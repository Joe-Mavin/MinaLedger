DROP TRIGGER IF EXISTS sync_receipt_history_immutable ON sync_command_receipt_history;
DROP TRIGGER IF EXISTS sync_command_receipt_update_guard ON sync_command_receipt;
DROP FUNCTION IF EXISTS reject_sync_receipt_history_mutation();
DROP FUNCTION IF EXISTS guard_sync_command_receipt_update();
DROP TABLE IF EXISTS sync_command_receipt_history;
DROP TABLE IF EXISTS sync_command_receipt;
