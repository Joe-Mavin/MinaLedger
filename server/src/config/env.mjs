import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']).optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().url(),
  TEST_DATABASE_URL: z.string().url().optional(),
  DATABASE_SSL: z.enum(['disable', 'require']).optional(),
  RUNTIME_DATABASE_USER: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/).optional(),
  JWT_SECRET: z.string().min(32).optional(),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10).default(10),
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(900_000).max(86_400_000).default(900_000),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
}).superRefine((config, context) => {
  if (config.NODE_ENV === 'production' && config.JWT_SECRET && /^(replace|change[-_]?me|example)/i.test(config.JWT_SECRET)) {
    context.addIssue({ code: 'custom', path: ['JWT_SECRET'], message: 'A generated JWT secret is required in production.' });
  }
  if (config.NODE_ENV === 'production' && config.DATABASE_SSL === 'disable' && (config.APP_ENV ?? config.NODE_ENV) !== 'staging') {
    context.addIssue({ code: 'custom', path: ['DATABASE_SSL'], message: 'Disabling database TLS is permitted only for isolated staging.' });
  }
});

const result = schema.safeParse(process.env);
if (!result.success) {
  const fields = result.error.issues.map((issue) => issue.path.join('.')).join(', ');
  throw new Error(`Invalid environment configuration: ${fields}`);
}

export const env = Object.freeze({
  ...result.data,
  APP_ENV: result.data.APP_ENV ?? result.data.NODE_ENV,
  DATABASE_SSL: result.data.DATABASE_SSL ?? (result.data.NODE_ENV === 'production' ? 'require' : 'disable'),
});
