DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM party_participation
    WHERE participant_kind IN ('SERVICE_PROVIDER', 'FAMILY_OR_AGREED_BENEFICIARY')
  ) THEN
    RAISE EXCEPTION 'convert or retain new participant kinds before rolling back migration 003';
  END IF;
END $$;

DROP TRIGGER IF EXISTS production_allocation_beneficiary_guard ON production_allocation_row;
DROP FUNCTION IF EXISTS validate_allocation_beneficiary_relationship();
DROP TRIGGER IF EXISTS material_measurement_phase_two_source_guard ON material_measurement;
DROP FUNCTION IF EXISTS validate_phase_two_measurement_source();

ALTER TABLE site_party_role DROP COLUMN IF EXISTS source_reference, DROP COLUMN IF EXISTS evidence_ref;
ALTER TABLE hole_party_role DROP COLUMN IF EXISTS source_reference, DROP COLUMN IF EXISTS evidence_ref;

ALTER TABLE party_participation DROP CONSTRAINT IF EXISTS party_participation_participant_kind_check;
ALTER TABLE party_participation
  ADD CONSTRAINT party_participation_participant_kind_check
  CHECK (participant_kind IN (
    'MINER', 'MINING_OPERATOR', 'LANDOWNER', 'PERMIT_HOLDER', 'DORA_OPERATOR',
    'RECOVERY_FACILITY', 'LOCAL_MERCHANT', 'LARGER_MERCHANT', 'CARRIER',
    'FIELD_OFFICER', 'AUDITOR', 'OTHER'
  ));
