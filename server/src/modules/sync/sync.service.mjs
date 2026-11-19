import { createHash, randomUUID } from 'node:crypto';
import canonicalize from 'canonicalize';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../database/connection.mjs';
import { canAccessHole, canAccessProcessingFacility, canAccessRecoveryFacility } from '../../middleware/auth.mjs';
import { addOutputMeasurement, createProductionEvent, recordCaptureAcknowledgement } from '../production/production.service.mjs';
import { createAllocationSet } from '../allocations/allocation.service.mjs';
import {
  adjustInventory, correctConsignmentReceiptItem, createCustodyOffer, decideCustodyTransfer,
  dispatchConsignment, receiveConsignment, transferBetweenStockpiles,
} from '../residue/residue.service.mjs';
import {
  createGoldCustodyOffer, decideGoldCustodyTransfer, readGoldTrade, recordGoldTradeAssay,
  recordGoldTradeMeasurement,
} from '../gold-trades/gold-trade.service.mjs';
import { commandVersionTarget, parseCommandPayload, requiresExpectedVersion, syncEnvelopeSchema } from './sync.schemas.mjs';
import { AppError } from '../../utils/errors.mjs';

const reviewStates = new Set(['NEEDS_REVIEW', 'SERVER_ACCEPTED']);
const lowerState = (status) => status.toLowerCase();

function receiptView(row) {
  return {
    clientMutationId: row.client_mutation_id,
    status: lowerState(row.status),
    receivedAt: row.server_received_at,
    resolvedAt: row.resolved_at,
    response: row.response_json,
    error: row.error_json,
  };
}

function expectedVersionFor(envelope, streamKind, streamId) {
  if (!envelope.expectedVersion) return undefined;
  if (envelope.expectedVersion.streamKind !== streamKind || envelope.expectedVersion.streamId !== streamId) {
    throw new AppError(400, 'INVALID_EXPECTED_VERSION', 'Expected version must identify the resource changed by this command.');
  }
  return envelope.expectedVersion;
}

function sameJson(left, right) {
  return canonicalize(left ?? null) === canonicalize(right ?? null);
}

async function validateContext(envelope, auth, transaction) {
  if (envelope.recorderUserId !== auth.userId) throw new AppError(403, 'RECORDER_MISMATCH', 'The recorder must be the authenticated account.');
  const context = envelope.actingContext;
  const role = await sequelize.query(
    `SELECT 1 FROM role_assignment WHERE user_id=:userId AND role_code=:roleCode AND scope_kind=:scopeKind AND scope_id=:scopeId
       AND status='ACTIVE' AND valid_from<=now() AND (valid_to IS NULL OR valid_to>now()) LIMIT 1`,
    { replacements: { userId: auth.userId, roleCode: context.roleCode, scopeKind: context.scopeKind, scopeId: context.scopeId }, type: QueryTypes.SELECT, transaction },
  );
  if (!role.length) throw new AppError(403, 'ACTING_CONTEXT_REVOKED', 'The selected acting role is no longer active.');
  if (context.partyId !== auth.personPartyId) {
    const [membership] = await sequelize.query(
      `SELECT 1 FROM organisation_membership om WHERE om.person_party_id=:personPartyId AND om.organisation_party_id=:partyId
       AND om.status='ACTIVE' AND om.valid_from<=now() AND (om.valid_to IS NULL OR om.valid_to>now()) LIMIT 1`,
      { replacements: { personPartyId: auth.personPartyId, partyId: context.partyId }, type: QueryTypes.SELECT, transaction },
    );
    if (!membership || context.scopeKind !== 'ORGANISATION' || context.scopeId !== context.partyId) {
      throw new AppError(403, 'INVALID_ACTING_PARTY', 'The acting party is not the authenticated recorder or an active organization membership.');
    }
  }
}

async function validateDependencies(envelope, userId, payload, transaction) {
  if (!envelope.parentCommandIds.length) return;
  const rows = await sequelize.query(
    `SELECT actor_user_id, client_mutation_id, status, response_json, envelope FROM sync_command_receipt
     WHERE client_mutation_id IN (:parentIds) FOR SHARE`,
    { replacements: { parentIds: envelope.parentCommandIds }, type: QueryTypes.SELECT, transaction },
  );
  const followsRevisionChain = (candidateId, immediateId) => {
    let cursor = rows.find((row) => row.client_mutation_id === immediateId);
    const seen = new Set();
    while (cursor?.envelope?.revisionOf && !seen.has(cursor.client_mutation_id)) {
      const parentId = cursor.envelope.revisionOf;
      if (parentId === candidateId) return true;
      seen.add(cursor.client_mutation_id);
      cursor = rows.find((row) => row.client_mutation_id === parentId);
    }
    return false;
  };
  for (const parentId of envelope.parentCommandIds) {
    const parent = rows.find((row) => row.client_mutation_id === parentId);
    const linkedRevision = Boolean(envelope.revisionOf && ['CONFLICT', 'REJECTED'].includes(parent?.status)
      && (envelope.revisionOf === parentId || followsRevisionChain(parentId, envelope.revisionOf)));
    if (linkedRevision && parent.actor_user_id !== userId) throw new AppError(403, 'REVISION_OWNER_MISMATCH', 'A linked revision must be submitted by the original recorder.');
    const parentSiteId = parent?.envelope?.payload?.siteId;
    if (parentSiteId && payload.siteId && parentSiteId !== payload.siteId) throw new AppError(403, 'DEPENDENCY_SCOPE_MISMATCH', 'Parent and child commands must refer to the same mining site.');
    if (linkedRevision) {
      const parentTarget = commandVersionTarget(parent.envelope.commandType, parent.envelope.payload);
      const nextTarget = commandVersionTarget(envelope.commandType, payload);
      if (parentTarget.streamKind !== nextTarget.streamKind || parentTarget.streamId !== nextTarget.streamId) {
        throw new AppError(403, 'REVISION_RESOURCE_MISMATCH', 'A linked correction must retain the original resource context.');
      }
    }
    if (!parent || (!linkedRevision && (!reviewStates.has(parent.status) || !parent.response_json))) {
      throw new AppError(409, 'DEPENDENCY_NOT_ACCEPTED', 'A parent command is missing or has not reached a receipt state with a server response.', { parentCommandId: parentId, parentStatus: parent?.status ? lowerState(parent.status) : 'missing' });
    }
  }
}

async function validateParticipant(envelope, payload, transaction) {
  const actual = envelope.actualParticipant;
  if (envelope.commandType === 'production.create') {
    const capture = payload.input.captureProvenance;
    if (!capture) throw new AppError(400, 'CAPTURE_PROVENANCE_REQUIRED', 'Offline production commands must preserve participant identity state and capture source.');
    if (actual.identityState !== capture.participantIdentityState || actual.partyId !== capture.actualParticipantPartyId) {
      throw new AppError(400, 'CAPTURE_PROVENANCE_MISMATCH', 'Envelope participant identity must match the production capture provenance.');
    }
    if (!sameJson(envelope.captureProvenance, capture)) throw new AppError(400, 'CAPTURE_PROVENANCE_MISMATCH', 'Envelope and payload capture provenance must match.');
    if (capture.acknowledgement) throw new AppError(400, 'SEPARATE_ACKNOWLEDGEMENT_REQUIRED', 'Participant acknowledgement or dispute must be uploaded as a separate command.');
    if (new Date(payload.input.occurredAt).getTime() !== new Date(envelope.occurredAtClaimed).getTime()) {
      throw new AppError(400, 'OCCURRENCE_TIME_MISMATCH', 'The command occurrence time must match its production payload.');
    }
    return;
  }
  if (!['production.measurement.add', 'capture.acknowledgement.add'].includes(envelope.commandType)) return;
  const eventId = payload.eventId;
  const [capture] = await sequelize.query(
    `SELECT cp.actual_participant_party_id, cp.participant_identity_state FROM production_event_capture pec
     JOIN capture_provenance cp ON cp.id=pec.capture_provenance_id WHERE pec.production_event_id=:eventId LIMIT 1`,
    { replacements: { eventId }, type: QueryTypes.SELECT, transaction },
  );
  if (capture) {
    const identityState = capture.participant_identity_state;
    if (actual.identityState !== identityState || actual.partyId !== (capture.actual_participant_party_id ?? undefined)) {
      throw new AppError(400, 'CAPTURE_PROVENANCE_MISMATCH', 'Envelope participant identity does not match the production event.');
    }
  } else if (actual.identityState === 'IDENTIFIED') {
    throw new AppError(400, 'CAPTURE_PROVENANCE_MISMATCH', 'An identified participant was supplied for an event without capture provenance.');
  }
}

async function validateResourceAccess(envelope, payload, auth, transaction, { requireVersion = true } = {}) {
  const productionTarget = ['production.measurement.add', 'capture.acknowledgement.add', 'production.allocation.propose'].includes(envelope.commandType);
  const target = commandVersionTarget(envelope.commandType, payload);
  if (envelope.expectedVersion) expectedVersionFor(envelope, target.streamKind, target.streamId);
  else if (requireVersion && requiresExpectedVersion(envelope.commandType)) throw new AppError(400, 'EXPECTED_VERSION_REQUIRED', 'This offline command requires a current resource version.');

  if (envelope.commandType === 'production.create' || productionTarget) {
    let holeId = envelope.commandType === 'production.create' ? payload.input.holeId : undefined;
    if (productionTarget) {
      const [event] = await sequelize.query(
        `SELECT pe.hole_id FROM production_event pe JOIN mining_hole h ON h.id=pe.hole_id
         WHERE pe.event_id=:eventId AND h.site_id=:siteId LIMIT 1`,
        { replacements: { eventId: payload.eventId, siteId: payload.siteId }, type: QueryTypes.SELECT, transaction },
      );
      if (!event) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested production resource was not found.');
      holeId = event.hole_id;
      if (!(await canAccessHole(auth, payload.siteId, event.hole_id, { write: envelope.commandType !== 'capture.acknowledgement.add' }))) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested production resource was not found.');
    } else if (!(await canAccessHole(auth, payload.siteId, holeId, { write: true }))) {
      throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested production resource was not found.');
    }
    if (envelope.commandType === 'capture.acknowledgement.add') {
      const [capture] = await sequelize.query(
        `SELECT cp.actual_participant_party_id FROM capture_provenance cp
         JOIN production_event_capture pec ON pec.capture_provenance_id=cp.id
         WHERE pec.production_event_id=:eventId AND cp.id=:captureId LIMIT 1`,
        { replacements: { eventId: payload.eventId, captureId: payload.captureProvenanceId }, type: QueryTypes.SELECT, transaction },
      );
      if (!capture || capture.actual_participant_party_id !== auth.personPartyId || !(await canAccessHole(auth, payload.siteId, holeId))) {
        throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested production resource was not found.');
      }
    }
    return;
  }

  if (envelope.commandType === 'stockpile.transfer') {
    const rows = await sequelize.query(`SELECT processing_facility_id FROM residue_stockpile WHERE inventory_location_id IN (:ids)`, {
      replacements: { ids: [payload.sourceLocationId, payload.input.destinationStockpileId] }, type: QueryTypes.SELECT, transaction,
    });
    if (rows.length !== 2) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested stockpile was not found.');
    for (const row of rows) if (!(await canAccessProcessingFacility(auth, row.processing_facility_id, { write: true }))) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested stockpile was not found.');
  } else if (envelope.commandType === 'inventory.adjustment.create') {
    const [location] = await sequelize.query(`SELECT s.processing_facility_id,ril.recovery_facility_id FROM inventory_location l
      LEFT JOIN residue_stockpile s ON s.inventory_location_id=l.id
      LEFT JOIN recovery_inventory_location ril ON ril.inventory_location_id=l.id WHERE l.id=:id`, {
      replacements: { id: payload.locationId }, type: QueryTypes.SELECT, transaction,
    });
    const allowed = location && (location.processing_facility_id
      ? await canAccessProcessingFacility(auth, location.processing_facility_id, { write: true })
      : location.recovery_facility_id ? await canAccessRecoveryFacility(auth, location.recovery_facility_id, { write: true }) : false);
    if (!allowed) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested inventory location was not found.');
  } else if (envelope.commandType.startsWith('consignment.')) {
    const [consignment] = await sequelize.query(`SELECT id,destination_recovery_facility_id FROM consignment WHERE id=:id`, {
      replacements: { id: payload.consignmentId }, type: QueryTypes.SELECT, transaction,
    });
    if (!consignment) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested consignment was not found.');
    if (['consignment.dispatch', 'consignment.custody.offer'].includes(envelope.commandType)) {
      const sources = await sequelize.query(`SELECT DISTINCT s.processing_facility_id FROM consignment_item ci
        JOIN residue_stockpile s ON s.inventory_location_id=ci.source_location_id WHERE ci.consignment_id=:id`, {
        replacements: { id: payload.consignmentId }, type: QueryTypes.SELECT, transaction,
      });
      if (!sources.length) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested consignment was not found.');
      for (const row of sources) if (!(await canAccessProcessingFacility(auth, row.processing_facility_id, { write: true }))) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested consignment was not found.');
    } else if (!(await canAccessRecoveryFacility(auth, consignment.destination_recovery_facility_id, { write: true }))) {
      throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested consignment was not found.');
    }
  } else if (envelope.commandType === 'custody.transfer.decide') {
    const [transfer] = await sequelize.query(`SELECT ct.id,ct.consignment_id,ct.offered_by_user_id,ct.from_party_id,c.destination_recovery_facility_id,l.trade_id FROM custody_transfer ct
      LEFT JOIN consignment c ON c.id=ct.consignment_id
      LEFT JOIN gold_trade_line l ON l.id=ct.gold_trade_line_id WHERE ct.id=:id`, {
      replacements: { id: payload.transferId }, type: QueryTypes.SELECT, transaction,
    });
    if (!transfer) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested custody transfer was not found.');
    if (transfer.consignment_id && payload.input.decision === 'WITHDRAW') {
      if (transfer.offered_by_user_id !== auth.userId) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested custody transfer was not found.');
      const sources = await sequelize.query(`SELECT DISTINCT s.processing_facility_id FROM consignment_item ci
        JOIN residue_stockpile s ON s.inventory_location_id=ci.source_location_id WHERE ci.consignment_id=:id`, {
        replacements: { id: transfer.consignment_id }, type: QueryTypes.SELECT, transaction,
      });
      for (const row of sources) if (!(await canAccessProcessingFacility(auth, row.processing_facility_id, { write: true }))) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested custody transfer was not found.');
    } else if (transfer.consignment_id && !(await canAccessRecoveryFacility(auth, transfer.destination_recovery_facility_id, { write: true }))) {
      throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested custody transfer was not found.');
    } else if (transfer.trade_id) {
      await readGoldTrade(transfer.trade_id, auth);
    }
  } else if (envelope.commandType.startsWith('gold_trade.')) {
    await readGoldTrade(payload.tradeId, auth);
  }
}

function needsReview(envelope, payload) {
  if (envelope.commandType !== 'production.create') return false;
  const capture = payload.input.captureProvenance;
  return capture.participantIdentityState !== 'IDENTIFIED' || capture.sourceKind !== 'DIRECT';
}

async function writeTransition(transaction, receiptId, fromStatus, toStatus, details = {}) {
  await sequelize.query(
    `INSERT INTO sync_command_receipt_history(id,receipt_id,from_status,to_status,details)
     VALUES (:id,:receiptId,:fromStatus,:toStatus,CAST(:details AS jsonb))`,
    { replacements: { id: randomUUID(), receiptId, fromStatus, toStatus, details: JSON.stringify(details) }, transaction },
  );
}

export async function submitSyncCommand(rawEnvelope, auth, idempotencyKey) {
  const parsedEnvelope = syncEnvelopeSchema.safeParse(rawEnvelope);
  if (!parsedEnvelope.success) throw new AppError(400, 'INVALID_SYNC_ENVELOPE', 'Sync command envelope is invalid.', parsedEnvelope.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })));
  const envelope = parsedEnvelope.data;
  if (idempotencyKey !== envelope.clientMutationId) throw new AppError(400, 'IDEMPOTENCY_KEY_MISMATCH', 'Idempotency-Key must match clientMutationId.');
  const parsedPayload = parseCommandPayload(envelope);
  if (!parsedPayload.success) throw new AppError(400, 'INVALID_COMMAND_PAYLOAD', 'Command payload does not match the allowlisted command schema.', parsedPayload.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })));
  const payload = parsedPayload.data;
  const canonicalEnvelope = canonicalize(envelope);
  const requestHash = createHash('sha256').update(canonicalEnvelope).digest();

  const receiptId = randomUUID();
  await sequelize.transaction(async (transaction) => {
    await sequelize.query(`SELECT pg_advisory_xact_lock(hashtextextended(:lockKey, 0))`, {
      replacements: { lockKey: `sync:user:${auth.userId}:${envelope.clientMutationId}` }, transaction,
    });
    const [existing] = await sequelize.query(
      `SELECT id, actor_user_id, request_hash FROM sync_command_receipt WHERE client_mutation_id=:mutationId FOR UPDATE`,
      { replacements: { mutationId: envelope.clientMutationId }, type: QueryTypes.SELECT, transaction },
    );
    if (existing) {
      if (existing.actor_user_id !== auth.userId) throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'This mutation ID is already assigned to another recorder.');
      if (!Buffer.from(existing.request_hash).equals(requestHash)) throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'This mutation ID was already used with a different command envelope.');
      return;
    }
    await sequelize.query(
      `INSERT INTO sync_command_receipt(id,actor_user_id,client_mutation_id,command_type,schema_version,envelope,request_hash,status)
       VALUES (:id,:userId,:mutationId,:commandType,:schemaVersion,CAST(:envelope AS jsonb),:requestHash,'SERVER_RECEIVED')`,
      { replacements: { id: receiptId, userId: auth.userId, mutationId: envelope.clientMutationId, commandType: envelope.commandType, schemaVersion: envelope.schemaVersion, envelope: canonicalEnvelope, requestHash }, transaction },
    );
    await writeTransition(transaction, receiptId, null, 'SERVER_RECEIVED', { commandType: envelope.commandType });
  });

  try {
    return await sequelize.transaction(async (transaction) => {
      const [receipt] = await sequelize.query(
        `SELECT * FROM sync_command_receipt WHERE actor_user_id=:userId AND client_mutation_id=:mutationId FOR UPDATE`,
        { replacements: { userId: auth.userId, mutationId: envelope.clientMutationId }, type: QueryTypes.SELECT, transaction },
      );
      if (!receipt) throw new AppError(500, 'SYNC_RECEIPT_MISSING', 'The durable sync receipt could not be loaded.');
      if (receipt.status !== 'SERVER_RECEIVED') return receiptView(receipt);
      await validateContext(envelope, auth, transaction);
      await validateDependencies(envelope, auth.userId, payload, transaction);
      await validateParticipant(envelope, payload, transaction);
      await validateResourceAccess(envelope, payload, auth, transaction);

      let response;
      const versionOptions = { expectedVersion: envelope.expectedVersion };
      if (envelope.commandType === 'production.create') {
        response = await createProductionEvent(payload.siteId, payload.input, auth, envelope.clientMutationId, { transaction, expectedVersion: envelope.expectedVersion });
      } else if (envelope.commandType === 'production.measurement.add') {
        const input = { ...payload.input, occurredAt: payload.input.occurredAt ?? envelope.occurredAtClaimed };
        if (new Date(input.occurredAt).getTime() !== new Date(envelope.occurredAtClaimed).getTime()) throw new AppError(400, 'OCCURRENCE_TIME_MISMATCH', 'The command occurrence time must match its measurement payload.');
        response = await addOutputMeasurement(payload.siteId, payload.eventId, payload.outputId, input, auth, envelope.clientMutationId, { transaction, expectedVersion: envelope.expectedVersion });
      } else if (envelope.commandType === 'capture.acknowledgement.add') {
        const acknowledgement = { ...payload.acknowledgement, occurredAt: payload.acknowledgement.occurredAt ?? envelope.occurredAtClaimed };
        if (new Date(acknowledgement.occurredAt).getTime() !== new Date(envelope.occurredAtClaimed).getTime()) throw new AppError(400, 'OCCURRENCE_TIME_MISMATCH', 'The command occurrence time must match its acknowledgement payload.');
        response = await recordCaptureAcknowledgement(payload.siteId, payload.eventId, payload.captureProvenanceId, acknowledgement, auth, envelope.clientMutationId, { transaction, expectedVersion: envelope.expectedVersion });
      } else if (envelope.commandType === 'production.allocation.propose') {
        response = await createAllocationSet(payload.siteId, payload.eventId, payload.outputId, payload.input, auth, envelope.clientMutationId, versionOptions);
      } else if (envelope.commandType === 'stockpile.transfer') {
        response = await transferBetweenStockpiles(payload.sourceLocationId, payload.input, auth, envelope.clientMutationId, versionOptions);
      } else if (envelope.commandType === 'inventory.adjustment.create') {
        response = await adjustInventory(payload.locationId, payload.input, auth, envelope.clientMutationId, versionOptions);
      } else if (envelope.commandType === 'consignment.dispatch') {
        response = await dispatchConsignment(payload.consignmentId, payload.input, auth, envelope.clientMutationId, versionOptions);
      } else if (envelope.commandType === 'consignment.receipt.add') {
        response = await receiveConsignment(payload.consignmentId, payload.input, auth, envelope.clientMutationId, versionOptions);
      } else if (envelope.commandType === 'consignment.receipt.correct') {
        response = await correctConsignmentReceiptItem(payload.consignmentId, payload.receiptItemId, payload.input, auth, envelope.clientMutationId, versionOptions);
      } else if (envelope.commandType === 'consignment.custody.offer') {
        response = await createCustodyOffer(payload.consignmentId, payload.input, auth, envelope.clientMutationId, versionOptions);
      } else if (envelope.commandType === 'custody.transfer.decide') {
        const [tradeTransfer] = await sequelize.query(`SELECT l.trade_id FROM custody_transfer ct
          JOIN gold_trade_line l ON l.id=ct.gold_trade_line_id WHERE ct.id=:id`, {
          replacements: { id: payload.transferId }, type: QueryTypes.SELECT, transaction,
        });
        response = tradeTransfer
          ? await decideGoldCustodyTransfer(tradeTransfer.trade_id, payload.transferId, payload.input, auth, envelope.clientMutationId, versionOptions)
          : await decideCustodyTransfer(payload.transferId, payload.input, auth, envelope.clientMutationId, versionOptions);
      } else if (envelope.commandType === 'gold_trade.measurement.add') {
        response = await recordGoldTradeMeasurement(payload.tradeId, payload.lineId, payload.input, auth, envelope.clientMutationId, versionOptions);
      } else if (envelope.commandType === 'gold_trade.custody.offer') {
        response = await createGoldCustodyOffer(payload.tradeId, payload.lineId, payload.input, auth, envelope.clientMutationId, versionOptions);
      } else {
        response = await recordGoldTradeAssay(payload.tradeId, payload.lineId, payload.input, auth, envelope.clientMutationId, versionOptions);
      }
      const status = needsReview(envelope, payload) ? 'NEEDS_REVIEW' : 'SERVER_ACCEPTED';
      const responseJson = JSON.stringify(response);
      await sequelize.query(
        `UPDATE sync_command_receipt SET status=:status,response_json=CAST(:response AS jsonb),resolved_at=now() WHERE id=:receiptId`,
        { replacements: { status, response: responseJson, receiptId: receipt.id }, transaction },
      );
      await writeTransition(transaction, receipt.id, 'SERVER_RECEIVED', status, { domainResponseStored: true });
      return receiptView({ ...receipt, status, response_json: response, resolved_at: new Date() });
    });
  } catch (error) {
    const pgCode = error.original?.code ?? error.parent?.code;
    const pgClientErrors = new Set(['23502', '23503', '23505', '23514', '22P02', '40001', '40P01', '55000']);
    if ((error instanceof AppError && error.status >= 500) || (!(error instanceof AppError) && !pgClientErrors.has(pgCode))) throw error;
    const httpStatus = error instanceof AppError
      ? error.status
      : ['23505', '40001', '40P01', '55000'].includes(pgCode) ? 409 : 400;
    const status = httpStatus === 409 ? 'CONFLICT' : 'REJECTED';
    return sequelize.transaction(async (transaction) => {
      const [receipt] = await sequelize.query(
        `SELECT * FROM sync_command_receipt WHERE actor_user_id=:userId AND client_mutation_id=:mutationId FOR UPDATE`,
        { replacements: { userId: auth.userId, mutationId: envelope.clientMutationId }, type: QueryTypes.SELECT, transaction },
      );
      if (!receipt || receipt.status !== 'SERVER_RECEIVED') return receiptView(receipt);
      const errorJson = {
        code: error.code ?? ({ 23502: 'INVALID_INPUT', 23503: 'INVALID_RELATIONSHIP', 23505: 'DUPLICATE_RECORD', 23514: 'INVALID_STATE', '22P02': 'INVALID_INPUT', '40001': 'CONCURRENT_CONFLICT', '40P01': 'CONCURRENT_CONFLICT', 55000: 'IMMUTABLE_RECORD' }[pgCode] ?? 'COMMAND_REJECTED'),
        message: error instanceof AppError ? error.message : 'The command violates a current database integrity rule.',
        ...(error.details ? { details: error.details } : {}),
      };
      await sequelize.query(
        `UPDATE sync_command_receipt SET status=:status,error_json=CAST(:error AS jsonb),resolved_at=now() WHERE id=:receiptId`,
        { replacements: { status, error: JSON.stringify(errorJson), receiptId: receipt.id }, transaction },
      );
      await writeTransition(transaction, receipt.id, 'SERVER_RECEIVED', status, errorJson);
      return receiptView({ ...receipt, status, error_json: errorJson, resolved_at: new Date() });
    });
  }
}

export async function getSyncCommandVersion(rawEnvelope, auth) {
  const parsedEnvelope = syncEnvelopeSchema.safeParse(rawEnvelope);
  if (!parsedEnvelope.success) throw new AppError(400, 'INVALID_SYNC_ENVELOPE', 'Sync command envelope is invalid.', parsedEnvelope.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })));
  const envelope = parsedEnvelope.data;
  if (envelope.recorderUserId !== auth.userId) throw new AppError(403, 'RECORDER_MISMATCH', 'The recorder must be the authenticated account.');
  const parsedPayload = parseCommandPayload(envelope);
  if (!parsedPayload.success) throw new AppError(400, 'INVALID_COMMAND_PAYLOAD', 'Command payload does not match the allowlisted command schema.', parsedPayload.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })));
  const payload = parsedPayload.data;
  return sequelize.transaction(async (transaction) => {
    await validateContext(envelope, auth, transaction);
    await validateDependencies(envelope, auth.userId, payload, transaction);
    await validateParticipant(envelope, payload, transaction);
    await validateResourceAccess(envelope, payload, auth, transaction, { requireVersion: false });
    const target = commandVersionTarget(envelope.commandType, payload);
    const [head] = await sequelize.query(`SELECT last_sequence FROM audit_stream_head WHERE stream_kind=:kind AND stream_id=:id`, {
      replacements: { kind: target.streamKind, id: target.streamId }, type: QueryTypes.SELECT, transaction,
    });
    return { expectedVersion: { ...target, sequence: Number(head?.last_sequence ?? 0) } };
  });
}

export async function getSyncReceipt(userId, clientMutationId) {
  const [row] = await sequelize.query(
    `SELECT client_mutation_id,status,server_received_at,resolved_at,response_json,error_json
     FROM sync_command_receipt WHERE actor_user_id=:userId AND client_mutation_id=:mutationId`,
    { replacements: { userId, mutationId: clientMutationId }, type: QueryTypes.SELECT },
  );
  if (!row) throw new AppError(404, 'SYNC_RECEIPT_NOT_FOUND', 'Sync receipt was not found.');
  return receiptView(row);
}
