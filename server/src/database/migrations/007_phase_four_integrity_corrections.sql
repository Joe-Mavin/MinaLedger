-- Phase 4 corrections: enforce current proposal leaves, assay lineage and
-- measurement/assay attribution without rewriting historical migrations.

ALTER TABLE gold_trade_line
  ADD COLUMN is_current BOOLEAN NOT NULL DEFAULT TRUE;

UPDATE gold_trade_line line SET is_current=FALSE
WHERE EXISTS (SELECT 1 FROM gold_trade_line successor WHERE successor.supersedes_line_id=line.id);

CREATE UNIQUE INDEX gold_trade_line_one_current_batch_idx
  ON gold_trade_line(trade_id,batch_id) WHERE is_current;

ALTER TABLE assay_record
  ADD COLUMN gold_trade_line_id UUID,
  ADD CONSTRAINT assay_record_id_batch_unique UNIQUE(id,batch_id),
  ADD CONSTRAINT assay_record_trade_line_batch_fk
    FOREIGN KEY (gold_trade_line_id,batch_id) REFERENCES gold_trade_line(id,batch_id) ON DELETE RESTRICT;

ALTER TABLE gold_trade_line
  DROP CONSTRAINT gold_trade_line_assay_record_id_fkey,
  ADD CONSTRAINT gold_trade_line_assay_batch_fk
    FOREIGN KEY (assay_record_id,batch_id) REFERENCES assay_record(id,batch_id) ON DELETE RESTRICT;

CREATE FUNCTION phase_four_user_represents_party_at(actor_user UUID, represented_party UUID, event_time TIMESTAMPTZ)
RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_account ua JOIN party person ON person.id=ua.person_party_id
    JOIN party represented ON represented.id=represented_party
    WHERE ua.id=actor_user AND ua.status='ACTIVE' AND person.status='ACTIVE' AND represented.status='ACTIVE'
      AND (ua.person_party_id=represented_party OR EXISTS (
        SELECT 1 FROM organisation_membership om JOIN role_assignment ra ON ra.user_id=ua.id
        WHERE om.person_party_id=ua.person_party_id AND om.organisation_party_id=represented_party
          AND om.status='ACTIVE' AND om.valid_from<=event_time AND (om.valid_to IS NULL OR om.valid_to>event_time)
          AND ra.role_code IN ('LOCAL_MERCHANT','LARGER_MERCHANT','MINING_OPERATOR','DORA_OPERATOR',
            'RECOVERY_FACILITY_OPERATOR','FIELD_OFFICER','MINER')
          AND ra.scope_kind='ORGANISATION' AND ra.scope_id=represented_party::TEXT
          AND ra.status='ACTIVE' AND ra.valid_from<=event_time AND (ra.valid_to IS NULL OR ra.valid_to>event_time)
      ))
  )
$$;

CREATE FUNCTION validate_phase_four_assay_attribution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.recorded_by_user_id IS NULL OR NEW.assayer_party_id IS NULL OR NEW.gold_trade_line_id IS NULL OR
     NOT phase_four_user_represents_party_at(NEW.recorded_by_user_id,NEW.assayer_party_id,NEW.observed_at) THEN
    RAISE EXCEPTION 'assay needs a trade-line context and a recorder authorized for the active assayer party at observation time' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER phase_four_assay_attribution_guard BEFORE INSERT ON assay_record
  FOR EACH ROW EXECUTE FUNCTION validate_phase_four_assay_attribution();

CREATE FUNCTION validate_phase_four_measurement_attribution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line gold_trade_line%ROWTYPE; trade gold_trade%ROWTYPE; recorder_person UUID;
BEGIN
  SELECT * INTO line FROM gold_trade_line WHERE id=(SELECT gold_trade_line_id FROM material_measurement_set WHERE id=NEW.measurement_set_id);
  IF line.id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO trade FROM gold_trade WHERE id=line.trade_id;
  SELECT person_party_id INTO recorder_person FROM user_account WHERE id=NEW.entered_by_user_id AND status='ACTIVE';
  IF NEW.entered_by_user_id IS NULL OR NEW.source_party_id IS NULL OR recorder_person IS NULL OR
     NOT phase_four_user_represents_party_at(NEW.entered_by_user_id,NEW.source_party_id,NEW.occurred_at_claimed) THEN
    RAISE EXCEPTION 'gold measurement source must be an active party represented by its recorder at observation time' USING ERRCODE='23514';
  END IF;
  IF (NEW.source_role='SELLER' AND NEW.source_party_id<>trade.seller_party_id) OR
     (NEW.source_role='BUYER' AND NEW.source_party_id<>trade.buyer_party_id) OR
     (NEW.source_role='RECORDER' AND NEW.source_party_id<>recorder_person) THEN
    RAISE EXCEPTION 'gold measurement source party does not match its declared source role' USING ERRCODE='23514';
  END IF;
  IF NEW.source_role IN ('SELLER','BUYER') AND
     NOT phase_four_user_represents_party_at(NEW.entered_by_user_id,NEW.source_party_id,NEW.occurred_at_claimed) THEN
    RAISE EXCEPTION 'gold measurement recorder must represent the declared trade side' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER phase_four_measurement_attribution_guard BEFORE INSERT ON material_measurement
  FOR EACH ROW EXECUTE FUNCTION validate_phase_four_measurement_attribution();

CREATE FUNCTION validate_gold_trade_line_current_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE predecessor gold_trade_line%ROWTYPE;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.supersedes_line_id IS NULL THEN
      IF NOT NEW.is_current OR EXISTS(SELECT 1 FROM gold_trade_line l
        WHERE l.trade_id=NEW.trade_id AND l.batch_id=NEW.batch_id AND l.is_current) THEN
        RAISE EXCEPTION 'a trade may have only one current line for a batch' USING ERRCODE='23505';
      END IF;
    ELSE
      SELECT * INTO predecessor FROM gold_trade_line WHERE id=NEW.supersedes_line_id FOR UPDATE;
      IF predecessor.id IS NULL OR NOT predecessor.is_current OR predecessor.trade_id<>NEW.trade_id OR
         predecessor.batch_id<>NEW.batch_id OR NEW.revision_no<>predecessor.revision_no+1 OR NEW.is_current THEN
        RAISE EXCEPTION 'a line successor must append to the current line for the same trade and batch' USING ERRCODE='23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.is_current IS DISTINCT FROM OLD.is_current THEN
    IF OLD.is_current AND NOT NEW.is_current THEN
      IF NOT EXISTS(SELECT 1 FROM gold_trade_line child WHERE child.supersedes_line_id=OLD.id) THEN
        RAISE EXCEPTION 'a current trade line can be superseded only by its linked successor' USING ERRCODE='23514';
      END IF;
    ELSIF NOT OLD.is_current AND NEW.is_current THEN
      IF EXISTS(SELECT 1 FROM gold_trade_line child WHERE child.supersedes_line_id=OLD.id) OR
         EXISTS(SELECT 1 FROM gold_trade_line other WHERE other.trade_id=NEW.trade_id AND other.batch_id=NEW.batch_id AND other.is_current AND other.id<>NEW.id) THEN
        RAISE EXCEPTION 'only the unsuperseded line may be current for a trade batch' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER gold_trade_line_current_state_guard BEFORE INSERT OR UPDATE OF is_current ON gold_trade_line
  FOR EACH ROW EXECUTE FUNCTION validate_gold_trade_line_current_state();

CREATE FUNCTION validate_gold_trade_line_current_projection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM gold_trade_line line WHERE line.trade_id=NEW.trade_id AND line.batch_id=NEW.batch_id
      AND line.is_current IS DISTINCT FROM (NOT EXISTS(
        SELECT 1 FROM gold_trade_line child WHERE child.supersedes_line_id=line.id
      ))
  ) THEN
    RAISE EXCEPTION 'each trade batch must have exactly its unsuperseded proposal line marked current' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER gold_trade_line_current_projection_guard
  AFTER INSERT OR UPDATE ON gold_trade_line DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_gold_trade_line_current_projection();
