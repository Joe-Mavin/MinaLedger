CREATE TABLE audit_checkpoint (
  id UUID PRIMARY KEY,
  created_by_user_id UUID NOT NULL REFERENCES user_account(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL,
  creation_request_id TEXT NOT NULL,
  provenance JSONB NOT NULL,
  manifest_version INTEGER NOT NULL CHECK (manifest_version = 1),
  manifest_hash BYTEA NOT NULL CHECK (octet_length(manifest_hash) = 32),
  client_mutation_id UUID NOT NULL,
  request_hash BYTEA NOT NULL CHECK (octet_length(request_hash) = 32),
  UNIQUE (created_by_user_id, client_mutation_id)
);

CREATE TABLE audit_checkpoint_stream (
  checkpoint_id UUID NOT NULL REFERENCES audit_checkpoint(id) ON DELETE RESTRICT,
  stream_kind TEXT NOT NULL,
  stream_id UUID NOT NULL,
  sequence BIGINT NOT NULL CHECK (sequence >= 0),
  head_hash BYTEA NOT NULL CHECK (octet_length(head_hash) = 32),
  PRIMARY KEY (checkpoint_id, stream_kind, stream_id)
);

CREATE TABLE audit_checkpoint_outbox (
  id UUID PRIMARY KEY,
  checkpoint_id UUID NOT NULL UNIQUE REFERENCES audit_checkpoint(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','RETRY','VERIFIED','INVALID','FAILED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  last_result JSONB,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CHECK ((status = 'PROCESSING') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK (status NOT IN ('VERIFIED','INVALID','FAILED') OR (last_result IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX audit_checkpoint_outbox_ready_idx
  ON audit_checkpoint_outbox(status, next_attempt_at, created_at)
  WHERE status IN ('PENDING','RETRY','PROCESSING');

CREATE TABLE audit_checkpoint_verification (
  id UUID PRIMARY KEY,
  checkpoint_id UUID NOT NULL REFERENCES audit_checkpoint(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('VERIFIED','INVALID','RETRYABLE_FAILURE','FAILED')),
  result JSONB NOT NULL,
  error_code TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  UNIQUE (checkpoint_id, attempt_number)
);

CREATE TRIGGER audit_checkpoint_no_update BEFORE UPDATE ON audit_checkpoint FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER audit_checkpoint_no_delete BEFORE DELETE ON audit_checkpoint FOR EACH ROW EXECUTE FUNCTION reject_immutable_delete();
CREATE TRIGGER audit_checkpoint_stream_no_update BEFORE UPDATE ON audit_checkpoint_stream FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER audit_checkpoint_stream_no_delete BEFORE DELETE ON audit_checkpoint_stream FOR EACH ROW EXECUTE FUNCTION reject_immutable_delete();
CREATE TRIGGER audit_checkpoint_verification_no_update BEFORE UPDATE ON audit_checkpoint_verification FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();
CREATE TRIGGER audit_checkpoint_verification_no_delete BEFORE DELETE ON audit_checkpoint_verification FOR EACH ROW EXECUTE FUNCTION reject_immutable_delete();

CREATE FUNCTION guard_audit_checkpoint_outbox_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.checkpoint_id <> OLD.checkpoint_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'audit checkpoint outbox identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status IN ('VERIFIED','INVALID','FAILED') THEN
    RAISE EXCEPTION 'terminal audit checkpoint outbox state is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.attempt_count < OLD.attempt_count THEN
    RAISE EXCEPTION 'audit checkpoint attempt count cannot decrease' USING ERRCODE = '55000';
  END IF;
  IF NEW.status = 'PROCESSING' THEN
    IF NEW.attempt_count <> OLD.attempt_count + 1 OR NEW.lease_token IS NULL OR NEW.lease_expires_at IS NULL THEN
      RAISE EXCEPTION 'claiming audit checkpoint work requires a new attempt and lease' USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'PROCESSING' AND OLD.lease_expires_at > clock_timestamp() THEN
      RAISE EXCEPTION 'audit checkpoint work lease has not expired' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.status IN ('RETRY','VERIFIED','INVALID','FAILED') THEN
    IF OLD.status <> 'PROCESSING' OR NEW.attempt_count <> OLD.attempt_count
       OR NEW.lease_token IS NOT NULL OR NEW.lease_expires_at IS NOT NULL THEN
      RAISE EXCEPTION 'audit checkpoint result requires an active processing lease' USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'invalid audit checkpoint outbox transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER audit_checkpoint_outbox_update_guard BEFORE UPDATE ON audit_checkpoint_outbox
  FOR EACH ROW EXECUTE FUNCTION guard_audit_checkpoint_outbox_update();
CREATE TRIGGER audit_checkpoint_outbox_no_delete BEFORE DELETE ON audit_checkpoint_outbox
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_delete();
