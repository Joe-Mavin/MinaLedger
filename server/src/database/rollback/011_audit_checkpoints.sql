DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM audit_checkpoint) THEN
    RAISE EXCEPTION 'cannot roll back audit checkpoints after checkpoint records have been created';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS audit_checkpoint_outbox_no_delete ON audit_checkpoint_outbox;
DROP TRIGGER IF EXISTS audit_checkpoint_outbox_update_guard ON audit_checkpoint_outbox;
DROP TRIGGER IF EXISTS audit_checkpoint_verification_no_delete ON audit_checkpoint_verification;
DROP TRIGGER IF EXISTS audit_checkpoint_verification_no_update ON audit_checkpoint_verification;
DROP TRIGGER IF EXISTS audit_checkpoint_stream_no_delete ON audit_checkpoint_stream;
DROP TRIGGER IF EXISTS audit_checkpoint_stream_no_update ON audit_checkpoint_stream;
DROP TRIGGER IF EXISTS audit_checkpoint_no_delete ON audit_checkpoint;
DROP TRIGGER IF EXISTS audit_checkpoint_no_update ON audit_checkpoint;
DROP FUNCTION IF EXISTS guard_audit_checkpoint_outbox_update();
DROP TABLE IF EXISTS audit_checkpoint_verification;
DROP TABLE IF EXISTS audit_checkpoint_outbox;
DROP TABLE IF EXISTS audit_checkpoint_stream;
DROP TABLE IF EXISTS audit_checkpoint;
