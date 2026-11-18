import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../database/connection.mjs';
import { MaterialBatch, MaterialEvent, MiningHole, ProductionEvent } from '../../database/models.mjs';
import { AppError } from '../../utils/errors.mjs';
import { appendAuditEvent } from '../audit/audit.service.mjs';
import { executeIdempotent } from '../commands/idempotency.service.mjs';

export async function createProductionEvent(siteId, input, auth, mutationId) {
  return sequelize.transaction(async (transaction) => executeIdempotent({ actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'production.create', siteId, input }, transaction }, async () => {
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
        await sequelize.query(
          `INSERT INTO material_measurement(id,measurement_set_id,measurement_kind,quantity_g,source_value,source_unit_code,conversion_version,source_role,source_party_id,entered_by_user_id,method_code,instrument_ref,occurred_at_claimed,evidence_ref)
           VALUES (:id,:setId,:kind,:quantity,:sourceValue,:unit,:conversion,:sourceRole,:sourcePartyId,:userId,:method,:instrument,:occurredAt,:evidenceRef)`,
          { replacements: {
            id: measurementId, setId: measurementSetId, kind: measure.kind, quantity: measure.quantityGrams, sourceValue: measure.sourceValue,
            unit: measure.sourceUnit, conversion: measure.conversionVersion, sourceRole: measure.sourceRole,
            sourcePartyId: measure.sourcePartyId ?? actor[0].person_party_id, userId: auth.userId, method: measure.methodCode ?? null,
            instrument: measure.instrumentRef ?? null, occurredAt: measure.occurredAt ?? input.occurredAt, evidenceRef: measure.evidenceRef ?? null,
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
    });
    return { id: event.id, eventCode: event.eventCode, eventKind: event.eventKind, siteId, holeId: input.holeId, occurredAt: input.occurredAt, recordedAt: event.recordedAt, outputs };
  }));
}

export async function addOutputMeasurement(siteId, eventId, outputId, input, auth, mutationId) {
  return sequelize.transaction(async (transaction) => executeIdempotent({ actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'measurement.add', siteId, eventId, outputId, input }, transaction }, async () => {
    const rows = await sequelize.query(
      `SELECT eo.id AS output_id, eo.batch_id, ms.id AS measurement_set_id
       FROM production_event pe JOIN mining_hole h ON h.id=pe.hole_id
       JOIN production_event_output peo ON peo.production_event_id=pe.event_id
       JOIN material_event_output eo ON eo.id=peo.material_event_output_id
       JOIN material_measurement_set ms ON ms.material_event_output_id=eo.id AND ms.batch_id=eo.batch_id
       WHERE pe.event_id=:eventId AND eo.id=:outputId AND h.site_id=:siteId FOR UPDATE OF ms`,
      { replacements: { eventId, outputId, siteId }, type: QueryTypes.SELECT, transaction },
    );
    if (!rows.length) throw new AppError(404, 'PRODUCTION_OUTPUT_NOT_FOUND', 'Production output was not found for this site.');
    const measurementId = randomUUID();
    await sequelize.query(
      `INSERT INTO material_measurement(id,measurement_set_id,measurement_kind,quantity_g,source_value,source_unit_code,conversion_version,source_role,source_party_id,entered_by_user_id,method_code,instrument_ref,occurred_at_claimed,evidence_ref)
       VALUES (:id,:setId,:kind,:quantity,:sourceValue,:unit,:conversion,:sourceRole,:sourcePartyId,:userId,:method,:instrument,:occurredAt,:evidenceRef)`,
      { replacements: { id: measurementId, setId: rows[0].measurement_set_id, kind: input.kind, quantity: input.quantityGrams, sourceValue: input.sourceValue, unit: input.sourceUnit, conversion: input.conversionVersion, sourceRole: input.sourceRole, sourcePartyId: input.sourcePartyId ?? auth.personPartyId, userId: auth.userId, method: input.methodCode ?? null, instrument: input.instrumentRef ?? null, occurredAt: input.occurredAt, evidenceRef: input.evidenceRef ?? null }, transaction },
    );
    await appendAuditEvent({ transaction, eventType: 'MEASUREMENT.RECORDED', actorUserId: auth.userId, actorPartyId: auth.personPartyId, occurredAt: new Date(input.occurredAt), clientMutationId: mutationId, payload: { measurement_id: measurementId, measurement_set_id: rows[0].measurement_set_id, batch_id: rows[0].batch_id, kind: input.kind, quantity_grams: input.quantityGrams }, streams: [{ kind: 'material_batch', id: rows[0].batch_id }, { kind: 'material_event', id: eventId }] });
    return { id: measurementId, measurementSetId: rows[0].measurement_set_id, batchId: rows[0].batch_id, kind: input.kind, quantityGrams: input.quantityGrams, occurredAt: input.occurredAt, enteredAt: new Date() };
  }));
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
    `SELECT id, measurement_set_id, measurement_kind, quantity_g, source_value, source_unit_code, conversion_version, source_role, source_party_id, occurred_at_claimed, entered_at, method_code, instrument_ref
     FROM material_measurement WHERE measurement_set_id IN (SELECT id FROM material_measurement_set WHERE material_event_output_id IN (SELECT material_event_output_id FROM production_event_output WHERE production_event_id=:eventId))
     ORDER BY entered_at, id`,
    { replacements: { eventId }, type: QueryTypes.SELECT },
  );
  return { ...event, outputs: outputs.map((output) => ({ ...output, measurements: measurements.filter((measurement) => measurement.measurement_set_id === output.measurement_set_id) })) };
}
