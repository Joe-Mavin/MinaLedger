import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../database/connection.mjs';
import { AppError } from '../../utils/errors.mjs';
import { canAccessHole, canAccessProcessingFacility, canAccessRecoveryFacility } from '../../middleware/auth.mjs';
import { appendAuditEvent } from '../audit/audit.service.mjs';
import { executeIdempotent } from '../commands/idempotency.service.mjs';

const tokenHash = (token) => createHash('sha256').update(token, 'utf8').digest();

export async function getBatchOrigins(batchId) {
  return sequelize.query(
    `
     SELECT DISTINCT h.site_id,h.id AS hole_id,NULL::uuid AS processing_facility_id,NULL::uuid AS recovery_facility_id
     FROM material_event_output eo
     JOIN production_event_output peo ON peo.material_event_output_id=eo.id
     JOIN production_event pe ON pe.event_id=peo.production_event_id
     JOIN mining_hole h ON h.id=pe.hole_id
     WHERE eo.batch_id=:batchId
     UNION
     SELECT DISTINCT source_hole.site_id,source_hole.id,pe.processing_facility_id,NULL::uuid
     FROM material_event_output eo
     JOIN processing_event_output peo ON peo.material_event_output_id=eo.id
     JOIN processing_event pe ON pe.event_id=peo.processing_event_id
     JOIN processing_event_input pei ON pei.processing_event_id=pe.event_id
     JOIN production_event_output source_output ON source_output.material_event_output_id=pei.source_production_output_id
     JOIN production_event source_event ON source_event.event_id=source_output.production_event_id
     JOIN mining_hole source_hole ON source_hole.id=source_event.hole_id
     WHERE eo.batch_id=:batchId
     UNION
     SELECT DISTINCT NULL::uuid,NULL::uuid,NULL::uuid,re.recovery_facility_id
     FROM material_event_output eo
     JOIN recovery_event_output reo ON reo.material_event_output_id=eo.id
     JOIN recovery_event re ON re.event_id=reo.recovery_event_id
     WHERE eo.batch_id=:batchId`,
    { replacements: { batchId }, type: QueryTypes.SELECT },
  );
}

export async function canAccessBatch(auth, batchId, { write = false } = {}) {
  const origins = await getBatchOrigins(batchId);
  if (!origins.length) return false;
  for (const origin of origins) {
    if (origin.site_id && !(await canAccessHole(auth, origin.site_id, origin.hole_id, { write }))) return false;
    if (origin.processing_facility_id && !(await canAccessProcessingFacility(auth, origin.processing_facility_id, { write }))) return false;
    if (origin.recovery_facility_id && !(await canAccessRecoveryFacility(auth, origin.recovery_facility_id, { write }))) return false;
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
  if (!(await canAccessBatch(auth, batchId, { write: true }))) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  return sequelize.transaction(async (transaction) => executeIdempotent({
    actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'qr.create', batchId }, transaction,
  }, () => createQrRecord(batchId, auth, mutationId, transaction)));
}

export async function rotateBatchQr(batchId, auth, mutationId) {
  if (!(await canAccessBatch(auth, batchId, { write: true }))) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
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
  const origins = await getBatchOrigins(record.material_batch_id);
  return { ...record, origins };
}
