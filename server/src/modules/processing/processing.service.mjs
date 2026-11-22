import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../database/connection.mjs';
import { AppError } from '../../utils/errors.mjs';
import { canAccessHole, canAccessProcessingFacility } from '../../middleware/auth.mjs';
import { appendAuditEvent } from '../audit/audit.service.mjs';
import { executeIdempotent } from '../commands/idempotency.service.mjs';
import { assertMeasurementSource, resolveMeasurementSourceParty } from '../measurements/source-attribution.service.mjs';

async function insertMeasurement({
  measurementSetId, batchId, measure, auth, fallbackOccurredAt, transaction,
  processingEventId, sourceProductionEventId = null,
}) {
  const occurredAt = measure.occurredAt ?? fallbackOccurredAt;
  const sourcePartyId = resolveMeasurementSourceParty(measure, auth);
  await assertMeasurementSource({
    sourcePartyId, sourceRole: measure.sourceRole, auth, occurredAt,
    processingEventId, sourceProductionEventId, transaction,
  });
  const measurementId = randomUUID();
  await sequelize.query(
    `INSERT INTO material_measurement(
       id,measurement_set_id,measurement_kind,quantity_g,source_value,source_unit_code,conversion_version,
       source_role,source_party_id,entered_by_user_id,method_code,instrument_ref,occurred_at_claimed,evidence_ref,supersedes_measurement_id
     ) VALUES (
       :id,:setId,:kind,:quantity,:sourceValue,:unit,:conversion,:sourceRole,:sourcePartyId,:userId,
       :method,:instrument,:occurredAt,:evidenceRef,:supersedesId
     )`,
    { replacements: {
      id: measurementId, setId: measurementSetId, kind: measure.kind, quantity: measure.quantityGrams,
      sourceValue: measure.sourceValue, unit: measure.sourceUnit, conversion: measure.conversionVersion,
      sourceRole: measure.sourceRole, sourcePartyId,
      userId: auth.userId, method: measure.methodCode ?? null, instrument: measure.instrumentRef ?? null,
      occurredAt, evidenceRef: measure.evidenceRef ?? null,
      supersedesId: measure.supersedesMeasurementId ?? null,
    }, transaction },
  );
  return { id: measurementId, measurementSetId, batchId, kind: measure.kind, quantityGrams: measure.quantityGrams, occurredAt: measure.occurredAt ?? fallbackOccurredAt };
}

export async function createProcessingEvent(siteId, input, auth, mutationId) {
  if (!(await canAccessProcessingFacility(auth, input.processingFacilityId, { write: true }))) {
    throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  }
  return sequelize.transaction(async (transaction) => executeIdempotent({
    actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'processing.create', siteId, input }, transaction,
  }, async () => {
    const [facility] = await sequelize.query(
      `SELECT pf.id FROM processing_facility pf
       JOIN processing_facility_site pfs ON pfs.processing_facility_id=pf.id
       WHERE pf.id=:facilityId AND pfs.mining_site_id=:siteId AND pf.status='ACTIVE' FOR UPDATE OF pf`,
      { replacements: { facilityId: input.processingFacilityId, siteId }, type: QueryTypes.SELECT, transaction },
    );
    if (!facility) throw new AppError(400, 'INVALID_DORA', 'The selected Dora is not active at this mining site.');

    const sourceIds = input.inputs.map((row) => row.sourceProductionOutputId);
    const sources = await sequelize.query(
      `SELECT peo.material_event_output_id AS output_id, eo.event_id AS source_event_id, eo.batch_id,
              h.id AS hole_id, h.site_id
       FROM production_event_output peo
       JOIN material_event_output eo ON eo.id=peo.material_event_output_id
       JOIN production_event pe ON pe.event_id=peo.production_event_id
       JOIN mining_hole h ON h.id=pe.hole_id
       WHERE peo.material_event_output_id IN (:sourceIds) AND h.site_id=:siteId
       FOR SHARE OF peo, eo`,
      { replacements: { sourceIds, siteId }, type: QueryTypes.SELECT, transaction },
    );
    if (sources.length !== sourceIds.length) throw new AppError(400, 'INVALID_PROCESSING_INPUT', 'Each input must reference a production output from this site.');
    for (const source of sources) {
      if (!(await canAccessHole(auth, siteId, source.hole_id, { write: true }))) {
        throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
      }
    }

    const actor = auth.personPartyId;
    const eventId = randomUUID();
    const eventCode = `EVT-${eventId}`;
    const [eventRecord] = await sequelize.query(
      `INSERT INTO material_event(id,event_code,event_kind,occurred_at_claimed,responsible_party_id,actor_user_id,current_status)
       VALUES (:id,:code,'PROCESSING',:occurredAt,:actor,:userId,'SUBMITTED') RETURNING recorded_at`,
      { replacements: { id: eventId, code: eventCode, occurredAt: input.occurredAt, actor, userId: auth.userId }, type: QueryTypes.SELECT, transaction },
    );
    await sequelize.query(
      `INSERT INTO processing_event(event_id,processing_facility_id,operator_party_id,service_terms_ref,compensation_arrangement_code)
       VALUES (:eventId,:facilityId,:actor,:sourceRef,:arrangement)`,
      { replacements: {
        eventId, facilityId: input.processingFacilityId, actor,
        sourceRef: input.serviceTermsRef ?? null, arrangement: input.compensationArrangementCode ?? null,
      }, transaction },
    );

    const inputs = [];
    const sourceEvents = new Set();
    for (const [index, inputRow] of input.inputs.entries()) {
      const source = sources.find((item) => item.output_id === inputRow.sourceProductionOutputId);
      sourceEvents.add(source.source_event_id);
      const inputId = randomUUID();
      await sequelize.query(
        `INSERT INTO material_event_input(id,event_id,batch_id,input_sequence) VALUES (:id,:eventId,:batchId,:sequence)`,
        { replacements: { id: inputId, eventId, batchId: source.batch_id, sequence: index + 1 }, transaction },
      );
      await sequelize.query(
        `INSERT INTO processing_event_input(material_event_input_id,processing_event_id,source_production_output_id)
         VALUES (:inputId,:eventId,:sourceOutputId)`,
        { replacements: { inputId, eventId, sourceOutputId: inputRow.sourceProductionOutputId }, transaction },
      );
      const setId = randomUUID();
      await sequelize.query(
        `INSERT INTO material_measurement_set(id,batch_id,material_event_input_id) VALUES (:id,:batchId,:inputId)`,
        { replacements: { id: setId, batchId: source.batch_id, inputId }, transaction },
      );
      const measurements = [];
      for (const measure of inputRow.measurements) measurements.push(await insertMeasurement({
        measurementSetId: setId, batchId: source.batch_id, measure, auth,
        fallbackOccurredAt: input.occurredAt, transaction, processingEventId: eventId,
        sourceProductionEventId: source.source_event_id,
      }));
      inputs.push({ id: inputId, sourceProductionOutputId: source.output_id, sourceEventId: source.source_event_id, batchId: source.batch_id, measurementSetId: setId, measurements });
    }

    const outputs = [];
    for (const [index, outputRow] of input.outputs.entries()) {
      const batchId = randomUUID();
      const outputId = randomUUID();
      const batchCode = `BATCH-${batchId}`;
      await sequelize.query(
        `INSERT INTO material_batch(id,batch_code,material_kind,current_status) VALUES (:id,:code,:kind,'ACTIVE')`,
        { replacements: { id: batchId, code: batchCode, kind: outputRow.materialKind }, transaction },
      );
      await sequelize.query(
        `INSERT INTO material_event_output(id,event_id,batch_id,output_sequence,output_kind)
         VALUES (:id,:eventId,:batchId,:sequence,:outputKind)`,
        { replacements: { id: outputId, eventId, batchId, sequence: index + 1, outputKind: outputRow.outputKind ?? outputRow.outputRole }, transaction },
      );
      await sequelize.query(
        `INSERT INTO processing_event_output(material_event_output_id,processing_event_id,output_role)
         VALUES (:outputId,:eventId,:role)`,
        { replacements: { outputId, eventId, role: outputRow.outputRole }, transaction },
      );
      const setId = randomUUID();
      await sequelize.query(
        `INSERT INTO material_measurement_set(id,batch_id,material_event_output_id) VALUES (:id,:batchId,:outputId)`,
        { replacements: { id: setId, batchId, outputId }, transaction },
      );
      const measurements = [];
      for (const measure of outputRow.measurements) measurements.push(await insertMeasurement({
        measurementSetId: setId, batchId, measure, auth, fallbackOccurredAt: input.occurredAt, transaction,
        processingEventId: eventId,
      }));
      outputs.push({ id: outputId, batchId, batchCode, materialKind: outputRow.materialKind, outputRole: outputRow.outputRole, measurementSetId: setId, measurements });
    }

    const streams = [
      { kind: 'material_event', id: eventId },
      { kind: 'processing_facility', id: input.processingFacilityId },
      ...[...sourceEvents].map((id) => ({ kind: 'material_event', id })),
      ...sources.map((source) => ({ kind: 'mining_hole', id: source.hole_id })),
      ...inputs.map((row) => ({ kind: 'material_batch', id: row.batchId })),
      ...outputs.map((row) => ({ kind: 'material_batch', id: row.batchId })),
    ];
    await appendAuditEvent({
      transaction, eventType: 'DORA_PROCESSING.RECORDED', actorUserId: auth.userId, actorPartyId: auth.personPartyId,
      occurredAt: new Date(input.occurredAt), clientMutationId: mutationId,
      payload: {
        processing_event_id: eventId, site_id: siteId, processing_facility_id: input.processingFacilityId,
        input_count: inputs.length, output_count: outputs.length,
        input_batch_ids: inputs.map((row) => row.batchId), output_batch_ids: outputs.map((row) => row.batchId),
        compensation_arrangement_code: input.compensationArrangementCode ?? null,
        service_terms_ref: input.serviceTermsRef ?? null,
      },
      streams,
    });
    return {
      id: eventId, eventCode, eventKind: 'PROCESSING', processingFacilityId: input.processingFacilityId,
      operatorPartyId: actor, occurredAt: input.occurredAt, recordedAt: eventRecord.recorded_at,
      compensationArrangementCode: input.compensationArrangementCode ?? null, serviceTermsRef: input.serviceTermsRef ?? null,
      inputs, outputs,
    };
  }));
}

export async function getProcessingEvent(eventId) {
  const [event] = await sequelize.query(
    `SELECT me.id, me.event_code, me.occurred_at_claimed, me.recorded_at, me.current_status,
            pe.processing_facility_id, pf.name AS processing_facility_name, pe.operator_party_id,
            pe.compensation_arrangement_code, pe.service_terms_ref
     FROM processing_event pe JOIN material_event me ON me.id=pe.event_id
     JOIN processing_facility pf ON pf.id=pe.processing_facility_id WHERE pe.event_id=:eventId`,
    { replacements: { eventId }, type: QueryTypes.SELECT },
  );
  if (!event) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  const inputs = await sequelize.query(
    `SELECT mei.id, mei.batch_id, mb.batch_code, mb.material_kind, pei.source_production_output_id,
            source_eo.event_id AS source_event_id, ms.id AS measurement_set_id
     FROM processing_event_input pei JOIN material_event_input mei ON mei.id=pei.material_event_input_id
     JOIN material_batch mb ON mb.id=mei.batch_id
     JOIN material_event_output source_eo ON source_eo.id=pei.source_production_output_id
     JOIN material_measurement_set ms ON ms.material_event_input_id=mei.id AND ms.batch_id=mei.batch_id
     WHERE pei.processing_event_id=:eventId ORDER BY mei.input_sequence`,
    { replacements: { eventId }, type: QueryTypes.SELECT },
  );
  const outputs = await sequelize.query(
    `SELECT eo.id, eo.batch_id, mb.batch_code, mb.material_kind, peo.output_role, ms.id AS measurement_set_id
     FROM processing_event_output peo JOIN material_event_output eo ON eo.id=peo.material_event_output_id
     JOIN material_batch mb ON mb.id=eo.batch_id
     JOIN material_measurement_set ms ON ms.material_event_output_id=eo.id AND ms.batch_id=eo.batch_id
     WHERE peo.processing_event_id=:eventId ORDER BY eo.output_sequence`,
    { replacements: { eventId }, type: QueryTypes.SELECT },
  );
  const measurements = await sequelize.query(
    `SELECT id, measurement_set_id, measurement_kind, quantity_g, source_value, source_unit_code,
            conversion_version, source_role, source_party_id, entered_by_user_id, occurred_at_claimed,
            entered_at, method_code, instrument_ref, supersedes_measurement_id
     FROM material_measurement
     WHERE measurement_set_id IN (
       SELECT ms.id FROM material_measurement_set ms
       LEFT JOIN material_event_input mei ON mei.id=ms.material_event_input_id
       LEFT JOIN material_event_output eo ON eo.id=ms.material_event_output_id
       WHERE mei.event_id=:eventId OR eo.event_id=:eventId
     ) ORDER BY entered_at, id`,
    { replacements: { eventId }, type: QueryTypes.SELECT },
  );
  return {
    ...event,
    inputs: inputs.map((row) => ({ ...row, measurements: measurements.filter((measurement) => measurement.measurement_set_id === row.measurement_set_id) })),
    outputs: outputs.map((row) => ({ ...row, measurements: measurements.filter((measurement) => measurement.measurement_set_id === row.measurement_set_id) })),
  };
}

export async function addProcessingMeasurement(eventId, contextKind, contextId, input, auth, mutationId) {
  return sequelize.transaction(async (transaction) => executeIdempotent({
    actorScope: `user:${auth.userId}`, mutationId,
    payload: { action: 'processing.measurement.add', eventId, contextKind, contextId, input }, transaction,
  }, async () => {
    const contextSql = contextKind === 'INPUT'
      ? `SELECT mei.id AS context_id, mei.batch_id, ms.id AS measurement_set_id
            , pe.processing_facility_id, source_peo.production_event_id AS source_production_event_id
         FROM processing_event_input pei JOIN material_event_input mei ON mei.id=pei.material_event_input_id
         JOIN processing_event pe ON pe.event_id=pei.processing_event_id
         JOIN production_event_output source_peo ON source_peo.material_event_output_id=pei.source_production_output_id
         JOIN material_measurement_set ms ON ms.material_event_input_id=mei.id AND ms.batch_id=mei.batch_id
         WHERE pei.processing_event_id=:eventId AND mei.id=:contextId FOR UPDATE OF ms`
      : `SELECT eo.id AS context_id, eo.batch_id, ms.id AS measurement_set_id, pe.processing_facility_id
         FROM processing_event_output peo JOIN material_event_output eo ON eo.id=peo.material_event_output_id
         JOIN processing_event pe ON pe.event_id=peo.processing_event_id
         JOIN material_measurement_set ms ON ms.material_event_output_id=eo.id AND ms.batch_id=eo.batch_id
         WHERE peo.processing_event_id=:eventId AND eo.id=:contextId FOR UPDATE OF ms`;
    const [context] = await sequelize.query(contextSql, {
      replacements: { eventId, contextId }, type: QueryTypes.SELECT, transaction,
    });
    if (!context) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
    const measurement = await insertMeasurement({
      measurementSetId: context.measurement_set_id, batchId: context.batch_id, measure: input,
      auth, fallbackOccurredAt: input.occurredAt ?? new Date(), transaction,
      processingEventId: eventId, sourceProductionEventId: context.source_production_event_id ?? null,
    });
    await appendAuditEvent({
      transaction, eventType: 'MEASUREMENT.RECORDED', actorUserId: auth.userId, actorPartyId: auth.personPartyId,
      occurredAt: new Date(input.occurredAt ?? Date.now()), clientMutationId: mutationId,
      payload: { measurement_id: measurement.id, measurement_set_id: measurement.measurementSetId, batch_id: context.batch_id, kind: measurement.kind, quantity_grams: measurement.quantityGrams, processing_event_id: eventId },
      streams: [{ kind: 'material_event', id: eventId }, { kind: 'material_batch', id: context.batch_id }],
    });
    return measurement;
  }));
}

export async function processingEventAccessRows(eventId, siteId = undefined) {
  const whereSite = siteId ? 'AND h.site_id=:siteId' : '';
  return sequelize.query(
    `SELECT DISTINCT pe.processing_facility_id, pe.event_id, h.site_id, h.id AS hole_id
     FROM processing_event pe
     JOIN processing_event_input pei ON pei.processing_event_id=pe.event_id
     JOIN material_event_input mei ON mei.id=pei.material_event_input_id
     JOIN production_event_output peo ON peo.material_event_output_id=pei.source_production_output_id
     JOIN production_event source_pe ON source_pe.event_id=peo.production_event_id
     JOIN mining_hole h ON h.id=source_pe.hole_id
     WHERE pe.event_id=:eventId ${whereSite}`,
    { replacements: { eventId, ...(siteId ? { siteId } : {}) }, type: QueryTypes.SELECT },
  );
}

export async function listAccessibleProcessingEvents(auth, siteId = undefined) {
  const events = await sequelize.query(
    `SELECT me.id, me.event_code, me.occurred_at_claimed, me.recorded_at, me.current_status,
            pe.processing_facility_id, pf.name AS processing_facility_name,
            count(DISTINCT pei.material_event_input_id)::int AS input_count,
            count(DISTINCT peo.material_event_output_id)::int AS output_count
     FROM processing_event pe
     JOIN material_event me ON me.id=pe.event_id
     JOIN processing_facility pf ON pf.id=pe.processing_facility_id
     JOIN processing_event_input pei ON pei.processing_event_id=pe.event_id
     JOIN material_event_input mei ON mei.id=pei.material_event_input_id
     JOIN production_event_output source_output ON source_output.material_event_output_id=pei.source_production_output_id
     JOIN production_event source_event ON source_event.event_id=source_output.production_event_id
     JOIN mining_hole h ON h.id=source_event.hole_id
     LEFT JOIN processing_event_output peo ON peo.processing_event_id=pe.event_id
     WHERE (:siteId IS NULL OR h.site_id=:siteId)
     GROUP BY me.id, pe.processing_facility_id, pf.name
     ORDER BY me.recorded_at DESC, me.id`,
    { replacements: { siteId: siteId ?? null }, type: QueryTypes.SELECT },
  );
  const visible = [];
  for (const event of events) {
    if (!(await canAccessProcessingFacility(auth, event.processing_facility_id))) continue;
    const sources = await processingEventAccessRows(event.id);
    if (siteId && !sources.some((source) => source.site_id === siteId)) continue;
    let allSourcesAllowed = sources.length > 0;
    for (const source of sources) {
      if (!(await canAccessHole(auth, source.site_id, source.hole_id))) { allSourcesAllowed = false; break; }
    }
    if (allSourcesAllowed) visible.push({
      ...event,
      sourceSiteIds: [...new Set(sources.map((source) => source.site_id))],
      sourceHoleIds: [...new Set(sources.map((source) => source.hole_id))],
    });
  }
  return visible;
}
