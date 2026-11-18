import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../database/connection.mjs';
import { env } from '../../config/env.mjs';
import { AppError } from '../../utils/errors.mjs';
import { appendAuditEvent } from '../audit/audit.service.mjs';
import { executeIdempotent } from '../commands/idempotency.service.mjs';

const unknownAccountHash = await bcrypt.hash(randomUUID(), 12);

export async function login(email, password) {
  const rows = await sequelize.query(
    `SELECT u.id, u.person_party_id, u.password_hash, u.status, p.status AS party_status, pp.display_name
     FROM user_account u JOIN party p ON p.id = u.person_party_id JOIN person_profile pp ON pp.party_id = p.id
     WHERE u.email = :email`,
    { replacements: { email: email.toLowerCase() }, type: QueryTypes.SELECT },
  );
  const account = rows[0];
  const passwordMatches = await bcrypt.compare(password, account?.password_hash ?? unknownAccountHash);
  if (!account || account.status !== 'ACTIVE' || account.party_status !== 'ACTIVE' || !passwordMatches) throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
  const token = jwt.sign({}, env.JWT_SECRET, {
    subject: account.id,
    issuer: 'minaledger-api',
    audience: 'minaledger-client',
    expiresIn: '15m',
    jwtid: randomUUID(),
  });
  const roles = await sequelize.query(
    `SELECT role_code, scope_kind, scope_id FROM role_assignment
     WHERE user_id = :userId AND status = 'ACTIVE' AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())`,
    { replacements: { userId: account.id }, type: QueryTypes.SELECT },
  );
  return { token, user: { id: account.id, personPartyId: account.person_party_id, displayName: account.display_name }, roles };
}

export async function getProfile(userId) {
  const [account] = await sequelize.query(
    `SELECT u.id, u.email, u.person_party_id, pp.display_name FROM user_account u
     JOIN person_profile pp ON pp.party_id = u.person_party_id WHERE u.id = :userId AND u.status = 'ACTIVE'`,
    { replacements: { userId }, type: QueryTypes.SELECT },
  );
  if (!account) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Account was not found.');
  const roles = await sequelize.query(
    `SELECT role_code, scope_kind, scope_id, valid_from, valid_to FROM role_assignment
     WHERE user_id = :userId AND status = 'ACTIVE' AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())
     ORDER BY role_code, scope_kind, scope_id`,
    { replacements: { userId }, type: QueryTypes.SELECT },
  );
  return { ...account, roles };
}

export async function createAccount({ email, displayName, password, organisationPartyId = null, roles = [] }, actorUserId, mutationId) {
  if (Buffer.byteLength(password, 'utf8') > 72) throw new AppError(400, 'INVALID_INPUT', 'Password must be at most 72 UTF-8 bytes.');
  const accountInput = { email, displayName, organisationPartyId, roles };
  return sequelize.transaction(async (transaction) => executeIdempotent({ actorScope: `user:${actorUserId}`, mutationId, payload: { action: 'identity.account.create', input: { ...accountInput, password } }, transaction }, async () => {
    const partyId = randomUUID();
    const userId = randomUUID();
    const passwordHash = await bcrypt.hash(password, 12);
    await sequelize.query(`INSERT INTO party(id, party_kind) VALUES (:id, 'PERSON')`, { replacements: { id: partyId }, transaction });
    await sequelize.query(`INSERT INTO person_profile(party_id, display_name) VALUES (:partyId, :displayName)`, { replacements: { partyId, displayName: displayName.trim() }, transaction });
    await sequelize.query(`INSERT INTO user_account(id, person_party_id, email, password_hash) VALUES (:userId, :partyId, :email, :passwordHash)`, { replacements: { userId, partyId, email: email.toLowerCase(), passwordHash }, transaction });
    if (organisationPartyId) {
      await sequelize.query(
        `INSERT INTO organisation_membership(id, person_party_id, organisation_party_id, membership_type) VALUES (:id, :partyId, :organisationPartyId, 'MEMBER')`,
        { replacements: { id: randomUUID(), partyId, organisationPartyId }, transaction },
      );
    }
    for (const role of roles) {
      await validateRoleScope(role, userId, partyId, transaction);
      await sequelize.query(
        `INSERT INTO role_assignment(id, user_id, role_code, scope_kind, scope_id, granted_by_user_id)
         VALUES (:id, :userId, :roleCode, :scopeKind, :scopeId, :grantedBy)`,
        { replacements: { id: randomUUID(), userId, roleCode: role.roleCode, scopeKind: role.scopeKind, scopeId: role.scopeId, grantedBy: actorUserId }, transaction },
      );
    }
    await appendAuditEvent({
      transaction, eventType: 'IDENTITY.ACCOUNT_CREATED', actorUserId, actorPartyId: null,
      occurredAt: new Date(), payload: { user_id: userId, organization_membership_created: Boolean(organisationPartyId), role_count: roles.length },
      streams: [{ kind: 'user_account', id: userId }],
    });
    return { id: userId, personPartyId: partyId, email: email.toLowerCase(), displayName: displayName.trim() };
  }));
}

export async function createOrganisation({ displayName, organisationKind }, actorUserId, mutationId) {
  return sequelize.transaction(async (transaction) => executeIdempotent({ actorScope: `user:${actorUserId}`, mutationId, payload: { action: 'organisation.create', displayName, organisationKind }, transaction }, async () => {
    const partyId = randomUUID();
    await sequelize.query(`INSERT INTO party(id, party_kind) VALUES (:partyId, 'ORGANISATION')`, { replacements: { partyId }, transaction });
    await sequelize.query(`INSERT INTO organisation_profile(party_id, display_name, organisation_kind) VALUES (:partyId, :displayName, :kind)`, { replacements: { partyId, displayName: displayName.trim(), kind: organisationKind }, transaction });
    await appendAuditEvent({ transaction, eventType: 'ORGANISATION.CREATED', actorUserId, actorPartyId: null, occurredAt: new Date(), payload: { party_id: partyId, organisation_kind: organisationKind }, streams: [{ kind: 'party', id: partyId }] });
    return { partyId, displayName: displayName.trim(), organisationKind };
  }));
}

async function validateRoleScope(role, targetUserId, personPartyId, transaction) {
  const { roleCode, scopeKind, scopeId } = role;
  if (roleCode === 'SYSTEM_ADMIN' && (scopeKind !== 'GLOBAL' || scopeId !== 'global')) throw new AppError(400, 'INVALID_ROLE_SCOPE', 'System-administration grants must use the global scope.');
  if (scopeKind === 'GLOBAL' && roleCode !== 'SYSTEM_ADMIN') throw new AppError(400, 'INVALID_ROLE_SCOPE', 'Only system-administration grants may use global scope.');
  if (scopeKind === 'PILOT' && (roleCode !== 'FIELD_OFFICER' || scopeId !== 'default')) throw new AppError(400, 'INVALID_ROLE_SCOPE', 'Pilot scope is available only to field officers in the default pilot.');
  if (scopeKind === 'ORGANISATION') {
    const memberships = await sequelize.query(
      `SELECT 1 FROM organisation_membership WHERE person_party_id=:personPartyId AND organisation_party_id=CAST(:scopeId AS uuid) AND status='ACTIVE' LIMIT 1`,
      { replacements: { personPartyId, scopeId }, type: QueryTypes.SELECT, transaction },
    );
    if (!memberships.length) throw new AppError(400, 'INVALID_ROLE_SCOPE', 'The account must be an active member of the scoped organisation.');
  }
  if (scopeKind === 'SITE') {
    const rows = await sequelize.query(`SELECT 1 FROM mining_site WHERE id=CAST(:scopeId AS uuid)`, { replacements: { scopeId }, type: QueryTypes.SELECT, transaction });
    if (!rows.length) throw new AppError(400, 'INVALID_ROLE_SCOPE', 'The scoped mining site does not exist.');
  }
  if (scopeKind === 'HOLE') {
    const rows = await sequelize.query(`SELECT 1 FROM mining_hole WHERE id=CAST(:scopeId AS uuid)`, { replacements: { scopeId }, type: QueryTypes.SELECT, transaction });
    if (!rows.length) throw new AppError(400, 'INVALID_ROLE_SCOPE', 'The scoped mining hole does not exist.');
  }
  if (scopeKind === 'FACILITY') {
    const rows = await sequelize.query(`SELECT 1 FROM processing_facility WHERE id=:scopeId::uuid UNION ALL SELECT 1 FROM recovery_facility WHERE id=:scopeId::uuid LIMIT 1`, { replacements: { scopeId }, type: QueryTypes.SELECT, transaction });
    if (!rows.length) throw new AppError(400, 'INVALID_ROLE_SCOPE', 'The scoped facility does not exist.');
  }
  void targetUserId;
}

export async function addRoleAssignment({ userId, roleCode, scopeKind, scopeId }, grantedByUserId, mutationId) {
  return sequelize.transaction(async (transaction) => executeIdempotent({ actorScope: `user:${grantedByUserId}`, mutationId, payload: { action: 'identity.role.grant', userId, roleCode, scopeKind, scopeId: String(scopeId) }, transaction }, async () => {
    const [target] = await sequelize.query(`SELECT person_party_id FROM user_account WHERE id=:userId AND status='ACTIVE' FOR UPDATE`, { replacements: { userId }, type: QueryTypes.SELECT, transaction });
    if (!target) throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'Account was not found.');
    const role = { roleCode, scopeKind, scopeId: String(scopeId) };
    await validateRoleScope(role, userId, target.person_party_id, transaction);
    const id = randomUUID();
    await sequelize.query(`INSERT INTO role_assignment(id, user_id, role_code, scope_kind, scope_id, granted_by_user_id) VALUES (:id,:userId,:roleCode,:scopeKind,:scopeId,:grantedBy)`, { replacements: { id, userId, roleCode, scopeKind, scopeId: String(scopeId), grantedBy: grantedByUserId }, transaction });
    await appendAuditEvent({ transaction, eventType: 'IDENTITY.ROLE_GRANTED', actorUserId: grantedByUserId, actorPartyId: null, occurredAt: new Date(), payload: { user_id: userId, role_code: roleCode, scope_kind: scopeKind, scope_id: String(scopeId) }, streams: [{ kind: 'user_account', id: userId }] });
    return { id, userId, roleCode, scopeKind, scopeId: String(scopeId) };
  }));
}

export async function revokeRoleAssignment(assignmentId, actorUserId, mutationId) {
  return sequelize.transaction(async (transaction) => executeIdempotent({ actorScope: `user:${actorUserId}`, mutationId, payload: { action: 'identity.role.revoke', assignmentId }, transaction }, async () => {
    const [assignment] = await sequelize.query(`SELECT id, user_id, role_code, scope_kind, scope_id, status FROM role_assignment WHERE id=:assignmentId FOR UPDATE`, { replacements: { assignmentId }, type: QueryTypes.SELECT, transaction });
    if (!assignment) throw new AppError(404, 'ROLE_ASSIGNMENT_NOT_FOUND', 'Role assignment was not found.');
    if (assignment.status !== 'ACTIVE') return assignment;
    await sequelize.query(`UPDATE role_assignment SET status='REVOKED', valid_to=now() WHERE id=:assignmentId`, { replacements: { assignmentId }, transaction });
    await appendAuditEvent({ transaction, eventType: 'IDENTITY.ROLE_REVOKED', actorUserId, actorPartyId: null, occurredAt: new Date(), payload: { user_id: assignment.user_id, role_code: assignment.role_code, scope_kind: assignment.scope_kind, scope_id: assignment.scope_id }, streams: [{ kind: 'user_account', id: assignment.user_id }] });
    return { ...assignment, status: 'REVOKED' };
  }));
}
