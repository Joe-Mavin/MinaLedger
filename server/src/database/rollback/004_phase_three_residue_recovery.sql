DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM phase_three_migration_marker)
    AND (EXISTS (SELECT 1 FROM consignment_receipt)
      OR EXISTS (SELECT 1 FROM custody_transfer_decision)
      OR EXISTS (SELECT 1 FROM recovery_event_input)
      OR EXISTS (SELECT 1 FROM residue_sale_decision_event)
      OR EXISTS (SELECT 1 FROM inventory_movement_line WHERE source_material_event_output_id IS NOT NULL OR consignment_receipt_item_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'Phase 3 records exist; export and reconcile them before rollback';
  END IF;
END $$;

DROP TRIGGER IF EXISTS phase_three_inventory_header_guard ON inventory_movement;
DROP TRIGGER IF EXISTS phase_three_inventory_line_guard ON inventory_movement_line;
DROP TRIGGER IF EXISTS phase_three_movement_links_header_guard ON inventory_movement;
DROP TRIGGER IF EXISTS phase_three_movement_links_line_guard ON inventory_movement_line;
DROP TRIGGER IF EXISTS consignment_status_transition_guard ON consignment;
DROP TRIGGER IF EXISTS consignment_status_event_append_only ON consignment_status_event;
DROP TRIGGER IF EXISTS receipt_measurement_guard ON consignment_receipt_item;
DROP TRIGGER IF EXISTS consignment_item_source_guard ON consignment_item;
DROP TRIGGER IF EXISTS consignment_item_phase3_append_only ON consignment_item;
DROP TRIGGER IF EXISTS transport_record_phase3_append_only ON transport_record;
DROP TRIGGER IF EXISTS consignment_receipt_phase3_append_only ON consignment_receipt;
DROP TRIGGER IF EXISTS consignment_receipt_item_phase3_append_only ON consignment_receipt_item;
DROP TRIGGER IF EXISTS accepted_receipt_has_movement_guard ON consignment_receipt_item;
DROP TRIGGER IF EXISTS consignment_status_event_phase3_append_only ON consignment_status_event;
DROP TRIGGER IF EXISTS custody_transfer_item_phase3_append_only ON custody_transfer_item;
DROP TRIGGER IF EXISTS custody_transfer_decision_phase3_append_only ON custody_transfer_decision;
DROP TRIGGER IF EXISTS recovery_event_input_source_phase3_append_only ON recovery_event_input_source;
DROP TRIGGER IF EXISTS recovery_output_input_link_phase3_append_only ON recovery_output_input_link;
DROP TRIGGER IF EXISTS recovery_process_stage_phase3_append_only ON recovery_process_stage;
DROP TRIGGER IF EXISTS recovery_variance_phase3_append_only ON recovery_variance;
DROP TRIGGER IF EXISTS residue_sale_decision_event_phase3_append_only ON residue_sale_decision_event;
DROP TRIGGER IF EXISTS residue_sale_decision_party_guard ON residue_sale_decision_event;
DROP TRIGGER IF EXISTS accepted_residue_sale_requires_counterparties ON residue_sale_line;
DROP TRIGGER IF EXISTS residue_sale_shipment_mapping_guard ON residue_sale_shipment_item;
DROP TRIGGER IF EXISTS custody_decision_party_guard ON custody_transfer_decision;
DROP TRIGGER IF EXISTS custody_transfer_update_guard ON custody_transfer;
DROP TRIGGER IF EXISTS custody_offer_complete_guard ON custody_transfer;
DROP TRIGGER IF EXISTS custody_offer_item_guard ON custody_transfer_item;
DROP TRIGGER IF EXISTS recovery_source_quantity_guard ON recovery_event_input_source;
DROP TRIGGER IF EXISTS recovery_event_complete_guard ON recovery_event;
DROP TRIGGER IF EXISTS recovery_input_complete_guard ON recovery_event_input;
DROP TRIGGER IF EXISTS recovery_output_complete_guard ON recovery_event_output;
DROP TRIGGER IF EXISTS recovery_genealogy_complete_guard ON recovery_output_input_link;
DROP FUNCTION IF EXISTS validate_phase_three_inventory();
DROP FUNCTION IF EXISTS validate_phase_three_recorded_movement_links();
DROP FUNCTION IF EXISTS validate_consignment_status_transition();
DROP FUNCTION IF EXISTS validate_phase_three_receipt_measurement();
DROP FUNCTION IF EXISTS validate_residue_sale_decision();
DROP FUNCTION IF EXISTS validate_accepted_residue_sale_line();
DROP FUNCTION IF EXISTS validate_residue_sale_shipment_mapping();
DROP FUNCTION IF EXISTS validate_custody_decision_party();
DROP FUNCTION IF EXISTS validate_custody_transfer_update();
DROP FUNCTION IF EXISTS validate_custody_offer_items();
DROP FUNCTION IF EXISTS validate_phase_three_consignment_item();
DROP FUNCTION IF EXISTS validate_accepted_receipt_has_movement();
DROP FUNCTION IF EXISTS validate_recovery_source_quantity();
DROP FUNCTION IF EXISTS validate_recovery_source_record_owner();
DROP FUNCTION IF EXISTS validate_recovery_event_complete();
DROP FUNCTION IF EXISTS reject_phase_three_event_mutation();

ALTER TABLE inventory_movement_line DROP CONSTRAINT IF EXISTS inventory_line_source_output_batch_fk;
ALTER TABLE inventory_movement_line DROP CONSTRAINT IF EXISTS inventory_line_receipt_item_fk;
DROP INDEX IF EXISTS inventory_line_one_intake_per_output_idx;
ALTER TABLE inventory_movement_line DROP COLUMN IF EXISTS source_material_event_output_id, DROP COLUMN IF EXISTS consignment_receipt_item_id;
ALTER TABLE inventory_movement DROP CONSTRAINT IF EXISTS inventory_movement_movement_kind_check;
ALTER TABLE inventory_movement ADD CONSTRAINT inventory_movement_movement_kind_check
  CHECK (movement_kind IN ('TRANSFER','TRANSFORMATION','ADJUSTMENT','OPENING_BALANCE','REVERSAL'));

DROP INDEX IF EXISTS residue_sale_shipment_item_one_sale_per_consignment_item_idx;
DROP INDEX IF EXISTS residue_sale_shipment_item_line_idx;
DROP INDEX IF EXISTS consignment_item_batch_idx;
DROP INDEX IF EXISTS consignment_recipient_status_idx;
DROP TABLE IF EXISTS phase_three_migration_marker;
DROP TABLE IF EXISTS consignment_status_event;
DROP TABLE IF EXISTS recovery_variance;
DROP TABLE IF EXISTS recovery_process_stage;
DROP TABLE IF EXISTS recovery_output_input_link;
DROP TABLE IF EXISTS recovery_event_input_source;
DROP TABLE IF EXISTS recovery_event_output;
DROP TABLE IF EXISTS recovery_event_input;
DROP TABLE IF EXISTS custody_transfer_decision;
DROP TABLE IF EXISTS custody_transfer_item;
DROP TABLE IF EXISTS consignment_receipt_item;
DROP TABLE IF EXISTS consignment_receipt;
DROP TABLE IF EXISTS residue_sale_decision_event;

ALTER TABLE consignment_item DROP COLUMN IF EXISTS source_location_id;
ALTER TABLE consignment DROP COLUMN IF EXISTS destination_recovery_facility_id,
  DROP COLUMN IF EXISTS dispatched_by_user_id,
  DROP COLUMN IF EXISTS dispatch_evidence_ref,
  DROP COLUMN IF EXISTS transporter_party_id,
  DROP COLUMN IF EXISTS recorded_at;
ALTER TABLE custody_transfer DROP COLUMN IF EXISTS source_location_id,
  DROP COLUMN IF EXISTS destination_location_id,
  DROP COLUMN IF EXISTS evidence_ref,
  DROP COLUMN IF EXISTS recorded_at;
CREATE UNIQUE INDEX measurement_set_unique_consignment_stage ON material_measurement_set(consignment_item_id,consignment_stage) WHERE consignment_item_id IS NOT NULL;
