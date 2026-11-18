import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { env } from './config/env.mjs';
import { logger } from './config/logger.mjs';
import { sequelize } from './database/connection.mjs';
import { authenticate, canAccessSite, hasRole, requirePilotFieldOfficer, requireSiteAccess, requireSystemAdministrator } from './middleware/auth.mjs';
import { login, getProfile, createAccount, createOrganisation, addRoleAssignment, revokeRoleAssignment } from './modules/identity/identity.service.mjs';
import { createSite, listSites, getSite, updateSite, createHole, listHoles, createParticipant, listParticipants } from './modules/mining-sites/site.service.mjs';
import { createProductionEvent, addOutputMeasurement, listProductionEvents, getProductionEvent } from './modules/production/production.service.mjs';
import { AppError, errorHandler, validateBody } from './utils/errors.mjs';

const decimal = (places) => z.string().regex(new RegExp(`^(0|[1-9][0-9]*)(\\.[0-9]{1,${places}})?$`));
const dateTime = z.string().datetime({ offset: true });
const loginSchema = z.object({ email: z.string().email().max(320), password: z.string().min(1).max(128) }).strict();
const accountSchema = z.object({ email: z.string().email().max(320), displayName: z.string().trim().min(1).max(160), password: z.string().min(12).max(72), organisationPartyId: z.string().uuid().optional() }).strict();
const organisationSchema = z.object({ displayName: z.string().trim().min(1).max(160), organisationKind: z.string().trim().min(1).max(40) }).strict();
const roleSchema = z.object({ roleCode: z.enum(['SYSTEM_ADMIN', 'FIELD_OFFICER', 'MINING_OPERATOR', 'MINER', 'DORA_OPERATOR', 'RECOVERY_FACILITY_OPERATOR', 'LOCAL_MERCHANT', 'LARGER_MERCHANT', 'AUDITOR']), scopeKind: z.enum(['GLOBAL', 'PILOT', 'ORGANISATION', 'SITE', 'HOLE', 'FACILITY']), scopeId: z.string().min(1).max(80) }).strict();
const siteSchema = z.object({ siteCode: z.string().trim().min(1).max(80), name: z.string().trim().min(1).max(160), countyCode: z.string().max(80).optional(), locality: z.string().max(160).optional() }).strict();
const sitePatchSchema = z.object({ name: z.string().trim().min(1).max(160).optional(), countyCode: z.string().max(80).nullable().optional(), locality: z.string().max(160).nullable().optional() }).strict().refine((value) => Object.keys(value).length > 0, 'At least one permitted site field must be supplied.');
const holeSchema = z.object({ holeCode: z.string().trim().min(1).max(80), name: z.string().trim().max(160).optional() }).strict();
const siteRole = z.enum(['LANDOWNER', 'PERMIT_HOLDER', 'SITE_OPERATOR', 'MINER', 'BENEFICIARY', 'FIELD_RECORDER', 'OTHER']);
const holeRole = z.enum(['HOLE_OPERATOR', 'MINER', 'BENEFICIARY', 'FIELD_RECORDER', 'OTHER']);
const participantKinds = z.enum(['MINER', 'MINING_OPERATOR', 'LANDOWNER', 'PERMIT_HOLDER', 'DORA_OPERATOR', 'RECOVERY_FACILITY', 'LOCAL_MERCHANT', 'LARGER_MERCHANT', 'CARRIER', 'FIELD_OFFICER', 'AUDITOR', 'OTHER']);
const participantSchema = z.object({
  partyKind: z.enum(['PERSON', 'ORGANISATION']),
  displayName: z.string().trim().min(1).max(160),
  organisationKind: z.string().trim().min(1).max(40).optional(),
  participantKind: participantKinds,
  roleCode: z.union([siteRole, holeRole]),
  holeId: z.string().uuid().optional(),
}).strict().superRefine((value, context) => {
  if (value.partyKind === 'ORGANISATION' && !value.organisationKind) context.addIssue({ code: 'custom', path: ['organisationKind'], message: 'organisationKind is required for organisation parties.' });
  if (value.holeId && !holeRole.safeParse(value.roleCode).success) context.addIssue({ code: 'custom', path: ['roleCode'], message: 'roleCode is not a hole role.' });
  if (!value.holeId && !siteRole.safeParse(value.roleCode).success) context.addIssue({ code: 'custom', path: ['roleCode'], message: 'roleCode is not a site role.' });
}).transform((value) => ({ ...value, organisationKind: value.organisationKind ?? null }));
const measurementSchema = z.object({
  kind: z.enum(['DECLARED', 'MEASURED', 'VERIFIED']),
  quantityGrams: decimal(6),
  sourceValue: decimal(12),
  sourceUnit: z.string().trim().min(1).max(20),
  conversionVersion: z.string().trim().min(1).max(40),
  sourceRole: z.enum(['SELLER', 'BUYER', 'RECORDER', 'WITNESS', 'WEIGHER', 'OTHER']),
  sourcePartyId: z.string().uuid().optional(),
  methodCode: z.string().max(80).optional(),
  instrumentRef: z.string().max(160).optional(),
  occurredAt: dateTime.optional(),
  evidenceRef: z.string().max(255).optional(),
}).strict();
const productionSchema = z.object({
  holeId: z.string().uuid(),
  occurredAt: dateTime,
  shiftOrPeriodRef: z.string().max(100).optional(),
  outputs: z.array(z.object({
    materialKind: z.enum(['GOLD_BEARING_FEED', 'RESIDUE', 'GOLD_DORE', 'RECOVERED_GOLD', 'PROCESS_OUTPUT']),
    outputKind: z.string().trim().min(1).max(40).optional(),
    measurements: z.array(measurementSchema).max(20).optional(),
  }).strict()).min(1).max(20),
}).strict();

function requireIdempotencyKey(req, res, next) {
  const key = req.get('idempotency-key');
  if (!key) return next(new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Provide an Idempotency-Key UUID for this command.'));
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) return next(new AppError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be a UUID.'));
  return next();
}

function requireUuidParams(...names) {
  return (req, res, next) => {
    for (const name of names) {
      if (!z.string().uuid().safeParse(req.params[name]).success) return next(new AppError(400, 'INVALID_ID', `${name} must be a UUID.`));
    }
    return next();
  };
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

export const app = express();
const allowedOrigins = env.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean);
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: allowedOrigins, credentials: false }));
app.use(express.json({ limit: '100kb', strict: true }));
app.use(pinoHttp({ logger, genReqId: (req) => req.get('x-request-id')?.slice(0, 100) || randomUUID(), autoLogging: { ignore: (req) => req.url === '/healthz' }, serializers: { req: (req) => ({ id: req.id, method: req.method, url: req.url }) } }));

app.get('/healthz', asyncRoute(async (req, res) => {
  await sequelize.query('SELECT 1');
  return res.status(200).json({ status: 'ok', database: 'connected', time: new Date().toISOString() });
}));
app.get('/api/v1/health', asyncRoute(async (req, res) => {
  await sequelize.query('SELECT 1');
  return res.status(200).json({ status: 'ok', database: 'connected' });
}));

app.post('/api/v1/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, handler: (req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many sign-in attempts. Try again later.', requestId: req.id } }) }), validateBody(loginSchema), asyncRoute(async (req, res) => {
  const result = await login(req.body.email, req.body.password);
  return res.status(200).json(result);
}));

app.use('/api/v1', authenticate);

app.get('/api/v1/me', asyncRoute(async (req, res) => res.json(await getProfile(req.auth.userId))));

app.post('/api/v1/admin/users', requireSystemAdministrator, requireIdempotencyKey, validateBody(accountSchema), asyncRoute(async (req, res) => {
  const account = await createAccount(req.body, req.auth.userId, req.get('idempotency-key'));
  return res.status(201).json(account);
}));
app.post('/api/v1/admin/organisations', requireSystemAdministrator, requireIdempotencyKey, validateBody(organisationSchema), asyncRoute(async (req, res) => {
  return res.status(201).json(await createOrganisation(req.body, req.auth.userId, req.get('idempotency-key')));
}));
app.post('/api/v1/admin/users/:userId/roles', requireSystemAdministrator, requireUuidParams('userId'), requireIdempotencyKey, validateBody(roleSchema), asyncRoute(async (req, res) => {
  return res.status(201).json(await addRoleAssignment({ userId: req.params.userId, ...req.body }, req.auth.userId, req.get('idempotency-key')));
}));
app.post('/api/v1/admin/role-assignments/:assignmentId/revoke', requireSystemAdministrator, requireUuidParams('assignmentId'), requireIdempotencyKey, asyncRoute(async (req, res) => {
  return res.status(200).json(await revokeRoleAssignment(req.params.assignmentId, req.auth.userId, req.get('idempotency-key')));
}));

app.get('/api/v1/sites', asyncRoute(async (req, res) => res.json(await listSites(req.auth))));
app.post('/api/v1/sites', requirePilotFieldOfficer, requireIdempotencyKey, validateBody(siteSchema), asyncRoute(async (req, res) => {
  return res.status(201).json(await createSite(req.body, req.auth, req.get('idempotency-key')));
}));
app.get('/api/v1/sites/:siteId', requireUuidParams('siteId'), asyncRoute(async (req, res, next) => {
  if (!(await canAccessSite(req.auth, req.params.siteId))) return next(new AppError(403, 'FORBIDDEN', 'You do not have access to this mining site.'));
  return res.json(await getSite(req.params.siteId));
}));
app.patch('/api/v1/sites/:siteId', requireUuidParams('siteId'), requireSiteAccess, requireIdempotencyKey, validateBody(sitePatchSchema), asyncRoute(async (req, res) => {
  return res.json(await updateSite(req.params.siteId, req.body, req.auth, req.get('idempotency-key')));
}));
app.get('/api/v1/sites/:siteId/holes', requireUuidParams('siteId'), requireSiteAccess, asyncRoute(async (req, res) => res.json(await listHoles(req.params.siteId))));
app.post('/api/v1/sites/:siteId/holes', requireUuidParams('siteId'), requireSiteAccess, requireIdempotencyKey, validateBody(holeSchema), asyncRoute(async (req, res) => {
  return res.status(201).json(await createHole(req.params.siteId, req.body, req.auth, req.get('idempotency-key')));
}));
app.get('/api/v1/sites/:siteId/participants', requireUuidParams('siteId'), requireSiteAccess, asyncRoute(async (req, res) => res.json(await listParticipants(req.params.siteId))));
app.post('/api/v1/sites/:siteId/participants', requireUuidParams('siteId'), requireSiteAccess, requireIdempotencyKey, validateBody(participantSchema), asyncRoute(async (req, res) => {
  return res.status(201).json(await createParticipant(req.params.siteId, req.body, req.auth, req.get('idempotency-key')));
}));
app.get('/api/v1/sites/:siteId/production-events', requireUuidParams('siteId'), requireSiteAccess, asyncRoute(async (req, res) => res.json(await listProductionEvents(req.params.siteId))));
app.get('/api/v1/sites/:siteId/production-events/:eventId', requireUuidParams('siteId', 'eventId'), requireSiteAccess, asyncRoute(async (req, res) => res.json(await getProductionEvent(req.params.siteId, req.params.eventId))));
app.post('/api/v1/sites/:siteId/production-events', requireUuidParams('siteId'), requireSiteAccess, requireIdempotencyKey, validateBody(productionSchema), asyncRoute(async (req, res) => {
  return res.status(201).json(await createProductionEvent(req.params.siteId, req.body, req.auth, req.get('idempotency-key')));
}));
app.post('/api/v1/sites/:siteId/production-events/:eventId/outputs/:outputId/measurements', requireUuidParams('siteId', 'eventId', 'outputId'), requireSiteAccess, requireIdempotencyKey, validateBody(measurementSchema), asyncRoute(async (req, res) => {
  const input = { ...req.body, occurredAt: req.body.occurredAt ?? new Date().toISOString() };
  return res.status(201).json(await addOutputMeasurement(req.params.siteId, req.params.eventId, req.params.outputId, input, req.auth, req.get('idempotency-key')));
}));

app.use((req, res, next) => next(new AppError(404, 'NOT_FOUND', 'The requested endpoint was not found.')));
app.use(errorHandler);

