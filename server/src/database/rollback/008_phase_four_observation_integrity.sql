DROP TRIGGER IF EXISTS phase_four_observation_state_guard ON material_measurement;
DROP TRIGGER IF EXISTS phase_four_observation_state_guard ON assay_record;
DROP FUNCTION IF EXISTS validate_phase_four_observation_state();
