-- Phase 2: participant capture, site-linked Dora facilities, allocation proposals,
-- processing lineage, and QR-backed authorized lookup.

ALTER TABLE site_party_role ADD CONSTRAINT site_party_role_id_party_uk UNIQUE (id, party_id);
ALTER TABLE hole_party_role ADD CONSTRAINT hole_party_role_id_party_uk UNIQUE (id, party_id);
ALTER TABLE material_event_input ADD CONSTRAINT material_event_input_id_event_uk UNIQUE (id, event_id);

CREATE TABLE production_event_participant (
  id UUID PRIMARY KEY,
  production_event_id UUID NOT NULL REFERENCES production_event(event_id) ON DELETE RESTRICT,
  party_id UUID NOT NULL REFERENCES party(id) ON DELETE RESTRICT,
  site_party_role_id UUID,
  hole_party_role_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(site_party_role_id, hole_party_role_id) = 1),
  FOREIGN KEY (site_party_role_id, party_id) REFERENCES site_party_role(id, party_id) ON DELETE RESTRICT,
  FOREIGN KEY (hole_party_role_id, party_id) REFERENCES hole_party_role(id, party_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX production_participant_site_relationship_uk
  ON production_event_participant(production_event_id, site_party_role_id) WHERE site_party_role_id IS NOT NULL;
CREATE UNIQUE INDEX production_participant_hole_relationship_uk
  ON production_event_participant(production_event_id, hole_party_role_id) WHERE hole_party_role_id IS NOT NULL;

CREATE FUNCTION validate_production_event_participant() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_time TIMESTAMPTZ; event_hole UUID; event_site UUID;
BEGIN
  SELECT me.occurred_at_claimed, pe.hole_id, h.site_id INTO event_time, event_hole, event_site
  FROM production_event pe
  JOIN material_event me ON me.id = pe.event_id
  JOIN mining_hole h ON h.id = pe.hole_id
  WHERE pe.event_id = NEW.production_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'production event participant has no production event' USING ERRCODE = '23503'; END IF;
  IF NEW.hole_party_role_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM hole_party_role r WHERE r.id = NEW.hole_party_role_id AND r.party_id = NEW.party_id
      AND r.hole_id = event_hole AND r.valid_from <= event_time AND (r.valid_to IS NULL OR r.valid_to > event_time)
  ) THEN
    RAISE EXCEPTION 'hole participant relationship was not effective for this event' USING ERRCODE = '23514';
  END IF;
  IF NEW.site_party_role_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM site_party_role r WHERE r.id = NEW.site_party_role_id AND r.party_id = NEW.party_id
      AND r.site_id = event_site AND r.valid_from <= event_time AND (r.valid_to IS NULL OR r.valid_to > event_time)
  ) THEN
    RAISE EXCEPTION 'site participant relationship was not effective for this event' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER production_event_participant_guard BEFORE INSERT ON production_event_participant
  FOR EACH ROW EXECUTE FUNCTION validate_production_event_participant();

CREATE TABLE production_event_capture (
  production_event_id UUID PRIMARY KEY REFERENCES production_event(event_id) ON DELETE RESTRICT,
  capture_provenance_id UUID NOT NULL UNIQUE REFERENCES capture_provenance(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE FUNCTION validate_production_event_capture() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual_party UUID; identity_state TEXT; provenance_event UUID;
BEGIN
  SELECT material_event_id, actual_participant_party_id, participant_identity_state
    INTO provenance_event, actual_party, identity_state
  FROM capture_provenance WHERE id = NEW.capture_provenance_id;
  IF provenance_event IS DISTINCT FROM NEW.production_event_id THEN
    RAISE EXCEPTION 'capture provenance must belong to the selected production event' USING ERRCODE = '23514';
  END IF;
  IF identity_state = 'IDENTIFIED' AND NOT EXISTS (
    SELECT 1 FROM production_event_participant p
    WHERE p.production_event_id = NEW.production_event_id AND p.party_id = actual_party
  ) THEN
    RAISE EXCEPTION 'identified capture participant must be linked to the production event' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER production_event_capture_guard BEFORE INSERT ON production_event_capture
  FOR EACH ROW EXECUTE FUNCTION validate_production_event_capture();

CREATE TABLE processing_facility_site (
  processing_facility_id UUID NOT NULL REFERENCES processing_facility(id) ON DELETE RESTRICT,
  mining_site_id UUID NOT NULL REFERENCES mining_site(id) ON DELETE RESTRICT,
  associated_by_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (processing_facility_id, mining_site_id)
);

ALTER TABLE processing_event ADD COLUMN compensation_arrangement_code TEXT;
ALTER TABLE processing_event ADD CONSTRAINT processing_compensation_source_pair_ck
  CHECK ((compensation_arrangement_code IS NULL) = (service_terms_ref IS NULL));
ALTER TABLE processing_event ADD CONSTRAINT processing_compensation_code_ck
  CHECK (compensation_arrangement_code IS NULL OR length(trim(compensation_arrangement_code)) BETWEEN 1 AND 40);

CREATE TABLE processing_event_input (
  material_event_input_id UUID PRIMARY KEY,
  processing_event_id UUID NOT NULL REFERENCES processing_event(event_id) ON DELETE RESTRICT,
  source_production_output_id UUID NOT NULL REFERENCES production_event_output(material_event_output_id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (processing_event_id, source_production_output_id),
  FOREIGN KEY (material_event_input_id, processing_event_id)
    REFERENCES material_event_input(id, event_id) ON DELETE RESTRICT
);

CREATE FUNCTION validate_processing_input_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE input_batch UUID; source_batch UUID; source_site UUID; facility_id UUID;
BEGIN
  SELECT batch_id INTO input_batch FROM material_event_input WHERE id = NEW.material_event_input_id;
  SELECT eo.batch_id, h.site_id INTO source_batch, source_site
  FROM production_event_output peo
  JOIN material_event_output eo ON eo.id = peo.material_event_output_id
  JOIN production_event pe ON pe.event_id = peo.production_event_id
  JOIN mining_hole h ON h.id = pe.hole_id
  WHERE peo.material_event_output_id = NEW.source_production_output_id;
  IF source_batch IS NULL OR input_batch IS DISTINCT FROM source_batch THEN
    RAISE EXCEPTION 'processing input batch must match its source production output' USING ERRCODE = '23514';
  END IF;
  SELECT processing_facility_id INTO facility_id FROM processing_event WHERE event_id = NEW.processing_event_id;
  IF NOT EXISTS (
    SELECT 1 FROM processing_facility_site WHERE processing_facility_id = facility_id AND mining_site_id = source_site
  ) THEN
    RAISE EXCEPTION 'selected Dora is not associated with the source mining site' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER processing_input_lineage_guard BEFORE INSERT ON processing_event_input
  FOR EACH ROW EXECUTE FUNCTION validate_processing_input_lineage();

CREATE TABLE processing_event_output (
  material_event_output_id UUID PRIMARY KEY,
  processing_event_id UUID NOT NULL REFERENCES processing_event(event_id) ON DELETE RESTRICT,
  output_role TEXT NOT NULL CHECK (output_role IN ('MINER_RETAINED_GOLD', 'DORA_RETAINED_RESIDUE', 'OTHER_OUTPUT')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (material_event_output_id, processing_event_id)
    REFERENCES material_event_output(id, event_id) ON DELETE RESTRICT
);

CREATE FUNCTION validate_processing_output_kind() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE material_kind TEXT;
BEGIN
  SELECT b.material_kind INTO material_kind
  FROM material_event_output o JOIN material_batch b ON b.id = o.batch_id
  WHERE o.id = NEW.material_event_output_id AND o.event_id = NEW.processing_event_id;
  IF material_kind IS NULL THEN RAISE EXCEPTION 'processing output must match its event output' USING ERRCODE = '23503'; END IF;
  IF NEW.output_role = 'DORA_RETAINED_RESIDUE' AND material_kind <> 'RESIDUE' THEN
    RAISE EXCEPTION 'Dora-retained residue must remain a residue batch' USING ERRCODE = '23514';
  END IF;
  IF NEW.output_role = 'MINER_RETAINED_GOLD' AND material_kind NOT IN ('GOLD_DORE', 'RECOVERED_GOLD') THEN
    RAISE EXCEPTION 'miner-retained gold must remain a gold output batch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER processing_output_kind_guard BEFORE INSERT ON processing_event_output
  FOR EACH ROW EXECUTE FUNCTION validate_processing_output_kind();

CREATE FUNCTION validate_processing_event_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_key UUID;
BEGIN
  IF TG_TABLE_NAME = 'processing_event' THEN event_key := NEW.event_id;
  ELSIF TG_OP = 'DELETE' THEN event_key := OLD.processing_event_id;
  ELSE event_key := NEW.processing_event_id;
  END IF;
  IF EXISTS (SELECT 1 FROM processing_event WHERE event_id = event_key) THEN
    IF NOT EXISTS (SELECT 1 FROM processing_event_input WHERE processing_event_id = event_key) THEN
      RAISE EXCEPTION 'a processing event needs at least one input batch' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM processing_event_output WHERE processing_event_id = event_key) THEN
      RAISE EXCEPTION 'a processing event needs at least one output batch' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM processing_event_input pei
      JOIN material_measurement_set ms ON ms.material_event_input_id = pei.material_event_input_id
      LEFT JOIN material_measurement m ON m.measurement_set_id = ms.id
      WHERE pei.processing_event_id = event_key
      GROUP BY pei.material_event_input_id HAVING count(m.id) = 0
    ) OR EXISTS (
      SELECT 1 FROM processing_event_input pei
      LEFT JOIN material_measurement_set ms ON ms.material_event_input_id = pei.material_event_input_id
      WHERE pei.processing_event_id = event_key AND ms.id IS NULL
    ) THEN
      RAISE EXCEPTION 'each processing input needs a typed measurement observation' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM processing_event_output peo
      JOIN material_measurement_set ms ON ms.material_event_output_id = peo.material_event_output_id
      LEFT JOIN material_measurement m ON m.measurement_set_id = ms.id
      WHERE peo.processing_event_id = event_key
      GROUP BY peo.material_event_output_id HAVING count(m.id) = 0
    ) OR EXISTS (
      SELECT 1 FROM processing_event_output peo
      LEFT JOIN material_measurement_set ms ON ms.material_event_output_id = peo.material_event_output_id
      WHERE peo.processing_event_id = event_key AND ms.id IS NULL
    ) THEN
      RAISE EXCEPTION 'each processing output needs a typed measurement observation' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER processing_event_complete_guard AFTER INSERT ON processing_event
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_processing_event_complete();
CREATE CONSTRAINT TRIGGER processing_input_complete_guard AFTER INSERT OR DELETE ON processing_event_input
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_processing_event_complete();
CREATE CONSTRAINT TRIGGER processing_output_complete_guard AFTER INSERT OR DELETE ON processing_event_output
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_processing_event_complete();

CREATE FUNCTION validate_allocation_revision_totals() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE set_key UUID; basis TEXT; basis_measurement UUID; basis_set UUID;
DECLARE quantity_total NUMERIC(20,6); share_total NUMERIC(12,9); basis_quantity NUMERIC(20,6); rows_count INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'production_allocation_set' THEN set_key := NEW.id;
  ELSE set_key := NEW.allocation_set_id;
  END IF;
  SELECT basis_kind, basis_measurement_id, basis_measurement_set_id
    INTO basis, basis_measurement, basis_set
  FROM production_allocation_set WHERE id = set_key;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*)::int, COALESCE(sum(allocated_quantity_g), 0), COALESCE(sum(allocated_share), 0)
    INTO rows_count, quantity_total, share_total
  FROM production_allocation_row WHERE allocation_set_id = set_key;
  IF rows_count = 0 THEN RAISE EXCEPTION 'an allocation revision needs at least one beneficiary' USING ERRCODE = '23514'; END IF;
  IF basis = 'SHARE' AND share_total > 1 THEN
    RAISE EXCEPTION 'allocation shares exceed 1.0' USING ERRCODE = '23514';
  END IF;
  IF basis = 'QUANTITY' THEN
    SELECT quantity_g INTO basis_quantity FROM material_measurement
      WHERE id = basis_measurement AND measurement_set_id = basis_set;
    IF basis_quantity IS NULL OR quantity_total > basis_quantity THEN
      RAISE EXCEPTION 'allocation quantity exceeds its explicitly selected observation' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER allocation_revision_totals_set_guard AFTER INSERT ON production_allocation_set
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_allocation_revision_totals();
CREATE CONSTRAINT TRIGGER allocation_revision_totals_row_guard AFTER INSERT ON production_allocation_row
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_allocation_revision_totals();

ALTER TABLE production_allocation_row ADD CONSTRAINT allocation_row_basis_value_required_ck CHECK (
  (allocation_basis = 'QUANTITY' AND allocated_quantity_g IS NOT NULL AND allocated_quantity_g >= 0 AND allocated_share IS NULL)
  OR
  (allocation_basis = 'SHARE' AND allocated_share IS NOT NULL AND allocated_share BETWEEN 0 AND 1 AND allocated_quantity_g IS NULL)
);

CREATE UNIQUE INDEX qr_record_one_active_batch_uk ON qr_record(material_batch_id) WHERE status = 'ACTIVE';

CREATE TRIGGER production_participant_no_update BEFORE UPDATE ON production_event_participant FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER production_participant_no_delete BEFORE DELETE ON production_event_participant FOR EACH ROW EXECUTE FUNCTION reject_immutable_delete();
CREATE TRIGGER production_capture_no_update BEFORE UPDATE ON production_event_capture FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER production_capture_no_delete BEFORE DELETE ON production_event_capture FOR EACH ROW EXECUTE FUNCTION reject_immutable_delete();
CREATE TRIGGER capture_provenance_no_update BEFORE UPDATE ON capture_provenance FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER capture_provenance_no_delete BEFORE DELETE ON capture_provenance FOR EACH ROW EXECUTE FUNCTION reject_immutable_delete();
CREATE TRIGGER processing_site_no_update BEFORE UPDATE ON processing_facility_site FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER processing_site_no_delete BEFORE DELETE ON processing_facility_site FOR EACH ROW EXECUTE FUNCTION reject_immutable_delete();
CREATE TRIGGER material_event_input_no_update BEFORE UPDATE ON material_event_input FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER material_event_input_no_delete BEFORE DELETE ON material_event_input FOR EACH ROW EXECUTE FUNCTION reject_immutable_delete();
CREATE TRIGGER material_event_output_no_update BEFORE UPDATE ON material_event_output FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER material_event_output_no_delete BEFORE DELETE ON material_event_output FOR EACH ROW EXECUTE FUNCTION reject_immutable_delete();
CREATE TRIGGER production_event_no_update BEFORE UPDATE ON production_event FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER production_event_no_delete BEFORE DELETE ON production_event FOR EACH ROW EXECUTE FUNCTION reject_immutable_delete();
CREATE TRIGGER production_event_output_no_update BEFORE UPDATE ON production_event_output FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER production_event_output_no_delete BEFORE DELETE ON production_event_output FOR EACH ROW EXECUTE FUNCTION reject_immutable_delete();
CREATE TRIGGER processing_input_no_update BEFORE UPDATE ON processing_event_input FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER processing_input_no_delete BEFORE DELETE ON processing_event_input FOR EACH ROW EXECUTE FUNCTION reject_immutable_delete();
CREATE TRIGGER processing_output_no_update BEFORE UPDATE ON processing_event_output FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER processing_output_no_delete BEFORE DELETE ON processing_event_output FOR EACH ROW EXECUTE FUNCTION reject_immutable_delete();
CREATE TRIGGER processing_event_no_update BEFORE UPDATE ON processing_event FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER processing_event_no_delete BEFORE DELETE ON processing_event FOR EACH ROW EXECUTE FUNCTION reject_immutable_delete();
