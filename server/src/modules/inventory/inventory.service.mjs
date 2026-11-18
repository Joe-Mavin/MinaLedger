import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../database/connection.mjs';
import { AppError } from '../../utils/errors.mjs';
import { appendAuditEvent } from '../audit/audit.service.mjs';
import { executeIdempotent } from '../commands/idempotency.service.mjs';

function sortKeys(values) {
  return [...new Map(values.map((value) => [`${value.locationId}:${value.batchId}`, value])).values()]
    .sort((a, b) => a.locationId.localeCompare(b.locationId) || a.batchId.localeCompare(b.batchId));
}

function gramsToMicros(value) {
  const [whole, fraction = ''] = String(value).split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

async function lockCommercialChains(lines, transaction) {
  const references = lines.filter((line) => line.goldTradeLineId || line.residueSaleLineId).map((line) => ({
    kind: line.goldTradeLineId ? 'GOLD_TRADE' : 'RESIDUE_SALE',
    lineId: line.goldTradeLineId ?? line.residueSaleLineId,
  })).sort((a, b) => a.kind.localeCompare(b.kind) || a.lineId.localeCompare(b.lineId));
  for (const reference of references) {
    if (reference.kind === 'GOLD_TRADE') {
      const [line] = await sequelize.query(`SELECT trade_id FROM gold_trade_line WHERE id=:id`, { replacements: { id: reference.lineId }, type: QueryTypes.SELECT, transaction });
      if (!line) throw new AppError(400, 'INVALID_TRADE_LINE', 'The gold-trade line does not exist.');
      await sequelize.query(`SELECT id FROM gold_trade WHERE id=:parentId FOR UPDATE`, { replacements: { parentId: line.trade_id }, type: QueryTypes.SELECT, transaction });
      await sequelize.query(`SELECT id FROM gold_trade_line WHERE trade_id=:parentId ORDER BY batch_id,revision_no,id FOR UPDATE`, { replacements: { parentId: line.trade_id }, type: QueryTypes.SELECT, transaction });
    } else {
      const [line] = await sequelize.query(`SELECT residue_sale_id FROM residue_sale_line WHERE id=:id`, { replacements: { id: reference.lineId }, type: QueryTypes.SELECT, transaction });
      if (!line) throw new AppError(400, 'INVALID_RESIDUE_SALE_LINE', 'The residue-sale line does not exist.');
      await sequelize.query(`SELECT id FROM residue_sale WHERE id=:parentId FOR UPDATE`, { replacements: { parentId: line.residue_sale_id }, type: QueryTypes.SELECT, transaction });
      await sequelize.query(`SELECT id FROM residue_sale_line WHERE residue_sale_id=:parentId ORDER BY batch_id,revision_no,id FOR UPDATE`, { replacements: { parentId: line.residue_sale_id }, type: QueryTypes.SELECT, transaction });
    }
  }
}

export async function postTransfer({ lines, reason, occurredAt }, auth, mutationId) {
  if (lines.length < 2) throw new AppError(400, 'INVALID_MOVEMENT', 'A transfer requires at least one OUT and one IN line.');
  const keys = sortKeys(lines);
  return sequelize.transaction(async (transaction) => executeIdempotent({ actorScope: `user:${auth.userId}`, mutationId, payload: { action: 'inventory.transfer', lines, reason, occurredAt }, transaction }, async () => {
    await lockCommercialChains(lines, transaction);
    for (const key of keys) {
      await sequelize.query(`INSERT INTO inventory_balance_guard(location_id,batch_id) VALUES (:locationId,:batchId) ON CONFLICT DO NOTHING`, { replacements: key, transaction });
    }
    for (const key of keys) {
      await sequelize.query(`SELECT 1 FROM inventory_balance_guard WHERE location_id=:locationId AND batch_id=:batchId FOR UPDATE`, { replacements: key, transaction });
    }
    const deltas = new Map(keys.map((key) => [`${key.locationId}:${key.batchId}`, 0n]));
    for (const line of lines) {
      const key = `${line.locationId}:${line.batchId}`;
      deltas.set(key, deltas.get(key) + (line.direction === 'IN' ? gramsToMicros(line.quantityGrams) : -gramsToMicros(line.quantityGrams)));
    }
    for (const key of keys) {
      const [balance] = await sequelize.query(
        `SELECT COALESCE(sum(CASE WHEN ml.direction='IN' THEN ml.posted_quantity_g ELSE -ml.posted_quantity_g END),0)::NUMERIC(20,6) AS quantity_g
         FROM inventory_movement_line ml JOIN inventory_movement m ON m.id=ml.inventory_movement_id
         WHERE m.current_status='ACCEPTED' AND ml.location_id=:locationId AND ml.batch_id=:batchId`,
        { replacements: key, type: QueryTypes.SELECT, transaction },
      );
      const available = gramsToMicros(balance.quantity_g);
      if (available + deltas.get(`${key.locationId}:${key.batchId}`) < 0n) throw new AppError(409, 'INSUFFICIENT_INVENTORY', 'The movement would make an inventory balance negative.');
    }
    const movementId = randomUUID();
    await sequelize.query(
      `INSERT INTO inventory_movement(id,movement_kind,current_status,reason,actor_user_id,occurred_at_claimed) VALUES (:id,'TRANSFER','DRAFT',:reason,:actorUserId,:occurredAt)`,
      { replacements: { id: movementId, reason: reason ?? null, actorUserId: auth.userId, occurredAt }, transaction },
    );
    for (const [index, line] of lines.entries()) {
      await sequelize.query(
        `INSERT INTO inventory_movement_line(id,inventory_movement_id,batch_id,location_id,direction,posted_quantity_g,basis_measurement_set_id,basis_measurement_id,consignment_item_id,consignment_stage,gold_trade_line_id,residue_sale_line_id,line_no)
         VALUES (:id,:movementId,:batchId,:locationId,:direction,:quantity,:measurementSetId,:measurementId,:consignmentItemId,:consignmentStage,:goldTradeLineId,:residueSaleLineId,:lineNo)`,
        { replacements: {
          id: randomUUID(), movementId, batchId: line.batchId, locationId: line.locationId, direction: line.direction, quantity: line.quantityGrams,
          measurementSetId: line.measurementSetId, measurementId: line.measurementId, consignmentItemId: line.consignmentItemId ?? null,
          consignmentStage: line.consignmentStage ?? null, goldTradeLineId: line.goldTradeLineId ?? null, residueSaleLineId: line.residueSaleLineId ?? null, lineNo: index + 1,
        }, transaction },
      );
    }
    await sequelize.query(`UPDATE inventory_movement SET current_status='ACCEPTED' WHERE id=:movementId`, { replacements: { movementId }, transaction });
    await appendAuditEvent({ transaction, eventType: 'INVENTORY.TRANSFER_ACCEPTED', actorUserId: auth.userId, actorPartyId: auth.personPartyId, occurredAt: new Date(occurredAt), clientMutationId: mutationId, payload: { movement_id: movementId, line_count: lines.length, batch_ids: [...new Set(lines.map((line) => line.batchId))] }, streams: [{ kind: 'inventory_movement', id: movementId }, ...keys.map((key) => ({ kind: 'material_batch', id: key.batchId })), ...keys.map((key) => ({ kind: 'inventory_location', id: key.locationId }))] });
    await sequelize.query('SET CONSTRAINTS inventory_validate_header_deferred, inventory_validate_line_deferred IMMEDIATE', { transaction });
    return { id: movementId, movementKind: 'TRANSFER', status: 'ACCEPTED', lineCount: lines.length };
  }));
}

