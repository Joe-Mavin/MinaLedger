import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../database/connection.mjs';
import { AppError } from '../../utils/errors.mjs';
import { canAccessHole, canAccessProcessingFacility } from '../../middleware/auth.mjs';
import { appendAuditEvent } from '../audit/audit.service.mjs';
import { executeIdempotent } from '../commands/idempotency.service.mjs';

const tokenHash = (token) => createHash('sha256').update(token, 'utf8').digest();

async function batchOrigins(batchId) {
  return sequelize.query(
    `WITH RECURSIVE batch_origins(batch_id,site_id,hole_id,processing_facility_id,depth) AS (
       SELECT eo.batch_id, h.site_id, h.id, NULL::uuid, 0
       FROM production_event_output peo
       JOIN material_event_output eo ON eo.id=peo.material_event_output_id
       JOIN production_event pe ON pe.event_id=peo.production_event_id
       JOIN mining_hole h ON h.id=pe.hole_id
       UNION
       SELECT output_eo.batch_id, origin.site_id, origin.hole_id, pe.processing_facility_id, origin.depth+1
       FROM processing_event_output peo
       JOIN material_event_output output_eo ON output_eo.id=peo.material_event_output_id
       JOIN processing_event pe ON pe.event_id=peo.processing_event_id
       JOIN processing_event_input pei ON pei.processing_event_id=pe.event_id
       JOIN material_event_input mei ON mei.id=pei.material_event_input_id
       JOIN batch_origins origin ON origin.batch_id=mei.batch_id
       WHERE origin.depth < 16
     )
     SELECT DISTINCT site_id,hole_id,processing_facility_id FROM batch_origins WHERE batch_id=:batchId`,
    { replacements: { batchId }, type: QueryTypes.SELECT },
  );
}

export async function canAccessBatch(auth, batchId) {
  const origins = await batchOrigins(batchId);
  if (!origins.length) return false;
  for (const origin of origins) {
    if (!(await canAccessHole(auth, origin.site_id, origin.hole_id))) return false;
    if (origin.processing_facility_id && !(await canAccessProcessingFacility(auth, origin.processing_facility_id))) return false;
  }
  return true;
}

async function createQrRecord(batchId, auth, mutationId, transaction, previousId = null) {
  const [batch] = await sequelize.query(
    `SELECT id,batch_code,material_kind FROM material_batch WHERE id=:batchId`,
    { replacements: { batchId }, type: QueryTypes.SELECT, transaction },
  );
  if (!batch) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  const [active] = await sequelize.query(
    `SELECT id FROM qr_record WHERE material_batch_id=:batchId AND status='ACTIVE' FOR UPDATE`,
    { replacements: { batchId }, type: QueryTypes.SELECT, transaction },
  );
  if (active) throw new AppError(409, 'QR_ALREADY_ACTIVE', 'This material batch already has an active QR identity.');
  const id = randomUUID();
  const token = randomBytes(32).toString('base64url');
  await sequelize.query(
    `INSERT INTO qr_record(id,public_token_hash,material_batch_id,status,rotated_from_id)
     VALUES (:id,:tokenHash,:batchId,'ACTIVE',:previousId)`,
    { replacements: { id, tokenHash: tokenHash(token), batchId, previousId }, transaction },
  );
  await appendAuditEvent({
    transaction, eventType: previousId ? 'QR.IDENTITY_ROTATED' : 'QR.IDENTITY_CREATED',
    actorUserId: auth.userId, actorPartyId: auth.personPartyId, occurredAt: new Date(), clientMutationId: mutationId,
    payload: { qr_record_id: id, material_batch_id: batchId, rotated_from_id: previousId },
    streams: [{ kind: 'material_batch', id: batchId }, { kind: 'qr_record', id }],
  });
  return { qrRecordId: id, materialBatchId: batchId, payload: token, status: 'ACTIVE', rotatedFromId: previousId };
}

export async function createBatchQr(batchId, auth, mutationId) {
  if (!(await canAccessBatch(auth, batchId))) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  return sequelize.transaction(async (transaction) => executeIdempotent({
    actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'qr.create', batchId }, transaction,
  }, () => createQrRecord(batchId, auth, mutationId, transaction)));
}

export async function rotateBatchQr(batchId, auth, mutationId) {
  if (!(await canAccessBatch(auth, batchId))) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  return sequelize.transaction(async (transaction) => executeIdempotent({
    actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'qr.rotate', batchId }, transaction,
  }, async () => {
    const [active] = await sequelize.query(
      `SELECT id FROM qr_record WHERE material_batch_id=:batchId AND status='ACTIVE' FOR UPDATE`,
      { replacements: { batchId }, type: QueryTypes.SELECT, transaction },
    );
    if (!active) throw new AppError(404, 'QR_NOT_FOUND', 'The active QR identity was not found.');
    await sequelize.query(`UPDATE qr_record SET status='REVOKED' WHERE id=:id`, { replacements: { id: active.id }, transaction });
    return createQrRecord(batchId, auth, mutationId, transaction, active.id);
  }));
}

export async function lookupQr(token, auth) {
  const [record] = await sequelize.query(
    `SELECT q.id AS qr_record_id, q.material_batch_id, q.status, q.rotated_from_id,
            b.batch_code, b.material_kind, b.current_status
     FROM qr_record q JOIN material_batch b ON b.id=q.material_batch_id
     WHERE q.public_token_hash=:tokenHash AND q.status='ACTIVE'`,
    { replacements: { tokenHash: tokenHash(token) }, type: QueryTypes.SELECT },
  );
  if (!record || !(await canAccessBatch(auth, record.material_batch_id))) {
    throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  }
  const origins = await batchOrigins(record.material_batch_id);
  return { ...record, origins };
}
