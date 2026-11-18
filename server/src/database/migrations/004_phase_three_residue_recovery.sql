-- Phase 3 extends the original domain schema and keeps inventory_movement_line
-- as the only quantity ledger. All new facts are additive and event-linked.

ALTER TABLE inventory_movement DROP CONSTRAINT IF EXISTS inventory_movement_movement_kind_check;
ALTER TABLE inventory_movement ADD CONSTRAINT inventory_movement_movement_kind_check
  CHECK (movement_kind IN ('TRANSFER','TRANSFORMATION','ADJUSTMENT','OPENING_BALANCE','REVERSAL','INTAKE'));

ALTER TABLE inventory_movement_line
  ADD COLUMN source_material_event_output_id UUID,
  ADD COLUMN consignment_receipt_item_id UUID;
ALTER TABLE inventory_movement_line
  ADD CONSTRAINT inventory_line_source_output_batch_fk
    FOREIGN KEY (source_material_event_output_id,batch_id) REFERENCES material_event_output(id,batch_id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX inventory_line_one_intake_per_output_idx
  ON inventory_movement_line(source_material_event_output_id) WHERE source_material_event_output_id IS NOT NULL;

ALTER TABLE consignment
  ADD COLUMN destination_recovery_facility_id UUID REFERENCES recovery_facility(id) ON DELETE RESTRICT,
  ADD COLUMN dispatched_by_user_id UUID REFERENCES user_account(id) ON DELETE RESTRICT,
  ADD COLUMN dispatch_evidence_ref TEXT,
  ADD COLUMN transporter_party_id UUID REFERENCES party(id) ON DELETE RESTRICT,
  ADD COLUMN recorded_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE consignment_item ADD COLUMN source_location_id UUID REFERENCES inventory_location(id) ON DELETE RESTRICT;
CREATE INDEX consignment_recipient_status_idx ON consignment(destination_recovery_facility_id,status,created_at);
CREATE INDEX consignment_item_batch_idx ON consignment_item(batch_id,consignment_id);
CREATE UNIQUE INDEX residue_sale_shipment_item_one_sale_per_consignment_item_idx
  ON residue_sale_shipment_item(consignment_item_id);
CREATE TABLE consignment_status_event (
  id UUID PRIMARY KEY,
  consignment_id UUID NOT NULL REFERENCES consignment(id) ON DELETE RESTRICT,
  previous_status TEXT NOT NULL,
  next_status TEXT NOT NULL CHECK (next_status IN ('DISPATCHED','PART_RECEIVED','RECEIVED','DISPUTED','CLOSED')),
  actor_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  occurred_at TIMESTAMPTZ NOT NULL,
  evidence_ref TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (previous_status<>next_status)
);

CREATE TABLE consignment_receipt (
  id UUID PRIMARY KEY,
  consignment_id UUID NOT NULL REFERENCES consignment(id) ON DELETE RESTRICT,
  received_by_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  occurred_at_claimed TIMESTAMPTZ NOT NULL,
  evidence_ref TEXT,
  note TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(id,consignment_id)
);
DROP INDEX IF EXISTS measurement_set_unique_consignment_stage;
CREATE TABLE consignment_receipt_item (
  id UUID PRIMARY KEY,
  receipt_id UUID NOT NULL,
  consignment_id UUID NOT NULL,
  consignment_item_id UUID NOT NULL,
  batch_id UUID NOT NULL,
  quantity_g NUMERIC(20,6) NOT NULL CHECK (quantity_g > 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('ACCEPTED','DISPUTED','REJECTED')),
  measurement_set_id UUID NOT NULL,
  measurement_id UUID NOT NULL,
  discrepancy_reason TEXT,
  evidence_ref TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (receipt_id,consignment_id) REFERENCES consignment_receipt(id,consignment_id) ON DELETE RESTRICT,
  FOREIGN KEY (consignment_item_id,batch_id) REFERENCES consignment_item(id,batch_id) ON DELETE RESTRICT,
  FOREIGN KEY (measurement_id,measurement_set_id) REFERENCES material_measurement(id,measurement_set_id) ON DELETE RESTRICT,
  UNIQUE(id,consignment_item_id,batch_id),
  CHECK ((outcome='ACCEPTED' AND discrepancy_reason IS NULL) OR (outcome<>'ACCEPTED' AND length(trim(COALESCE(discrepancy_reason,'')))>0))
);
CREATE INDEX consignment_receipt_item_consignment_idx ON consignment_receipt_item(consignment_id,consignment_item_id,recorded_at);
ALTER TABLE inventory_movement_line
  ADD CONSTRAINT inventory_line_receipt_item_fk
    FOREIGN KEY (consignment_receipt_item_id,consignment_item_id,batch_id)
    REFERENCES consignment_receipt_item(id,consignment_item_id,batch_id) ON DELETE RESTRICT;

CREATE TABLE custody_transfer_item (
  id UUID PRIMARY KEY,
  custody_transfer_id UUID NOT NULL REFERENCES custody_transfer(id) ON DELETE RESTRICT,
  consignment_item_id UUID NOT NULL,
  batch_id UUID NOT NULL REFERENCES material_batch(id) ON DELETE RESTRICT,
  quantity_g NUMERIC(20,6) NOT NULL CHECK (quantity_g > 0),
  FOREIGN KEY (consignment_item_id,batch_id) REFERENCES consignment_item(id,batch_id) ON DELETE RESTRICT,
  UNIQUE(custody_transfer_id,consignment_item_id),
  UNIQUE(id,custody_transfer_id)
);
ALTER TABLE custody_transfer
  ADD COLUMN source_location_id UUID REFERENCES inventory_location(id) ON DELETE RESTRICT,
  ADD COLUMN destination_location_id UUID REFERENCES inventory_location(id) ON DELETE RESTRICT,
  ADD COLUMN evidence_ref TEXT,
  ADD COLUMN recorded_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE TABLE custody_transfer_decision (
  id UUID PRIMARY KEY,
  custody_transfer_id UUID NOT NULL REFERENCES custody_transfer(id) ON DELETE RESTRICT,
  actor_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  actor_party_id UUID NOT NULL REFERENCES party(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('ACCEPT','DISPUTE','REJECT','WITHDRAW')),
  occurred_at TIMESTAMPTZ NOT NULL,
  reason TEXT,
  evidence_ref TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(custody_transfer_id,actor_party_id)
);

CREATE TABLE recovery_event_input (
  material_event_input_id UUID PRIMARY KEY,
  recovery_event_id UUID NOT NULL,
  batch_id UUID NOT NULL,
  FOREIGN KEY (material_event_input_id,recovery_event_id,batch_id)
    REFERENCES material_event_input(id,event_id,batch_id) ON DELETE RESTRICT,
  FOREIGN KEY (recovery_event_id) REFERENCES recovery_event(event_id) ON DELETE RESTRICT,
  FOREIGN KEY (batch_id) REFERENCES material_batch(id) ON DELETE RESTRICT,
  UNIQUE(material_event_input_id,recovery_event_id,batch_id),
  UNIQUE(material_event_input_id,recovery_event_id)
);
CREATE TABLE recovery_event_output (
  material_event_output_id UUID PRIMARY KEY,
  recovery_event_id UUID NOT NULL,
  batch_id UUID NOT NULL,
  output_role TEXT NOT NULL CHECK (output_role IN ('RECOVERED_GOLD','OTHER_OUTPUT')),
  FOREIGN KEY (material_event_output_id,recovery_event_id,batch_id)
    REFERENCES material_event_output(id,event_id,batch_id) ON DELETE RESTRICT,
  FOREIGN KEY (recovery_event_id) REFERENCES recovery_event(event_id) ON DELETE RESTRICT,
  FOREIGN KEY (batch_id) REFERENCES material_batch(id) ON DELETE RESTRICT,
  UNIQUE(material_event_output_id,recovery_event_id,batch_id)
);
CREATE TABLE recovery_event_input_source (
  id UUID PRIMARY KEY,
  recovery_event_input_id UUID NOT NULL,
  recovery_event_id UUID NOT NULL,
  batch_id UUID NOT NULL,
  consignment_receipt_item_id UUID NOT NULL,
  consignment_item_id UUID NOT NULL,
  source_quantity_g NUMERIC(20,6) NOT NULL CHECK (source_quantity_g > 0),
  FOREIGN KEY (recovery_event_input_id,recovery_event_id,batch_id)
    REFERENCES recovery_event_input(material_event_input_id,recovery_event_id,batch_id) ON DELETE RESTRICT,
  FOREIGN KEY (consignment_receipt_item_id,consignment_item_id,batch_id)
    REFERENCES consignment_receipt_item(id,consignment_item_id,batch_id) ON DELETE RESTRICT,
  UNIQUE(recovery_event_input_id,consignment_receipt_item_id)
);
CREATE TABLE recovery_output_input_link (
  recovery_event_id UUID NOT NULL REFERENCES recovery_event(event_id) ON DELETE RESTRICT,
  material_event_output_id UUID NOT NULL,
  material_event_input_id UUID NOT NULL,
  batch_id UUID NOT NULL,
  PRIMARY KEY(material_event_output_id,material_event_input_id),
  FOREIGN KEY (material_event_output_id,recovery_event_id,batch_id)
    REFERENCES recovery_event_output(material_event_output_id,recovery_event_id,batch_id) ON DELETE RESTRICT,
  FOREIGN KEY (material_event_input_id,recovery_event_id)
    REFERENCES recovery_event_input(material_event_input_id,recovery_event_id) ON DELETE RESTRICT
);
CREATE INDEX recovery_output_genealogy_input_idx ON recovery_output_input_link(material_event_input_id,material_event_output_id);
CREATE TABLE recovery_process_stage (
  id UUID PRIMARY KEY,
  recovery_event_id UUID NOT NULL REFERENCES recovery_event(event_id) ON DELETE RESTRICT,
  stage_code TEXT NOT NULL CHECK (stage_code IN ('LEACHING','CARBON_RELATED','ELUTION','FINAL_RECOVERY','OTHER')),
  occurred_at_claimed TIMESTAMPTZ NOT NULL,
  evidence_ref TEXT,
  note TEXT,
  recorded_by_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE recovery_variance (
  id UUID PRIMARY KEY,
  recovery_event_id UUID NOT NULL REFERENCES recovery_event(event_id) ON DELETE RESTRICT,
  variance_kind TEXT NOT NULL CHECK (variance_kind IN ('INPUT','OUTPUT','PROCESS')),
  expected_quantity_g NUMERIC(20,6),
  observed_quantity_g NUMERIC(20,6),
  variance_quantity_g NUMERIC(20,6),
  reason TEXT NOT NULL CHECK (length(trim(reason))>0),
  evidence_ref TEXT,
  recorded_by_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(expected_quantity_g,observed_quantity_g,variance_quantity_g)>0)
);

CREATE TABLE residue_sale_decision_event (
  id UUID PRIMARY KEY,
  residue_sale_line_id UUID NOT NULL REFERENCES residue_sale_line(id) ON DELETE RESTRICT,
  actor_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  actor_party_id UUID NOT NULL REFERENCES party(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('ACCEPT','DISPUTE','REJECT')),
  accepted_quantity_g NUMERIC(20,6),
  occurred_at TIMESTAMPTZ NOT NULL,
  reason TEXT,
  evidence_ref TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((decision='ACCEPT' AND accepted_quantity_g>0) OR (decision<>'ACCEPT' AND accepted_quantity_g IS NULL))
);
CREATE UNIQUE INDEX residue_sale_decision_party_once_idx ON residue_sale_decision_event(residue_sale_line_id,actor_party_id);
CREATE UNIQUE INDEX residue_sale_decision_user_once_idx ON residue_sale_decision_event(residue_sale_line_id,actor_user_id);
CREATE INDEX residue_sale_shipment_item_line_idx ON residue_sale_shipment_item(residue_sale_line_id,consignment_item_id);

CREATE FUNCTION reject_phase_three_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'phase three evidence records are append-only' USING ERRCODE='55000';
END $$;
DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['consignment_receipt','consignment_receipt_item','consignment_status_event','consignment_item','transport_record','custody_transfer_item','custody_transfer_decision','recovery_event_input_source','recovery_output_input_link','recovery_process_stage','recovery_variance','residue_sale_decision_event'] LOOP
    EXECUTE format('CREATE TRIGGER %I_phase3_append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_phase_three_event_mutation()', table_name, table_name);
  END LOOP;
END $$;

CREATE FUNCTION validate_residue_sale_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE seller UUID; buyer UUID; line_parent UUID;
BEGIN
  SELECT rs.seller_party_id,rs.buyer_party_id,rs.id INTO seller,buyer,line_parent
  FROM residue_sale_line rsl JOIN residue_sale rs ON rs.id=rsl.residue_sale_id
  WHERE rsl.id=NEW.residue_sale_line_id;
  IF line_parent IS NULL OR NEW.actor_party_id NOT IN (seller,buyer) THEN
    RAISE EXCEPTION 'residue sale decisions require one of the recorded counterparties' USING ERRCODE='23514';
  END IF;
  IF NEW.decision='ACCEPT' AND NEW.accepted_quantity_g > (SELECT transaction_quantity_g FROM residue_sale_line WHERE id=NEW.residue_sale_line_id) THEN
    RAISE EXCEPTION 'accepted residue quantity cannot exceed the proposed quantity' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER residue_sale_decision_party_guard BEFORE INSERT ON residue_sale_decision_event FOR EACH ROW EXECUTE FUNCTION validate_residue_sale_decision();

CREATE FUNCTION validate_phase_three_receipt_measurement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item consignment_item%ROWTYPE; measured NUMERIC(20,6);
BEGIN
  SELECT * INTO item FROM consignment_item WHERE id=NEW.consignment_item_id;
  IF item.id IS NULL OR NOT EXISTS (
    SELECT 1 FROM material_measurement_set ms JOIN material_measurement m ON m.measurement_set_id=ms.id
    WHERE ms.id=NEW.measurement_set_id AND ms.batch_id=NEW.batch_id AND ms.consignment_item_id=NEW.consignment_item_id
      AND ms.consignment_stage='RECEIPT' AND m.id=NEW.measurement_id AND m.quantity_g=NEW.quantity_g
  ) THEN RAISE EXCEPTION 'receipt quantity must match an observation for this item and receipt stage' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM consignment_receipt r WHERE r.id=NEW.receipt_id AND r.consignment_id=item.consignment_id) THEN
    RAISE EXCEPTION 'receipt item must belong to its parent consignment' USING ERRCODE='23514';
  END IF;
  IF NEW.outcome='ACCEPTED' AND length(trim(COALESCE(NEW.discrepancy_reason,'')))>0 THEN
    RAISE EXCEPTION 'accepted receipt is not a discrepancy record' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER receipt_measurement_guard BEFORE INSERT ON consignment_receipt_item FOR EACH ROW EXECUTE FUNCTION validate_phase_three_receipt_measurement();

CREATE FUNCTION validate_phase_three_consignment_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE destination_facility UUID;
BEGIN
  SELECT destination_recovery_facility_id INTO destination_facility
    FROM consignment WHERE id=NEW.consignment_id;
  -- Preserve the pre-Phase-3 generic inventory transfer records used by the
  -- existing movement journal. Phase-3 consignments always name a recovery
  -- facility and therefore must identify a Dora stockpile source.
  IF destination_facility IS NULL THEN RETURN NEW; END IF;
  IF NEW.source_location_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM residue_stockpile s JOIN material_batch b ON b.id=NEW.batch_id
    WHERE s.inventory_location_id=NEW.source_location_id AND b.material_kind='RESIDUE'
  ) THEN RAISE EXCEPTION 'consignment items must identify a Dora stockpile and residue batch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER consignment_item_source_guard BEFORE INSERT ON consignment_item FOR EACH ROW EXECUTE FUNCTION validate_phase_three_consignment_item();

CREATE FUNCTION validate_accepted_receipt_has_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reference_count INTEGER;
BEGIN
  IF NEW.outcome='ACCEPTED' THEN
    SELECT count(*) INTO reference_count FROM inventory_movement_line ml
      JOIN inventory_movement m ON m.id=ml.inventory_movement_id AND m.movement_kind='TRANSFER' AND m.current_status='ACCEPTED'
      WHERE ml.consignment_receipt_item_id=NEW.id AND ml.consignment_item_id=NEW.consignment_item_id AND ml.batch_id=NEW.batch_id AND ml.consignment_stage='RECEIPT';
    IF reference_count<>2 THEN RAISE EXCEPTION 'accepted receipt quantity requires exactly one paired journal transfer' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER accepted_receipt_has_movement_guard AFTER INSERT ON consignment_receipt_item DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_accepted_receipt_has_movement();

CREATE FUNCTION validate_phase_three_inventory() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE movement_id UUID; kind TEXT; event_key UUID; line RECORD; facility_key UUID; output_role TEXT; output_facility UUID; receipt consignment_receipt_item%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='inventory_movement' THEN movement_id:=NEW.id; ELSE movement_id:=NEW.inventory_movement_id; END IF;
  SELECT movement_kind,event_id INTO kind,event_key FROM inventory_movement WHERE id=movement_id AND current_status='ACCEPTED';
  IF kind IS NULL THEN RETURN NULL; END IF;

  IF kind='INTAKE' THEN
    IF event_key IS NOT NULL OR NOT EXISTS (SELECT 1 FROM inventory_movement_line WHERE inventory_movement_id=movement_id) THEN
      RAISE EXCEPTION 'stockpile intake needs source output references and no unrelated event' USING ERRCODE='23514';
    END IF;
    FOR line IN SELECT ml.*,s.processing_facility_id,loc.location_kind,peo.processing_event_id
      FROM inventory_movement_line ml
      JOIN material_event_output eo ON eo.id=ml.source_material_event_output_id AND eo.batch_id=ml.batch_id
      JOIN processing_event_output peo ON peo.material_event_output_id=eo.id
      JOIN processing_event p ON p.event_id=peo.processing_event_id
      JOIN residue_stockpile s ON s.inventory_location_id=ml.location_id
      JOIN inventory_location loc ON loc.id=ml.location_id
      WHERE ml.inventory_movement_id=movement_id
    LOOP
      SELECT peo.output_role,p.processing_facility_id INTO output_role,output_facility
      FROM processing_event_output peo JOIN processing_event p ON p.event_id=peo.processing_event_id
      WHERE peo.material_event_output_id=line.source_material_event_output_id;
      IF line.direction<>'IN' OR line.source_material_event_output_id IS NULL OR line.material_event_input_id IS NOT NULL OR line.material_event_output_id IS NOT NULL
        OR line.consignment_item_id IS NOT NULL OR line.consignment_receipt_item_id IS NOT NULL OR line.gold_trade_line_id IS NOT NULL OR line.residue_sale_line_id IS NOT NULL
        OR line.location_kind<>'STOCKPILE' OR line.processing_facility_id<>output_facility OR output_role<>'DORA_RETAINED_RESIDUE'
        OR NOT EXISTS (SELECT 1 FROM material_batch WHERE id=line.batch_id AND material_kind='RESIDUE')
        OR NOT EXISTS (SELECT 1 FROM material_measurement_set ms JOIN material_measurement mm ON mm.measurement_set_id=ms.id
          WHERE ms.id=line.basis_measurement_set_id AND ms.material_event_output_id=line.source_material_event_output_id AND ms.batch_id=line.batch_id
            AND mm.id=line.basis_measurement_id AND mm.quantity_g=line.posted_quantity_g)
      THEN RAISE EXCEPTION 'intake must post the measured Dora-retained residue output to that Dora stockpile' USING ERRCODE='23514'; END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM inventory_movement_line WHERE inventory_movement_id=movement_id AND source_material_event_output_id IS NULL) THEN
      RAISE EXCEPTION 'every intake line needs one source processing output' USING ERRCODE='23514';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM inventory_movement_line WHERE inventory_movement_id=movement_id AND source_material_event_output_id IS NOT NULL) THEN
      RAISE EXCEPTION 'only INTAKE movements can reference a source processing output' USING ERRCODE='23514';
    END IF;
  END IF;

  IF kind='TRANSFER' AND EXISTS (
    SELECT 1 FROM inventory_movement_line ml JOIN consignment_item ci ON ci.id=ml.consignment_item_id
    JOIN consignment c ON c.id=ci.consignment_id
    WHERE ml.inventory_movement_id=movement_id AND ml.consignment_stage='DISPATCH' AND c.destination_recovery_facility_id IS NOT NULL
  ) THEN
    FOR line IN SELECT ml.*,ci.source_location_id,c.transit_location_id,c.destination_recovery_facility_id
      FROM inventory_movement_line ml JOIN consignment_item ci ON ci.id=ml.consignment_item_id
      JOIN consignment c ON c.id=ci.consignment_id WHERE ml.inventory_movement_id=movement_id
        AND ml.consignment_stage='DISPATCH' AND c.destination_recovery_facility_id IS NOT NULL
    LOOP
      IF line.consignment_receipt_item_id IS NOT NULL OR
        (line.direction='OUT' AND line.location_id<>line.source_location_id) OR
        (line.direction='IN' AND line.location_id<>line.transit_location_id) OR
        NOT EXISTS (SELECT 1 FROM residue_stockpile WHERE inventory_location_id=line.source_location_id) OR
        NOT EXISTS (SELECT 1 FROM inventory_location WHERE id=line.transit_location_id AND location_kind='CONSIGNMENT_TRANSIT')
      THEN RAISE EXCEPTION 'dispatch must pair each item source stockpile OUT with its own transit IN' USING ERRCODE='23514'; END IF;
    END LOOP;
    IF EXISTS (
      SELECT ci.id
      FROM inventory_movement_line ml JOIN consignment_item ci ON ci.id=ml.consignment_item_id
      JOIN consignment c ON c.id=ci.consignment_id
      WHERE ml.inventory_movement_id=movement_id AND ml.consignment_stage='DISPATCH' AND c.destination_recovery_facility_id IS NOT NULL
      GROUP BY ci.id,ci.batch_id,ci.source_location_id,c.transit_location_id
      HAVING count(*)<>2 OR count(*) FILTER (WHERE ml.direction='OUT' AND ml.batch_id=ci.batch_id AND ml.location_id=ci.source_location_id)<>1
        OR count(*) FILTER (WHERE ml.direction='IN' AND ml.batch_id=ci.batch_id AND ml.location_id=c.transit_location_id)<>1
        OR sum(ml.posted_quantity_g) FILTER (WHERE ml.direction='OUT') IS DISTINCT FROM sum(ml.posted_quantity_g) FILTER (WHERE ml.direction='IN')
    ) THEN RAISE EXCEPTION 'every Phase 3 dispatch item requires equal paired stockpile OUT and transit IN lines' USING ERRCODE='23514'; END IF;
  END IF;

  IF kind='TRANSFER' AND EXISTS (SELECT 1 FROM inventory_movement_line WHERE inventory_movement_id=movement_id AND consignment_stage='RECEIPT') THEN
    FOR line IN SELECT ml.*,ci.consignment_id,c.transit_location_id,c.destination_recovery_facility_id
      FROM inventory_movement_line ml JOIN consignment_item ci ON ci.id=ml.consignment_item_id
      JOIN consignment c ON c.id=ci.consignment_id WHERE ml.inventory_movement_id=movement_id
    LOOP
      SELECT * INTO receipt FROM consignment_receipt_item WHERE id=line.consignment_receipt_item_id;
      IF line.consignment_stage<>'RECEIPT' OR line.consignment_receipt_item_id IS NULL OR receipt.outcome<>'ACCEPTED' OR
        receipt.consignment_item_id<>line.consignment_item_id OR receipt.batch_id<>line.batch_id OR receipt.quantity_g<>line.posted_quantity_g OR
        line.basis_measurement_id<>receipt.measurement_id OR line.basis_measurement_set_id<>receipt.measurement_set_id OR
        (line.direction='OUT' AND line.location_id<>line.transit_location_id) OR
        (line.direction='IN' AND NOT EXISTS (SELECT 1 FROM recovery_inventory_location ril WHERE ril.inventory_location_id=line.location_id AND ril.recovery_facility_id=line.destination_recovery_facility_id))
      THEN RAISE EXCEPTION 'receipt postings must pair accepted transit quantity with the designated recovery facility' USING ERRCODE='23514'; END IF;
    END LOOP;
  END IF;

  IF kind='TRANSFORMATION' AND EXISTS (SELECT 1 FROM recovery_event WHERE event_id=event_key) THEN
    SELECT recovery_facility_id INTO facility_key FROM recovery_event WHERE event_id=event_key;
    IF EXISTS (SELECT 1 FROM inventory_movement_line ml WHERE ml.inventory_movement_id=movement_id AND ml.direction='OUT'
      AND (NOT EXISTS (SELECT 1 FROM recovery_event_input ri WHERE ri.material_event_input_id=ml.material_event_input_id AND ri.recovery_event_id=event_key AND ri.batch_id=ml.batch_id)
        OR NOT EXISTS (SELECT 1 FROM recovery_inventory_location ril WHERE ril.inventory_location_id=ml.location_id AND ril.recovery_facility_id=facility_key))) OR
       EXISTS (SELECT 1 FROM inventory_movement_line ml WHERE ml.inventory_movement_id=movement_id AND ml.direction='IN'
      AND (NOT EXISTS (SELECT 1 FROM recovery_event_output ro WHERE ro.material_event_output_id=ml.material_event_output_id AND ro.recovery_event_id=event_key AND ro.batch_id=ml.batch_id)
        OR NOT EXISTS (SELECT 1 FROM recovery_inventory_location ril WHERE ril.inventory_location_id=ml.location_id AND ril.recovery_facility_id=facility_key))) THEN
      RAISE EXCEPTION 'recovery transformation must consume and create batches at its authorized facility inventory' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER phase_three_inventory_header_guard AFTER INSERT OR UPDATE ON inventory_movement DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_phase_three_inventory();
CREATE CONSTRAINT TRIGGER phase_three_inventory_line_guard AFTER INSERT ON inventory_movement_line DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_phase_three_inventory();

CREATE FUNCTION validate_recovery_event_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_key UUID; input_count INTEGER; output_count INTEGER;
BEGIN
  IF TG_TABLE_NAME='recovery_event' THEN event_key:=NEW.event_id;
  ELSIF TG_OP='DELETE' THEN event_key:=OLD.recovery_event_id;
  ELSE event_key:=NEW.recovery_event_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM recovery_event WHERE event_id=event_key) THEN RETURN NULL; END IF;
  SELECT count(*) INTO input_count FROM recovery_event_input WHERE recovery_event_id=event_key;
  SELECT count(*) INTO output_count FROM recovery_event_output WHERE recovery_event_id=event_key;
  IF input_count=0 OR output_count=0 THEN RAISE EXCEPTION 'a recovery event requires at least one measured input and output' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM inventory_movement WHERE event_id=event_key AND movement_kind='TRANSFORMATION' AND current_status='ACCEPTED') THEN
    RAISE EXCEPTION 'recovery events require one accepted inventory transformation' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM recovery_event_input ri JOIN material_batch b ON b.id=ri.batch_id WHERE ri.recovery_event_id=event_key AND b.material_kind<>'RESIDUE') THEN
    RAISE EXCEPTION 'recovery inputs must be residue batches' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM recovery_event_output ro JOIN material_batch b ON b.id=ro.batch_id WHERE ro.recovery_event_id=event_key AND ((ro.output_role='RECOVERED_GOLD' AND b.material_kind<>'RECOVERED_GOLD') OR (ro.output_role='OTHER_OUTPUT' AND b.material_kind='RECOVERED_GOLD'))) THEN
    RAISE EXCEPTION 'recovery output role and material classification must agree' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM recovery_event_output ro WHERE ro.recovery_event_id=event_key AND
    (SELECT count(*) FROM recovery_output_input_link l WHERE l.material_event_output_id=ro.material_event_output_id)<>input_count) THEN
    RAISE EXCEPTION 'each recovery output must link to every contributing recovery input' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM recovery_event_input ri WHERE ri.recovery_event_id=event_key AND NOT EXISTS (SELECT 1 FROM material_measurement_set ms JOIN material_measurement mm ON mm.measurement_set_id=ms.id WHERE ms.material_event_input_id=ri.material_event_input_id AND mm.quantity_g IS NOT NULL)) OR
     EXISTS (SELECT 1 FROM recovery_event_output ro WHERE ro.recovery_event_id=event_key AND NOT EXISTS (SELECT 1 FROM material_measurement_set ms JOIN material_measurement mm ON mm.measurement_set_id=ms.id WHERE ms.material_event_output_id=ro.material_event_output_id AND mm.quantity_g IS NOT NULL)) THEN
    RAISE EXCEPTION 'every recovery input and output needs a quantity observation' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER recovery_event_complete_guard AFTER INSERT ON recovery_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_recovery_event_complete();
CREATE CONSTRAINT TRIGGER recovery_input_complete_guard AFTER INSERT ON recovery_event_input DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_recovery_event_complete();
CREATE CONSTRAINT TRIGGER recovery_output_complete_guard AFTER INSERT ON recovery_event_output DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_recovery_event_complete();
CREATE CONSTRAINT TRIGGER recovery_genealogy_complete_guard AFTER INSERT ON recovery_output_input_link DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_recovery_event_complete();

CREATE FUNCTION validate_residue_sale_shipment_mapping() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sale_batch UUID; item_batch UUID; sale_quantity NUMERIC(20,6); mapped_total NUMERIC(20,6); seller UUID; buyer UUID; sender UUID; recipient UUID;
BEGIN
  SELECT rsl.batch_id,rsl.accepted_trade_quantity_g,rs.seller_party_id,rs.buyer_party_id
    INTO sale_batch,sale_quantity,seller,buyer
    FROM residue_sale_line rsl JOIN residue_sale rs ON rs.id=rsl.residue_sale_id
    WHERE rsl.id=NEW.residue_sale_line_id AND rsl.is_accepted;
  SELECT ci.batch_id,c.sender_party_id,c.recipient_party_id INTO item_batch,sender,recipient
    FROM consignment_item ci JOIN consignment c ON c.id=ci.consignment_id WHERE ci.id=NEW.consignment_item_id;
  IF sale_batch IS NULL OR sale_batch<>item_batch OR NOT EXISTS (
    SELECT 1 FROM material_measurement_set ms JOIN material_measurement mm ON mm.measurement_set_id=ms.id
    WHERE ms.consignment_item_id=NEW.consignment_item_id AND ms.consignment_stage='DISPATCH' AND mm.id=NEW.basis_measurement_id AND mm.quantity_g>=NEW.mapped_quantity_g
  ) THEN RAISE EXCEPTION 'sale mapping must match the shipped batch and dispatch measurement' USING ERRCODE='23514'; END IF;
  SELECT COALESCE(sum(mapped_quantity_g),0) INTO mapped_total FROM residue_sale_shipment_item WHERE residue_sale_line_id=NEW.residue_sale_line_id;
  IF seller<>sender OR buyer<>recipient OR mapped_total+NEW.mapped_quantity_g>sale_quantity THEN
    RAISE EXCEPTION 'shipment mapping counterparties or quantity do not match the accepted sale' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER residue_sale_shipment_mapping_guard BEFORE INSERT ON residue_sale_shipment_item FOR EACH ROW EXECUTE FUNCTION validate_residue_sale_shipment_mapping();

CREATE FUNCTION validate_accepted_residue_sale_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE seller UUID; buyer UUID; seller_quantity NUMERIC(20,6); buyer_quantity NUMERIC(20,6);
BEGIN
  IF NEW.is_accepted THEN
    IF NEW.supersedes_line_id IS NULL OR NEW.accepted_trade_quantity_g IS NULL THEN
      RAISE EXCEPTION 'accepted residue terms require an append-only successor after counterparty decisions' USING ERRCODE='23514';
    END IF;
    SELECT rs.seller_party_id,rs.buyer_party_id INTO seller,buyer
      FROM residue_sale_line prior JOIN residue_sale rs ON rs.id=prior.residue_sale_id
      WHERE prior.id=NEW.supersedes_line_id AND prior.residue_sale_id=NEW.residue_sale_id AND prior.batch_id=NEW.batch_id;
    SELECT max(accepted_quantity_g) FILTER (WHERE actor_party_id=seller),
           max(accepted_quantity_g) FILTER (WHERE actor_party_id=buyer)
      INTO seller_quantity,buyer_quantity
      FROM residue_sale_decision_event WHERE residue_sale_line_id=NEW.supersedes_line_id AND decision='ACCEPT';
    IF seller_quantity IS NULL OR buyer_quantity IS NULL OR seller_quantity<>NEW.accepted_trade_quantity_g OR buyer_quantity<>NEW.accepted_trade_quantity_g THEN
      RAISE EXCEPTION 'both residue-sale counterparties must accept the same quantity before it is recorded' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER accepted_residue_sale_requires_counterparties BEFORE INSERT ON residue_sale_line FOR EACH ROW EXECUTE FUNCTION validate_accepted_residue_sale_line();

CREATE FUNCTION validate_custody_decision_party() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE recipient UUID;
BEGIN
  SELECT to_party_id INTO recipient FROM custody_transfer WHERE id=NEW.custody_transfer_id;
  IF recipient IS NULL OR (NEW.decision IN ('ACCEPT','DISPUTE','REJECT') AND NEW.actor_party_id<>recipient) THEN
    RAISE EXCEPTION 'custody acceptance, dispute or rejection must be recorded by the receiving party' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER custody_decision_party_guard BEFORE INSERT ON custody_transfer_decision FOR EACH ROW EXECUTE FUNCTION validate_custody_decision_party();

CREATE FUNCTION validate_custody_transfer_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE decision_exists BOOLEAN; destination_ok BOOLEAN;
BEGIN
  IF ROW(NEW.consignment_id,NEW.from_party_id,NEW.to_party_id,NEW.offered_at,NEW.offered_by_user_id,NEW.source_location_id,NEW.destination_location_id)
     IS DISTINCT FROM ROW(OLD.consignment_id,OLD.from_party_id,OLD.to_party_id,OLD.offered_at,OLD.offered_by_user_id,OLD.source_location_id,OLD.destination_location_id) THEN
    RAISE EXCEPTION 'custody offer facts are immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.status<>OLD.status THEN
    IF OLD.status<>'OFFERED' OR NEW.status NOT IN ('ACCEPTED','DISPUTED','REJECTED','WITHDRAWN') THEN
      RAISE EXCEPTION 'custody offer status transition is invalid' USING ERRCODE='23514';
    END IF;
    SELECT EXISTS(SELECT 1 FROM custody_transfer_decision d WHERE d.custody_transfer_id=NEW.id AND
      ((NEW.status='ACCEPTED' AND d.decision='ACCEPT') OR (NEW.status='DISPUTED' AND d.decision='DISPUTE') OR (NEW.status='REJECTED' AND d.decision='REJECT') OR (NEW.status='WITHDRAWN' AND d.decision='WITHDRAW'))) INTO decision_exists;
    IF NOT decision_exists THEN RAISE EXCEPTION 'custody offer decisions require an append-only decision record' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER custody_transfer_update_guard BEFORE UPDATE ON custody_transfer FOR EACH ROW EXECUTE FUNCTION validate_custody_transfer_update();

CREATE FUNCTION validate_custody_offer_items() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE transfer_id UUID; consignment_key UUID; transit_key UUID; dest_facility UUID; sender UUID; recipient UUID; item_count INTEGER;
BEGIN
  transfer_id:=COALESCE((to_jsonb(NEW)->>'custody_transfer_id')::UUID,(to_jsonb(NEW)->>'id')::UUID);
  SELECT ct.consignment_id,c.transit_location_id,c.destination_recovery_facility_id,c.sender_party_id,c.recipient_party_id
    INTO consignment_key,transit_key,dest_facility,sender,recipient
    FROM custody_transfer ct JOIN consignment c ON c.id=ct.consignment_id WHERE ct.id=transfer_id;
  IF consignment_key IS NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM custody_transfer ct JOIN recovery_inventory_location ril ON ril.inventory_location_id=ct.destination_location_id
    WHERE ct.id=transfer_id AND ct.from_party_id=sender AND ct.to_party_id=recipient AND ct.source_location_id=transit_key AND ril.recovery_facility_id=dest_facility) THEN
    RAISE EXCEPTION 'custody offer endpoints must match the consignment parties and locations' USING ERRCODE='23514';
  END IF;
  SELECT count(*) INTO item_count FROM consignment_item WHERE consignment_id=consignment_key;
  IF item_count=0 OR (SELECT count(*) FROM custody_transfer_item WHERE custody_transfer_id=transfer_id)<>item_count THEN
    RAISE EXCEPTION 'custody offer must list every consignment item' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM custody_transfer_item cti WHERE cti.custody_transfer_id=transfer_id AND NOT EXISTS (
    SELECT 1 FROM inventory_movement_line ml JOIN inventory_movement m ON m.id=ml.inventory_movement_id AND m.current_status='ACCEPTED'
    WHERE ml.consignment_item_id=cti.consignment_item_id AND ml.consignment_stage='DISPATCH' AND ml.direction='OUT' AND ml.posted_quantity_g=cti.quantity_g
  )) THEN RAISE EXCEPTION 'custody quantities must match accepted dispatched items' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER custody_offer_complete_guard AFTER INSERT OR UPDATE ON custody_transfer DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_custody_offer_items();
CREATE CONSTRAINT TRIGGER custody_offer_item_guard AFTER INSERT ON custody_transfer_item DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_custody_offer_items();

CREATE FUNCTION validate_recovery_source_quantity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt consignment_receipt_item%ROWTYPE; already_mapped NUMERIC(20,6); consumed NUMERIC(20,6);
BEGIN
  SELECT * INTO receipt FROM consignment_receipt_item WHERE id=NEW.consignment_receipt_item_id FOR UPDATE;
  IF receipt.outcome<>'ACCEPTED' OR receipt.batch_id<>NEW.batch_id OR receipt.consignment_item_id<>NEW.consignment_item_id THEN
    RAISE EXCEPTION 'recovery genealogy must refer to accepted receipt of the same batch' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(sum(source_quantity_g),0) INTO already_mapped FROM recovery_event_input_source
    WHERE consignment_receipt_item_id=NEW.consignment_receipt_item_id;
  IF already_mapped+NEW.source_quantity_g>receipt.quantity_g THEN
    RAISE EXCEPTION 'recovery genealogy cannot consume more than this accepted receipt quantity' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(sum(ml.posted_quantity_g),0) INTO consumed
    FROM recovery_event_input ri
    JOIN inventory_movement m ON m.event_id=ri.recovery_event_id AND m.current_status='ACCEPTED' AND m.movement_kind='TRANSFORMATION'
    JOIN inventory_movement_line ml ON ml.inventory_movement_id=m.id AND ml.material_event_input_id=ri.material_event_input_id AND ml.direction='OUT'
    WHERE ri.material_event_input_id=NEW.recovery_event_input_id;
  IF consumed>0 AND already_mapped+NEW.source_quantity_g>consumed THEN
    RAISE EXCEPTION 'source genealogy quantities cannot exceed the consumed input movement' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recovery_source_quantity_guard BEFORE INSERT ON recovery_event_input_source FOR EACH ROW EXECUTE FUNCTION validate_recovery_source_quantity();

CREATE FUNCTION validate_phase_three_recorded_movement_links() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE movement_key UUID; movement_kind_value TEXT; item RECORD; movement_quantity NUMERIC(20,6); source_quantity NUMERIC(20,6);
BEGIN
  IF TG_TABLE_NAME='inventory_movement' THEN movement_key:=NEW.id;
  ELSIF TG_TABLE_NAME='inventory_movement_line' THEN movement_key:=NEW.inventory_movement_id;
  ELSE movement_key:=NEW.id;
  END IF;
  SELECT movement_kind INTO movement_kind_value FROM inventory_movement WHERE id=movement_key AND current_status='ACCEPTED';
  IF movement_kind_value IS NULL THEN RETURN NULL; END IF;
  IF movement_kind_value='TRANSFER' THEN
    FOR item IN SELECT DISTINCT ci.id,ci.consignment_id,ci.batch_id FROM inventory_movement_line ml JOIN consignment_item ci ON ci.id=ml.consignment_item_id
      WHERE ml.inventory_movement_id=movement_key AND ml.consignment_stage='RECEIPT'
    LOOP
      IF EXISTS (SELECT 1 FROM inventory_movement_line ml WHERE ml.inventory_movement_id=movement_key AND ml.consignment_item_id=item.id AND ml.consignment_stage='RECEIPT' AND ml.direction='IN') THEN
        SELECT COALESCE(sum(posted_quantity_g),0) INTO movement_quantity FROM inventory_movement_line ml WHERE ml.inventory_movement_id=movement_key AND ml.consignment_item_id=item.id AND ml.consignment_stage='RECEIPT' AND ml.direction='IN';
        SELECT quantity_g INTO source_quantity FROM consignment_receipt_item ri WHERE ri.id=(SELECT consignment_receipt_item_id FROM inventory_movement_line WHERE inventory_movement_id=movement_key AND consignment_item_id=item.id LIMIT 1);
        IF movement_quantity<>source_quantity THEN RAISE EXCEPTION 'accepted receipt record must be posted as one complete paired transfer' USING ERRCODE='23514'; END IF;
      END IF;
    END LOOP;
  ELSIF movement_kind_value='TRANSFORMATION' THEN
    FOR item IN SELECT ri.material_event_input_id FROM inventory_movement_line ml JOIN recovery_event_input ri ON ri.material_event_input_id=ml.material_event_input_id
      WHERE ml.inventory_movement_id=movement_key AND ml.direction='OUT'
    LOOP
      SELECT COALESCE(sum(ml.posted_quantity_g),0) INTO movement_quantity FROM inventory_movement_line ml WHERE ml.inventory_movement_id=movement_key AND ml.material_event_input_id=item.material_event_input_id AND ml.direction='OUT';
      SELECT COALESCE(sum(source_quantity_g),0) INTO source_quantity FROM recovery_event_input_source WHERE recovery_event_input_id=item.material_event_input_id;
      IF movement_quantity<>source_quantity THEN RAISE EXCEPTION 'recovery input genealogy quantities must reconcile to consumed movement quantity' USING ERRCODE='23514'; END IF;
    END LOOP;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER phase_three_movement_links_header_guard AFTER INSERT OR UPDATE ON inventory_movement DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_phase_three_recorded_movement_links();
CREATE CONSTRAINT TRIGGER phase_three_movement_links_line_guard AFTER INSERT ON inventory_movement_line DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_phase_three_recorded_movement_links();

CREATE FUNCTION validate_consignment_status_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_exists BOOLEAN;
BEGIN
  IF NEW.status=OLD.status THEN RETURN NEW; END IF;
  IF NOT ((OLD.status='DRAFT' AND NEW.status='DISPATCHED') OR
          (OLD.status IN ('DISPATCHED','PART_RECEIVED','DISPUTED') AND NEW.status IN ('PART_RECEIVED','RECEIVED','DISPUTED','CLOSED'))) THEN
    RAISE EXCEPTION 'consignment status transition is invalid' USING ERRCODE='23514';
  END IF;
  SELECT EXISTS(SELECT 1 FROM consignment_status_event e WHERE e.consignment_id=NEW.id AND e.previous_status=OLD.status AND e.next_status=NEW.status) INTO event_exists;
  IF NOT event_exists THEN RAISE EXCEPTION 'consignment status changes require an append-only status event' USING ERRCODE='23514'; END IF;
  IF NEW.status='DISPATCHED' AND (NEW.dispatched_at IS NULL OR NEW.dispatched_by_user_id IS NULL OR NOT EXISTS(SELECT 1 FROM consignment_item WHERE consignment_id=NEW.id)) THEN
    RAISE EXCEPTION 'dispatch status requires dispatch context and itemized residue' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER consignment_status_transition_guard BEFORE UPDATE OF status ON consignment FOR EACH ROW EXECUTE FUNCTION validate_consignment_status_transition();

CREATE FUNCTION validate_recovery_source_record_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM consignment_receipt_item ri WHERE ri.id=NEW.consignment_receipt_item_id AND ri.outcome='ACCEPTED' AND ri.batch_id=NEW.batch_id AND ri.consignment_item_id=NEW.consignment_item_id) THEN
    RAISE EXCEPTION 'recovery sources must be accepted receipts for the same residue batch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER consignment_status_event_append_only BEFORE UPDATE OR DELETE ON consignment_status_event FOR EACH ROW EXECUTE FUNCTION reject_phase_three_event_mutation();

CREATE TABLE phase_three_migration_marker (
  marker TEXT PRIMARY KEY,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO phase_three_migration_marker(marker) VALUES ('residue-pooling-custody-recovery-v1');
