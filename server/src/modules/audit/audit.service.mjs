import { createHash, randomBytes, randomUUID } from 'node:crypto';
import canonicalize from 'canonicalize';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../database/connection.mjs';
import { AppError } from '../../utils/errors.mjs';

const ZERO_HASH = '00'.repeat(32);
const EVENT_PREFIX = Buffer.from('MinaLedger:event:v1\0', 'utf8');
const STREAM_PREFIX = Buffer.from('MinaLedger:stream:v1\0', 'utf8');
const sha256 = (value) => createHash('sha256').update(value).digest();

export function hashPayload(canonicalPayload, salt) {
  return sha256(Buffer.concat([EVENT_PREFIX, Buffer.from(canonicalPayload, 'utf8'), salt]));
}

export function hashStreamEntry(entry) {
  return sha256(Buffer.concat([STREAM_PREFIX, Buffer.from(canonicalize(entry), 'utf8')]));
}

export async function appendAuditEvent({ transaction, eventType, actorUserId, actorPartyId, occurredAt, payload, streams, clientMutationId = null, expectedVersions = [] }) {
  const normalizedStreams = [...new Map(streams.map(({ kind, id }) => [`${kind}:${id}`, { kind, id }])).values()]
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  const canonicalPayload = canonicalize(payload);
  if (typeof canonicalPayload !== 'string') throw new TypeError('Audit payload could not be canonicalized.');
  const salt = randomBytes(32);
  const payloadCommitment = hashPayload(canonicalPayload, salt);
  const auditEventId = randomUUID();
  await sequelize.query(
    `INSERT INTO audit_event(id, event_type, actor_user_id, actor_party_id, client_mutation_id, occurred_at_claimed,
      canonical_payload, payload_salt, payload_commitment)
     VALUES (:id, :eventType, :actorUserId, :actorPartyId, :clientMutationId, :occurredAt, :payload, :salt, :commitment)`,
    { replacements: { id: auditEventId, eventType, actorUserId, actorPartyId, clientMutationId, occurredAt, payload: canonicalPayload, salt, commitment: payloadCommitment }, transaction },
  );

  for (const stream of normalizedStreams) {
    await sequelize.query(
      `INSERT INTO audit_stream_head(stream_kind, stream_id) VALUES (:kind, :id) ON CONFLICT DO NOTHING`,
      { replacements: { kind: stream.kind, id: stream.id }, transaction },
    );
  }
  const expectedByStream = new Map(expectedVersions.map((version) => [`${version.kind}:${version.id}`, Number(version.sequence)]));
  for (const key of expectedByStream.keys()) {
    if (!normalizedStreams.some((stream) => `${stream.kind}:${stream.id}` === key)) throw new AppError(400, 'INVALID_EXPECTED_VERSION', 'Expected version must reference an audit stream changed by this command.');
  }
  for (const stream of normalizedStreams) {
    const [head] = await sequelize.query(
      `SELECT last_sequence FROM audit_stream_head WHERE stream_kind = :kind AND stream_id = :id FOR UPDATE`,
      { replacements: { kind: stream.kind, id: stream.id }, type: QueryTypes.SELECT, transaction },
    );
    const key = `${stream.kind}:${stream.id}`;
    if (expectedByStream.has(key) && Number(head.last_sequence) !== expectedByStream.get(key)) {
      throw new AppError(409, 'STALE_VERSION', 'The resource changed after this command was prepared.', { streamKind: stream.kind, streamId: stream.id, expectedSequence: expectedByStream.get(key), currentSequence: Number(head.last_sequence) });
    }
  }
  for (const stream of normalizedStreams) {
    const [head] = await sequelize.query(
      `SELECT last_sequence, head_hash FROM audit_stream_head WHERE stream_kind = :kind AND stream_id = :id FOR UPDATE`,
      { replacements: { kind: stream.kind, id: stream.id }, type: QueryTypes.SELECT, transaction },
    );
    const sequence = Number(head.last_sequence) + 1;
    const previousHash = Buffer.from(head.head_hash).toString('hex');
    const entryHash = hashStreamEntry({ stream_kind: stream.kind, stream_id: stream.id, sequence, previous_hash: previousHash, payload_commitment: payloadCommitment.toString('hex') });
    await sequelize.query(
      `INSERT INTO audit_stream_entry(id, audit_event_id, stream_kind, stream_id, sequence, previous_hash, entry_hash)
       VALUES (:id, :auditEventId, :kind, :streamId, :sequence, :previousHash, :entryHash)`,
      { replacements: { id: randomUUID(), auditEventId, kind: stream.kind, streamId: stream.id, sequence, previousHash: Buffer.from(previousHash, 'hex'), entryHash }, transaction },
    );
    await sequelize.query(
      `UPDATE audit_stream_head SET last_sequence = :sequence, head_hash = :entryHash, updated_at = now()
       WHERE stream_kind = :kind AND stream_id = :streamId`,
      { replacements: { sequence, entryHash, kind: stream.kind, streamId: stream.id }, transaction },
    );
  }
  return { id: auditEventId, payloadCommitment: payloadCommitment.toString('hex') };
}

export async function readAuditStream(streamKind, streamId) {
  const rows = await sequelize.query(
    `SELECT e.stream_kind, e.stream_id, e.sequence, e.previous_hash, e.entry_hash, a.canonical_payload, a.payload_salt, a.payload_commitment, a.event_type, a.recorded_at
     FROM audit_stream_entry e JOIN audit_event a ON a.id = e.audit_event_id
     WHERE e.stream_kind = :streamKind AND e.stream_id = :streamId ORDER BY e.sequence`,
    { replacements: { streamKind, streamId }, type: QueryTypes.SELECT },
  );
  return rows.map((row) => ({ ...row, previous_hash: Buffer.from(row.previous_hash).toString('hex'), entry_hash: Buffer.from(row.entry_hash).toString('hex'), payload_salt: Buffer.from(row.payload_salt).toString('hex'), payload_commitment: Buffer.from(row.payload_commitment).toString('hex') }));
}

export function verifyAuditEntries(rows) {
  let previousHash = ZERO_HASH;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const sequence = Number(row.sequence);
    if (sequence !== index + 1 || row.previous_hash !== previousHash) return { valid: false, failedSequence: sequence, reason: 'sequence_or_previous_hash' };
    const commitment = hashPayload(row.canonical_payload, Buffer.from(row.payload_salt, 'hex')).toString('hex');
    if (commitment !== row.payload_commitment) return { valid: false, failedSequence: sequence, reason: 'payload_commitment' };
    const entryHash = hashStreamEntry({ stream_kind: row.stream_kind, stream_id: row.stream_id, sequence, previous_hash: previousHash, payload_commitment: commitment }).toString('hex');
    if (entryHash !== row.entry_hash) return { valid: false, failedSequence: sequence, reason: 'entry_hash' };
    previousHash = entryHash;
  }
  return { valid: true, verifiedEntries: rows.length, headHash: previousHash };
}

export async function verifyAuditStream(streamKind, streamId) {
  const rows = await readAuditStream(streamKind, streamId);
  const result = verifyAuditEntries(rows);
  const [head] = await sequelize.query('SELECT last_sequence, head_hash FROM audit_stream_head WHERE stream_kind=:streamKind AND stream_id=:streamId', { replacements: { streamKind, streamId }, type: QueryTypes.SELECT });
  if (!head) return { valid: rows.length === 0, verifiedEntries: 0, reason: rows.length ? 'missing_head' : undefined };
  if (Number(head.last_sequence) !== rows.length || Buffer.from(head.head_hash).toString('hex') !== result.headHash) return { valid: false, verifiedEntries: result.verifiedEntries, reason: 'head_mismatch' };
  return result;
}
