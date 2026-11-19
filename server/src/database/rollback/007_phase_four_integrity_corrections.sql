DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM assay_record WHERE gold_trade_line_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Phase 4 assays reference trade lines; export and reconcile them before rollback';
  END IF;
END $$;

DROP TRIGGER IF EXISTS gold_trade_line_current_projection_guard ON gold_trade_line;
DROP TRIGGER IF EXISTS gold_trade_line_current_state_guard ON gold_trade_line;
DROP TRIGGER IF EXISTS phase_four_measurement_attribution_guard ON material_measurement;
DROP TRIGGER IF EXISTS phase_four_assay_attribution_guard ON assay_record;

DROP FUNCTION IF EXISTS validate_gold_trade_line_current_projection();
DROP FUNCTION IF EXISTS validate_gold_trade_line_current_state();
DROP FUNCTION IF EXISTS validate_phase_four_measurement_attribution();
DROP FUNCTION IF EXISTS validate_phase_four_assay_attribution();
DROP FUNCTION IF EXISTS phase_four_user_represents_party_at(UUID,UUID,TIMESTAMPTZ);

DROP INDEX IF EXISTS gold_trade_line_one_current_batch_idx;
ALTER TABLE gold_trade_line
  DROP CONSTRAINT IF EXISTS gold_trade_line_assay_batch_fk,
  ADD CONSTRAINT gold_trade_line_assay_record_id_fkey
    FOREIGN KEY (assay_record_id) REFERENCES assay_record(id) ON DELETE RESTRICT,
  DROP COLUMN IF EXISTS is_current;
ALTER TABLE assay_record
  DROP CONSTRAINT IF EXISTS assay_record_trade_line_batch_fk,
  DROP CONSTRAINT IF EXISTS assay_record_id_batch_unique,
  DROP COLUMN IF EXISTS gold_trade_line_id;
