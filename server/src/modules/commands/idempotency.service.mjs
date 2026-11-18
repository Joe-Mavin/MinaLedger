import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../database/connection.mjs';
import { AppError } from '../../utils/errors.mjs';

export async function executeIdempotent({ actorScope, mutationId, payload, transaction }, operation) {
  const requestHash = createHash('sha256').update(canonicalize(payload)).digest();
  await sequelize.query(`SELECT pg_advisory_xact_lock(hashtextextended(:lockKey, 0))`, {
    replacements: { lockKey: `${actorScope}:${mutationId}` }, transaction,
  });
  const [existing] = await sequelize.query(
    `SELECT request_hash, response_json FROM idempotency_receipt WHERE actor_scope=:actorScope AND client_mutation_id=:mutationId FOR UPDATE`,
    { replacements: { actorScope, mutationId }, type: QueryTypes.SELECT, transaction },
  );
  if (existing) {
    if (!Buffer.from(existing.request_hash).equals(requestHash)) throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used with a different request.');
    return { ...existing.response_json, replayed: true };
  }
  const response = await operation();
  await sequelize.query(
    `INSERT INTO idempotency_receipt(id, actor_scope, client_mutation_id, request_hash, response_json) VALUES (gen_random_uuid(),:actorScope,:mutationId,:requestHash,:response::jsonb)`,
    { replacements: { actorScope, mutationId, requestHash, response: JSON.stringify(response) }, transaction },
  );
  return response;
}

export async function idempotentTransaction(req, operation) {
  const mutationId = req.get('idempotency-key');
  if (!mutationId) throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Provide an Idempotency-Key UUID for this command.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(mutationId)) {
    throw new AppError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be a UUID.');
  }
  return sequelize.transaction(async (transaction) => executeIdempotent({
    actorScope: `user:${req.auth.userId}`,
    mutationId,
    payload: { method: req.method, path: req.originalUrl, body: req.body },
    transaction,
  }, () => operation(transaction, mutationId)));
}

