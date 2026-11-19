import { setTimeout as delay } from 'node:timers/promises';
import { sequelize } from '../database/connection.mjs';
import { logger } from '../config/logger.mjs';
import { processAuditCheckpoint } from '../modules/audit/checkpoint.service.mjs';

let stopping = false;
process.once('SIGINT', () => { stopping = true; });
process.once('SIGTERM', () => { stopping = true; });

try {
  logger.info({}, 'audit checkpoint worker started');
  while (!stopping) {
    const result = await processAuditCheckpoint();
    if (!result.processed) await delay(1_000);
  }
} catch (error) {
  logger.error({ errorCode: error?.code ?? error?.name ?? 'WORKER_ERROR' }, 'audit checkpoint worker stopped after an unexpected error');
  process.exitCode = 1;
} finally {
  logger.info({}, 'audit checkpoint worker stopping');
  await sequelize.close();
}
