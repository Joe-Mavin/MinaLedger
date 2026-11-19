import { z } from 'zod';
import { acknowledgementSchema, measurementSchema, productionSchema } from '../production/production.schemas.mjs';

const dateTime = z.string().datetime({ offset: true });
const decimal = (places) => z.string().regex(new RegExp(`^(0|[1-9][0-9]*)(\\.[0-9]{1,${places}})?$`));
const positiveGrams = decimal(6).refine((value) => Number(value) > 0, 'Quantity must be greater than zero.');
export const measurementEvidenceSchema = z.object({
  kind: z.enum(['DECLARED', 'MEASURED', 'VERIFIED']).optional(), sourceValue: decimal(12).optional(),
  sourceUnit: z.string().trim().min(1).max(20).optional(), conversionVersion: z.string().trim().min(1).max(40).optional(),
  sourceRole: z.enum(['SELLER', 'BUYER', 'RECORDER', 'WITNESS', 'WEIGHER', 'OTHER']).optional(),
  methodCode: z.string().max(80).optional(), instrumentRef: z.string().max(160).optional(),
  occurredAt: dateTime.optional(), evidenceRef: z.string().max(255).optional(),
}).strict().optional();

export const allocationCommandInputSchema = z.object({
  basisKind: z.enum(['QUANTITY', 'SHARE']),
  basisMeasurementId: z.string().uuid().optional(),
  supersedesSetId: z.string().uuid().optional(),
  correctionReason: z.string().trim().min(1).max(500).optional(),
  rows: z.array(z.object({
    beneficiaryPartyId: z.string().uuid(),
    allocatedQuantityGrams: decimal(6).optional(),
    allocatedShare: decimal(9).optional(),
  }).strict()).min(1).max(100),
}).strict().superRefine((value, context) => {
  if (value.basisKind === 'QUANTITY' && !value.basisMeasurementId) context.addIssue({ code: 'custom', path: ['basisMeasurementId'], message: 'Choose the exact output observation for a quantity set.' });
  if (value.basisKind === 'SHARE' && value.basisMeasurementId) context.addIssue({ code: 'custom', path: ['basisMeasurementId'], message: 'Share sets do not name a measurement basis.' });
  if (Boolean(value.supersedesSetId) !== Boolean(value.correctionReason)) context.addIssue({ code: 'custom', path: ['correctionReason'], message: 'A complete revision names its predecessor and a reason.' });
  const seen = new Set();
  value.rows.forEach((row, index) => {
    if (seen.has(row.beneficiaryPartyId)) context.addIssue({ code: 'custom', path: ['rows', index, 'beneficiaryPartyId'], message: 'A beneficiary may appear once per complete set.' });
    seen.add(row.beneficiaryPartyId);
    if (value.basisKind === 'QUANTITY' && (row.allocatedQuantityGrams === undefined || row.allocatedShare !== undefined)) context.addIssue({ code: 'custom', path: ['rows', index], message: 'Every row in a quantity set needs only allocatedQuantityGrams.' });
    if (value.basisKind === 'SHARE' && (row.allocatedShare === undefined || row.allocatedQuantityGrams !== undefined)) context.addIssue({ code: 'custom', path: ['rows', index], message: 'Every row in a share set needs only allocatedShare.' });
  });
});

export const stockpileTransferInputSchema = z.object({
  destinationStockpileId: z.string().uuid(), occurredAt: dateTime,
  evidenceRef: z.string().trim().min(1).max(255),
  items: z.array(z.object({ batchId: z.string().uuid(), quantityGrams: positiveGrams, measurement: measurementEvidenceSchema }).strict()).min(1).max(40),
}).strict();

export const dispatchInputSchema = z.object({
  occurredAt: dateTime, evidenceRef: z.string().trim().min(1).max(255).optional(),
  items: z.array(z.object({ consignmentItemId: z.string().uuid(), measurementId: z.string().uuid() }).strict()).min(1).max(40),
}).strict();

const receiptItemSchema = z.object({
  consignmentItemId: z.string().uuid(), quantityGrams: positiveGrams,
  outcome: z.enum(['ACCEPTED', 'DISPUTED', 'REJECTED']),
  reason: z.string().trim().min(1).max(500).optional(), evidenceRef: z.string().trim().min(1).max(255).optional(),
  measurement: measurementEvidenceSchema,
}).strict().superRefine((value, context) => {
  if (value.outcome === 'ACCEPTED' && value.reason) context.addIssue({ code: 'custom', path: ['reason'], message: 'Accepted receipt does not require a discrepancy reason.' });
  if (value.outcome !== 'ACCEPTED' && !value.reason) context.addIssue({ code: 'custom', path: ['reason'], message: 'Disputed and rejected quantities need a reason.' });
});

export const receiptInputSchema = z.object({
  recoveryInventoryLocationId: z.string().uuid(), occurredAt: dateTime,
  evidenceRef: z.string().trim().min(1).max(255).optional(), note: z.string().trim().min(1).max(1000).optional(),
  items: z.array(receiptItemSchema).min(1).max(40),
}).strict();

export const receiptCorrectionInputSchema = z.object({
  recoveryInventoryLocationId: z.string().uuid(), quantityGrams: positiveGrams,
  outcome: z.enum(['ACCEPTED', 'DISPUTED', 'REJECTED']), correctionReason: z.string().trim().min(1).max(500),
  reason: z.string().trim().min(1).max(500).optional(), evidenceRef: z.string().trim().min(1).max(255).optional(),
  note: z.string().trim().min(1).max(1000).optional(), occurredAt: dateTime,
  measurement: measurementEvidenceSchema,
}).strict().superRefine((value, context) => {
  if (value.outcome === 'ACCEPTED' && value.reason) context.addIssue({ code: 'custom', path: ['reason'], message: 'Accepted receipt does not require a discrepancy reason.' });
  if (value.outcome !== 'ACCEPTED' && !value.reason) context.addIssue({ code: 'custom', path: ['reason'], message: 'Disputed and rejected quantities need a reason.' });
});

export const custodyOfferInputSchema = z.object({
  destinationLocationId: z.string().uuid(), occurredAt: dateTime,
  evidenceRef: z.string().trim().min(1).max(255).optional(),
}).strict();
export const custodyDecisionInputSchema = z.object({
  decision: z.enum(['ACCEPT', 'DISPUTE', 'REJECT', 'WITHDRAW']), occurredAt: dateTime,
  reason: z.string().trim().min(1).max(500).optional(), evidenceRef: z.string().trim().min(1).max(255).optional(),
}).strict().superRefine((value, context) => {
  if (value.decision !== 'ACCEPT' && !value.reason) context.addIssue({ code: 'custom', path: ['reason'], message: 'A non-acceptance decision needs a reason.' });
});
export const inventoryAdjustmentInputSchema = z.object({
  batchId: z.string().uuid(), countedQuantityGrams: decimal(6), reason: z.string().trim().min(1).max(500),
  evidenceRef: z.string().trim().min(1).max(255), occurredAt: dateTime, measurement: measurementEvidenceSchema,
}).strict();

export const goldTradeAssayInputSchema = z.object({
  assayerPartyId: z.string().uuid().optional(), sampleRef: z.string().trim().min(1).max(160).optional(),
  methodRef: z.string().trim().min(1).max(160).optional(), resultValue: decimal(8),
  resultUnit: z.string().trim().min(1).max(40), observedAt: dateTime, evidenceRef: z.string().trim().min(1).max(255).optional(),
  correctionOfId: z.string().uuid().optional(), correctionReason: z.string().trim().min(1).max(500).optional(),
}).strict().superRefine((value, context) => {
  if (Boolean(value.correctionOfId) !== Boolean(value.correctionReason)) context.addIssue({ code: 'custom', path: ['correctionReason'], message: 'An assay correction needs both a predecessor and a reason.' });
});
export const goldTradeMeasurementInputSchema = z.object({
  kind: z.enum(['DECLARED', 'MEASURED']), quantityGrams: positiveGrams, sourceValue: decimal(12),
  sourceUnit: z.enum(['g', 'kg', 'mg']), conversionVersion: z.literal('canonical-mass-v1'),
  sourceRole: z.enum(['SELLER', 'BUYER', 'RECORDER', 'WITNESS', 'WEIGHER', 'OTHER']),
  sourcePartyId: z.string().uuid().optional(), methodCode: z.string().trim().min(1).max(80).optional(),
  instrumentRef: z.string().trim().min(1).max(160).optional(), occurredAt: dateTime,
  evidenceRef: z.string().trim().min(1).max(255).optional(), supersedesMeasurementId: z.string().uuid().optional(),
  correctionReason: z.string().trim().min(1).max(500).optional(),
}).strict().superRefine((value, context) => {
  if (Boolean(value.supersedesMeasurementId) !== Boolean(value.correctionReason)) context.addIssue({ code: 'custom', path: ['correctionReason'], message: 'A measurement correction needs both a predecessor and a reason.' });
});
export const goldTradeCustodyOfferInputSchema = z.object({
  sourceLocationId: z.string().uuid(), destinationLocationId: z.string().uuid(), measurementSetId: z.string().uuid(), measurementId: z.string().uuid(),
  quantityGrams: positiveGrams, occurredAt: dateTime, evidenceRef: z.string().trim().min(1).max(255).optional(),
}).strict();

export const syncCommandTypes = [
  'production.create', 'production.measurement.add', 'capture.acknowledgement.add',
  'production.allocation.propose', 'stockpile.transfer', 'inventory.adjustment.create',
  'consignment.dispatch', 'consignment.receipt.add', 'consignment.receipt.correct',
  'consignment.custody.offer', 'custody.transfer.decide', 'gold_trade.assay.record',
  'gold_trade.measurement.add', 'gold_trade.custody.offer',
];

const expectedVersionSchema = z.object({
  streamKind: z.enum(['mining_hole', 'material_event', 'inventory_location', 'consignment', 'custody_transfer', 'gold_trade']),
  streamId: z.string().uuid(), sequence: z.number().int().nonnegative(),
}).strict();

export const syncEnvelopeSchema = z.object({
  clientMutationId: z.string().uuid(),
  deviceId: z.string().uuid(),
  recorderUserId: z.string().uuid(),
  actualParticipant: z.object({
    identityState: z.enum(['IDENTIFIED', 'UNRESOLVED', 'UNKNOWN']),
    partyId: z.string().uuid().optional(),
  }).strict().superRefine((value, context) => {
    if ((value.identityState === 'IDENTIFIED') !== Boolean(value.partyId)) context.addIssue({ code: 'custom', path: ['partyId'], message: 'IDENTIFIED requires a party; unresolved and unknown states omit it.' });
  }),
  actingContext: z.object({
    partyId: z.string().uuid(), roleCode: z.string().trim().min(1).max(40),
    scopeKind: z.enum(['GLOBAL', 'PILOT', 'ORGANISATION', 'SITE', 'HOLE', 'FACILITY']),
    scopeId: z.string().trim().min(1).max(80),
  }).strict(),
  commandType: z.enum(syncCommandTypes), schemaVersion: z.literal(1), payload: z.unknown(),
  clientCreatedAt: dateTime, clientTimezone: z.string().trim().min(1).max(80), occurredAtClaimed: dateTime,
  expectedVersion: expectedVersionSchema.optional(), parentCommandIds: z.array(z.string().uuid()).max(50).default([]),
  revisionOf: z.string().uuid().optional(), captureProvenance: z.unknown().optional(),
  evidence: z.array(z.object({ reference: z.string().trim().min(1).max(255), sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional() }).strict()).max(50).default([]),
  localState: z.enum(['pending_upload', 'uploading']),
}).strict().superRefine((value, context) => {
  if (value.parentCommandIds.includes(value.clientMutationId)) context.addIssue({ code: 'custom', path: ['parentCommandIds'], message: 'A command cannot depend on itself.' });
  if (value.revisionOf && !value.parentCommandIds.includes(value.revisionOf)) context.addIssue({ code: 'custom', path: ['revisionOf'], message: 'A linked revision must include its original command as a parent dependency.' });
});

const payloadSchemas = {
  'production.create': z.object({ siteId: z.string().uuid(), input: productionSchema }).strict(),
  'production.measurement.add': z.object({ siteId: z.string().uuid(), eventId: z.string().uuid(), outputId: z.string().uuid(), input: measurementSchema }).strict(),
  'capture.acknowledgement.add': z.object({ siteId: z.string().uuid(), eventId: z.string().uuid(), captureProvenanceId: z.string().uuid(), acknowledgement: acknowledgementSchema }).strict(),
  'production.allocation.propose': z.object({ siteId: z.string().uuid(), eventId: z.string().uuid(), outputId: z.string().uuid(), input: allocationCommandInputSchema }).strict(),
  'stockpile.transfer': z.object({ sourceLocationId: z.string().uuid(), input: stockpileTransferInputSchema }).strict(),
  'inventory.adjustment.create': z.object({ locationId: z.string().uuid(), input: inventoryAdjustmentInputSchema }).strict(),
  'consignment.dispatch': z.object({ consignmentId: z.string().uuid(), input: dispatchInputSchema }).strict(),
  'consignment.receipt.add': z.object({ consignmentId: z.string().uuid(), input: receiptInputSchema }).strict(),
  'consignment.receipt.correct': z.object({ consignmentId: z.string().uuid(), receiptItemId: z.string().uuid(), input: receiptCorrectionInputSchema }).strict(),
  'consignment.custody.offer': z.object({ consignmentId: z.string().uuid(), input: custodyOfferInputSchema }).strict(),
  'custody.transfer.decide': z.object({ transferId: z.string().uuid(), input: custodyDecisionInputSchema }).strict(),
  'gold_trade.assay.record': z.object({ tradeId: z.string().uuid(), lineId: z.string().uuid(), input: goldTradeAssayInputSchema }).strict(),
  'gold_trade.measurement.add': z.object({ tradeId: z.string().uuid(), lineId: z.string().uuid(), input: goldTradeMeasurementInputSchema }).strict(),
  'gold_trade.custody.offer': z.object({ tradeId: z.string().uuid(), lineId: z.string().uuid(), input: goldTradeCustodyOfferInputSchema }).strict(),
};

export function parseCommandPayload(envelope) {
  return payloadSchemas[envelope.commandType].safeParse(envelope.payload);
}

export function commandVersionTarget(commandType, payload) {
  switch (commandType) {
    case 'production.create': return { streamKind: 'mining_hole', streamId: payload.input.holeId };
    case 'production.measurement.add':
    case 'capture.acknowledgement.add':
    case 'production.allocation.propose': return { streamKind: 'material_event', streamId: payload.eventId };
    case 'stockpile.transfer': return { streamKind: 'inventory_location', streamId: payload.sourceLocationId };
    case 'inventory.adjustment.create': return { streamKind: 'inventory_location', streamId: payload.locationId };
    case 'consignment.dispatch':
    case 'consignment.receipt.add':
    case 'consignment.receipt.correct':
    case 'consignment.custody.offer': return { streamKind: 'consignment', streamId: payload.consignmentId };
    case 'custody.transfer.decide': return { streamKind: 'custody_transfer', streamId: payload.transferId };
    case 'gold_trade.assay.record': return { streamKind: 'gold_trade', streamId: payload.tradeId };
    case 'gold_trade.measurement.add':
    case 'gold_trade.custody.offer': return { streamKind: 'gold_trade', streamId: payload.tradeId };
    default: throw new Error(`No expected-version target for command ${commandType}.`);
  }
}

const expectedVersionRequired = new Set(syncCommandTypes.filter((type) => !['production.create', 'production.measurement.add', 'capture.acknowledgement.add'].includes(type)));
export function requiresExpectedVersion(commandType) { return expectedVersionRequired.has(commandType); }
