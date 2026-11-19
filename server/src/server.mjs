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
  let shutdownTimer;
  let shutdownFailed = false;
  try {
    if (server) {
      const serverClosed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeIdleConnections?.();
      shutdownTimer = setTimeout(() => {
        logger.error({ signal }, 'shutdown deadline reached; closing active connections');
        server.closeAllConnections?.();
      }, env.SHUTDOWN_TIMEOUT_MS);
      shutdownTimer.unref();
      await serverClosed;
    }
  } catch (error) {
    logger.error({ signal, errorCode: error?.code ?? error?.name ?? 'SHUTDOWN_ERROR' }, 'graceful shutdown failed');
    shutdownFailed = true;
  } finally {
    if (shutdownTimer) clearTimeout(shutdownTimer);
  }
  try {
    await sequelize.close();
  } catch (error) {
    logger.error({ signal, errorCode: error?.code ?? error?.name ?? 'DATABASE_SHUTDOWN_ERROR' }, 'database shutdown failed');
    shutdownFailed = true;
  }
  if (shutdownFailed) process.exitCode = 1;
  else logger.info({ signal }, 'graceful shutdown complete');
}

try {
  if (!env.JWT_SECRET) throw new Error('JWT_SECRET is required for API startup.');
  await sequelize.authenticate();
  server = await new Promise((resolve, reject) => {
    const candidate = app.listen(env.PORT);
    candidate.once('error', reject);
    candidate.once('listening', () => {
      candidate.off('error', reject);
      resolve(candidate);
    });
  });
  logger.info({ port: env.PORT, environment: env.APP_ENV }, 'MinaLedger API listening');
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
} catch (error) {
  logger.fatal({ errorCode: error?.code ?? error?.name ?? 'STARTUP_ERROR' }, 'server startup failed');
  await sequelize.close().catch(() => {});
  process.exitCode = 1;
}
