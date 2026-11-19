import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../database/connection.mjs';
import { AppError } from '../../utils/errors.mjs';
import { appendAuditEvent } from '../audit/audit.service.mjs';
import { executeIdempotent } from '../commands/idempotency.service.mjs';
import { lockInventoryBalanceKeys, postMovementInTransaction } from '../inventory/inventory.service.mjs';

const query = (sql, replacements = {}, transaction) => sequelize.query(sql, {
  replacements, ...(transaction ? { transaction } : {}), type: QueryTypes.SELECT,
});
const write = (sql, replacements = {}, transaction) => sequelize.query(sql, { replacements, transaction });
const MICRO = 1_000_000n;
const MONEY_SCALE = 100_000_000n;
const MEMBER_ROLES = ['LOCAL_MERCHANT', 'LARGER_MERCHANT', 'MINING_OPERATOR', 'DORA_OPERATOR', 'RECOVERY_FACILITY_OPERATOR', 'FIELD_OFFICER', 'MINER'];

function toScaled(value, scale) {
  const [whole, fraction = ''] = String(value).split('.');
  return BigInt(whole) * scale + BigInt(fraction.padEnd(String(scale).length - 1, '0') || '0');
}

function formatScaled(value, scale) {
  return `${value / scale}.${String(value % scale).padStart(String(scale).length - 1, '0')}`;
}

function calculateAmount(quantityGrams, unitPrice) {
  const product = toScaled(quantityGrams, MICRO) * toScaled(unitPrice, MONEY_SCALE);
  const divisor = MICRO;
  const amount = product / divisor + (product % divisor >= divisor / 2n ? 1n : 0n);
  return formatScaled(amount, MONEY_SCALE);
}

function toMicros(value) {
  return toScaled(value, MICRO);
}

function addMoney(values) {
  return formatScaled(values.reduce((total, value) => total + toScaled(value ?? '0', MONEY_SCALE), 0n), MONEY_SCALE);
}

function subtractMoney(left, right) {
  return formatScaled(toScaled(left, MONEY_SCALE) - toScaled(right, MONEY_SCALE), MONEY_SCALE);
}

function assertUniqueBatchIds(lines) {
  if (new Set(lines.map((line) => line.batchId)).size !== lines.length) {
    throw new AppError(400, 'DUPLICATE_BATCH', 'A gold batch may appear only once in a trade proposal.');
  }
}

async function isRepresentedParty(auth, partyId, transaction) {
  if (auth.personPartyId === partyId) return true;
  const rows = await query(
    `SELECT 1 FROM organisation_membership om JOIN role_assignment ra ON ra.user_id=:userId
     WHERE om.person_party_id=:personPartyId AND om.organisation_party_id=:partyId
       AND om.status='ACTIVE' AND om.valid_from<=now() AND (om.valid_to IS NULL OR om.valid_to>now())
       AND ra.role_code IN (:roleCodes) AND ra.scope_kind='ORGANISATION' AND ra.scope_id=:partyId
       AND ra.status='ACTIVE' AND ra.valid_from<=now() AND (ra.valid_to IS NULL OR ra.valid_to>now()) LIMIT 1`,
    { userId: auth.userId, personPartyId: auth.personPartyId, partyId, roleCodes: MEMBER_ROLES }, transaction,
  );
  return rows.length > 0;
}

async function isRepresentedPartyAt(auth, partyId, occurredAt, transaction) {
  const [party] = await query(`SELECT party_kind,status FROM party WHERE id=:partyId`, { partyId }, transaction);
  if (!party || party.status !== 'ACTIVE') return false;
  if (party.party_kind === 'PERSON') return auth.personPartyId === partyId;
  const rows = await query(
    `SELECT 1 FROM organisation_membership om JOIN role_assignment ra ON ra.user_id=:userId
     WHERE om.person_party_id=:personPartyId AND om.organisation_party_id=:partyId
       AND om.status='ACTIVE' AND om.valid_from<=:occurredAt AND (om.valid_to IS NULL OR om.valid_to>:occurredAt)
       AND ra.role_code IN (:roleCodes) AND ra.scope_kind='ORGANISATION' AND ra.scope_id=:partyId
       AND ra.status='ACTIVE' AND ra.valid_from<=:occurredAt AND (ra.valid_to IS NULL OR ra.valid_to>:occurredAt) LIMIT 1`,
    { userId: auth.userId, personPartyId: auth.personPartyId, partyId, occurredAt, roleCodes: MEMBER_ROLES }, transaction,
  );
  return rows.length > 0;
}

async function assertAssayForBatch(assayRecordId, batchId, transaction) {
  if (!assayRecordId) return;
  const [assay] = await query(
    `SELECT a.id FROM assay_record a WHERE a.id=:assayRecordId AND a.batch_id=:batchId
       AND NOT EXISTS(SELECT 1 FROM assay_record successor WHERE successor.correction_of_id=a.id)`,
    { assayRecordId, batchId }, transaction,
  );
  if (!assay) throw new AppError(400, 'INVALID_ASSAY', 'The selected current assay record does not belong to this gold batch.');
}

async function assertGoldMeasurementSource({ auth, line, sourceRole, requestedSourcePartyId, occurredAt, transaction }) {
  let sourcePartyId = requestedSourcePartyId;
  if (sourceRole === 'SELLER') {
    sourcePartyId ??= line.seller_party_id;
    if (sourcePartyId !== line.seller_party_id) throw new AppError(400, 'INVALID_MEASUREMENT_SOURCE', 'Seller observations must identify the trade seller.');
  } else if (sourceRole === 'BUYER') {
    sourcePartyId ??= line.buyer_party_id;
    if (sourcePartyId !== line.buyer_party_id) throw new AppError(400, 'INVALID_MEASUREMENT_SOURCE', 'Buyer observations must identify the trade buyer.');
  } else if (sourceRole === 'RECORDER') {
    sourcePartyId ??= auth.personPartyId;
    if (sourcePartyId !== auth.personPartyId) throw new AppError(400, 'INVALID_MEASUREMENT_SOURCE', 'Recorder observations must identify the authenticated recorder.');
  } else if (!sourcePartyId) {
    throw new AppError(400, 'MEASUREMENT_SOURCE_REQUIRED', 'Witness, weigher and other observations require an explicit source party.');
  }
  if (!(await isRepresentedPartyAt(auth, sourcePartyId, occurredAt, transaction))) {
    throw new AppError(400, 'INVALID_MEASUREMENT_SOURCE', 'The authenticated user is not authorized to record this source party at the claimed observation time.');
  }
  return sourcePartyId;
}

async function resolveTradeParty(auth, trade, allowedPartyIds = [trade.seller_party_id, trade.buyer_party_id], transaction) {
  for (const partyId of allowedPartyIds) {
    if (await isRepresentedParty(auth, partyId, transaction)) return partyId;
  }
  throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
}

async function assertActiveParty(partyId, transaction) {
  const [party] = await query(`SELECT id FROM party WHERE id=:partyId AND status='ACTIVE'`, { partyId }, transaction);
  if (!party) throw new AppError(400, 'INVALID_PARTY', 'Both gold trade parties must be active.');
}

async function assertEligibleBuyer(partyId, effectiveAt, transaction) {
  const eligible = await query(
    `SELECT 1 FROM party_participation WHERE party_id=:partyId AND status='ACTIVE'
       AND valid_from<=:effectiveAt AND (valid_to IS NULL OR valid_to>:effectiveAt)
       AND participant_kind IN ('LOCAL_MERCHANT','LARGER_MERCHANT') LIMIT 1`,
    { partyId, effectiveAt }, transaction,
  );
  if (!eligible.length) throw new AppError(400, 'INELIGIBLE_BUYER', 'The buyer must have an active local-merchant or larger-merchant participation.');
}

async function getEligibleGoldBatch(batchId, transaction) {
  const [batch] = await query(
    `SELECT b.id,b.batch_code,b.material_kind,b.current_status,o.id AS output_id,o.event_id,
       e.event_kind,e.current_status AS event_status,
       p.production_event_id IS NOT NULL AS from_production,
       po.output_role AS processing_output_role,
       ro.output_role AS recovery_output_role
     FROM material_batch b JOIN material_event_output o ON o.batch_id=b.id
     JOIN material_event e ON e.id=o.event_id
     LEFT JOIN production_event_output p ON p.material_event_output_id=o.id
     LEFT JOIN processing_event_output po ON po.material_event_output_id=o.id
     LEFT JOIN recovery_event_output ro ON ro.material_event_output_id=o.id
     WHERE b.id=:batchId AND b.current_status='ACTIVE' AND e.current_status IN ('SUBMITTED','ACCEPTED')
       AND ((b.material_kind='GOLD_DORE' AND p.material_event_output_id IS NOT NULL)
         OR (b.material_kind IN ('GOLD_DORE','RECOVERED_GOLD') AND po.output_role='MINER_RETAINED_GOLD')
         OR (b.material_kind='RECOVERED_GOLD' AND ro.output_role='RECOVERED_GOLD'))
     ORDER BY o.created_at LIMIT 1`,
    { batchId }, transaction,
  );
  if (!batch) throw new AppError(400, 'INELIGIBLE_GOLD_BATCH', 'Only active gold-dore or recovered-gold outputs from accepted source events can be traded.');
  return batch;
}

async function sellerInventory(batchId, sellerPartyId, transaction, lock = false) {
  const locations = await query(
    `SELECT DISTINCT l.id AS location_id FROM inventory_location l
     LEFT JOIN merchant_inventory_location m ON m.inventory_location_id=l.id
     WHERE l.status='ACTIVE' AND (l.custodian_party_id=:sellerPartyId OR m.merchant_party_id=:sellerPartyId)
       AND EXISTS(SELECT 1 FROM inventory_balance b WHERE b.location_id=l.id AND b.batch_id=:batchId AND b.quantity_g>0)
     ORDER BY l.id`,
    { sellerPartyId, batchId }, transaction,
  );
  if (lock && locations.length) await lockInventoryBalanceKeys(locations.map((row) => ({ locationId: row.location_id, batchId })), transaction);
  const balances = await query(
    `SELECT l.id AS location_id,COALESCE(b.quantity_g,0)::NUMERIC(20,6) AS quantity_g
     FROM inventory_location l LEFT JOIN merchant_inventory_location m ON m.inventory_location_id=l.id
     LEFT JOIN inventory_balance b ON b.location_id=l.id AND b.batch_id=:batchId
     WHERE l.status='ACTIVE' AND (l.custodian_party_id=:sellerPartyId OR m.merchant_party_id=:sellerPartyId)
       AND COALESCE(b.quantity_g,0)>0 ORDER BY l.id`,
    { sellerPartyId, batchId }, transaction,
  );
  return balances;
}

async function assertSellerAvailability(batchId, sellerPartyId, quantity, transaction) {
  const balances = await sellerInventory(batchId, sellerPartyId, transaction, true);
  const [commitments] = await query(
    `SELECT COALESCE(sum(GREATEST(line.accepted_trade_quantity_g-COALESCE(moved.quantity_g,0),0)),0)::NUMERIC(20,6) AS quantity_g
     FROM gold_trade_line line JOIN gold_trade trade ON trade.id=line.trade_id
     LEFT JOIN LATERAL (
       SELECT COALESCE(sum(outgoing.posted_quantity_g-COALESCE(reversed.quantity_g,0)),0)::NUMERIC(20,6) AS quantity_g
       FROM inventory_movement_line outgoing JOIN inventory_movement movement ON movement.id=outgoing.inventory_movement_id AND movement.current_status='ACCEPTED'
       LEFT JOIN LATERAL (SELECT sum(reverse_line.posted_quantity_g) AS quantity_g FROM inventory_movement_line reverse_line
         JOIN inventory_movement reverse_movement ON reverse_movement.id=reverse_line.inventory_movement_id AND reverse_movement.current_status='ACCEPTED' AND reverse_movement.movement_kind='REVERSAL'
         WHERE reverse_line.reverses_line_id=outgoing.id) reversed ON true
       WHERE outgoing.gold_trade_line_id=line.id AND outgoing.direction='OUT'
     ) moved ON true
     WHERE line.batch_id=:batchId AND trade.seller_party_id=:sellerPartyId AND line.is_accepted
       AND NOT EXISTS(SELECT 1 FROM gold_trade_line child WHERE child.supersedes_line_id=line.id)`,
    { batchId, sellerPartyId }, transaction,
  );
  const available = balances.reduce((sum, row) => sum + toMicros(row.quantity_g), 0n) - toMicros(commitments.quantity_g);
  if (available < toMicros(quantity)) throw new AppError(409, 'INSUFFICIENT_INVENTORY', 'The seller does not have enough available inventory for this gold quantity.');
  return balances;
}

async function insertMeasurementSet(lineId, batchId, transaction) {
  const id = randomUUID();
  await write(`INSERT INTO material_measurement_set(id,batch_id,gold_trade_line_id) VALUES (:id,:batchId,:lineId)`, { id, batchId, lineId }, transaction);
  return id;
}

async function recordTradeStatus({ tradeId, trade, nextStatus, auth, representedPartyId, occurredAt, reason = null, evidenceRef = null, transaction }) {
  if (trade.status === nextStatus) return;
  await write(
    `INSERT INTO gold_trade_status_event(id,gold_trade_id,previous_status,next_status,actor_user_id,actor_party_id,occurred_at,reason,evidence_ref)
     VALUES (:id,:tradeId,:previous,:next,:userId,:partyId,:occurredAt,:reason,:evidenceRef)`,
    { id: randomUUID(), tradeId, previous: trade.status, next: nextStatus, userId: auth.userId, partyId: representedPartyId, occurredAt, reason, evidenceRef }, transaction,
  );
  await write(`UPDATE gold_trade SET status=:status,agreed_at=:agreedAt WHERE id=:tradeId`, {
    tradeId, status: nextStatus, agreedAt: nextStatus === 'AGREED' ? occurredAt : null,
  }, transaction);
  trade.status = nextStatus;
}

async function assertLineCurrent(lineId, transaction) {
  const [child] = await query(`SELECT id FROM gold_trade_line WHERE supersedes_line_id=:lineId`, { lineId }, transaction);
  if (child) throw new AppError(409, 'STALE_TRADE_LINE', 'A successor proposal already exists for this trade line.');
}

async function assertCurrentMeasurement(measurementId, measurementSetId, transaction) {
  const [measurement] = await query(
    `SELECT id,quantity_g,measurement_kind FROM material_measurement WHERE id=:measurementId AND measurement_set_id=:measurementSetId
       AND measurement_kind IN ('MEASURED','VERIFIED')
       AND NOT EXISTS(SELECT 1 FROM material_measurement successor WHERE successor.supersedes_measurement_id=material_measurement.id)`,
    { measurementId, measurementSetId }, transaction,
  );
  if (!measurement) throw new AppError(400, 'INVALID_TRADE_MEASUREMENT', 'A current measured observation on this trade line is required.');
  return measurement;
}

async function appendEvidence(tradeId, evidence, auth, representedPartyId, transaction) {
  if (!evidence) return null;
  const id = randomUUID();
  await write(
    `INSERT INTO gold_trade_evidence(id,gold_trade_id,evidence_kind,evidence_ref,note,actor_user_id,actor_party_id,occurred_at)
     VALUES (:id,:tradeId,:kind,:ref,:note,:userId,:partyId,:occurredAt)`,
    { id, tradeId, kind: evidence.kind, ref: evidence.reference, note: evidence.note ?? null, userId: auth.userId, partyId: representedPartyId, occurredAt: evidence.occurredAt }, transaction,
  );
  return id;
}

function lineAmount(quantityGrams, unitPrice) {
  return calculateAmount(quantityGrams, unitPrice);
}

async function currentAssayId(assayRecordId, batchId, transaction) {
  if (!assayRecordId) return null;
  const [assay] = await query(
    `WITH RECURSIVE assay_chain AS (
       SELECT id,batch_id FROM assay_record WHERE id=:assayRecordId AND batch_id=:batchId
       UNION ALL
       SELECT successor.id,successor.batch_id FROM assay_record successor
         JOIN assay_chain prior ON successor.correction_of_id=prior.id
     )
     SELECT assay_chain.id FROM assay_chain
     WHERE NOT EXISTS(SELECT 1 FROM assay_record successor WHERE successor.correction_of_id=assay_chain.id)
     LIMIT 1`,
    { assayRecordId, batchId }, transaction,
  );
  if (!assay) throw new AppError(400, 'INVALID_ASSAY', 'The selected assay record does not belong to this gold batch.');
  return assay.id;
}

async function createProposalLine({ tradeId, line, revisionNo = 1, supersedesLineId = null, correctionReason = null, assayRecordId = line.assayRecordId ?? null }, transaction) {
  await assertAssayForBatch(assayRecordId, line.batchId, transaction);
  if (supersedesLineId) {
    const [prior] = await query(`SELECT id,is_current,trade_id,batch_id FROM gold_trade_line WHERE id=:id FOR UPDATE`, { id: supersedesLineId }, transaction);
    if (!prior || !prior.is_current || prior.trade_id !== tradeId || prior.batch_id !== line.batchId) {
      throw new AppError(409, 'STALE_TRADE_LINE', 'A successor must revise the current line for the same trade and batch.');
    }
  }
  const id = randomUUID();
  const amount = lineAmount(line.quantityGrams, line.unitPrice);
  await write(
    `INSERT INTO gold_trade_line(id,trade_id,batch_id,revision_no,revision_kind,transaction_quantity_g,
       accepted_trade_quantity_g,unit_price,line_amount,assay_record_id,supersedes_line_id,correction_reason,
       is_accepted,deduction_amount,deduction_reason,is_current)
     VALUES (:id,:tradeId,:batchId,:revision,:kind,:quantity,NULL,:unitPrice,:amount,:assayRecordId,:supersedes,:reason,false,:deduction,:deductionReason,:isCurrent)`,
    {
      id, tradeId, batchId: line.batchId, revision: revisionNo, kind: supersedesLineId ? 'CORRECTION' : 'ORIGINAL',
      quantity: line.quantityGrams, unitPrice: line.unitPrice, amount, assayRecordId, supersedes: supersedesLineId,
      isCurrent: !supersedesLineId,
      reason: correctionReason, deduction: line.deductionAmount ?? '0.00000000',
      deductionReason: line.deductionAmount && toScaled(line.deductionAmount, MONEY_SCALE) > 0n ? line.deductionReason : null,
    }, transaction,
  );
  const measurementSetId = await insertMeasurementSet(id, line.batchId, transaction);
  if (supersedesLineId) {
    await write(`UPDATE gold_trade_line SET is_current=false WHERE id=:priorId`, { priorId: supersedesLineId }, transaction);
    await write(`UPDATE gold_trade_line SET is_current=true WHERE id=:id`, { id }, transaction);
  }
  return { id, batchId: line.batchId, measurementSetId, quantityGrams: line.quantityGrams, unitPrice: line.unitPrice, lineAmount: amount };
}

export async function createGoldTrade(input, auth, mutationId) {
  assertUniqueBatchIds(input.lines);
  await assertActiveParty(input.sellerPartyId);
  await assertActiveParty(input.buyerPartyId);
  await assertEligibleBuyer(input.buyerPartyId, input.tradeDate);
  if (input.sellerPartyId === input.buyerPartyId) throw new AppError(400, 'INVALID_COUNTERPARTIES', 'Gold trade seller and buyer must differ.');
  const representedPartyId = await resolveTradeParty(auth, { seller_party_id: input.sellerPartyId, buyer_party_id: input.buyerPartyId });
  return sequelize.transaction(async (transaction) => executeIdempotent({
    actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'gold-trade.create', input }, transaction,
  }, async () => {
    const tradeId = randomUUID();
    const tradeCode = input.tradeCode ?? `GT-${tradeId.slice(0, 8).toUpperCase()}`;
    await write(
      `INSERT INTO gold_trade(id,trade_code,trade_kind,buyer_party_id,seller_party_id,agreed_at,trade_date,
         currency_code,terms_ref,created_by_user_id,status)
       VALUES (:id,:code,:kind,:buyer,:seller,NULL,:tradeDate,:currency,:termsRef,:actor,'PROPOSED')`,
      { id: tradeId, code: tradeCode, kind: input.tradeKind, buyer: input.buyerPartyId, seller: input.sellerPartyId,
        tradeDate: input.tradeDate, currency: input.currencyCode, termsRef: input.termsRef ?? null, actor: auth.userId }, transaction,
    );
    await write(
      `INSERT INTO gold_trade_status_event(id,gold_trade_id,previous_status,next_status,actor_user_id,actor_party_id,occurred_at,evidence_ref)
       VALUES (:id,:tradeId,NULL,'PROPOSED',:userId,:partyId,:occurredAt,:evidenceRef)`,
      { id: randomUUID(), tradeId, userId: auth.userId, partyId: representedPartyId, occurredAt: input.tradeDate, evidenceRef: input.evidence?.reference ?? null }, transaction,
    );
    const lines = [];
    for (const line of input.lines) {
      await getEligibleGoldBatch(line.batchId, transaction);
      await assertSellerAvailability(line.batchId, input.sellerPartyId, line.quantityGrams, transaction);
      lines.push(await createProposalLine({ tradeId, line }, transaction));
    }
    const evidenceId = await appendEvidence(tradeId, input.evidence, auth, representedPartyId, transaction);
    await appendAuditEvent({
      transaction, eventType: 'GOLD_TRADE.PROPOSED', actorUserId: auth.userId, actorPartyId: auth.personPartyId,
      occurredAt: new Date(input.tradeDate), clientMutationId: mutationId,
      payload: { gold_trade_id: tradeId, trade_code: tradeCode, seller_party_id: input.sellerPartyId,
        buyer_party_id: input.buyerPartyId, line_count: lines.length, evidence_id: evidenceId },
      streams: [{ kind: 'gold_trade', id: tradeId }, ...lines.map((line) => ({ kind: 'material_batch', id: line.batchId }))],
    });
    return { id: tradeId, tradeCode, status: 'PROPOSED', lines };
  }));
}

export async function addGoldTradeLine(tradeId, line, auth, mutationId) {
  const [trade] = await query(`SELECT * FROM gold_trade WHERE id=:tradeId`, { tradeId });
  if (!trade) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  const representedPartyId = await resolveTradeParty(auth, trade);
  if (!['PROPOSED','DISPUTED'].includes(trade.status)) throw new AppError(409, 'TRADE_NOT_OPEN', 'A batch can be added only to an open trade proposal.');
  return sequelize.transaction(async (transaction) => executeIdempotent({ actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'gold-trade.line.add', tradeId, line }, transaction }, async () => {
    const [locked] = await query(`SELECT * FROM gold_trade WHERE id=:tradeId FOR UPDATE`, { tradeId }, transaction);
    if (!['PROPOSED','DISPUTED'].includes(locked.status)) throw new AppError(409, 'TRADE_NOT_OPEN', 'A batch can be added only to an open trade proposal.');
    const [existingLine] = await query(`SELECT id FROM gold_trade_line WHERE trade_id=:tradeId AND batch_id=:batchId AND is_current`, { tradeId, batchId: line.batchId }, transaction);
    if (existingLine) throw new AppError(409, 'DUPLICATE_BATCH', 'This gold batch already has a current line in the trade. Revise its existing line instead.');
    await getEligibleGoldBatch(line.batchId, transaction);
    await assertSellerAvailability(line.batchId, locked.seller_party_id, line.quantityGrams, transaction);
    const result = await createProposalLine({ tradeId, line }, transaction);
    if (locked.status === 'DISPUTED') await recordTradeStatus({ tradeId, trade: locked, nextStatus: 'PROPOSED', auth, representedPartyId, occurredAt: line.occurredAt ?? new Date().toISOString(), reason: 'New gold batch proposal added', transaction });
    await appendAuditEvent({ transaction, eventType: 'GOLD_TRADE.LINE_PROPOSED', actorUserId: auth.userId, actorPartyId: auth.personPartyId, occurredAt: new Date(line.occurredAt ?? new Date()), clientMutationId: mutationId, payload: { trade_id: tradeId, line_id: result.id, batch_id: result.batchId }, streams: [{ kind: 'gold_trade', id: tradeId }, { kind: 'material_batch', id: result.batchId }] });
    return result;
  }));
}

export async function recordGoldTradeMeasurement(tradeId, lineId, input, auth, mutationId) {
  const [line] = await query(`SELECT l.*,t.seller_party_id,t.buyer_party_id,t.status FROM gold_trade_line l JOIN gold_trade t ON t.id=l.trade_id WHERE t.id=:tradeId AND l.id=:lineId`, { tradeId, lineId });
  if (!line) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  const representedPartyId = await resolveTradeParty(auth, line);
  if (line.status === 'CLOSED') throw new AppError(409, 'TRADE_CLOSED', 'Closed trade records cannot receive new measurements.');
  if (!['g','kg','mg'].includes(input.sourceUnit) || input.conversionVersion !== 'canonical-mass-v1') throw new AppError(400, 'UNSUPPORTED_CONVERSION', 'Use g, kg or mg with canonical-mass-v1 conversion evidence.');
  const source = toScaled(input.sourceValue, 1_000_000_000_000n);
  const denominator = input.sourceUnit === 'kg' ? 1_000n : input.sourceUnit === 'mg' ? 1_000_000_000n : 1_000_000n;
  const convertedMicros = source / denominator;
  if (source % denominator !== 0n || convertedMicros !== toMicros(input.quantityGrams)) throw new AppError(400, 'MEASUREMENT_CONVERSION_MISMATCH', 'The source value and canonical gram quantity do not match exactly.');
  return sequelize.transaction(async (transaction) => executeIdempotent({ actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'gold-trade.measurement', tradeId, lineId, input }, transaction }, async () => {
    const sourcePartyId = await assertGoldMeasurementSource({ auth, line, sourceRole: input.sourceRole, requestedSourcePartyId: input.sourcePartyId, occurredAt: input.occurredAt, transaction });
    const id = randomUUID();
    const [set] = await query(`SELECT id FROM material_measurement_set WHERE gold_trade_line_id=:lineId`, { lineId }, transaction);
    if (input.supersedesMeasurementId) {
      const [previous] = await query(`SELECT id FROM material_measurement WHERE id=:id AND measurement_set_id=:setId`, { id: input.supersedesMeasurementId, setId: set.id }, transaction);
      if (!previous) throw new AppError(400, 'INVALID_MEASUREMENT_CORRECTION', 'A correction must refer to an observation on the same trade line.');
    }
    await write(
      `INSERT INTO material_measurement(id,measurement_set_id,measurement_kind,quantity_g,source_value,source_unit_code,conversion_version,
        source_role,source_party_id,entered_by_user_id,method_code,instrument_ref,occurred_at_claimed,evidence_ref,supersedes_measurement_id)
       VALUES (:id,:setId,:kind,:quantity,:sourceValue,:unit,:conversion,:sourceRole,:sourceParty,:userId,:method,:instrument,:occurredAt,:evidence,:supersedes)`,
      { id, setId: set.id, kind: input.kind, quantity: input.quantityGrams, sourceValue: input.sourceValue, unit: input.sourceUnit,
        conversion: input.conversionVersion, sourceRole: input.sourceRole, sourceParty: sourcePartyId, userId: auth.userId,
        method: input.methodCode ?? null, instrument: input.instrumentRef ?? null, occurredAt: input.occurredAt,
        evidence: input.evidenceRef ?? null, supersedes: input.supersedesMeasurementId ?? null }, transaction,
    );
    if (input.evidenceRef || input.supersedesMeasurementId) await appendEvidence(tradeId, {
      kind: 'WEIGHT', reference: input.evidenceRef ?? `MEASUREMENT:${id}`, note: input.supersedesMeasurementId ? `Correction of ${input.supersedesMeasurementId}: ${input.correctionReason}` : null,
      occurredAt: input.occurredAt,
    }, auth, representedPartyId, transaction);
    await appendAuditEvent({ transaction, eventType: input.supersedesMeasurementId ? 'GOLD_TRADE.MEASUREMENT_CORRECTED' : 'GOLD_TRADE.MEASUREMENT_RECORDED', actorUserId: auth.userId, actorPartyId: auth.personPartyId, occurredAt: new Date(input.occurredAt), clientMutationId: mutationId, payload: { trade_id: tradeId, line_id: lineId, measurement_id: id, kind: input.kind, quantity_g: input.quantityGrams, supersedes_measurement_id: input.supersedesMeasurementId ?? null }, streams: [{ kind: 'gold_trade', id: tradeId }, { kind: 'material_batch', id: line.batch_id }] });
    return { id, tradeId, lineId, measurementSetId: set.id, kind: input.kind, quantityGrams: input.quantityGrams, supersedesMeasurementId: input.supersedesMeasurementId ?? null };
  }));
}

export async function recordGoldTradeAssay(tradeId, lineId, input, auth, mutationId) {
  const [line] = await query(`SELECT l.*,t.seller_party_id,t.buyer_party_id,t.status FROM gold_trade_line l JOIN gold_trade t ON t.id=l.trade_id WHERE t.id=:tradeId AND l.id=:lineId`, { tradeId, lineId });
  if (!line) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  const representedPartyId = await resolveTradeParty(auth, line);
  if (!line.is_current) throw new AppError(409, 'STALE_TRADE_LINE', 'Assays must be recorded against the current proposal line.');
  const assayerPartyId = input.assayerPartyId ?? representedPartyId;
  return sequelize.transaction(async (transaction) => executeIdempotent({ actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'gold-trade.assay', tradeId, lineId, input }, transaction }, async () => {
    if (!(await isRepresentedPartyAt(auth, assayerPartyId, input.observedAt, transaction))) {
      throw new AppError(400, 'INVALID_ASSAYER', 'The authenticated user is not authorized to record an assay for this party at the claimed observation time.');
    }
    if (input.correctionOfId) {
      const [prior] = await query(`SELECT a.id FROM assay_record a WHERE a.id=:id AND a.batch_id=:batchId
        AND NOT EXISTS(SELECT 1 FROM assay_record successor WHERE successor.correction_of_id=a.id)`,
      { id: input.correctionOfId, batchId: line.batch_id }, transaction);
      if (!prior) throw new AppError(400, 'INVALID_ASSAY_CORRECTION', 'An assay correction must refer to the current observation for this batch.');
    }
    const id = randomUUID();
    await write(
      `INSERT INTO assay_record(id,batch_id,assayer_party_id,sample_ref,method_ref,result_value,result_unit,observed_at,evidence_ref,correction_of_id,recorded_by_user_id,correction_reason,gold_trade_line_id)
       VALUES (:id,:batchId,:assayer,:sample,:method,:value,:unit,:observedAt,:evidence,:correction,:userId,:reason,:lineId)`,
      { id, batchId: line.batch_id, assayer: assayerPartyId, sample: input.sampleRef ?? null, method: input.methodRef ?? null,
        value: input.resultValue, unit: input.resultUnit, observedAt: input.observedAt, evidence: input.evidenceRef ?? null,
        correction: input.correctionOfId ?? null, userId: auth.userId, reason: input.correctionReason ?? null, lineId }, transaction,
    );
    if (input.evidenceRef) await appendEvidence(tradeId, { kind: 'ASSAY', reference: input.evidenceRef, occurredAt: input.observedAt }, auth, representedPartyId, transaction);
    await appendAuditEvent({ transaction, eventType: input.correctionOfId ? 'GOLD_TRADE.ASSAY_CORRECTED' : 'GOLD_TRADE.ASSAY_RECORDED', actorUserId: auth.userId, actorPartyId: auth.personPartyId, occurredAt: new Date(input.observedAt), clientMutationId: mutationId, payload: { trade_id: tradeId, line_id: lineId, assay_record_id: id, batch_id: line.batch_id, result_value: input.resultValue, result_unit: input.resultUnit, evidenced: Boolean(input.evidenceRef), correction_of_id: input.correctionOfId ?? null }, streams: [{ kind: 'gold_trade', id: tradeId }, { kind: 'material_batch', id: line.batch_id }] });
    return { id, tradeId, lineId, batchId: line.batch_id, status: 'RECORDED', resultValue: input.resultValue, resultUnit: input.resultUnit, evidenceRef: input.evidenceRef ?? null, correctionOfId: input.correctionOfId ?? null };
  }));
}

export async function proposeGoldTradeRevision(tradeId, lineId, input, auth, mutationId) {
  const [line] = await query(`SELECT l.*,t.seller_party_id,t.buyer_party_id,t.status FROM gold_trade_line l JOIN gold_trade t ON t.id=l.trade_id WHERE t.id=:tradeId AND l.id=:lineId`, { tradeId, lineId });
  if (!line) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  const representedPartyId = await resolveTradeParty(auth, line);
  if (!['PROPOSED','DISPUTED'].includes(line.status)) throw new AppError(409, 'TRADE_NOT_OPEN', 'Agreed or closed trades cannot be revised through the proposal workflow.');
  return sequelize.transaction(async (transaction) => executeIdempotent({ actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'gold-trade.line.revise', tradeId, lineId, input }, transaction }, async () => {
    const [locked] = await query(`SELECT l.*,t.status FROM gold_trade_line l JOIN gold_trade t ON t.id=l.trade_id WHERE l.id=:lineId FOR UPDATE OF t,l`, { lineId }, transaction);
    await assertLineCurrent(lineId, transaction);
    if (locked.is_accepted) await write(`UPDATE gold_trade_line SET is_accepted=false WHERE id=:lineId`, { lineId }, transaction);
    await getEligibleGoldBatch(locked.batch_id, transaction);
    await assertSellerAvailability(locked.batch_id, line.seller_party_id, input.quantityGrams, transaction);
    const revision = await query(`SELECT COALESCE(max(revision_no),0)::int AS revision FROM gold_trade_line WHERE trade_id=:tradeId AND batch_id=:batchId`, { tradeId, batchId: line.batch_id }, transaction);
    const assayRecordId = input.assayRecordId ?? await currentAssayId(line.assay_record_id, line.batch_id, transaction);
    const result = await createProposalLine({ tradeId, line: { ...input, batchId: line.batch_id, assayRecordId }, revisionNo: revision[0].revision + 1, supersedesLineId: lineId, correctionReason: input.correctionReason }, transaction);
    const [trade] = await query(`SELECT * FROM gold_trade WHERE id=:tradeId FOR UPDATE`, { tradeId }, transaction);
    if (trade.status === 'DISPUTED') await recordTradeStatus({ tradeId, trade, nextStatus: 'PROPOSED', auth, representedPartyId, occurredAt: input.occurredAt, reason: input.correctionReason, evidenceRef: input.evidenceRef ?? null, transaction });
    await appendAuditEvent({ transaction, eventType: 'GOLD_TRADE.LINE_REVISION_PROPOSED', actorUserId: auth.userId, actorPartyId: auth.personPartyId, occurredAt: new Date(input.occurredAt), clientMutationId: mutationId, payload: { trade_id: tradeId, prior_line_id: lineId, successor_line_id: result.id, correction_reason: input.correctionReason, quantity_g: input.quantityGrams, unit_price: input.unitPrice }, streams: [{ kind: 'gold_trade', id: tradeId }, { kind: 'material_batch', id: line.batch_id }] });
    return { ...result, supersedesLineId: lineId, revisionNo: revision[0].revision + 1 };
  }));
}

export async function decideGoldTradeLine(tradeId, lineId, input, auth, mutationId) {
  const [line] = await query(`SELECT l.*,t.seller_party_id,t.buyer_party_id,t.status,t.currency_code FROM gold_trade_line l JOIN gold_trade t ON t.id=l.trade_id WHERE t.id=:tradeId AND l.id=:lineId`, { tradeId, lineId });
  if (!line) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  const representedPartyId = await resolveTradeParty(auth, line);
  if (!['PROPOSED','DISPUTED'].includes(line.status)) throw new AppError(409, 'TRADE_NOT_OPEN', 'Only open proposals can receive a commercial decision.');
  if (input.decision === 'ACCEPT') {
    if (toMicros(input.quantityGrams) > toMicros(line.transaction_quantity_g)) throw new AppError(400, 'QUANTITY_EXCEEDS_PROPOSAL', 'Accepted quantity cannot exceed the proposed quantity.');
    if (input.deductionAmount && toScaled(input.deductionAmount, MONEY_SCALE) > toScaled(calculateAmount(input.quantityGrams, input.unitPrice), MONEY_SCALE)) throw new AppError(400, 'INVALID_DEDUCTION', 'Deduction cannot exceed the gross line amount.');
    if (input.deductionAmount && toScaled(input.deductionAmount, MONEY_SCALE) > 0n && !input.deductionReason) throw new AppError(400, 'DEDUCTION_REASON_REQUIRED', 'A recorded deduction requires a reason.');
  }
  return sequelize.transaction(async (transaction) => executeIdempotent({ actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'gold-trade.line.decision', tradeId, lineId, input }, transaction }, async () => {
    const [locked] = await query(`SELECT l.*,t.seller_party_id,t.buyer_party_id,t.currency_code,t.status FROM gold_trade_line l JOIN gold_trade t ON t.id=l.trade_id WHERE l.id=:lineId FOR UPDATE OF t,l`, { lineId }, transaction);
    await assertLineCurrent(lineId, transaction);
    const acceptedQuantity = input.decision === 'ACCEPT' ? input.quantityGrams : null;
    const acceptedUnitPrice = input.decision === 'ACCEPT' ? input.unitPrice : null;
    const acceptedAmount = input.decision === 'ACCEPT' ? calculateAmount(input.quantityGrams, input.unitPrice) : null;
    const deduction = input.decision === 'ACCEPT' ? input.deductionAmount ?? '0.00000000' : null;
    const decisionId = randomUUID();
    await write(
      `INSERT INTO commercial_line_decision_event(id,gold_trade_line_id,actor_user_id,actor_party_id,decision,occurred_at,reason,evidence_ref,accepted_quantity_g,accepted_unit_price,accepted_line_amount,accepted_deduction_amount)
       VALUES (:id,:lineId,:userId,:partyId,:decision,:occurredAt,:reason,:evidence,:quantity,:price,:amount,:deduction)`,
      { id: decisionId, lineId, userId: auth.userId, partyId: representedPartyId, decision: input.decision,
        occurredAt: input.occurredAt, reason: input.reason ?? null, evidence: input.evidenceRef ?? null,
        quantity: acceptedQuantity, price: acceptedUnitPrice, amount: acceptedAmount, deduction }, transaction,
    );
    if (input.evidenceRef) await appendEvidence(tradeId, { kind: 'TERMS', reference: input.evidenceRef, occurredAt: input.occurredAt }, auth, representedPartyId, transaction);
    let successorLineId = null;
    let agreed = false;
    let disputed = false;
    if (input.decision === 'DISPUTE' || input.decision === 'REJECT') {
      disputed = true;
      if (locked.status !== 'DISPUTED') await recordTradeStatus({ tradeId, trade: locked, nextStatus: 'DISPUTED', auth, representedPartyId, occurredAt: input.occurredAt, reason: input.reason, evidenceRef: input.evidenceRef ?? null, transaction });
    } else {
      const decisions = await query(`SELECT actor_party_id,accepted_quantity_g,accepted_unit_price,accepted_line_amount,accepted_deduction_amount FROM commercial_line_decision_event WHERE gold_trade_line_id=:lineId AND decision='ACCEPT'`, { lineId }, transaction);
      const seller = decisions.find((row) => row.actor_party_id === locked.seller_party_id);
      const buyer = decisions.find((row) => row.actor_party_id === locked.buyer_party_id);
      if (seller && buyer) {
        const sameTerms = seller.accepted_quantity_g === buyer.accepted_quantity_g && seller.accepted_unit_price === buyer.accepted_unit_price && seller.accepted_line_amount === buyer.accepted_line_amount && seller.accepted_deduction_amount === buyer.accepted_deduction_amount;
        if (!sameTerms) {
          disputed = true;
          if (locked.status !== 'DISPUTED') await recordTradeStatus({ tradeId, trade: locked, nextStatus: 'DISPUTED', auth, representedPartyId, occurredAt: input.occurredAt, reason: 'Counterparties accepted different effective terms', transaction });
        } else {
          await assertSellerAvailability(locked.batch_id, locked.seller_party_id, buyer.accepted_quantity_g, transaction);
          const revisionNo = locked.revision_no + 1;
          const assayRecordId = await currentAssayId(locked.assay_record_id, locked.batch_id, transaction);
          successorLineId = randomUUID();
          await write(
            `INSERT INTO gold_trade_line(id,trade_id,batch_id,revision_no,revision_kind,transaction_quantity_g,accepted_trade_quantity_g,unit_price,line_amount,assay_record_id,supersedes_line_id,correction_reason,is_accepted,deduction_amount,deduction_reason,is_current)
             VALUES (:id,:tradeId,:batchId,:revision,'CORRECTION',:quantity,:accepted,:price,:amount,:assay,:prior,:reason,true,:deduction,:deductionReason,false)`,
            { id: successorLineId, tradeId, batchId: locked.batch_id, revision: revisionNo, quantity: buyer.accepted_quantity_g,
              accepted: buyer.accepted_quantity_g, price: buyer.accepted_unit_price, amount: buyer.accepted_line_amount,
              assay: assayRecordId, prior: lineId, reason: 'Bilateral acceptance of identical gold trade terms',
              deduction: buyer.accepted_deduction_amount, deductionReason: toScaled(buyer.accepted_deduction_amount, MONEY_SCALE) > 0n ? input.deductionReason ?? 'Counterparty-agreed deduction' : null }, transaction,
          );
          await write(`UPDATE gold_trade_line SET is_current=false WHERE id=:priorId`, { priorId: lineId }, transaction);
          await write(`UPDATE gold_trade_line SET is_current=true WHERE id=:id`, { id: successorLineId }, transaction);
          await insertMeasurementSet(successorLineId, locked.batch_id, transaction);
          const [currentTrade] = await query(`SELECT * FROM gold_trade WHERE id=:tradeId FOR UPDATE`, { tradeId }, transaction);
          const [openLines] = await query(`SELECT count(*)::int AS total FROM gold_trade_line l WHERE l.trade_id=:tradeId AND l.is_current`, { tradeId }, transaction);
          const [unagreed] = await query(`SELECT count(*)::int AS total FROM gold_trade_line l WHERE l.trade_id=:tradeId AND l.is_current AND (NOT l.is_accepted OR l.accepted_trade_quantity_g IS NULL)`, { tradeId }, transaction);
          if (openLines.total > 0 && unagreed.total === 0) {
            await recordTradeStatus({ tradeId, trade: currentTrade, nextStatus: 'AGREED', auth, representedPartyId, occurredAt: input.occurredAt, evidenceRef: input.evidenceRef ?? null, transaction });
            agreed = true;
          }
        }
      }
    }
    await appendAuditEvent({ transaction, eventType: `GOLD_TRADE.LINE_${input.decision}`, actorUserId: auth.userId, actorPartyId: auth.personPartyId, occurredAt: new Date(input.occurredAt), clientMutationId: mutationId, payload: { trade_id: tradeId, line_id: lineId, decision_id: decisionId, decision: input.decision, accepted_quantity_g: acceptedQuantity, accepted_unit_price: acceptedUnitPrice, accepted_line_amount: acceptedAmount, successor_line_id: successorLineId, trade_agreed: agreed }, streams: [{ kind: 'gold_trade', id: tradeId }, { kind: 'material_batch', id: line.batch_id }] });
    return { id: decisionId, tradeId, lineId, decision: input.decision, status: agreed ? 'AGREED' : disputed ? 'DISPUTED' : 'PENDING_COUNTERPARTY', acceptedLineId: successorLineId };
  }));
}

export async function createGoldCustodyOffer(tradeId, lineId, input, auth, mutationId) {
  const [line] = await query(`SELECT l.*,t.seller_party_id,t.buyer_party_id,t.status FROM gold_trade_line l JOIN gold_trade t ON t.id=l.trade_id WHERE t.id=:tradeId AND l.id=:lineId`, { tradeId, lineId });
  if (!line || !line.is_accepted || line.status !== 'AGREED') throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  const representedPartyId = await resolveTradeParty(auth, line, [line.seller_party_id]);
  const measurement = await assertCurrentMeasurement(input.measurementId, input.measurementSetId, undefined);
  if (toMicros(measurement.quantity_g) !== toMicros(input.quantityGrams)) throw new AppError(400, 'CUSTODY_MEASUREMENT_MISMATCH', 'The selected current measured observation must exactly match the custody quantity.');
  return sequelize.transaction(async (transaction) => executeIdempotent({ actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'gold-trade.custody.offer', tradeId, lineId, input }, transaction }, async () => {
    const [locked] = await query(`SELECT l.*,t.seller_party_id,t.buyer_party_id,t.status FROM gold_trade_line l JOIN gold_trade t ON t.id=l.trade_id WHERE l.id=:lineId FOR UPDATE OF t,l`, { lineId }, transaction);
    if (!locked.is_accepted || locked.status !== 'AGREED') throw new AppError(409, 'TRADE_NOT_AGREED', 'Custody requires an agreed trade line.');
    const [measurementSet] = await query(`SELECT id FROM material_measurement_set WHERE id=:setId AND gold_trade_line_id=:lineId`, { setId: input.measurementSetId, lineId }, transaction);
    if (!measurementSet) throw new AppError(400, 'INVALID_TRADE_MEASUREMENT', 'The selected measurement must belong to this trade line.');
    const [measurement] = await query(`SELECT id,quantity_g FROM material_measurement WHERE id=:id AND measurement_set_id=:setId AND measurement_kind IN ('MEASURED','VERIFIED') AND NOT EXISTS(SELECT 1 FROM material_measurement successor WHERE successor.supersedes_measurement_id=material_measurement.id)`, { id: input.measurementId, setId: input.measurementSetId }, transaction);
    if (!measurement || toMicros(measurement.quantity_g) < toMicros(input.quantityGrams)) throw new AppError(400, 'INVALID_TRADE_MEASUREMENT', 'The selected current measured observation must cover the custody quantity.');
    const [source] = await query(`SELECT * FROM inventory_location WHERE id=:sourceId AND status='ACTIVE'`, { sourceId: input.sourceLocationId }, transaction);
    const [destination] = await query(`SELECT * FROM inventory_location WHERE id=:destinationId AND status='ACTIVE'`, { destinationId: input.destinationLocationId }, transaction);
    if (!source || !(source.custodian_party_id === locked.seller_party_id || (await query(`SELECT 1 FROM merchant_inventory_location WHERE inventory_location_id=:id AND merchant_party_id=:party`, { id: source?.id ?? input.sourceLocationId, party: locked.seller_party_id }, transaction)).length)) throw new AppError(400, 'INVALID_CUSTODY_SOURCE', 'Source location must be held by the gold seller.');
    if (!destination || !(destination.custodian_party_id === locked.buyer_party_id || (await query(`SELECT 1 FROM merchant_inventory_location WHERE inventory_location_id=:id AND merchant_party_id=:party`, { id: destination?.id ?? input.destinationLocationId, party: locked.buyer_party_id }, transaction)).length)) throw new AppError(400, 'INVALID_CUSTODY_DESTINATION', 'Destination location must be held by the gold buyer.');
    await assertSellerAvailability(locked.batch_id, locked.seller_party_id, input.quantityGrams, transaction);
    const [lineBalance] = await query(`SELECT COALESCE(sum(CASE WHEN ml.direction='OUT' THEN ml.posted_quantity_g-COALESCE(r.quantity_g,0) ELSE 0 END),0)::NUMERIC(20,6) AS moved FROM inventory_movement_line ml JOIN inventory_movement m ON m.id=ml.inventory_movement_id AND m.current_status='ACCEPTED' LEFT JOIN LATERAL (SELECT sum(rev.posted_quantity_g) AS quantity_g FROM inventory_movement_line rev JOIN inventory_movement rm ON rm.id=rev.inventory_movement_id AND rm.current_status='ACCEPTED' AND rm.movement_kind='REVERSAL' WHERE rev.reverses_line_id=ml.id) r ON true WHERE ml.gold_trade_line_id=:lineId`, { lineId }, transaction);
    if (toMicros(lineBalance.moved) + toMicros(input.quantityGrams) > toMicros(locked.accepted_trade_quantity_g)) throw new AppError(409, 'TRADE_QUANTITY_EXHAUSTED', 'Gold custody quantity would exceed the accepted trade quantity.');
    const id = randomUUID();
    await write(`INSERT INTO custody_transfer(id,batch_id,from_party_id,to_party_id,offered_at,status,offered_by_user_id,source_location_id,destination_location_id,evidence_ref,gold_trade_line_id,quantity_g,measurement_set_id,measurement_id) VALUES (:id,:batchId,:seller,:buyer,:at,'OFFERED',:actor,:source,:destination,:evidence,:lineId,:quantity,:measurementSetId,:measurementId)`, { id, batchId: locked.batch_id, seller: locked.seller_party_id, buyer: locked.buyer_party_id, at: input.occurredAt, actor: auth.userId, source: input.sourceLocationId, destination: input.destinationLocationId, evidence: input.evidenceRef ?? null, lineId, quantity: input.quantityGrams, measurementSetId: input.measurementSetId, measurementId: input.measurementId }, transaction);
    await appendAuditEvent({ transaction, eventType: 'GOLD_TRADE.CUSTODY_OFFERED', actorUserId: auth.userId, actorPartyId: auth.personPartyId, occurredAt: new Date(input.occurredAt), clientMutationId: mutationId, payload: { trade_id: tradeId, line_id: lineId, custody_transfer_id: id, batch_id: locked.batch_id, quantity_g: input.quantityGrams }, streams: [{ kind: 'gold_trade', id: tradeId }, { kind: 'custody_transfer', id }, { kind: 'material_batch', id: locked.batch_id }] });
    return { id, tradeId, lineId, status: 'OFFERED', batchId: locked.batch_id, quantityGrams: input.quantityGrams };
  }));
}

export async function decideGoldCustodyTransfer(tradeId, transferId, input, auth, mutationId) {
  const [transfer] = await query(`SELECT ct.*,l.trade_id,t.seller_party_id,t.buyer_party_id,t.currency_code,l.is_accepted,t.status AS trade_status FROM custody_transfer ct JOIN gold_trade_line l ON l.id=ct.gold_trade_line_id JOIN gold_trade t ON t.id=l.trade_id WHERE ct.id=:id AND t.id=:tradeId`, { id: transferId, tradeId });
  if (!transfer) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  const actorPartyId = input.decision === 'WITHDRAW' ? transfer.from_party_id : transfer.to_party_id;
  if (!(await isRepresentedParty(auth, actorPartyId))) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  return sequelize.transaction(async (transaction) => executeIdempotent({ actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'gold-trade.custody.decision', transferId, input }, transaction }, async () => {
    const [locked] = await query(`SELECT * FROM custody_transfer WHERE id=:id FOR UPDATE`, { id: transferId }, transaction);
    if (locked.status !== 'OFFERED') throw new AppError(409, 'INVALID_CUSTODY_STATE', 'Only an offered gold handover can receive a decision.');
    const decisionId = randomUUID();
    await write(`INSERT INTO custody_transfer_decision(id,custody_transfer_id,actor_user_id,actor_party_id,decision,occurred_at,reason,evidence_ref) VALUES (:id,:transferId,:userId,:partyId,:decision,:occurredAt,:reason,:evidence)`, { id: decisionId, transferId, userId: auth.userId, partyId: actorPartyId, decision: input.decision, occurredAt: input.occurredAt, reason: input.reason ?? null, evidence: input.evidenceRef ?? null }, transaction);
    const status = input.decision === 'ACCEPT' ? 'ACCEPTED' : input.decision === 'DISPUTE' ? 'DISPUTED' : input.decision === 'REJECT' ? 'REJECTED' : 'WITHDRAWN';
    await write(`UPDATE custody_transfer SET status=:status,accepted_at=:acceptedAt,accepted_by_user_id=:acceptedBy WHERE id=:id`, { id: transferId, status, acceptedAt: status === 'ACCEPTED' ? input.occurredAt : null, acceptedBy: status === 'ACCEPTED' ? auth.userId : null }, transaction);
    let movementId = null;
    if (status === 'ACCEPTED') {
      const [line] = await query(`SELECT * FROM gold_trade_line WHERE id=:lineId`, { lineId: locked.gold_trade_line_id }, transaction);
       const [measurement] = await query(`SELECT id,measurement_set_id FROM material_measurement WHERE id=:measurementId AND measurement_set_id=:setId AND measurement_kind IN ('MEASURED','VERIFIED') AND quantity_g=:quantity AND NOT EXISTS(SELECT 1 FROM material_measurement successor WHERE successor.supersedes_measurement_id=material_measurement.id)`, { measurementId: locked.measurement_id, setId: locked.measurement_set_id, quantity: locked.quantity_g }, transaction);
      if (!measurement) throw new AppError(409, 'CUSTODY_MEASUREMENT_MISSING', 'A current measured observation covering the handover is required.');
      const movement = await postMovementInTransaction({ movementKind: 'TRANSFER', occurredAt: input.occurredAt, reason: 'Accepted gold custody handover', auth, transaction, mutationId, lines: [
        { batchId: locked.batch_id, locationId: locked.source_location_id, direction: 'OUT', quantityGrams: locked.quantity_g, measurementSetId: measurement.measurement_set_id, measurementId: measurement.id, goldTradeLineId: locked.gold_trade_line_id },
        { batchId: locked.batch_id, locationId: locked.destination_location_id, direction: 'IN', quantityGrams: locked.quantity_g },
      ] });
      movementId = movement.id;
      await write(`UPDATE custody_transfer SET linked_inventory_movement_id=:movementId WHERE id=:id`, { movementId, id: transferId }, transaction);
    }
    await appendAuditEvent({ transaction, eventType: `GOLD_TRADE.CUSTODY_${status}`, actorUserId: auth.userId, actorPartyId: auth.personPartyId, occurredAt: new Date(input.occurredAt), clientMutationId: mutationId, payload: { custody_transfer_id: transferId, decision_id: decisionId, status, inventory_movement_id: movementId, reason: input.reason ?? null }, streams: [{ kind: 'gold_trade', id: transfer.trade_id }, { kind: 'custody_transfer', id: transferId }, { kind: 'material_batch', id: locked.batch_id }] });
    return { id: transferId, status, decisionId, inventoryMovementId: movementId };
  }));
}

export async function recordGoldTradePayment(tradeId, input, auth, mutationId) {
  const [trade] = await query(`SELECT * FROM gold_trade WHERE id=:tradeId`, { tradeId });
  if (!trade || trade.status !== 'AGREED') throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  const representedPartyId = await resolveTradeParty(auth, trade, [trade.buyer_party_id]);
  return sequelize.transaction(async (transaction) => executeIdempotent({ actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'gold-trade.payment.report', tradeId, input }, transaction }, async () => {
    const [lockedTrade] = await query(`SELECT * FROM gold_trade WHERE id=:tradeId FOR UPDATE`, { tradeId }, transaction);
    const lines = await query(`SELECT line_amount,deduction_amount FROM gold_trade_line WHERE trade_id=:tradeId AND is_accepted AND NOT EXISTS(SELECT 1 FROM gold_trade_line child WHERE child.supersedes_line_id=gold_trade_line.id)`, { tradeId }, transaction);
    const obligation = addMoney(lines.map((line) => subtractMoney(line.line_amount, line.deduction_amount)));
    const [reported] = await query(`SELECT COALESCE(sum(CASE WHEN e.event_kind='REPORTED' THEN e.amount WHEN e.event_kind='FAILED' OR e.event_kind='REVERSAL' THEN -e.amount ELSE 0 END),0)::NUMERIC(20,8) AS amount FROM payment_event e JOIN payment p ON p.id=e.payment_id WHERE p.gold_trade_id=:tradeId`, { tradeId }, transaction);
    if (toScaled(input.amount, MONEY_SCALE) + toScaled(reported.amount, MONEY_SCALE) > toScaled(obligation, MONEY_SCALE)) throw new AppError(409, 'OVERPAYMENT', 'Payment would exceed the outstanding agreed trade amount.');
    const paymentId = randomUUID();
    const reportId = randomUUID();
    await write(`INSERT INTO payment(id,gold_trade_id,currency_code,payer_party_id,payee_party_id) VALUES (:id,:tradeId,:currency,:payer,:payee)`, { id: paymentId, tradeId, currency: lockedTrade.currency_code, payer: lockedTrade.buyer_party_id, payee: lockedTrade.seller_party_id }, transaction);
    await write(`INSERT INTO payment_event(id,payment_id,currency_code,event_kind,direction,amount,method_code,external_ref,occurred_at_claimed,actor_user_id,actor_party_id,evidence_ref) VALUES (:id,:paymentId,:currency,'REPORTED','CREDIT',:amount,:method,:reference,:occurredAt,:userId,:partyId,:evidence)`, { id: reportId, paymentId, currency: lockedTrade.currency_code, amount: input.amount, method: input.methodCode, reference: input.reference ?? null, occurredAt: input.occurredAt, userId: auth.userId, partyId: representedPartyId, evidence: input.evidenceRef ?? null }, transaction);
    if (input.evidenceRef) await appendEvidence(tradeId, { kind: 'PAYMENT', reference: input.evidenceRef, occurredAt: input.occurredAt }, auth, representedPartyId, transaction);
    await appendAuditEvent({ transaction, eventType: 'GOLD_TRADE.PAYMENT_REPORTED', actorUserId: auth.userId, actorPartyId: auth.personPartyId, occurredAt: new Date(input.occurredAt), clientMutationId: mutationId, payload: { trade_id: tradeId, payment_id: paymentId, report_event_id: reportId, amount: input.amount, currency_code: lockedTrade.currency_code, verified_externally: false }, streams: [{ kind: 'gold_trade', id: tradeId }, { kind: 'payment', id: paymentId }] });
    return { id: paymentId, reportEventId: reportId, status: 'REPORTED', amount: input.amount, currencyCode: lockedTrade.currency_code, verifiedExternally: false };
  }));
}

export async function decideGoldTradePayment(tradeId, paymentId, input, auth, mutationId) {
  const [payment] = await query(`SELECT p.*,t.seller_party_id,t.buyer_party_id,t.status,t.currency_code FROM payment p JOIN gold_trade t ON t.id=p.gold_trade_id WHERE p.id=:paymentId AND t.id=:tradeId`, { paymentId, tradeId });
  if (!payment) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  const allowed = input.decision === 'CONFIRM' || input.decision === 'FAIL' ? [payment.seller_party_id] : [payment.seller_party_id,payment.buyer_party_id];
  const representedPartyId = await resolveTradeParty(auth, payment, allowed);
  return sequelize.transaction(async (transaction) => executeIdempotent({ actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'gold-trade.payment.decision', tradeId, paymentId, input }, transaction }, async () => {
    const [report] = await query(`SELECT * FROM payment_event WHERE payment_id=:paymentId AND event_kind='REPORTED'`, { paymentId }, transaction);
    if (!report) throw new AppError(409, 'PAYMENT_NOT_REPORTED', 'The payment report is unavailable.');
    const existing = await query(`SELECT event_kind FROM payment_event WHERE related_event_id=:reportId AND event_kind IN ('CONFIRMED','FAILED','DISPUTED')`, { reportId: report.id }, transaction);
    const finalResolution = existing.some((row) => row.event_kind === 'CONFIRMED' || row.event_kind === 'FAILED');
    const alreadyDisputed = existing.some((row) => row.event_kind === 'DISPUTED');
    if (input.decision === 'CONFIRM' && finalResolution || input.decision === 'FAIL' && finalResolution || input.decision === 'DISPUTE' && (finalResolution || alreadyDisputed)) {
      throw new AppError(409, 'PAYMENT_ALREADY_RESOLVED', 'The payment report already has a final resolution or matching dispute event.');
    }
    if (input.decision !== 'REVERSE' && input.decision === 'DISPUTE' && alreadyDisputed) throw new AppError(409, 'PAYMENT_ALREADY_RESOLVED', 'The payment report is already disputed.');
    let eventKind; let direction; let relatedId; let amount;
    if (input.decision === 'CONFIRM') { eventKind='CONFIRMED'; direction='CREDIT'; relatedId=report.id; amount=report.amount; }
    else if (input.decision === 'DISPUTE') { eventKind='DISPUTED'; direction='CREDIT'; relatedId=report.id; amount=report.amount; }
    else if (input.decision === 'FAIL') { eventKind='FAILED'; direction='DEBIT'; relatedId=report.id; amount=report.amount; }
    else {
      const [confirmed] = await query(`SELECT * FROM payment_event WHERE related_event_id=:reportId AND event_kind='CONFIRMED'`, { reportId: report.id }, transaction);
      if (!confirmed) throw new AppError(409, 'PAYMENT_NOT_CONFIRMED', 'Only a confirmed settlement can be reversed.');
      eventKind='REVERSAL'; direction='DEBIT'; relatedId=confirmed.id; amount=input.amount;
      if (toScaled(input.amount,MONEY_SCALE)>toScaled(confirmed.amount,MONEY_SCALE)) throw new AppError(400,'INVALID_REVERSAL','A reversal cannot exceed its confirmed payment amount.');
    }
    const eventId = randomUUID();
    await write(`INSERT INTO payment_event(id,payment_id,currency_code,event_kind,direction,amount,method_code,external_ref,occurred_at_claimed,actor_user_id,actor_party_id,related_event_id,reason,evidence_ref) VALUES (:id,:paymentId,:currency,:kind,:direction,:amount,:method,:reference,:occurredAt,:userId,:partyId,:related,:reason,:evidence)`, { id: eventId, paymentId, currency: payment.currency_code, kind: eventKind, direction, amount, method: input.methodCode ?? null, reference: input.reference ?? null, occurredAt: input.occurredAt, userId: auth.userId, partyId: representedPartyId, related: relatedId, reason: input.reason ?? null, evidence: input.evidenceRef ?? null }, transaction);
    await appendAuditEvent({ transaction, eventType: `GOLD_TRADE.PAYMENT_${input.decision}`, actorUserId: auth.userId, actorPartyId: auth.personPartyId, occurredAt: new Date(input.occurredAt), clientMutationId: mutationId, payload: { trade_id: tradeId, payment_id: paymentId, payment_event_id: eventId, decision: input.decision, amount, currency_code: payment.currency_code }, streams: [{ kind: 'gold_trade', id: tradeId }, { kind: 'payment', id: paymentId }] });
    return { id: eventId, paymentId, status: eventKind, amount, currencyCode: payment.currency_code };
  }));
}

export async function readGoldTrade(tradeId, auth) {
  const [trade] = await query(`SELECT * FROM gold_trade WHERE id=:tradeId`, { tradeId });
  if (!trade) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  if (!(await isRepresentedParty(auth, trade.seller_party_id)) && !(await isRepresentedParty(auth, trade.buyer_party_id))) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  const lines = await query(`SELECT l.*,b.batch_code,b.material_kind,b.current_status AS batch_status,o.event_id AS source_event_id,e.event_kind AS source_event_kind,e.current_status AS source_event_status FROM gold_trade_line l JOIN material_batch b ON b.id=l.batch_id LEFT JOIN material_event_output o ON o.batch_id=b.id LEFT JOIN material_event e ON e.id=o.event_id WHERE l.trade_id=:tradeId ORDER BY l.batch_id,l.revision_no`, { tradeId });
  const lineIds = lines.map((line) => line.id);
  const measurements = lineIds.length ? await query(`SELECT ms.gold_trade_line_id AS line_id,m.* FROM material_measurement_set ms JOIN material_measurement m ON m.measurement_set_id=ms.id WHERE ms.gold_trade_line_id IN (:lineIds) ORDER BY m.entered_at,m.id`, { lineIds }) : [];
  const assays = await query(`SELECT DISTINCT a.* FROM assay_record a JOIN gold_trade_line l ON l.batch_id=a.batch_id WHERE l.trade_id=:tradeId ORDER BY a.created_at,a.id`, { tradeId });
  const decisions = lineIds.length ? await query(`SELECT * FROM commercial_line_decision_event WHERE gold_trade_line_id IN (:lineIds) ORDER BY recorded_at,id`, { lineIds }) : [];
  const statusHistory = await query(`SELECT * FROM gold_trade_status_event WHERE gold_trade_id=:tradeId ORDER BY recorded_at,id`, { tradeId });
  const evidence = await query(`SELECT * FROM gold_trade_evidence WHERE gold_trade_id=:tradeId ORDER BY recorded_at,id`, { tradeId });
  const custody = lineIds.length ? await query(`SELECT ct.*,d.decision AS last_decision,d.actor_party_id AS decision_party_id FROM custody_transfer ct LEFT JOIN LATERAL (SELECT decision,actor_party_id FROM custody_transfer_decision WHERE custody_transfer_id=ct.id ORDER BY recorded_at DESC LIMIT 1) d ON true WHERE ct.gold_trade_line_id IN (:lineIds) ORDER BY ct.recorded_at,ct.id`, { lineIds }) : [];
  const payments = await query(`SELECT p.id,p.currency_code,p.payer_party_id,p.payee_party_id,p.created_at,
      COALESCE(sum(CASE WHEN e.event_kind='REPORTED' THEN e.amount ELSE 0 END),0)::NUMERIC(20,8) AS reported_amount,
      COALESCE(sum(CASE WHEN e.event_kind='CONFIRMED' THEN e.amount WHEN e.event_kind='REVERSAL' THEN -e.amount ELSE 0 END),0)::NUMERIC(20,8) AS settled_amount,
      (SELECT latest.event_kind FROM payment_event latest WHERE latest.payment_id=p.id ORDER BY latest.recorded_at DESC,latest.id DESC LIMIT 1) AS current_status,
      (SELECT latest.event_kind='DISPUTED' FROM payment_event latest WHERE latest.payment_id=p.id ORDER BY latest.recorded_at DESC,latest.id DESC LIMIT 1) AS disputed
    FROM payment p JOIN payment_event e ON e.payment_id=p.id WHERE p.gold_trade_id=:tradeId GROUP BY p.id ORDER BY p.created_at,p.id`, { tradeId });
  const paymentTotals = await query(`SELECT t.currency_code,
      COALESCE((SELECT sum(l.line_amount-l.deduction_amount) FROM gold_trade_line l WHERE l.trade_id=t.id AND l.is_accepted AND NOT EXISTS(SELECT 1 FROM gold_trade_line child WHERE child.supersedes_line_id=l.id)),0)::NUMERIC(20,8) AS amount_agreed,
      COALESCE(sum(CASE WHEN pe.event_kind='CONFIRMED' THEN pe.amount WHEN pe.event_kind='REVERSAL' THEN -pe.amount ELSE 0 END),0)::NUMERIC(20,8) AS amount_settled,
      COALESCE((SELECT sum(report.amount) FROM payment_event report JOIN payment p ON p.id=report.payment_id
        WHERE p.gold_trade_id=t.id AND report.event_kind='REPORTED'
          AND (SELECT latest.event_kind FROM payment_event latest WHERE latest.payment_id=p.id ORDER BY latest.recorded_at DESC,latest.id DESC LIMIT 1)='DISPUTED'),0)::NUMERIC(20,8) AS amount_disputed,
      COALESCE((SELECT sum(report.amount) FROM payment_event report JOIN payment p ON p.id=report.payment_id
        WHERE p.gold_trade_id=t.id AND report.event_kind='REPORTED'
          AND (SELECT latest.event_kind FROM payment_event latest WHERE latest.payment_id=p.id ORDER BY latest.recorded_at DESC,latest.id DESC LIMIT 1) NOT IN ('FAILED','REVERSAL')),0)::NUMERIC(20,8) AS amount_reported
    FROM gold_trade t LEFT JOIN payment p ON p.gold_trade_id=t.id LEFT JOIN payment_event pe ON pe.payment_id=p.id WHERE t.id=:tradeId GROUP BY t.id`, { tradeId });
  const totals = paymentTotals[0] ?? { currency_code: trade.currency_code, amount_agreed: '0.00000000', amount_settled: '0.00000000', amount_disputed: '0.00000000', amount_reported: '0.00000000' };
  const custodyQuantities = await query(`SELECT l.id AS line_id,COALESCE(sum(ct.quantity_g) FILTER (WHERE ct.status='ACCEPTED'),0)::NUMERIC(20,6) AS transferred_quantity_g,COALESCE(sum(ct.quantity_g) FILTER (WHERE ct.status='OFFERED'),0)::NUMERIC(20,6) AS offered_quantity_g,COALESCE(sum(ct.quantity_g) FILTER (WHERE ct.status='DISPUTED'),0)::NUMERIC(20,6) AS disputed_quantity_g FROM gold_trade_line l LEFT JOIN custody_transfer ct ON ct.gold_trade_line_id=l.id WHERE l.trade_id=:tradeId GROUP BY l.id`, { tradeId });
  const currentLineIds = new Set(lines.filter((line) => !lines.some((child) => child.supersedes_line_id === line.id)).map((line) => line.id));
  const lineDiscrepancies = lines.filter((line) => currentLineIds.has(line.id)).map((line) => {
    const observations = measurements.filter((measurement) => measurement.line_id === line.id && !measurements.some((successor) => successor.supersedes_measurement_id === measurement.id));
    const declared = observations.filter((measurement) => measurement.measurement_kind === 'DECLARED');
    const measured = observations.filter((measurement) => ['MEASURED','VERIFIED'].includes(measurement.measurement_kind));
    const allQuantities = [...declared, ...measured].map((observation) => toMicros(observation.quantity_g));
    const spread = allQuantities.length < 2 ? '0.000000' : formatScaled(allQuantities.reduce((max, value) => value > max ? value : max) - allQuantities.reduce((min, value) => value < min ? value : min), MICRO);
    return { lineId: line.id, batchId: line.batch_id, declaredQuantitiesGrams: declared.map((measurement) => measurement.quantity_g), measuredQuantitiesGrams: measured.map((measurement) => measurement.quantity_g), observationSpreadGrams: spread };
  });
  return {
    ...trade,
    lines: lines.map((line) => ({ ...line, measurements: measurements.filter((measurement) => measurement.line_id === line.id), custody: custody.filter((transfer) => transfer.gold_trade_line_id === line.id), custodyTotals: custodyQuantities.find((entry) => entry.line_id === line.id) ?? null })),
    decisions, statusHistory, evidence, assays, payments,
    reconciliation: {
      proposedQuantityGrams: lines.filter((line) => !line.supersedes_line_id).map((line) => ({ batchId: line.batch_id, quantityGrams: line.transaction_quantity_g })),
      currentProposedQuantityGrams: lines.filter((line) => currentLineIds.has(line.id) && !line.is_accepted).map((line) => ({ lineId: line.id, batchId: line.batch_id, quantityGrams: line.transaction_quantity_g })),
      agreedQuantityGrams: lines.filter((line) => line.is_accepted).map((line) => ({ batchId: line.batch_id, quantityGrams: line.accepted_trade_quantity_g })),
      transferredQuantityGrams: custodyQuantities,
      amountAgreed: totals.amount_agreed,
      amountSettled: totals.amount_settled,
      amountOutstanding: subtractMoney(totals.amount_agreed, totals.amount_settled),
      amountReported: totals.amount_reported,
      amountDisputed: totals.amount_disputed,
      currencyCode: totals.currency_code,
      measurementDiscrepancies: lineDiscrepancies,
      unresolvedLines: lines.filter((line) => currentLineIds.has(line.id) && !line.is_accepted).map((line) => line.id),
      unresolvedDecisions: decisions.filter((decision) => currentLineIds.has(decision.gold_trade_line_id) && ['DISPUTE','REJECT'].includes(decision.decision)),
      missingEvidence: !evidence.length,
      unresolvedPaymentReports: payments.filter((payment) => payment.current_status === 'REPORTED' || payment.current_status === 'DISPUTED').map((payment) => payment.id),
    },
  };
}
