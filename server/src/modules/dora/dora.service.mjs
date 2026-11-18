import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../database/connection.mjs';
import { AppError } from '../../utils/errors.mjs';
import { appendAuditEvent } from '../audit/audit.service.mjs';
import { executeIdempotent } from '../commands/idempotency.service.mjs';

export async function createDora(siteId, input, auth, mutationId) {
  return sequelize.transaction(async (transaction) => executeIdempotent({
    actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'dora.create', siteId, input }, transaction,
  }, async () => {
    const [site] = await sequelize.query(`SELECT id FROM mining_site WHERE id=:siteId FOR UPDATE`, {
      replacements: { siteId }, type: QueryTypes.SELECT, transaction,
    });
    if (!site) throw new AppError(404, 'SITE_NOT_FOUND', 'Mining site was not found.');
    const facilityId = randomUUID();
    await sequelize.query(
      `INSERT INTO processing_facility(id,name,status) VALUES (:id,:name,'ACTIVE')`,
      { replacements: { id: facilityId, name: input.name.trim() }, transaction },
    );
    await sequelize.query(
      `INSERT INTO processing_facility_site(processing_facility_id,mining_site_id,associated_by_user_id)
       VALUES (:facilityId,:siteId,:userId)`,
      { replacements: { facilityId, siteId, userId: auth.userId }, transaction },
    );
    await appendAuditEvent({
      transaction, eventType: 'DORA_FACILITY.CREATED', actorUserId: auth.userId, actorPartyId: auth.personPartyId,
      occurredAt: new Date(), clientMutationId: mutationId,
      payload: { processing_facility_id: facilityId, site_id: siteId },
      streams: [{ kind: 'processing_facility', id: facilityId }, { kind: 'mining_site', id: siteId }],
    });
    return { id: facilityId, siteId, name: input.name.trim(), status: 'ACTIVE' };
  }));
}

export async function listSiteDoras(siteId) {
  return sequelize.query(
    `SELECT pf.id, pf.name, pf.status, pfs.created_at AS associated_at
     FROM processing_facility_site pfs JOIN processing_facility pf ON pf.id=pfs.processing_facility_id
     WHERE pfs.mining_site_id=:siteId ORDER BY pf.created_at, pf.id`,
    { replacements: { siteId }, type: QueryTypes.SELECT },
  );
}

export async function getDora(facilityId) {
  const [facility] = await sequelize.query(
    `SELECT pf.id, pf.name, pf.status, pf.created_at,
            array_agg(pfs.mining_site_id ORDER BY pfs.mining_site_id) AS site_ids
     FROM processing_facility pf JOIN processing_facility_site pfs ON pfs.processing_facility_id=pf.id
     WHERE pf.id=:facilityId GROUP BY pf.id`,
    { replacements: { facilityId }, type: QueryTypes.SELECT },
  );
  if (!facility) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  return facility;
}

export async function updateDora(facilityId, input, auth, mutationId) {
  return sequelize.transaction(async (transaction) => executeIdempotent({
    actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'dora.update', facilityId, input }, transaction,
  }, async () => {
    const [facility] = await sequelize.query(
      `SELECT id,name,status FROM processing_facility WHERE id=:facilityId FOR UPDATE`,
      { replacements: { facilityId }, type: QueryTypes.SELECT, transaction },
    );
    if (!facility) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
    const changedFields = [];
    if (input.name !== undefined && input.name !== facility.name) {
      await sequelize.query(`UPDATE processing_facility SET name=:name WHERE id=:facilityId`, { replacements: { name: input.name, facilityId }, transaction });
      changedFields.push('name');
      facility.name = input.name;
    }
    if (input.status !== undefined && input.status !== facility.status) {
      await sequelize.query(`UPDATE processing_facility SET status=:status WHERE id=:facilityId`, { replacements: { status: input.status, facilityId }, transaction });
      changedFields.push('status');
      facility.status = input.status;
    }
    await appendAuditEvent({
      transaction, eventType: 'DORA_FACILITY.UPDATED', actorUserId: auth.userId, actorPartyId: auth.personPartyId,
      occurredAt: new Date(), clientMutationId: mutationId,
      payload: { processing_facility_id: facilityId, changed_fields: changedFields.sort() },
      streams: [{ kind: 'processing_facility', id: facilityId }],
    });
    return { id: facilityId, name: facility.name, status: facility.status };
  }));
}
