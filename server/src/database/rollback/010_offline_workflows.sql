DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM sync_command_receipt
    WHERE command_type NOT IN ('production.create', 'production.measurement.add', 'capture.acknowledgement.add')
  ) THEN
    RAISE EXCEPTION 'cannot roll back offline workflow command types while matching sync receipts exist';
  END IF;
END;
$$;

ALTER TABLE sync_command_receipt
  DROP CONSTRAINT sync_command_receipt_command_type_check;

ALTER TABLE sync_command_receipt
  ADD CONSTRAINT sync_command_receipt_command_type_check CHECK (command_type IN (
    'production.create',
    'production.measurement.add',
    'capture.acknowledgement.add'
  ));
