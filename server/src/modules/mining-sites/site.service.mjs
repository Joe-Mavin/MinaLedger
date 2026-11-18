import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../database/connection.mjs';
import { MiningHole, MiningSite } from '../../database/models.mjs';
import { AppError } from '../../utils/errors.mjs';
import { canAccessHole, canAccessSite } from '../../middleware/auth.mjs';
import { appendAuditEvent } from '../audit/audit.service.mjs';
import { executeIdempotent } from '../commands/idempotency.service.mjs';

export async function createSite(input, auth, mutationId) {
  return sequelize.transaction(async (transaction) => executeIdempotent({ actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'site.create', input }, transaction }, async () => {
    const site = await MiningSite.create({
      id: randomUUID(), siteCode: input.siteCode.trim(), name: input.name.trim(), countyCode: input.countyCode ?? null,
      locality: input.locality ?? null, createdByUserId: auth.userId,
    }, { transaction });
    await appendAuditEvent({
      transaction, eventType: 'MINING_SITE.CREATED', actorUserId: auth.userId, actorPartyId: auth.personPartyId,
      occurredAt: new Date(), clientMutationId: mutationId,
      payload: { site_id: site.id, site_code: site.siteCode }, streams: [{ kind: 'mining_site', id: site.id }],
    });
    return { id: site.id, siteCode: site.siteCode, name: site.name, countyCode: site.countyCode, locality: site.locality, status: site.status };
  }));
}

export async function listSites(auth) {
  const sites = await MiningSite.findAll({ order: [['createdAt', 'DESC']], attributes: ['id', 'siteCode', 'name', 'countyCode', 'locality', 'status', 'createdAt'] });
  const visible = [];
  for (const site of sites) if (await canAccessSite(auth, site.id)) visible.push(site);
  return visible;
}

export async function getSite(siteId) {
  const site = await MiningSite.findByPk(siteId, { attributes: ['id', 'siteCode', 'name', 'countyCode', 'locality', 'status', 'createdAt'] });
  if (!site) throw new AppError(404, 'SITE_NOT_FOUND', 'Mining site was not found.');
  return site;
}

export async function updateSite(siteId, input, auth, mutationId) {
  return sequelize.transaction(async (transaction) => executeIdempotent({ actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'site.update', siteId, input }, transaction }, async () => {
    const site = await MiningSite.findByPk(siteId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!site) throw new AppError(404, 'SITE_NOT_FOUND', 'Mining site was not found.');
    const update = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
    await site.update(update, { transaction, fields: Object.keys(update) });
    await appendAuditEvent({ transaction, eventType: 'MINING_SITE.UPDATED', actorUserId: auth.userId, actorPartyId: auth.personPartyId, occurredAt: new Date(), clientMutationId: mutationId, payload: { site_id: siteId, changed_fields: Object.keys(update).sort() }, streams: [{ kind: 'mining_site', id: siteId }] });
    return { id: site.id, siteCode: site.siteCode, name: site.name, countyCode: site.countyCode, locality: site.locality, status: site.status };
  }));
}

export async function createHole(siteId, input, auth, mutationId) {
  return sequelize.transaction(async (transaction) => executeIdempotent({ actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'hole.create', siteId, input }, transaction }, async () => {
    const site = await MiningSite.findByPk(siteId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!site) throw new AppError(404, 'SITE_NOT_FOUND', 'Mining site was not found.');
    const hole = await MiningHole.create({ id: randomUUID(), siteId, holeCode: input.holeCode.trim(), name: input.name ?? null }, { transaction });
    await appendAuditEvent({
      transaction, eventType: 'MINING_HOLE.CREATED', actorUserId: auth.userId, actorPartyId: auth.personPartyId,
      occurredAt: new Date(), clientMutationId: mutationId,
      payload: { site_id: siteId, hole_id: hole.id, hole_code: hole.holeCode },
      streams: [{ kind: 'mining_site', id: siteId }, { kind: 'mining_hole', id: hole.id }],
    });
    return { id: hole.id, siteId, holeCode: hole.holeCode, name: hole.name, status: hole.status };
  }));
}

export async function listHoles(siteId, auth) {
  const holes = await MiningHole.findAll({ where: { siteId }, order: [['createdAt', 'ASC']], attributes: ['id', 'siteId', 'holeCode', 'name', 'status', 'createdAt'] });
  const visible = [];
  for (const hole of holes) if (await canAccessHole(auth, siteId, hole.id)) visible.push(hole);
  if (!visible.length && !(await canAccessSite(auth, siteId))) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  return visible;
}

export async function getHole(siteId, holeId, auth) {
  if (!(await canAccessHole(auth, siteId, holeId))) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  const hole = await MiningHole.findOne({ where: { id: holeId, siteId }, attributes: ['id', 'siteId', 'holeCode', 'name', 'status', 'createdAt'] });
  if (!hole) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  return hole;
}

export async function listHoleParticipants(siteId, holeId, auth) {
  if (!(await canAccessHole(auth, siteId, holeId))) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  return sequelize.query(
    `SELECT p.id AS party_id, p.party_kind, COALESCE(pp.display_name, op.display_name) AS display_name,
       hp.role_code, hp.valid_from, hp.valid_to, h.id AS hole_id
     FROM hole_party_role hp JOIN mining_hole h ON h.id=hp.hole_id JOIN party p ON p.id=hp.party_id
       LEFT JOIN person_profile pp ON pp.party_id=p.id LEFT JOIN organisation_profile op ON op.party_id=p.id
     WHERE h.id=:holeId AND h.site_id=:siteId AND hp.status='ACTIVE'
       AND hp.valid_from<=now() AND (hp.valid_to IS NULL OR hp.valid_to>now())
     ORDER BY display_name`,
    { replacements: { siteId, holeId }, type: QueryTypes.SELECT },
  );
}

export async function createParticipant(siteId, input, auth, mutationId) {
  return sequelize.transaction(async (transaction) => executeIdempotent({ actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'participant.create', siteId, input }, transaction }, async () => {
    const site = await MiningSite.findByPk(siteId, { transaction });
    if (!site) throw new AppError(404, 'SITE_NOT_FOUND', 'Mining site was not found.');
    if (input.holeId) {
      const hole = await MiningHole.findOne({ where: { id: input.holeId, siteId }, transaction });
      if (!hole) throw new AppError(400, 'INVALID_HOLE', 'The hole must belong to the selected mining site.');
    }
    const partyId = randomUUID();
    await sequelize.query(`INSERT INTO party(id, party_kind) VALUES (:partyId, :kind)`, { replacements: { partyId, kind: input.partyKind }, transaction });
    if (input.partyKind === 'PERSON') {
      await sequelize.query(`INSERT INTO person_profile(party_id, display_name) VALUES (:partyId, :displayName)`, { replacements: { partyId, displayName: input.displayName.trim() }, transaction });
    } else {
      await sequelize.query(`INSERT INTO organisation_profile(party_id, display_name, organisation_kind) VALUES (:partyId, :displayName, :kind)`, { replacements: { partyId, displayName: input.displayName.trim(), kind: input.organisationKind }, transaction });
    }
    await sequelize.query(`INSERT INTO party_participation(id, party_id, participant_kind) VALUES (:id, :partyId, :kind)`, { replacements: { id: randomUUID(), partyId, kind: input.participantKind }, transaction });
    if (input.holeId) {
      await sequelize.query(`INSERT INTO hole_party_role(id, hole_id, party_id, role_code, asserted_by_user_id) VALUES (:id, :holeId, :partyId, :roleCode, :userId)`, { replacements: { id: randomUUID(), holeId: input.holeId, partyId, roleCode: input.roleCode, userId: auth.userId }, transaction });
    } else {
      await sequelize.query(`INSERT INTO site_party_role(id, site_id, party_id, role_code, asserted_by_user_id) VALUES (:id, :siteId, :partyId, :roleCode, :userId)`, { replacements: { id: randomUUID(), siteId, partyId, roleCode: input.roleCode, userId: auth.userId }, transaction });
    }
    await appendAuditEvent({
      transaction, eventType: 'SITE_PARTICIPANT.ASSOCIATED', actorUserId: auth.userId, actorPartyId: auth.personPartyId,
      occurredAt: new Date(), clientMutationId: mutationId,
      payload: { site_id: siteId, participant_party_id: partyId, participant_kind: input.participantKind, role_code: input.roleCode, hole_id: input.holeId ?? null },
      streams: [{ kind: 'mining_site', id: siteId }, { kind: 'party', id: partyId }],
    });
    return { partyId, partyKind: input.partyKind, displayName: input.displayName.trim(), participantKind: input.participantKind, roleCode: input.roleCode, siteId, holeId: input.holeId ?? null };
  }));
}

export async function listParticipants(siteId) {
  return sequelize.query(
    `SELECT p.id AS party_id, p.party_kind, COALESCE(pp.display_name, op.display_name) AS display_name,
       pp_role.role_code, pp_role.valid_from, pp_role.valid_to, NULL::uuid AS hole_id
     FROM site_party_role pp_role JOIN party p ON p.id=pp_role.party_id
       LEFT JOIN person_profile pp ON pp.party_id=p.id LEFT JOIN organisation_profile op ON op.party_id=p.id
     WHERE pp_role.site_id=:siteId AND pp_role.status='ACTIVE'
     UNION ALL
     SELECT p.id, p.party_kind, COALESCE(pp.display_name, op.display_name), hp.role_code, hp.valid_from, hp.valid_to, h.id
     FROM hole_party_role hp JOIN mining_hole h ON h.id=hp.hole_id JOIN party p ON p.id=hp.party_id
       LEFT JOIN person_profile pp ON pp.party_id=p.id LEFT JOIN organisation_profile op ON op.party_id=p.id
     WHERE h.site_id=:siteId AND hp.status='ACTIVE' ORDER BY display_name`,
    { replacements: { siteId }, type: QueryTypes.SELECT },
  );
}
