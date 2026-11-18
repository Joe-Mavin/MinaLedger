import { Sequelize } from 'sequelize';
import { env } from '../config/env.mjs';
import { logger } from '../config/logger.mjs';

export const sequelize = new Sequelize(env.DATABASE_URL, {
  dialect: 'postgres',
  logging: env.NODE_ENV === 'development' ? (message) => logger.debug({ sql: message }, 'database query') : false,
  pool: { max: 10, min: 0, acquire: 30000, idle: 10000 },
  define: { freezeTableName: true, underscored: true, timestamps: false },
  dialectOptions: env.NODE_ENV === 'production' ? { ssl: { require: true, rejectUnauthorized: true } } : {},
});

export async function assertDatabaseConnection() {
  await sequelize.authenticate();
}
