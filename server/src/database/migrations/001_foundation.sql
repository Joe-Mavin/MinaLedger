CREATE FUNCTION reject_immutable_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only or immutable', TG_TABLE_NAME USING ERRCODE = '55000';
END $$;

CREATE TABLE party (
  id UUID PRIMARY KEY,
  party_kind TEXT NOT NULL CHECK (party_kind IN ('PERSON', 'ORGANISATION')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'SUSPENDED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE person_profile (
  party_id UUID PRIMARY KEY REFERENCES party(id) ON DELETE RESTRICT,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE organisation_profile (
  party_id UUID PRIMARY KEY REFERENCES party(id) ON DELETE RESTRICT,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  organisation_kind TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE FUNCTION validate_party_profile_kind() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_kind TEXT;
BEGIN
  expected_kind := CASE TG_TABLE_NAME WHEN 'person_profile' THEN 'PERSON' ELSE 'ORGANISATION' END;
  IF NOT EXISTS (SELECT 1 FROM party WHERE id = NEW.party_id AND party_kind = expected_kind) THEN
    RAISE EXCEPTION 'party profile kind does not match party kind' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER person_profile_kind BEFORE INSERT OR UPDATE ON person_profile FOR EACH ROW EXECUTE FUNCTION validate_party_profile_kind();
CREATE TRIGGER organisation_profile_kind BEFORE INSERT OR UPDATE ON organisation_profile FOR EACH ROW EXECUTE FUNCTION validate_party_profile_kind();

CREATE TABLE organisation_membership (
  id UUID PRIMARY KEY,
  person_party_id UUID NOT NULL REFERENCES person_profile(party_id) ON DELETE RESTRICT,
  organisation_party_id UUID NOT NULL REFERENCES organisation_profile(party_id) ON DELETE RESTRICT,
  membership_type TEXT NOT NULL,
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED', 'ENDED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE INDEX organisation_membership_person_idx ON organisation_membership(person_party_id, status);

CREATE TABLE party_participation (
  id UUID PRIMARY KEY,
  party_id UUID NOT NULL REFERENCES party(id) ON DELETE RESTRICT,
  participant_kind TEXT NOT NULL CHECK (participant_kind IN ('MINER', 'MINING_OPERATOR', 'LANDOWNER', 'PERMIT_HOLDER', 'DORA_OPERATOR', 'RECOVERY_FACILITY', 'LOCAL_MERCHANT', 'LARGER_MERCHANT', 'CARRIER', 'FIELD_OFFICER', 'AUDITOR', 'OTHER')),
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED', 'ENDED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE TABLE user_account (
  id UUID PRIMARY KEY,
  person_party_id UUID NOT NULL UNIQUE REFERENCES person_profile(party_id) ON DELETE RESTRICT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED', 'LOCKED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (email = lower(email))
);

CREATE TABLE role_assignment (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  role_code TEXT NOT NULL CHECK (role_code IN ('SYSTEM_ADMIN', 'FIELD_OFFICER', 'MINING_OPERATOR', 'MINER', 'DORA_OPERATOR', 'RECOVERY_FACILITY_OPERATOR', 'LOCAL_MERCHANT', 'LARGER_MERCHANT', 'AUDITOR')),
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('GLOBAL', 'PILOT', 'ORGANISATION', 'SITE', 'HOLE', 'FACILITY')),
  scope_id TEXT NOT NULL,
  granted_by_user_id UUID REFERENCES user_account(id) ON DELETE RESTRICT,
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED', 'EXPIRED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CHECK ((scope_kind = 'GLOBAL' AND scope_id = 'global') OR (scope_kind <> 'GLOBAL' AND length(trim(scope_id)) > 0))
);
CREATE INDEX role_assignment_active_user_idx ON role_assignment(user_id, role_code, scope_kind, scope_id) WHERE status = 'ACTIVE';

CREATE TABLE mining_site (
  id UUID PRIMARY KEY,
  site_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  county_code TEXT,
  locality TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'CLOSED')),
  created_by_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(id, site_code)
);

CREATE TABLE mining_hole (
  id UUID PRIMARY KEY,
  site_id UUID NOT NULL REFERENCES mining_site(id) ON DELETE RESTRICT,
  hole_code TEXT NOT NULL,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'CLOSED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(site_id, hole_code),
  UNIQUE(id, site_id)
);

CREATE TABLE site_party_role (
  id UUID PRIMARY KEY,
  site_id UUID NOT NULL REFERENCES mining_site(id) ON DELETE RESTRICT,
  party_id UUID NOT NULL REFERENCES party(id) ON DELETE RESTRICT,
  role_code TEXT NOT NULL CHECK (role_code IN ('LANDOWNER', 'PERMIT_HOLDER', 'SITE_OPERATOR', 'MINER', 'BENEFICIARY', 'FIELD_RECORDER', 'OTHER')),
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED', 'ENDED')),
  asserted_by_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE TABLE hole_party_role (
  id UUID PRIMARY KEY,
  hole_id UUID NOT NULL REFERENCES mining_hole(id) ON DELETE RESTRICT,
  party_id UUID NOT NULL REFERENCES party(id) ON DELETE RESTRICT,
  role_code TEXT NOT NULL CHECK (role_code IN ('HOLE_OPERATOR', 'MINER', 'BENEFICIARY', 'FIELD_RECORDER', 'OTHER')),
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED', 'ENDED')),
  asserted_by_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE TABLE processing_facility (
  id UUID PRIMARY KEY,
  party_id UUID REFERENCES party(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE recovery_facility (
  id UUID PRIMARY KEY,
  party_id UUID REFERENCES party(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE facility_party_role (
  id UUID PRIMARY KEY,
  processing_facility_id UUID REFERENCES processing_facility(id) ON DELETE RESTRICT,
  recovery_facility_id UUID REFERENCES recovery_facility(id) ON DELETE RESTRICT,
  party_id UUID NOT NULL REFERENCES party(id) ON DELETE RESTRICT,
  role_code TEXT NOT NULL,
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED', 'ENDED')),
  asserted_by_user_id UUID REFERENCES user_account(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(processing_facility_id, recovery_facility_id) = 1),
  CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE TABLE material_batch (
  id UUID PRIMARY KEY,
  batch_code TEXT NOT NULL UNIQUE,
  material_kind TEXT NOT NULL CHECK (material_kind IN ('GOLD_BEARING_FEED', 'RESIDUE', 'GOLD_DORE', 'RECOVERED_GOLD', 'PROCESS_OUTPUT')),
  current_status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (current_status IN ('ACTIVE', 'DISPUTED', 'CLOSED', 'VOIDED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE material_event (
  id UUID PRIMARY KEY,
  event_code TEXT NOT NULL UNIQUE,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('PRODUCTION', 'PROCESSING', 'RECOVERY', 'MOVEMENT', 'AGGREGATION', 'CORRECTION')),
  occurred_at_claimed TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responsible_party_id UUID NOT NULL REFERENCES party(id) ON DELETE RESTRICT,
  actor_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  current_status TEXT NOT NULL DEFAULT 'SUBMITTED' CHECK (current_status IN ('DRAFT', 'SUBMITTED', 'ACCEPTED', 'REJECTED', 'VOIDED')),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  notes_ref TEXT,
  supersedes_event_id UUID REFERENCES material_event(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE material_event_input (
  id UUID PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES material_event(id) ON DELETE RESTRICT,
  batch_id UUID NOT NULL REFERENCES material_batch(id) ON DELETE RESTRICT,
  input_sequence INTEGER NOT NULL CHECK (input_sequence > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(event_id, input_sequence),
  UNIQUE(id, batch_id),
  UNIQUE(id, event_id, batch_id)
);
CREATE TABLE material_event_output (
  id UUID PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES material_event(id) ON DELETE RESTRICT,
  batch_id UUID NOT NULL UNIQUE REFERENCES material_batch(id) ON DELETE RESTRICT,
  output_sequence INTEGER NOT NULL CHECK (output_sequence > 0),
  output_kind TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(event_id, output_sequence),
  UNIQUE(id, batch_id),
  UNIQUE(id, event_id),
  UNIQUE(id, event_id, batch_id)
);
CREATE TABLE production_event (
  event_id UUID PRIMARY KEY REFERENCES material_event(id) ON DELETE RESTRICT,
  hole_id UUID NOT NULL REFERENCES mining_hole(id) ON DELETE RESTRICT,
  shift_or_period_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE production_event_output (
  material_event_output_id UUID PRIMARY KEY,
  production_event_id UUID NOT NULL REFERENCES production_event(event_id) ON DELETE RESTRICT,
  FOREIGN KEY (material_event_output_id, production_event_id)
    REFERENCES material_event_output(id, event_id) ON DELETE RESTRICT
);

CREATE TABLE processing_event (
  event_id UUID PRIMARY KEY REFERENCES material_event(id) ON DELETE RESTRICT,
  processing_facility_id UUID NOT NULL REFERENCES processing_facility(id) ON DELETE RESTRICT,
  operator_party_id UUID NOT NULL REFERENCES party(id) ON DELETE RESTRICT,
  service_terms_ref TEXT
);
CREATE TABLE recovery_event (
  event_id UUID PRIMARY KEY REFERENCES material_event(id) ON DELETE RESTRICT,
  recovery_facility_id UUID NOT NULL REFERENCES recovery_facility(id) ON DELETE RESTRICT,
  operator_party_id UUID NOT NULL REFERENCES party(id) ON DELETE RESTRICT,
  method_ref TEXT
);

CREATE TABLE assay_record (
  id UUID PRIMARY KEY,
  batch_id UUID NOT NULL REFERENCES material_batch(id) ON DELETE RESTRICT,
  assayer_party_id UUID REFERENCES party(id) ON DELETE RESTRICT,
  sample_ref TEXT,
  method_ref TEXT,
  result_value NUMERIC(20, 8),
  result_unit TEXT,
  observed_at TIMESTAMPTZ NOT NULL,
  evidence_ref TEXT,
  correction_of_id UUID REFERENCES assay_record(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE gold_trade (
  id UUID PRIMARY KEY,
  trade_code TEXT NOT NULL UNIQUE,
  trade_kind TEXT NOT NULL CHECK (trade_kind IN ('PURCHASE', 'RESALE')),
  buyer_party_id UUID NOT NULL REFERENCES party(id) ON DELETE RESTRICT,
  seller_party_id UUID NOT NULL REFERENCES party(id) ON DELETE RESTRICT,
  agreed_at TIMESTAMPTZ NOT NULL,
  currency_code CHAR(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  terms_ref TEXT,
  supersedes_trade_id UUID UNIQUE REFERENCES gold_trade(id) ON DELETE RESTRICT,
  correction_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(id, currency_code),
  CHECK (buyer_party_id <> seller_party_id),
  CHECK ((supersedes_trade_id IS NULL AND correction_reason IS NULL) OR (supersedes_trade_id IS NOT NULL AND length(trim(correction_reason)) > 0))
);
CREATE TRIGGER gold_trade_currency_immutable BEFORE UPDATE OF currency_code ON gold_trade FOR EACH ROW
WHEN (NEW.currency_code IS DISTINCT FROM OLD.currency_code)
EXECUTE FUNCTION reject_immutable_update();

CREATE TABLE residue_sale (
  id UUID PRIMARY KEY,
  sale_code TEXT NOT NULL UNIQUE,
  seller_party_id UUID NOT NULL REFERENCES party(id) ON DELETE RESTRICT,
  buyer_party_id UUID NOT NULL REFERENCES party(id) ON DELETE RESTRICT,
  agreed_at TIMESTAMPTZ NOT NULL,
  currency_code CHAR(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  terms_ref TEXT,
  supersedes_sale_id UUID UNIQUE REFERENCES residue_sale(id) ON DELETE RESTRICT,
  correction_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(id, currency_code),
  CHECK (seller_party_id <> buyer_party_id),
  CHECK ((supersedes_sale_id IS NULL AND correction_reason IS NULL) OR (supersedes_sale_id IS NOT NULL AND length(trim(correction_reason)) > 0))
);
CREATE TRIGGER residue_sale_currency_immutable BEFORE UPDATE OF currency_code ON residue_sale FOR EACH ROW
WHEN (NEW.currency_code IS DISTINCT FROM OLD.currency_code)
EXECUTE FUNCTION reject_immutable_update();

CREATE TABLE gold_trade_line (
  id UUID PRIMARY KEY,
  trade_id UUID NOT NULL REFERENCES gold_trade(id) ON DELETE RESTRICT,
  batch_id UUID NOT NULL REFERENCES material_batch(id) ON DELETE RESTRICT,
  revision_no INTEGER NOT NULL CHECK (revision_no > 0),
  revision_kind TEXT NOT NULL CHECK (revision_kind IN ('ORIGINAL', 'CORRECTION')),
  transaction_quantity_g NUMERIC(20, 6) NOT NULL CHECK (transaction_quantity_g > 0),
  accepted_trade_quantity_g NUMERIC(20, 6) CHECK (accepted_trade_quantity_g > 0),
  unit_price NUMERIC(20, 8),
  line_amount NUMERIC(20, 8),
  assay_record_id UUID REFERENCES assay_record(id) ON DELETE RESTRICT,
  supersedes_line_id UUID REFERENCES gold_trade_line(id) ON DELETE RESTRICT,
  correction_reason TEXT,
  is_accepted BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(trade_id, batch_id, revision_no),
  UNIQUE(id, batch_id),
  CHECK ((revision_kind = 'ORIGINAL' AND revision_no = 1 AND supersedes_line_id IS NULL AND correction_reason IS NULL) OR (revision_kind = 'CORRECTION' AND revision_no > 1 AND supersedes_line_id IS NOT NULL AND length(trim(correction_reason)) > 0)),
  CHECK (NOT is_accepted OR accepted_trade_quantity_g IS NOT NULL)
);
CREATE UNIQUE INDEX gold_trade_line_single_successor_idx ON gold_trade_line(supersedes_line_id) WHERE supersedes_line_id IS NOT NULL;
CREATE UNIQUE INDEX gold_trade_line_one_current_accepted_idx ON gold_trade_line(trade_id,batch_id) WHERE is_accepted;

CREATE TABLE residue_sale_line (
  id UUID PRIMARY KEY,
  residue_sale_id UUID NOT NULL REFERENCES residue_sale(id) ON DELETE RESTRICT,
  batch_id UUID NOT NULL REFERENCES material_batch(id) ON DELETE RESTRICT,
  revision_no INTEGER NOT NULL CHECK (revision_no > 0),
  revision_kind TEXT NOT NULL CHECK (revision_kind IN ('ORIGINAL', 'CORRECTION')),
  transaction_quantity_g NUMERIC(20, 6) NOT NULL CHECK (transaction_quantity_g > 0),
  accepted_trade_quantity_g NUMERIC(20, 6) CHECK (accepted_trade_quantity_g > 0),
  unit_price NUMERIC(20, 8),
  line_amount NUMERIC(20, 8),
  supersedes_line_id UUID REFERENCES residue_sale_line(id) ON DELETE RESTRICT,
  correction_reason TEXT,
  is_accepted BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(residue_sale_id, batch_id, revision_no),
  UNIQUE(id, batch_id),
  CHECK ((revision_kind = 'ORIGINAL' AND revision_no = 1 AND supersedes_line_id IS NULL AND correction_reason IS NULL) OR (revision_kind = 'CORRECTION' AND revision_no > 1 AND supersedes_line_id IS NOT NULL AND length(trim(correction_reason)) > 0)),
  CHECK (NOT is_accepted OR accepted_trade_quantity_g IS NOT NULL)
);
CREATE UNIQUE INDEX residue_sale_line_single_successor_idx ON residue_sale_line(supersedes_line_id) WHERE supersedes_line_id IS NOT NULL;
CREATE UNIQUE INDEX residue_sale_line_one_current_accepted_idx ON residue_sale_line(residue_sale_id,batch_id) WHERE is_accepted;

CREATE TABLE commercial_line_decision_event (
  id UUID PRIMARY KEY,
  gold_trade_line_id UUID REFERENCES gold_trade_line(id) ON DELETE RESTRICT,
  residue_sale_line_id UUID REFERENCES residue_sale_line(id) ON DELETE RESTRICT,
  actor_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  actor_party_id UUID NOT NULL REFERENCES party(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('ACCEPT', 'DISPUTE', 'REJECT', 'WITHDRAW')),
  occurred_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason TEXT,
  evidence_ref TEXT,
  CHECK (num_nonnulls(gold_trade_line_id, residue_sale_line_id) = 1)
);

CREATE TABLE consignment (
  id UUID PRIMARY KEY,
  consignment_code TEXT NOT NULL UNIQUE,
  sender_party_id UUID NOT NULL REFERENCES party(id) ON DELETE RESTRICT,
  recipient_party_id UUID NOT NULL REFERENCES party(id) ON DELETE RESTRICT,
  transit_location_id UUID UNIQUE,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'DISPATCHED', 'PART_RECEIVED', 'RECEIVED', 'DISPUTED', 'CLOSED')),
  dispatched_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (sender_party_id <> recipient_party_id)
);
CREATE TABLE consignment_item (
  id UUID PRIMARY KEY,
  consignment_id UUID NOT NULL REFERENCES consignment(id) ON DELETE RESTRICT,
  batch_id UUID NOT NULL REFERENCES material_batch(id) ON DELETE RESTRICT,
  line_no INTEGER NOT NULL CHECK (line_no > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(consignment_id, line_no),
  UNIQUE(id, batch_id)
);
CREATE TABLE transport_record (
  id UUID PRIMARY KEY,
  consignment_id UUID NOT NULL REFERENCES consignment(id) ON DELETE RESTRICT,
  carrier_party_id UUID REFERENCES party(id) ON DELETE RESTRICT,
  vehicle_ref TEXT,
  departure_at TIMESTAMPTZ,
  arrival_at TIMESTAMPTZ,
  evidence_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE inventory_location (
  id UUID PRIMARY KEY,
  location_code TEXT NOT NULL UNIQUE,
  location_kind TEXT NOT NULL CHECK (location_kind IN ('STOCKPILE', 'CONSIGNMENT_TRANSIT', 'RECOVERY_FACILITY', 'MERCHANT', 'OTHER')),
  custodian_party_id UUID NOT NULL REFERENCES party(id) ON DELETE RESTRICT,
  physical_place_ref TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(id, location_kind)
);
ALTER TABLE consignment ADD CONSTRAINT consignment_transit_location_fk FOREIGN KEY (transit_location_id) REFERENCES inventory_location(id) ON DELETE RESTRICT;
CREATE TABLE residue_stockpile (
  inventory_location_id UUID PRIMARY KEY REFERENCES inventory_location(id) ON DELETE RESTRICT,
  stockpile_code TEXT NOT NULL UNIQUE,
  processing_facility_id UUID NOT NULL REFERENCES processing_facility(id) ON DELETE RESTRICT,
  operator_party_id UUID NOT NULL REFERENCES party(id) ON DELETE RESTRICT,
  location_ref TEXT
);
CREATE TABLE recovery_inventory_location (
  inventory_location_id UUID PRIMARY KEY REFERENCES inventory_location(id) ON DELETE RESTRICT,
  recovery_facility_id UUID NOT NULL REFERENCES recovery_facility(id) ON DELETE RESTRICT,
  location_ref TEXT
);
CREATE TABLE merchant_inventory_location (
  inventory_location_id UUID PRIMARY KEY REFERENCES inventory_location(id) ON DELETE RESTRICT,
  merchant_party_id UUID NOT NULL REFERENCES party(id) ON DELETE RESTRICT
);
CREATE TABLE inventory_count (
  id UUID PRIMARY KEY,
  location_id UUID NOT NULL REFERENCES inventory_location(id) ON DELETE RESTRICT,
  batch_id UUID NOT NULL REFERENCES material_batch(id) ON DELETE RESTRICT,
  counted_at_claimed TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  evidence_ref TEXT,
  UNIQUE(id, batch_id, location_id),
  UNIQUE(id, batch_id)
);

CREATE TABLE material_measurement_set (
  id UUID PRIMARY KEY,
  batch_id UUID NOT NULL REFERENCES material_batch(id) ON DELETE RESTRICT,
  material_event_input_id UUID,
  material_event_output_id UUID,
  gold_trade_line_id UUID,
  residue_sale_line_id UUID,
  consignment_item_id UUID,
  consignment_stage TEXT CHECK (consignment_stage IN ('MANIFEST', 'DISPATCH', 'RECEIPT')),
  inventory_count_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(material_event_input_id, material_event_output_id, gold_trade_line_id, residue_sale_line_id, consignment_item_id, inventory_count_id) = 1),
  CHECK ((consignment_item_id IS NULL) = (consignment_stage IS NULL)),
  UNIQUE(id, batch_id),
  UNIQUE(id, material_event_input_id),
  UNIQUE(id, material_event_output_id),
  UNIQUE(id, gold_trade_line_id),
  UNIQUE(id, residue_sale_line_id),
  UNIQUE(id, consignment_item_id, consignment_stage),
  UNIQUE(id, inventory_count_id),
  FOREIGN KEY (material_event_input_id, batch_id) REFERENCES material_event_input(id, batch_id) ON DELETE RESTRICT,
  FOREIGN KEY (material_event_output_id, batch_id) REFERENCES material_event_output(id, batch_id) ON DELETE RESTRICT,
  FOREIGN KEY (gold_trade_line_id, batch_id) REFERENCES gold_trade_line(id, batch_id) ON DELETE RESTRICT,
  FOREIGN KEY (residue_sale_line_id, batch_id) REFERENCES residue_sale_line(id, batch_id) ON DELETE RESTRICT,
  FOREIGN KEY (consignment_item_id, batch_id) REFERENCES consignment_item(id, batch_id) ON DELETE RESTRICT,
  FOREIGN KEY (inventory_count_id, batch_id) REFERENCES inventory_count(id, batch_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX measurement_set_unique_consignment_stage ON material_measurement_set(consignment_item_id, consignment_stage) WHERE consignment_item_id IS NOT NULL;

CREATE TABLE material_measurement (
  id UUID PRIMARY KEY,
  measurement_set_id UUID NOT NULL REFERENCES material_measurement_set(id) ON DELETE RESTRICT,
  measurement_kind TEXT NOT NULL CHECK (measurement_kind IN ('DECLARED', 'MEASURED', 'VERIFIED')),
  quantity_g NUMERIC(20, 6) NOT NULL CHECK (quantity_g >= 0),
  source_value NUMERIC(28, 12) NOT NULL CHECK (source_value >= 0),
  source_unit_code TEXT NOT NULL,
  conversion_version TEXT NOT NULL,
  source_role TEXT NOT NULL CHECK (source_role IN ('SELLER', 'BUYER', 'RECORDER', 'WITNESS', 'WEIGHER', 'OTHER')),
  source_party_id UUID REFERENCES party(id) ON DELETE RESTRICT,
  entered_by_user_id UUID REFERENCES user_account(id) ON DELETE RESTRICT,
  method_code TEXT,
  instrument_ref TEXT,
  occurred_at_claimed TIMESTAMPTZ NOT NULL,
  entered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  evidence_ref TEXT,
  supersedes_measurement_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(id, measurement_set_id),
  FOREIGN KEY (supersedes_measurement_id, measurement_set_id) REFERENCES material_measurement(id, measurement_set_id) ON DELETE RESTRICT,
  CHECK (supersedes_measurement_id IS NULL OR supersedes_measurement_id <> id)
);
CREATE INDEX material_measurement_set_idx ON material_measurement(measurement_set_id, entered_at);

CREATE TABLE measurement_review_event (
  id UUID PRIMARY KEY,
  material_measurement_id UUID NOT NULL REFERENCES material_measurement(id) ON DELETE RESTRICT,
  review_status TEXT NOT NULL CHECK (review_status IN ('DISPUTED', 'ACCEPTED_FOR_CONTEXT', 'REJECTED', 'WITHDRAWN')),
  actor_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  reason TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE production_allocation_chain (
  id UUID PRIMARY KEY,
  production_event_output_id UUID NOT NULL UNIQUE REFERENCES production_event_output(material_event_output_id) ON DELETE RESTRICT,
  active_approved_set_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE production_allocation_set (
  id UUID PRIMARY KEY,
  allocation_chain_id UUID NOT NULL REFERENCES production_allocation_chain(id) ON DELETE RESTRICT,
  revision_no INTEGER NOT NULL CHECK (revision_no > 0),
  revision_kind TEXT NOT NULL CHECK (revision_kind IN ('ORIGINAL', 'CORRECTION')),
  basis_kind TEXT NOT NULL CHECK (basis_kind IN ('QUANTITY', 'SHARE')),
  basis_measurement_set_id UUID REFERENCES material_measurement_set(id) ON DELETE RESTRICT,
  basis_measurement_id UUID,
  supersedes_set_id UUID,
  correction_reason TEXT,
  proposed_by_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(allocation_chain_id, revision_no),
  UNIQUE(allocation_chain_id, id),
  UNIQUE(id, basis_kind),
  FOREIGN KEY (allocation_chain_id, supersedes_set_id) REFERENCES production_allocation_set(allocation_chain_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (basis_measurement_id, basis_measurement_set_id) REFERENCES material_measurement(id, measurement_set_id) ON DELETE RESTRICT,
  CHECK ((revision_kind = 'ORIGINAL' AND revision_no = 1 AND supersedes_set_id IS NULL AND correction_reason IS NULL) OR (revision_kind = 'CORRECTION' AND revision_no > 1 AND supersedes_set_id IS NOT NULL AND length(trim(correction_reason)) > 0)),
  CHECK ((basis_kind = 'QUANTITY' AND basis_measurement_set_id IS NOT NULL AND basis_measurement_id IS NOT NULL) OR (basis_kind = 'SHARE' AND basis_measurement_set_id IS NULL AND basis_measurement_id IS NULL))
);
ALTER TABLE production_allocation_chain ADD CONSTRAINT allocation_active_set_same_chain_fk
  FOREIGN KEY (id, active_approved_set_id) REFERENCES production_allocation_set(allocation_chain_id, id) DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX allocation_set_single_successor_idx ON production_allocation_set(supersedes_set_id) WHERE supersedes_set_id IS NOT NULL;

CREATE TABLE production_allocation_row (
  id UUID PRIMARY KEY,
  allocation_set_id UUID NOT NULL REFERENCES production_allocation_set(id) ON DELETE RESTRICT,
  beneficiary_party_id UUID NOT NULL REFERENCES party(id) ON DELETE RESTRICT,
  allocation_basis TEXT NOT NULL CHECK (allocation_basis IN ('QUANTITY', 'SHARE')),
  allocated_quantity_g NUMERIC(20, 6),
  allocated_share NUMERIC(12, 9),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(allocation_set_id, beneficiary_party_id),
  FOREIGN KEY (allocation_set_id, allocation_basis) REFERENCES production_allocation_set(id, basis_kind) ON DELETE RESTRICT,
  CHECK ((allocation_basis = 'QUANTITY' AND allocated_quantity_g >= 0 AND allocated_share IS NULL) OR (allocation_basis = 'SHARE' AND allocated_share BETWEEN 0 AND 1 AND allocated_quantity_g IS NULL))
);

CREATE TABLE allocation_set_review_event (
  id UUID PRIMARY KEY,
  production_allocation_set_id UUID NOT NULL REFERENCES production_allocation_set(id) ON DELETE RESTRICT,
  review_sequence INTEGER NOT NULL CHECK (review_sequence > 0),
  review_status TEXT NOT NULL CHECK (review_status IN ('PENDING', 'PROVISIONAL', 'DISPUTED', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
  authorized_basis_measurement_id UUID REFERENCES material_measurement(id) ON DELETE RESTRICT,
  actor_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  reason TEXT,
  evidence_ref TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(production_allocation_set_id, review_sequence)
);

CREATE TABLE entitlement_event (
  id UUID PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES material_event(id) ON DELETE RESTRICT,
  batch_id UUID NOT NULL REFERENCES material_batch(id) ON DELETE RESTRICT,
  party_id UUID NOT NULL REFERENCES party(id) ON DELETE RESTRICT,
  entitlement_kind TEXT NOT NULL,
  quantity_g NUMERIC(20, 6),
  share NUMERIC(12, 9),
  basis TEXT,
  effective_at TIMESTAMPTZ NOT NULL,
  supersedes_id UUID REFERENCES entitlement_event(id) ON DELETE RESTRICT,
  CHECK (num_nonnulls(quantity_g, share) = 1)
);
CREATE TABLE custody_transfer (
  id UUID PRIMARY KEY,
  batch_id UUID REFERENCES material_batch(id) ON DELETE RESTRICT,
  consignment_id UUID REFERENCES consignment(id) ON DELETE RESTRICT,
  from_party_id UUID NOT NULL REFERENCES party(id) ON DELETE RESTRICT,
  to_party_id UUID NOT NULL REFERENCES party(id) ON DELETE RESTRICT,
  offered_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('OFFERED', 'ACCEPTED', 'DISPUTED', 'REJECTED', 'WITHDRAWN')),
  offered_by_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  accepted_by_user_id UUID REFERENCES user_account(id) ON DELETE RESTRICT,
  linked_inventory_movement_id UUID,
  correction_of_id UUID REFERENCES custody_transfer(id) ON DELETE RESTRICT,
  CHECK (num_nonnulls(batch_id, consignment_id) = 1),
  CHECK ((status = 'ACCEPTED') = (accepted_at IS NOT NULL))
);

CREATE TABLE residue_sale_shipment_item (
  id UUID PRIMARY KEY,
  residue_sale_line_id UUID NOT NULL REFERENCES residue_sale_line(id) ON DELETE RESTRICT,
  consignment_item_id UUID NOT NULL REFERENCES consignment_item(id) ON DELETE RESTRICT,
  mapped_quantity_g NUMERIC(20, 6) NOT NULL CHECK (mapped_quantity_g > 0),
  basis_measurement_id UUID NOT NULL REFERENCES material_measurement(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(residue_sale_line_id, consignment_item_id, basis_measurement_id)
);

CREATE TABLE payment (
  id UUID PRIMARY KEY,
  gold_trade_id UUID REFERENCES gold_trade(id) ON DELETE RESTRICT,
  residue_sale_id UUID REFERENCES residue_sale(id) ON DELETE RESTRICT,
  currency_code CHAR(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  payer_party_id UUID NOT NULL REFERENCES party(id) ON DELETE RESTRICT,
  payee_party_id UUID NOT NULL REFERENCES party(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(id, currency_code),
  CHECK (num_nonnulls(gold_trade_id, residue_sale_id) = 1),
  CHECK (payer_party_id <> payee_party_id),
  FOREIGN KEY (gold_trade_id, currency_code) REFERENCES gold_trade(id, currency_code) ON DELETE RESTRICT,
  FOREIGN KEY (residue_sale_id, currency_code) REFERENCES residue_sale(id, currency_code) ON DELETE RESTRICT
);
CREATE TABLE payment_event (
  id UUID PRIMARY KEY,
  payment_id UUID NOT NULL,
  currency_code CHAR(3) NOT NULL,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('REPORTED', 'CONFIRMED', 'FAILED', 'REVERSAL', 'CORRECTION')),
  direction TEXT NOT NULL CHECK (direction IN ('CREDIT', 'DEBIT')),
  amount NUMERIC(20, 8) NOT NULL CHECK (amount > 0),
  method_code TEXT,
  external_ref TEXT,
  occurred_at_claimed TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  related_event_id UUID REFERENCES payment_event(id) ON DELETE RESTRICT,
  reason TEXT,
  evidence_ref TEXT,
  FOREIGN KEY (payment_id, currency_code) REFERENCES payment(id, currency_code) ON DELETE RESTRICT
);

CREATE TABLE inventory_movement (
  id UUID PRIMARY KEY,
  event_id UUID UNIQUE REFERENCES material_event(id) ON DELETE RESTRICT,
  movement_kind TEXT NOT NULL CHECK (movement_kind IN ('TRANSFER', 'TRANSFORMATION', 'ADJUSTMENT', 'OPENING_BALANCE', 'REVERSAL')),
  current_status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (current_status IN ('DRAFT', 'ACCEPTED', 'REJECTED', 'VOIDED')),
  reason TEXT,
  actor_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  occurred_at_claimed TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reverses_movement_id UUID REFERENCES inventory_movement(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((movement_kind = 'TRANSFORMATION' AND event_id IS NOT NULL) OR (movement_kind <> 'TRANSFORMATION' AND event_id IS NULL) OR (movement_kind = 'TRANSFER' AND event_id IS NOT NULL)),
  CHECK ((movement_kind = 'REVERSAL' AND reverses_movement_id IS NOT NULL) OR (movement_kind <> 'REVERSAL' AND reverses_movement_id IS NULL))
);

CREATE TABLE inventory_movement_line (
  id UUID PRIMARY KEY,
  inventory_movement_id UUID NOT NULL REFERENCES inventory_movement(id) ON DELETE RESTRICT,
  batch_id UUID NOT NULL REFERENCES material_batch(id) ON DELETE RESTRICT,
  location_id UUID NOT NULL REFERENCES inventory_location(id) ON DELETE RESTRICT,
  direction TEXT NOT NULL CHECK (direction IN ('IN', 'OUT')),
  posted_quantity_g NUMERIC(20, 6) NOT NULL CHECK (posted_quantity_g > 0),
  basis_measurement_set_id UUID,
  basis_measurement_id UUID,
  consignment_item_id UUID,
  consignment_stage TEXT CHECK (consignment_stage IN ('MANIFEST', 'DISPATCH', 'RECEIPT')),
  material_event_input_id UUID,
  material_event_output_id UUID,
  gold_trade_line_id UUID,
  residue_sale_line_id UUID,
  inventory_count_id UUID,
  reverses_line_id UUID REFERENCES inventory_movement_line(id) ON DELETE RESTRICT,
  line_no INTEGER NOT NULL CHECK (line_no > 0),
  UNIQUE(inventory_movement_id, line_no),
  FOREIGN KEY (basis_measurement_set_id, batch_id) REFERENCES material_measurement_set(id, batch_id) ON DELETE RESTRICT,
  FOREIGN KEY (basis_measurement_id, basis_measurement_set_id) REFERENCES material_measurement(id, measurement_set_id) ON DELETE RESTRICT,
  FOREIGN KEY (consignment_item_id, batch_id) REFERENCES consignment_item(id, batch_id) ON DELETE RESTRICT,
  FOREIGN KEY (inventory_count_id, batch_id, location_id) REFERENCES inventory_count(id, batch_id, location_id) ON DELETE RESTRICT,
  FOREIGN KEY (material_event_input_id, batch_id) REFERENCES material_event_input(id, batch_id) ON DELETE RESTRICT,
  FOREIGN KEY (material_event_output_id, batch_id) REFERENCES material_event_output(id, batch_id) ON DELETE RESTRICT,
  FOREIGN KEY (gold_trade_line_id, batch_id) REFERENCES gold_trade_line(id, batch_id) ON DELETE RESTRICT,
  FOREIGN KEY (residue_sale_line_id, batch_id) REFERENCES residue_sale_line(id, batch_id) ON DELETE RESTRICT,
  CHECK ((basis_measurement_set_id IS NULL) = (basis_measurement_id IS NULL)),
  CHECK ((consignment_item_id IS NULL) = (consignment_stage IS NULL)),
  CHECK (num_nonnulls(gold_trade_line_id, residue_sale_line_id) <= 1)
);
CREATE INDEX inventory_movement_line_balance_idx ON inventory_movement_line(location_id, batch_id, inventory_movement_id);
CREATE INDEX inventory_movement_line_trade_idx ON inventory_movement_line(gold_trade_line_id) WHERE gold_trade_line_id IS NOT NULL;
CREATE INDEX inventory_movement_line_residue_idx ON inventory_movement_line(residue_sale_line_id) WHERE residue_sale_line_id IS NOT NULL;
CREATE TABLE inventory_balance_guard (
  location_id UUID NOT NULL REFERENCES inventory_location(id) ON DELETE RESTRICT,
  batch_id UUID NOT NULL REFERENCES material_batch(id) ON DELETE RESTRICT,
  lock_version BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY(location_id, batch_id)
);
CREATE VIEW inventory_balance AS
  SELECT l.location_id, l.batch_id,
         sum(CASE WHEN l.direction = 'IN' THEN l.posted_quantity_g ELSE -l.posted_quantity_g END)::NUMERIC(20,6) AS quantity_g
  FROM inventory_movement_line l
  JOIN inventory_movement m ON m.id = l.inventory_movement_id
  WHERE m.current_status = 'ACCEPTED'
  GROUP BY l.location_id, l.batch_id;

CREATE TABLE capture_provenance (
  id UUID PRIMARY KEY,
  material_event_id UUID NOT NULL REFERENCES material_event(id) ON DELETE RESTRICT,
  actual_participant_party_id UUID REFERENCES party(id) ON DELETE RESTRICT,
  participant_identity_state TEXT NOT NULL CHECK (participant_identity_state IN ('IDENTIFIED', 'UNRESOLVED', 'UNKNOWN')),
  entered_by_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('DIRECT', 'ASSISTED_VERBAL', 'WITNESS', 'PAPER_TRANSCRIPTION', 'OTHER')),
  occurred_at_claimed TIMESTAMPTZ NOT NULL,
  entered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_reference TEXT,
  evidence_ref TEXT,
  note TEXT,
  CHECK ((participant_identity_state = 'IDENTIFIED') = (actual_participant_party_id IS NOT NULL))
);
CREATE TABLE capture_acknowledgement_event (
  id UUID PRIMARY KEY,
  capture_provenance_id UUID NOT NULL REFERENCES capture_provenance(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('ACKNOWLEDGED', 'PENDING', 'DECLINED', 'DISPUTED', 'NOT_OBTAINED')),
  acknowledged_by_party_id UUID REFERENCES party(id) ON DELETE RESTRICT,
  recorded_by_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  method TEXT,
  occurred_at_claimed TIMESTAMPTZ,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason TEXT,
  CHECK ((status = 'ACKNOWLEDGED') = (acknowledged_by_party_id IS NOT NULL))
);

CREATE TABLE audit_event (
  id UUID PRIMARY KEY,
  event_type TEXT NOT NULL,
  actor_user_id UUID REFERENCES user_account(id) ON DELETE RESTRICT,
  actor_party_id UUID REFERENCES party(id) ON DELETE RESTRICT,
  client_mutation_id UUID,
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  occurred_at_claimed TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  canonical_payload TEXT NOT NULL,
  payload_salt BYTEA NOT NULL CHECK (octet_length(payload_salt) = 32),
  payload_commitment BYTEA NOT NULL CHECK (octet_length(payload_commitment) = 32),
  hash_algorithm TEXT NOT NULL DEFAULT 'SHA-256',
  UNIQUE(id, payload_commitment)
);
CREATE TABLE audit_stream_head (
  stream_kind TEXT NOT NULL,
  stream_id UUID NOT NULL,
  last_sequence BIGINT NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  head_hash BYTEA NOT NULL DEFAULT decode(repeat('00', 32), 'hex') CHECK (octet_length(head_hash) = 32),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(stream_kind, stream_id)
);
CREATE TABLE audit_stream_entry (
  id UUID PRIMARY KEY,
  audit_event_id UUID NOT NULL REFERENCES audit_event(id) ON DELETE RESTRICT,
  stream_kind TEXT NOT NULL,
  stream_id UUID NOT NULL,
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  previous_hash BYTEA NOT NULL CHECK (octet_length(previous_hash) = 32),
  entry_hash BYTEA NOT NULL CHECK (octet_length(entry_hash) = 32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(stream_kind, stream_id, sequence),
  UNIQUE(audit_event_id, stream_kind, stream_id)
);
CREATE TABLE idempotency_receipt (
  id UUID PRIMARY KEY,
  actor_scope TEXT NOT NULL,
  client_mutation_id UUID NOT NULL,
  request_hash BYTEA NOT NULL CHECK (octet_length(request_hash) = 32),
  response_json JSONB,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(actor_scope, client_mutation_id)
);
CREATE TABLE outbox_event (
  id UUID PRIMARY KEY,
  audit_event_id UUID NOT NULL UNIQUE REFERENCES audit_event(id) ON DELETE RESTRICT,
  commitment_payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'SUBMITTED', 'COMMITTED', 'FAILED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE ledger_submission (
  id UUID PRIMARY KEY,
  audit_event_id UUID NOT NULL REFERENCES audit_event(id) ON DELETE RESTRICT,
  network_id TEXT NOT NULL,
  transaction_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('QUEUED', 'SUBMITTED', 'COMMITTED', 'FAILED')),
  submitted_at TIMESTAMPTZ,
  committed_at TIMESTAMPTZ,
  receipt_ref TEXT,
  UNIQUE(network_id, audit_event_id)
);
CREATE TABLE qr_record (
  id UUID PRIMARY KEY,
  public_token_hash BYTEA NOT NULL UNIQUE,
  material_batch_id UUID NOT NULL REFERENCES material_batch(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED')),
  rotated_from_id UUID REFERENCES qr_record(id) ON DELETE RESTRICT
);
CREATE TABLE evidence_reference (
  id UUID PRIMARY KEY,
  storage_key TEXT NOT NULL UNIQUE,
  content_hash BYTEA NOT NULL CHECK (octet_length(content_hash) = 32),
  media_type TEXT NOT NULL,
  classification TEXT NOT NULL,
  uploaded_by_party_id UUID NOT NULL REFERENCES party(id) ON DELETE RESTRICT,
  captured_at TIMESTAMPTZ,
  retention_state TEXT NOT NULL
);

CREATE OR REPLACE FUNCTION reject_immutable_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only or immutable', TG_TABLE_NAME USING ERRCODE = '55000';
END $$;
CREATE FUNCTION reject_immutable_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END $$;

CREATE TRIGGER material_measurement_immutable BEFORE UPDATE ON material_measurement FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER material_measurement_no_delete BEFORE DELETE ON material_measurement FOR EACH ROW EXECUTE FUNCTION reject_immutable_delete();
CREATE TRIGGER measurement_review_no_update BEFORE UPDATE ON measurement_review_event FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER measurement_review_no_delete BEFORE DELETE ON measurement_review_event FOR EACH ROW EXECUTE FUNCTION reject_immutable_delete();
CREATE TRIGGER allocation_review_no_update BEFORE UPDATE ON allocation_set_review_event FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER allocation_review_no_delete BEFORE DELETE ON allocation_set_review_event FOR EACH ROW EXECUTE FUNCTION reject_immutable_delete();
CREATE TRIGGER commercial_decision_no_update BEFORE UPDATE ON commercial_line_decision_event FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER commercial_decision_no_delete BEFORE DELETE ON commercial_line_decision_event FOR EACH ROW EXECUTE FUNCTION reject_immutable_delete();
CREATE TRIGGER payment_event_no_update BEFORE UPDATE ON payment_event FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER payment_event_no_delete BEFORE DELETE ON payment_event FOR EACH ROW EXECUTE FUNCTION reject_immutable_delete();
CREATE TRIGGER capture_ack_no_update BEFORE UPDATE ON capture_acknowledgement_event FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER capture_ack_no_delete BEFORE DELETE ON capture_acknowledgement_event FOR EACH ROW EXECUTE FUNCTION reject_immutable_delete();
CREATE TRIGGER audit_event_no_update BEFORE UPDATE ON audit_event FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER audit_event_no_delete BEFORE DELETE ON audit_event FOR EACH ROW EXECUTE FUNCTION reject_immutable_delete();
CREATE TRIGGER audit_stream_entry_no_update BEFORE UPDATE ON audit_stream_entry FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER audit_stream_entry_no_delete BEFORE DELETE ON audit_stream_entry FOR EACH ROW EXECUTE FUNCTION reject_immutable_delete();
CREATE TRIGGER idempotency_receipt_no_update BEFORE UPDATE ON idempotency_receipt FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER idempotency_receipt_no_delete BEFORE DELETE ON idempotency_receipt FOR EACH ROW EXECUTE FUNCTION reject_immutable_delete();
CREATE TRIGGER allocation_set_no_update BEFORE UPDATE ON production_allocation_set FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER allocation_set_no_delete BEFORE DELETE ON production_allocation_set FOR EACH ROW EXECUTE FUNCTION reject_immutable_delete();
CREATE TRIGGER allocation_row_no_update BEFORE UPDATE ON production_allocation_row FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER allocation_row_no_delete BEFORE DELETE ON production_allocation_row FOR EACH ROW EXECUTE FUNCTION reject_immutable_delete();

CREATE FUNCTION validate_allocation_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE chain_id UUID; selected_set UUID; selected_kind TEXT; selected_measurement UUID; selected_measurement_set UUID;
DECLARE output_id UUID; output_measurement_set UUID; latest_status TEXT; total_quantity NUMERIC(20,6); total_share NUMERIC(20,9); basis_quantity NUMERIC(20,6); row_count INTEGER;
DECLARE new_review_status TEXT; new_review_set UUID;
BEGIN
  IF TG_TABLE_NAME = 'production_allocation_chain' THEN
    chain_id := NEW.id;
  ELSIF TG_TABLE_NAME = 'production_allocation_set' THEN
    chain_id := NEW.allocation_chain_id;
  ELSIF TG_TABLE_NAME = 'production_allocation_row' THEN
    SELECT allocation_chain_id INTO chain_id FROM production_allocation_set WHERE id = NEW.allocation_set_id;
  ELSE
    SELECT allocation_chain_id INTO chain_id FROM production_allocation_set WHERE id = NEW.production_allocation_set_id;
    new_review_status := NEW.review_status;
    new_review_set := NEW.production_allocation_set_id;
  END IF;
  SELECT active_approved_set_id, production_event_output_id INTO selected_set, output_id FROM production_allocation_chain WHERE id = chain_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF new_review_status = 'APPROVED' AND selected_set IS DISTINCT FROM new_review_set THEN
    RAISE EXCEPTION 'the newly approved allocation revision must become the active revision in the same transaction' USING ERRCODE = '23514';
  END IF;
  IF selected_set IS NULL THEN RETURN NULL; END IF;
  SELECT basis_kind, basis_measurement_id, basis_measurement_set_id INTO selected_kind, selected_measurement, selected_measurement_set FROM production_allocation_set WHERE id = selected_set AND allocation_chain_id = chain_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'active allocation set belongs to a different chain' USING ERRCODE = '23503'; END IF;
  SELECT review_status INTO latest_status FROM allocation_set_review_event WHERE production_allocation_set_id = selected_set ORDER BY review_sequence DESC LIMIT 1;
  IF latest_status IS DISTINCT FROM 'APPROVED' THEN RAISE EXCEPTION 'active allocation set must be currently approved' USING ERRCODE = '23514'; END IF;
  SELECT count(*), COALESCE(sum(allocated_quantity_g),0), COALESCE(sum(allocated_share),0)
    INTO row_count, total_quantity, total_share FROM production_allocation_row WHERE allocation_set_id = selected_set;
  IF row_count = 0 THEN RAISE EXCEPTION 'an allocation set must contain at least one beneficiary row' USING ERRCODE = '23514'; END IF;
  IF selected_kind = 'SHARE' AND total_share > 1 THEN RAISE EXCEPTION 'allocation shares exceed 1.0' USING ERRCODE = '23514'; END IF;
  IF selected_kind = 'QUANTITY' THEN
    IF NOT EXISTS (
      SELECT 1 FROM material_measurement_set ms
      WHERE ms.id = selected_measurement_set AND ms.material_event_output_id = output_id
    ) THEN RAISE EXCEPTION 'quantity basis must belong to this output' USING ERRCODE = '23514'; END IF;
    SELECT quantity_g INTO basis_quantity FROM material_measurement WHERE id = selected_measurement AND measurement_set_id = selected_measurement_set;
    IF basis_quantity IS NULL OR total_quantity > basis_quantity THEN RAISE EXCEPTION 'allocation quantity exceeds its explicitly selected output observation' USING ERRCODE = '23514'; END IF;
    IF NOT EXISTS (SELECT 1 FROM allocation_set_review_event WHERE production_allocation_set_id = selected_set AND review_status = 'APPROVED' AND authorized_basis_measurement_id = selected_measurement) THEN
      RAISE EXCEPTION 'approval must authorize the set measurement basis' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER allocation_chain_validate_deferred AFTER INSERT OR UPDATE ON production_allocation_chain DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_allocation_chain();
CREATE CONSTRAINT TRIGGER allocation_rows_validate_deferred AFTER INSERT ON production_allocation_row DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_allocation_chain();
CREATE CONSTRAINT TRIGGER allocation_reviews_validate_deferred AFTER INSERT ON allocation_set_review_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_allocation_chain();

CREATE FUNCTION validate_allocation_review_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_sequence INTEGER; set_basis TEXT; set_measurement UUID; previous_status TEXT; chain_key UUID;
BEGIN
  SELECT allocation_chain_id INTO chain_key FROM production_allocation_set WHERE id=NEW.production_allocation_set_id;
  PERFORM 1 FROM production_allocation_chain WHERE id=chain_key FOR UPDATE;
  SELECT COALESCE(max(review_sequence), 0) + 1 INTO expected_sequence FROM allocation_set_review_event WHERE production_allocation_set_id = NEW.production_allocation_set_id;
  IF NEW.review_sequence <> expected_sequence THEN RAISE EXCEPTION 'allocation review sequence must be contiguous' USING ERRCODE = '23514'; END IF;
  SELECT basis_kind, basis_measurement_id INTO set_basis, set_measurement FROM production_allocation_set WHERE id = NEW.production_allocation_set_id;
  IF NEW.review_sequence = 1 AND NEW.review_status <> 'PENDING' THEN RAISE EXCEPTION 'first allocation review must be PENDING' USING ERRCODE = '23514'; END IF;
  IF NEW.review_status = 'APPROVED' AND set_basis = 'QUANTITY' AND NEW.authorized_basis_measurement_id IS DISTINCT FROM set_measurement THEN
    RAISE EXCEPTION 'approval must name the selected quantity observation' USING ERRCODE = '23514';
  END IF;
  IF NEW.review_status = 'APPROVED' AND set_basis = 'SHARE' AND NEW.authorized_basis_measurement_id IS NOT NULL THEN
    RAISE EXCEPTION 'share allocation approval cannot name a measurement basis' USING ERRCODE = '23514';
  END IF;
  SELECT review_status INTO previous_status FROM allocation_set_review_event WHERE production_allocation_set_id = NEW.production_allocation_set_id ORDER BY review_sequence DESC LIMIT 1;
  IF previous_status IN ('APPROVED', 'WITHDRAWN', 'REJECTED') THEN RAISE EXCEPTION 'terminal allocation review state requires a new revision' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER allocation_review_guard BEFORE INSERT ON allocation_set_review_event FOR EACH ROW EXECUTE FUNCTION validate_allocation_review_insert();

CREATE FUNCTION validate_allocation_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE predecessor_revision INTEGER;
BEGIN
  PERFORM 1 FROM production_allocation_chain WHERE id=NEW.allocation_chain_id FOR UPDATE;
  IF NEW.revision_kind = 'CORRECTION' THEN
    SELECT revision_no INTO predecessor_revision FROM production_allocation_set WHERE id = NEW.supersedes_set_id AND allocation_chain_id = NEW.allocation_chain_id;
    IF predecessor_revision IS NULL OR predecessor_revision + 1 <> NEW.revision_no THEN RAISE EXCEPTION 'allocation correction must name the immediately preceding revision in its chain' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER allocation_revision_guard BEFORE INSERT ON production_allocation_set FOR EACH ROW EXECUTE FUNCTION validate_allocation_revision();

CREATE FUNCTION validate_allocation_basis_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE output_id UUID;
BEGIN
  IF NEW.basis_kind='QUANTITY' THEN
    SELECT production_event_output_id INTO output_id FROM production_allocation_chain WHERE id=NEW.allocation_chain_id;
    IF NOT EXISTS (SELECT 1 FROM material_measurement_set WHERE id=NEW.basis_measurement_set_id AND material_event_output_id=output_id) THEN
      RAISE EXCEPTION 'allocation quantity basis must belong to its exact production output' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER allocation_basis_owner_guard BEFORE INSERT ON production_allocation_set FOR EACH ROW EXECUTE FUNCTION validate_allocation_basis_owner();

CREATE FUNCTION validate_allocation_has_rows() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE set_key UUID;
BEGIN
  IF TG_TABLE_NAME='production_allocation_set' THEN set_key := NEW.id; ELSE set_key := NEW.allocation_set_id; END IF;
  IF NOT EXISTS (SELECT 1 FROM production_allocation_row WHERE allocation_set_id=set_key) THEN RAISE EXCEPTION 'every allocation revision must include at least one beneficiary' USING ERRCODE = '23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER allocation_set_minimum_rows AFTER INSERT ON production_allocation_set DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_allocation_has_rows();
CREATE CONSTRAINT TRIGGER allocation_row_minimum_rows AFTER INSERT ON production_allocation_row DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_allocation_has_rows();

CREATE FUNCTION validate_measurement_set_owner_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.batch_id, NEW.material_event_input_id, NEW.material_event_output_id, NEW.gold_trade_line_id, NEW.residue_sale_line_id, NEW.consignment_item_id, NEW.consignment_stage, NEW.inventory_count_id)
     IS DISTINCT FROM ROW(OLD.batch_id, OLD.material_event_input_id, OLD.material_event_output_id, OLD.gold_trade_line_id, OLD.residue_sale_line_id, OLD.consignment_item_id, OLD.consignment_stage, OLD.inventory_count_id) THEN
    RAISE EXCEPTION 'measurement-set owner and batch are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER measurement_set_owner_immutable BEFORE UPDATE ON material_measurement_set FOR EACH ROW EXECUTE FUNCTION validate_measurement_set_owner_immutable();

CREATE FUNCTION reject_accepted_movement_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE movement_id UUID; movement_status TEXT;
BEGIN
  IF TG_TABLE_NAME = 'inventory_movement' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.current_status <> 'DRAFT' THEN RAISE EXCEPTION 'inventory movement must start as DRAFT' USING ERRCODE = '23514'; END IF;
      RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'inventory movement history cannot be deleted' USING ERRCODE = '55000'; END IF;
    movement_id := NEW.id;
    movement_status := OLD.current_status;
    IF movement_status <> 'DRAFT' THEN RAISE EXCEPTION 'non-draft inventory movement headers are immutable' USING ERRCODE = '55000'; END IF;
    IF movement_status <> NEW.current_status AND (movement_status <> 'DRAFT' OR NEW.current_status NOT IN ('ACCEPTED', 'REJECTED', 'VOIDED')) THEN
      RAISE EXCEPTION 'inventory movement status transition is invalid' USING ERRCODE = '23514';
    END IF;
  ELSE
    movement_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.inventory_movement_id ELSE NEW.inventory_movement_id END;
    SELECT current_status INTO movement_status FROM inventory_movement WHERE id = movement_id;
    IF movement_status <> 'DRAFT' THEN RAISE EXCEPTION 'non-draft inventory movement lines are immutable' USING ERRCODE = '55000'; END IF;
  END IF;
  IF movement_status = 'ACCEPTED' THEN RAISE EXCEPTION 'accepted inventory movements are append-only' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER accepted_movement_immutable BEFORE INSERT OR UPDATE OR DELETE ON inventory_movement FOR EACH ROW EXECUTE FUNCTION reject_accepted_movement_mutation();
CREATE TRIGGER accepted_movement_line_immutable BEFORE INSERT OR UPDATE OR DELETE ON inventory_movement_line FOR EACH ROW EXECUTE FUNCTION reject_accepted_movement_mutation();

CREATE FUNCTION validate_inventory_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE movement_id UUID; v_kind TEXT; v_status TEXT; v_event_id UUID; v_reversal_target UUID; line RECORD; pair RECORD;
DECLARE balance_value NUMERIC(20,6); measurement_quantity NUMERIC(20,6); expected_quantity NUMERIC(20,6);
DECLARE original_line RECORD; already_reversed NUMERIC(20,6); current_line RECORD; commercial RECORD;
BEGIN
  IF TG_TABLE_NAME = 'inventory_movement' THEN movement_id := NEW.id; ELSE movement_id := NEW.inventory_movement_id; END IF;
  SELECT movement_kind, current_status, event_id, reverses_movement_id INTO v_kind, v_status, v_event_id, v_reversal_target FROM inventory_movement WHERE id = movement_id;
  IF NOT FOUND OR v_status <> 'ACCEPTED' THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM inventory_movement_line WHERE inventory_movement_id = movement_id) THEN RAISE EXCEPTION 'accepted movement must contain lines' USING ERRCODE = '23514'; END IF;

  FOR commercial IN
    SELECT kind, parent_id FROM (
      SELECT DISTINCT 'GOLD_TRADE'::TEXT AS kind, t.trade_id AS parent_id FROM inventory_movement_line ml JOIN gold_trade_line t ON t.id=ml.gold_trade_line_id WHERE ml.inventory_movement_id=movement_id
      UNION
      SELECT DISTINCT 'RESIDUE_SALE'::TEXT AS kind, s.residue_sale_id AS parent_id FROM inventory_movement_line ml JOIN residue_sale_line s ON s.id=ml.residue_sale_line_id WHERE ml.inventory_movement_id=movement_id
    ) refs ORDER BY kind, parent_id
  LOOP
    IF commercial.kind = 'GOLD_TRADE' THEN
      PERFORM 1 FROM gold_trade WHERE id=commercial.parent_id FOR UPDATE;
      PERFORM 1 FROM gold_trade_line WHERE trade_id=commercial.parent_id ORDER BY batch_id,revision_no,id FOR UPDATE;
    ELSE
      PERFORM 1 FROM residue_sale WHERE id=commercial.parent_id FOR UPDATE;
      PERFORM 1 FROM residue_sale_line WHERE residue_sale_id=commercial.parent_id ORDER BY batch_id,revision_no,id FOR UPDATE;
    END IF;
  END LOOP;

  FOR line IN SELECT DISTINCT location_id, batch_id FROM inventory_movement_line WHERE inventory_movement_id = movement_id ORDER BY location_id, batch_id LOOP
    INSERT INTO inventory_balance_guard(location_id, batch_id) VALUES (line.location_id, line.batch_id) ON CONFLICT DO NOTHING;
    PERFORM 1 FROM inventory_balance_guard WHERE location_id = line.location_id AND batch_id = line.batch_id FOR UPDATE;
  END LOOP;

  IF v_kind = 'TRANSFER' THEN
    FOR pair IN SELECT batch_id, count(*) AS line_count,
      count(*) FILTER (WHERE direction = 'OUT') AS out_count,
      count(*) FILTER (WHERE direction = 'IN') AS in_count,
      sum(posted_quantity_g) FILTER (WHERE direction = 'OUT') AS out_g,
      sum(posted_quantity_g) FILTER (WHERE direction = 'IN') AS in_g,
      count(DISTINCT location_id) AS location_count,
      count(DISTINCT basis_measurement_id) AS measurement_count,
      count(DISTINCT basis_measurement_set_id) AS measurement_set_count
      FROM inventory_movement_line WHERE inventory_movement_id = movement_id GROUP BY batch_id LOOP
      IF pair.line_count <> 2 OR pair.out_count <> 1 OR pair.in_count <> 1 OR pair.location_count <> 2 OR pair.out_g <> pair.in_g OR pair.measurement_count <> 1 OR pair.measurement_set_count <> 1 THEN
        RAISE EXCEPTION 'transfer requires equal measured IN and OUT legs per batch at distinct locations' USING ERRCODE = '23514';
      END IF;
      SELECT ml.basis_measurement_set_id, ml.basis_measurement_id INTO line FROM inventory_movement_line ml WHERE ml.inventory_movement_id = movement_id AND ml.batch_id = pair.batch_id LIMIT 1;
      SELECT quantity_g INTO measurement_quantity FROM material_measurement WHERE id = line.basis_measurement_id AND measurement_set_id = line.basis_measurement_set_id;
      IF measurement_quantity IS NULL OR measurement_quantity <> pair.out_g THEN RAISE EXCEPTION 'transfer posting must equal its selected measurement' USING ERRCODE = '23514'; END IF;
      IF EXISTS (SELECT 1 FROM inventory_movement_line WHERE inventory_movement_id=movement_id AND batch_id=pair.batch_id AND consignment_item_id IS NOT NULL) AND
         ((SELECT count(*) FROM inventory_movement_line WHERE inventory_movement_id=movement_id AND batch_id=pair.batch_id AND consignment_item_id IS NOT NULL) <> 2 OR
          (SELECT count(DISTINCT consignment_item_id) FROM inventory_movement_line WHERE inventory_movement_id=movement_id AND batch_id=pair.batch_id) <> 1 OR
          (SELECT count(DISTINCT consignment_stage) FROM inventory_movement_line WHERE inventory_movement_id=movement_id AND batch_id=pair.batch_id) <> 1) THEN
        RAISE EXCEPTION 'consignment transfer must reference the same manifest item on both legs' USING ERRCODE = '23514';
      END IF;
      IF EXISTS (SELECT 1 FROM inventory_movement_line WHERE inventory_movement_id=movement_id AND batch_id=pair.batch_id AND material_event_input_id IS NOT NULL) AND
         EXISTS (SELECT 1 FROM inventory_movement_line WHERE inventory_movement_id=movement_id AND batch_id=pair.batch_id AND consignment_item_id IS NOT NULL) THEN
        RAISE EXCEPTION 'transfer cannot mix consignment and event reference modes' USING ERRCODE = '23514';
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM inventory_movement_line WHERE inventory_movement_id = movement_id AND material_event_input_id IS NOT NULL) THEN
      IF v_event_id IS NULL OR EXISTS (
        SELECT 1 FROM inventory_movement_line ml
        LEFT JOIN material_event_input i ON i.id = ml.material_event_input_id AND i.event_id = v_event_id AND i.batch_id = ml.batch_id
        LEFT JOIN material_event_output o ON o.id = ml.material_event_output_id AND o.event_id = v_event_id AND o.batch_id = ml.batch_id
        WHERE ml.inventory_movement_id = movement_id AND ((ml.direction = 'OUT' AND i.id IS NULL) OR (ml.direction = 'IN' AND o.id IS NULL))
      ) THEN RAISE EXCEPTION 'event transfer legs must reference matching event inputs and outputs' USING ERRCODE = '23514'; END IF;
    END IF;
    IF v_event_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM inventory_movement_line ml WHERE ml.inventory_movement_id=movement_id AND
        (ml.consignment_item_id IS NOT NULL OR
         (ml.direction='OUT' AND (ml.material_event_input_id IS NULL OR ml.material_event_output_id IS NOT NULL)) OR
         (ml.direction='IN' AND (ml.material_event_output_id IS NULL OR ml.material_event_input_id IS NOT NULL)))
    ) THEN RAISE EXCEPTION 'event transfers must use matching input and output references only' USING ERRCODE = '23514'; END IF;
    IF v_event_id IS NULL AND EXISTS (SELECT 1 FROM inventory_movement_line WHERE inventory_movement_id=movement_id AND consignment_item_id IS NOT NULL) AND EXISTS (
      SELECT 1 FROM inventory_movement_line ml WHERE ml.inventory_movement_id=movement_id AND (ml.material_event_input_id IS NOT NULL OR ml.material_event_output_id IS NOT NULL OR ml.consignment_item_id IS NULL OR ml.consignment_stage IS NULL)
    ) THEN RAISE EXCEPTION 'consignment transfers must use one typed consignment item and stage only' USING ERRCODE = '23514'; END IF;
    IF v_event_id IS NULL AND NOT EXISTS (SELECT 1 FROM inventory_movement_line WHERE inventory_movement_id=movement_id AND consignment_item_id IS NOT NULL) AND EXISTS (
      SELECT 1 FROM inventory_movement_line ml WHERE ml.inventory_movement_id=movement_id AND (ml.material_event_input_id IS NOT NULL OR ml.material_event_output_id IS NOT NULL)
    ) THEN RAISE EXCEPTION 'event transfer references require the parent material event' USING ERRCODE = '23514'; END IF;
    IF v_event_id IS NULL AND NOT EXISTS (SELECT 1 FROM inventory_movement_line WHERE inventory_movement_id=movement_id AND consignment_item_id IS NOT NULL) AND length(trim(COALESCE((SELECT reason FROM inventory_movement WHERE id=movement_id),'')))=0 THEN
      RAISE EXCEPTION 'uncontextualized transfer requires a reason' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM inventory_movement_line WHERE inventory_movement_id = movement_id AND gold_trade_line_id IS NOT NULL AND direction <> 'OUT') OR
       EXISTS (SELECT 1 FROM inventory_movement_line WHERE inventory_movement_id = movement_id AND residue_sale_line_id IS NOT NULL AND direction <> 'OUT') THEN
      RAISE EXCEPTION 'commercial references are allowed only on physical OUT lines' USING ERRCODE = '23514';
    END IF;
  ELSIF v_kind = 'TRANSFORMATION' THEN
    IF v_event_id IS NULL OR EXISTS (SELECT 1 FROM inventory_movement_line WHERE inventory_movement_id = movement_id AND ((direction = 'OUT' AND material_event_input_id IS NULL) OR (direction = 'IN' AND material_event_output_id IS NULL))) THEN
      RAISE EXCEPTION 'transformation lines must reference event inputs or outputs' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM inventory_movement_line ml
      LEFT JOIN material_event_input i ON i.id = ml.material_event_input_id AND i.event_id = v_event_id AND i.batch_id = ml.batch_id
      LEFT JOIN material_event_output o ON o.id = ml.material_event_output_id AND o.event_id = v_event_id AND o.batch_id = ml.batch_id
      WHERE ml.inventory_movement_id = movement_id AND ((ml.direction = 'OUT' AND i.id IS NULL) OR (ml.direction = 'IN' AND o.id IS NULL) OR (ml.direction = 'OUT' AND o.id IS NOT NULL) OR (ml.direction = 'IN' AND i.id IS NOT NULL))
    ) THEN RAISE EXCEPTION 'transformation line references must match this event and batch' USING ERRCODE = '23514'; END IF;
    IF EXISTS (
      SELECT 1 FROM inventory_movement_line ml
      JOIN material_measurement_set ms ON ms.id=ml.basis_measurement_set_id
      WHERE ml.inventory_movement_id=movement_id AND
        ((ml.direction='OUT' AND ms.material_event_input_id IS DISTINCT FROM ml.material_event_input_id) OR
         (ml.direction='IN' AND ms.material_event_output_id IS DISTINCT FROM ml.material_event_output_id))
    ) THEN RAISE EXCEPTION 'transformation measurement must belong to the exact input or output context' USING ERRCODE = '23514'; END IF;
    IF EXISTS (
      SELECT 1 FROM inventory_movement_line ml JOIN material_measurement mm ON mm.id=ml.basis_measurement_id
      WHERE ml.inventory_movement_id=movement_id AND mm.quantity_g <> ml.posted_quantity_g
    ) THEN RAISE EXCEPTION 'transformation line must equal its selected measurement' USING ERRCODE = '23514'; END IF;
  ELSIF v_kind = 'ADJUSTMENT' OR v_kind = 'OPENING_BALANCE' THEN
    IF EXISTS (SELECT 1 FROM inventory_movement_line WHERE inventory_movement_id = movement_id AND (inventory_count_id IS NULL OR basis_measurement_id IS NULL)) THEN
      RAISE EXCEPTION 'adjustments and opening balances require a physical count measurement' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM inventory_movement_line WHERE inventory_movement_id = movement_id AND
      ((v_kind='ADJUSTMENT' AND (consignment_item_id IS NOT NULL OR material_event_input_id IS NOT NULL OR material_event_output_id IS NOT NULL OR gold_trade_line_id IS NOT NULL OR residue_sale_line_id IS NOT NULL OR reverses_line_id IS NOT NULL)) OR
       (v_kind='OPENING_BALANCE' AND (direction <> 'IN' OR consignment_item_id IS NOT NULL OR material_event_input_id IS NOT NULL OR material_event_output_id IS NOT NULL OR gold_trade_line_id IS NOT NULL OR residue_sale_line_id IS NOT NULL OR reverses_line_id IS NOT NULL)))) THEN
      RAISE EXCEPTION 'adjustment/opening movement has an unsupported reference or direction' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM inventory_movement_line ml JOIN material_measurement mm ON mm.id=ml.basis_measurement_id
      WHERE ml.inventory_movement_id=movement_id AND mm.quantity_g IS NULL
    ) THEN RAISE EXCEPTION 'inventory count measurement is missing' USING ERRCODE = '23514'; END IF;
    IF v_kind = 'OPENING_BALANCE' AND EXISTS (
      SELECT 1 FROM inventory_movement_line ml JOIN material_measurement mm ON mm.id=ml.basis_measurement_id
      WHERE ml.inventory_movement_id=movement_id AND mm.quantity_g <> ml.posted_quantity_g
    ) THEN RAISE EXCEPTION 'opening balance must equal its count measurement' USING ERRCODE = '23514'; END IF;
  ELSIF v_kind = 'REVERSAL' THEN
    IF NOT EXISTS (SELECT 1 FROM inventory_movement WHERE id = v_reversal_target AND current_status = 'ACCEPTED') THEN RAISE EXCEPTION 'reversal target must be accepted' USING ERRCODE = '23514'; END IF;
    FOR current_line IN SELECT * FROM inventory_movement_line WHERE inventory_movement_id = movement_id LOOP
      SELECT * INTO original_line FROM inventory_movement_line WHERE id = current_line.reverses_line_id AND inventory_movement_id = v_reversal_target;
      IF NOT FOUND OR original_line.batch_id <> current_line.batch_id OR original_line.location_id <> current_line.location_id OR original_line.direction = current_line.direction THEN
        RAISE EXCEPTION 'reversal line must offset an exact line from the target movement' USING ERRCODE = '23514';
      END IF;
      SELECT COALESCE(sum(reversal.posted_quantity_g), 0) INTO already_reversed
        FROM inventory_movement_line reversal
        JOIN inventory_movement header ON header.id = reversal.inventory_movement_id AND header.current_status = 'ACCEPTED' AND header.movement_kind = 'REVERSAL'
        WHERE reversal.reverses_line_id = current_line.reverses_line_id AND reversal.inventory_movement_id <> movement_id;
      IF already_reversed + current_line.posted_quantity_g > original_line.posted_quantity_g THEN RAISE EXCEPTION 'reversals cannot exceed the original line' USING ERRCODE = '23514'; END IF;
    END LOOP;
  END IF;

  FOR line IN SELECT DISTINCT location_id, batch_id FROM inventory_movement_line WHERE inventory_movement_id = movement_id ORDER BY location_id, batch_id LOOP
    SELECT COALESCE(sum(CASE WHEN ml.direction = 'IN' THEN ml.posted_quantity_g ELSE -ml.posted_quantity_g END), 0)
      INTO balance_value FROM inventory_movement_line ml JOIN inventory_movement mh ON mh.id = ml.inventory_movement_id
      WHERE ml.location_id = line.location_id AND ml.batch_id = line.batch_id AND mh.current_status = 'ACCEPTED';
    IF balance_value < 0 THEN RAISE EXCEPTION 'inventory balance cannot become negative' USING ERRCODE = '23514'; END IF;
  END LOOP;

  FOR current_line IN SELECT * FROM inventory_movement_line WHERE inventory_movement_id = movement_id AND direction = 'OUT' LOOP
    IF current_line.gold_trade_line_id IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM gold_trade_line t WHERE t.id = current_line.gold_trade_line_id AND t.batch_id = current_line.batch_id AND t.is_accepted AND NOT EXISTS (SELECT 1 FROM gold_trade_line child WHERE child.supersedes_line_id = t.id)) THEN
        RAISE EXCEPTION 'outgoing movement must reference the current accepted gold-trade line for this batch' USING ERRCODE = '23514';
      END IF;
      WITH RECURSIVE line_chain(id, supersedes_line_id) AS (
        SELECT id, supersedes_line_id FROM gold_trade_line WHERE id=current_line.gold_trade_line_id
        UNION ALL SELECT previous.id, previous.supersedes_line_id FROM gold_trade_line previous JOIN line_chain child ON child.supersedes_line_id=previous.id
      ),
      posted_lines AS (
        SELECT ml.id, ml.direction, ml.posted_quantity_g FROM inventory_movement_line ml JOIN inventory_movement mh ON mh.id=ml.inventory_movement_id AND mh.current_status='ACCEPTED'
        WHERE ml.gold_trade_line_id IN (SELECT id FROM line_chain)
      ),
      reversed AS (
        SELECT ml.reverses_line_id, sum(ml.posted_quantity_g) AS quantity_g FROM inventory_movement_line ml JOIN inventory_movement mh ON mh.id=ml.inventory_movement_id AND mh.current_status='ACCEPTED' AND mh.movement_kind='REVERSAL'
        WHERE ml.reverses_line_id IN (SELECT id FROM posted_lines) GROUP BY ml.reverses_line_id
      )
      SELECT COALESCE(sum(CASE WHEN p.direction='OUT' THEN p.posted_quantity_g ELSE -p.posted_quantity_g END - COALESCE(r.quantity_g,0)),0)
        INTO expected_quantity FROM posted_lines p LEFT JOIN reversed r ON r.reverses_line_id=p.id;
      IF expected_quantity > (SELECT accepted_trade_quantity_g FROM gold_trade_line WHERE id = current_line.gold_trade_line_id) THEN RAISE EXCEPTION 'gold-trade outgoing quantity exceeds accepted quantity' USING ERRCODE = '23514'; END IF;
    END IF;
    IF current_line.residue_sale_line_id IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM residue_sale_line s WHERE s.id = current_line.residue_sale_line_id AND s.batch_id = current_line.batch_id AND s.is_accepted AND NOT EXISTS (SELECT 1 FROM residue_sale_line child WHERE child.supersedes_line_id = s.id)) THEN
        RAISE EXCEPTION 'outgoing movement must reference the current accepted residue-sale line for this batch' USING ERRCODE = '23514';
      END IF;
      WITH RECURSIVE line_chain(id, supersedes_line_id) AS (
        SELECT id, supersedes_line_id FROM residue_sale_line WHERE id=current_line.residue_sale_line_id
        UNION ALL SELECT previous.id, previous.supersedes_line_id FROM residue_sale_line previous JOIN line_chain child ON child.supersedes_line_id=previous.id
      ),
      posted_lines AS (
        SELECT ml.id, ml.direction, ml.posted_quantity_g FROM inventory_movement_line ml JOIN inventory_movement mh ON mh.id=ml.inventory_movement_id AND mh.current_status='ACCEPTED'
        WHERE ml.residue_sale_line_id IN (SELECT id FROM line_chain)
      ),
      reversed AS (
        SELECT ml.reverses_line_id, sum(ml.posted_quantity_g) AS quantity_g FROM inventory_movement_line ml JOIN inventory_movement mh ON mh.id=ml.inventory_movement_id AND mh.current_status='ACCEPTED' AND mh.movement_kind='REVERSAL'
        WHERE ml.reverses_line_id IN (SELECT id FROM posted_lines) GROUP BY ml.reverses_line_id
      )
      SELECT COALESCE(sum(CASE WHEN p.direction='OUT' THEN p.posted_quantity_g ELSE -p.posted_quantity_g END - COALESCE(r.quantity_g,0)),0)
        INTO expected_quantity FROM posted_lines p LEFT JOIN reversed r ON r.reverses_line_id=p.id;
      IF expected_quantity > (SELECT accepted_trade_quantity_g FROM residue_sale_line WHERE id = current_line.residue_sale_line_id) THEN RAISE EXCEPTION 'residue-sale outgoing quantity exceeds accepted quantity' USING ERRCODE = '23514'; END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER inventory_validate_header_deferred AFTER INSERT OR UPDATE ON inventory_movement DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_inventory_movement();
CREATE CONSTRAINT TRIGGER inventory_validate_line_deferred AFTER INSERT ON inventory_movement_line DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_inventory_movement();

CREATE FUNCTION validate_payment_counterparties() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_buyer UUID; expected_seller UUID;
BEGIN
  IF NEW.gold_trade_id IS NOT NULL THEN
    SELECT buyer_party_id, seller_party_id INTO expected_buyer, expected_seller FROM gold_trade WHERE id = NEW.gold_trade_id;
  ELSE
    SELECT buyer_party_id, seller_party_id INTO expected_buyer, expected_seller FROM residue_sale WHERE id = NEW.residue_sale_id;
  END IF;
  IF NOT ((NEW.payer_party_id = expected_buyer AND NEW.payee_party_id = expected_seller) OR (NEW.payer_party_id = expected_seller AND NEW.payee_party_id = expected_buyer)) THEN
    RAISE EXCEPTION 'payment payer and payee must be transaction counterparties' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_counterparty_guard BEFORE INSERT OR UPDATE ON payment FOR EACH ROW EXECUTE FUNCTION validate_payment_counterparties();

CREATE FUNCTION validate_movement_line_context() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE movement RECORD; count_quantity NUMERIC(20,6); current_balance NUMERIC(20,6); expected_delta NUMERIC(20,6); owner_ok BOOLEAN;
BEGIN
  SELECT * INTO movement FROM inventory_movement WHERE id = NEW.inventory_movement_id;
  IF NEW.gold_trade_line_id IS NOT NULL OR NEW.residue_sale_line_id IS NOT NULL THEN
    IF NEW.direction <> 'OUT' OR movement.movement_kind <> 'TRANSFER' THEN RAISE EXCEPTION 'commercial line references require TRANSFER OUT' USING ERRCODE = '23514'; END IF;
  END IF;
  IF NEW.reverses_line_id IS NOT NULL AND movement.movement_kind <> 'REVERSAL' THEN RAISE EXCEPTION 'line reversal reference requires REVERSAL movement' USING ERRCODE = '23514'; END IF;
  IF movement.movement_kind = 'REVERSAL' AND (NEW.reverses_line_id IS NULL OR NEW.basis_measurement_id IS NOT NULL OR NEW.inventory_count_id IS NOT NULL OR NEW.consignment_item_id IS NOT NULL OR NEW.consignment_stage IS NOT NULL OR NEW.material_event_input_id IS NOT NULL OR NEW.material_event_output_id IS NOT NULL OR NEW.gold_trade_line_id IS NOT NULL OR NEW.residue_sale_line_id IS NOT NULL) THEN
    RAISE EXCEPTION 'reversal lines require only the exact original-line reference' USING ERRCODE = '23514';
  END IF;
  IF movement.movement_kind IN ('ADJUSTMENT', 'OPENING_BALANCE') THEN
    IF NEW.basis_measurement_set_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM material_measurement_set ms JOIN inventory_count c ON c.id = ms.inventory_count_id
      WHERE ms.id = NEW.basis_measurement_set_id AND ms.inventory_count_id = NEW.inventory_count_id AND ms.batch_id = NEW.batch_id AND ms.inventory_count_id IS NOT NULL AND c.location_id = NEW.location_id AND c.batch_id = NEW.batch_id AND (movement.movement_kind <> 'OPENING_BALANCE' OR length(trim(COALESCE(c.evidence_ref,''))) > 0)
    ) THEN RAISE EXCEPTION 'adjustment/opening measurement must belong to a count of this batch at this location' USING ERRCODE = '23514'; END IF;
    SELECT quantity_g INTO count_quantity FROM material_measurement WHERE id = NEW.basis_measurement_id AND measurement_set_id = NEW.basis_measurement_set_id;
    IF movement.movement_kind = 'OPENING_BALANCE' AND (NEW.direction <> 'IN' OR count_quantity <> NEW.posted_quantity_g) THEN RAISE EXCEPTION 'opening balance must be a matching measured IN' USING ERRCODE = '23514'; END IF;
    IF movement.movement_kind = 'ADJUSTMENT' THEN
      SELECT COALESCE(sum(CASE WHEN ml.direction='IN' THEN ml.posted_quantity_g ELSE -ml.posted_quantity_g END),0) INTO current_balance
        FROM inventory_movement_line ml JOIN inventory_movement mh ON mh.id=ml.inventory_movement_id AND mh.current_status='ACCEPTED'
        WHERE ml.location_id=NEW.location_id AND ml.batch_id=NEW.batch_id;
      expected_delta := count_quantity - current_balance;
      IF expected_delta=0 OR abs(expected_delta) <> NEW.posted_quantity_g OR (expected_delta > 0 AND NEW.direction <> 'IN') OR (expected_delta < 0 AND NEW.direction <> 'OUT') THEN
        RAISE EXCEPTION 'adjustment must equal the signed variance from the measured count' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  IF NEW.basis_measurement_set_id IS NOT NULL AND movement.movement_kind IN ('TRANSFER','TRANSFORMATION') THEN
    SELECT CASE
      WHEN NEW.material_event_input_id IS NOT NULL THEN ms.material_event_input_id=NEW.material_event_input_id
      WHEN NEW.material_event_output_id IS NOT NULL THEN ms.material_event_output_id=NEW.material_event_output_id
      WHEN NEW.consignment_item_id IS NOT NULL THEN ms.consignment_item_id=NEW.consignment_item_id AND ms.consignment_stage=NEW.consignment_stage
      WHEN NEW.gold_trade_line_id IS NOT NULL THEN ms.gold_trade_line_id=NEW.gold_trade_line_id
      WHEN NEW.residue_sale_line_id IS NOT NULL THEN ms.residue_sale_line_id=NEW.residue_sale_line_id
      ELSE true END INTO owner_ok FROM material_measurement_set ms WHERE ms.id=NEW.basis_measurement_set_id AND ms.batch_id=NEW.batch_id;
    IF owner_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'movement measurement must belong to the exact referenced context and batch' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER movement_line_context_guard BEFORE INSERT ON inventory_movement_line FOR EACH ROW EXECUTE FUNCTION validate_movement_line_context();

CREATE FUNCTION validate_inventory_location_type() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE location_key UUID; location_type TEXT; subtype_count INTEGER;
BEGIN
  IF TG_TABLE_NAME='inventory_location' THEN location_key := NEW.id;
  ELSIF TG_TABLE_NAME='consignment' THEN location_key := NEW.transit_location_id;
  ELSE location_key := NEW.inventory_location_id; END IF;
  IF location_key IS NULL THEN RETURN NULL; END IF;
  SELECT location_kind INTO location_type FROM inventory_location WHERE id=location_key;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT (EXISTS(SELECT 1 FROM residue_stockpile WHERE inventory_location_id=location_key))::int +
         (EXISTS(SELECT 1 FROM consignment WHERE transit_location_id=location_key))::int +
         (EXISTS(SELECT 1 FROM recovery_inventory_location WHERE inventory_location_id=location_key))::int +
         (EXISTS(SELECT 1 FROM merchant_inventory_location WHERE inventory_location_id=location_key))::int
    INTO subtype_count;
  IF (location_type='STOCKPILE' AND (NOT EXISTS(SELECT 1 FROM residue_stockpile WHERE inventory_location_id=location_key) OR subtype_count<>1)) OR
     (location_type='CONSIGNMENT_TRANSIT' AND (NOT EXISTS(SELECT 1 FROM consignment WHERE transit_location_id=location_key) OR subtype_count<>1)) OR
     (location_type='RECOVERY_FACILITY' AND (NOT EXISTS(SELECT 1 FROM recovery_inventory_location WHERE inventory_location_id=location_key) OR subtype_count<>1)) OR
     (location_type='MERCHANT' AND (NOT EXISTS(SELECT 1 FROM merchant_inventory_location WHERE inventory_location_id=location_key) OR subtype_count<>1)) OR
     (location_type='OTHER' AND subtype_count<>0) THEN
    RAISE EXCEPTION 'inventory location kind must have exactly its matching typed subtype' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER inventory_location_type_deferred AFTER INSERT OR UPDATE ON inventory_location DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_inventory_location_type();
CREATE CONSTRAINT TRIGGER consignment_location_type_deferred AFTER INSERT OR UPDATE ON consignment DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_inventory_location_type();
CREATE CONSTRAINT TRIGGER stockpile_location_type_deferred AFTER INSERT OR UPDATE ON residue_stockpile DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_inventory_location_type();
CREATE CONSTRAINT TRIGGER recovery_location_type_deferred AFTER INSERT OR UPDATE ON recovery_inventory_location DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_inventory_location_type();
CREATE CONSTRAINT TRIGGER merchant_location_type_deferred AFTER INSERT OR UPDATE ON merchant_inventory_location DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_inventory_location_type();

CREATE FUNCTION validate_trade_line_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE predecessor RECORD; new_parent_id UUID;
BEGIN
  IF NEW.revision_kind = 'CORRECTION' THEN
    IF TG_TABLE_NAME = 'gold_trade_line' THEN
      new_parent_id := NEW.trade_id;
      SELECT trade_id, batch_id, revision_no INTO predecessor FROM gold_trade_line WHERE id = NEW.supersedes_line_id;
    ELSE
      new_parent_id := NEW.residue_sale_id;
      SELECT residue_sale_id AS trade_id, batch_id, revision_no INTO predecessor FROM residue_sale_line WHERE id = NEW.supersedes_line_id;
    END IF;
    IF predecessor.trade_id IS NULL OR predecessor.trade_id <> new_parent_id OR predecessor.batch_id <> NEW.batch_id OR predecessor.revision_no + 1 <> NEW.revision_no THEN
      RAISE EXCEPTION 'commercial corrections must stay in the same parent and batch and use the next revision' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER gold_trade_line_revision_guard BEFORE INSERT ON gold_trade_line FOR EACH ROW EXECUTE FUNCTION validate_trade_line_revision();
CREATE TRIGGER residue_sale_line_revision_guard BEFORE INSERT ON residue_sale_line FOR EACH ROW EXECUTE FUNCTION validate_trade_line_revision();

CREATE FUNCTION validate_material_batch_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE batch_key UUID;
BEGIN
  IF TG_TABLE_NAME = 'material_batch' THEN batch_key := NEW.id; ELSE batch_key := NEW.batch_id; END IF;
  IF NOT EXISTS (SELECT 1 FROM material_event_output WHERE batch_id = batch_key) THEN
    RAISE EXCEPTION 'material batch must be sourced by a material-event output in the same transaction' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER material_batch_source_required AFTER INSERT ON material_batch DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_material_batch_source();
CREATE CONSTRAINT TRIGGER material_output_batch_source AFTER INSERT ON material_event_output DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_material_batch_source();

CREATE FUNCTION validate_inventory_kind_shape() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.movement_kind = 'OPENING_BALANCE' AND (NEW.event_id IS NOT NULL OR NEW.reverses_movement_id IS NOT NULL) THEN RAISE EXCEPTION 'opening balance cannot reference an event or reversal' USING ERRCODE = '23514'; END IF;
  IF NEW.movement_kind = 'ADJUSTMENT' AND (NEW.event_id IS NOT NULL OR NEW.reverses_movement_id IS NOT NULL) THEN RAISE EXCEPTION 'adjustment cannot reference an event or reversal' USING ERRCODE = '23514'; END IF;
  IF NEW.movement_kind = 'REVERSAL' AND NEW.event_id IS NOT NULL THEN RAISE EXCEPTION 'reversal cannot reference a material event' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_kind_shape_guard BEFORE INSERT OR UPDATE ON inventory_movement FOR EACH ROW EXECUTE FUNCTION validate_inventory_kind_shape();

CREATE FUNCTION validate_commercial_line_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER gold_trade_line_immutable BEFORE UPDATE OR DELETE ON gold_trade_line FOR EACH ROW EXECUTE FUNCTION validate_commercial_line_immutable();
CREATE TRIGGER residue_sale_line_immutable BEFORE UPDATE OR DELETE ON residue_sale_line FOR EACH ROW EXECUTE FUNCTION validate_commercial_line_immutable();

CREATE FUNCTION validate_commercial_line_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_id UUID; line_id UUID; chain_start UUID; batch_key UUID; is_current BOOLEAN; accepted_quantity NUMERIC(20,6); other_current BOOLEAN; net_quantity NUMERIC(20,6);
BEGIN
  IF TG_TABLE_NAME='gold_trade_line' THEN
    parent_id := NEW.trade_id; line_id := NEW.id; batch_key := NEW.batch_id; is_current := NEW.is_accepted; accepted_quantity := NEW.accepted_trade_quantity_g;
    chain_start := CASE WHEN TG_OP='INSERT' THEN NEW.supersedes_line_id ELSE line_id END;
    PERFORM 1 FROM gold_trade WHERE id=parent_id FOR UPDATE;
    PERFORM 1 FROM gold_trade_line WHERE trade_id=parent_id ORDER BY batch_id,revision_no,id FOR UPDATE;
    IF is_current THEN
      SELECT EXISTS(SELECT 1 FROM gold_trade_line WHERE trade_id=parent_id AND batch_id=batch_key AND id<>line_id AND is_accepted) INTO other_current;
      IF other_current THEN RAISE EXCEPTION 'only one current accepted gold-trade line is allowed per batch chain' USING ERRCODE = '23514'; END IF;
      WITH RECURSIVE line_chain(id,supersedes_line_id) AS (
        SELECT id,supersedes_line_id FROM gold_trade_line WHERE id=chain_start
        UNION ALL SELECT previous.id,previous.supersedes_line_id FROM gold_trade_line previous JOIN line_chain child ON child.supersedes_line_id=previous.id
      ),
      posted_lines AS (SELECT ml.id,ml.posted_quantity_g FROM inventory_movement_line ml JOIN inventory_movement mh ON mh.id=ml.inventory_movement_id AND mh.current_status='ACCEPTED' WHERE ml.gold_trade_line_id IN (SELECT id FROM line_chain)),
      reversed AS (SELECT ml.reverses_line_id,sum(ml.posted_quantity_g) AS quantity_g FROM inventory_movement_line ml JOIN inventory_movement mh ON mh.id=ml.inventory_movement_id AND mh.current_status='ACCEPTED' AND mh.movement_kind='REVERSAL' WHERE ml.reverses_line_id IN (SELECT id FROM posted_lines) GROUP BY ml.reverses_line_id)
      SELECT COALESCE(sum(p.posted_quantity_g-COALESCE(r.quantity_g,0)),0) INTO net_quantity FROM posted_lines p LEFT JOIN reversed r ON r.reverses_line_id=p.id;
    END IF;
  ELSE
    parent_id := NEW.residue_sale_id; line_id := NEW.id; batch_key := NEW.batch_id; is_current := NEW.is_accepted; accepted_quantity := NEW.accepted_trade_quantity_g;
    chain_start := CASE WHEN TG_OP='INSERT' THEN NEW.supersedes_line_id ELSE line_id END;
    PERFORM 1 FROM residue_sale WHERE id=parent_id FOR UPDATE;
    PERFORM 1 FROM residue_sale_line WHERE residue_sale_id=parent_id ORDER BY batch_id,revision_no,id FOR UPDATE;
    IF is_current THEN
      SELECT EXISTS(SELECT 1 FROM residue_sale_line WHERE residue_sale_id=parent_id AND batch_id=batch_key AND id<>line_id AND is_accepted) INTO other_current;
      IF other_current THEN RAISE EXCEPTION 'only one current accepted residue-sale line is allowed per batch chain' USING ERRCODE = '23514'; END IF;
      WITH RECURSIVE line_chain(id,supersedes_line_id) AS (
        SELECT id,supersedes_line_id FROM residue_sale_line WHERE id=chain_start
        UNION ALL SELECT previous.id,previous.supersedes_line_id FROM residue_sale_line previous JOIN line_chain child ON child.supersedes_line_id=previous.id
      ),
      posted_lines AS (SELECT ml.id,ml.posted_quantity_g FROM inventory_movement_line ml JOIN inventory_movement mh ON mh.id=ml.inventory_movement_id AND mh.current_status='ACCEPTED' WHERE ml.residue_sale_line_id IN (SELECT id FROM line_chain)),
      reversed AS (SELECT ml.reverses_line_id,sum(ml.posted_quantity_g) AS quantity_g FROM inventory_movement_line ml JOIN inventory_movement mh ON mh.id=ml.inventory_movement_id AND mh.current_status='ACCEPTED' AND mh.movement_kind='REVERSAL' WHERE ml.reverses_line_id IN (SELECT id FROM posted_lines) GROUP BY ml.reverses_line_id)
      SELECT COALESCE(sum(p.posted_quantity_g-COALESCE(r.quantity_g,0)),0) INTO net_quantity FROM posted_lines p LEFT JOIN reversed r ON r.reverses_line_id=p.id;
    END IF;
  END IF;
  IF is_current AND (accepted_quantity IS NULL OR net_quantity > accepted_quantity) THEN RAISE EXCEPTION 'accepted commercial quantity cannot be below net physical outgoing movement' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER gold_trade_line_acceptance_guard BEFORE INSERT OR UPDATE ON gold_trade_line FOR EACH ROW EXECUTE FUNCTION validate_commercial_line_acceptance();
CREATE TRIGGER residue_sale_line_acceptance_guard BEFORE INSERT OR UPDATE ON residue_sale_line FOR EACH ROW EXECUTE FUNCTION validate_commercial_line_acceptance();

CREATE FUNCTION validate_commercial_measurement_set() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line_key UUID; line_table TEXT;
BEGIN
  IF TG_TABLE_NAME='gold_trade_line' THEN line_key := NEW.id; line_table := 'gold_trade_line';
  ELSIF TG_TABLE_NAME='residue_sale_line' THEN line_key := NEW.id; line_table := 'residue_sale_line';
  ELSIF NEW.gold_trade_line_id IS NOT NULL THEN line_key := NEW.gold_trade_line_id; line_table := 'gold_trade_line';
  ELSIF NEW.residue_sale_line_id IS NOT NULL THEN line_key := NEW.residue_sale_line_id; line_table := 'residue_sale_line';
  ELSE RETURN NULL; END IF;
  IF line_table='gold_trade_line' AND NOT EXISTS (SELECT 1 FROM material_measurement_set WHERE gold_trade_line_id=line_key) THEN RAISE EXCEPTION 'each gold-trade line revision needs its own measurement set' USING ERRCODE = '23514'; END IF;
  IF line_table='residue_sale_line' AND NOT EXISTS (SELECT 1 FROM material_measurement_set WHERE residue_sale_line_id=line_key) THEN RAISE EXCEPTION 'each residue-sale line revision needs its own measurement set' USING ERRCODE = '23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER gold_trade_line_measurement_required AFTER INSERT ON gold_trade_line DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_commercial_measurement_set();
CREATE CONSTRAINT TRIGGER residue_sale_line_measurement_required AFTER INSERT ON residue_sale_line DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_commercial_measurement_set();
CREATE CONSTRAINT TRIGGER trade_line_measurement_added AFTER INSERT ON material_measurement_set DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_commercial_measurement_set();

CREATE TABLE schema_foundation_marker (
  marker TEXT PRIMARY KEY,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO schema_foundation_marker(marker) VALUES ('sequelize-postgresql-foundation');
