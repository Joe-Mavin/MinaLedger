import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../database/connection.mjs';
import { AppError } from '../../utils/errors.mjs';
import { appendAuditEvent } from '../audit/audit.service.mjs';
import { executeIdempotent } from '../commands/idempotency.service.mjs';

function decimalToScaledInteger(value, scale) {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * (10n ** BigInt(scale)) + BigInt(fraction.padEnd(scale, '0'));
}

export async function createAllocationSet(siteId, eventId, outputId, input, auth, mutationId) {
  return sequelize.transaction(async (transaction) => executeIdempotent({
    actorScope: `user:${auth.userId}`, mutationId,
    payload: { action: 'allocation.propose', siteId, eventId, outputId, input }, transaction,
  }, async () => {
    const [output] = await sequelize.query(
      `SELECT eo.id AS output_id, eo.batch_id, pe.event_id, h.id AS hole_id, me.occurred_at_claimed AS event_occurred_at
       FROM production_event_output peo JOIN material_event_output eo ON eo.id=peo.material_event_output_id
       JOIN production_event pe ON pe.event_id=peo.production_event_id
       JOIN material_event me ON me.id=pe.event_id
       JOIN mining_hole h ON h.id=pe.hole_id
       WHERE pe.event_id=:eventId AND eo.id=:outputId AND h.site_id=:siteId
       FOR UPDATE OF peo, eo`,
      { replacements: { siteId, eventId, outputId }, type: QueryTypes.SELECT, transaction },
    );
    if (!output) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');

    const beneficiaryIds = input.rows.map((row) => row.beneficiaryPartyId);
    const eligibleBeneficiaries = await sequelize.query(
      `SELECT DISTINCT candidate.party_id
       FROM unnest(ARRAY[:beneficiaryIds]::uuid[]) AS candidate(party_id)
       JOIN party beneficiary ON beneficiary.id=candidate.party_id AND beneficiary.status='ACTIVE'
       WHERE EXISTS (
         SELECT 1 FROM site_party_role r
         WHERE r.site_id=:siteId AND r.party_id=candidate.party_id AND r.role_code='BENEFICIARY'
           AND r.status='ACTIVE' AND r.valid_from<=:eventOccurredAt AND (r.valid_to IS NULL OR r.valid_to>:eventOccurredAt)
       ) OR EXISTS (
         SELECT 1 FROM hole_party_role r
         WHERE r.hole_id=:holeId AND r.party_id=candidate.party_id AND r.role_code='BENEFICIARY'
           AND r.status='ACTIVE' AND r.valid_from<=:eventOccurredAt AND (r.valid_to IS NULL OR r.valid_to>:eventOccurredAt)
       )`,
      {
        replacements: { beneficiaryIds, siteId, holeId: output.hole_id, eventOccurredAt: output.event_occurred_at },
        type: QueryTypes.SELECT, transaction,
      },
    );
    if (eligibleBeneficiaries.length !== beneficiaryIds.length) {
      throw new AppError(400, 'INVALID_ALLOCATION_BENEFICIARY', 'Each beneficiary needs an active, effective beneficiary relationship to this site or hole at the production event time.');
    }

    let [chain] = await sequelize.query(
      `SELECT id, active_approved_set_id FROM production_allocation_chain
       WHERE production_event_output_id=:outputId FOR UPDATE`,
      { replacements: { outputId }, type: QueryTypes.SELECT, transaction },
    );
    let revisionNo = 1;
    let revisionKind = 'ORIGINAL';
    let predecessorId = null;
    if (chain) {
      if (chain.active_approved_set_id) {
        throw new AppError(409, 'ALLOCATION_REVIEW_REQUIRED', 'This output has a current approved allocation. A policy-authorized review is required before a correction can be submitted.');
      }
      const [latest] = await sequelize.query(
        `SELECT s.id, s.revision_no, r.review_status
         FROM production_allocation_set s
         LEFT JOIN LATERAL (
           SELECT review_status FROM allocation_set_review_event
           WHERE production_allocation_set_id=s.id ORDER BY review_sequence DESC LIMIT 1
         ) r ON true
         WHERE s.allocation_chain_id=:chainId ORDER BY s.revision_no DESC LIMIT 1`,
        { replacements: { chainId: chain.id }, type: QueryTypes.SELECT, transaction },
      );
      if (!latest || input.supersedesSetId !== latest.id) {
        throw new AppError(409, 'ALLOCATION_REVISION_CONFLICT', 'A complete correction must identify the current latest revision.');
      }
      if (latest.review_status === 'APPROVED') {
        throw new AppError(409, 'ALLOCATION_REVIEW_REQUIRED', 'An approved allocation cannot be retargeted by a new proposal.');
      }
      predecessorId = latest.id;
      revisionNo = Number(latest.revision_no) + 1;
      revisionKind = 'CORRECTION';
    } else {
      if (input.supersedesSetId) throw new AppError(409, 'ALLOCATION_REVISION_CONFLICT', 'The named predecessor does not exist for this output.');
      const chainId = randomUUID();
      await sequelize.query(
        `INSERT INTO production_allocation_chain(id,production_event_output_id) VALUES (:id,:outputId)`,
        { replacements: { id: chainId, outputId }, transaction },
      );
      chain = { id: chainId, active_approved_set_id: null };
    }

    let basisMeasurement = null;
    if (input.basisKind === 'QUANTITY') {
      [basisMeasurement] = await sequelize.query(
        `SELECT m.id, m.measurement_set_id, m.quantity_g
         FROM material_measurement m JOIN material_measurement_set ms ON ms.id=m.measurement_set_id
         WHERE m.id=:measurementId AND ms.material_event_output_id=:outputId AND ms.batch_id=:batchId`,
        { replacements: { measurementId: input.basisMeasurementId, outputId, batchId: output.batch_id }, type: QueryTypes.SELECT, transaction },
      );
      if (!basisMeasurement) throw new AppError(400, 'INVALID_ALLOCATION_BASIS', 'The selected observation does not belong to this exact production output.');
      const allocated = input.rows.reduce((sum, row) => sum + decimalToScaledInteger(row.allocatedQuantityGrams, 6), 0n);
      const basis = decimalToScaledInteger(basisMeasurement.quantity_g, 6);
      if (allocated > basis) throw new AppError(400, 'ALLOCATION_EXCEEDS_BASIS', 'Allocation quantities exceed the explicitly selected observation.');
    } else {
      const shareTotal = input.rows.reduce((sum, row) => sum + decimalToScaledInteger(row.allocatedShare, 9), 0n);
      if (shareTotal > 1_000_000_000n) throw new AppError(400, 'ALLOCATION_EXCEEDS_BASIS', 'Allocation shares exceed 1.0.');
    }

    const setId = randomUUID();
    await sequelize.query(
      `INSERT INTO production_allocation_set(
         id,allocation_chain_id,revision_no,revision_kind,basis_kind,basis_measurement_set_id,
         basis_measurement_id,supersedes_set_id,correction_reason,proposed_by_user_id
       ) VALUES (:id,:chainId,:revisionNo,:revisionKind,:basisKind,:basisSetId,:basisMeasurementId,:predecessorId,:reason,:userId)`,
      { replacements: {
        id: setId, chainId: chain.id, revisionNo, revisionKind, basisKind: input.basisKind,
        basisSetId: basisMeasurement?.measurement_set_id ?? null, basisMeasurementId: basisMeasurement?.id ?? null,
        predecessorId, reason: input.correctionReason ?? null, userId: auth.userId,
      }, transaction },
    );
    for (const row of input.rows) {
      await sequelize.query(
        `INSERT INTO production_allocation_row(id,allocation_set_id,beneficiary_party_id,allocation_basis,allocated_quantity_g,allocated_share)
         VALUES (:id,:setId,:beneficiaryId,:basis,:quantity,:share)`,
        { replacements: {
          id: randomUUID(), setId, beneficiaryId: row.beneficiaryPartyId, basis: input.basisKind,
          quantity: row.allocatedQuantityGrams ?? null, share: row.allocatedShare ?? null,
        }, transaction },
      );
    }
    await sequelize.query(
      `INSERT INTO allocation_set_review_event(id,production_allocation_set_id,review_sequence,review_status,actor_user_id,occurred_at)
       VALUES (:id,:setId,1,'PENDING',:userId,now())`,
      { replacements: { id: randomUUID(), setId, userId: auth.userId }, transaction },
    );
    await appendAuditEvent({
      transaction, eventType: 'PRODUCTION_ALLOCATION.PROPOSED', actorUserId: auth.userId, actorPartyId: auth.personPartyId,
      occurredAt: new Date(), clientMutationId: mutationId,
      payload: {
        allocation_chain_id: chain.id, allocation_set_id: setId, production_event_id: eventId,
        production_event_output_id: outputId, revision_no: revisionNo, revision_kind: revisionKind,
        basis_kind: input.basisKind, basis_measurement_id: basisMeasurement?.id ?? null,
        beneficiary_count: input.rows.length,
      },
      streams: [
        { kind: 'allocation_chain', id: chain.id }, { kind: 'material_event', id: eventId },
        { kind: 'material_batch', id: output.batch_id },
        ...input.rows.map((row) => ({ kind: 'party', id: row.beneficiaryPartyId })),
      ],
    });
    return {
      id: setId, allocationChainId: chain.id, productionEventOutputId: outputId,
      revisionNo, revisionKind, basisKind: input.basisKind,
      basisMeasurementId: basisMeasurement?.id ?? null, supersedesSetId: predecessorId,
      reviewStatus: 'PENDING', approvalAvailable: false,
      rows: input.rows.map((row) => ({
        beneficiaryPartyId: row.beneficiaryPartyId,
        allocatedQuantityGrams: row.allocatedQuantityGrams ?? null,
        allocatedShare: row.allocatedShare ?? null,
      })),
    };
  }));
}

export async function getOutputAllocations(siteId, eventId, outputId) {
  const [output] = await sequelize.query(
    `SELECT eo.id, pe.event_id FROM production_event_output peo
     JOIN material_event_output eo ON eo.id=peo.material_event_output_id
     JOIN production_event pe ON pe.event_id=peo.production_event_id
     JOIN mining_hole h ON h.id=pe.hole_id
     WHERE pe.event_id=:eventId AND eo.id=:outputId AND h.site_id=:siteId`,
    { replacements: { siteId, eventId, outputId }, type: QueryTypes.SELECT },
  );
  if (!output) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  const [chain] = await sequelize.query(
    `SELECT id, active_approved_set_id FROM production_allocation_chain WHERE production_event_output_id=:outputId`,
    { replacements: { outputId }, type: QueryTypes.SELECT },
  );
  if (!chain) return { productionEventOutputId: outputId, allocationChainId: null, activeApprovedSetId: null, revisions: [] };
  const revisions = await sequelize.query(
    `SELECT id, revision_no, revision_kind, basis_kind, basis_measurement_set_id, basis_measurement_id,
            supersedes_set_id, correction_reason, proposed_by_user_id, created_at
     FROM production_allocation_set WHERE allocation_chain_id=:chainId ORDER BY revision_no`,
    { replacements: { chainId: chain.id }, type: QueryTypes.SELECT },
  );
  const rows = await sequelize.query(
    `SELECT r.id, r.allocation_set_id, r.beneficiary_party_id, r.allocation_basis, r.allocated_quantity_g, r.allocated_share
     FROM production_allocation_row r JOIN production_allocation_set s ON s.id=r.allocation_set_id
     WHERE s.allocation_chain_id=:chainId ORDER BY s.revision_no, r.created_at, r.id`,
    { replacements: { chainId: chain.id }, type: QueryTypes.SELECT },
  );
  const reviews = await sequelize.query(
    `SELECT id, production_allocation_set_id, review_sequence, review_status, authorized_basis_measurement_id,
            actor_user_id, reason, evidence_ref, occurred_at, recorded_at
     FROM allocation_set_review_event WHERE production_allocation_set_id IN (
       SELECT id FROM production_allocation_set WHERE allocation_chain_id=:chainId
     ) ORDER BY production_allocation_set_id, review_sequence`,
    { replacements: { chainId: chain.id }, type: QueryTypes.SELECT },
  );
  return {
    productionEventOutputId: outputId, allocationChainId: chain.id, activeApprovedSetId: chain.active_approved_set_id,
    revisions: revisions.map((revision) => ({
      ...revision,
      rows: rows.filter((row) => row.allocation_set_id === revision.id),
      reviewHistory: reviews.filter((review) => review.production_allocation_set_id === revision.id),
    })),
  };
}
