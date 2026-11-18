-- Additive integrity corrections. A checked rollback script is kept under
-- server/src/database/rollback/ so the forward-only migrator does not apply it.
ALTER TABLE party_participation
  DROP CONSTRAINT party_participation_participant_kind_check;
ALTER TABLE party_participation
  ADD CONSTRAINT party_participation_participant_kind_check
  CHECK (participant_kind IN (
    'MINER', 'MINING_OPERATOR', 'LANDOWNER', 'PERMIT_HOLDER', 'DORA_OPERATOR',
    'RECOVERY_FACILITY', 'LOCAL_MERCHANT', 'LARGER_MERCHANT', 'CARRIER',
    'FIELD_OFFICER', 'AUDITOR', 'SERVICE_PROVIDER', 'FAMILY_OR_AGREED_BENEFICIARY', 'OTHER'
  ));

ALTER TABLE site_party_role
  ADD COLUMN source_reference TEXT,
  ADD COLUMN evidence_ref TEXT;
ALTER TABLE hole_party_role
  ADD COLUMN source_reference TEXT,
  ADD COLUMN evidence_ref TEXT;

CREATE FUNCTION validate_phase_two_measurement_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  context_production_event_id UUID;
  process_id UUID;
  facility_id UUID;
  source_event_id UUID;
  actor_party_id UUID;
  has_context BOOLEAN := false;
  source_valid BOOLEAN := false;
BEGIN
  SELECT u.person_party_id INTO actor_party_id
  FROM user_account u WHERE u.id=NEW.entered_by_user_id;

  SELECT peo.production_event_id INTO context_production_event_id
  FROM material_measurement_set ms
  JOIN production_event_output peo ON peo.material_event_output_id=ms.material_event_output_id
  WHERE ms.id=NEW.measurement_set_id;
  IF FOUND THEN
    has_context := true;
  ELSE
    SELECT pe.processing_facility_id, pe.event_id, source_peo.production_event_id
      INTO facility_id, process_id, source_event_id
    FROM material_measurement_set ms
    JOIN material_event_input mei ON mei.id=ms.material_event_input_id
    JOIN processing_event_input pei ON pei.material_event_input_id=mei.id
    JOIN processing_event pe ON pe.event_id=pei.processing_event_id
    JOIN production_event_output source_peo ON source_peo.material_event_output_id=pei.source_production_output_id
    WHERE ms.id=NEW.measurement_set_id;
    IF FOUND THEN
      has_context := true;
    ELSE
      SELECT pe.processing_facility_id, pe.event_id
        INTO facility_id, process_id
      FROM material_measurement_set ms
      JOIN material_event_output eo ON eo.id=ms.material_event_output_id
      JOIN processing_event_output peo ON peo.material_event_output_id=eo.id
      JOIN processing_event pe ON pe.event_id=peo.processing_event_id
      WHERE ms.id=NEW.measurement_set_id;
      IF FOUND THEN has_context := true; END IF;
    END IF;
  END IF;

  IF NOT has_context THEN RETURN NEW; END IF;
  IF NEW.source_party_id IS NULL THEN
    RAISE EXCEPTION 'phase two measurement source party is required' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM party WHERE id=NEW.source_party_id AND status='ACTIVE') THEN
    RAISE EXCEPTION 'phase two measurement source party is unavailable' USING ERRCODE = '23514';
  END IF;
  IF NEW.source_role='RECORDER' AND NEW.source_party_id=actor_party_id THEN RETURN NEW; END IF;

  IF context_production_event_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM production_event_participant pep
      JOIN production_event pe ON pe.event_id=pep.production_event_id
      JOIN mining_hole h ON h.id=pe.hole_id
      LEFT JOIN site_party_role sr ON sr.id=pep.site_party_role_id
      LEFT JOIN hole_party_role hr ON hr.id=pep.hole_party_role_id
      WHERE pep.production_event_id=context_production_event_id AND pep.party_id=NEW.source_party_id
        AND (
          (sr.id IS NOT NULL AND sr.site_id=h.site_id AND sr.status='ACTIVE'
            AND sr.valid_from<=NEW.occurred_at_claimed AND (sr.valid_to IS NULL OR sr.valid_to>NEW.occurred_at_claimed))
          OR
          (hr.id IS NOT NULL AND hr.hole_id=h.id AND hr.status='ACTIVE'
            AND hr.valid_from<=NEW.occurred_at_claimed AND (hr.valid_to IS NULL OR hr.valid_to>NEW.occurred_at_claimed))
        )
    ) INTO source_valid;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM facility_party_role fpr
      WHERE fpr.processing_facility_id=facility_id AND fpr.party_id=NEW.source_party_id
        AND fpr.status='ACTIVE' AND fpr.valid_from<=NEW.occurred_at_claimed
        AND (fpr.valid_to IS NULL OR fpr.valid_to>NEW.occurred_at_claimed)
    ) OR EXISTS (
      SELECT 1
      FROM production_event_participant pep
      JOIN production_event pe ON pe.event_id=pep.production_event_id
      JOIN mining_hole h ON h.id=pe.hole_id
      LEFT JOIN site_party_role sr ON sr.id=pep.site_party_role_id
      LEFT JOIN hole_party_role hr ON hr.id=pep.hole_party_role_id
      WHERE pep.party_id=NEW.source_party_id
        AND (
          (source_event_id IS NOT NULL AND pep.production_event_id=source_event_id)
          OR
          (source_event_id IS NULL AND pep.production_event_id IN (
            SELECT source_peo.production_event_id
            FROM processing_event_input pei
            JOIN production_event_output source_peo
              ON source_peo.material_event_output_id=pei.source_production_output_id
            WHERE pei.processing_event_id=process_id
          ))
        )
        AND (
          (sr.id IS NOT NULL AND sr.site_id=h.site_id AND sr.status='ACTIVE'
            AND sr.valid_from<=NEW.occurred_at_claimed AND (sr.valid_to IS NULL OR sr.valid_to>NEW.occurred_at_claimed))
          OR
          (hr.id IS NOT NULL AND hr.hole_id=h.id AND hr.status='ACTIVE'
            AND hr.valid_from<=NEW.occurred_at_claimed AND (hr.valid_to IS NULL OR hr.valid_to>NEW.occurred_at_claimed))
        )
    ) INTO source_valid;
  END IF;

  IF NOT source_valid THEN
    RAISE EXCEPTION 'phase two measurement source has no effective context relationship' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER material_measurement_phase_two_source_guard
  BEFORE INSERT ON material_measurement
  FOR EACH ROW EXECUTE FUNCTION validate_phase_two_measurement_source();

CREATE FUNCTION validate_allocation_beneficiary_relationship() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  context_site_id UUID;
  context_hole_id UUID;
  context_event_time TIMESTAMPTZ;
BEGIN
  SELECT h.site_id, h.id, me.occurred_at_claimed
    INTO context_site_id, context_hole_id, context_event_time
  FROM production_allocation_set s
  JOIN production_allocation_chain c ON c.id=s.allocation_chain_id
  JOIN production_event_output peo ON peo.material_event_output_id=c.production_event_output_id
  JOIN production_event pe ON pe.event_id=peo.production_event_id
  JOIN material_event me ON me.id=pe.event_id
  JOIN mining_hole h ON h.id=pe.hole_id
  WHERE s.id=NEW.allocation_set_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'allocation beneficiary has no production context' USING ERRCODE = '23503';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM party WHERE id=NEW.beneficiary_party_id AND status='ACTIVE') THEN
    RAISE EXCEPTION 'allocation beneficiary is unavailable' USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM site_party_role r
    WHERE r.site_id=context_site_id AND r.party_id=NEW.beneficiary_party_id AND r.role_code='BENEFICIARY'
      AND r.status='ACTIVE' AND r.valid_from<=context_event_time AND (r.valid_to IS NULL OR r.valid_to>context_event_time)
    UNION ALL
    SELECT 1 FROM hole_party_role r
    WHERE r.hole_id=context_hole_id AND r.party_id=NEW.beneficiary_party_id AND r.role_code='BENEFICIARY'
      AND r.status='ACTIVE' AND r.valid_from<=context_event_time AND (r.valid_to IS NULL OR r.valid_to>context_event_time)
  ) THEN
    RAISE EXCEPTION 'allocation beneficiary has no effective beneficiary relationship' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER production_allocation_beneficiary_guard
  BEFORE INSERT ON production_allocation_row
  FOR EACH ROW EXECUTE FUNCTION validate_allocation_beneficiary_relationship();
