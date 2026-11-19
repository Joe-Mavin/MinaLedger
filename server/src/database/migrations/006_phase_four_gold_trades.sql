-- Phase 4: bilateral gold trade proposals, evidence, custody and settlement.
-- Existing Phase 1-3 records remain in place; this migration only adds facts
-- and guards required by the gold-merchant workflow.

ALTER TABLE gold_trade
  ALTER COLUMN agreed_at DROP NOT NULL,
  ADD COLUMN trade_date TIMESTAMPTZ,
  ADD COLUMN created_by_user_id UUID REFERENCES user_account(id) ON DELETE RESTRICT,
  ADD COLUMN status TEXT NOT NULL DEFAULT 'AGREED'
    CHECK (status IN ('PROPOSED','DISPUTED','AGREED','CLOSED'));

ALTER TABLE gold_trade_line
  ADD COLUMN deduction_amount NUMERIC(20,8) NOT NULL DEFAULT 0 CHECK (deduction_amount >= 0),
  ADD COLUMN deduction_reason TEXT,
  ADD CONSTRAINT gold_trade_line_deduction_shape_check
    CHECK ((deduction_amount=0 AND deduction_reason IS NULL) OR
      (deduction_amount>0 AND length(trim(COALESCE(deduction_reason,'')))>0));

ALTER TABLE commercial_line_decision_event
  ADD COLUMN accepted_quantity_g NUMERIC(20,6),
  ADD COLUMN accepted_unit_price NUMERIC(20,8),
  ADD COLUMN accepted_line_amount NUMERIC(20,8),
  ADD COLUMN accepted_deduction_amount NUMERIC(20,8);
CREATE UNIQUE INDEX commercial_gold_line_one_party_decision_idx
  ON commercial_line_decision_event(gold_trade_line_id,actor_party_id)
  WHERE gold_trade_line_id IS NOT NULL;

CREATE TABLE gold_trade_status_event (
  id UUID PRIMARY KEY,
  gold_trade_id UUID NOT NULL REFERENCES gold_trade(id) ON DELETE RESTRICT,
  previous_status TEXT CHECK (previous_status IN ('PROPOSED','DISPUTED','AGREED','CLOSED')),
  next_status TEXT NOT NULL CHECK (next_status IN ('PROPOSED','DISPUTED','AGREED','CLOSED')),
  actor_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  actor_party_id UUID NOT NULL REFERENCES party(id) ON DELETE RESTRICT,
  occurred_at TIMESTAMPTZ NOT NULL,
  reason TEXT,
  evidence_ref TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((previous_status IS NULL AND next_status='PROPOSED') OR
    (previous_status IS NOT NULL AND previous_status<>next_status))
);
CREATE INDEX gold_trade_status_history_idx ON gold_trade_status_event(gold_trade_id,recorded_at,id);

CREATE TABLE gold_trade_evidence (
  id UUID PRIMARY KEY,
  gold_trade_id UUID NOT NULL REFERENCES gold_trade(id) ON DELETE RESTRICT,
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('TERMS','WEIGHT','ASSAY','CUSTODY','PAYMENT','OTHER')),
  evidence_ref TEXT NOT NULL CHECK (length(trim(evidence_ref))>0),
  note TEXT,
  actor_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  actor_party_id UUID NOT NULL REFERENCES party(id) ON DELETE RESTRICT,
  occurred_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX gold_trade_evidence_history_idx ON gold_trade_evidence(gold_trade_id,recorded_at,id);

CREATE TABLE gold_trade_payment_marker (
  marker TEXT PRIMARY KEY CHECK (marker='phase-four-gold-trades'),
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO gold_trade_payment_marker(marker) VALUES ('phase-four-gold-trades');

ALTER TABLE assay_record
  ADD COLUMN recorded_by_user_id UUID REFERENCES user_account(id) ON DELETE RESTRICT,
  ADD COLUMN correction_reason TEXT,
  ADD CONSTRAINT assay_record_correction_shape_check
    CHECK ((correction_of_id IS NULL AND correction_reason IS NULL) OR
      (correction_of_id IS NOT NULL AND length(trim(COALESCE(correction_reason,'')))>0));
CREATE UNIQUE INDEX assay_record_single_successor_idx
  ON assay_record(correction_of_id) WHERE correction_of_id IS NOT NULL;

ALTER TABLE custody_transfer
  ADD COLUMN gold_trade_line_id UUID REFERENCES gold_trade_line(id) ON DELETE RESTRICT,
  ADD COLUMN quantity_g NUMERIC(20,6),
  ADD COLUMN measurement_set_id UUID,
  ADD COLUMN measurement_id UUID,
  ADD CONSTRAINT custody_gold_transfer_shape_check CHECK (
    (gold_trade_line_id IS NULL AND quantity_g IS NULL) OR
    (gold_trade_line_id IS NOT NULL AND batch_id IS NOT NULL AND quantity_g>0 AND consignment_id IS NULL)
  ),
  ADD CONSTRAINT custody_gold_measurement_shape_check CHECK (
    (gold_trade_line_id IS NULL AND measurement_set_id IS NULL AND measurement_id IS NULL) OR
    (gold_trade_line_id IS NOT NULL AND measurement_set_id IS NOT NULL AND measurement_id IS NOT NULL)
  ),
  ADD CONSTRAINT custody_gold_measurement_fk FOREIGN KEY (measurement_id,measurement_set_id)
    REFERENCES material_measurement(id,measurement_set_id) ON DELETE RESTRICT;
ALTER TABLE custody_transfer
  ADD CONSTRAINT custody_gold_movement_fk FOREIGN KEY (linked_inventory_movement_id)
  REFERENCES inventory_movement(id) ON DELETE RESTRICT;

ALTER TABLE payment_event DROP CONSTRAINT IF EXISTS payment_event_event_kind_check;
ALTER TABLE payment_event ADD CONSTRAINT payment_event_event_kind_check
  CHECK (event_kind IN ('REPORTED','CONFIRMED','DISPUTED','FAILED','REVERSAL','CORRECTION'));
ALTER TABLE payment_event
  ADD COLUMN actor_party_id UUID REFERENCES party(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX payment_event_one_report_per_payment_idx
  ON payment_event(payment_id) WHERE event_kind='REPORTED';
CREATE UNIQUE INDEX payment_event_one_resolution_per_report_idx
  ON payment_event(related_event_id) WHERE event_kind IN ('CONFIRMED','FAILED');
CREATE UNIQUE INDEX payment_event_one_dispute_per_report_idx
  ON payment_event(related_event_id) WHERE event_kind='DISPUTED';

CREATE OR REPLACE FUNCTION reject_gold_trade_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE='55000';
END $$;
CREATE TRIGGER gold_trade_status_event_immutable BEFORE UPDATE OR DELETE ON gold_trade_status_event
  FOR EACH ROW EXECUTE FUNCTION reject_gold_trade_history_mutation();
CREATE TRIGGER gold_trade_evidence_immutable BEFORE UPDATE OR DELETE ON gold_trade_evidence
  FOR EACH ROW EXECUTE FUNCTION reject_gold_trade_history_mutation();
CREATE TRIGGER gold_trade_payment_marker_immutable BEFORE UPDATE OR DELETE ON gold_trade_payment_marker
  FOR EACH ROW EXECUTE FUNCTION reject_gold_trade_history_mutation();
CREATE TRIGGER assay_record_phase_four_immutable BEFORE UPDATE OR DELETE ON assay_record
  FOR EACH ROW EXECUTE FUNCTION reject_gold_trade_history_mutation();
CREATE TRIGGER payment_phase_four_immutable BEFORE UPDATE OR DELETE ON payment
  FOR EACH ROW EXECUTE FUNCTION reject_gold_trade_history_mutation();

CREATE OR REPLACE FUNCTION validate_gold_trade_status() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_exists BOOLEAN; all_lines_agreed BOOLEAN;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'PROPOSED' OR NEW.created_by_user_id IS NULL OR NEW.trade_date IS NULL OR
       NOT EXISTS(SELECT 1 FROM party WHERE id=NEW.seller_party_id AND status='ACTIVE') OR
       NOT EXISTS(SELECT 1 FROM party WHERE id=NEW.buyer_party_id AND status='ACTIVE') OR
       NOT EXISTS(SELECT 1 FROM party_participation WHERE party_id=NEW.buyer_party_id AND participant_kind IN ('LOCAL_MERCHANT','LARGER_MERCHANT') AND status='ACTIVE' AND valid_from<=NEW.trade_date AND (valid_to IS NULL OR valid_to>NEW.trade_date)) THEN
      RAISE EXCEPTION 'new gold trades require an active eligible buyer, seller, creator and trade date' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status=OLD.status THEN RETURN NEW; END IF;
  IF NOT ((OLD.status='PROPOSED' AND NEW.status IN ('DISPUTED','AGREED','CLOSED')) OR
          (OLD.status='DISPUTED' AND NEW.status IN ('PROPOSED','AGREED','CLOSED')) OR
          (OLD.status='AGREED' AND NEW.status='CLOSED')) THEN
    RAISE EXCEPTION 'gold trade status transition is invalid' USING ERRCODE='23514';
  END IF;
  SELECT EXISTS(SELECT 1 FROM gold_trade_status_event e WHERE e.gold_trade_id=NEW.id
    AND e.previous_status=OLD.status AND e.next_status=NEW.status) INTO event_exists;
  IF NOT event_exists THEN RAISE EXCEPTION 'gold trade status changes require an append-only history event' USING ERRCODE='23514'; END IF;
  IF NEW.status='AGREED' THEN
    SELECT count(*)>0 AND bool_and(current_line.is_accepted AND current_line.accepted_trade_quantity_g IS NOT NULL)
      INTO all_lines_agreed
      FROM gold_trade_line current_line
      WHERE current_line.trade_id=NEW.id AND NOT EXISTS (
        SELECT 1 FROM gold_trade_line successor WHERE successor.supersedes_line_id=current_line.id);
    IF NOT COALESCE(all_lines_agreed,false) OR NEW.agreed_at IS NULL THEN
      RAISE EXCEPTION 'a gold trade can be agreed only with bilateral acceptance of each current line' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER gold_trade_status_guard BEFORE INSERT OR UPDATE OF status,agreed_at ON gold_trade
  FOR EACH ROW EXECUTE FUNCTION validate_gold_trade_status();

CREATE FUNCTION validate_gold_trade_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.trade_code,NEW.trade_kind,NEW.buyer_party_id,NEW.seller_party_id,NEW.currency_code,NEW.terms_ref,NEW.supersedes_trade_id,NEW.correction_reason,NEW.trade_date,NEW.created_by_user_id)
    IS DISTINCT FROM ROW(OLD.trade_code,OLD.trade_kind,OLD.buyer_party_id,OLD.seller_party_id,OLD.currency_code,OLD.terms_ref,OLD.supersedes_trade_id,OLD.correction_reason,OLD.trade_date,OLD.created_by_user_id) THEN
    RAISE EXCEPTION 'gold trade proposal facts are immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER gold_trade_identity_immutable BEFORE UPDATE ON gold_trade
  FOR EACH ROW EXECUTE FUNCTION validate_gold_trade_identity_immutable();

CREATE FUNCTION validate_phase_four_trade_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM gold_trade_status_event e WHERE e.gold_trade_id=NEW.id AND e.previous_status IS NULL AND e.next_status='PROPOSED')
    OR NOT EXISTS(SELECT 1 FROM gold_trade_line l WHERE l.trade_id=NEW.id) THEN
    RAISE EXCEPTION 'a new gold trade requires initial status history and at least one proposed gold line' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER phase_four_trade_complete_guard AFTER INSERT ON gold_trade
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_phase_four_trade_complete();

CREATE FUNCTION validate_gold_trade_status_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE trade gold_trade%ROWTYPE; user_party UUID;
BEGIN
  SELECT * INTO trade FROM gold_trade WHERE id=NEW.gold_trade_id;
  SELECT person_party_id INTO user_party FROM user_account WHERE id=NEW.actor_user_id;
  IF trade.id IS NULL OR NEW.actor_party_id NOT IN (trade.seller_party_id,trade.buyer_party_id) OR (user_party<>NEW.actor_party_id AND NOT EXISTS (
      SELECT 1 FROM organisation_membership om WHERE om.person_party_id=user_party
        AND om.organisation_party_id=NEW.actor_party_id AND om.status='ACTIVE'
        AND om.valid_from<=NEW.occurred_at AND (om.valid_to IS NULL OR om.valid_to>NEW.occurred_at))) THEN
    RAISE EXCEPTION 'gold trade history actor must represent the recorded party' USING ERRCODE='23514';
  END IF;
  IF NEW.previous_status IS NULL THEN
    IF trade.status<>'PROPOSED' OR EXISTS(SELECT 1 FROM gold_trade_status_event WHERE gold_trade_id=NEW.gold_trade_id) THEN
      RAISE EXCEPTION 'gold trade requires exactly one initial proposed status event' USING ERRCODE='23514';
    END IF;
  ELSIF trade.status<>NEW.previous_status THEN
    RAISE EXCEPTION 'gold trade status history does not match the current status' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER gold_trade_status_event_guard BEFORE INSERT ON gold_trade_status_event
  FOR EACH ROW EXECUTE FUNCTION validate_gold_trade_status_event();

CREATE FUNCTION validate_phase_four_gold_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE trade gold_trade%ROWTYPE; eligible BOOLEAN; available NUMERIC(20,6); committed NUMERIC(20,6);
BEGIN
  SELECT * INTO trade FROM gold_trade WHERE id=NEW.trade_id FOR UPDATE;
  IF trade.id IS NULL OR trade.status NOT IN ('PROPOSED','DISPUTED') THEN
    RAISE EXCEPTION 'gold trade lines may be proposed only while the trade is open' USING ERRCODE='23514';
  END IF;
  SELECT EXISTS(
    SELECT 1 FROM material_event_output o JOIN material_event e ON e.id=o.event_id
    JOIN material_batch b ON b.id=o.batch_id
    WHERE o.batch_id=NEW.batch_id AND e.current_status IN ('SUBMITTED','ACCEPTED')
      AND ((b.material_kind='GOLD_DORE' AND EXISTS(SELECT 1 FROM production_event_output p WHERE p.material_event_output_id=o.id))
        OR (b.material_kind IN ('GOLD_DORE','RECOVERED_GOLD') AND EXISTS(
          SELECT 1 FROM processing_event_output p WHERE p.material_event_output_id=o.id AND p.output_role='MINER_RETAINED_GOLD'))
        OR (b.material_kind='RECOVERED_GOLD' AND EXISTS(
          SELECT 1 FROM recovery_event_output r WHERE r.material_event_output_id=o.id AND r.output_role='RECOVERED_GOLD')))
  ) INTO eligible;
  IF NOT eligible THEN RAISE EXCEPTION 'gold trade batch must be an eligible accepted gold output' USING ERRCODE='23514'; END IF;
  SELECT COALESCE(sum(balance.quantity_g),0) INTO available FROM inventory_balance balance
    JOIN inventory_location location ON location.id=balance.location_id
    LEFT JOIN merchant_inventory_location merchant ON merchant.inventory_location_id=location.id
    WHERE balance.batch_id=NEW.batch_id AND location.status='ACTIVE'
      AND (location.custodian_party_id=trade.seller_party_id OR merchant.merchant_party_id=trade.seller_party_id);
  SELECT COALESCE(sum(GREATEST(line.accepted_trade_quantity_g-COALESCE(moved.quantity_g,0),0)),0) INTO committed
    FROM gold_trade_line line JOIN gold_trade other_trade ON other_trade.id=line.trade_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(outgoing.posted_quantity_g-COALESCE(reversed.quantity_g,0)),0)::NUMERIC(20,6) AS quantity_g
      FROM inventory_movement_line outgoing JOIN inventory_movement movement ON movement.id=outgoing.inventory_movement_id AND movement.current_status='ACCEPTED'
      LEFT JOIN LATERAL (SELECT sum(reverse_line.posted_quantity_g) AS quantity_g FROM inventory_movement_line reverse_line
        JOIN inventory_movement reverse_movement ON reverse_movement.id=reverse_line.inventory_movement_id AND reverse_movement.current_status='ACCEPTED' AND reverse_movement.movement_kind='REVERSAL'
        WHERE reverse_line.reverses_line_id=outgoing.id) reversed ON true
      WHERE outgoing.gold_trade_line_id=line.id AND outgoing.direction='OUT'
    ) moved ON true
    WHERE line.batch_id=NEW.batch_id AND other_trade.seller_party_id=trade.seller_party_id
      AND other_trade.id<>trade.id AND line.is_accepted
      AND NOT EXISTS(SELECT 1 FROM gold_trade_line child WHERE child.supersedes_line_id=line.id);
  IF available-committed<NEW.transaction_quantity_g THEN
    RAISE EXCEPTION 'proposed gold quantity exceeds the seller inventory currently available' USING ERRCODE='23514';
  END IF;
  IF NEW.unit_price IS NULL OR NEW.line_amount IS NULL OR NEW.line_amount<>round(NEW.transaction_quantity_g*NEW.unit_price,8)
      OR NEW.deduction_amount>NEW.line_amount THEN
    RAISE EXCEPTION 'gold trade line price, gross amount and deduction are inconsistent' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER phase_four_gold_line_guard BEFORE INSERT ON gold_trade_line
  FOR EACH ROW EXECUTE FUNCTION validate_phase_four_gold_line();

CREATE OR REPLACE FUNCTION validate_commercial_line_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'commercial line revisions are append-only' USING ERRCODE='55000'; END IF;
  IF TG_TABLE_NAME='gold_trade_line' THEN
    IF ROW(NEW.trade_id,NEW.batch_id,NEW.revision_no,NEW.revision_kind,NEW.transaction_quantity_g,NEW.accepted_trade_quantity_g,NEW.unit_price,NEW.line_amount,NEW.assay_record_id,NEW.supersedes_line_id,NEW.correction_reason,NEW.deduction_amount,NEW.deduction_reason)
       IS DISTINCT FROM ROW(OLD.trade_id,OLD.batch_id,OLD.revision_no,OLD.revision_kind,OLD.transaction_quantity_g,OLD.accepted_trade_quantity_g,OLD.unit_price,OLD.line_amount,OLD.assay_record_id,OLD.supersedes_line_id,OLD.correction_reason,OLD.deduction_amount,OLD.deduction_reason) THEN
      RAISE EXCEPTION 'commercial line terms are immutable; create a linked revision' USING ERRCODE='55000';
    END IF;
  ELSE
    IF ROW(NEW.residue_sale_id,NEW.batch_id,NEW.revision_no,NEW.revision_kind,NEW.transaction_quantity_g,NEW.accepted_trade_quantity_g,NEW.unit_price,NEW.line_amount,NEW.supersedes_line_id,NEW.correction_reason)
       IS DISTINCT FROM ROW(OLD.residue_sale_id,OLD.batch_id,OLD.revision_no,OLD.revision_kind,OLD.transaction_quantity_g,OLD.accepted_trade_quantity_g,OLD.unit_price,OLD.line_amount,OLD.supersedes_line_id,OLD.correction_reason) THEN
      RAISE EXCEPTION 'commercial line terms are immutable; create a linked revision' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER gold_trade_line_immutable ON gold_trade_line;
CREATE TRIGGER gold_trade_line_immutable BEFORE UPDATE OR DELETE ON gold_trade_line
  FOR EACH ROW EXECUTE FUNCTION validate_commercial_line_immutable();

CREATE FUNCTION validate_gold_trade_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line gold_trade_line%ROWTYPE; trade gold_trade%ROWTYPE; user_party UUID;
BEGIN
  IF NEW.gold_trade_line_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO line FROM gold_trade_line WHERE id=NEW.gold_trade_line_id;
  SELECT * INTO trade FROM gold_trade WHERE id=line.trade_id FOR UPDATE;
  SELECT person_party_id INTO user_party FROM user_account WHERE id=NEW.actor_user_id;
  IF line.id IS NULL OR trade.status NOT IN ('PROPOSED','DISPUTED')
    OR NOT (NEW.actor_party_id IN (trade.seller_party_id,trade.buyer_party_id))
    OR NOT (user_party=NEW.actor_party_id OR EXISTS(
      SELECT 1 FROM organisation_membership om WHERE om.person_party_id=user_party
        AND om.organisation_party_id=NEW.actor_party_id AND om.status='ACTIVE'
        AND om.valid_from<=NEW.occurred_at AND (om.valid_to IS NULL OR om.valid_to>NEW.occurred_at))) THEN
    RAISE EXCEPTION 'gold line decision actor must be an authorized trade counterparty' USING ERRCODE='23514';
  END IF;
  IF NEW.decision='ACCEPT' THEN
    IF NEW.accepted_quantity_g IS NULL OR NEW.accepted_unit_price IS NULL OR NEW.accepted_line_amount IS NULL
      OR NEW.accepted_deduction_amount IS NULL
      OR NEW.accepted_line_amount<>round(NEW.accepted_quantity_g*NEW.accepted_unit_price,8)
      OR NEW.accepted_deduction_amount>NEW.accepted_line_amount OR NEW.reason IS NOT NULL THEN
      RAISE EXCEPTION 'gold line acceptance must record complete consistent terms' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.accepted_quantity_g IS NOT NULL OR NEW.accepted_unit_price IS NOT NULL
      OR NEW.accepted_line_amount IS NOT NULL OR NEW.accepted_deduction_amount IS NOT NULL
      OR length(trim(COALESCE(NEW.reason,'')))=0 THEN
    RAISE EXCEPTION 'non-acceptance gold decisions require a reason and no accepted terms' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER phase_four_gold_decision_guard BEFORE INSERT ON commercial_line_decision_event
  FOR EACH ROW EXECUTE FUNCTION validate_gold_trade_decision();

CREATE FUNCTION validate_gold_line_acceptance_successor() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE seller UUID; buyer UUID; seller_qty NUMERIC(20,6); buyer_qty NUMERIC(20,6);
  seller_price NUMERIC(20,8); buyer_price NUMERIC(20,8); seller_amount NUMERIC(20,8); buyer_amount NUMERIC(20,8);
  seller_deduction NUMERIC(20,8); buyer_deduction NUMERIC(20,8); previous_line gold_trade_line%ROWTYPE;
BEGIN
  IF NEW.is_accepted THEN
    IF NEW.supersedes_line_id IS NULL OR NEW.accepted_trade_quantity_g IS NULL THEN
      RAISE EXCEPTION 'accepted gold terms require a linked successor after bilateral decisions' USING ERRCODE='23514';
    END IF;
    SELECT * INTO previous_line FROM gold_trade_line WHERE id=NEW.supersedes_line_id
      AND trade_id=NEW.trade_id AND batch_id=NEW.batch_id;
    SELECT t.seller_party_id,t.buyer_party_id INTO seller,buyer FROM gold_trade t WHERE t.id=NEW.trade_id;
    SELECT max(d.accepted_quantity_g) FILTER(WHERE d.actor_party_id=seller),
      max(d.accepted_quantity_g) FILTER(WHERE d.actor_party_id=buyer),
      max(d.accepted_unit_price) FILTER(WHERE d.actor_party_id=seller),
      max(d.accepted_unit_price) FILTER(WHERE d.actor_party_id=buyer),
      max(d.accepted_line_amount) FILTER(WHERE d.actor_party_id=seller),
      max(d.accepted_line_amount) FILTER(WHERE d.actor_party_id=buyer),
      max(d.accepted_deduction_amount) FILTER(WHERE d.actor_party_id=seller),
      max(d.accepted_deduction_amount) FILTER(WHERE d.actor_party_id=buyer)
    INTO seller_qty,buyer_qty,seller_price,buyer_price,seller_amount,buyer_amount,seller_deduction,buyer_deduction
    FROM commercial_line_decision_event d WHERE d.gold_trade_line_id=previous_line.id AND d.decision='ACCEPT';
    IF previous_line.id IS NULL OR seller_qty IS NULL OR buyer_qty IS NULL OR
      ROW(seller_qty,seller_price,seller_amount,seller_deduction) IS DISTINCT FROM ROW(buyer_qty,buyer_price,buyer_amount,buyer_deduction) OR
      ROW(NEW.accepted_trade_quantity_g,NEW.unit_price,NEW.line_amount,NEW.deduction_amount) IS DISTINCT FROM ROW(seller_qty,seller_price,seller_amount,seller_deduction) OR
      NEW.transaction_quantity_g<>NEW.accepted_trade_quantity_g OR NEW.is_accepted IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'accepted gold line must exactly match both counterparties decisions on its predecessor' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER gold_line_acceptance_requires_bilateral_terms BEFORE INSERT ON gold_trade_line
  FOR EACH ROW EXECUTE FUNCTION validate_gold_line_acceptance_successor();

CREATE FUNCTION validate_assay_correction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous assay_record%ROWTYPE;
BEGIN
  IF NEW.correction_of_id IS NOT NULL THEN
    SELECT * INTO previous FROM assay_record WHERE id=NEW.correction_of_id;
    IF previous.id IS NULL OR previous.batch_id<>NEW.batch_id OR
      EXISTS(SELECT 1 FROM assay_record successor WHERE successor.correction_of_id=previous.id) THEN
      RAISE EXCEPTION 'assay correction must link the current observation for the same batch' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assay_correction_guard BEFORE INSERT ON assay_record
  FOR EACH ROW EXECUTE FUNCTION validate_assay_correction();

CREATE FUNCTION validate_gold_custody_offer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line gold_trade_line%ROWTYPE; trade gold_trade%ROWTYPE; source_location inventory_location%ROWTYPE;
  destination_location inventory_location%ROWTYPE; measurement_quantity NUMERIC(20,6);
BEGIN
  IF NEW.gold_trade_line_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO line FROM gold_trade_line WHERE id=NEW.gold_trade_line_id;
  SELECT * INTO trade FROM gold_trade WHERE id=line.trade_id;
  SELECT * INTO source_location FROM inventory_location WHERE id=NEW.source_location_id;
  SELECT * INTO destination_location FROM inventory_location WHERE id=NEW.destination_location_id;
  IF NEW.batch_id<>line.batch_id OR NOT line.is_accepted OR trade.status NOT IN ('AGREED','CLOSED') OR
    NEW.from_party_id<>trade.seller_party_id OR NEW.to_party_id<>trade.buyer_party_id OR
    source_location.status<>'ACTIVE' OR destination_location.status<>'ACTIVE' OR
    NOT (source_location.custodian_party_id=trade.seller_party_id OR EXISTS(
      SELECT 1 FROM merchant_inventory_location m WHERE m.inventory_location_id=source_location.id AND m.merchant_party_id=trade.seller_party_id)) OR
    NOT (destination_location.custodian_party_id=trade.buyer_party_id OR EXISTS(
      SELECT 1 FROM merchant_inventory_location m WHERE m.inventory_location_id=destination_location.id AND m.merchant_party_id=trade.buyer_party_id)) OR
       NOT EXISTS(SELECT 1 FROM material_measurement_set ms JOIN material_measurement mm ON mm.measurement_set_id=ms.id
       WHERE ms.id=NEW.measurement_set_id AND ms.gold_trade_line_id=line.id AND mm.id=NEW.measurement_id
         AND mm.quantity_g=NEW.quantity_g AND mm.measurement_kind IN ('MEASURED','VERIFIED')
         AND NOT EXISTS(SELECT 1 FROM material_measurement successor WHERE successor.supersedes_measurement_id=mm.id)) THEN
    RAISE EXCEPTION 'gold custody offer must match an agreed line, counterparties, locations and current measured evidence' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER gold_custody_offer_guard BEFORE INSERT ON custody_transfer
  FOR EACH ROW EXECUTE FUNCTION validate_gold_custody_offer();

CREATE FUNCTION validate_gold_custody_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE movement_matches BOOLEAN;
BEGIN
  IF NEW.gold_trade_line_id IS NOT NULL AND
     ROW(NEW.gold_trade_line_id,NEW.quantity_g,NEW.measurement_set_id,NEW.measurement_id,NEW.batch_id,NEW.from_party_id,NEW.to_party_id,NEW.offered_at,NEW.offered_by_user_id,NEW.source_location_id,NEW.destination_location_id)
       IS DISTINCT FROM ROW(OLD.gold_trade_line_id,OLD.quantity_g,OLD.measurement_set_id,OLD.measurement_id,OLD.batch_id,OLD.from_party_id,OLD.to_party_id,OLD.offered_at,OLD.offered_by_user_id,OLD.source_location_id,OLD.destination_location_id) THEN
    RAISE EXCEPTION 'gold custody offer facts are immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.gold_trade_line_id IS NOT NULL AND NEW.status='ACCEPTED' AND NEW.linked_inventory_movement_id IS NOT NULL THEN
    SELECT count(*)=2 AND bool_and(m.current_status='ACCEPTED') INTO movement_matches
      FROM inventory_movement m JOIN inventory_movement_line ml ON ml.inventory_movement_id=m.id
      WHERE m.id=NEW.linked_inventory_movement_id AND m.movement_kind='TRANSFER' AND ml.batch_id=NEW.batch_id
        AND ml.posted_quantity_g=NEW.quantity_g AND
        ((ml.direction='OUT' AND ml.location_id=NEW.source_location_id AND ml.gold_trade_line_id=NEW.gold_trade_line_id) OR
         (ml.direction='IN' AND ml.location_id=NEW.destination_location_id AND ml.gold_trade_line_id IS NULL));
    IF NOT COALESCE(movement_matches,false) THEN RAISE EXCEPTION 'accepted gold custody requires its balanced inventory movement' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER gold_custody_update_guard BEFORE UPDATE ON custody_transfer
  FOR EACH ROW EXECUTE FUNCTION validate_gold_custody_update();

CREATE FUNCTION validate_gold_payment_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pay payment%ROWTYPE; trade gold_trade%ROWTYPE; report payment_event%ROWTYPE;
  due NUMERIC(20,8); settled NUMERIC(20,8); reported NUMERIC(20,8); actor_person UUID;
BEGIN
  IF NEW.actor_party_id IS NULL THEN
    RAISE EXCEPTION 'payment events require the recorded actor party' USING ERRCODE='23514';
  END IF;
  SELECT * INTO pay FROM payment WHERE id=NEW.payment_id;
  IF pay.gold_trade_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO trade FROM gold_trade WHERE id=pay.gold_trade_id FOR UPDATE;
  SELECT person_party_id INTO actor_person FROM user_account WHERE id=NEW.actor_user_id;
  IF actor_person<>NEW.actor_party_id AND NOT EXISTS(SELECT 1 FROM organisation_membership om
      WHERE om.person_party_id=actor_person AND om.organisation_party_id=NEW.actor_party_id AND om.status='ACTIVE'
        AND om.valid_from<=NEW.occurred_at_claimed AND (om.valid_to IS NULL OR om.valid_to>NEW.occurred_at_claimed)) THEN
    RAISE EXCEPTION 'payment event actor must represent its recorded party' USING ERRCODE='23514';
  END IF;
  IF trade.status NOT IN ('AGREED','CLOSED') THEN RAISE EXCEPTION 'payments require an agreed gold trade' USING ERRCODE='23514'; END IF;
  IF NEW.event_kind='REPORTED' THEN
    IF NEW.related_event_id IS NOT NULL OR NEW.direction<>'CREDIT' OR NEW.actor_party_id<>pay.payer_party_id THEN
      RAISE EXCEPTION 'payment reports must be credited by the recorded payer' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.event_kind='REVERSAL' THEN
    SELECT * INTO report FROM payment_event WHERE id=NEW.related_event_id AND payment_id=NEW.payment_id AND event_kind='CONFIRMED';
    IF report.id IS NULL OR NEW.direction<>'DEBIT' OR NEW.actor_party_id NOT IN (pay.payer_party_id,pay.payee_party_id) OR
       NEW.amount>(report.amount-COALESCE((SELECT sum(prior.amount) FROM payment_event prior WHERE prior.related_event_id=report.id AND prior.event_kind='REVERSAL'),0)) THEN
      RAISE EXCEPTION 'payment reversal must be a valid unreversed portion of a confirmed settlement' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT * INTO report FROM payment_event WHERE id=NEW.related_event_id AND payment_id=NEW.payment_id AND event_kind='REPORTED';
    IF report.id IS NULL OR NEW.amount<>report.amount THEN
      RAISE EXCEPTION 'payment resolution must reference its exact reported amount' USING ERRCODE='23514';
    END IF;
    IF NEW.event_kind='CONFIRMED' AND (NEW.actor_party_id<>pay.payee_party_id OR NEW.direction<>'CREDIT') THEN
      RAISE EXCEPTION 'payment confirmation must be recorded by the payee' USING ERRCODE='23514';
    ELSIF NEW.event_kind='DISPUTED' AND (NEW.actor_party_id NOT IN (pay.payer_party_id,pay.payee_party_id) OR NEW.direction<>'CREDIT') THEN
      RAISE EXCEPTION 'payment dispute must be recorded by a counterparty' USING ERRCODE='23514';
    ELSIF NEW.event_kind='FAILED' AND (NEW.actor_party_id<>pay.payee_party_id OR NEW.direction<>'DEBIT') THEN
      RAISE EXCEPTION 'payment failure must be recorded by the payee' USING ERRCODE='23514';
    ELSIF NEW.event_kind='CORRECTION' THEN
      RAISE EXCEPTION 'payment corrections must be represented by a new report or linked reversal' USING ERRCODE='23514';
    END IF;
  END IF;
  SELECT COALESCE(sum(line_amount-deduction_amount),0) INTO due FROM gold_trade_line l
    WHERE l.trade_id=trade.id AND l.is_accepted AND NOT EXISTS(SELECT 1 FROM gold_trade_line child WHERE child.supersedes_line_id=l.id);
  SELECT COALESCE(sum(CASE WHEN e.event_kind='CONFIRMED' THEN e.amount WHEN e.event_kind='REVERSAL' THEN -e.amount ELSE 0 END),0),
         COALESCE(sum(CASE WHEN e.event_kind='REPORTED' THEN e.amount WHEN e.event_kind='FAILED' THEN -e.amount WHEN e.event_kind='REVERSAL' THEN -e.amount ELSE 0 END),0)
    INTO settled,reported FROM payment_event e JOIN payment p ON p.id=e.payment_id WHERE p.gold_trade_id=trade.id;
  IF NEW.event_kind='REPORTED' AND reported+NEW.amount>due THEN
    RAISE EXCEPTION 'recorded settlement exceeds the outstanding gold trade obligation' USING ERRCODE='23514';
  END IF;
  IF NEW.event_kind='REVERSAL' AND settled<NEW.amount THEN
    RAISE EXCEPTION 'payment reversal exceeds confirmed settlement' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER gold_trade_payment_event_guard BEFORE INSERT ON payment_event
  FOR EACH ROW EXECUTE FUNCTION validate_gold_payment_event();

CREATE FUNCTION validate_gold_trade_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE trade gold_trade%ROWTYPE; actor_person UUID;
BEGIN
  SELECT * INTO trade FROM gold_trade WHERE id=NEW.gold_trade_id;
  SELECT person_party_id INTO actor_person FROM user_account WHERE id=NEW.actor_user_id;
  IF trade.id IS NULL OR NEW.actor_party_id NOT IN (trade.seller_party_id,trade.buyer_party_id) OR
    (actor_person<>NEW.actor_party_id AND NOT EXISTS(SELECT 1 FROM organisation_membership om
      WHERE om.person_party_id=actor_person AND om.organisation_party_id=NEW.actor_party_id AND om.status='ACTIVE'
        AND om.valid_from<=NEW.occurred_at AND (om.valid_to IS NULL OR om.valid_to>NEW.occurred_at))) THEN
    RAISE EXCEPTION 'trade evidence must be submitted by an authorized counterparty' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER gold_trade_evidence_guard BEFORE INSERT ON gold_trade_evidence
  FOR EACH ROW EXECUTE FUNCTION validate_gold_trade_evidence();

CREATE FUNCTION validate_gold_trade_line_eligibility_on_accept() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE seller UUID; available NUMERIC(20,6); committed NUMERIC(20,6);
BEGIN
  IF TG_TABLE_NAME='gold_trade_line' AND NEW.is_accepted THEN
    SELECT seller_party_id INTO seller FROM gold_trade WHERE id=NEW.trade_id;
    SELECT COALESCE(sum(balance.quantity_g),0) INTO available FROM inventory_balance balance
      JOIN inventory_location location ON location.id=balance.location_id
      LEFT JOIN merchant_inventory_location merchant ON merchant.inventory_location_id=location.id
      WHERE balance.batch_id=NEW.batch_id AND location.status='ACTIVE'
        AND (location.custodian_party_id=seller OR merchant.merchant_party_id=seller);
    SELECT COALESCE(sum(GREATEST(line.accepted_trade_quantity_g-COALESCE(moved.quantity_g,0),0)),0) INTO committed
      FROM gold_trade_line line JOIN gold_trade other_trade ON other_trade.id=line.trade_id
      LEFT JOIN LATERAL (
        SELECT COALESCE(sum(outgoing.posted_quantity_g-COALESCE(reversed.quantity_g,0)),0)::NUMERIC(20,6) AS quantity_g
        FROM inventory_movement_line outgoing JOIN inventory_movement movement ON movement.id=outgoing.inventory_movement_id AND movement.current_status='ACCEPTED'
        LEFT JOIN LATERAL (SELECT sum(reverse_line.posted_quantity_g) AS quantity_g FROM inventory_movement_line reverse_line
          JOIN inventory_movement reverse_movement ON reverse_movement.id=reverse_line.inventory_movement_id AND reverse_movement.current_status='ACCEPTED' AND reverse_movement.movement_kind='REVERSAL'
          WHERE reverse_line.reverses_line_id=outgoing.id) reversed ON true
        WHERE outgoing.gold_trade_line_id=line.id AND outgoing.direction='OUT'
      ) moved ON true
      WHERE line.batch_id=NEW.batch_id AND other_trade.seller_party_id=seller
        AND other_trade.id<>NEW.trade_id
        AND line.is_accepted AND NOT EXISTS(SELECT 1 FROM gold_trade_line child WHERE child.supersedes_line_id=line.id);
    IF available-committed<NEW.accepted_trade_quantity_g THEN
      RAISE EXCEPTION 'agreed gold quantity exceeds the seller inventory available at acceptance' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER gold_trade_line_available_on_accept BEFORE INSERT ON gold_trade_line
  FOR EACH ROW EXECUTE FUNCTION validate_gold_trade_line_eligibility_on_accept();
