import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../database/connection.mjs';
import { MaterialBatch, MaterialEvent, MiningHole, ProductionEvent } from '../../database/models.mjs';
import { AppError } from '../../utils/errors.mjs';
import { appendAuditEvent } from '../audit/audit.service.mjs';
import { executeIdempotent } from '../commands/idempotency.service.mjs';
import { assertMeasurementSource, resolveMeasurementSourceParty } from '../measurements/source-attribution.service.mjs';

export async function createProductionEvent(siteId, input, auth, mutationId, options = {}) {
  const operation = (transaction) => executeIdempotent({ actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'production.create', siteId, input }, transaction }, async () => {
    const hole = await MiningHole.findOne({ where: { id: input.holeId, siteId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!hole) throw new AppError(400, 'INVALID_HOLE', 'The selected hole does not belong to this site.');
    const eventId = randomUUID();
    const eventCode = `EVT-${eventId}`;
    const actor = await sequelize.query(`SELECT person_party_id FROM user_account WHERE id=:userId`, { replacements: { userId: auth.userId }, type: QueryTypes.SELECT, transaction });
    const event = await MaterialEvent.create({
      id: eventId, eventCode, eventKind: 'PRODUCTION', occurredAtClaimed: new Date(input.occurredAt), responsiblePartyId: actor[0].person_party_id,
      actorUserId: auth.userId, currentStatus: 'SUBMITTED', schemaVersion: 1,
    }, { transaction });
    await ProductionEvent.create({ eventId, holeId: input.holeId, shiftOrPeriodRef: input.shiftOrPeriodRef ?? null }, { transaction });
    const participantRows = [];
    if (input.participantRelationshipIds?.length) {
      const relationships = await sequelize.query(
        `SELECT 'SITE'::text AS relationship_kind, r.id AS relationship_id, r.party_id, r.role_code,
                r.valid_from, r.valid_to, r.site_id AS site_id, NULL::uuid AS hole_id
         FROM site_party_role r WHERE r.id IN (:relationshipIds)
         UNION ALL
         SELECT 'HOLE'::text, r.id, r.party_id, r.role_code, r.valid_from, r.valid_to, h.site_id, r.hole_id
         FROM hole_party_role r JOIN mining_hole h ON h.id=r.hole_id WHERE r.id IN (:relationshipIds)`,
        { replacements: { relationshipIds: input.participantRelationshipIds }, type: QueryTypes.SELECT, transaction },
      );
      const occurredAt = new Date(input.occurredAt);
      if (relationships.length !== input.participantRelationshipIds.length || relationships.some((relationship) => (
        relationship.site_id !== siteId
        || (relationship.relationship_kind === 'HOLE' && relationship.hole_id !== input.holeId)
        || new Date(relationship.valid_from) > occurredAt
        || (relationship.valid_to && new Date(relationship.valid_to) <= occurredAt)
      ))) {
        throw new AppError(400, 'INVALID_PARTICIPANT_RELATIONSHIP', 'Each participant relationship must be effective for this production event and its selected site or hole.');
      }
      for (const relationship of relationships) {
        const participantId = randomUUID();
        await sequelize.query(
          `INSERT INTO production_event_participant(id,production_event_id,party_id,site_party_role_id,hole_party_role_id)
           VALUES (:id,:eventId,:partyId,:siteRoleId,:holeRoleId)`,
          { replacements: {
            id: participantId, eventId, partyId: relationship.party_id,
            siteRoleId: relationship.relationship_kind === 'SITE' ? relationship.relationship_id : null,
            holeRoleId: relationship.relationship_kind === 'HOLE' ? relationship.relationship_id : null,
          }, transaction },
        );
        participantRows.push({ partyId: relationship.party_id, roleCode: relationship.role_code, relationshipId: relationship.relationship_id, relationshipKind: relationship.relationship_kind });
      }
    }
    let captureResult = null;
    if (input.captureProvenance) {
      const capture = input.captureProvenance;
      const captureId = randomUUID();
      await sequelize.query(
        `INSERT INTO capture_provenance(id,material_event_id,actual_participant_party_id,participant_identity_state,entered_by_user_id,source_kind,occurred_at_claimed,source_reference,evidence_ref,note)
         VALUES (:id,:eventId,:actualPartyId,:identityState,:userId,:sourceKind,:occurredAt,:sourceReference,:evidenceRef,:note)`,
        { replacements: {
          id: captureId, eventId, actualPartyId: capture.actualParticipantPartyId ?? null,
          identityState: capture.participantIdentityState, userId: auth.userId,
          sourceKind: capture.sourceKind, occurredAt: capture.occurredAt ?? input.occurredAt,
          sourceReference: capture.sourceReference ?? null, evidenceRef: capture.evidenceRef ?? null, note: capture.note ?? null,
        }, transaction },
      );
      await sequelize.query(
        `INSERT INTO production_event_capture(production_event_id,capture_provenance_id) VALUES (:eventId,:captureId)`,
        { replacements: { eventId, captureId }, transaction },
      );
      let acknowledgement = null;
      if (capture.acknowledgement) {
        const supplied = capture.acknowledgement;
        if (supplied.status === 'ACKNOWLEDGED' && supplied.acknowledgedByPartyId !== capture.actualParticipantPartyId) {
          throw new AppError(400, 'INVALID_ACKNOWLEDGEMENT', 'An acknowledgement must identify the recorded participant.');
        }
        const acknowledgementId = randomUUID();
        await sequelize.query(
          `INSERT INTO capture_acknowledgement_event(id,capture_provenance_id,status,acknowledged_by_party_id,recorded_by_user_id,method,occurred_at_claimed,reason)
           VALUES (:id,:captureId,:status,:partyId,:userId,:method,:occurredAt,:reason)`,
          { replacements: {
            id: acknowledgementId, captureId, status: supplied.status,
            partyId: supplied.acknowledgedByPartyId ?? null, userId: auth.userId,
            method: supplied.method ?? null, occurredAt: supplied.occurredAt ?? null, reason: supplied.reason ?? null,
          }, transaction },
        );
        acknowledgement = { id: acknowledgementId, status: supplied.status, acknowledgedByPartyId: supplied.acknowledgedByPartyId ?? null };
      }
      captureResult = { id: captureId, participantIdentityState: capture.participantIdentityState, actualParticipantPartyId: capture.actualParticipantPartyId ?? null, sourceKind: capture.sourceKind, acknowledgement };
    }
    const outputs = [];
    for (const [index, outputInput] of input.outputs.entries()) {
      const batchId = randomUUID();
      const outputId = randomUUID();
      const batchCode = `BATCH-${batchId}`;
      await MaterialBatch.create({ id: batchId, batchCode, materialKind: outputInput.materialKind, currentStatus: 'ACTIVE' }, { transaction });
      await sequelize.query(
        `INSERT INTO material_event_output(id,event_id,batch_id,output_sequence,output_kind) VALUES (:id,:eventId,:batchId,:sequence,:outputKind)`,
        { replacements: { id: outputId, eventId, batchId, sequence: index + 1, outputKind: outputInput.outputKind ?? outputInput.materialKind }, transaction },
      );
      await sequelize.query(`INSERT INTO production_event_output(material_event_output_id,production_event_id) VALUES (:outputId,:eventId)`, { replacements: { outputId, eventId }, transaction });
      const measurementSetId = randomUUID();
      await sequelize.query(`INSERT INTO material_measurement_set(id,batch_id,material_event_output_id) VALUES (:id,:batchId,:outputId)`, { replacements: { id: measurementSetId, batchId, outputId }, transaction });
      const measurements = [];
      for (const measure of outputInput.measurements ?? []) {
        const measurementId = randomUUID();
        const occurredAt = measure.occurredAt ?? input.occurredAt;
        const sourcePartyId = resolveMeasurementSourceParty(measure, auth);
        await assertMeasurementSource({
          sourcePartyId, sourceRole: measure.sourceRole, auth, occurredAt, productionEventId: eventId, transaction,
        });
        await sequelize.query(
          `INSERT INTO material_measurement(id,measurement_set_id,measurement_kind,quantity_g,source_value,source_unit_code,conversion_version,source_role,source_party_id,entered_by_user_id,method_code,instrument_ref,occurred_at_claimed,evidence_ref)
           VALUES (:id,:setId,:kind,:quantity,:sourceValue,:unit,:conversion,:sourceRole,:sourcePartyId,:userId,:method,:instrument,:occurredAt,:evidenceRef)`,
          { replacements: {
            id: measurementId, setId: measurementSetId, kind: measure.kind, quantity: measure.quantityGrams, sourceValue: measure.sourceValue,
            unit: measure.sourceUnit, conversion: measure.conversionVersion, sourceRole: measure.sourceRole,
            sourcePartyId, userId: auth.userId, method: measure.methodCode ?? null,
            instrument: measure.instrumentRef ?? null, occurredAt, evidenceRef: measure.evidenceRef ?? null,
          }, transaction },
        );
        measurements.push({ id: measurementId, kind: measure.kind, quantityGrams: measure.quantityGrams, enteredAt: new Date() });
      }
      outputs.push({ id: outputId, batchId, batchCode, materialKind: outputInput.materialKind, measurementSetId, measurements });
    }
    await appendAuditEvent({
      transaction, eventType: 'PRODUCTION.EVENT_RECORDED', actorUserId: auth.userId, actorPartyId: auth.personPartyId,
      occurredAt: new Date(input.occurredAt), clientMutationId: mutationId,
      payload: { production_event_id: eventId, site_id: siteId, hole_id: input.holeId, output_ids: outputs.map((row) => row.id), output_count: outputs.length },
      streams: [{ kind: 'material_event', id: eventId }, { kind: 'mining_hole', id: input.holeId }, ...outputs.map((row) => ({ kind: 'material_batch', id: row.batchId }))],
      expectedVersions: options.expectedVersion ? [{ kind: options.expectedVersion.streamKind, id: options.expectedVersion.streamId, sequence: options.expectedVersion.sequence }] : [],
    });
    return { id: event.id, eventCode: event.eventCode, eventKind: event.eventKind, siteId, holeId: input.holeId, occurredAt: input.occurredAt, recordedAt: event.recordedAt, participants: participantRows, captureProvenance: captureResult, outputs };
  });
  return options.transaction ? operation(options.transaction) : sequelize.transaction(operation);
}

export async function addOutputMeasurement(siteId, eventId, outputId, input, auth, mutationId, options = {}) {
  const operation = (transaction) => executeIdempotent({ actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'measurement.add', siteId, eventId, outputId, input }, transaction }, async () => {
    const rows = await sequelize.query(
      `SELECT eo.id AS output_id, eo.batch_id, ms.id AS measurement_set_id, pe.event_id AS production_event_id
       FROM production_event pe JOIN mining_hole h ON h.id=pe.hole_id
       JOIN production_event_output peo ON peo.production_event_id=pe.event_id
       JOIN material_event_output eo ON eo.id=peo.material_event_output_id
       JOIN material_measurement_set ms ON ms.material_event_output_id=eo.id AND ms.batch_id=eo.batch_id
       WHERE pe.event_id=:eventId AND eo.id=:outputId AND h.site_id=:siteId FOR UPDATE OF ms`,
      { replacements: { eventId, outputId, siteId }, type: QueryTypes.SELECT, transaction },
    );
    if (!rows.length) throw new AppError(404, 'PRODUCTION_OUTPUT_NOT_FOUND', 'Production output was not found for this site.');
    const occurredAt = input.occurredAt;
    const sourcePartyId = resolveMeasurementSourceParty(input, auth);
    await assertMeasurementSource({
      sourcePartyId, sourceRole: input.sourceRole, auth, occurredAt,
      productionEventId: rows[0].production_event_id, transaction,
    });
    const measurementId = randomUUID();
    await sequelize.query(
      `INSERT INTO material_measurement(id,measurement_set_id,measurement_kind,quantity_g,source_value,source_unit_code,conversion_version,source_role,source_party_id,entered_by_user_id,method_code,instrument_ref,occurred_at_claimed,evidence_ref,supersedes_measurement_id)
       VALUES (:id,:setId,:kind,:quantity,:sourceValue,:unit,:conversion,:sourceRole,:sourcePartyId,:userId,:method,:instrument,:occurredAt,:evidenceRef,:supersedesId)`,
      { replacements: { id: measurementId, setId: rows[0].measurement_set_id, kind: input.kind, quantity: input.quantityGrams, sourceValue: input.sourceValue, unit: input.sourceUnit, conversion: input.conversionVersion, sourceRole: input.sourceRole, sourcePartyId, userId: auth.userId, method: input.methodCode ?? null, instrument: input.instrumentRef ?? null, occurredAt, evidenceRef: input.evidenceRef ?? null, supersedesId: input.supersedesMeasurementId ?? null }, transaction },
    );
    await appendAuditEvent({ transaction, eventType: 'MEASUREMENT.RECORDED', actorUserId: auth.userId, actorPartyId: auth.personPartyId, occurredAt: new Date(input.occurredAt), clientMutationId: mutationId, payload: { measurement_id: measurementId, measurement_set_id: rows[0].measurement_set_id, batch_id: rows[0].batch_id, kind: input.kind, quantity_grams: input.quantityGrams }, streams: [{ kind: 'material_batch', id: rows[0].batch_id }, { kind: 'material_event', id: eventId }], expectedVersions: options.expectedVersion ? [{ kind: options.expectedVersion.streamKind, id: options.expectedVersion.streamId, sequence: options.expectedVersion.sequence }] : [] });
    return { id: measurementId, measurementSetId: rows[0].measurement_set_id, batchId: rows[0].batch_id, kind: input.kind, quantityGrams: input.quantityGrams, occurredAt: input.occurredAt, supersedesMeasurementId: input.supersedesMeasurementId ?? null, enteredAt: new Date() };
  });
  return options.transaction ? operation(options.transaction) : sequelize.transaction(operation);
}

export async function recordCaptureAcknowledgement(siteId, eventId, captureProvenanceId, acknowledgement, auth, mutationId, options = {}) {
  const operation = (transaction) => executeIdempotent({
    actorScope: `user:${auth.userId}`, mutationId,
    payload: { action: 'capture.acknowledgement.add', siteId, eventId, captureProvenanceId, acknowledgement }, transaction,
  }, async () => {
    const [capture] = await sequelize.query(
      `SELECT cp.actual_participant_party_id, cp.participant_identity_state, pe.hole_id
       FROM capture_provenance cp JOIN production_event_capture pec ON pec.capture_provenance_id=cp.id
       JOIN production_event pe ON pe.event_id=pec.production_event_id
       JOIN mining_hole h ON h.id=pe.hole_id
       WHERE cp.id=:captureId AND pe.event_id=:eventId AND h.site_id=:siteId
       FOR UPDATE OF cp`,
      { replacements: { captureId: captureProvenanceId, eventId, siteId }, type: QueryTypes.SELECT, transaction },
    );
    if (!capture) throw new AppError(404, 'CAPTURE_NOT_FOUND', 'Capture provenance was not found for this site and event.');
    if (capture.participant_identity_state !== 'IDENTIFIED' || capture.actual_participant_party_id !== auth.personPartyId) {
      throw new AppError(403, 'PARTICIPANT_ACKNOWLEDGEMENT_REQUIRED', 'Only the identified participant account can record an acknowledgement or dispute.');
    }
    if (acknowledgement.status === 'ACKNOWLEDGED' && acknowledgement.acknowledgedByPartyId !== auth.personPartyId) {
      throw new AppError(403, 'PARTICIPANT_ACKNOWLEDGEMENT_REQUIRED', 'The acknowledging party must be the authenticated participant.');
    }
    const acknowledgementId = randomUUID();
    await sequelize.query(
      `INSERT INTO capture_acknowledgement_event(id,capture_provenance_id,status,acknowledged_by_party_id,recorded_by_user_id,method,occurred_at_claimed,reason)
       VALUES (:id,:captureId,:status,:partyId,:userId,:method,:occurredAt,:reason)`,
      { replacements: {
        id: acknowledgementId, captureId: captureProvenanceId, status: acknowledgement.status,
        partyId: acknowledgement.acknowledgedByPartyId ?? null, userId: auth.userId,
        method: acknowledgement.method ?? null, occurredAt: acknowledgement.occurredAt ?? null, reason: acknowledgement.reason ?? null,
      }, transaction },
    );
    await appendAuditEvent({
      transaction, eventType: 'CAPTURE.ACKNOWLEDGEMENT_RECORDED', actorUserId: auth.userId, actorPartyId: auth.personPartyId,
      occurredAt: acknowledgement.occurredAt ? new Date(acknowledgement.occurredAt) : new Date(), clientMutationId: mutationId,
      payload: { capture_provenance_id: captureProvenanceId, acknowledgement_id: acknowledgementId, status: acknowledgement.status },
      streams: [{ kind: 'material_event', id: eventId }, { kind: 'mining_hole', id: capture.hole_id }],
      expectedVersions: options.expectedVersion ? [{ kind: options.expectedVersion.streamKind, id: options.expectedVersion.streamId, sequence: options.expectedVersion.sequence }] : [],
    });
    return { id: acknowledgementId, captureProvenanceId, status: acknowledgement.status, acknowledgedByPartyId: acknowledgement.acknowledgedByPartyId ?? null, recordedByUserId: auth.userId };
  });
  return options.transaction ? operation(options.transaction) : sequelize.transaction(operation);
}

export async function listProductionEvents(siteId) {
  return sequelize.query(
    `SELECT me.id, me.event_code, me.event_kind, me.occurred_at_claimed, me.recorded_at, me.current_status,
       pe.hole_id, h.hole_code, count(DISTINCT eo.id)::int AS output_count
     FROM material_event me JOIN production_event pe ON pe.event_id=me.id JOIN mining_hole h ON h.id=pe.hole_id
     LEFT JOIN production_event_output peo ON peo.production_event_id=pe.event_id
     LEFT JOIN material_event_output eo ON eo.id=peo.material_event_output_id
     WHERE h.site_id=:siteId GROUP BY me.id, pe.hole_id, h.hole_code ORDER BY me.recorded_at DESC`,
    { replacements: { siteId }, type: QueryTypes.SELECT },
  );
}

export async function getProductionEvent(siteId, eventId) {
  const [event] = await sequelize.query(
    `SELECT me.id, me.event_code, me.event_kind, me.occurred_at_claimed, me.recorded_at, me.current_status, pe.hole_id, h.hole_code
     FROM material_event me JOIN production_event pe ON pe.event_id=me.id JOIN mining_hole h ON h.id=pe.hole_id
     WHERE me.id=:eventId AND h.site_id=:siteId`,
    { replacements: { eventId, siteId }, type: QueryTypes.SELECT },
  );
  if (!event) throw new AppError(404, 'PRODUCTION_EVENT_NOT_FOUND', 'Production event was not found for this site.');
  const outputs = await sequelize.query(
    `SELECT eo.id, eo.batch_id, mb.batch_code, mb.material_kind, ms.id AS measurement_set_id
     FROM production_event_output peo JOIN material_event_output eo ON eo.id=peo.material_event_output_id
     JOIN material_batch mb ON mb.id=eo.batch_id JOIN material_measurement_set ms ON ms.material_event_output_id=eo.id AND ms.batch_id=eo.batch_id
     WHERE peo.production_event_id=:eventId ORDER BY eo.output_sequence`,
    { replacements: { eventId }, type: QueryTypes.SELECT },
  );
  const measurements = await sequelize.query(
    `SELECT id, measurement_set_id, measurement_kind, quantity_g, source_value, source_unit_code, conversion_version, source_role, source_party_id, occurred_at_claimed, entered_at, method_code, instrument_ref, supersedes_measurement_id
     FROM material_measurement WHERE measurement_set_id IN (SELECT id FROM material_measurement_set WHERE material_event_output_id IN (SELECT material_event_output_id FROM production_event_output WHERE production_event_id=:eventId))
     ORDER BY entered_at, id`,
    { replacements: { eventId }, type: QueryTypes.SELECT },
  );
  const participants = await sequelize.query(
    `SELECT p.party_id, COALESCE(sr.role_code, hr.role_code) AS role_code,
            COALESCE(p.site_party_role_id, p.hole_party_role_id) AS relationship_id,
            CASE WHEN p.site_party_role_id IS NULL THEN 'HOLE' ELSE 'SITE' END AS relationship_kind
     FROM production_event_participant p
     LEFT JOIN site_party_role sr ON sr.id=p.site_party_role_id
     LEFT JOIN hole_party_role hr ON hr.id=p.hole_party_role_id
     WHERE p.production_event_id=:eventId ORDER BY relationship_id`,
    { replacements: { eventId }, type: QueryTypes.SELECT },
  );
  const [capture] = await sequelize.query(
    `SELECT cp.id, cp.actual_participant_party_id, cp.participant_identity_state, cp.source_kind,
            cp.occurred_at_claimed, cp.entered_at, cp.source_reference, cp.evidence_ref,
            ack.status AS acknowledgement_status, ack.acknowledged_by_party_id, ack.occurred_at_claimed AS acknowledgement_occurred_at
     FROM production_event_capture pec JOIN capture_provenance cp ON cp.id=pec.capture_provenance_id
     LEFT JOIN LATERAL (
       SELECT status, acknowledged_by_party_id, occurred_at_claimed
       FROM capture_acknowledgement_event WHERE capture_provenance_id=cp.id
       ORDER BY recorded_at DESC, id DESC LIMIT 1
     ) ack ON true
     WHERE pec.production_event_id=:eventId`,
    { replacements: { eventId }, type: QueryTypes.SELECT },
  );
  const [auditHead] = await sequelize.query(
    `SELECT last_sequence FROM audit_stream_head WHERE stream_kind='material_event' AND stream_id=:eventId`,
    { replacements: { eventId }, type: QueryTypes.SELECT },
  );
  return {
    ...event,
    auditSequence: Number(auditHead?.last_sequence ?? 0),
    participants,
    captureProvenance: capture ?? null,
    outputs: outputs.map((output) => ({ ...output, measurements: measurements.filter((measurement) => measurement.measurement_set_id === output.measurement_set_id) })),
  };
}
