import jwt from 'jsonwebtoken';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../database/connection.mjs';
import { env } from '../config/env.mjs';
import { AppError } from '../utils/errors.mjs';

export async function authenticate(req, res, next) {
  const header = req.get('authorization');
  if (!header?.startsWith('Bearer ')) return next(new AppError(401, 'AUTH_REQUIRED', 'Sign in is required.'));
  try {
    const claims = jwt.verify(header.slice(7), env.JWT_SECRET, { issuer: 'minaledger-api', audience: 'minaledger-client' });
    const rows = await sequelize.query(
      `SELECT u.id AS user_id, u.person_party_id, u.status AS account_status, p.status AS party_status
       FROM user_account u JOIN party p ON p.id = u.person_party_id
       WHERE u.id = :userId`,
      { replacements: { userId: claims.sub }, type: QueryTypes.SELECT },
    );
    const account = rows[0];
    if (!account || account.account_status !== 'ACTIVE' || account.party_status !== 'ACTIVE') {
      return next(new AppError(401, 'ACCOUNT_INACTIVE', 'This account is unavailable.'));
    }
    const roles = await sequelize.query(
      `SELECT role_code, scope_kind, scope_id FROM role_assignment
       WHERE user_id = :userId AND status = 'ACTIVE' AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())`,
      { replacements: { userId: account.user_id }, type: QueryTypes.SELECT },
    );
    req.auth = { userId: account.user_id, personPartyId: account.person_party_id, roles };
    return next();
  } catch (error) {
    if (error instanceof AppError) return next(error);
    return next(new AppError(401, 'INVALID_TOKEN', 'The access token is invalid or expired.'));
  }
}

export function hasRole(auth, roleCode, scopeKind, scopeId) {
  return auth.roles.some((role) => role.role_code === roleCode && role.scope_kind === scopeKind && (scopeId === undefined || role.scope_id === String(scopeId)));
}

export function requireSystemAdministrator(req, res, next) {
  const allowed = req.auth?.roles.some((role) => role.role_code === 'SYSTEM_ADMIN' && role.scope_kind === 'GLOBAL' && role.scope_id === 'global');
  if (!allowed) return next(new AppError(403, 'FORBIDDEN', 'This action requires an active system-administration grant.'));
  return next();
}

const SITE_READ_ROLES = ['FIELD_OFFICER', 'MINING_OPERATOR', 'MINER', 'AUDITOR'];
const RESOURCE_WRITE_ROLES = ['FIELD_OFFICER', 'MINING_OPERATOR'];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function accessRoleCodes(write) {
  return write ? RESOURCE_WRITE_ROLES : SITE_READ_ROLES;
}

async function hasActiveOrganisationMembership(auth, organisationId) {
  if (!UUID_PATTERN.test(String(organisationId))) return false;
  const memberships = await sequelize.query(
    `SELECT 1 FROM organisation_membership om JOIN user_account u ON u.person_party_id=om.person_party_id
     WHERE u.id=:userId AND om.organisation_party_id=:organisationId AND om.status='ACTIVE'
       AND om.valid_from<=now() AND (om.valid_to IS NULL OR om.valid_to>now()) LIMIT 1`,
    { replacements: { userId: auth.userId, organisationId }, type: QueryTypes.SELECT },
  );
  return memberships.length > 0;
}

async function hasActiveSiteOrganisationRelationship(siteId, organisationId) {
  const relationships = await sequelize.query(
    `SELECT 1 FROM site_party_role
     WHERE site_id=:siteId AND party_id=:organisationId AND status='ACTIVE'
       AND valid_from<=now() AND (valid_to IS NULL OR valid_to>now()) LIMIT 1`,
    { replacements: { siteId, organisationId }, type: QueryTypes.SELECT },
  );
  return relationships.length > 0;
}

export async function canAccessSite(auth, siteId, { write = false } = {}) {
  const roleCodes = accessRoleCodes(write);
  if (auth.roles.some((role) => role.role_code === 'FIELD_OFFICER' && role.scope_kind === 'PILOT' && role.scope_id === 'default')) return true;
  if (auth.roles.some((role) => roleCodes.includes(role.role_code) && role.scope_kind === 'SITE' && role.scope_id === String(siteId))) return true;

  for (const role of auth.roles.filter((item) => roleCodes.includes(item.role_code) && item.scope_kind === 'ORGANISATION')) {
    if (!(await hasActiveOrganisationMembership(auth, role.scope_id))) continue;
    if (await hasActiveSiteOrganisationRelationship(siteId, role.scope_id)) return true;
  }
  return false;
}

export async function canAccessHole(auth, siteId, holeId, { write = false } = {}) {
  const holes = await sequelize.query(
    `SELECT 1 FROM mining_hole WHERE id=:holeId AND site_id=:siteId LIMIT 1`,
    { replacements: { holeId, siteId }, type: QueryTypes.SELECT },
  );
  if (!holes.length) return false;
  if (await canAccessSite(auth, siteId, { write })) return true;

  const roleCodes = accessRoleCodes(write);
  if (auth.roles.some((role) => roleCodes.includes(role.role_code) && role.scope_kind === 'HOLE' && role.scope_id === String(holeId))) return true;

  for (const role of auth.roles.filter((item) => roleCodes.includes(item.role_code) && item.scope_kind === 'ORGANISATION')) {
    if (!(await hasActiveOrganisationMembership(auth, role.scope_id))) continue;
    if (!UUID_PATTERN.test(String(role.scope_id))) continue;
    const relationships = await sequelize.query(
      `SELECT 1 FROM hole_party_role
       WHERE hole_id=:holeId AND party_id=:organisationId AND status='ACTIVE'
         AND valid_from<=now() AND (valid_to IS NULL OR valid_to>now()) LIMIT 1`,
      { replacements: { holeId, organisationId: role.scope_id }, type: QueryTypes.SELECT },
    );
    if (relationships.length) return true;
  }
  return false;
}

export async function canAccessProcessingFacility(auth, facilityId, { write = false } = {}) {
  if (!UUID_PATTERN.test(String(facilityId))) return false;
  const scopedRoles = write ? ['DORA_OPERATOR'] : ['DORA_OPERATOR', 'AUDITOR'];
  if (auth.roles.some((role) => scopedRoles.includes(role.role_code) && role.scope_kind === 'FACILITY' && role.scope_id === String(facilityId))) return true;

  const relationshipRoles = write
    ? ['DORA_OPERATOR', 'FACILITY_OPERATOR', 'OPERATOR']
    : ['DORA_OPERATOR', 'FACILITY_OPERATOR', 'OPERATOR', 'AUDITOR'];
  const direct = await sequelize.query(
    `SELECT 1 FROM facility_party_role fpr
     WHERE fpr.processing_facility_id=:facilityId AND fpr.party_id=:partyId
       AND fpr.role_code IN (:relationshipRoles) AND fpr.status='ACTIVE'
       AND fpr.valid_from<=now() AND (fpr.valid_to IS NULL OR fpr.valid_to>now()) LIMIT 1`,
    { replacements: { facilityId, partyId: auth.personPartyId, relationshipRoles }, type: QueryTypes.SELECT },
  );
  if (direct.length) return true;

  for (const role of auth.roles.filter((item) => scopedRoles.includes(item.role_code) && item.scope_kind === 'ORGANISATION')) {
    if (!(await hasActiveOrganisationMembership(auth, role.scope_id))) continue;
    const affiliated = await sequelize.query(
      `SELECT 1 FROM facility_party_role fpr
       WHERE fpr.processing_facility_id=:facilityId AND fpr.party_id=:organisationId
         AND fpr.role_code IN (:relationshipRoles) AND fpr.status='ACTIVE'
         AND fpr.valid_from<=now() AND (fpr.valid_to IS NULL OR fpr.valid_to>now()) LIMIT 1`,
      { replacements: { facilityId, organisationId: role.scope_id, relationshipRoles }, type: QueryTypes.SELECT },
    );
    if (affiliated.length) return true;
  }
  return false;
}

export async function requireProcessingFacilityAccess(req, res, next) {
  try {
    const facilityId = req.params.facilityId ?? req.body?.processingFacilityId;
    const write = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    if (!(await canAccessProcessingFacility(req.auth, facilityId, { write }))) {
      return next(new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.'));
    }
    return next();
  } catch (error) { return next(error); }
}

export async function requireSiteAccess(req, res, next) {
  try {
    const write = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    if (!(await canAccessSite(req.auth, req.params.siteId, { write }))) return next(new AppError(403, 'FORBIDDEN', 'You do not have access to this mining site.'));
    return next();
  } catch (error) { return next(error); }
}

export async function requireHoleAccess(req, res, next) {
  try {
    const write = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    if (!(await canAccessHole(req.auth, req.params.siteId, req.params.holeId, { write }))) {
      return next(new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.'));
    }
    return next();
  } catch (error) { return next(error); }
}

export async function requireParticipantWriteAccess(req, res, next) {
  try {
    if (await canAccessSite(req.auth, req.params.siteId, { write: true })) return next();
    if (req.body.holeId && await canAccessHole(req.auth, req.params.siteId, req.body.holeId, { write: true })) return next();
    return next(new AppError(403, 'FORBIDDEN', 'You do not have access to associate a participant with this resource.'));
  } catch (error) { return next(error); }
}

export async function requireProductionHoleAccess(req, res, next) {
  try {
    if (await canAccessSite(req.auth, req.params.siteId, { write: true })) return next();
    if (!(await canAccessHole(req.auth, req.params.siteId, req.body.holeId, { write: true }))) {
      return next(new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.'));
    }
    return next();
  } catch (error) { return next(error); }
}

export async function requireProductionEventAccess(req, res, next) {
  try {
    const write = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    const [event] = await sequelize.query(
      `SELECT pe.hole_id FROM production_event pe JOIN mining_hole h ON h.id=pe.hole_id
       WHERE pe.event_id=:eventId AND h.site_id=:siteId LIMIT 1`,
      { replacements: { eventId: req.params.eventId, siteId: req.params.siteId }, type: QueryTypes.SELECT },
    );
    if (!event || !(await canAccessHole(req.auth, req.params.siteId, event.hole_id, { write }))) {
      return next(new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.'));
    }
    req.authorizedHoleId = event.hole_id;
    return next();
  } catch (error) { return next(error); }
}

export function requirePilotFieldOfficer(req, res, next) {
  if (!hasRole(req.auth, 'FIELD_OFFICER', 'PILOT', 'default')) return next(new AppError(403, 'FORBIDDEN', 'This action requires a pilot-scoped field-officer grant.'));
  return next();
}
