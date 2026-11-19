import { env } from '../config/env.mjs';
import { sequelize } from './connection.mjs';

if (!env.RUNTIME_DATABASE_USER) throw new Error('RUNTIME_DATABASE_USER is required to grant staging application permissions.');
const role = `"${env.RUNTIME_DATABASE_USER}"`;

try {
  const [database] = await sequelize.query('SELECT current_database() AS name');
  const databaseName = database[0].name;
  if (!/^[a-zA-Z0-9_]+$/.test(databaseName)) throw new Error('Database name contains unsupported characters.');
  const databaseIdentifier = `"${databaseName}"`;
  await sequelize.query(`GRANT CONNECT ON DATABASE ${databaseIdentifier} TO ${role}`);
  await sequelize.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  await sequelize.query(`GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ${role}`);
  await sequelize.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
  await sequelize.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO ${role}`);
  await sequelize.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${role}`);
} finally {
  await sequelize.close();
}
