import { QueryTypes } from 'sequelize';
import { sequelize } from '../../database/connection.mjs';
import { AppError } from '../../utils/errors.mjs';
import { listSites } from '../mining-sites/site.service.mjs';
import { listAccessibleProductionEvents, getProductionEvent } from '../production/production.service.mjs';
import { listAccessibleProcessingEvents, getProcessingEvent } from '../processing/processing.service.mjs';
import { canAccessBatch, getBatchOrigins } from '../qr/qr.service.mjs';
import {
  listAccessibleConsignments, readConsignment, listAccessibleRecoveryFacilities,
  listAccessibleRecoveryEvents, readRecoveryEvent, listInventoryMovements,
  listAccessibleResidueSales, readResidueSale,
} from '../residue/residue.service.mjs';
import { readGoldTrade } from '../gold-trades/gold-trade.service.mjs';

const query = (sql, replacements = {}) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });

function isHiddenResource(error) {
  return error instanceof AppError && error.code === 'RESOURCE_NOT_FOUND';
}

export async function searchAccessibleMaterialBatches(search, auth) {
  const visible = [];
  const pageSize = 100;
  const maxCandidates = 1000;
  let scanned = 0;
  let cursor = null;
  let complete = false;

  while (scanned < maxCandidates && visible.length < 50) {
    const remaining = Math.min(pageSize, maxCandidates - scanned);
    const cursorClause = cursor ? 'AND (b.batch_code,b.id) > (:cursorCode,CAST(:cursorId AS uuid))' : '';
    const rows = await query(`SELECT b.id,b.batch_code,b.material_kind,b.current_status,
        (SELECT q.status FROM qr_record q WHERE q.material_batch_id=b.id ORDER BY q.created_at DESC,q.id DESC LIMIT 1) AS qr_status
      FROM material_batch b
      WHERE (b.batch_code ILIKE :pattern OR b.id::text=:search) ${cursorClause}
      ORDER BY b.batch_code,b.id LIMIT :pageSize`, {
      pattern: `%${search}%`, search, pageSize: remaining,
      ...(cursor ? { cursorCode: cursor.batch_code, cursorId: cursor.id } : {}),
    });
    if (rows.length === 0) { complete = true; break; }

    for (const batch of rows) {
      scanned += 1;
      cursor = batch;
      if (await canAccessBatch(auth, batch.id)) visible.push(batch);
      if (visible.length === 50) break;
    }

    if (visible.length === 50) break;
    if (rows.length < remaining) { complete = true; break; }
  }
  return { results: visible, complete };
}

async function connectedBatchIds(batchId) {
  const rows = await query(`WITH RECURSIVE batch_edges(parent_batch_id,child_batch_id) AS (
      SELECT mei.batch_id,output_eo.batch_id
      FROM processing_event_input pei JOIN material_event_input mei ON mei.id=pei.material_event_input_id
      JOIN processing_event_output peo ON peo.processing_event_id=pei.processing_event_id
      JOIN material_event_output output_eo ON output_eo.id=peo.material_event_output_id
      UNION
      SELECT rei.batch_id,output_eo.batch_id
      FROM recovery_event_input rei JOIN recovery_output_input_link link
        ON link.recovery_event_id=rei.recovery_event_id AND link.material_event_input_id=rei.material_event_input_id
      JOIN material_event_output output_eo ON output_eo.id=link.material_event_output_id
    ), connected(batch_id,depth,path) AS (
      SELECT CAST(:batchId AS uuid),0,ARRAY[CAST(:batchId AS uuid)]
      UNION ALL
      SELECT CASE WHEN edge.parent_batch_id=connected.batch_id THEN edge.child_batch_id ELSE edge.parent_batch_id END,
        connected.depth+1,
        connected.path || CASE WHEN edge.parent_batch_id=connected.batch_id THEN edge.child_batch_id ELSE edge.parent_batch_id END
      FROM connected JOIN batch_edges edge ON edge.parent_batch_id=connected.batch_id OR edge.child_batch_id=connected.batch_id
      WHERE connected.depth < 16
        AND NOT (CASE WHEN edge.parent_batch_id=connected.batch_id THEN edge.child_batch_id ELSE edge.parent_batch_id END)=ANY(connected.path)
    ) SELECT DISTINCT batch_id FROM connected ORDER BY batch_id LIMIT 1000`, { batchId });
  return rows.map((row) => row.batch_id);
}

export async function getMaterialBatchTraceability(batchId, auth) {
  if (!(await canAccessBatch(auth, batchId))) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested material batch was not found.');
  const [batch] = await query(`SELECT id,batch_code,material_kind,current_status,created_at FROM material_batch WHERE id=:batchId`, { batchId });
  if (!batch) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested material batch was not found.');
  const [qr] = await query(`SELECT id,status,rotated_from_id,created_at FROM qr_record
    WHERE material_batch_id=:batchId ORDER BY created_at DESC,id DESC LIMIT 1`, { batchId });
  const origins = await getBatchOrigins(batchId);
  const candidates = await connectedBatchIds(batchId);
  const visibleBatchIds = [];
  for (const id of candidates) if (await canAccessBatch(auth, id)) visibleBatchIds.push(id);
  const candidateSet = new Set(visibleBatchIds);

  const productionRows = await query(`SELECT DISTINCT pe.event_id,h.site_id FROM production_event_output peo
    JOIN material_event_output eo ON eo.id=peo.material_event_output_id
    JOIN production_event pe ON pe.event_id=peo.production_event_id
    JOIN mining_hole h ON h.id=pe.hole_id WHERE eo.batch_id IN (:batchIds)`, { batchIds: visibleBatchIds });
  const sites = await listSites(auth);
  const siteById = new Map(sites.map((site) => [site.id, site]));
  const productionEvents = [];
  const productionIds = new Set(productionRows.map((row) => row.event_id));
  for (const siteId of new Set(productionRows.map((row) => row.site_id))) {
    let listed;
    try { listed = await listAccessibleProductionEvents(siteId, auth); }
    catch (error) { if (isHiddenResource(error)) continue; throw error; }
    for (const row of listed) {
      if (!productionIds.has(row.id)) continue;
      const detail = await getProductionEvent(siteId, row.id);
      if (detail.outputs.some((output) => candidateSet.has(output.batch_id))) productionEvents.push({ siteId, siteName: siteById.get(siteId)?.name ?? null, ...detail });
    }
  }

  const processingRows = await query(`SELECT DISTINCT pe.event_id FROM processing_event pe
    WHERE EXISTS (SELECT 1 FROM processing_event_input pei JOIN material_event_input mei ON mei.id=pei.material_event_input_id
      WHERE pei.processing_event_id=pe.event_id AND mei.batch_id IN (:batchIds))
      OR EXISTS (SELECT 1 FROM processing_event_output peo JOIN material_event_output eo ON eo.id=peo.material_event_output_id
      WHERE peo.processing_event_id=pe.event_id AND eo.batch_id IN (:batchIds))`, { batchIds: visibleBatchIds });
  const processingIds = new Set(processingRows.map((row) => row.event_id));
  const processingEvents = [];
  for (const row of await listAccessibleProcessingEvents(auth)) {
    if (!processingIds.has(row.id)) continue;
    const detail = await getProcessingEvent(row.id);
    if ([...detail.inputs, ...detail.outputs].some((item) => candidateSet.has(item.batch_id))) processingEvents.push(detail);
  }

  const locationRows = await query(`SELECT DISTINCT location_id FROM inventory_movement_line WHERE batch_id IN (:batchIds)`, { batchIds: visibleBatchIds });
  const inventoryMovements = [];
  for (const { location_id: locationId } of locationRows) {
    try {
      const lines = await listInventoryMovements(locationId, auth);
      const relevant = lines.filter((line) => candidateSet.has(line.batch_id));
      for (const line of relevant) inventoryMovements.push({ locationId, ...line });
    } catch (error) { if (!isHiddenResource(error)) throw error; }
  }

  const consignments = [];
  for (const row of await listAccessibleConsignments(auth)) {
    try {
      const detail = await readConsignment(row.id, auth);
      if (detail.items.some((item) => candidateSet.has(item.batch_id))) consignments.push(detail);
    } catch (error) { if (!isHiddenResource(error)) throw error; }
  }

  const recoveryEvents = [];
  const recoveryRows = await query(`SELECT DISTINCT re.event_id FROM recovery_event re
    WHERE EXISTS (SELECT 1 FROM recovery_event_input ri WHERE ri.recovery_event_id=re.event_id AND ri.batch_id IN (:batchIds))
      OR EXISTS (SELECT 1 FROM recovery_event_output ro WHERE ro.recovery_event_id=re.event_id AND ro.batch_id IN (:batchIds))`, { batchIds: visibleBatchIds });
  const recoveryIds = new Set(recoveryRows.map((row) => row.event_id));
  for (const facility of await listAccessibleRecoveryFacilities(auth)) {
    for (const row of await listAccessibleRecoveryEvents(facility.id, auth)) {
      if (!recoveryIds.has(row.id)) continue;
      const detail = await readRecoveryEvent(row.id, auth);
      if ([...detail.inputs, ...detail.outputs].some((item) => candidateSet.has(item.batch_id))) recoveryEvents.push(detail);
    }
  }

  const residueSales = [];
  for (const row of await listAccessibleResidueSales(auth)) {
    try {
      const detail = await readResidueSale(row.id, auth);
      if (detail.lines.some((line) => candidateSet.has(line.batch_id))) residueSales.push(detail);
    } catch (error) { if (!isHiddenResource(error)) throw error; }
  }

  const tradeRows = await query(`SELECT DISTINCT trade_id FROM gold_trade_line WHERE batch_id IN (:batchIds) ORDER BY trade_id`, { batchIds: visibleBatchIds });
  const goldTrades = [];
  for (const row of tradeRows) {
    try {
      goldTrades.push(await readGoldTrade(row.trade_id, auth));
    } catch (error) { if (!isHiddenResource(error)) throw error; }
  }

  const relatedBatches = await query(`SELECT id,batch_code,material_kind,current_status FROM material_batch WHERE id IN (:batchIds) ORDER BY created_at,id`, { batchIds: visibleBatchIds });
  return {
    batch,
    origins,
    qr: qr ? { id: qr.id, status: qr.status, rotatedFromId: qr.rotated_from_id, createdAt: qr.created_at } : null,
    relatedBatches,
    productionEvents,
    processingEvents,
    inventoryMovements,
    consignments,
    recoveryEvents,
    residueSales,
    goldTrades,
    limitations: {
      pooledAttribution: 'Pooled recovery outputs remain aggregate; no individual source-person attribution is inferred.',
      tradeLookup: 'Trade and payment records are included only when the caller is an authorized trade party; no general trade search endpoint exists.',
    },
  };
}
