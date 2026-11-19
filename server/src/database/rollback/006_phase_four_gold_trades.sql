DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM gold_trade_status_event)
    OR EXISTS (SELECT 1 FROM gold_trade_evidence)
    OR EXISTS (SELECT 1 FROM gold_trade WHERE created_by_user_id IS NOT NULL OR status<>'AGREED')
    OR EXISTS (SELECT 1 FROM assay_record WHERE recorded_by_user_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM custody_transfer WHERE gold_trade_line_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM payment_event WHERE actor_party_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Phase 4 trade records exist; export and reconcile them before rollback';
  END IF;
END $$;

DROP TRIGGER IF EXISTS gold_trade_payment_event_guard ON payment_event;
DROP TRIGGER IF EXISTS gold_trade_evidence_guard ON gold_trade_evidence;
DROP TRIGGER IF EXISTS gold_trade_line_available_on_accept ON gold_trade_line;
DROP TRIGGER IF EXISTS gold_custody_update_guard ON custody_transfer;
DROP TRIGGER IF EXISTS gold_custody_offer_guard ON custody_transfer;
DROP TRIGGER IF EXISTS assay_correction_guard ON assay_record;
DROP TRIGGER IF EXISTS gold_line_acceptance_requires_bilateral_terms ON gold_trade_line;
DROP TRIGGER IF EXISTS phase_four_gold_decision_guard ON commercial_line_decision_event;
DROP TRIGGER IF EXISTS gold_trade_line_immutable ON gold_trade_line;
DROP TRIGGER IF EXISTS phase_four_gold_line_guard ON gold_trade_line;
DROP TRIGGER IF EXISTS phase_four_trade_complete_guard ON gold_trade;
DROP TRIGGER IF EXISTS gold_trade_identity_immutable ON gold_trade;
DROP TRIGGER IF EXISTS gold_trade_status_event_guard ON gold_trade_status_event;
DROP TRIGGER IF EXISTS gold_trade_status_guard ON gold_trade;
DROP TRIGGER IF EXISTS gold_trade_status_event_immutable ON gold_trade_status_event;
DROP TRIGGER IF EXISTS gold_trade_evidence_immutable ON gold_trade_evidence;
DROP TRIGGER IF EXISTS gold_trade_payment_marker_immutable ON gold_trade_payment_marker;
DROP TRIGGER IF EXISTS assay_record_phase_four_immutable ON assay_record;
DROP TRIGGER IF EXISTS payment_phase_four_immutable ON payment;

DROP FUNCTION IF EXISTS validate_gold_payment_event();
DROP FUNCTION IF EXISTS validate_gold_trade_evidence();
DROP FUNCTION IF EXISTS validate_gold_trade_line_eligibility_on_accept();
DROP FUNCTION IF EXISTS validate_gold_custody_update();
DROP FUNCTION IF EXISTS validate_gold_custody_offer();
DROP FUNCTION IF EXISTS validate_assay_correction();
DROP FUNCTION IF EXISTS validate_gold_line_acceptance_successor();
DROP FUNCTION IF EXISTS validate_gold_trade_decision();
DROP FUNCTION IF EXISTS validate_phase_four_gold_line();
DROP FUNCTION IF EXISTS validate_gold_trade_status_event();
DROP FUNCTION IF EXISTS validate_gold_trade_status();
DROP FUNCTION IF EXISTS validate_gold_trade_identity_immutable();
DROP FUNCTION IF EXISTS validate_phase_four_trade_complete();
DROP FUNCTION IF EXISTS reject_gold_trade_history_mutation();

-- Restore the Phase 1 commercial-line immutability function.
CREATE OR REPLACE FUNCTION validate_commercial_line_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'commercial line revisions are append-only' USING ERRCODE = '55000'; END IF;
  IF TG_TABLE_NAME = 'gold_trade_line' THEN
    IF ROW(NEW.trade_id,NEW.batch_id,NEW.revision_no,NEW.revision_kind,NEW.transaction_quantity_g,NEW.accepted_trade_quantity_g,NEW.unit_price,NEW.line_amount,NEW.assay_record_id,NEW.supersedes_line_id,NEW.correction_reason)
       IS DISTINCT FROM ROW(OLD.trade_id,OLD.batch_id,OLD.revision_no,OLD.revision_kind,OLD.transaction_quantity_g,OLD.accepted_trade_quantity_g,OLD.unit_price,OLD.line_amount,OLD.assay_record_id,OLD.supersedes_line_id,OLD.correction_reason) THEN
      RAISE EXCEPTION 'commercial line terms are immutable; create a linked revision' USING ERRCODE = '55000';
    END IF;
  ELSE
    IF ROW(NEW.residue_sale_id,NEW.batch_id,NEW.revision_no,NEW.revision_kind,NEW.transaction_quantity_g,NEW.accepted_trade_quantity_g,NEW.unit_price,NEW.line_amount,NEW.supersedes_line_id,NEW.correction_reason)
       IS DISTINCT FROM ROW(OLD.residue_sale_id,OLD.batch_id,OLD.revision_no,OLD.revision_kind,OLD.transaction_quantity_g,OLD.accepted_trade_quantity_g,OLD.unit_price,OLD.line_amount,OLD.supersedes_line_id,OLD.correction_reason) THEN
      RAISE EXCEPTION 'commercial line terms are immutable; create a linked revision' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS gold_trade_line_immutable ON gold_trade_line;
CREATE TRIGGER gold_trade_line_immutable BEFORE UPDATE OR DELETE ON gold_trade_line FOR EACH ROW EXECUTE FUNCTION validate_commercial_line_immutable();

ALTER TABLE custody_transfer DROP CONSTRAINT IF EXISTS custody_gold_movement_fk,
  DROP CONSTRAINT IF EXISTS custody_gold_measurement_fk,
  DROP CONSTRAINT IF EXISTS custody_gold_measurement_shape_check,
  DROP CONSTRAINT IF EXISTS custody_gold_transfer_shape_check,
  DROP COLUMN IF EXISTS gold_trade_line_id,
  DROP COLUMN IF EXISTS quantity_g,
  DROP COLUMN IF EXISTS measurement_set_id,
  DROP COLUMN IF EXISTS measurement_id;
ALTER TABLE custody_transfer DROP CONSTRAINT IF EXISTS custody_transfer_linked_inventory_movement_id_fkey;

DROP INDEX IF EXISTS assay_record_single_successor_idx;
ALTER TABLE assay_record DROP CONSTRAINT IF EXISTS assay_record_correction_shape_check,
  DROP COLUMN IF EXISTS recorded_by_user_id,
  DROP COLUMN IF EXISTS correction_reason;

DROP INDEX IF EXISTS payment_event_one_dispute_per_report_idx;
DROP INDEX IF EXISTS payment_event_one_resolution_per_report_idx;
DROP INDEX IF EXISTS payment_event_one_report_per_payment_idx;
ALTER TABLE payment_event DROP CONSTRAINT IF EXISTS payment_event_event_kind_check,
  DROP COLUMN IF EXISTS actor_party_id;
ALTER TABLE payment_event ADD CONSTRAINT payment_event_event_kind_check
  CHECK (event_kind IN ('REPORTED','CONFIRMED','FAILED','REVERSAL','CORRECTION'));

DROP INDEX IF EXISTS commercial_gold_line_one_party_decision_idx;
ALTER TABLE commercial_line_decision_event DROP COLUMN IF EXISTS accepted_quantity_g,
  DROP COLUMN IF EXISTS accepted_unit_price,
  DROP COLUMN IF EXISTS accepted_line_amount,
  DROP COLUMN IF EXISTS accepted_deduction_amount;

DROP INDEX IF EXISTS gold_trade_status_history_idx;
DROP INDEX IF EXISTS gold_trade_evidence_history_idx;
DROP TABLE IF EXISTS gold_trade_status_event;
DROP TABLE IF EXISTS gold_trade_evidence;
DROP TRIGGER IF EXISTS gold_trade_payment_marker_immutable ON gold_trade_payment_marker;
DROP TABLE IF EXISTS gold_trade_payment_marker;

ALTER TABLE gold_trade_line DROP CONSTRAINT IF EXISTS gold_trade_line_deduction_shape_check,
  DROP COLUMN IF EXISTS deduction_amount,
  DROP COLUMN IF EXISTS deduction_reason;
ALTER TABLE gold_trade ALTER COLUMN agreed_at SET NOT NULL,
  DROP COLUMN IF EXISTS trade_date,
  DROP COLUMN IF EXISTS created_by_user_id,
  DROP COLUMN IF EXISTS status;
