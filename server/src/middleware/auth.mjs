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

export async function canAccessSite(auth, siteId, { write = false } = {}) {
  const roleCodes = write ? ['FIELD_OFFICER', 'MINING_OPERATOR'] : ['FIELD_OFFICER', 'MINING_OPERATOR', 'MINER', 'AUDITOR'];
  if (auth.roles.some((role) => role.role_code === 'FIELD_OFFICER' && role.scope_kind === 'PILOT' && role.scope_id === 'default')) return true;
  const direct = auth.roles.some((role) => roleCodes.includes(role.role_code) && role.scope_kind === 'SITE' && role.scope_id === String(siteId));
  if (direct) return true;
  const holeIds = auth.roles.filter((role) => roleCodes.includes(role.role_code) && role.scope_kind === 'HOLE').map((role) => role.scope_id);
  if (holeIds.length) {
    const matches = await sequelize.query(
      `SELECT 1 FROM mining_hole WHERE site_id=:siteId AND id=ANY(CAST(:holeIds AS uuid[])) LIMIT 1`,
      { replacements: { siteId, holeIds }, type: QueryTypes.SELECT },
    );
    if (matches.length) return true;
  }
  for (const role of auth.roles.filter((item) => roleCodes.includes(item.role_code) && item.scope_kind === 'ORGANISATION')) {
    const membership = await sequelize.query(
      `SELECT 1 FROM organisation_membership om JOIN user_account u ON u.person_party_id=om.person_party_id
       WHERE u.id=:userId AND om.organisation_party_id=CAST(:organisationId AS uuid) AND om.status='ACTIVE'
         AND om.valid_from<=now() AND (om.valid_to IS NULL OR om.valid_to>now()) LIMIT 1`,
      { replacements: { userId: auth.userId, organisationId: role.scope_id }, type: QueryTypes.SELECT },
    );
    if (!membership.length) continue;
    const relationship = await sequelize.query(
      `SELECT 1 FROM site_party_role WHERE site_id=:siteId AND party_id=CAST(:organisationId AS uuid) AND status='ACTIVE'
         AND valid_from<=now() AND (valid_to IS NULL OR valid_to>now()) LIMIT 1`,
      { replacements: { siteId, organisationId: role.scope_id }, type: QueryTypes.SELECT },
    );
    if (relationship.length) return true;
  }
  return false;
}

export async function requireSiteAccess(req, res, next) {
  try {
    const write = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    if (!(await canAccessSite(req.auth, req.params.siteId, { write }))) return next(new AppError(403, 'FORBIDDEN', 'You do not have access to this mining site.'));
    return next();
  } catch (error) { return next(error); }
}

export function requirePilotFieldOfficer(req, res, next) {
  if (!hasRole(req.auth, 'FIELD_OFFICER', 'PILOT', 'default')) return next(new AppError(403, 'FORBIDDEN', 'This action requires a pilot-scoped field-officer grant.'));
  return next();
}
