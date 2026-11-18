-- Targeted Phase 3 fixes: receipt claim revisions/limits, current measured Dora
-- intake observations, and a resolvable residue-sale decision revision path.

ALTER TABLE consignment_receipt_item
  ADD COLUMN supersedes_receipt_item_id UUID,
  ADD COLUMN correction_reason TEXT,
  ADD CONSTRAINT consignment_receipt_item_successor_fk
    FOREIGN KEY (supersedes_receipt_item_id,consignment_item_id,batch_id)
    REFERENCES consignment_receipt_item(id,consignment_item_id,batch_id) ON DELETE RESTRICT,
  ADD CONSTRAINT consignment_receipt_item_correction_shape_check
    CHECK ((supersedes_receipt_item_id IS NULL AND correction_reason IS NULL)
      OR (supersedes_receipt_item_id IS NOT NULL AND length(trim(COALESCE(correction_reason,'')))>0));
CREATE UNIQUE INDEX consignment_receipt_item_single_successor_idx
  ON consignment_receipt_item(supersedes_receipt_item_id) WHERE supersedes_receipt_item_id IS NOT NULL;
CREATE INDEX consignment_receipt_item_current_position_idx
  ON consignment_receipt_item(consignment_item_id,outcome,recorded_at)
  WHERE supersedes_receipt_item_id IS NULL;

ALTER TABLE residue_sale_line
  ADD COLUMN resolves_decision_mismatch BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT residue_sale_line_mismatch_revision_check
    CHECK (NOT resolves_decision_mismatch OR
      (revision_kind='CORRECTION' AND supersedes_line_id IS NOT NULL AND is_accepted=false));
CREATE TRIGGER residue_sale_mismatch_marker_immutable
  BEFORE UPDATE OF resolves_decision_mismatch ON residue_sale_line
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();

CREATE UNIQUE INDEX material_measurement_single_successor_idx
  ON material_measurement(supersedes_measurement_id) WHERE supersedes_measurement_id IS NOT NULL;

CREATE FUNCTION validate_phase_three_receipt_quantity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE dispatched NUMERIC(20,6); previous_item consignment_receipt_item%ROWTYPE; already_claimed NUMERIC(20,6);
BEGIN
  PERFORM 1 FROM consignment_item WHERE id=NEW.consignment_item_id AND batch_id=NEW.batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'receipt claim must reference its consignment item and batch' USING ERRCODE='23503'; END IF;

  IF NEW.supersedes_receipt_item_id IS NOT NULL THEN
    SELECT * INTO previous_item FROM consignment_receipt_item WHERE id=NEW.supersedes_receipt_item_id;
    IF previous_item.id IS NULL OR previous_item.consignment_item_id<>NEW.consignment_item_id OR previous_item.batch_id<>NEW.batch_id
      OR EXISTS (SELECT 1 FROM consignment_receipt_item child WHERE child.supersedes_receipt_item_id=previous_item.id) THEN
      RAISE EXCEPTION 'receipt corrections must succeed the current observation for the same item' USING ERRCODE='23514';
    END IF;
    IF EXISTS (SELECT 1 FROM recovery_event_input_source WHERE consignment_receipt_item_id=previous_item.id) THEN
      RAISE EXCEPTION 'a receipt referenced by recovery genealogy cannot be corrected' USING ERRCODE='23514';
    END IF;
  END IF;

  SELECT COALESCE(sum(dispatch.posted_quantity_g-COALESCE(reversed.quantity_g,0)),0)::NUMERIC(20,6)
    INTO dispatched
  FROM inventory_movement_line dispatch
  JOIN inventory_movement movement ON movement.id=dispatch.inventory_movement_id
    AND movement.current_status='ACCEPTED' AND movement.movement_kind='TRANSFER'
  LEFT JOIN LATERAL (
    SELECT COALESCE(sum(reverse_line.posted_quantity_g),0)::NUMERIC(20,6) AS quantity_g
    FROM inventory_movement_line reverse_line
    JOIN inventory_movement reverse_movement ON reverse_movement.id=reverse_line.inventory_movement_id
      AND reverse_movement.current_status='ACCEPTED' AND reverse_movement.movement_kind='REVERSAL'
    WHERE reverse_line.reverses_line_id=dispatch.id
  ) reversed ON true
  WHERE dispatch.consignment_item_id=NEW.consignment_item_id
    AND dispatch.consignment_stage='DISPATCH' AND dispatch.direction='OUT';

  IF dispatched<=0 THEN RAISE EXCEPTION 'receipt claims require an accepted dispatch quantity' USING ERRCODE='23514'; END IF;

  SELECT COALESCE(sum(current_item.quantity_g),0)::NUMERIC(20,6) INTO already_claimed
  FROM consignment_receipt_item current_item
  WHERE current_item.consignment_item_id=NEW.consignment_item_id
    AND current_item.id IS DISTINCT FROM NEW.supersedes_receipt_item_id
    AND NOT EXISTS (SELECT 1 FROM consignment_receipt_item child WHERE child.supersedes_receipt_item_id=current_item.id);

  IF already_claimed+NEW.quantity_g>dispatched THEN
    RAISE EXCEPTION 'cumulative current receipt claims cannot exceed the accepted dispatched quantity' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER consignment_receipt_quantity_guard BEFORE INSERT ON consignment_receipt_item
  FOR EACH ROW EXECUTE FUNCTION validate_phase_three_receipt_quantity();

CREATE FUNCTION validate_phase_three_receipt_correction_reversal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_outcome TEXT; original RECORD; reversed_quantity NUMERIC(20,6); original_count INTEGER;
BEGIN
  IF NEW.supersedes_receipt_item_id IS NULL THEN RETURN NULL; END IF;
  SELECT outcome INTO previous_outcome FROM consignment_receipt_item WHERE id=NEW.supersedes_receipt_item_id;
  SELECT count(*) INTO original_count FROM inventory_movement_line ml
    JOIN inventory_movement m ON m.id=ml.inventory_movement_id AND m.current_status='ACCEPTED' AND m.movement_kind='TRANSFER'
    WHERE ml.consignment_receipt_item_id=NEW.supersedes_receipt_item_id AND ml.consignment_stage='RECEIPT';

  IF previous_outcome='ACCEPTED' THEN
    IF original_count<>2 THEN RAISE EXCEPTION 'an accepted receipt correction must find its original paired movement' USING ERRCODE='23514'; END IF;
    FOR original IN SELECT ml.* FROM inventory_movement_line ml
      JOIN inventory_movement m ON m.id=ml.inventory_movement_id AND m.current_status='ACCEPTED' AND m.movement_kind='TRANSFER'
      WHERE ml.consignment_receipt_item_id=NEW.supersedes_receipt_item_id AND ml.consignment_stage='RECEIPT'
    LOOP
      SELECT COALESCE(sum(reverse_line.posted_quantity_g),0)::NUMERIC(20,6) INTO reversed_quantity
      FROM inventory_movement_line reverse_line
      JOIN inventory_movement reverse_movement ON reverse_movement.id=reverse_line.inventory_movement_id
        AND reverse_movement.current_status='ACCEPTED' AND reverse_movement.movement_kind='REVERSAL'
        AND reverse_movement.reverses_movement_id=original.inventory_movement_id
      WHERE reverse_line.reverses_line_id=original.id;
      IF reversed_quantity<>original.posted_quantity_g THEN
        RAISE EXCEPTION 'an accepted receipt correction must fully reverse both original inventory legs' USING ERRCODE='23514';
      END IF;
    END LOOP;
  ELSIF original_count<>0 THEN
    RAISE EXCEPTION 'a non-accepted receipt observation cannot have receipt inventory movements' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER receipt_correction_reversal_guard AFTER INSERT ON consignment_receipt_item
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_phase_three_receipt_correction_reversal();

CREATE FUNCTION validate_phase_three_intake_measurement_authority() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE movement_id UUID; movement_kind_value TEXT;
BEGIN
  IF TG_TABLE_NAME='inventory_movement' THEN movement_id:=NEW.id;
  ELSE movement_id:=NEW.inventory_movement_id;
  END IF;
  SELECT movement_kind INTO movement_kind_value FROM inventory_movement
    WHERE id=movement_id AND current_status='ACCEPTED';
  IF movement_kind_value<>'INTAKE' THEN RETURN NULL; END IF;

  IF EXISTS (
    SELECT 1 FROM inventory_movement_line line
    WHERE line.inventory_movement_id=movement_id AND NOT EXISTS (
      SELECT 1 FROM material_measurement_set ms
      JOIN material_measurement measurement ON measurement.measurement_set_id=ms.id
      JOIN material_event_output output ON output.id=line.source_material_event_output_id AND output.batch_id=line.batch_id
      WHERE ms.id=line.basis_measurement_set_id AND ms.batch_id=line.batch_id
        AND ms.material_event_output_id=output.id AND measurement.id=line.basis_measurement_id
        AND measurement.quantity_g=line.posted_quantity_g
        AND measurement.measurement_kind IN ('MEASURED','VERIFIED')
        AND NOT EXISTS (SELECT 1 FROM material_measurement successor
          WHERE successor.supersedes_measurement_id=measurement.id)
    )
  ) THEN RAISE EXCEPTION 'Dora intake requires a current measured or verified source-output observation matching the posted quantity' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER phase_three_intake_measurement_header_guard AFTER INSERT OR UPDATE ON inventory_movement
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_phase_three_intake_measurement_authority();
CREATE CONSTRAINT TRIGGER phase_three_intake_measurement_line_guard AFTER INSERT ON inventory_movement_line
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_phase_three_intake_measurement_authority();

CREATE FUNCTION lock_phase_three_dispatch_item_for_reversal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item_id UUID; stage_value TEXT;
BEGIN
  IF NEW.reverses_line_id IS NULL THEN RETURN NEW; END IF;
  SELECT consignment_item_id,consignment_stage INTO item_id,stage_value
  FROM inventory_movement_line WHERE id=NEW.reverses_line_id;
  IF item_id IS NULL OR stage_value NOT IN ('DISPATCH','RECEIPT') THEN RETURN NEW; END IF;
  PERFORM 1 FROM consignment_item WHERE id=item_id FOR UPDATE;
  IF stage_value='RECEIPT' AND NOT EXISTS (
    SELECT 1 FROM consignment_receipt_item successor
    WHERE successor.supersedes_receipt_item_id=(SELECT consignment_receipt_item_id FROM inventory_movement_line WHERE id=NEW.reverses_line_id)
  ) THEN RAISE EXCEPTION 'accepted receipt inventory can be reversed only by a receipt correction successor' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dispatch_receipt_reversal_item_lock BEFORE INSERT ON inventory_movement_line
  FOR EACH ROW EXECUTE FUNCTION lock_phase_three_dispatch_item_for_reversal();

CREATE FUNCTION validate_residue_sale_decision_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior residue_sale_line%ROWTYPE; seller UUID; buyer UUID; seller_quantity NUMERIC(20,6); buyer_quantity NUMERIC(20,6);
BEGIN
  IF NOT NEW.resolves_decision_mismatch THEN RETURN NEW; END IF;
  SELECT * INTO prior FROM residue_sale_line WHERE id=NEW.supersedes_line_id AND residue_sale_id=NEW.residue_sale_id AND batch_id=NEW.batch_id;
  IF prior.id IS NULL OR prior.is_accepted OR NEW.revision_no<>prior.revision_no+1
    OR EXISTS (SELECT 1 FROM residue_sale_line child WHERE child.supersedes_line_id=prior.id) THEN
    RAISE EXCEPTION 'decision revision must succeed the current unresolved sale line' USING ERRCODE='23514';
  END IF;
  SELECT sale.seller_party_id,sale.buyer_party_id INTO seller,buyer
    FROM residue_sale sale WHERE sale.id=NEW.residue_sale_id;
  SELECT max(accepted_quantity_g) FILTER (WHERE actor_party_id=seller),
         max(accepted_quantity_g) FILTER (WHERE actor_party_id=buyer)
    INTO seller_quantity,buyer_quantity
  FROM residue_sale_decision_event WHERE residue_sale_line_id=prior.id AND decision='ACCEPT';
  IF seller_quantity IS NULL OR buyer_quantity IS NULL OR seller_quantity=buyer_quantity THEN
    RAISE EXCEPTION 'decision revision requires conflicting accepted quantities from both counterparties' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER residue_sale_decision_revision_guard BEFORE INSERT ON residue_sale_line
  FOR EACH ROW EXECUTE FUNCTION validate_residue_sale_decision_revision();

CREATE FUNCTION validate_eligible_residue_sale_quantity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE facility_id UUID; location_id UUID; available NUMERIC(20,6); committed NUMERIC(20,6);
BEGIN
  IF NOT NEW.is_accepted THEN RETURN NEW; END IF;
  PERFORM 1 FROM material_batch WHERE id=NEW.batch_id AND material_kind='RESIDUE' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'accepted residue sale must reference a residue batch' USING ERRCODE='23514'; END IF;

  SELECT p.processing_facility_id INTO facility_id
  FROM material_event_output output JOIN processing_event_output po ON po.material_event_output_id=output.id
  JOIN processing_event p ON p.event_id=po.processing_event_id
  WHERE output.batch_id=NEW.batch_id AND po.output_role='DORA_RETAINED_RESIDUE';
  IF facility_id IS NULL THEN RAISE EXCEPTION 'accepted residue sale batch has no Dora source facility' USING ERRCODE='23514'; END IF;

  FOR location_id IN SELECT inventory_location_id FROM residue_stockpile
    WHERE processing_facility_id=facility_id ORDER BY inventory_location_id
  LOOP
    INSERT INTO inventory_balance_guard(location_id,batch_id) VALUES (location_id,NEW.batch_id) ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM guard.location_id FROM inventory_balance_guard guard
    JOIN residue_stockpile stockpile ON stockpile.inventory_location_id=guard.location_id
    WHERE stockpile.processing_facility_id=facility_id AND guard.batch_id=NEW.batch_id
    ORDER BY guard.location_id FOR UPDATE OF guard;

  SELECT COALESCE(sum(balance.quantity_g),0)::NUMERIC(20,6) INTO available
  FROM (
    SELECT ml.location_id,sum(CASE WHEN ml.direction='IN' THEN ml.posted_quantity_g ELSE -ml.posted_quantity_g END)::NUMERIC(20,6) AS quantity_g
    FROM inventory_movement_line ml JOIN inventory_movement movement ON movement.id=ml.inventory_movement_id AND movement.current_status='ACCEPTED'
    JOIN residue_stockpile stockpile ON stockpile.inventory_location_id=ml.location_id AND stockpile.processing_facility_id=facility_id
    WHERE ml.batch_id=NEW.batch_id GROUP BY ml.location_id
  ) balance;

  SELECT COALESCE(sum(GREATEST(sale_line.accepted_trade_quantity_g-COALESCE(dispatched.quantity_g,0),0)),0)::NUMERIC(20,6)
  INTO committed
  FROM residue_sale_line sale_line
  LEFT JOIN LATERAL (
    SELECT COALESCE(sum(dispatch.posted_quantity_g-COALESCE(reversed.quantity_g,0)),0)::NUMERIC(20,6) AS quantity_g
    FROM inventory_movement_line dispatch
    JOIN inventory_movement movement ON movement.id=dispatch.inventory_movement_id AND movement.current_status='ACCEPTED' AND movement.movement_kind='TRANSFER'
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(reverse_line.posted_quantity_g),0)::NUMERIC(20,6) AS quantity_g
      FROM inventory_movement_line reverse_line JOIN inventory_movement reverse_movement
        ON reverse_movement.id=reverse_line.inventory_movement_id AND reverse_movement.current_status='ACCEPTED' AND reverse_movement.movement_kind='REVERSAL'
      WHERE reverse_line.reverses_line_id=dispatch.id
    ) reversed ON true
    WHERE dispatch.residue_sale_line_id=sale_line.id AND dispatch.consignment_stage='DISPATCH' AND dispatch.direction='OUT'
  ) dispatched ON true
  WHERE sale_line.batch_id=NEW.batch_id AND sale_line.is_accepted;

  IF NEW.accepted_trade_quantity_g>GREATEST(available-committed,0) THEN
    RAISE EXCEPTION 'accepted residue sale quantity exceeds the uncommitted eligible stockpile balance' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER residue_sale_eligible_inventory_guard BEFORE INSERT OR UPDATE ON residue_sale_line
  FOR EACH ROW EXECUTE FUNCTION validate_eligible_residue_sale_quantity();

CREATE FUNCTION validate_current_recovery_receipt_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item_id UUID;
BEGIN
  SELECT ci.id INTO item_id
  FROM consignment_receipt_item receipt
  JOIN consignment_item ci ON ci.id=receipt.consignment_item_id
  WHERE receipt.id=NEW.consignment_receipt_item_id
  FOR UPDATE OF ci;
  IF item_id IS NULL OR EXISTS (
    SELECT 1 FROM consignment_receipt_item successor
    WHERE successor.supersedes_receipt_item_id=NEW.consignment_receipt_item_id
  ) THEN
    RAISE EXCEPTION 'recovery genealogy must use a current receipt observation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recovery_source_current_receipt_guard BEFORE INSERT ON recovery_event_input_source
  FOR EACH ROW EXECUTE FUNCTION validate_current_recovery_receipt_source();

CREATE OR REPLACE FUNCTION validate_consignment_status_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_exists BOOLEAN;
BEGIN
  IF NEW.status=OLD.status THEN RETURN NEW; END IF;
  IF NOT ((OLD.status='DRAFT' AND NEW.status='DISPATCHED') OR
          (OLD.status IN ('DISPATCHED','PART_RECEIVED','DISPUTED') AND NEW.status IN ('PART_RECEIVED','RECEIVED','DISPUTED','CLOSED')) OR
          (OLD.status='RECEIVED' AND NEW.status IN ('PART_RECEIVED','DISPUTED'))) THEN
    RAISE EXCEPTION 'consignment status transition is invalid' USING ERRCODE='23514';
  END IF;
  SELECT EXISTS(SELECT 1 FROM consignment_status_event e WHERE e.consignment_id=NEW.id AND e.previous_status=OLD.status AND e.next_status=NEW.status) INTO event_exists;
  IF NOT event_exists THEN RAISE EXCEPTION 'consignment status changes require an append-only status event' USING ERRCODE='23514'; END IF;
  IF NEW.status='DISPATCHED' AND (NEW.dispatched_at IS NULL OR NEW.dispatched_by_user_id IS NULL OR NOT EXISTS(SELECT 1 FROM consignment_item WHERE consignment_id=NEW.id)) THEN
    RAISE EXCEPTION 'dispatch status requires dispatch context and itemized residue' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TABLE phase_three_integrity_correction_marker (
  marker TEXT PRIMARY KEY,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO phase_three_integrity_correction_marker(marker) VALUES ('receipt-measurement-sale-revision-v1');
