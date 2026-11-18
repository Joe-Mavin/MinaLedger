import { app } from './app.mjs';
import { env } from './config/env.mjs';
import { logger } from './config/logger.mjs';
import { sequelize } from './database/connection.mjs';

let server;
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'graceful shutdown started');
  if (server) await new Promise((resolve) => server.close(resolve));
  await sequelize.close();
  process.exitCode = 0;
}

try {
  await sequelize.authenticate();
  server = app.listen(env.PORT, () => logger.info({ port: env.PORT, environment: env.NODE_ENV }, 'MinaLedger API listening'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
} catch (error) {
  logger.fatal({ err: error }, 'server startup failed');
  await sequelize.close();
  process.exitCode = 1;
}
