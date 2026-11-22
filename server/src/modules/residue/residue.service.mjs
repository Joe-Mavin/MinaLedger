import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../database/connection.mjs';
import { canAccessProcessingFacility, canAccessRecoveryFacility } from '../../middleware/auth.mjs';
import { AppError } from '../../utils/errors.mjs';
import { appendAuditEvent } from '../audit/audit.service.mjs';
import { executeIdempotent } from '../commands/idempotency.service.mjs';
import { lockInventoryBalanceKeys, postMovementInTransaction } from '../inventory/inventory.service.mjs';

const query = (sql, replacements = {}, transaction, type = QueryTypes.SELECT) => sequelize.query(sql, {
  replacements, ...(transaction ? { transaction } : {}), ...(type ? { type } : {}),
});
const expectedVersionsFor = (options) => options?.expectedVersion ? [{
  kind: options.expectedVersion.streamKind, id: options.expectedVersion.streamId, sequence: options.expectedVersion.sequence,
}] : [];

function assertDistinctIds(values, field) {
  if (new Set(values).size !== values.length) throw new AppError(400, 'DUPLICATE_RESOURCE', `${field} may appear only once in a command.`);
}

function toMicros(value) {
  const [whole, fraction = ''] = String(value).split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

function microsToGrams(value) {
  const abs = value < 0n ? -value : value;
  return `${value < 0n ? '-' : ''}${abs / 1_000_000n}.${String(abs % 1_000_000n).padStart(6, '0')}`;
}

async function insertMeasurement({ measurementSetId, quantityGrams, input = {}, auth, occurredAt, transaction }) {
  const id = randomUUID();
  const sourceValue = input.sourceValue ?? quantityGrams;
  const sourceUnit = input.sourceUnit ?? 'g';
  await sequelize.query(
    `INSERT INTO material_measurement(
       id,measurement_set_id,measurement_kind,quantity_g,source_value,source_unit_code,conversion_version,
       source_role,source_party_id,entered_by_user_id,method_code,instrument_ref,occurred_at_claimed,evidence_ref
     ) VALUES (:id,:measurementSetId,:kind,:quantity,:sourceValue,:sourceUnit,:conversion,:sourceRole,:sourceParty,
       :userId,:method,:instrument,:occurredAt,:evidenceRef)`,
    { replacements: {
      id, measurementSetId, kind: input.kind ?? 'MEASURED', quantity: quantityGrams, sourceValue, sourceUnit,
      conversion: input.conversionVersion ?? 'canonical-g-v1', sourceRole: input.sourceRole ?? 'RECORDER',
      sourceParty: auth.personPartyId, userId: auth.userId, method: input.methodCode ?? null,
      instrument: input.instrumentRef ?? null, occurredAt: input.occurredAt ?? occurredAt,
      evidenceRef: input.evidenceRef ?? null,
    }, transaction },
  );
  return id;
}

async function assertDoraAccess(auth, facilityId, write) {
  if (!(await canAccessProcessingFacility(auth, facilityId, { write }))) {
    throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  }
}

async function assertRecoveryAccess(auth, facilityId, write) {
  if (!(await canAccessRecoveryFacility(auth, facilityId, { write }))) {
    throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  }
}

async function lockAndGetEligibleResidueQuantity(batchId, facilityId, transaction) {
  await query(`SELECT id FROM material_batch WHERE id=:batchId FOR UPDATE`, { batchId }, transaction);
  const locations = await query(
    `SELECT inventory_location_id AS location_id FROM residue_stockpile
     WHERE processing_facility_id=:facilityId ORDER BY inventory_location_id`,
    { facilityId }, transaction,
  );
  await lockInventoryBalanceKeys(locations.map((row) => ({ locationId: row.location_id, batchId })), transaction);
  const [balance] = await query(
    `SELECT COALESCE(sum(derived.quantity_g),0)::NUMERIC(20,6) AS quantity_g
     FROM (
       SELECT ml.location_id,sum(CASE WHEN ml.direction='IN' THEN ml.posted_quantity_g ELSE -ml.posted_quantity_g END)::NUMERIC(20,6) AS quantity_g
       FROM inventory_movement_line ml JOIN inventory_movement movement ON movement.id=ml.inventory_movement_id AND movement.current_status='ACCEPTED'
       JOIN residue_stockpile stockpile ON stockpile.inventory_location_id=ml.location_id AND stockpile.processing_facility_id=:facilityId
       WHERE ml.batch_id=:batchId GROUP BY ml.location_id
     ) derived`,
    { facilityId, batchId }, transaction,
  );
  const [commitments] = await query(
    `SELECT COALESCE(sum(GREATEST(line.accepted_trade_quantity_g-COALESCE(shipped.quantity_g,0),0)),0)::NUMERIC(20,6) AS quantity_g
     FROM residue_sale_line line
     JOIN residue_sale sale ON sale.id=line.residue_sale_id
     JOIN material_event_output output ON output.batch_id=line.batch_id
     JOIN processing_event_output po ON po.material_event_output_id=output.id AND po.output_role='DORA_RETAINED_RESIDUE'
     JOIN processing_event processing ON processing.event_id=po.processing_event_id AND processing.processing_facility_id=:facilityId
     LEFT JOIN LATERAL (
       SELECT COALESCE(sum(dispatch.posted_quantity_g-COALESCE(reversed.quantity_g,0)),0)::NUMERIC(20,6) AS quantity_g
       FROM inventory_movement_line dispatch
       JOIN inventory_movement movement ON movement.id=dispatch.inventory_movement_id AND movement.current_status='ACCEPTED' AND movement.movement_kind='TRANSFER'
       LEFT JOIN LATERAL (
         SELECT COALESCE(sum(reverse_line.posted_quantity_g),0)::NUMERIC(20,6) AS quantity_g
         FROM inventory_movement_line reverse_line
         JOIN inventory_movement reverse_movement ON reverse_movement.id=reverse_line.inventory_movement_id AND reverse_movement.current_status='ACCEPTED' AND reverse_movement.movement_kind='REVERSAL'
         WHERE reverse_line.reverses_line_id=dispatch.id
       ) reversed ON true
       WHERE dispatch.residue_sale_line_id=line.id AND dispatch.consignment_stage='DISPATCH' AND dispatch.direction='OUT'
     ) shipped ON true
     WHERE line.batch_id=:batchId AND line.is_accepted`,
    { facilityId, batchId }, transaction,
  );
  const free = toMicros(balance.quantity_g) - toMicros(commitments.quantity_g);
  return free > 0n ? free : 0n;
}

async function assertReceiptClaimWithinDispatch(consignmentItemId, quantityGrams, transaction, supersedesReceiptItemId = null) {
  const [dispatch] = await query(
    `SELECT COALESCE(sum(line.posted_quantity_g-COALESCE(reversed.quantity_g,0)),0)::NUMERIC(20,6) AS quantity_g
     FROM inventory_movement_line line
     JOIN inventory_movement movement ON movement.id=line.inventory_movement_id AND movement.current_status='ACCEPTED' AND movement.movement_kind='TRANSFER'
     LEFT JOIN LATERAL (
       SELECT COALESCE(sum(reverse_line.posted_quantity_g),0)::NUMERIC(20,6) AS quantity_g
       FROM inventory_movement_line reverse_line
       JOIN inventory_movement reverse_movement ON reverse_movement.id=reverse_line.inventory_movement_id AND reverse_movement.current_status='ACCEPTED' AND reverse_movement.movement_kind='REVERSAL'
       WHERE reverse_line.reverses_line_id=line.id
     ) reversed ON true
     WHERE line.consignment_item_id=:itemId AND line.consignment_stage='DISPATCH' AND line.direction='OUT'`,
    { itemId: consignmentItemId }, transaction,
  );
  const [claims] = await query(
    `SELECT COALESCE(sum(item.quantity_g),0)::NUMERIC(20,6) AS quantity_g
     FROM consignment_receipt_item item
     WHERE item.consignment_item_id=:itemId AND item.id IS DISTINCT FROM :supersedesId
       AND NOT EXISTS (SELECT 1 FROM consignment_receipt_item child WHERE child.supersedes_receipt_item_id=item.id)`,
    { itemId: consignmentItemId, supersedesId: supersedesReceiptItemId }, transaction,
  );
  if (toMicros(dispatch.quantity_g)<=0n || toMicros(claims.quantity_g)+toMicros(quantityGrams)>toMicros(dispatch.quantity_g)) {
    throw new AppError(409, 'RECEIPT_CLAIMS_EXCEED_DISPATCH', 'Current receipt claims cannot exceed the accepted dispatched quantity.');
  }
}

export async function createStockpile(facilityId, input, auth, mutationId) {
  await assertDoraAccess(auth, facilityId, true);
  return sequelize.transaction(async (transaction) => executeIdempotent({
    actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'residue.stockpile.create', facilityId, input }, transaction,
  }, async () => {
    const [facility] = await query(`SELECT id FROM processing_facility WHERE id=:facilityId AND status='ACTIVE' FOR UPDATE`, { facilityId }, transaction);
    if (!facility) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
    const locationId = randomUUID();
    await sequelize.query(
      `INSERT INTO inventory_location(id,location_code,location_kind,custodian_party_id,physical_place_ref)
       VALUES (:id,:code,'STOCKPILE',:party,:place)`,
      { replacements: { id: locationId, code: input.locationCode, party: auth.personPartyId, place: input.physicalPlaceRef ?? null }, transaction },
    );
    await sequelize.query(
      `INSERT INTO residue_stockpile(inventory_location_id,stockpile_code,processing_facility_id,operator_party_id,location_ref)
       VALUES (:id,:code,:facilityId,:operator,:place)`,
      { replacements: { id: locationId, code: input.stockpileCode, facilityId, operator: auth.personPartyId, place: input.physicalPlaceRef ?? null }, transaction },
    );
    await appendAuditEvent({
      transaction, eventType: 'RESIDUE.STOCKPILE_CREATED', actorUserId: auth.userId, actorPartyId: auth.personPartyId,
      occurredAt: new Date(), clientMutationId: mutationId, payload: { location_id: locationId, processing_facility_id: facilityId },
      streams: [{ kind: 'inventory_location', id: locationId }, { kind: 'processing_facility', id: facilityId }],
    });
    return { id: locationId, stockpileCode: input.stockpileCode, locationCode: input.locationCode, processingFacilityId: facilityId };
  }));
}

export async function listStockpiles(facilityId, auth) {
  await assertDoraAccess(auth, facilityId, false);
  return query(
    `SELECT s.inventory_location_id AS id,s.stockpile_code,l.location_code,s.processing_facility_id,s.location_ref,
       b.id AS batch_id,b.batch_code,b.material_kind,b.origin_processing_event_id,b.origin_output_id,balance.quantity_g
     FROM residue_stockpile s JOIN inventory_location l ON l.id=s.inventory_location_id
     LEFT JOIN LATERAL (
       SELECT mb.id,mb.batch_code,mb.material_kind,
         (SELECT pe.event_id FROM processing_event_output peo JOIN processing_event pe ON pe.event_id=peo.processing_event_id WHERE peo.material_event_output_id=eo.id) AS origin_processing_event_id,
         eo.id AS origin_output_id
       FROM material_batch mb JOIN material_event_output eo ON eo.batch_id=mb.id
       WHERE mb.material_kind='RESIDUE' AND EXISTS (SELECT 1 FROM inventory_movement_line x JOIN inventory_movement m ON m.id=x.inventory_movement_id AND m.current_status='ACCEPTED' WHERE x.batch_id=mb.id AND x.location_id=s.inventory_location_id)
     ) b ON true
     LEFT JOIN LATERAL (
       SELECT COALESCE(sum(CASE WHEN ml.direction='IN' THEN ml.posted_quantity_g ELSE -ml.posted_quantity_g END),0)::NUMERIC(20,6) AS quantity_g
       FROM inventory_movement_line ml JOIN inventory_movement m ON m.id=ml.inventory_movement_id AND m.current_status='ACCEPTED'
       WHERE ml.location_id=s.inventory_location_id AND ml.batch_id=b.id
     ) balance ON b.id IS NOT NULL
     WHERE s.processing_facility_id=:facilityId ORDER BY s.stockpile_code,b.batch_code`,
    { facilityId },
  );
}

export async function listAccessibleRecoveryFacilities(auth) {
  const facilities = await query(
    `SELECT id,name,status,party_id,created_at FROM recovery_facility ORDER BY name,id`,
  );
  const visible = [];
  for (const facility of facilities) {
    if (await canAccessRecoveryFacility(auth, facility.id)) visible.push(facility);
  }
  return visible;
}

export async function listEligibleRecoveryDestinations(processingFacilityId, auth) {
  await assertDoraAccess(auth, processingFacilityId, true);
  return query(
    `SELECT rf.id,rf.name,rf.status,
       COALESCE(json_agg(json_build_object('id',l.id,'locationCode',l.location_code)
         ORDER BY l.location_code,l.id) FILTER (WHERE l.id IS NOT NULL),'[]') AS locations
     FROM recovery_facility rf LEFT JOIN recovery_inventory_location ril ON ril.recovery_facility_id=rf.id
     LEFT JOIN inventory_location l ON l.id=ril.inventory_location_id
     WHERE rf.status='ACTIVE' AND rf.party_id IS NOT NULL
     GROUP BY rf.id ORDER BY rf.name,rf.id`,
  );
}

export async function getRecoveryFacility(facilityId, auth) {
  await assertRecoveryAccess(auth, facilityId, false);
  const [facility] = await query(
    `SELECT id,name,status,party_id,created_at FROM recovery_facility WHERE id=:facilityId`, { facilityId },
  );
  if (!facility) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  const locations = await query(
    `SELECT l.id,l.location_code,l.physical_place_ref,ril.location_ref
     FROM recovery_inventory_location ril JOIN inventory_location l ON l.id=ril.inventory_location_id
     WHERE ril.recovery_facility_id=:facilityId ORDER BY l.location_code,l.id`, { facilityId },
  );
  return { ...facility, locations };
}

export async function listAccessibleRecoveryEvents(facilityId, auth) {
  await assertRecoveryAccess(auth, facilityId, false);
  return query(
    `SELECT me.id,me.event_code,me.occurred_at_claimed,me.recorded_at,me.current_status,
            re.method_ref, count(DISTINCT ri.material_event_input_id)::int AS input_count,
            count(DISTINCT ro.material_event_output_id)::int AS output_count
     FROM recovery_event re JOIN material_event me ON me.id=re.event_id
     LEFT JOIN recovery_event_input ri ON ri.recovery_event_id=re.event_id
     LEFT JOIN recovery_event_output ro ON ro.recovery_event_id=re.event_id
     WHERE re.recovery_facility_id=:facilityId
     GROUP BY me.id,re.method_ref ORDER BY me.recorded_at DESC,me.id`, { facilityId },
  );
}

export async function listEligibleDoraResidueOutputs(facilityId, auth) {
  await assertDoraAccess(auth, facilityId, false);
  return query(
    `SELECT eo.id AS output_id,eo.event_id AS processing_event_id,me.event_code,me.occurred_at_claimed,
            eo.batch_id,mb.batch_code,mb.material_kind,peo.output_role,mm.id AS measurement_id,
            mm.measurement_kind,mm.quantity_g,mm.source_value,mm.source_unit_code,mm.conversion_version,
            mm.source_role,mm.method_code,mm.instrument_ref,mm.evidence_ref
     FROM processing_event_output peo JOIN material_event_output eo ON eo.id=peo.material_event_output_id
     JOIN processing_event pe ON pe.event_id=peo.processing_event_id
     JOIN material_event me ON me.id=pe.event_id JOIN material_batch mb ON mb.id=eo.batch_id
     JOIN material_measurement_set ms ON ms.material_event_output_id=eo.id AND ms.batch_id=eo.batch_id
     JOIN material_measurement mm ON mm.measurement_set_id=ms.id
     WHERE pe.processing_facility_id=:facilityId AND peo.output_role='DORA_RETAINED_RESIDUE'
       AND mb.material_kind='RESIDUE' AND mm.measurement_kind IN ('MEASURED','VERIFIED')
       AND NOT EXISTS (SELECT 1 FROM material_measurement successor WHERE successor.supersedes_measurement_id=mm.id)
       AND NOT EXISTS (SELECT 1 FROM inventory_movement_line ml JOIN inventory_movement m ON m.id=ml.inventory_movement_id AND m.current_status='ACCEPTED' WHERE ml.source_material_event_output_id=eo.id)
     ORDER BY me.recorded_at,eo.output_sequence,mm.entered_at`, { facilityId },
  );
}

export async function listEligibleRecoveryInputs(facilityId, auth) {
  await assertRecoveryAccess(auth, facilityId, false);
  return query(
    `SELECT ri.id AS receipt_item_id,ri.consignment_id,ci.batch_id,mb.batch_code,mb.material_kind,
            c.consignment_code,ri.quantity_g,ri.outcome,ri.evidence_ref,ri.recorded_at,
            GREATEST(ri.quantity_g-COALESCE(used.quantity_g,0),0)::NUMERIC(20,6) AS available_quantity_g
     FROM consignment_receipt_item ri JOIN consignment_item ci ON ci.id=ri.consignment_item_id
     JOIN consignment c ON c.id=ci.consignment_id JOIN material_batch mb ON mb.id=ci.batch_id
     LEFT JOIN LATERAL (
       SELECT sum(source.source_quantity_g)::NUMERIC(20,6) AS quantity_g
       FROM recovery_event_input_source source WHERE source.consignment_receipt_item_id=ri.id
     ) used ON true
     WHERE c.destination_recovery_facility_id=:facilityId AND ri.outcome='ACCEPTED'
       AND NOT EXISTS (SELECT 1 FROM consignment_receipt_item successor WHERE successor.supersedes_receipt_item_id=ri.id)
       AND COALESCE(used.quantity_g,0)<ri.quantity_g
     ORDER BY ri.recorded_at,ri.id`, { facilityId },
  );
}

export async function receiveDoraResidue(stockpileId, input, auth, mutationId) {
  const [stockpile] = await query(`SELECT processing_facility_id FROM residue_stockpile WHERE inventory_location_id=:stockpileId`, { stockpileId });
  if (!stockpile) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  await assertDoraAccess(auth, stockpile.processing_facility_id, true);
  assertDistinctIds(input.outputs.map((row) => row.outputId), 'outputs');
  return sequelize.transaction(async (transaction) => executeIdempotent({
    actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'residue.stockpile.intake', stockpileId, input }, transaction,
  }, async () => {
    const outputs = await query(
      `SELECT eo.id AS output_id,eo.batch_id,pe.processing_facility_id,peo.output_role,mb.material_kind,
          ms.id AS measurement_set_id,mm.id AS measurement_id,mm.quantity_g
       FROM material_event_output eo JOIN processing_event_output peo ON peo.material_event_output_id=eo.id
       JOIN processing_event pe ON pe.event_id=peo.processing_event_id JOIN material_batch mb ON mb.id=eo.batch_id
       JOIN material_measurement_set ms ON ms.material_event_output_id=eo.id AND ms.batch_id=eo.batch_id
       JOIN material_measurement mm ON mm.measurement_set_id=ms.id
       WHERE eo.id IN (:outputIds) AND pe.processing_facility_id=:facilityId AND peo.output_role='DORA_RETAINED_RESIDUE'
         AND mb.material_kind='RESIDUE' AND mm.id IN (:measurementIds)
         AND mm.measurement_kind IN ('MEASURED','VERIFIED')
         AND NOT EXISTS (SELECT 1 FROM material_measurement successor WHERE successor.supersedes_measurement_id=mm.id)
       FOR SHARE OF eo,peo,pe,mb`,
      { outputIds: input.outputs.map((row) => row.outputId), measurementIds: input.outputs.map((row) => row.measurementId), facilityId: stockpile.processing_facility_id }, transaction,
    );
    const lines = [];
    for (const row of input.outputs) {
      const source = outputs.find((item) => item.output_id === row.outputId && item.measurement_id === row.measurementId);
      if (!source) throw new AppError(400, 'INVALID_RESIDUE_SOURCE', 'Each intake must select a measured Dora-retained residue output from this facility.');
      const [alreadyReceived] = await query(
        `SELECT 1 FROM inventory_movement_line ml JOIN inventory_movement m ON m.id=ml.inventory_movement_id AND m.current_status='ACCEPTED'
         WHERE ml.source_material_event_output_id=:outputId LIMIT 1`, { outputId: row.outputId }, transaction,
      );
      if (alreadyReceived) throw new AppError(409, 'RESIDUE_ALREADY_RECEIVED', 'This Dora residue output has already entered a stockpile.');
      lines.push({
        batchId: source.batch_id, locationId: stockpileId, direction: 'IN', quantityGrams: source.quantity_g,
        measurementSetId: source.measurement_set_id, measurementId: source.measurement_id,
        sourceMaterialEventOutputId: source.output_id,
      });
    }
    const movement = await postMovementInTransaction({ movementKind: 'INTAKE', lines, occurredAt: input.occurredAt, auth, transaction, mutationId, reason: input.evidenceRef ?? 'Dora residue output intake' });
    await appendAuditEvent({
      transaction, eventType: 'RESIDUE.STOCKPILE_INTAKE_RECORDED', actorUserId: auth.userId, actorPartyId: auth.personPartyId,
      occurredAt: new Date(input.occurredAt), clientMutationId: mutationId,
      payload: { stockpile_id: stockpileId, inventory_movement_id: movement.id, source_output_ids: input.outputs.map((row) => row.outputId) },
      streams: [{ kind: 'inventory_location', id: stockpileId }, ...lines.map((line) => ({ kind: 'material_batch', id: line.batchId }))],
    });
    return { ...movement, stockpileId, sourceOutputCount: lines.length };
  }));
}

export async function transferBetweenStockpiles(sourceLocationId, input, auth, mutationId, options = {}) {
  if (sourceLocationId === input.destinationStockpileId) throw new AppError(400, 'INVALID_STOCKPILE_TRANSFER', 'Choose a different destination stockpile.');
  const [source] = await query(`SELECT processing_facility_id FROM residue_stockpile WHERE inventory_location_id=:id`, { id: sourceLocationId });
  const [destination] = await query(`SELECT processing_facility_id FROM residue_stockpile WHERE inventory_location_id=:id`, { id: input.destinationStockpileId });
  if (!source || !destination) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  await assertDoraAccess(auth, source.processing_facility_id, true);
  await assertDoraAccess(auth, destination.processing_facility_id, true);
  assertDistinctIds(input.items.map((row) => row.batchId), 'items');
  return sequelize.transaction(async (transaction) => executeIdempotent({
    actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'residue.stockpile.transfer', sourceLocationId, input }, transaction,
  }, async () => {
    const lines = [];
    for (const item of input.items) {
      const countId = randomUUID();
      const setId = randomUUID();
      await sequelize.query(
        `INSERT INTO inventory_count(id,location_id,batch_id,counted_at_claimed,actor_user_id,evidence_ref)
         VALUES (:id,:locationId,:batchId,:occurredAt,:actor,:evidence)`,
        { replacements: { id: countId, locationId: sourceLocationId, batchId: item.batchId, occurredAt: input.occurredAt, actor: auth.userId, evidence: input.evidenceRef }, transaction },
      );
      await sequelize.query(`INSERT INTO material_measurement_set(id,batch_id,inventory_count_id) VALUES (:id,:batchId,:countId)`, { replacements: { id: setId, batchId: item.batchId, countId }, transaction });
      const measurementId = await insertMeasurement({ measurementSetId: setId, quantityGrams: item.quantityGrams, input: item.measurement, auth, occurredAt: input.occurredAt, transaction });
      lines.push(
        { batchId: item.batchId, locationId: sourceLocationId, direction: 'OUT', quantityGrams: item.quantityGrams, measurementSetId: setId, measurementId, inventoryCountId: countId },
        { batchId: item.batchId, locationId: input.destinationStockpileId, direction: 'IN', quantityGrams: item.quantityGrams, measurementSetId: setId, measurementId },
      );
    }
    const movement = await postMovementInTransaction({ movementKind: 'TRANSFER', lines, reason: input.evidenceRef, occurredAt: input.occurredAt, auth, transaction, mutationId, expectedVersions: expectedVersionsFor(options) });
    await appendAuditEvent({
      transaction, eventType: 'RESIDUE.STOCKPILE_TRANSFERRED', actorUserId: auth.userId, actorPartyId: auth.personPartyId,
      occurredAt: new Date(input.occurredAt), clientMutationId: mutationId,
      payload: { source_location_id: sourceLocationId, destination_location_id: input.destinationStockpileId, inventory_movement_id: movement.id, batch_ids: input.items.map((row) => row.batchId) },
      streams: [{ kind: 'inventory_location', id: sourceLocationId }, { kind: 'inventory_location', id: input.destinationStockpileId }, ...input.items.map((row) => ({ kind: 'material_batch', id: row.batchId }))],
    });
    return movement;
  }));
}

export async function createConsignment(input, auth, mutationId) {
  assertDistinctIds(input.items.map((row) => row.batchId), 'items');
  return sequelize.transaction(async (transaction) => executeIdempotent({
    actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'residue.consignment.create', input }, transaction,
  }, async () => {
    const [recipient] = await query(`SELECT id,party_id FROM recovery_facility WHERE id=:id AND status='ACTIVE' FOR SHARE`, { id: input.recoveryFacilityId }, transaction);
    if (!recipient || !recipient.party_id) throw new AppError(400, 'INVALID_RECOVERY_FACILITY', 'The destination recovery facility must be active and have a recorded receiving party.');
    const senderPartyId = auth.personPartyId;
    if (senderPartyId === recipient.party_id) throw new AppError(400, 'INVALID_COUNTERPARTIES', 'Consignment sender and receiver must differ.');
    const transitLocationId = randomUUID();
    const consignmentId = randomUUID();
    const code = input.consignmentCode ?? `CON-${consignmentId}`;
    await sequelize.query(
      `INSERT INTO inventory_location(id,location_code,location_kind,custodian_party_id,physical_place_ref)
       VALUES (:id,:code,'CONSIGNMENT_TRANSIT',:custodian,:place)`,
      { replacements: { id: transitLocationId, code: `TRANSIT-${consignmentId}`, custodian: input.transporterPartyId ?? senderPartyId, place: input.transitLocationRef ?? null }, transaction },
    );
    await sequelize.query(
      `INSERT INTO consignment(id,consignment_code,sender_party_id,recipient_party_id,transit_location_id,destination_recovery_facility_id,transporter_party_id)
       VALUES (:id,:code,:sender,:recipient,:transit,:facilityId,:transporter)`,
      { replacements: { id: consignmentId, code, sender: senderPartyId, recipient: recipient.party_id, transit: transitLocationId, facilityId: recipient.id, transporter: input.transporterPartyId ?? null }, transaction },
    );
    const resultItems = [];
    const sourceFacilities = new Set();
    for (const [index, item] of input.items.entries()) {
      const [stockpile] = await query(
        `SELECT s.processing_facility_id FROM residue_stockpile s WHERE s.inventory_location_id=:locationId`,
        { locationId: item.sourceStockpileId }, transaction,
      );
      if (!stockpile) throw new AppError(400, 'INVALID_STOCKPILE', 'Every consignment item must come from an existing Dora stockpile.');
      await assertDoraAccess(auth, stockpile.processing_facility_id, true);
      sourceFacilities.add(stockpile.processing_facility_id);
      const [batch] = await query(`SELECT id,material_kind FROM material_batch WHERE id=:id FOR SHARE`, { id: item.batchId }, transaction);
      if (!batch || batch.material_kind !== 'RESIDUE') throw new AppError(400, 'INVALID_RESIDUE_BATCH', 'Consignments accept only residue batches.');
      const itemId = randomUUID();
      const setId = randomUUID();
      await sequelize.query(
        `INSERT INTO consignment_item(id,consignment_id,batch_id,line_no,source_location_id) VALUES (:id,:consignmentId,:batchId,:lineNo,:sourceLocationId)`,
        { replacements: { id: itemId, consignmentId, batchId: item.batchId, lineNo: index + 1, sourceLocationId: item.sourceStockpileId }, transaction },
      );
      await sequelize.query(
        `INSERT INTO material_measurement_set(id,batch_id,consignment_item_id,consignment_stage) VALUES (:id,:batchId,:itemId,'DISPATCH')`,
        { replacements: { id: setId, batchId: item.batchId, itemId }, transaction },
      );
      const measurementId = await insertMeasurement({ measurementSetId: setId, quantityGrams: item.quantityGrams, input: item.measurement, auth, occurredAt: input.occurredAt, transaction });
      if (item.residueSaleLineId) {
        await sequelize.query(
          `INSERT INTO residue_sale_shipment_item(id,residue_sale_line_id,consignment_item_id,mapped_quantity_g,basis_measurement_id)
           VALUES (:id,:lineId,:itemId,:quantity,:measurementId)`,
          { replacements: { id: randomUUID(), lineId: item.residueSaleLineId, itemId, quantity: item.saleMappedQuantityGrams ?? item.quantityGrams, measurementId }, transaction },
        );
      }
      resultItems.push({ id: itemId, batchId: item.batchId, sourceStockpileId: item.sourceStockpileId, quantityGrams: item.quantityGrams, measurementId, residueSaleLineId: item.residueSaleLineId ?? null });
    }
    await appendAuditEvent({
      transaction, eventType: 'CONSIGNMENT.CREATED', actorUserId: auth.userId, actorPartyId: auth.personPartyId,
      occurredAt: new Date(input.occurredAt), clientMutationId: mutationId,
      payload: { consignment_id: consignmentId, item_count: resultItems.length, destination_recovery_facility_id: recipient.id, batch_ids: resultItems.map((row) => row.batchId) },
      streams: [{ kind: 'consignment', id: consignmentId }, ...[...sourceFacilities].map((id) => ({ kind: 'processing_facility', id })), { kind: 'recovery_facility', id: recipient.id }, ...resultItems.map((row) => ({ kind: 'material_batch', id: row.batchId }))],
    });
    return { id: consignmentId, consignmentCode: code, status: 'DRAFT', transitLocationId, destinationRecoveryFacilityId: recipient.id, items: resultItems };
  }));
}

async function getConsignmentSourceFacilities(consignmentId) {
  const rows = await query(
    `SELECT s.processing_facility_id FROM consignment c JOIN consignment_item ci ON ci.consignment_id=c.id
     JOIN residue_stockpile s ON s.inventory_location_id=ci.source_location_id WHERE c.id=:id GROUP BY s.processing_facility_id ORDER BY s.processing_facility_id`,
    { id: consignmentId },
  );
  return rows.map((row) => row.processing_facility_id);
}

export async function listAccessibleConsignments(auth) {
  const consignments = await query(
    `SELECT id,consignment_code,status,destination_recovery_facility_id,created_at,dispatched_at,received_at
     FROM consignment ORDER BY created_at DESC,id`,
  );
  const visible = [];
  for (const consignment of consignments) {
    const sourceFacilityIds = await getConsignmentSourceFacilities(consignment.id);
    const receiverAllowed = await canAccessRecoveryFacility(auth, consignment.destination_recovery_facility_id);
    let senderAllowed = sourceFacilityIds.length > 0;
    for (const facilityId of sourceFacilityIds) {
      if (!(await canAccessProcessingFacility(auth, facilityId))) senderAllowed = false;
    }
    if (receiverAllowed || senderAllowed) visible.push({ ...consignment, sourceFacilityIds });
  }
  return visible;
}

export async function dispatchConsignment(consignmentId, input, auth, mutationId, options = {}) {
  const sourceFacilityIds = await getConsignmentSourceFacilities(consignmentId);
  if (!sourceFacilityIds.length) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  for (const id of sourceFacilityIds) await assertDoraAccess(auth, id, true);
  return sequelize.transaction(async (transaction) => executeIdempotent({
    actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'residue.consignment.dispatch', consignmentId, input }, transaction,
  }, async () => {
    const [consignment] = await query(`SELECT * FROM consignment WHERE id=:id FOR UPDATE`, { id: consignmentId }, transaction);
    if (!consignment || consignment.status !== 'DRAFT') throw new AppError(409, 'INVALID_CONSIGNMENT_STATE', 'Only a draft consignment can be dispatched.');
    const items = await query(
      `SELECT ci.id,ci.batch_id,ci.source_location_id,ms.id AS measurement_set_id,mm.id AS measurement_id,mm.quantity_g,
         (SELECT rssi.residue_sale_line_id FROM residue_sale_shipment_item rssi WHERE rssi.consignment_item_id=ci.id) AS residue_sale_line_id
       FROM consignment_item ci JOIN material_measurement_set ms ON ms.consignment_item_id=ci.id AND ms.consignment_stage='DISPATCH'
       JOIN material_measurement mm ON mm.measurement_set_id=ms.id
       WHERE ci.consignment_id=:consignmentId AND mm.id IN (:measurementIds) ORDER BY ci.line_no FOR UPDATE OF ci`,
      { consignmentId, measurementIds: input.items.map((row) => row.measurementId) }, transaction,
    );
    if (items.length !== input.items.length) throw new AppError(400, 'INVALID_DISPATCH_MEASUREMENT', 'Select one recorded dispatch measurement for every consignment item.');
    assertDistinctIds(input.items.map((row) => row.consignmentItemId), 'items');
    const itemMap = new Map(input.items.map((row) => [row.consignmentItemId, row.measurementId]));
    if (items.some((item) => itemMap.get(item.id) !== item.measurement_id)) throw new AppError(400, 'INVALID_DISPATCH_MEASUREMENT', 'Dispatch measurements must match their consignment items.');
    const lines = items.flatMap((item) => [
      { batchId: item.batch_id, locationId: item.source_location_id, direction: 'OUT', quantityGrams: item.quantity_g, measurementSetId: item.measurement_set_id, measurementId: item.measurement_id, consignmentItemId: item.id, consignmentStage: 'DISPATCH', residueSaleLineId: item.residue_sale_line_id },
      { batchId: item.batch_id, locationId: consignment.transit_location_id, direction: 'IN', quantityGrams: item.quantity_g, measurementSetId: item.measurement_set_id, measurementId: item.measurement_id, consignmentItemId: item.id, consignmentStage: 'DISPATCH' },
    ]);
    const movement = await postMovementInTransaction({ movementKind: 'TRANSFER', lines, occurredAt: input.occurredAt, reason: input.evidenceRef ?? null, auth, transaction, mutationId });
    await sequelize.query(
      `INSERT INTO consignment_status_event(id,consignment_id,previous_status,next_status,actor_user_id,occurred_at,evidence_ref)
       VALUES (:id,:consignmentId,'DRAFT','DISPATCHED',:actor,:occurredAt,:evidence)`,
      { replacements: { id: randomUUID(), consignmentId, actor: auth.userId, occurredAt: input.occurredAt, evidence: input.evidenceRef ?? null }, transaction },
    );
    await sequelize.query(
      `UPDATE consignment SET status='DISPATCHED',dispatched_at=:occurredAt,dispatched_by_user_id=:actor,dispatch_evidence_ref=:evidence WHERE id=:id`,
      { replacements: { id: consignmentId, occurredAt: input.occurredAt, actor: auth.userId, evidence: input.evidenceRef ?? null }, transaction },
    );
    await appendAuditEvent({
      transaction, eventType: 'CONSIGNMENT.DISPATCHED', actorUserId: auth.userId, actorPartyId: auth.personPartyId,
      occurredAt: new Date(input.occurredAt), clientMutationId: mutationId,
      payload: { consignment_id: consignmentId, inventory_movement_id: movement.id, item_count: items.length },
      streams: [{ kind: 'consignment', id: consignmentId }, { kind: 'inventory_location', id: consignment.transit_location_id }, ...items.map((row) => ({ kind: 'material_batch', id: row.batch_id }))],
      expectedVersions: expectedVersionsFor(options),
    });
    return { ...movement, consignmentId, status: 'DISPATCHED' };
  }));
}

export async function addTransportLeg(consignmentId, input, auth, mutationId) {
  const sourceFacilityIds = await getConsignmentSourceFacilities(consignmentId);
  const [consignment] = await query(`SELECT destination_recovery_facility_id,status FROM consignment WHERE id=:id`, { id: consignmentId });
  if (!sourceFacilityIds.length || !consignment) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  let senderAccess = true;
  for (const sourceFacilityId of sourceFacilityIds) if (!(await canAccessProcessingFacility(auth, sourceFacilityId, { write: true }))) senderAccess = false;
  const recipientAccess = await canAccessRecoveryFacility(auth, consignment.destination_recovery_facility_id, { write: true });
  if (!senderAccess && !recipientAccess) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  if (consignment.status === 'DRAFT') throw new AppError(409, 'INVALID_CONSIGNMENT_STATE', 'Transport legs can be recorded after dispatch.');
  return sequelize.transaction(async (transaction) => executeIdempotent({
    actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'consignment.transport-leg', consignmentId, input }, transaction,
  }, async () => {
    const legId = randomUUID();
    await sequelize.query(
      `INSERT INTO transport_record(id,consignment_id,carrier_party_id,vehicle_ref,departure_at,arrival_at,evidence_ref)
       VALUES (:id,:consignmentId,:carrier,:vehicle,:departure,:arrival,:evidence)`,
      { replacements: { id: legId, consignmentId, carrier: input.carrierPartyId ?? null, vehicle: input.vehicleRef ?? null, departure: input.departureAt ?? null, arrival: input.arrivalAt ?? null, evidence: input.evidenceRef ?? null }, transaction },
    );
    await appendAuditEvent({
      transaction, eventType: 'CONSIGNMENT.TRANSPORT_LEG_RECORDED', actorUserId: auth.userId, actorPartyId: auth.personPartyId,
      occurredAt: new Date(input.departureAt ?? input.arrivalAt ?? Date.now()), clientMutationId: mutationId,
      payload: { consignment_id: consignmentId, transport_leg_id: legId, carrier_party_id: input.carrierPartyId ?? null },
      streams: [{ kind: 'consignment', id: consignmentId }],
    });
    return { id: legId, consignmentId, ...input };
  }));
}

export async function readConsignment(consignmentId, auth) {
  const [parent] = await query(`SELECT * FROM consignment WHERE id=:id`, { id: consignmentId });
  if (!parent) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  const sourceFacilityIds = await getConsignmentSourceFacilities(consignmentId);
  let senderAllowed = sourceFacilityIds.length > 0;
  for (const sourceFacilityId of sourceFacilityIds) if (!(await canAccessProcessingFacility(auth, sourceFacilityId))) senderAllowed = false;
  const receiverAllowed = await canAccessRecoveryFacility(auth, parent.destination_recovery_facility_id);
  if (!senderAllowed && !receiverAllowed) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  const items = await query(
    `SELECT ci.id,ci.batch_id,mb.batch_code,ci.source_location_id,ci.line_no,
       (SELECT mm.id FROM material_measurement_set dispatch_set
        JOIN material_measurement mm ON mm.measurement_set_id=dispatch_set.id
        WHERE dispatch_set.consignment_item_id=ci.id AND dispatch_set.consignment_stage='DISPATCH'
        ORDER BY mm.entered_at,mm.id LIMIT 1) AS dispatch_measurement_id,
       (SELECT COALESCE(sum(dispatch.posted_quantity_g-COALESCE(reversed.quantity_g,0)),0)::NUMERIC(20,6)
        FROM inventory_movement_line dispatch
        JOIN inventory_movement movement ON movement.id=dispatch.inventory_movement_id AND movement.current_status='ACCEPTED' AND movement.movement_kind='TRANSFER'
        LEFT JOIN LATERAL (
          SELECT COALESCE(sum(reverse_line.posted_quantity_g),0)::NUMERIC(20,6) AS quantity_g
          FROM inventory_movement_line reverse_line
          JOIN inventory_movement reverse_movement ON reverse_movement.id=reverse_line.inventory_movement_id AND reverse_movement.current_status='ACCEPTED' AND reverse_movement.movement_kind='REVERSAL'
          WHERE reverse_line.reverses_line_id=dispatch.id
        ) reversed ON true
        WHERE dispatch.consignment_item_id=ci.id AND dispatch.consignment_stage='DISPATCH' AND dispatch.direction='OUT') AS dispatched_quantity_g,
       COALESCE((SELECT sum(ri.quantity_g) FROM consignment_receipt_item ri WHERE ri.consignment_item_id=ci.id AND NOT EXISTS (SELECT 1 FROM consignment_receipt_item child WHERE child.supersedes_receipt_item_id=ri.id)),0)::NUMERIC(20,6) AS presented_receipt_quantity_g,
       COALESCE((SELECT sum(ri.quantity_g) FROM consignment_receipt_item ri WHERE ri.consignment_item_id=ci.id AND ri.outcome='ACCEPTED' AND NOT EXISTS (SELECT 1 FROM consignment_receipt_item child WHERE child.supersedes_receipt_item_id=ri.id)),0)::NUMERIC(20,6) AS accepted_receipt_quantity_g,
       COALESCE((SELECT sum(ri.quantity_g) FROM consignment_receipt_item ri WHERE ri.consignment_item_id=ci.id AND ri.outcome='DISPUTED' AND NOT EXISTS (SELECT 1 FROM consignment_receipt_item child WHERE child.supersedes_receipt_item_id=ri.id)),0)::NUMERIC(20,6) AS disputed_receipt_quantity_g,
       COALESCE((SELECT sum(ri.quantity_g) FROM consignment_receipt_item ri WHERE ri.consignment_item_id=ci.id AND ri.outcome='REJECTED' AND NOT EXISTS (SELECT 1 FROM consignment_receipt_item child WHERE child.supersedes_receipt_item_id=ri.id)),0)::NUMERIC(20,6) AS rejected_receipt_quantity_g
     FROM consignment_item ci JOIN material_batch mb ON mb.id=ci.batch_id WHERE ci.consignment_id=:id ORDER BY ci.line_no`,
    { id: consignmentId },
  );
  const legs = await query(`SELECT * FROM transport_record WHERE consignment_id=:id ORDER BY created_at,id`, { id: consignmentId });
  const receipts = await query(`SELECT * FROM consignment_receipt WHERE consignment_id=:id ORDER BY recorded_at,id`, { id: consignmentId });
  const receiptItems = await query(`SELECT * FROM consignment_receipt_item WHERE consignment_id=:id ORDER BY recorded_at,id`, { id: consignmentId });
  const custodyTransfers = await query(
    `SELECT ct.*,COALESCE(json_agg(json_build_object(
       'id',d.id,'decision',d.decision,'actorPartyId',d.actor_party_id,'occurredAt',d.occurred_at,
       'reason',d.reason,'evidenceRef',d.evidence_ref
     ) ORDER BY d.occurred_at,d.id) FILTER (WHERE d.id IS NOT NULL),'[]') AS decisions
     FROM custody_transfer ct LEFT JOIN custody_transfer_decision d ON d.custody_transfer_id=ct.id
     WHERE ct.consignment_id=:id GROUP BY ct.id ORDER BY ct.offered_at,ct.id`, { id: consignmentId },
  );
  return { ...parent, items, transportLegs: legs, receipts, receiptItems, custodyTransfers };
}

export async function createRecoveryInventoryLocation(facilityId, input, auth, mutationId) {
  await assertRecoveryAccess(auth, facilityId, true);
  return sequelize.transaction(async (transaction) => executeIdempotent({
    actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'recovery.inventory-location.create', facilityId, input }, transaction,
  }, async () => {
    const [facility] = await query(`SELECT id FROM recovery_facility WHERE id=:facilityId AND status='ACTIVE' FOR UPDATE`, { facilityId }, transaction);
    if (!facility) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
    const locationId = randomUUID();
    await sequelize.query(
      `INSERT INTO inventory_location(id,location_code,location_kind,custodian_party_id,physical_place_ref)
       VALUES (:id,:code,'RECOVERY_FACILITY',:custodian,:place)`,
      { replacements: { id: locationId, code: input.locationCode, custodian: auth.personPartyId, place: input.physicalPlaceRef ?? null }, transaction },
    );
    await sequelize.query(
      `INSERT INTO recovery_inventory_location(inventory_location_id,recovery_facility_id,location_ref) VALUES (:id,:facilityId,:place)`,
      { replacements: { id: locationId, facilityId, place: input.physicalPlaceRef ?? null }, transaction },
    );
    await appendAuditEvent({
      transaction, eventType: 'RECOVERY.INVENTORY_LOCATION_CREATED', actorUserId: auth.userId, actorPartyId: auth.personPartyId,
      occurredAt: new Date(), clientMutationId: mutationId, payload: { location_id: locationId, recovery_facility_id: facilityId },
      streams: [{ kind: 'inventory_location', id: locationId }, { kind: 'recovery_facility', id: facilityId }],
    });
    return { id: locationId, locationCode: input.locationCode, recoveryFacilityId: facilityId };
  }));
}

export async function listLocationBalances(locationId, auth) {
  const [location] = await query(
    `SELECT l.id,l.location_kind,s.processing_facility_id,ril.recovery_facility_id
     FROM inventory_location l LEFT JOIN residue_stockpile s ON s.inventory_location_id=l.id
     LEFT JOIN recovery_inventory_location ril ON ril.inventory_location_id=l.id WHERE l.id=:locationId`,
    { locationId },
  );
  if (!location) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  const doraAllowed = location.processing_facility_id && await canAccessProcessingFacility(auth, location.processing_facility_id);
  const recoveryAllowed = location.recovery_facility_id && await canAccessRecoveryFacility(auth, location.recovery_facility_id);
  const [consignment] = location.location_kind === 'CONSIGNMENT_TRANSIT'
    ? await query(`SELECT id,destination_recovery_facility_id FROM consignment WHERE transit_location_id=:locationId`, { locationId }) : [];
  let transitAllowed = false;
  if (consignment) {
    transitAllowed = await canAccessRecoveryFacility(auth, consignment.destination_recovery_facility_id);
    if (!transitAllowed) {
      const facilities = await getConsignmentSourceFacilities(consignment.id);
      transitAllowed = facilities.length > 0;
      for (const facilityId of facilities) if (!(await canAccessProcessingFacility(auth, facilityId))) transitAllowed = false;
    }
  }
  if (!doraAllowed && !recoveryAllowed && !transitAllowed) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  return query(
    `SELECT mb.id AS batch_id,mb.batch_code,mb.material_kind,
       COALESCE(sum(CASE WHEN ml.direction='IN' THEN ml.posted_quantity_g ELSE -ml.posted_quantity_g END),0)::NUMERIC(20,6) AS quantity_g
     FROM inventory_movement_line ml JOIN inventory_movement m ON m.id=ml.inventory_movement_id AND m.current_status='ACCEPTED'
     JOIN material_batch mb ON mb.id=ml.batch_id WHERE ml.location_id=:locationId
     GROUP BY mb.id,mb.batch_code,mb.material_kind ORDER BY mb.batch_code`,
    { locationId },
  );
}

export async function listInventoryMovements(locationId, auth) {
  await listLocationBalances(locationId, auth);
  return query(
    `SELECT m.id AS movement_id,m.movement_kind,m.occurred_at_claimed,m.recorded_at,m.current_status,m.reason,
            ml.id AS movement_line_id,ml.batch_id,mb.batch_code,mb.material_kind,ml.direction,ml.posted_quantity_g,
            ml.source_material_event_output_id,ml.consignment_receipt_item_id,ml.consignment_item_id,ml.consignment_stage,
            mm.measurement_kind,mm.source_value,mm.source_unit_code,mm.conversion_version,mm.source_role,
            mm.source_party_id,mm.method_code,mm.instrument_ref,mm.evidence_ref
     FROM inventory_movement_line ml JOIN inventory_movement m ON m.id=ml.inventory_movement_id
     JOIN material_batch mb ON mb.id=ml.batch_id
     LEFT JOIN material_measurement mm ON mm.id=ml.basis_measurement_id
     WHERE ml.location_id=:locationId
     ORDER BY m.occurred_at_claimed,m.recorded_at,m.id,ml.id`, { locationId },
  );
}

export async function receiveConsignment(consignmentId, input, auth, mutationId, options = {}) {
  const [parent] = await query(`SELECT * FROM consignment WHERE id=:id`, { id: consignmentId });
  if (!parent) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  await assertRecoveryAccess(auth, parent.destination_recovery_facility_id, true);
  assertDistinctIds(input.items.map((row) => row.consignmentItemId), 'items');
  return sequelize.transaction(async (transaction) => executeIdempotent({
    actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'residue.consignment.receive', consignmentId, input }, transaction,
  }, async () => {
    const [consignment] = await query(`SELECT * FROM consignment WHERE id=:id FOR UPDATE`, { id: consignmentId }, transaction);
    if (!['DISPATCHED','PART_RECEIVED','DISPUTED'].includes(consignment.status)) throw new AppError(409, 'INVALID_CONSIGNMENT_STATE', 'This consignment is not available for receipt.');
    const [destination] = await query(
      `SELECT inventory_location_id FROM recovery_inventory_location WHERE inventory_location_id=:locationId AND recovery_facility_id=:facilityId FOR UPDATE`,
      { locationId: input.recoveryInventoryLocationId, facilityId: consignment.destination_recovery_facility_id }, transaction,
    );
    if (!destination) throw new AppError(400, 'INVALID_RECOVERY_LOCATION', 'The destination location does not belong to this consignment recovery facility.');
    const itemRows = await query(
      `SELECT id,batch_id FROM consignment_item WHERE consignment_id=:consignmentId AND id IN (:itemIds) ORDER BY id FOR UPDATE`,
      { consignmentId, itemIds: input.items.map((row) => row.consignmentItemId) }, transaction,
    );
    if (itemRows.length !== input.items.length) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
    for (const item of input.items) await assertReceiptClaimWithinDispatch(item.consignmentItemId, item.quantityGrams, transaction);
    const receiptId = randomUUID();
    await sequelize.query(
      `INSERT INTO consignment_receipt(id,consignment_id,received_by_user_id,occurred_at_claimed,evidence_ref,note)
       VALUES (:id,:consignmentId,:actor,:occurredAt,:evidence,:note)`,
      { replacements: { id: receiptId, consignmentId, actor: auth.userId, occurredAt: input.occurredAt, evidence: input.evidenceRef ?? null, note: input.note ?? null }, transaction },
    );
    const lines = [];
    const results = [];
    for (const itemInput of input.items) {
      const item = itemRows.find((row) => row.id === itemInput.consignmentItemId);
      const receiptItemId = randomUUID();
      const setId = randomUUID();
      await sequelize.query(
        `INSERT INTO material_measurement_set(id,batch_id,consignment_item_id,consignment_stage) VALUES (:id,:batchId,:itemId,'RECEIPT')`,
        { replacements: { id: setId, batchId: item.batch_id, itemId: item.id }, transaction },
      );
      const measurementId = await insertMeasurement({ measurementSetId: setId, quantityGrams: itemInput.quantityGrams, input: itemInput.measurement, auth, occurredAt: input.occurredAt, transaction });
      await sequelize.query(
        `INSERT INTO consignment_receipt_item(id,receipt_id,consignment_id,consignment_item_id,batch_id,quantity_g,outcome,measurement_set_id,measurement_id,discrepancy_reason,evidence_ref)
         VALUES (:id,:receiptId,:consignmentId,:itemId,:batchId,:quantity,:outcome,:setId,:measurementId,:reason,:evidence)`,
        { replacements: {
          id: receiptItemId, receiptId, consignmentId, itemId: item.id, batchId: item.batch_id, quantity: itemInput.quantityGrams,
          outcome: itemInput.outcome, setId, measurementId, reason: itemInput.reason ?? null, evidence: itemInput.evidenceRef ?? input.evidenceRef ?? null,
        }, transaction },
      );
      if (itemInput.outcome === 'ACCEPTED') {
        lines.push(
          { batchId: item.batch_id, locationId: consignment.transit_location_id, direction: 'OUT', quantityGrams: itemInput.quantityGrams, measurementSetId: setId, measurementId, consignmentItemId: item.id, consignmentStage: 'RECEIPT', consignmentReceiptItemId: receiptItemId },
          { batchId: item.batch_id, locationId: destination.inventory_location_id, direction: 'IN', quantityGrams: itemInput.quantityGrams, measurementSetId: setId, measurementId, consignmentItemId: item.id, consignmentStage: 'RECEIPT', consignmentReceiptItemId: receiptItemId },
        );
      }
      results.push({ id: receiptItemId, consignmentItemId: item.id, batchId: item.batch_id, quantityGrams: itemInput.quantityGrams, outcome: itemInput.outcome });
    }
    let movement = null;
    if (lines.length) movement = await postMovementInTransaction({ movementKind: 'TRANSFER', lines, occurredAt: input.occurredAt, reason: input.evidenceRef ?? null, auth, transaction, mutationId });
    const [transit] = await query(
      `SELECT COALESCE(sum(CASE WHEN ml.direction='IN' THEN ml.posted_quantity_g ELSE -ml.posted_quantity_g END),0)::NUMERIC(20,6) AS quantity_g
       FROM inventory_movement_line ml JOIN inventory_movement m ON m.id=ml.inventory_movement_id AND m.current_status='ACCEPTED'
       WHERE ml.location_id=:locationId`, { locationId: consignment.transit_location_id }, transaction,
    );
    const [disputes] = await query(
      `SELECT EXISTS(
         SELECT 1 FROM consignment_receipt_item item
         WHERE item.consignment_id=:id AND item.outcome IN ('DISPUTED','REJECTED')
           AND NOT EXISTS (SELECT 1 FROM consignment_receipt_item child WHERE child.supersedes_receipt_item_id=item.id)
       ) AS has_dispute`,
      { id: consignmentId }, transaction,
    );
    const remains = toMicros(transit.quantity_g) > 0n;
    const nextStatus = remains ? (disputes.has_dispute ? 'DISPUTED' : 'PART_RECEIVED') : 'RECEIVED';
    if (nextStatus !== consignment.status) {
      await sequelize.query(
        `INSERT INTO consignment_status_event(id,consignment_id,previous_status,next_status,actor_user_id,occurred_at,evidence_ref)
         VALUES (:id,:consignmentId,:previous,:next,:actor,:occurredAt,:evidence)`,
        { replacements: { id: randomUUID(), consignmentId, previous: consignment.status, next: nextStatus, actor: auth.userId, occurredAt: input.occurredAt, evidence: input.evidenceRef ?? null }, transaction },
      );
      await sequelize.query(
        `UPDATE consignment SET status=:status,received_at=COALESCE(:receivedAt,received_at) WHERE id=:id`,
        { replacements: { id: consignmentId, status: nextStatus, receivedAt: nextStatus === 'RECEIVED' ? input.occurredAt : null }, transaction },
      );
    }
    await appendAuditEvent({
      transaction, eventType: 'CONSIGNMENT.RECEIPT_RECORDED', actorUserId: auth.userId, actorPartyId: auth.personPartyId,
      occurredAt: new Date(input.occurredAt), clientMutationId: mutationId,
      payload: { consignment_id: consignmentId, receipt_id: receiptId, status: nextStatus, accepted_item_count: results.filter((row) => row.outcome === 'ACCEPTED').length, disputed_item_count: results.filter((row) => row.outcome !== 'ACCEPTED').length, inventory_movement_id: movement?.id ?? null },
      streams: [{ kind: 'consignment', id: consignmentId }, { kind: 'recovery_facility', id: consignment.destination_recovery_facility_id }, { kind: 'inventory_location', id: consignment.transit_location_id }, { kind: 'inventory_location', id: destination.inventory_location_id }, ...results.map((row) => ({ kind: 'material_batch', id: row.batchId }))],
      expectedVersions: expectedVersionsFor(options),
    });
    return { id: receiptId, consignmentId, status: nextStatus, items: results, movement };
  }));
}

export async function correctConsignmentReceiptItem(consignmentId, receiptItemId, input, auth, mutationId, options = {}) {
  const [parent] = await query(`SELECT destination_recovery_facility_id FROM consignment WHERE id=:id`, { id: consignmentId });
  if (!parent) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  await assertRecoveryAccess(auth, parent.destination_recovery_facility_id, true);
  return sequelize.transaction(async (transaction) => executeIdempotent({
    actorScope: `user:${auth.userId}`, mutationId,
    payload: { action: 'residue.consignment.receipt.correct', consignmentId, receiptItemId, input }, transaction,
  }, async () => {
    const [consignment] = await query(`SELECT * FROM consignment WHERE id=:id FOR UPDATE`, { id: consignmentId }, transaction);
    if (!['DISPATCHED','PART_RECEIVED','DISPUTED','RECEIVED'].includes(consignment.status)) {
      throw new AppError(409, 'INVALID_CONSIGNMENT_STATE', 'This consignment does not have a correctable receipt.');
    }
    const [prior] = await query(
      `SELECT item.*,header.received_by_user_id,ci.batch_id,ci.consignment_id
       FROM consignment_receipt_item item
       JOIN consignment_receipt header ON header.id=item.receipt_id
       JOIN consignment_item ci ON ci.id=item.consignment_item_id
       WHERE item.id=:receiptItemId AND item.consignment_id=:consignmentId FOR UPDATE OF ci,item`,
      { receiptItemId, consignmentId }, transaction,
    );
    if (!prior || await query(`SELECT 1 FROM consignment_receipt_item WHERE supersedes_receipt_item_id=:id`, { id: receiptItemId }, transaction).then((rows) => rows.length > 0)) {
      throw new AppError(409, 'RECEIPT_OBSERVATION_NOT_CURRENT', 'Only a current receipt observation can be corrected.');
    }
    const [recoveryUse] = await query(
      `SELECT COALESCE(sum(source_quantity_g),0)::NUMERIC(20,6) AS quantity_g
       FROM recovery_event_input_source WHERE consignment_receipt_item_id=:receiptItemId`,
      { receiptItemId }, transaction,
    );
    if (toMicros(recoveryUse.quantity_g)>0n) {
      throw new AppError(409, 'RECEIPT_ALREADY_USED_IN_RECOVERY', 'A receipt already referenced by recovery genealogy cannot be revised.');
    }
    await assertReceiptClaimWithinDispatch(prior.consignment_item_id, input.quantityGrams, transaction, prior.id);
    const [destination] = await query(
      `SELECT inventory_location_id FROM recovery_inventory_location WHERE inventory_location_id=:locationId AND recovery_facility_id=:facilityId FOR UPDATE`,
      { locationId: input.recoveryInventoryLocationId, facilityId: consignment.destination_recovery_facility_id }, transaction,
    );
    if (!destination) throw new AppError(400, 'INVALID_RECOVERY_LOCATION', 'The destination location does not belong to this consignment recovery facility.');

    const receiptId = randomUUID();
    await sequelize.query(
      `INSERT INTO consignment_receipt(id,consignment_id,received_by_user_id,occurred_at_claimed,evidence_ref,note)
       VALUES (:id,:consignmentId,:actor,:occurredAt,:evidence,:note)`,
      { replacements: { id: receiptId, consignmentId, actor: auth.userId, occurredAt: input.occurredAt, evidence: input.evidenceRef ?? null, note: input.note ?? null }, transaction },
    );
    const measurementSetId = randomUUID();
    await sequelize.query(
      `INSERT INTO material_measurement_set(id,batch_id,consignment_item_id,consignment_stage) VALUES (:id,:batchId,:itemId,'RECEIPT')`,
      { replacements: { id: measurementSetId, batchId: prior.batch_id, itemId: prior.consignment_item_id }, transaction },
    );
    const measurementId = await insertMeasurement({ measurementSetId, quantityGrams: input.quantityGrams, input: input.measurement, auth, occurredAt: input.occurredAt, transaction });
    const correctedReceiptItemId = randomUUID();
    await sequelize.query(
      `INSERT INTO consignment_receipt_item(
         id,receipt_id,consignment_id,consignment_item_id,batch_id,quantity_g,outcome,measurement_set_id,measurement_id,
         discrepancy_reason,evidence_ref,supersedes_receipt_item_id,correction_reason
       ) VALUES (
         :id,:receiptId,:consignmentId,:itemId,:batchId,:quantity,:outcome,:measurementSetId,:measurementId,
         :reason,:evidence,:supersedesId,:correctionReason
       )`,
      { replacements: {
        id: correctedReceiptItemId, receiptId, consignmentId, itemId: prior.consignment_item_id, batchId: prior.batch_id,
        quantity: input.quantityGrams, outcome: input.outcome, measurementSetId, measurementId,
        reason: input.outcome === 'ACCEPTED' ? null : input.reason, evidence: input.evidenceRef ?? null,
        supersedesId: prior.id, correctionReason: input.correctionReason,
      }, transaction },
    );

    let reversal = null;
    if (prior.outcome === 'ACCEPTED') {
      const originalLines = await query(
        `SELECT line.*,movement.id AS movement_id FROM inventory_movement_line line
         JOIN inventory_movement movement ON movement.id=line.inventory_movement_id
           AND movement.current_status='ACCEPTED' AND movement.movement_kind='TRANSFER'
         WHERE line.consignment_receipt_item_id=:receiptItemId AND line.consignment_stage='RECEIPT'
         ORDER BY line.line_no FOR UPDATE OF movement`,
        { receiptItemId: prior.id }, transaction,
      );
      if (originalLines.length !== 2 || originalLines.some((line) => line.movement_id !== originalLines[0].movement_id)) {
        throw new AppError(409, 'RECEIPT_MOVEMENT_NOT_REVERSIBLE', 'The accepted receipt no longer has one complete paired movement to correct.');
      }
      reversal = await postMovementInTransaction({
        movementKind: 'REVERSAL', reversesMovementId: originalLines[0].movement_id,
        lines: originalLines.map((line) => ({
          batchId: line.batch_id, locationId: line.location_id, direction: line.direction === 'IN' ? 'OUT' : 'IN',
          quantityGrams: line.posted_quantity_g, reversesLineId: line.id,
        })),
        reason: input.correctionReason, occurredAt: input.occurredAt, auth, transaction, mutationId,
      });
    }

    let movement = null;
    if (input.outcome === 'ACCEPTED') {
      movement = await postMovementInTransaction({
        movementKind: 'TRANSFER',
        lines: [
          { batchId: prior.batch_id, locationId: consignment.transit_location_id, direction: 'OUT', quantityGrams: input.quantityGrams, measurementSetId, measurementId, consignmentItemId: prior.consignment_item_id, consignmentStage: 'RECEIPT', consignmentReceiptItemId: correctedReceiptItemId },
          { batchId: prior.batch_id, locationId: destination.inventory_location_id, direction: 'IN', quantityGrams: input.quantityGrams, measurementSetId, measurementId, consignmentItemId: prior.consignment_item_id, consignmentStage: 'RECEIPT', consignmentReceiptItemId: correctedReceiptItemId },
        ],
        occurredAt: input.occurredAt, reason: input.evidenceRef ?? null, auth, transaction, mutationId,
      });
    }

    const [transit] = await query(
      `SELECT COALESCE(sum(CASE WHEN line.direction='IN' THEN line.posted_quantity_g ELSE -line.posted_quantity_g END),0)::NUMERIC(20,6) AS quantity_g
       FROM inventory_movement_line line JOIN inventory_movement movement ON movement.id=line.inventory_movement_id AND movement.current_status='ACCEPTED'
       WHERE line.location_id=:locationId`,
      { locationId: consignment.transit_location_id }, transaction,
    );
    const [currentDisputes] = await query(
      `SELECT EXISTS(
         SELECT 1 FROM consignment_receipt_item item
         WHERE item.consignment_id=:consignmentId AND item.outcome IN ('DISPUTED','REJECTED')
           AND NOT EXISTS (SELECT 1 FROM consignment_receipt_item child WHERE child.supersedes_receipt_item_id=item.id)
       ) AS has_dispute`,
      { consignmentId }, transaction,
    );
    const remains = toMicros(transit.quantity_g) > 0n;
    const nextStatus = remains ? (currentDisputes.has_dispute ? 'DISPUTED' : 'PART_RECEIVED') : 'RECEIVED';
    if (nextStatus !== consignment.status) {
      await sequelize.query(
        `INSERT INTO consignment_status_event(id,consignment_id,previous_status,next_status,actor_user_id,occurred_at,evidence_ref)
         VALUES (:id,:consignmentId,:previous,:next,:actor,:occurredAt,:evidence)`,
        { replacements: { id: randomUUID(), consignmentId, previous: consignment.status, next: nextStatus, actor: auth.userId, occurredAt: input.occurredAt, evidence: input.evidenceRef ?? null }, transaction },
      );
      await sequelize.query(
        `UPDATE consignment SET status=:status,received_at=:receivedAt WHERE id=:id`,
        { replacements: { id: consignmentId, status: nextStatus, receivedAt: nextStatus === 'RECEIVED' ? input.occurredAt : null }, transaction },
      );
    }
    await appendAuditEvent({
      transaction, eventType: 'CONSIGNMENT.RECEIPT_CORRECTED', actorUserId: auth.userId, actorPartyId: auth.personPartyId,
      occurredAt: new Date(input.occurredAt), clientMutationId: mutationId,
      payload: {
        consignment_id: consignmentId, receipt_id: receiptId, prior_receipt_item_id: prior.id,
        corrected_receipt_item_id: correctedReceiptItemId, correction_reason: input.correctionReason,
        prior_outcome: prior.outcome, outcome: input.outcome, quantity_g: input.quantityGrams,
        reversal_movement_id: reversal?.id ?? null, inventory_movement_id: movement?.id ?? null, status: nextStatus,
      },
      streams: [{ kind: 'consignment', id: consignmentId }, { kind: 'recovery_facility', id: consignment.destination_recovery_facility_id }, { kind: 'material_batch', id: prior.batch_id }],
      expectedVersions: expectedVersionsFor(options),
    });
    return {
      id: receiptId, consignmentId, status: nextStatus,
      item: { id: correctedReceiptItemId, supersedesReceiptItemId: prior.id, consignmentItemId: prior.consignment_item_id, batchId: prior.batch_id, quantityGrams: input.quantityGrams, outcome: input.outcome, correctionReason: input.correctionReason },
      reversal, movement,
    };
  }));
}

export async function createCustodyOffer(consignmentId, input, auth, mutationId, options = {}) {
  const [consignment] = await query(`SELECT * FROM consignment WHERE id=:id`, { id: consignmentId });
  const sourceFacilityIds = await getConsignmentSourceFacilities(consignmentId);
  if (!consignment || !sourceFacilityIds.length) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  let senderAllowed = true;
  for (const id of sourceFacilityIds) if (!(await canAccessProcessingFacility(auth, id, { write: true }))) senderAllowed = false;
  if (!senderAllowed || consignment.status === 'DRAFT') throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  return sequelize.transaction(async (transaction) => executeIdempotent({
    actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'consignment.custody-offer', consignmentId, input }, transaction,
  }, async () => {
    const [destination] = await query(
      `SELECT inventory_location_id FROM recovery_inventory_location WHERE inventory_location_id=:locationId AND recovery_facility_id=:facilityId`,
      { locationId: input.destinationLocationId, facilityId: consignment.destination_recovery_facility_id }, transaction,
    );
    if (!destination) throw new AppError(400, 'INVALID_RECOVERY_LOCATION', 'Custody destination must be a location at the receiving facility.');
    const items = await query(
      `SELECT ci.id,ci.batch_id,COALESCE(sum(ml.posted_quantity_g),0)::NUMERIC(20,6) AS quantity_g
       FROM consignment_item ci JOIN inventory_movement_line ml ON ml.consignment_item_id=ci.id AND ml.consignment_stage='DISPATCH' AND ml.direction='OUT'
       JOIN inventory_movement m ON m.id=ml.inventory_movement_id AND m.current_status='ACCEPTED'
       WHERE ci.consignment_id=:consignmentId GROUP BY ci.id,ci.batch_id ORDER BY ci.id`,
      { consignmentId }, transaction,
    );
    if (!items.length) throw new AppError(409, 'NOT_DISPATCHED', 'Custody cannot be offered until inventory has been dispatched.');
    const transferId = randomUUID();
    await sequelize.query(
      `INSERT INTO custody_transfer(id,consignment_id,from_party_id,to_party_id,offered_at,status,offered_by_user_id,source_location_id,destination_location_id,evidence_ref)
       VALUES (:id,:consignmentId,:sender,:recipient,:occurredAt,'OFFERED',:actor,:source,:destination,:evidence)`,
      { replacements: {
        id: transferId, consignmentId, sender: consignment.sender_party_id, recipient: consignment.recipient_party_id,
        occurredAt: input.occurredAt, actor: auth.userId, source: consignment.transit_location_id,
        destination: destination.inventory_location_id, evidence: input.evidenceRef ?? null,
      }, transaction },
    );
    for (const item of items) await sequelize.query(
      `INSERT INTO custody_transfer_item(id,custody_transfer_id,consignment_item_id,batch_id,quantity_g) VALUES (:id,:transferId,:itemId,:batchId,:quantity)`,
      { replacements: { id: randomUUID(), transferId, itemId: item.id, batchId: item.batch_id, quantity: item.quantity_g }, transaction },
    );
    await appendAuditEvent({
      transaction, eventType: 'CUSTODY.TRANSFER_OFFERED', actorUserId: auth.userId, actorPartyId: auth.personPartyId,
      occurredAt: new Date(input.occurredAt), clientMutationId: mutationId,
      payload: { custody_transfer_id: transferId, consignment_id: consignmentId, item_count: items.length },
      streams: [{ kind: 'custody_transfer', id: transferId }, { kind: 'consignment', id: consignmentId }],
      expectedVersions: expectedVersionsFor(options),
    });
    return { id: transferId, consignmentId, status: 'OFFERED', itemCount: items.length };
  }));
}

export async function decideCustodyTransfer(transferId, input, auth, mutationId, options = {}) {
  const [transfer] = await query(
    `SELECT ct.*,c.destination_recovery_facility_id FROM custody_transfer ct JOIN consignment c ON c.id=ct.consignment_id WHERE ct.id=:id`,
    { id: transferId },
  );
  if (!transfer) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  if (input.decision === 'WITHDRAW') {
    const sourceFacilityIds = await getConsignmentSourceFacilities(transfer.consignment_id);
    let allowed = false;
    for (const id of sourceFacilityIds) if (await canAccessProcessingFacility(auth, id, { write: true })) allowed = true;
    if (!allowed || transfer.offered_by_user_id !== auth.userId) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  } else {
    await assertRecoveryAccess(auth, transfer.destination_recovery_facility_id, true);
  }
  return sequelize.transaction(async (transaction) => executeIdempotent({
    actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'custody.transfer.decision', transferId, input }, transaction,
  }, async () => {
    const [locked] = await query(`SELECT * FROM custody_transfer WHERE id=:id FOR UPDATE`, { id: transferId }, transaction);
    if (locked.status !== 'OFFERED') throw new AppError(409, 'INVALID_CUSTODY_STATE', 'Only an offered custody transfer can receive a decision.');
    const representedPartyId = input.decision === 'WITHDRAW' ? locked.from_party_id : locked.to_party_id;
    const eventId = randomUUID();
    await sequelize.query(
      `INSERT INTO custody_transfer_decision(id,custody_transfer_id,actor_user_id,actor_party_id,decision,occurred_at,reason,evidence_ref)
       VALUES (:id,:transferId,:actor,:party,:decision,:occurredAt,:reason,:evidence)`,
      { replacements: { id: eventId, transferId, actor: auth.userId, party: representedPartyId, decision: input.decision, occurredAt: input.occurredAt, reason: input.reason ?? null, evidence: input.evidenceRef ?? null }, transaction },
    );
    const status = input.decision === 'ACCEPT' ? 'ACCEPTED' : input.decision === 'DISPUTE' ? 'DISPUTED' : input.decision === 'REJECT' ? 'REJECTED' : 'WITHDRAWN';
    await sequelize.query(
      `UPDATE custody_transfer SET status=:status,accepted_at=:acceptedAt,accepted_by_user_id=:acceptedBy WHERE id=:id`,
      { replacements: { id: transferId, status, acceptedAt: status === 'ACCEPTED' ? input.occurredAt : null, acceptedBy: status === 'ACCEPTED' ? auth.userId : null }, transaction },
    );
    await appendAuditEvent({
      transaction, eventType: `CUSTODY.TRANSFER_${status}`, actorUserId: auth.userId, actorPartyId: auth.personPartyId,
      occurredAt: new Date(input.occurredAt), clientMutationId: mutationId,
      payload: { custody_transfer_id: transferId, decision_event_id: eventId, status, reason: input.reason ?? null },
      streams: [{ kind: 'custody_transfer', id: transferId }, { kind: 'consignment', id: locked.consignment_id }],
      expectedVersions: expectedVersionsFor(options),
    });
    return { id: transferId, status, decisionEventId: eventId };
  }));
}

export async function createResidueSale(input, auth, mutationId) {
  await assertDoraAccess(auth, input.processingFacilityId, true);
  const [buyerFacility] = await query(`SELECT id,party_id FROM recovery_facility WHERE id=:id AND status='ACTIVE'`, { id: input.recoveryFacilityId });
  if (!buyerFacility?.party_id) throw new AppError(400, 'INVALID_RECOVERY_FACILITY', 'The buyer recovery facility needs a recorded party.');
  if (auth.personPartyId === buyerFacility.party_id) throw new AppError(400, 'INVALID_COUNTERPARTIES', 'Sale buyer and seller must differ.');
  assertDistinctIds(input.lines.map((row) => row.batchId), 'lines');
  return sequelize.transaction(async (transaction) => executeIdempotent({
    actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'residue.sale.create', input }, transaction,
  }, async () => {
    const saleId = randomUUID();
    const saleCode = input.saleCode ?? `SALE-${saleId}`;
    await sequelize.query(
      `INSERT INTO residue_sale(id,sale_code,seller_party_id,buyer_party_id,agreed_at,currency_code,terms_ref)
       VALUES (:id,:code,:seller,:buyer,:agreedAt,:currency,:terms)`,
      { replacements: { id: saleId, code: saleCode, seller: auth.personPartyId, buyer: buyerFacility.party_id, agreedAt: input.agreedAt, currency: input.currencyCode, terms: input.termsRef ?? null }, transaction },
    );
    const lines = [];
    for (const [index, line] of input.lines.entries()) {
      const [source] = await query(
        `SELECT eo.id FROM material_event_output eo JOIN processing_event_output peo ON peo.material_event_output_id=eo.id
         JOIN processing_event pe ON pe.event_id=peo.processing_event_id JOIN material_batch mb ON mb.id=eo.batch_id
         WHERE eo.batch_id=:batchId AND pe.processing_facility_id=:facilityId AND peo.output_role='DORA_RETAINED_RESIDUE' AND mb.material_kind='RESIDUE'`,
        { batchId: line.batchId, facilityId: input.processingFacilityId }, transaction,
      );
      if (!source) throw new AppError(400, 'INVALID_RESIDUE_BATCH', 'Each sale line must reference residue retained by the selling Dora.');
      const lineId = randomUUID();
      await sequelize.query(
        `INSERT INTO residue_sale_line(id,residue_sale_id,batch_id,revision_no,revision_kind,transaction_quantity_g,unit_price,line_amount)
         VALUES (:id,:saleId,:batchId,1,'ORIGINAL',:quantity,:price,:amount)`,
        { replacements: { id: lineId, saleId, batchId: line.batchId, quantity: line.quantityGrams, price: line.unitPrice ?? null, amount: line.lineAmount ?? null }, transaction },
      );
      await sequelize.query(
        `INSERT INTO material_measurement_set(id,batch_id,residue_sale_line_id) VALUES (:id,:batchId,:lineId)`,
        { replacements: { id: randomUUID(), batchId: line.batchId, lineId }, transaction },
      );
      lines.push({ id: lineId, batchId: line.batchId, proposedQuantityGrams: line.quantityGrams, accepted: false });
    }
    await appendAuditEvent({
      transaction, eventType: 'RESIDUE_SALE.PROPOSED', actorUserId: auth.userId, actorPartyId: auth.personPartyId,
      occurredAt: new Date(input.agreedAt), clientMutationId: mutationId,
      payload: { residue_sale_id: saleId, seller_facility_id: input.processingFacilityId, buyer_facility_id: buyerFacility.id, line_ids: lines.map((row) => row.id), currency_code: input.currencyCode },
      streams: [{ kind: 'residue_sale', id: saleId }, { kind: 'processing_facility', id: input.processingFacilityId }, { kind: 'recovery_facility', id: buyerFacility.id }, ...lines.map((row) => ({ kind: 'material_batch', id: row.batchId }))],
    });
    return { id: saleId, saleCode, status: 'PROPOSED', currencyCode: input.currencyCode, lines };
  }));
}

export async function proposeResidueSaleLineRevision(saleId, lineId, input, auth, mutationId) {
  const [line] = await query(
    `SELECT rsl.*,rs.seller_party_id,rs.buyer_party_id,pe.processing_facility_id,rf.id AS recovery_facility_id
     FROM residue_sale_line rsl JOIN residue_sale rs ON rs.id=rsl.residue_sale_id
     JOIN material_event_output eo ON eo.batch_id=rsl.batch_id JOIN processing_event_output peo ON peo.material_event_output_id=eo.id
     JOIN processing_event pe ON pe.event_id=peo.processing_event_id
     LEFT JOIN recovery_facility rf ON rf.party_id=rs.buyer_party_id
     WHERE rsl.id=:lineId AND rs.id=:saleId`,
    { lineId, saleId },
  );
  if (!line) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  const sellerAllowed = await canAccessProcessingFacility(auth, line.processing_facility_id, { write: true });
  const buyerAllowed = line.recovery_facility_id && await canAccessRecoveryFacility(auth, line.recovery_facility_id, { write: true });
  const representedPartyId = auth.personPartyId === line.seller_party_id && sellerAllowed
    ? line.seller_party_id
    : buyerAllowed ? line.buyer_party_id : null;
  if (!representedPartyId) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  return sequelize.transaction(async (transaction) => executeIdempotent({
    actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'residue.sale.line.revision.propose', saleId, lineId, input }, transaction,
  }, async () => {
    await query(`SELECT id FROM residue_sale WHERE id=:saleId FOR UPDATE`, { saleId }, transaction);
    const [prior] = await query(`SELECT * FROM residue_sale_line WHERE id=:lineId AND residue_sale_id=:saleId FOR UPDATE`, { lineId, saleId }, transaction);
    if (!prior || prior.is_accepted || await query(`SELECT 1 FROM residue_sale_line WHERE supersedes_line_id=:lineId`, { lineId }, transaction).then((rows) => rows.length > 0)) {
      throw new AppError(409, 'SALE_LINE_NOT_CURRENT', 'Only the current unresolved sale line can be revised.');
    }
    const decisions = await query(
      `SELECT actor_party_id,accepted_quantity_g FROM residue_sale_decision_event
       WHERE residue_sale_line_id=:lineId AND decision='ACCEPT'`,
      { lineId }, transaction,
    );
    const seller = decisions.find((row) => row.actor_party_id === line.seller_party_id);
    const buyer = decisions.find((row) => row.actor_party_id === line.buyer_party_id);
    if (!seller || !buyer || seller.accepted_quantity_g === buyer.accepted_quantity_g) {
      throw new AppError(409, 'SALE_LINE_DECISION_MISMATCH_REQUIRED', 'A successor proposal is available only after both counterparties accept different quantities.');
    }
    const revisionNo = prior.revision_no + 1;
    const successorId = randomUUID();
    await sequelize.query(
      `INSERT INTO residue_sale_line(
         id,residue_sale_id,batch_id,revision_no,revision_kind,transaction_quantity_g,unit_price,line_amount,
         supersedes_line_id,correction_reason,resolves_decision_mismatch
       ) VALUES (:id,:saleId,:batchId,:revision,'CORRECTION',:quantity,:unitPrice,:lineAmount,:prior,:reason,true)`,
      { replacements: {
        id: successorId, saleId, batchId: prior.batch_id, revision: revisionNo, quantity: input.quantityGrams,
        unitPrice: input.unitPrice ?? prior.unit_price, lineAmount: input.lineAmount ?? prior.line_amount,
        prior: prior.id, reason: input.correctionReason,
      }, transaction },
    );
    await sequelize.query(
      `INSERT INTO material_measurement_set(id,batch_id,residue_sale_line_id) VALUES (:id,:batchId,:lineId)`,
      { replacements: { id: randomUUID(), batchId: prior.batch_id, lineId: successorId }, transaction },
    );
    await appendAuditEvent({
      transaction, eventType: 'RESIDUE_SALE.LINE_REVISION_PROPOSED', actorUserId: auth.userId, actorPartyId: auth.personPartyId,
      occurredAt: new Date(input.occurredAt), clientMutationId: mutationId,
      payload: {
        residue_sale_id: saleId, prior_line_id: prior.id, successor_line_id: successorId,
        revision_no: revisionNo, quantity_g: input.quantityGrams, correction_reason: input.correctionReason,
        seller_prior_quantity_g: seller.accepted_quantity_g, buyer_prior_quantity_g: buyer.accepted_quantity_g,
      },
      streams: [{ kind: 'residue_sale', id: saleId }, { kind: 'material_batch', id: prior.batch_id }],
    });
    return { id: successorId, saleId, batchId: prior.batch_id, revisionNo, supersedesLineId: prior.id, proposedQuantityGrams: input.quantityGrams, accepted: false };
  }));
}

export async function decideResidueSaleLine(saleId, lineId, input, auth, mutationId) {
  const [line] = await query(
    `SELECT rsl.*,rs.seller_party_id,rs.buyer_party_id,rs.currency_code,pe.processing_facility_id,
       rf.id AS recovery_facility_id
     FROM residue_sale_line rsl JOIN residue_sale rs ON rs.id=rsl.residue_sale_id
     JOIN material_event_output eo ON eo.batch_id=rsl.batch_id JOIN processing_event_output peo ON peo.material_event_output_id=eo.id
     JOIN processing_event pe ON pe.event_id=peo.processing_event_id
     LEFT JOIN recovery_facility rf ON rf.party_id=rs.buyer_party_id
     WHERE rsl.id=:lineId AND rs.id=:saleId`,
    { lineId, saleId },
  );
  if (!line) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  const sellerAllowed = await canAccessProcessingFacility(auth, line.processing_facility_id, { write: true });
  const buyerAllowed = line.recovery_facility_id && await canAccessRecoveryFacility(auth, line.recovery_facility_id, { write: true });
  if (!sellerAllowed && !buyerAllowed) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  const representedPartyId = auth.personPartyId === line.seller_party_id && sellerAllowed
    ? line.seller_party_id
    : buyerAllowed ? line.buyer_party_id : null;
  if (!representedPartyId) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  return sequelize.transaction(async (transaction) => executeIdempotent({
    actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'residue.sale.line.decision', saleId, lineId, input }, transaction,
  }, async () => {
    const [locked] = await query(`SELECT * FROM residue_sale_line WHERE id=:lineId AND residue_sale_id=:saleId FOR UPDATE`, { lineId, saleId }, transaction);
    if (!locked || locked.is_accepted) throw new AppError(409, 'INVALID_SALE_LINE_STATE', 'Only a proposed sale line can receive a counterparty decision.');
    if (input.decision === 'ACCEPT' && toMicros(input.acceptedQuantityGrams) > toMicros(locked.transaction_quantity_g)) {
      throw new AppError(400, 'ACCEPTED_QUANTITY_EXCEEDS_PROPOSAL', 'Accepted residue quantity cannot exceed the proposed sale quantity.');
    }
    const [priorDecision] = await query(
      `SELECT decision FROM residue_sale_decision_event WHERE residue_sale_line_id=:lineId AND actor_party_id=:partyId`,
      { lineId, partyId: representedPartyId }, transaction,
    );
    if (priorDecision) throw new AppError(409, 'SALE_DECISION_ALREADY_RECORDED', 'This counterparty has already decided this sale-line revision.');
    const decisionId = randomUUID();
    await sequelize.query(
      `INSERT INTO residue_sale_decision_event(id,residue_sale_line_id,actor_user_id,actor_party_id,decision,accepted_quantity_g,occurred_at,reason,evidence_ref)
       VALUES (:id,:lineId,:actor,:party,:decision,:quantity,:occurredAt,:reason,:evidence)`,
      { replacements: { id: decisionId, lineId, actor: auth.userId, party: representedPartyId, decision: input.decision, quantity: input.decision === 'ACCEPT' ? input.acceptedQuantityGrams : null, occurredAt: input.occurredAt, reason: input.reason ?? null, evidence: input.evidenceRef ?? null }, transaction },
    );
    let acceptedLineId = null;
    if (input.decision === 'ACCEPT') {
      const decisions = await query(`SELECT actor_party_id,accepted_quantity_g FROM residue_sale_decision_event WHERE residue_sale_line_id=:lineId AND decision='ACCEPT'`, { lineId }, transaction);
      const seller = decisions.find((row) => row.actor_party_id === line.seller_party_id);
      const buyer = decisions.find((row) => row.actor_party_id === line.buyer_party_id);
      if (seller && buyer && seller.accepted_quantity_g === buyer.accepted_quantity_g) {
        const eligible = await lockAndGetEligibleResidueQuantity(locked.batch_id, line.processing_facility_id, transaction);
        if (toMicros(buyer.accepted_quantity_g) > eligible) {
          throw new AppError(409, 'INSUFFICIENT_ELIGIBLE_RESIDUE', 'The agreed quantity exceeds residue available after other accepted sale commitments.');
        }
        acceptedLineId = randomUUID();
        await sequelize.query(
          `INSERT INTO residue_sale_line(id,residue_sale_id,batch_id,revision_no,revision_kind,transaction_quantity_g,accepted_trade_quantity_g,unit_price,line_amount,supersedes_line_id,correction_reason,is_accepted)
           VALUES (:id,:saleId,:batchId,:revision,'CORRECTION',:quantity,:accepted,:price,:amount,:prior,'Counterparties recorded the accepted residue quantity',true)`,
          { replacements: { id: acceptedLineId, saleId, batchId: locked.batch_id, revision: locked.revision_no + 1, quantity: locked.transaction_quantity_g, accepted: buyer.accepted_quantity_g, price: locked.unit_price, amount: locked.line_amount, prior: lineId }, transaction },
        );
        await sequelize.query(
          `INSERT INTO material_measurement_set(id,batch_id,residue_sale_line_id) VALUES (:id,:batchId,:lineId)`,
          { replacements: { id: randomUUID(), batchId: locked.batch_id, lineId: acceptedLineId }, transaction },
        );
      }
    }
    await appendAuditEvent({
      transaction, eventType: `RESIDUE_SALE.LINE_${input.decision}`, actorUserId: auth.userId, actorPartyId: auth.personPartyId,
      occurredAt: new Date(input.occurredAt), clientMutationId: mutationId,
      payload: { residue_sale_id: saleId, proposed_line_id: lineId, accepted_line_id: acceptedLineId, decision: input.decision, accepted_quantity_g: input.acceptedQuantityGrams ?? null },
      streams: [{ kind: 'residue_sale', id: saleId }, { kind: 'material_batch', id: locked.batch_id }],
    });
    return { id: decisionId, saleId, proposedLineId: lineId, acceptedLineId, decision: input.decision };
  }));
}

export async function readResidueSale(saleId, auth) {
  const [sale] = await query(`SELECT * FROM residue_sale WHERE id=:saleId`, { saleId });
  if (!sale) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  const lines = await query(
    `SELECT rsl.*,mb.batch_code,pe.processing_facility_id FROM residue_sale_line rsl JOIN material_batch mb ON mb.id=rsl.batch_id
     JOIN material_event_output eo ON eo.batch_id=rsl.batch_id JOIN processing_event_output peo ON peo.material_event_output_id=eo.id
     JOIN processing_event pe ON pe.event_id=peo.processing_event_id WHERE rsl.residue_sale_id=:saleId ORDER BY rsl.batch_id,rsl.revision_no`,
    { saleId },
  );
  let authorized = false;
  for (const line of lines) if (await canAccessProcessingFacility(auth, line.processing_facility_id)) authorized = true;
  const buyerFacilities = await query(`SELECT id FROM recovery_facility WHERE party_id=:partyId`, { partyId: sale.buyer_party_id });
  for (const facility of buyerFacilities) if (await canAccessRecoveryFacility(auth, facility.id)) authorized = true;
  if (!authorized) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  const decisions = await query(
    `SELECT d.* FROM residue_sale_decision_event d JOIN residue_sale_line l ON l.id=d.residue_sale_line_id WHERE l.residue_sale_id=:saleId ORDER BY d.recorded_at,d.id`,
    { saleId },
  );
  return { ...sale, lines, decisions };
}

export async function listAccessibleResidueSales(auth) {
  const sales = await query(
    `SELECT id,sale_code,seller_party_id,buyer_party_id,agreed_at,currency_code,terms_ref,created_at
     FROM residue_sale ORDER BY created_at DESC,id`,
  );
  const visible = [];
  for (const sale of sales) {
    const sellerFacilities = await query(
      `SELECT DISTINCT pe.processing_facility_id
       FROM residue_sale_line line JOIN material_event_output eo ON eo.batch_id=line.batch_id
       JOIN processing_event_output peo ON peo.material_event_output_id=eo.id
       JOIN processing_event pe ON pe.event_id=peo.processing_event_id
       WHERE line.residue_sale_id=:saleId`, { saleId: sale.id },
    );
    let allowed = false;
    for (const row of sellerFacilities) {
      if (await canAccessProcessingFacility(auth, row.processing_facility_id)) { allowed = true; break; }
    }
    if (!allowed) {
      const buyerFacilities = await query(`SELECT id FROM recovery_facility WHERE party_id=:partyId`, { partyId: sale.buyer_party_id });
      for (const facility of buyerFacilities) {
        if (await canAccessRecoveryFacility(auth, facility.id)) { allowed = true; break; }
      }
    }
    if (allowed) visible.push(sale);
  }
  return visible;
}

export async function adjustInventory(locationId, input, auth, mutationId, options = {}) {
  const balances = await listLocationBalances(locationId, auth);
  const [location] = await query(
    `SELECT s.processing_facility_id,ril.recovery_facility_id FROM inventory_location l
     LEFT JOIN residue_stockpile s ON s.inventory_location_id=l.id
     LEFT JOIN recovery_inventory_location ril ON ril.inventory_location_id=l.id WHERE l.id=:locationId`, { locationId },
  );
  if (!location) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  if (location.processing_facility_id) await assertDoraAccess(auth, location.processing_facility_id, true);
  else if (location.recovery_facility_id) await assertRecoveryAccess(auth, location.recovery_facility_id, true);
  else throw new AppError(400, 'INVALID_ADJUSTMENT_LOCATION', 'Only typed stockpile or recovery inventory locations can be adjusted.');
  return sequelize.transaction(async (transaction) => executeIdempotent({
    actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'inventory.adjustment', locationId, input }, transaction,
  }, async () => {
    const [batch] = await query(`SELECT id FROM material_batch WHERE id=:batchId FOR SHARE`, { batchId: input.batchId }, transaction);
    if (!batch) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
    await lockInventoryBalanceKeys([{ locationId, batchId: input.batchId }], transaction);
    const [current] = await query(
      `SELECT COALESCE(sum(CASE WHEN ml.direction='IN' THEN ml.posted_quantity_g ELSE -ml.posted_quantity_g END),0)::NUMERIC(20,6) AS quantity_g
       FROM inventory_movement_line ml JOIN inventory_movement m ON m.id=ml.inventory_movement_id AND m.current_status='ACCEPTED'
       WHERE ml.location_id=:locationId AND ml.batch_id=:batchId`, { locationId, batchId: input.batchId }, transaction,
    );
    const delta = toMicros(input.countedQuantityGrams) - toMicros(current.quantity_g);
    if (delta === 0n) throw new AppError(409, 'NO_ADJUSTMENT_REQUIRED', 'The recorded count matches the derived balance.');
    const countId = randomUUID();
    const setId = randomUUID();
    await sequelize.query(
      `INSERT INTO inventory_count(id,location_id,batch_id,counted_at_claimed,actor_user_id,evidence_ref)
       VALUES (:id,:locationId,:batchId,:occurredAt,:actor,:evidence)`,
      { replacements: { id: countId, locationId, batchId: input.batchId, occurredAt: input.occurredAt, actor: auth.userId, evidence: input.evidenceRef }, transaction },
    );
    await sequelize.query(`INSERT INTO material_measurement_set(id,batch_id,inventory_count_id) VALUES (:id,:batchId,:countId)`, { replacements: { id: setId, batchId: input.batchId, countId }, transaction });
    const measurementId = await insertMeasurement({ measurementSetId: setId, quantityGrams: input.countedQuantityGrams, input: input.measurement, auth, occurredAt: input.occurredAt, transaction });
    const movement = await postMovementInTransaction({
      movementKind: 'ADJUSTMENT', lines: [{
        batchId: input.batchId, locationId, direction: delta > 0n ? 'IN' : 'OUT', quantityGrams: microsToGrams(delta > 0n ? delta : -delta),
        measurementSetId: setId, measurementId, inventoryCountId: countId,
      }], reason: input.reason, occurredAt: input.occurredAt, auth, transaction, mutationId, expectedVersions: expectedVersionsFor(options),
    });
    await appendAuditEvent({
      transaction, eventType: 'INVENTORY.COUNT_ADJUSTMENT_RECORDED', actorUserId: auth.userId, actorPartyId: auth.personPartyId,
      occurredAt: new Date(input.occurredAt), clientMutationId: mutationId,
      payload: { inventory_movement_id: movement.id, location_id: locationId, batch_id: input.batchId, count_quantity_g: input.countedQuantityGrams, reason: input.reason, evidence_ref: input.evidenceRef },
      streams: [{ kind: 'inventory_movement', id: movement.id }, { kind: 'inventory_location', id: locationId }, { kind: 'material_batch', id: input.batchId }],
    });
    return movement;
  }));
}

export async function createRecoveryEvent(facilityId, input, auth, mutationId) {
  await assertRecoveryAccess(auth, facilityId, true);
  assertDistinctIds(input.inputs.map((row) => row.batchId), 'inputs');
  return sequelize.transaction(async (transaction) => executeIdempotent({
    actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'recovery.event.create', facilityId, input }, transaction,
  }, async () => {
    const [facility] = await query(`SELECT id,status FROM recovery_facility WHERE id=:facilityId AND status='ACTIVE' FOR UPDATE`, { facilityId }, transaction);
    const [inventoryLocation] = await query(
      `SELECT inventory_location_id FROM recovery_inventory_location WHERE inventory_location_id=:locationId AND recovery_facility_id=:facilityId FOR UPDATE`,
      { locationId: input.recoveryInventoryLocationId, facilityId }, transaction,
    );
    if (!facility || !inventoryLocation) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
    const eventId = randomUUID();
    await sequelize.query(
      `INSERT INTO material_event(id,event_code,event_kind,occurred_at_claimed,responsible_party_id,actor_user_id,current_status,notes_ref)
       VALUES (:id,:code,'RECOVERY',:occurredAt,:party,:userId,'SUBMITTED',:notes)`,
      { replacements: { id: eventId, code: `EVT-${eventId}`, occurredAt: input.occurredAt, party: auth.personPartyId, userId: auth.userId, notes: input.notesRef ?? null }, transaction },
    );
    await sequelize.query(
      `INSERT INTO recovery_event(event_id,recovery_facility_id,operator_party_id,method_ref) VALUES (:id,:facilityId,:operator,:method)`,
      { replacements: { id: eventId, facilityId, operator: auth.personPartyId, method: input.methodRef ?? null }, transaction },
    );
    const inputs = [];
    for (const [index, item] of input.inputs.entries()) {
      const sourceTotal = item.sources.reduce((sum, source) => sum + toMicros(source.quantityGrams), 0n);
      if (sourceTotal !== toMicros(item.quantityGrams)) throw new AppError(400, 'INVALID_SOURCE_ALLOCATION', 'Recorded source quantities must reconcile to the consumed batch measurement.');
      const receiptIds = item.sources.map((source) => source.receiptItemId);
      assertDistinctIds(receiptIds, 'input.sources');
      const receiptRows = await query(
        `SELECT ri.id,ri.batch_id,ri.consignment_item_id,ri.quantity_g,ri.outcome,c.destination_recovery_facility_id
         FROM consignment_receipt_item ri JOIN consignment_item ci ON ci.id=ri.consignment_item_id
         JOIN consignment c ON c.id=ci.consignment_id WHERE ri.id IN (:receiptIds)
           AND NOT EXISTS (SELECT 1 FROM consignment_receipt_item successor WHERE successor.supersedes_receipt_item_id=ri.id)
         ORDER BY ri.id FOR UPDATE OF ci`,
        { receiptIds }, transaction,
      );
      if (receiptRows.length !== receiptIds.length || receiptRows.some((row) => row.outcome !== 'ACCEPTED' || row.batch_id !== item.batchId || row.destination_recovery_facility_id !== facilityId)) {
        throw new AppError(400, 'INVALID_RECOVERY_SOURCE', 'Recovery inputs must trace to accepted receipts of this facility and batch.');
      }
      const batch = await query(`SELECT id,material_kind FROM material_batch WHERE id=:id FOR SHARE`, { id: item.batchId }, transaction);
      if (!batch.length || batch[0].material_kind !== 'RESIDUE') throw new AppError(400, 'INVALID_RECOVERY_INPUT', 'Recovery inputs must be residue batches.');
      const inputId = randomUUID();
      await sequelize.query(`INSERT INTO material_event_input(id,event_id,batch_id,input_sequence) VALUES (:id,:eventId,:batchId,:sequence)`, { replacements: { id: inputId, eventId, batchId: item.batchId, sequence: index + 1 }, transaction });
      await sequelize.query(`INSERT INTO recovery_event_input(material_event_input_id,recovery_event_id,batch_id) VALUES (:id,:eventId,:batchId)`, { replacements: { id: inputId, eventId, batchId: item.batchId }, transaction });
      const measurementSetId = randomUUID();
      await sequelize.query(`INSERT INTO material_measurement_set(id,batch_id,material_event_input_id) VALUES (:id,:batchId,:inputId)`, { replacements: { id: measurementSetId, batchId: item.batchId, inputId }, transaction });
      const measurementId = await insertMeasurement({ measurementSetId, quantityGrams: item.quantityGrams, input: item.measurement, auth, occurredAt: input.occurredAt, transaction });
      for (const source of item.sources) {
        const receipt = receiptRows.find((row) => row.id === source.receiptItemId);
        const [previouslyAllocated] = await query(
          `SELECT COALESCE(sum(source_quantity_g),0)::NUMERIC(20,6) AS quantity_g FROM recovery_event_input_source WHERE consignment_receipt_item_id=:receiptId`,
          { receiptId: receipt.id }, transaction,
        );
        if (toMicros(previouslyAllocated.quantity_g) + toMicros(source.quantityGrams) > toMicros(receipt.quantity_g)) {
          throw new AppError(409, 'SOURCE_QUANTITY_EXHAUSTED', 'Recorded recovery input cannot exceed the unconsumed accepted receipt quantity.');
        }
        await sequelize.query(
          `INSERT INTO recovery_event_input_source(id,recovery_event_input_id,recovery_event_id,batch_id,consignment_receipt_item_id,consignment_item_id,source_quantity_g)
           VALUES (:id,:inputId,:eventId,:batchId,:receiptId,:consignmentItemId,:quantity)`,
          { replacements: { id: randomUUID(), inputId, eventId, batchId: item.batchId, receiptId: receipt.id, consignmentItemId: receipt.consignment_item_id, quantity: source.quantityGrams }, transaction },
        );
      }
      inputs.push({ id: inputId, batchId: item.batchId, quantityGrams: item.quantityGrams, measurementSetId, measurementId });
    }
    const outputs = [];
    for (const [index, output] of input.outputs.entries()) {
      const batchId = randomUUID();
      const outputId = randomUUID();
      const batchCode = `BATCH-${batchId}`;
      await sequelize.query(`INSERT INTO material_batch(id,batch_code,material_kind,current_status) VALUES (:id,:code,:kind,'ACTIVE')`, { replacements: { id: batchId, code: batchCode, kind: output.materialKind }, transaction });
      await sequelize.query(
        `INSERT INTO material_event_output(id,event_id,batch_id,output_sequence,output_kind) VALUES (:id,:eventId,:batchId,:sequence,:kind)`,
        { replacements: { id: outputId, eventId, batchId, sequence: index + 1, kind: output.outputKind ?? output.outputRole }, transaction },
      );
      await sequelize.query(
        `INSERT INTO recovery_event_output(material_event_output_id,recovery_event_id,batch_id,output_role) VALUES (:id,:eventId,:batchId,:role)`,
        { replacements: { id: outputId, eventId, batchId, role: output.outputRole }, transaction },
      );
      const measurementSetId = randomUUID();
      await sequelize.query(`INSERT INTO material_measurement_set(id,batch_id,material_event_output_id) VALUES (:id,:batchId,:outputId)`, { replacements: { id: measurementSetId, batchId, outputId }, transaction });
      const measurementId = await insertMeasurement({ measurementSetId, quantityGrams: output.quantityGrams, input: output.measurement, auth, occurredAt: input.occurredAt, transaction });
      for (const recoveryInput of inputs) await sequelize.query(
        `INSERT INTO recovery_output_input_link(recovery_event_id,material_event_output_id,material_event_input_id,batch_id) VALUES (:eventId,:outputId,:inputId,:outputBatchId)`,
        { replacements: { eventId, outputId, inputId: recoveryInput.id, outputBatchId: batchId }, transaction },
      );
      outputs.push({ id: outputId, batchId, batchCode, materialKind: output.materialKind, outputRole: output.outputRole, quantityGrams: output.quantityGrams, measurementSetId, measurementId });
    }
    for (const stage of input.stages ?? []) await sequelize.query(
      `INSERT INTO recovery_process_stage(id,recovery_event_id,stage_code,occurred_at_claimed,evidence_ref,note,recorded_by_user_id)
       VALUES (:id,:eventId,:code,:occurredAt,:evidence,:note,:actor)`,
      { replacements: { id: randomUUID(), eventId, code: stage.stageCode, occurredAt: stage.occurredAt, evidence: stage.evidenceRef ?? null, note: stage.note ?? null, actor: auth.userId }, transaction },
    );
    for (const variance of input.variances ?? []) await sequelize.query(
      `INSERT INTO recovery_variance(id,recovery_event_id,variance_kind,expected_quantity_g,observed_quantity_g,variance_quantity_g,reason,evidence_ref,recorded_by_user_id)
       VALUES (:id,:eventId,:kind,:expected,:observed,:variance,:reason,:evidence,:actor)`,
      { replacements: { id: randomUUID(), eventId, kind: variance.varianceKind, expected: variance.expectedQuantityGrams ?? null, observed: variance.observedQuantityGrams ?? null, variance: variance.varianceQuantityGrams ?? null, reason: variance.reason, evidence: variance.evidenceRef ?? null, actor: auth.userId }, transaction },
    );
    const movementLines = [
      ...inputs.map((row) => ({ batchId: row.batchId, locationId: inventoryLocation.inventory_location_id, direction: 'OUT', quantityGrams: row.quantityGrams, measurementSetId: row.measurementSetId, measurementId: row.measurementId, materialEventInputId: row.id })),
      ...outputs.map((row) => ({ batchId: row.batchId, locationId: inventoryLocation.inventory_location_id, direction: 'IN', quantityGrams: row.quantityGrams, measurementSetId: row.measurementSetId, measurementId: row.measurementId, materialEventOutputId: row.id })),
    ];
    const movement = await postMovementInTransaction({ movementKind: 'TRANSFORMATION', eventId, lines: movementLines, occurredAt: input.occurredAt, reason: input.varianceNote ?? null, auth, transaction, mutationId });
    await appendAuditEvent({
      transaction, eventType: 'RECOVERY.EVENT_RECORDED', actorUserId: auth.userId, actorPartyId: auth.personPartyId,
      occurredAt: new Date(input.occurredAt), clientMutationId: mutationId,
      payload: { recovery_event_id: eventId, recovery_facility_id: facilityId, inventory_movement_id: movement.id, input_count: inputs.length, output_count: outputs.length, source_receipt_item_ids: input.inputs.flatMap((row) => row.sources.map((source) => source.receiptItemId)) },
      streams: [{ kind: 'material_event', id: eventId }, { kind: 'recovery_facility', id: facilityId }, ...[...inputs, ...outputs].map((row) => ({ kind: 'material_batch', id: row.batchId }))],
    });
    return { id: eventId, eventKind: 'RECOVERY', recoveryFacilityId: facilityId, occurredAt: input.occurredAt, inventoryMovementId: movement.id, inputs, outputs, stages: input.stages ?? [], variances: input.variances ?? [] };
  }));
}

export async function readRecoveryEvent(eventId, auth) {
  const [event] = await query(
    `SELECT me.id,me.event_code,me.occurred_at_claimed,me.recorded_at,re.recovery_facility_id,re.operator_party_id,re.method_ref
     FROM recovery_event re JOIN material_event me ON me.id=re.event_id WHERE re.event_id=:eventId`, { eventId },
  );
  if (!event) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  await assertRecoveryAccess(auth, event.recovery_facility_id, false);
  const inputs = await query(
    `SELECT ri.material_event_input_id AS id,ri.batch_id,mb.batch_code,mm.id AS measurement_id,
       mm.measurement_kind,mm.quantity_g,mm.source_value,mm.source_unit_code,mm.conversion_version,
       mm.source_role,mm.source_party_id,mm.method_code,mm.instrument_ref,mm.evidence_ref,
       COALESCE(json_agg(json_build_object(
         'receipt_item_id',src.consignment_receipt_item_id,'consignment_item_id',src.consignment_item_id,
         'consignment_id',ci.consignment_id,'consignment_code',c.consignment_code,'quantity_g',src.source_quantity_g
       ) ORDER BY src.consignment_receipt_item_id) FILTER (WHERE src.id IS NOT NULL),'[]') AS sources
     FROM recovery_event_input ri JOIN material_batch mb ON mb.id=ri.batch_id
     JOIN material_measurement_set ms ON ms.material_event_input_id=ri.material_event_input_id
     JOIN material_measurement mm ON mm.measurement_set_id=ms.id
     LEFT JOIN recovery_event_input_source src ON src.recovery_event_input_id=ri.material_event_input_id
     LEFT JOIN consignment_item ci ON ci.id=src.consignment_item_id
     LEFT JOIN consignment c ON c.id=ci.consignment_id
     WHERE ri.recovery_event_id=:eventId GROUP BY ri.material_event_input_id,ri.batch_id,mb.batch_code,mm.id,mm.measurement_kind,mm.quantity_g,mm.source_value,mm.source_unit_code,mm.conversion_version,mm.source_role,mm.source_party_id,mm.method_code,mm.instrument_ref,mm.evidence_ref ORDER BY ri.material_event_input_id`, { eventId },
  );
  const outputs = await query(
    `SELECT ro.material_event_output_id AS id,ro.batch_id,mb.batch_code,mb.material_kind,ro.output_role,
       mm.id AS measurement_id,mm.measurement_kind,mm.quantity_g,mm.source_value,mm.source_unit_code,
       mm.conversion_version,mm.source_role,mm.source_party_id,mm.method_code,mm.instrument_ref,mm.evidence_ref,
       array_agg(DISTINCT ri.batch_id ORDER BY ri.batch_id) AS contributing_batch_ids
     FROM recovery_event_output ro JOIN material_batch mb ON mb.id=ro.batch_id
     JOIN material_measurement_set ms ON ms.material_event_output_id=ro.material_event_output_id
     JOIN material_measurement mm ON mm.measurement_set_id=ms.id
     JOIN recovery_output_input_link link ON link.material_event_output_id=ro.material_event_output_id
     JOIN recovery_event_input ri ON ri.material_event_input_id=link.material_event_input_id
     WHERE ro.recovery_event_id=:eventId GROUP BY ro.material_event_output_id,ro.batch_id,mb.batch_code,mb.material_kind,ro.output_role,mm.id,mm.measurement_kind,mm.quantity_g,mm.source_value,mm.source_unit_code,mm.conversion_version,mm.source_role,mm.source_party_id,mm.method_code,mm.instrument_ref,mm.evidence_ref`, { eventId },
  );
  const stages = await query(`SELECT stage_code,occurred_at_claimed,evidence_ref,note FROM recovery_process_stage WHERE recovery_event_id=:eventId ORDER BY occurred_at_claimed,id`, { eventId });
  const variances = await query(`SELECT variance_kind,expected_quantity_g,observed_quantity_g,variance_quantity_g,reason,evidence_ref FROM recovery_variance WHERE recovery_event_id=:eventId ORDER BY recorded_at,id`, { eventId });
  return { ...event, inputs, outputs, stages, variances };
}
