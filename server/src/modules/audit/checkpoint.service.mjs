import { createHash, randomUUID } from 'node:crypto';
import canonicalize from 'canonicalize';
import { QueryTypes, Transaction } from 'sequelize';
import { sequelize } from '../../database/connection.mjs';
import { canAccessHole, canAccessProcessingFacility, canAccessRecoveryFacility, canAccessSite } from '../../middleware/auth.mjs';
import { AppError } from '../../utils/errors.mjs';
import { logger } from '../../config/logger.mjs';
import { processingEventAccessRows } from '../processing/processing.service.mjs';
import { readConsignment } from '../residue/residue.service.mjs';
import { readGoldTrade } from '../gold-trades/gold-trade.service.mjs';
import { hashPayload, hashStreamEntry, readAuditStream, verifyAuditEntries } from './audit.service.mjs';

const ZERO_HASH = '00'.repeat(32);
const CHECKPOINT_PREFIX = Buffer.from('MinaLedger:checkpoint:v1\0', 'utf8');
const MAX_ATTEMPTS = 8;
const LEASE_MS = 60_000;
const query = (sql, replacements = {}, transaction = undefined) => sequelize.query(sql, {
  replacements, type: QueryTypes.SELECT, ...(transaction ? { transaction } : {}),
});

const sha256 = (value) => createHash('sha256').update(value).digest();
const hex = (value) => Buffer.from(value).toString('hex');

function sortedStreams(streams) {
  const streamKind = (stream) => stream.streamKind ?? stream.stream_kind;
  const streamId = (stream) => stream.streamId ?? stream.stream_id;
  return [...streams].sort((left, right) => streamKind(left).localeCompare(streamKind(right)) || streamId(left).localeCompare(streamId(right)));
}

function manifestFor(checkpoint, streams) {
  return {
    version: checkpoint.manifest_version ?? 1,
    checkpointId: checkpoint.id,
    createdByUserId: checkpoint.created_by_user_id,
    createdAt: new Date(checkpoint.created_at).toISOString(),
    provenance: checkpoint.provenance,
    streams: sortedStreams(streams).map((stream) => ({
      streamKind: stream.stream_kind,
      streamId: stream.stream_id,
      sequence: Number(stream.sequence),
      headHash: stream.head_hash,
    })),
  };
}

export function checkpointManifestHash(checkpoint, streams) {
  const serialized = canonicalize(manifestFor(checkpoint, streams));
  if (typeof serialized !== 'string') throw new TypeError('Checkpoint manifest could not be canonicalized.');
  return sha256(Buffer.concat([CHECKPOINT_PREFIX, Buffer.from(serialized, 'utf8')]));
}

function verifyStreamSnapshot(checkpointStream, snapshot) {
  const coveredSequence = Number(checkpointStream.sequence);
  const coveredHeadHash = checkpointStream.head_hash;
  const rows = snapshot.rows;
  const prefix = rows.filter((row) => Number(row.sequence) <= coveredSequence);
  const prefixResult = verifyAuditEntries(prefix);
  const zeroSequenceHeadMatches = coveredSequence !== 0 || coveredHeadHash === ZERO_HASH;
  const checkpointValid = prefixResult.valid
    && prefix.length === coveredSequence
    && prefixResult.lastSequence === coveredSequence
    && prefixResult.headHash === coveredHeadHash
    && zeroSequenceHeadMatches;
  const headSequence = snapshot.head ? Number(snapshot.head.last_sequence) : null;
  const headHash = snapshot.head?.head_hash ?? null;
  const fullResult = verifyAuditEntries(rows);
  const currentHeadConsistent = Boolean(snapshot.head)
    && fullResult.valid
    && headSequence === rows.length
    && fullResult.lastSequence === headSequence
    && fullResult.headHash === headHash;
  const tailRows = rows.filter((row) => Number(row.sequence) > coveredSequence);
  const tailResult = verifyAuditEntries(tailRows, { startingSequence: coveredSequence, startingHash: coveredHeadHash });
  const tailCountMatches = headSequence !== null && headSequence >= coveredSequence
    && tailRows.length === headSequence - coveredSequence;
  let tailStatus = 'NONE';
  let tailReason;
  if (!snapshot.head) {
    tailStatus = 'MISSING_HEAD';
  } else if (!currentHeadConsistent || !tailResult.valid || !tailCountMatches || headSequence < coveredSequence) {
    tailStatus = 'INVALID';
    tailReason = !tailCountMatches ? 'head_sequence_mismatch' : !tailResult.valid ? tailResult.reason : 'head_hash_mismatch';
  } else if (tailRows.length > 0) {
    tailStatus = 'UNANCHORED';
  }
  return {
    streamKind: checkpointStream.stream_kind,
    streamId: checkpointStream.stream_id,
    coveredSequence,
    coveredHeadHash,
    checkpointStatus: checkpointValid ? 'VERIFIED' : 'INVALID',
    ...(checkpointValid ? {} : { checkpointFailure: prefixResult.reason ?? 'checkpoint_head_mismatch' }),
    currentSequence: headSequence,
    currentHeadStatus: currentHeadConsistent ? 'CONSISTENT' : 'MISMATCH',
    tailStatus,
    tailEntries: Math.max(0, tailRows.length),
    ...(tailReason ? { tailFailure: tailReason } : {}),
  };
}

export function verifyCheckpointSnapshot({ checkpoint, checkpointStreams, snapshots }) {
  const expectedManifest = hex(checkpointManifestHash(checkpoint, checkpointStreams));
  const storedManifest = hex(checkpoint.manifest_hash);
  const manifestValid = expectedManifest === storedManifest;
  const snapshotByKey = new Map(snapshots.map((snapshot) => [`${snapshot.streamKind}:${snapshot.streamId}`, snapshot]));
  const streamResults = checkpointStreams.map((stream) => {
    const snapshot = snapshotByKey.get(`${stream.stream_kind}:${stream.stream_id}`);
    if (!snapshot) return {
      streamKind: stream.stream_kind, streamId: stream.stream_id,
      coveredSequence: Number(stream.sequence), coveredHeadHash: stream.head_hash,
      checkpointStatus: 'INVALID', checkpointFailure: 'stream_snapshot_missing',
      currentSequence: null, currentHeadStatus: 'MISMATCH', tailStatus: 'MISSING_HEAD', tailEntries: 0,
    };
    return verifyStreamSnapshot(stream, snapshot);
  });
  const checkpointValid = manifestValid
    && streamResults.length === checkpointStreams.length
    && streamResults.every((result) => result.checkpointStatus === 'VERIFIED');
  return {
    checkpointStatus: checkpointValid ? 'VERIFIED' : 'INVALID',
    manifestStatus: manifestValid ? 'VALID' : 'INVALID',
    streams: streamResults,
    externalCommitment: 'NOT_IMPLEMENTED',
  };
}

async function requireStreamAccess(auth, stream) {
  const streamKind = stream.streamKind ?? stream.stream_kind;
  const streamId = stream.streamId ?? stream.stream_id;
  let allowed = false;
  if (streamKind === 'mining_site') {
    allowed = await canAccessSite(auth, streamId);
  } else if (streamKind === 'mining_hole') {
    const [hole] = await query('SELECT site_id FROM mining_hole WHERE id=:id', { id: streamId });
    allowed = Boolean(hole && await canAccessHole(auth, hole.site_id, streamId));
  } else if (streamKind === 'material_event') {
    const [production] = await query(`SELECT h.site_id,h.id AS hole_id FROM production_event pe
      JOIN mining_hole h ON h.id=pe.hole_id WHERE pe.event_id=:id`, { id: streamId });
    if (production) {
      allowed = await canAccessHole(auth, production.site_id, production.hole_id);
    } else {
      const sources = await processingEventAccessRows(streamId);
      if (sources.length && await canAccessProcessingFacility(auth, sources[0].processing_facility_id)) {
        allowed = true;
        for (const source of sources) {
          if (!(await canAccessHole(auth, source.site_id, source.hole_id))) allowed = false;
        }
      }
    }
  } else if (streamKind === 'processing_facility') {
    allowed = await canAccessProcessingFacility(auth, streamId);
    if (allowed) {
      const events = await query('SELECT event_id FROM processing_event WHERE processing_facility_id=:id', { id: streamId });
      for (const event of events) {
        const sources = await processingEventAccessRows(event.event_id);
        if (!sources.length) {
          allowed = false;
          break;
        }
        for (const source of sources) {
          if (!(await canAccessHole(auth, source.site_id, source.hole_id))) allowed = false;
        }
        if (!allowed) break;
      }
    }
  } else if (streamKind === 'recovery_facility') {
    allowed = await canAccessRecoveryFacility(auth, streamId);
  } else if (streamKind === 'gold_trade') {
    try {
      await readGoldTrade(streamId, auth);
      allowed = true;
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'RESOURCE_NOT_FOUND') throw error;
    }
  } else if (streamKind === 'consignment') {
    try {
      await readConsignment(streamId, auth);
      allowed = true;
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'RESOURCE_NOT_FOUND') throw error;
    }
  }
  if (!allowed) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested audit stream was not found.');
}

async function loadCheckpoint(checkpointId, transaction) {
  const [checkpoint] = await query('SELECT * FROM audit_checkpoint WHERE id=:id', { id: checkpointId }, transaction);
  if (!checkpoint) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested audit checkpoint was not found.');
  const checkpointStreams = await query(`SELECT stream_kind,stream_id,sequence,encode(head_hash,'hex') AS head_hash
    FROM audit_checkpoint_stream WHERE checkpoint_id=:id ORDER BY stream_kind,stream_id`, { id: checkpointId }, transaction);
  return { checkpoint, checkpointStreams };
}

async function loadStreamSnapshot(stream, transaction) {
  const rows = await readAuditStream(stream.stream_kind, stream.stream_id, transaction);
  const [headRow] = await query(`SELECT last_sequence,encode(head_hash,'hex') AS head_hash FROM audit_stream_head
    WHERE stream_kind=:kind AND stream_id=:id`, { kind: stream.stream_kind, id: stream.stream_id }, transaction);
  return {
    streamKind: stream.stream_kind,
    streamId: stream.stream_id,
    rows,
    head: headRow ? { last_sequence: Number(headRow.last_sequence), head_hash: headRow.head_hash } : null,
  };
}

async function verifyStoredCheckpoint(checkpointId) {
  return sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ, readOnly: true }, async (transaction) => {
    const { checkpoint, checkpointStreams } = await loadCheckpoint(checkpointId, transaction);
    const snapshots = [];
    for (const stream of checkpointStreams) snapshots.push(await loadStreamSnapshot(stream, transaction));
    return verifyCheckpointSnapshot({ checkpoint, checkpointStreams, snapshots });
  });
}

export async function createAuditCheckpoint(input, auth, requestId, idempotencyKey) {
  if (input.clientMutationId !== idempotencyKey) throw new AppError(400, 'IDEMPOTENCY_KEY_MISMATCH', 'Idempotency-Key must match clientMutationId.');
  const streams = sortedStreams(input.streams);
  const requestHash = sha256(Buffer.from(canonicalize({ streams }), 'utf8'));
  const checkpointId = await sequelize.transaction(async (transaction) => {
    const lockKey = `audit-checkpoint:${auth.userId}:${input.clientMutationId}`;
    await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:lockKey,0))', { replacements: { lockKey }, transaction });
    const [existing] = await query(`SELECT id,request_hash FROM audit_checkpoint
      WHERE created_by_user_id=:userId AND client_mutation_id=:mutationId FOR UPDATE`,
    { userId: auth.userId, mutationId: input.clientMutationId }, transaction);
    if (existing) {
      if (!Buffer.from(existing.request_hash).equals(requestHash)) throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'This checkpoint mutation ID was already used with a different stream selection.');
      return existing.id;
    }

    for (const stream of streams) await requireStreamAccess(auth, stream);
    const currentStreams = [];
    for (const stream of streams) {
      const [head] = await query(`SELECT last_sequence,encode(head_hash,'hex') AS head_hash FROM audit_stream_head
        WHERE stream_kind=:kind AND stream_id=:id FOR UPDATE`,
      { kind: stream.streamKind, id: stream.streamId }, transaction);
      if (!head) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested audit stream was not found.');
      const rows = await readAuditStream(stream.streamKind, stream.streamId, transaction);
      const verified = verifyAuditEntries(rows);
      if (!verified.valid || verified.lastSequence !== Number(head.last_sequence) || verified.headHash !== head.head_hash) {
        throw new AppError(409, 'AUDIT_STREAM_INVALID', 'A selected audit stream failed integrity verification; no checkpoint was created.', { streamKind: stream.streamKind, streamId: stream.streamId, reason: verified.reason ?? 'head_mismatch' });
      }
      currentStreams.push({ stream_kind: stream.streamKind, stream_id: stream.streamId, sequence: Number(head.last_sequence), head_hash: head.head_hash });
    }

    const id = randomUUID();
    const [clock] = await query('SELECT transaction_timestamp() AS created_at', {}, transaction);
    const createdAt = clock.created_at;
    const provenance = { method: 'AUTHENTICATED_API', requestId: String(requestId).slice(0, 100) };
    const checkpoint = { id, created_by_user_id: auth.userId, created_at: createdAt, provenance, manifest_version: 1 };
    const manifestHash = checkpointManifestHash(checkpoint, currentStreams);
    await sequelize.query(`INSERT INTO audit_checkpoint(id,created_by_user_id,created_at,creation_request_id,provenance,
      manifest_version,manifest_hash,client_mutation_id,request_hash)
      VALUES (:id,:userId,:createdAt,:requestId,CAST(:provenance AS jsonb),1,:manifestHash,:mutationId,:requestHash)`, {
      replacements: { id, userId: auth.userId, createdAt, requestId: provenance.requestId, provenance: JSON.stringify(provenance), manifestHash, mutationId: input.clientMutationId, requestHash }, transaction,
    });
    for (const stream of currentStreams) {
      await sequelize.query(`INSERT INTO audit_checkpoint_stream(checkpoint_id,stream_kind,stream_id,sequence,head_hash)
        VALUES (:checkpointId,:kind,:streamId,:sequence,:headHash)`, {
        replacements: { checkpointId: id, kind: stream.stream_kind, streamId: stream.stream_id, sequence: stream.sequence, headHash: Buffer.from(stream.head_hash, 'hex') }, transaction,
      });
    }
    await sequelize.query(`INSERT INTO audit_checkpoint_outbox(id,checkpoint_id) VALUES (:id,:checkpointId)`, {
      replacements: { id: randomUUID(), checkpointId: id }, transaction,
    });
    logger.info({ checkpointId: id, actorUserId: auth.userId, streamCount: currentStreams.length, requestId: provenance.requestId }, 'audit checkpoint created');
    return id;
  });
  return getAuditCheckpoint(checkpointId, auth);
}

export async function getAuditCheckpoint(checkpointId, auth) {
  const { checkpoint, checkpointStreams } = await loadCheckpoint(checkpointId);
  for (const stream of checkpointStreams) await requireStreamAccess(auth, stream);
  const liveVerification = await verifyStoredCheckpoint(checkpointId);
  const [outbox] = await query(`SELECT status,attempt_count,next_attempt_at,last_result,last_error_code,created_at,completed_at
    FROM audit_checkpoint_outbox WHERE checkpoint_id=:id`, { id: checkpointId });
  const verificationHistory = await query(`SELECT attempt_number,outcome,error_code,started_at,completed_at
    FROM audit_checkpoint_verification WHERE checkpoint_id=:id ORDER BY attempt_number`, { id: checkpointId });
  return {
    checkpoint: {
      id: checkpoint.id,
      createdAt: checkpoint.created_at,
      createdByUserId: checkpoint.created_by_user_id,
      provenance: checkpoint.provenance,
      manifestVersion: checkpoint.manifest_version,
      manifestHash: hex(checkpoint.manifest_hash),
      streams: checkpointStreams.map((stream) => ({ streamKind: stream.stream_kind, streamId: stream.stream_id, sequence: Number(stream.sequence), headHash: stream.head_hash })),
    },
    databaseState: 'ACCEPTED',
    processing: {
      status: outbox.status,
      attemptCount: outbox.attempt_count,
      nextAttemptAt: outbox.next_attempt_at,
      lastErrorCode: outbox.last_error_code,
      completedAt: outbox.completed_at,
      verification: outbox.last_result,
      attempts: verificationHistory,
    },
    liveVerification,
    externalCommitment: 'NOT_IMPLEMENTED',
  };
}

export async function claimAuditCheckpoint(checkpointId = undefined, { leaseMs = LEASE_MS } = {}) {
  return sequelize.transaction(async (transaction) => {
    const idFilter = checkpointId ? 'AND checkpoint_id=:checkpointId' : '';
    const [candidate] = await query(`SELECT id,checkpoint_id,status,attempt_count,lease_expires_at
      FROM audit_checkpoint_outbox
      WHERE ((status IN ('PENDING','RETRY') AND next_attempt_at<=now())
        OR (status='PROCESSING' AND lease_expires_at<=now())) ${idFilter}
      ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,
    { ...(checkpointId ? { checkpointId } : {}) }, transaction);
    if (!candidate) return null;
    const leaseToken = randomUUID();
    const [claimed] = await query(`UPDATE audit_checkpoint_outbox SET status='PROCESSING',attempt_count=attempt_count+1,
      lease_token=:leaseToken,lease_expires_at=now()+(:leaseMs * interval '1 millisecond'),last_error_code=NULL
      WHERE id=:id RETURNING attempt_count,clock_timestamp() AS started_at`,
    { leaseToken, leaseMs, id: candidate.id }, transaction);
    return { checkpointId: candidate.checkpoint_id, attemptNumber: claimed.attempt_count, leaseToken, startedAt: claimed.started_at };
  });
}

async function finishClaim(claim, outcome, result, errorCode = null) {
  return sequelize.transaction(async (transaction) => {
    const [row] = await query(`SELECT id,status,attempt_count,lease_token FROM audit_checkpoint_outbox
      WHERE checkpoint_id=:checkpointId FOR UPDATE`, { checkpointId: claim.checkpointId }, transaction);
    if (!row || row.status !== 'PROCESSING' || row.lease_token !== claim.leaseToken) return false;
    const completedAt = new Date();
    await sequelize.query(`INSERT INTO audit_checkpoint_verification(id,checkpoint_id,attempt_number,outcome,result,error_code,started_at,completed_at)
      VALUES (:id,:checkpointId,:attemptNumber,:outcome,CAST(:result AS jsonb),:errorCode,:startedAt,:completedAt)`, {
      replacements: { id: randomUUID(), checkpointId: claim.checkpointId, attemptNumber: claim.attemptNumber, outcome, result: JSON.stringify(result), errorCode, startedAt: claim.startedAt, completedAt }, transaction,
    });
    if (outcome === 'RETRYABLE_FAILURE') {
      const terminal = claim.attemptNumber >= MAX_ATTEMPTS;
      const status = terminal ? 'FAILED' : 'RETRY';
      const delayMs = Math.min(300_000, 2_000 * (2 ** Math.min(claim.attemptNumber - 1, 8)));
      await sequelize.query(`UPDATE audit_checkpoint_outbox SET status=:status,last_result=CAST(:result AS jsonb),last_error_code=:errorCode,
        next_attempt_at=:nextAttemptAt,lease_token=NULL,lease_expires_at=NULL,completed_at=:completedAt
        WHERE id=:id`, {
        replacements: { status, result: JSON.stringify(result), errorCode, nextAttemptAt: terminal ? completedAt : new Date(completedAt.getTime() + delayMs), completedAt: terminal ? completedAt : null, id: row.id }, transaction,
      });
      logger.warn({ checkpointId: claim.checkpointId, attempt: claim.attemptNumber, status, errorCode }, 'audit checkpoint processing attempt failed');
      return true;
    }
    const status = outcome;
    await sequelize.query(`UPDATE audit_checkpoint_outbox SET status=:status,last_result=CAST(:result AS jsonb),last_error_code=:errorCode,
      lease_token=NULL,lease_expires_at=NULL,completed_at=:completedAt WHERE id=:id`, {
      replacements: { status, result: JSON.stringify(result), errorCode, completedAt, id: row.id }, transaction,
    });
    if (status === 'VERIFIED') logger.info({ checkpointId: claim.checkpointId, attempt: claim.attemptNumber, streamCount: result.streams.length }, 'audit checkpoint verified');
    else logger.warn({ checkpointId: claim.checkpointId, attempt: claim.attemptNumber }, 'audit checkpoint verification found invalid data');
    return true;
  });
}

export async function processAuditCheckpoint(checkpointId = undefined, { verifier = verifyStoredCheckpoint } = {}) {
  const claim = await claimAuditCheckpoint(checkpointId);
  if (!claim) return { processed: false };
  try {
    const result = await verifier(claim.checkpointId);
    const streamResults = Array.isArray(result.streams) ? result.streams : [];
    const currentHistoryConsistent = streamResults.length > 0 && streamResults.every((stream) => (
      stream.currentHeadStatus === 'CONSISTENT' && ['NONE', 'UNANCHORED'].includes(stream.tailStatus)
    ));
    const outcome = result.checkpointStatus === 'VERIFIED' && currentHistoryConsistent ? 'VERIFIED' : 'INVALID';
    const completed = await finishClaim(claim, outcome, result, outcome === 'INVALID' ? 'CHECKPOINT_VERIFICATION_FAILED' : null);
    return { processed: completed, checkpointId: claim.checkpointId, outcome: completed ? outcome : 'LEASE_LOST' };
  } catch (error) {
    const errorCode = typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'CHECKPOINT_PROCESSING_ERROR';
    const result = { checkpointStatus: 'PROCESSING_ERROR', retryable: claim.attemptNumber < MAX_ATTEMPTS, errorCode };
    const outcome = claim.attemptNumber >= MAX_ATTEMPTS ? 'FAILED' : 'RETRYABLE_FAILURE';
    const completed = await finishClaim(claim, outcome, result, errorCode);
    return { processed: completed, checkpointId: claim.checkpointId, outcome: completed ? (outcome === 'RETRYABLE_FAILURE' ? 'RETRY' : outcome) : 'LEASE_LOST' };
  }
}
