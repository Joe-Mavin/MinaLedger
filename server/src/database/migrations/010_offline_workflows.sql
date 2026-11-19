ALTER TABLE sync_command_receipt
  DROP CONSTRAINT sync_command_receipt_command_type_check;

ALTER TABLE sync_command_receipt
  ADD CONSTRAINT sync_command_receipt_command_type_check CHECK (command_type IN (
    'production.create',
    'production.measurement.add',
    'capture.acknowledgement.add',
    'production.allocation.propose',
    'stockpile.transfer',
    'inventory.adjustment.create',
    'consignment.dispatch',
    'consignment.receipt.add',
    'consignment.receipt.correct',
    'consignment.custody.offer',
    'custody.transfer.decide',
    'gold_trade.assay.record',
    'gold_trade.measurement.add',
    'gold_trade.custody.offer'
  ));
