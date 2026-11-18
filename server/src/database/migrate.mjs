import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { QueryTypes } from 'sequelize';
import { sequelize } from './connection.mjs';
import { logger } from '../config/logger.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(directory, 'migrations');

export async function runMigrations(db = sequelize) {
  await db.authenticate();
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migration (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const files = (await readdir(migrationsDirectory)).filter((name) => name.endsWith('.sql')).sort();
  const applied = await db.query('SELECT name FROM schema_migration', { type: QueryTypes.SELECT });
  const known = new Set(applied.map((row) => row.name));

  for (const name of files) {
    if (known.has(name)) continue;
    const sql = await readFile(path.join(migrationsDirectory, name), 'utf8');
    await db.transaction(async (transaction) => {
      await db.query(sql, { transaction, raw: true });
      await db.query('INSERT INTO schema_migration(name) VALUES (:name)', { replacements: { name }, transaction });
    });
    logger.info({ migration: name }, 'database migration applied');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMigrations()
    .then(() => sequelize.close())
    .catch(async (error) => {
      logger.error({ name: error.name, message: error.message, code: error.original?.code }, 'database migrations failed');
      await sequelize.close();
      process.exitCode = 1;
    });
}
