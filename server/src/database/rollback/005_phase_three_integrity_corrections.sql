DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM phase_three_integrity_correction_marker)
    AND (EXISTS (SELECT 1 FROM consignment_receipt_item WHERE supersedes_receipt_item_id IS NOT NULL)
      OR EXISTS (SELECT 1 FROM residue_sale_line WHERE resolves_decision_mismatch)) THEN
    RAISE EXCEPTION 'Phase 3 correction records exist; export and reconcile them before rollback';
  END IF;
END $$;

DROP TRIGGER IF EXISTS consignment_receipt_quantity_guard ON consignment_receipt_item;
DROP TRIGGER IF EXISTS receipt_correction_reversal_guard ON consignment_receipt_item;
DROP TRIGGER IF EXISTS phase_three_intake_measurement_header_guard ON inventory_movement;
DROP TRIGGER IF EXISTS phase_three_intake_measurement_line_guard ON inventory_movement_line;
DROP TRIGGER IF EXISTS dispatch_receipt_reversal_item_lock ON inventory_movement_line;
DROP TRIGGER IF EXISTS residue_sale_decision_revision_guard ON residue_sale_line;
DROP TRIGGER IF EXISTS residue_sale_eligible_inventory_guard ON residue_sale_line;
DROP TRIGGER IF EXISTS residue_sale_mismatch_marker_immutable ON residue_sale_line;
DROP TRIGGER IF EXISTS recovery_source_current_receipt_guard ON recovery_event_input_source;

DROP FUNCTION IF EXISTS validate_phase_three_receipt_quantity();
DROP FUNCTION IF EXISTS validate_phase_three_receipt_correction_reversal();
DROP FUNCTION IF EXISTS validate_phase_three_intake_measurement_authority();
DROP FUNCTION IF EXISTS lock_phase_three_dispatch_item_for_reversal();
DROP FUNCTION IF EXISTS validate_residue_sale_decision_revision();
DROP FUNCTION IF EXISTS validate_eligible_residue_sale_quantity();
DROP FUNCTION IF EXISTS validate_current_recovery_receipt_source();

CREATE OR REPLACE FUNCTION validate_consignment_status_transition() RETURNS trigger LANGUAGE plpgsql AS $$
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

DROP INDEX IF EXISTS consignment_receipt_item_single_successor_idx;
DROP INDEX IF EXISTS consignment_receipt_item_current_position_idx;
ALTER TABLE consignment_receipt_item DROP CONSTRAINT IF EXISTS consignment_receipt_item_successor_fk,
  DROP CONSTRAINT IF EXISTS consignment_receipt_item_correction_shape_check,
  DROP COLUMN IF EXISTS supersedes_receipt_item_id,
  DROP COLUMN IF EXISTS correction_reason;
ALTER TABLE residue_sale_line DROP CONSTRAINT IF EXISTS residue_sale_line_mismatch_revision_check,
  DROP COLUMN IF EXISTS resolves_decision_mismatch;
DROP INDEX IF EXISTS material_measurement_single_successor_idx;
DROP TABLE IF EXISTS phase_three_integrity_correction_marker;
