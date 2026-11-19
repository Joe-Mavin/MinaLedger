CREATE TABLE sync_command_receipt (
  id UUID PRIMARY KEY,
  actor_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  client_mutation_id UUID NOT NULL,
  command_type TEXT NOT NULL CHECK (command_type IN ('production.create', 'production.measurement.add', 'capture.acknowledgement.add')),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  envelope JSONB NOT NULL,
  request_hash BYTEA NOT NULL CHECK (octet_length(request_hash) = 32),
  status TEXT NOT NULL CHECK (status IN ('SERVER_RECEIVED', 'NEEDS_REVIEW', 'SERVER_ACCEPTED', 'CONFLICT', 'REJECTED')),
  response_json JSONB,
  error_json JSONB,
  server_received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  UNIQUE(actor_user_id, client_mutation_id),
  UNIQUE(client_mutation_id),
  CHECK ((status = 'SERVER_RECEIVED' AND resolved_at IS NULL) OR (status <> 'SERVER_RECEIVED' AND resolved_at IS NOT NULL)),
  CHECK (status NOT IN ('NEEDS_REVIEW', 'SERVER_ACCEPTED') OR response_json IS NOT NULL)
);
CREATE INDEX sync_command_receipt_actor_state_idx ON sync_command_receipt(actor_user_id, status, server_received_at);

CREATE TABLE sync_command_receipt_history (
  id UUID PRIMARY KEY,
  receipt_id UUID NOT NULL REFERENCES sync_command_receipt(id) ON DELETE RESTRICT,
  from_status TEXT CHECK (from_status IN ('SERVER_RECEIVED', 'NEEDS_REVIEW', 'SERVER_ACCEPTED', 'CONFLICT', 'REJECTED')),
  to_status TEXT NOT NULL CHECK (to_status IN ('SERVER_RECEIVED', 'NEEDS_REVIEW', 'SERVER_ACCEPTED', 'CONFLICT', 'REJECTED')),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX sync_command_receipt_history_receipt_idx ON sync_command_receipt_history(receipt_id, recorded_at, id);

CREATE FUNCTION guard_sync_command_receipt_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.actor_user_id <> NEW.actor_user_id
     OR OLD.client_mutation_id <> NEW.client_mutation_id
     OR OLD.command_type <> NEW.command_type
     OR OLD.schema_version <> NEW.schema_version
     OR OLD.envelope <> NEW.envelope
     OR OLD.request_hash <> NEW.request_hash
     OR OLD.server_received_at <> NEW.server_received_at THEN
    RAISE EXCEPTION 'sync command envelope is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'SERVER_RECEIVED' OR NEW.status = 'SERVER_RECEIVED' THEN
    RAISE EXCEPTION 'sync receipt can only transition once from SERVER_RECEIVED' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sync_command_receipt_update_guard BEFORE UPDATE ON sync_command_receipt
FOR EACH ROW EXECUTE FUNCTION guard_sync_command_receipt_update();

CREATE FUNCTION reject_sync_receipt_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'sync receipt history is append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER sync_receipt_history_immutable BEFORE UPDATE OR DELETE ON sync_command_receipt_history
FOR EACH ROW EXECUTE FUNCTION reject_sync_receipt_history_mutation();
