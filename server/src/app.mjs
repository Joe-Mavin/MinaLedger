import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { z } from 'zod';
import { env } from './config/env.mjs';
import { logger } from './config/logger.mjs';
import { sequelize } from './database/connection.mjs';
import { authenticate, canAccessHole, canAccessProcessingFacility, canAccessSite, hasRole, requireHoleAccess, requirePilotFieldOfficer, requireParticipantWriteAccess, requireProcessingFacilityAccess, requireProductionEventAccess, requireProductionHoleAccess, requireSiteAccess, requireSystemAdministrator } from './middleware/auth.mjs';
import { login, getProfile, createAccount, createOrganisation, addRoleAssignment, revokeRoleAssignment } from './modules/identity/identity.service.mjs';
import { createSite, listSites, getSite, updateSite, createHole, getHole, listHoles, createParticipant, listParticipants, listHoleParticipants } from './modules/mining-sites/site.service.mjs';
import { createProductionEvent, addOutputMeasurement, listProductionEvents, getProductionEvent } from './modules/production/production.service.mjs';
import { createDora, listSiteDoras, getDora, updateDora } from './modules/dora/dora.service.mjs';
import { createProcessingEvent, getProcessingEvent, addProcessingMeasurement, processingEventAccessRows } from './modules/processing/processing.service.mjs';
import { createAllocationSet, getOutputAllocations } from './modules/allocations/allocation.service.mjs';
import { createBatchQr, rotateBatchQr, lookupQr, canAccessBatch } from './modules/qr/qr.service.mjs';
import {
  createStockpile, listStockpiles, receiveDoraResidue, transferBetweenStockpiles, createConsignment,
  dispatchConsignment, addTransportLeg, readConsignment, createRecoveryInventoryLocation, listLocationBalances,
  receiveConsignment, correctConsignmentReceiptItem, createCustodyOffer, decideCustodyTransfer,
  createResidueSale, proposeResidueSaleLineRevision, decideResidueSaleLine,
  readResidueSale, adjustInventory, createRecoveryEvent, readRecoveryEvent,
} from './modules/residue/residue.service.mjs';
import {
  createGoldTrade, addGoldTradeLine, readGoldTrade, recordGoldTradeMeasurement, recordGoldTradeAssay,
  proposeGoldTradeRevision, decideGoldTradeLine, createGoldCustodyOffer, decideGoldCustodyTransfer,
  recordGoldTradePayment, decideGoldTradePayment,
} from './modules/gold-trades/gold-trade.service.mjs';
import { AppError, errorHandler, validateBody } from './utils/errors.mjs';

const decimal = (places) => z.string().regex(new RegExp(`^(0|[1-9][0-9]*)(\\.[0-9]{1,${places}})?$`));
const dateTime = z.string().datetime({ offset: true });
const loginSchema = z.object({ email: z.string().email().max(320), password: z.string().min(1).max(128) }).strict();
const emptySchema = z.object({}).strict().default({});
const accountSchema = z.object({ email: z.string().email().max(320), displayName: z.string().trim().min(1).max(160), password: z.string().min(12).max(72), organisationPartyId: z.string().uuid().optional() }).strict();
const organisationSchema = z.object({ displayName: z.string().trim().min(1).max(160), organisationKind: z.string().trim().min(1).max(40) }).strict();
const roleSchema = z.object({ roleCode: z.enum(['SYSTEM_ADMIN', 'FIELD_OFFICER', 'MINING_OPERATOR', 'MINER', 'DORA_OPERATOR', 'RECOVERY_FACILITY_OPERATOR', 'LOCAL_MERCHANT', 'LARGER_MERCHANT', 'AUDITOR']), scopeKind: z.enum(['GLOBAL', 'PILOT', 'ORGANISATION', 'SITE', 'HOLE', 'FACILITY']), scopeId: z.string().min(1).max(80) }).strict();
const siteSchema = z.object({ siteCode: z.string().trim().min(1).max(80), name: z.string().trim().min(1).max(160), countyCode: z.string().max(80).optional(), locality: z.string().max(160).optional() }).strict();
const sitePatchSchema = z.object({ name: z.string().trim().min(1).max(160).optional(), countyCode: z.string().max(80).nullable().optional(), locality: z.string().max(160).nullable().optional() }).strict().refine((value) => Object.keys(value).length > 0, 'At least one permitted site field must be supplied.');
const holeSchema = z.object({ holeCode: z.string().trim().min(1).max(80), name: z.string().trim().max(160).optional() }).strict();
const siteRole = z.enum(['LANDOWNER', 'PERMIT_HOLDER', 'SITE_OPERATOR', 'MINER', 'BENEFICIARY', 'FIELD_RECORDER', 'OTHER']);
const holeRole = z.enum(['HOLE_OPERATOR', 'MINER', 'BENEFICIARY', 'FIELD_RECORDER', 'OTHER']);
const participantKinds = z.enum(['MINER', 'MINING_OPERATOR', 'LANDOWNER', 'PERMIT_HOLDER', 'DORA_OPERATOR', 'RECOVERY_FACILITY', 'LOCAL_MERCHANT', 'LARGER_MERCHANT', 'CARRIER', 'FIELD_OFFICER', 'AUDITOR', 'SERVICE_PROVIDER', 'FAMILY_OR_AGREED_BENEFICIARY', 'OTHER']);
const participantSchema = z.object({
  partyId: z.string().uuid().optional(),
  partyKind: z.enum(['PERSON', 'ORGANISATION']).optional(),
  displayName: z.string().trim().min(1).max(160).optional(),
  organisationKind: z.string().trim().min(1).max(40).optional(),
  participantKind: participantKinds,
  roleCode: z.union([siteRole, holeRole]),
  holeId: z.string().uuid().optional(),
  validFrom: dateTime.optional(),
  validTo: dateTime.optional(),
  sourceReference: z.string().trim().min(1).max(255).optional(),
  evidenceRef: z.string().trim().min(1).max(255).optional(),
}).strict().superRefine((value, context) => {
  if (value.partyId && (value.partyKind || value.displayName || value.organisationKind)) context.addIssue({ code: 'custom', path: ['partyId'], message: 'Existing participants are selected by partyId without replacement identity fields.' });
  if (!value.partyId && (!value.partyKind || !value.displayName)) context.addIssue({ code: 'custom', path: ['partyKind'], message: 'New participants require partyKind and displayName.' });
  if (!value.partyId && value.partyKind === 'ORGANISATION' && !value.organisationKind) context.addIssue({ code: 'custom', path: ['organisationKind'], message: 'organisationKind is required for organisation parties.' });
  if (value.holeId && !holeRole.safeParse(value.roleCode).success) context.addIssue({ code: 'custom', path: ['roleCode'], message: 'roleCode is not a hole role.' });
  if (!value.holeId && !siteRole.safeParse(value.roleCode).success) context.addIssue({ code: 'custom', path: ['roleCode'], message: 'roleCode is not a site role.' });
  if (value.validFrom && value.validTo && new Date(value.validTo) <= new Date(value.validFrom)) context.addIssue({ code: 'custom', path: ['validTo'], message: 'validTo must be later than validFrom.' });
}).transform((value) => ({ ...value, organisationKind: value.organisationKind ?? null }));
const measurementSchema = z.object({
  kind: z.enum(['DECLARED', 'MEASURED', 'VERIFIED']),
  quantityGrams: decimal(6),
  sourceValue: decimal(12),
  sourceUnit: z.string().trim().min(1).max(20),
  conversionVersion: z.string().trim().min(1).max(40),
  sourceRole: z.enum(['SELLER', 'BUYER', 'RECORDER', 'WITNESS', 'WEIGHER', 'OTHER']),
  sourcePartyId: z.string().uuid().optional(),
  methodCode: z.string().max(80).optional(),
  instrumentRef: z.string().max(160).optional(),
  occurredAt: dateTime.optional(),
  evidenceRef: z.string().max(255).optional(),
  supersedesMeasurementId: z.string().uuid().optional(),
}).strict();
const newMeasurementSchema = measurementSchema.omit({ supersedesMeasurementId: true });
const productionSchema = z.object({
  holeId: z.string().uuid(),
  occurredAt: dateTime,
  shiftOrPeriodRef: z.string().max(100).optional(),
  participantRelationshipIds: z.array(z.string().uuid()).max(40).optional(),
  captureProvenance: z.object({
    actualParticipantPartyId: z.string().uuid().optional(),
    participantIdentityState: z.enum(['IDENTIFIED', 'UNRESOLVED', 'UNKNOWN']),
    sourceKind: z.enum(['DIRECT', 'ASSISTED_VERBAL', 'WITNESS', 'PAPER_TRANSCRIPTION', 'OTHER']),
    occurredAt: dateTime.optional(),
    sourceReference: z.string().max(255).optional(),
    evidenceRef: z.string().max(255).optional(),
    note: z.string().max(1000).optional(),
    acknowledgement: z.object({
      status: z.enum(['ACKNOWLEDGED', 'PENDING', 'DECLINED', 'DISPUTED', 'NOT_OBTAINED']),
      acknowledgedByPartyId: z.string().uuid().optional(),
      method: z.string().max(80).optional(),
      occurredAt: dateTime.optional(),
      reason: z.string().max(500).optional(),
    }).strict().optional(),
  }).strict().superRefine((value, context) => {
    if ((value.participantIdentityState === 'IDENTIFIED') !== Boolean(value.actualParticipantPartyId)) context.addIssue({ code: 'custom', path: ['actualParticipantPartyId'], message: 'IDENTIFIED capture requires an actual participant; other identity states omit it.' });
    if (value.acknowledgement?.status === 'ACKNOWLEDGED' && !value.acknowledgement.acknowledgedByPartyId) context.addIssue({ code: 'custom', path: ['acknowledgement', 'acknowledgedByPartyId'], message: 'ACKNOWLEDGED requires the acknowledging party.' });
    if (value.acknowledgement?.status !== 'ACKNOWLEDGED' && value.acknowledgement?.acknowledgedByPartyId) context.addIssue({ code: 'custom', path: ['acknowledgement', 'acknowledgedByPartyId'], message: 'Only an ACKNOWLEDGED event names an acknowledging party.' });
  }).optional(),
  outputs: z.array(z.object({
    materialKind: z.enum(['GOLD_BEARING_FEED', 'RESIDUE', 'GOLD_DORE', 'RECOVERED_GOLD', 'PROCESS_OUTPUT']),
    outputKind: z.string().trim().min(1).max(40).optional(),
    measurements: z.array(newMeasurementSchema).max(20).optional(),
  }).strict()).min(1).max(20),
}).strict();
const doraSchema = z.object({ name: z.string().trim().min(1).max(160) }).strict();
const doraPatchSchema = z.object({ name: z.string().trim().min(1).max(160).optional(), status: z.enum(['ACTIVE', 'INACTIVE']).optional() }).strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one permitted Dora field must be supplied.');
const allocationRowSchema = z.object({
  beneficiaryPartyId: z.string().uuid(),
  allocatedQuantityGrams: decimal(6).optional(),
  allocatedShare: decimal(9).optional(),
}).strict();
const allocationSchema = z.object({
  basisKind: z.enum(['QUANTITY', 'SHARE']),
  basisMeasurementId: z.string().uuid().optional(),
  supersedesSetId: z.string().uuid().optional(),
  correctionReason: z.string().trim().min(1).max(500).optional(),
  rows: z.array(allocationRowSchema).min(1).max(100),
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
const processingSchema = z.object({
  processingFacilityId: z.string().uuid(),
  occurredAt: dateTime,
  compensationArrangementCode: z.string().trim().min(1).max(40).optional(),
  serviceTermsRef: z.string().trim().min(1).max(255).optional(),
  inputs: z.array(z.object({ sourceProductionOutputId: z.string().uuid(), measurements: z.array(newMeasurementSchema).min(1).max(20) }).strict()).min(1).max(20),
  outputs: z.array(z.object({
    materialKind: z.enum(['GOLD_BEARING_FEED', 'RESIDUE', 'GOLD_DORE', 'RECOVERED_GOLD', 'PROCESS_OUTPUT']),
    outputRole: z.enum(['MINER_RETAINED_GOLD', 'DORA_RETAINED_RESIDUE', 'OTHER_OUTPUT']),
    outputKind: z.string().trim().min(1).max(40).optional(),
    measurements: z.array(newMeasurementSchema).min(1).max(20),
  }).strict()).min(1).max(20),
}).strict().superRefine((value, context) => {
  if (Boolean(value.compensationArrangementCode) !== Boolean(value.serviceTermsRef)) context.addIssue({ code: 'custom', path: ['serviceTermsRef'], message: 'Record both the applicable arrangement code and its source reference.' });
  if (new Set(value.inputs.map((input) => input.sourceProductionOutputId)).size !== value.inputs.length) context.addIssue({ code: 'custom', path: ['inputs'], message: 'A source production output may appear once per processing event.' });
});
const positiveGrams = decimal(6).refine((value) => Number(value) > 0, 'Quantity must be greater than zero.');
const measurementEvidenceSchema = z.object({
  kind: z.enum(['DECLARED', 'MEASURED', 'VERIFIED']).optional(),
  sourceValue: decimal(12).optional(),
  sourceUnit: z.string().trim().min(1).max(20).optional(),
  conversionVersion: z.string().trim().min(1).max(40).optional(),
  sourceRole: z.enum(['SELLER', 'BUYER', 'RECORDER', 'WITNESS', 'WEIGHER', 'OTHER']).optional(),
  methodCode: z.string().max(80).optional(),
  instrumentRef: z.string().max(160).optional(),
  occurredAt: dateTime.optional(),
  evidenceRef: z.string().max(255).optional(),
}).strict().optional();
const stockpileSchema = z.object({
  stockpileCode: z.string().trim().min(1).max(100),
  locationCode: z.string().trim().min(1).max(100),
  physicalPlaceRef: z.string().trim().min(1).max(255).optional(),
}).strict();
const stockpileIntakeSchema = z.object({
  occurredAt: dateTime,
  evidenceRef: z.string().trim().min(1).max(255).optional(),
  outputs: z.array(z.object({ outputId: z.string().uuid(), measurementId: z.string().uuid() }).strict()).min(1).max(40),
}).strict();
const stockpileTransferSchema = z.object({
  destinationStockpileId: z.string().uuid(),
  occurredAt: dateTime,
  evidenceRef: z.string().trim().min(1).max(255),
  items: z.array(z.object({ batchId: z.string().uuid(), quantityGrams: positiveGrams, measurement: measurementEvidenceSchema }).strict()).min(1).max(40),
}).strict();
const consignmentSchema = z.object({
  consignmentCode: z.string().trim().min(1).max(100).optional(),
  recoveryFacilityId: z.string().uuid(),
  transporterPartyId: z.string().uuid().optional(),
  transitLocationRef: z.string().trim().min(1).max(255).optional(),
  occurredAt: dateTime,
  items: z.array(z.object({
    sourceStockpileId: z.string().uuid(), batchId: z.string().uuid(), quantityGrams: positiveGrams,
    measurement: measurementEvidenceSchema, residueSaleLineId: z.string().uuid().optional(), saleMappedQuantityGrams: positiveGrams.optional(),
  }).strict().refine((row) => !row.saleMappedQuantityGrams || Boolean(row.residueSaleLineId), 'Sale mapped quantity requires a residue sale line.')).min(1).max(40),
}).strict();
const dispatchSchema = z.object({
  occurredAt: dateTime, evidenceRef: z.string().trim().min(1).max(255).optional(),
  items: z.array(z.object({ consignmentItemId: z.string().uuid(), measurementId: z.string().uuid() }).strict()).min(1).max(40),
}).strict();
const transportLegSchema = z.object({
  carrierPartyId: z.string().uuid().optional(), vehicleRef: z.string().trim().min(1).max(120).optional(),
  departureAt: dateTime.optional(), arrivalAt: dateTime.optional(), evidenceRef: z.string().trim().min(1).max(255).optional(),
}).strict().refine((value) => Boolean(value.departureAt || value.arrivalAt), 'A transport leg needs a departure or arrival time.')
  .refine((value) => !value.departureAt || !value.arrivalAt || new Date(value.arrivalAt) >= new Date(value.departureAt), 'Arrival cannot be before departure.');
const recoveryLocationSchema = z.object({ locationCode: z.string().trim().min(1).max(100), physicalPlaceRef: z.string().trim().min(1).max(255).optional() }).strict();
const receiptSchema = z.object({
  recoveryInventoryLocationId: z.string().uuid(), occurredAt: dateTime,
  evidenceRef: z.string().trim().min(1).max(255).optional(), note: z.string().trim().min(1).max(1000).optional(),
  items: z.array(z.object({
    consignmentItemId: z.string().uuid(), quantityGrams: positiveGrams, outcome: z.enum(['ACCEPTED', 'DISPUTED', 'REJECTED']),
    reason: z.string().trim().min(1).max(500).optional(), evidenceRef: z.string().trim().min(1).max(255).optional(), measurement: measurementEvidenceSchema,
  }).strict().superRefine((value, context) => {
    if (value.outcome === 'ACCEPTED' && value.reason) context.addIssue({ code: 'custom', path: ['reason'], message: 'Accepted receipt does not require a discrepancy reason.' });
    if (value.outcome !== 'ACCEPTED' && !value.reason) context.addIssue({ code: 'custom', path: ['reason'], message: 'Disputed and rejected quantities need a reason.' });
  })).min(1).max(40),
}).strict();
const receiptCorrectionSchema = z.object({
  recoveryInventoryLocationId: z.string().uuid(), quantityGrams: positiveGrams,
  outcome: z.enum(['ACCEPTED', 'DISPUTED', 'REJECTED']), correctionReason: z.string().trim().min(1).max(500),
  reason: z.string().trim().min(1).max(500).optional(), evidenceRef: z.string().trim().min(1).max(255).optional(),
  note: z.string().trim().min(1).max(1000).optional(), occurredAt: dateTime, measurement: measurementEvidenceSchema,
}).strict().superRefine((value, context) => {
  if (value.outcome === 'ACCEPTED' && value.reason) context.addIssue({ code: 'custom', path: ['reason'], message: 'Accepted receipt does not require a discrepancy reason.' });
  if (value.outcome !== 'ACCEPTED' && !value.reason) context.addIssue({ code: 'custom', path: ['reason'], message: 'Disputed and rejected quantities need a reason.' });
});
const custodyOfferSchema = z.object({ destinationLocationId: z.string().uuid(), occurredAt: dateTime, evidenceRef: z.string().trim().min(1).max(255).optional() }).strict();
const custodyDecisionSchema = z.object({
  decision: z.enum(['ACCEPT', 'DISPUTE', 'REJECT', 'WITHDRAW']), occurredAt: dateTime,
  reason: z.string().trim().min(1).max(500).optional(), evidenceRef: z.string().trim().min(1).max(255).optional(),
}).strict().superRefine((value, context) => {
  if (value.decision !== 'ACCEPT' && !value.reason) context.addIssue({ code: 'custom', path: ['reason'], message: 'A non-acceptance decision needs a reason.' });
});
const residueSaleSchema = z.object({
  saleCode: z.string().trim().min(1).max(100).optional(), processingFacilityId: z.string().uuid(), recoveryFacilityId: z.string().uuid(),
  agreedAt: dateTime, currencyCode: z.string().regex(/^[A-Z]{3}$/), termsRef: z.string().trim().min(1).max(255).optional(),
  lines: z.array(z.object({ batchId: z.string().uuid(), quantityGrams: positiveGrams, unitPrice: decimal(8).optional(), lineAmount: decimal(8).optional() }).strict()).min(1).max(40),
}).strict();
const residueSaleDecisionSchema = z.object({
  decision: z.enum(['ACCEPT', 'DISPUTE', 'REJECT']), acceptedQuantityGrams: positiveGrams.optional(), occurredAt: dateTime,
  reason: z.string().trim().min(1).max(500).optional(), evidenceRef: z.string().trim().min(1).max(255).optional(),
}).strict().superRefine((value, context) => {
  if ((value.decision === 'ACCEPT') !== Boolean(value.acceptedQuantityGrams)) context.addIssue({ code: 'custom', path: ['acceptedQuantityGrams'], message: 'Accept requires an agreed quantity; other decisions omit it.' });
  if (value.decision !== 'ACCEPT' && !value.reason) context.addIssue({ code: 'custom', path: ['reason'], message: 'A dispute or rejection needs a reason.' });
});
const residueSaleRevisionSchema = z.object({
  quantityGrams: positiveGrams, unitPrice: decimal(8).optional(), lineAmount: decimal(8).optional(),
  correctionReason: z.string().trim().min(1).max(500), occurredAt: dateTime,
}).strict();
const adjustmentSchema = z.object({
  batchId: z.string().uuid(), countedQuantityGrams: decimal(6), reason: z.string().trim().min(1).max(500),
  evidenceRef: z.string().trim().min(1).max(255), occurredAt: dateTime, measurement: measurementEvidenceSchema,
}).strict();
const recoveryEventSchema = z.object({
  recoveryInventoryLocationId: z.string().uuid(), occurredAt: dateTime, methodRef: z.string().trim().min(1).max(255).optional(),
  notesRef: z.string().trim().min(1).max(255).optional(), varianceNote: z.string().trim().min(1).max(500).optional(),
  inputs: z.array(z.object({
    batchId: z.string().uuid(), quantityGrams: positiveGrams, measurement: measurementEvidenceSchema,
    sources: z.array(z.object({ receiptItemId: z.string().uuid(), quantityGrams: positiveGrams }).strict()).min(1).max(40),
  }).strict()).min(1).max(40),
  outputs: z.array(z.object({
    materialKind: z.enum(['RECOVERED_GOLD', 'PROCESS_OUTPUT']), outputRole: z.enum(['RECOVERED_GOLD', 'OTHER_OUTPUT']),
    outputKind: z.string().trim().min(1).max(40).optional(), quantityGrams: positiveGrams, measurement: measurementEvidenceSchema,
  }).strict()).min(1).max(40),
  stages: z.array(z.object({ stageCode: z.enum(['LEACHING', 'CARBON_RELATED', 'ELUTION', 'FINAL_RECOVERY', 'OTHER']), occurredAt: dateTime, evidenceRef: z.string().trim().min(1).max(255).optional(), note: z.string().trim().min(1).max(500).optional() }).strict()).max(20).optional(),
  variances: z.array(z.object({
    varianceKind: z.enum(['INPUT', 'OUTPUT', 'PROCESS']), expectedQuantityGrams: decimal(6).optional(), observedQuantityGrams: decimal(6).optional(), varianceQuantityGrams: decimal(6).optional(),
    reason: z.string().trim().min(1).max(500), evidenceRef: z.string().trim().min(1).max(255).optional(),
  }).strict().refine((value) => value.expectedQuantityGrams !== undefined || value.observedQuantityGrams !== undefined || value.varianceQuantityGrams !== undefined, 'A variance needs at least one quantity value.')).max(40).optional(),
}).strict().superRefine((value, context) => {
  value.outputs.forEach((output, index) => {
    if ((output.materialKind === 'RECOVERED_GOLD') !== (output.outputRole === 'RECOVERED_GOLD')) context.addIssue({ code: 'custom', path: ['outputs', index, 'outputRole'], message: 'Recovered gold batch classification and output role must agree.' });
  });
});

const goldTradeLineSchema = z.object({
  batchId: z.string().uuid(), quantityGrams: positiveGrams, unitPrice: decimal(8).refine((value) => Number(value)>0, 'Unit price must be greater than zero.'),
  deductionAmount: decimal(8).optional(), deductionReason: z.string().trim().min(1).max(500).optional(), assayRecordId: z.string().uuid().optional(),
}).strict().superRefine((value, context) => {
  if (value.deductionAmount && Number(value.deductionAmount)>0 && !value.deductionReason) context.addIssue({ code: 'custom', path: ['deductionReason'], message: 'A deduction requires a reason.' });
  if ((!value.deductionAmount || Number(value.deductionAmount)===0) && value.deductionReason) context.addIssue({ code: 'custom', path: ['deductionReason'], message: 'Deduction reason requires a non-zero deduction.' });
});
const goldTradeSchema = z.object({
  tradeCode: z.string().trim().min(1).max(100).optional(), tradeKind: z.enum(['PURCHASE','RESALE']),
  sellerPartyId: z.string().uuid(), buyerPartyId: z.string().uuid(), tradeDate: dateTime,
  currencyCode: z.string().regex(/^[A-Z]{3}$/), termsRef: z.string().trim().min(1).max(255).optional(),
  evidence: z.object({ kind: z.enum(['TERMS','WEIGHT','ASSAY','CUSTODY','PAYMENT','OTHER']), reference: z.string().trim().min(1).max(255), note: z.string().trim().min(1).max(1000).optional(), occurredAt: dateTime }).strict().optional(),
  lines: z.array(goldTradeLineSchema).min(1).max(40),
}).strict();
const goldTradeMeasurementSchema = z.object({
  kind: z.enum(['DECLARED','MEASURED']), quantityGrams: positiveGrams, sourceValue: decimal(12), sourceUnit: z.enum(['g','kg','mg']),
  conversionVersion: z.literal('canonical-mass-v1'), sourceRole: z.enum(['SELLER','BUYER','RECORDER','WITNESS','WEIGHER','OTHER']),
  sourcePartyId: z.string().uuid().optional(), methodCode: z.string().trim().min(1).max(80).optional(),
  instrumentRef: z.string().trim().min(1).max(160).optional(), occurredAt: dateTime, evidenceRef: z.string().trim().min(1).max(255).optional(),
  supersedesMeasurementId: z.string().uuid().optional(), correctionReason: z.string().trim().min(1).max(500).optional(),
}).strict().superRefine((value, context) => {
  if (Boolean(value.supersedesMeasurementId)!==Boolean(value.correctionReason)) context.addIssue({ code: 'custom', path: ['correctionReason'], message: 'A measurement correction needs both a predecessor and a reason.' });
});
const goldTradeAssaySchema = z.object({
  assayerPartyId: z.string().uuid().optional(), sampleRef: z.string().trim().min(1).max(160).optional(), methodRef: z.string().trim().min(1).max(160).optional(),
  resultValue: decimal(8), resultUnit: z.string().trim().min(1).max(40), observedAt: dateTime, evidenceRef: z.string().trim().min(1).max(255).optional(),
  correctionOfId: z.string().uuid().optional(), correctionReason: z.string().trim().min(1).max(500).optional(),
}).strict().superRefine((value, context) => {
  if (Boolean(value.correctionOfId)!==Boolean(value.correctionReason)) context.addIssue({ code: 'custom', path: ['correctionReason'], message: 'An assay correction needs both a predecessor and a reason.' });
});
const goldTradeRevisionSchema = z.object({
  quantityGrams: positiveGrams, unitPrice: decimal(8).refine((value) => Number(value)>0, 'Unit price must be greater than zero.'),
  deductionAmount: decimal(8).optional(), deductionReason: z.string().trim().min(1).max(500).optional(),
  correctionReason: z.string().trim().min(1).max(500), occurredAt: dateTime, assayRecordId: z.string().uuid().optional(), evidenceRef: z.string().trim().min(1).max(255).optional(),
}).strict().superRefine((value, context) => {
  if (value.deductionAmount && Number(value.deductionAmount)>0 && !value.deductionReason) context.addIssue({ code: 'custom', path: ['deductionReason'], message: 'A deduction requires a reason.' });
});
const goldTradeDecisionSchema = z.object({
  decision: z.enum(['ACCEPT','DISPUTE','REJECT']), quantityGrams: positiveGrams.optional(), unitPrice: decimal(8).optional(),
  deductionAmount: decimal(8).optional(), deductionReason: z.string().trim().min(1).max(500).optional(), occurredAt: dateTime,
  reason: z.string().trim().min(1).max(500).optional(), evidenceRef: z.string().trim().min(1).max(255).optional(),
}).strict().superRefine((value, context) => {
  if (value.decision==='ACCEPT' && (!value.quantityGrams || !value.unitPrice)) context.addIssue({ code: 'custom', path: ['quantityGrams'], message: 'Acceptance requires a quantity and unit price.' });
  if (value.decision!=='ACCEPT' && (value.quantityGrams || value.unitPrice || value.deductionAmount)) context.addIssue({ code: 'custom', path: ['decision'], message: 'A dispute or rejection does not include accepted terms.' });
  if (value.decision!=='ACCEPT' && !value.reason) context.addIssue({ code: 'custom', path: ['reason'], message: 'A dispute or rejection needs a reason.' });
  if (value.deductionAmount && Number(value.deductionAmount)>0 && !value.deductionReason) context.addIssue({ code: 'custom', path: ['deductionReason'], message: 'An agreed deduction needs a reason.' });
});
const goldCustodyOfferSchema = z.object({
  sourceLocationId: z.string().uuid(), destinationLocationId: z.string().uuid(), measurementSetId: z.string().uuid(), measurementId: z.string().uuid(),
  quantityGrams: positiveGrams, occurredAt: dateTime, evidenceRef: z.string().trim().min(1).max(255).optional(),
}).strict();
const goldPaymentSchema = z.object({
  amount: decimal(8).refine((value) => Number(value)>0, 'Payment amount must be greater than zero.'),
  methodCode: z.string().trim().min(1).max(40), reference: z.string().trim().min(1).max(160).optional(),
  evidenceRef: z.string().trim().min(1).max(255).optional(), occurredAt: dateTime,
}).strict();
const goldPaymentDecisionSchema = z.object({
  decision: z.enum(['CONFIRM','DISPUTE','FAIL','REVERSE']), amount: decimal(8).optional(),
  methodCode: z.string().trim().min(1).max(40).optional(), reference: z.string().trim().min(1).max(160).optional(),
  reason: z.string().trim().min(1).max(500).optional(), evidenceRef: z.string().trim().min(1).max(255).optional(), occurredAt: dateTime,
}).strict().superRefine((value, context) => {
  if (value.decision==='REVERSE' && (!value.amount || !value.reason)) context.addIssue({ code: 'custom', path: ['amount'], message: 'A reversal needs an amount and reason.' });
  if (value.decision!=='REVERSE' && value.amount) context.addIssue({ code: 'custom', path: ['amount'], message: 'Amount is supplied only for a reversal.' });
  if (value.decision==='DISPUTE' || value.decision==='FAIL') if (!value.reason) context.addIssue({ code: 'custom', path: ['reason'], message: 'A disputed or failed payment needs a reason.' });
});

function requireIdempotencyKey(req, res, next) {
  const key = req.get('idempotency-key');
  if (!key) return next(new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Provide an Idempotency-Key UUID for this command.'));
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) return next(new AppError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be a UUID.'));
  return next();
}

function requireUuidParams(...names) {
  return (req, res, next) => {
    for (const name of names) {
      if (!z.string().uuid().safeParse(req.params[name]).success) return next(new AppError(400, 'INVALID_ID', `${name} must be a UUID.`));
    }
    return next();
  };
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

async function requireProcessingCommandAccess(req, res, next) {
  try {
    if (!(await canAccessProcessingFacility(req.auth, req.body.processingFacilityId, { write: true }))) {
      return next(new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.'));
    }
    const sourceIds = req.body.inputs.map((row) => row.sourceProductionOutputId);
    const sources = await sequelize.query(
      `SELECT peo.material_event_output_id AS output_id, h.site_id, h.id AS hole_id
       FROM production_event_output peo JOIN production_event pe ON pe.event_id=peo.production_event_id
       JOIN mining_hole h ON h.id=pe.hole_id
       WHERE peo.material_event_output_id IN (:sourceIds) AND h.site_id=:siteId`,
      { replacements: { sourceIds, siteId: req.params.siteId }, type: QueryTypes.SELECT },
    );
    if (sources.length !== sourceIds.length) return next(new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.'));
    for (const source of sources) {
      if (!(await canAccessHole(req.auth, req.params.siteId, source.hole_id, { write: true }))) {
        return next(new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.'));
      }
    }
    return next();
  } catch (error) { return next(error); }
}

async function requireProcessingEventAccess(req, res, next) {
  try {
    const rows = await processingEventAccessRows(req.params.eventId);
    const write = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    if (!rows.length || !(await canAccessProcessingFacility(req.auth, rows[0].processing_facility_id, { write }))) {
      return next(new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.'));
    }
    for (const row of rows) {
      if (!(await canAccessHole(req.auth, row.site_id, row.hole_id, { write }))) {
        return next(new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.'));
      }
    }
    return next();
  } catch (error) { return next(error); }
}

export const app = express();
const allowedOrigins = env.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean);
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: allowedOrigins, credentials: false }));
app.use(express.json({ limit: '100kb', strict: true }));
app.use(pinoHttp({ logger, genReqId: (req) => req.get('x-request-id')?.slice(0, 100) || randomUUID(), autoLogging: { ignore: (req) => req.url === '/healthz' }, serializers: { req: (req) => ({ id: req.id, method: req.method, url: req.url }) } }));

app.get('/healthz', asyncRoute(async (req, res) => {
  await sequelize.query('SELECT 1');
  return res.status(200).json({ status: 'ok', database: 'connected', time: new Date().toISOString() });
}));
app.get('/api/v1/health', asyncRoute(async (req, res) => {
  await sequelize.query('SELECT 1');
  return res.status(200).json({ status: 'ok', database: 'connected' });
}));

app.post('/api/v1/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, handler: (req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many sign-in attempts. Try again later.', requestId: req.id } }) }), validateBody(loginSchema), asyncRoute(async (req, res) => {
  const result = await login(req.body.email, req.body.password);
  return res.status(200).json(result);
}));

app.use('/api/v1', authenticate);

app.get('/api/v1/me', asyncRoute(async (req, res) => res.json(await getProfile(req.auth.userId))));

app.post('/api/v1/admin/users', requireSystemAdministrator, requireIdempotencyKey, validateBody(accountSchema), asyncRoute(async (req, res) => {
  const account = await createAccount(req.body, req.auth.userId, req.get('idempotency-key'));
  return res.status(201).json(account);
}));
app.post('/api/v1/admin/organisations', requireSystemAdministrator, requireIdempotencyKey, validateBody(organisationSchema), asyncRoute(async (req, res) => {
  return res.status(201).json(await createOrganisation(req.body, req.auth.userId, req.get('idempotency-key')));
}));
app.post('/api/v1/admin/users/:userId/roles', requireSystemAdministrator, requireUuidParams('userId'), requireIdempotencyKey, validateBody(roleSchema), asyncRoute(async (req, res) => {
  return res.status(201).json(await addRoleAssignment({ userId: req.params.userId, ...req.body }, req.auth.userId, req.get('idempotency-key')));
}));
app.post('/api/v1/admin/role-assignments/:assignmentId/revoke', requireSystemAdministrator, requireUuidParams('assignmentId'), requireIdempotencyKey, asyncRoute(async (req, res) => {
  return res.status(200).json(await revokeRoleAssignment(req.params.assignmentId, req.auth.userId, req.get('idempotency-key')));
}));

app.get('/api/v1/sites', asyncRoute(async (req, res) => res.json(await listSites(req.auth))));
app.post('/api/v1/sites', requirePilotFieldOfficer, requireIdempotencyKey, validateBody(siteSchema), asyncRoute(async (req, res) => {
  return res.status(201).json(await createSite(req.body, req.auth, req.get('idempotency-key')));
}));
app.get('/api/v1/sites/:siteId', requireUuidParams('siteId'), asyncRoute(async (req, res, next) => {
  if (!(await canAccessSite(req.auth, req.params.siteId))) return next(new AppError(403, 'FORBIDDEN', 'You do not have access to this mining site.'));
  return res.json(await getSite(req.params.siteId));
}));
app.patch('/api/v1/sites/:siteId', requireUuidParams('siteId'), requireSiteAccess, requireIdempotencyKey, validateBody(sitePatchSchema), asyncRoute(async (req, res) => {
  return res.json(await updateSite(req.params.siteId, req.body, req.auth, req.get('idempotency-key')));
}));
app.get('/api/v1/sites/:siteId/holes', requireUuidParams('siteId'), asyncRoute(async (req, res) => res.json(await listHoles(req.params.siteId, req.auth))));
app.post('/api/v1/sites/:siteId/holes', requireUuidParams('siteId'), requireSiteAccess, requireIdempotencyKey, validateBody(holeSchema), asyncRoute(async (req, res) => {
  return res.status(201).json(await createHole(req.params.siteId, req.body, req.auth, req.get('idempotency-key')));
}));
app.get('/api/v1/sites/:siteId/holes/:holeId', requireUuidParams('siteId', 'holeId'), requireHoleAccess, asyncRoute(async (req, res) => res.json(await getHole(req.params.siteId, req.params.holeId, req.auth))));
app.get('/api/v1/sites/:siteId/holes/:holeId/participants', requireUuidParams('siteId', 'holeId'), requireHoleAccess, asyncRoute(async (req, res) => res.json(await listHoleParticipants(req.params.siteId, req.params.holeId, req.auth))));
app.get('/api/v1/sites/:siteId/participants', requireUuidParams('siteId'), requireSiteAccess, asyncRoute(async (req, res) => res.json(await listParticipants(req.params.siteId))));
app.post('/api/v1/sites/:siteId/participants', requireUuidParams('siteId'), requireIdempotencyKey, validateBody(participantSchema), requireParticipantWriteAccess, asyncRoute(async (req, res) => {
  return res.status(201).json(await createParticipant(req.params.siteId, req.body, req.auth, req.get('idempotency-key')));
}));
app.get('/api/v1/sites/:siteId/doras', requireUuidParams('siteId'), requireSiteAccess, asyncRoute(async (req, res) => res.json(await listSiteDoras(req.params.siteId))));
app.post('/api/v1/sites/:siteId/doras', requireUuidParams('siteId'), requireSiteAccess, requireIdempotencyKey, validateBody(doraSchema), asyncRoute(async (req, res) => {
  return res.status(201).json(await createDora(req.params.siteId, req.body, req.auth, req.get('idempotency-key')));
}));
app.get('/api/v1/doras/:facilityId', requireUuidParams('facilityId'), requireProcessingFacilityAccess, asyncRoute(async (req, res) => res.json(await getDora(req.params.facilityId))));
app.patch('/api/v1/doras/:facilityId', requireUuidParams('facilityId'), requireProcessingFacilityAccess, requireIdempotencyKey, validateBody(doraPatchSchema), asyncRoute(async (req, res) => {
  return res.json(await updateDora(req.params.facilityId, req.body, req.auth, req.get('idempotency-key')));
}));
app.get('/api/v1/sites/:siteId/production-events', requireUuidParams('siteId'), requireSiteAccess, asyncRoute(async (req, res) => res.json(await listProductionEvents(req.params.siteId))));
app.get('/api/v1/sites/:siteId/production-events/:eventId', requireUuidParams('siteId', 'eventId'), requireProductionEventAccess, asyncRoute(async (req, res) => res.json(await getProductionEvent(req.params.siteId, req.params.eventId))));
app.post('/api/v1/sites/:siteId/production-events', requireUuidParams('siteId'), requireIdempotencyKey, validateBody(productionSchema), requireProductionHoleAccess, asyncRoute(async (req, res) => {
  return res.status(201).json(await createProductionEvent(req.params.siteId, req.body, req.auth, req.get('idempotency-key')));
}));
app.post('/api/v1/sites/:siteId/production-events/:eventId/outputs/:outputId/measurements', requireUuidParams('siteId', 'eventId', 'outputId'), requireProductionEventAccess, requireIdempotencyKey, validateBody(measurementSchema), asyncRoute(async (req, res) => {
  const input = { ...req.body, occurredAt: req.body.occurredAt ?? new Date().toISOString() };
  return res.status(201).json(await addOutputMeasurement(req.params.siteId, req.params.eventId, req.params.outputId, input, req.auth, req.get('idempotency-key')));
}));
app.get('/api/v1/sites/:siteId/production-events/:eventId/outputs/:outputId/allocation-sets', requireUuidParams('siteId', 'eventId', 'outputId'), requireProductionEventAccess, asyncRoute(async (req, res) => {
  return res.json(await getOutputAllocations(req.params.siteId, req.params.eventId, req.params.outputId));
}));
app.post('/api/v1/sites/:siteId/production-events/:eventId/outputs/:outputId/allocation-sets', requireUuidParams('siteId', 'eventId', 'outputId'), requireProductionEventAccess, requireIdempotencyKey, validateBody(allocationSchema), asyncRoute(async (req, res) => {
  return res.status(201).json(await createAllocationSet(req.params.siteId, req.params.eventId, req.params.outputId, req.body, req.auth, req.get('idempotency-key')));
}));
app.post('/api/v1/sites/:siteId/processing-events', requireUuidParams('siteId'), requireIdempotencyKey, validateBody(processingSchema), requireProcessingCommandAccess, asyncRoute(async (req, res) => {
  return res.status(201).json(await createProcessingEvent(req.params.siteId, req.body, req.auth, req.get('idempotency-key')));
}));
app.get('/api/v1/processing-events/:eventId', requireUuidParams('eventId'), requireProcessingEventAccess, asyncRoute(async (req, res) => res.json(await getProcessingEvent(req.params.eventId))));
app.post('/api/v1/processing-events/:eventId/inputs/:inputId/measurements', requireUuidParams('eventId', 'inputId'), requireProcessingEventAccess, requireIdempotencyKey, validateBody(measurementSchema), asyncRoute(async (req, res) => {
  return res.status(201).json(await addProcessingMeasurement(req.params.eventId, 'INPUT', req.params.inputId, { ...req.body, occurredAt: req.body.occurredAt ?? new Date().toISOString() }, req.auth, req.get('idempotency-key')));
}));
app.post('/api/v1/processing-events/:eventId/outputs/:outputId/measurements', requireUuidParams('eventId', 'outputId'), requireProcessingEventAccess, requireIdempotencyKey, validateBody(measurementSchema), asyncRoute(async (req, res) => {
  return res.status(201).json(await addProcessingMeasurement(req.params.eventId, 'OUTPUT', req.params.outputId, { ...req.body, occurredAt: req.body.occurredAt ?? new Date().toISOString() }, req.auth, req.get('idempotency-key')));
}));
app.post('/api/v1/material-batches/:batchId/qr', requireUuidParams('batchId'), requireIdempotencyKey, validateBody(emptySchema), asyncRoute(async (req, res) => {
  return res.status(201).json(await createBatchQr(req.params.batchId, req.auth, req.get('idempotency-key')));
}));
app.post('/api/v1/material-batches/:batchId/qr/rotate', requireUuidParams('batchId'), requireIdempotencyKey, validateBody(emptySchema), asyncRoute(async (req, res) => {
  return res.status(201).json(await rotateBatchQr(req.params.batchId, req.auth, req.get('idempotency-key')));
}));
app.get('/api/v1/qr/:token', asyncRoute(async (req, res) => {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(req.params.token)) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'The requested resource was not found.');
  return res.json(await lookupQr(req.params.token, req.auth));
}));

app.get('/api/v1/doras/:facilityId/stockpiles', requireUuidParams('facilityId'), asyncRoute(async (req, res) => {
  return res.json(await listStockpiles(req.params.facilityId, req.auth));
}));
app.post('/api/v1/doras/:facilityId/stockpiles', requireUuidParams('facilityId'), requireIdempotencyKey, validateBody(stockpileSchema), asyncRoute(async (req, res) => {
  return res.status(201).json(await createStockpile(req.params.facilityId, req.body, req.auth, req.get('idempotency-key')));
}));
app.post('/api/v1/stockpiles/:stockpileId/intake', requireUuidParams('stockpileId'), requireIdempotencyKey, validateBody(stockpileIntakeSchema), asyncRoute(async (req, res) => {
  return res.status(201).json(await receiveDoraResidue(req.params.stockpileId, req.body, req.auth, req.get('idempotency-key')));
}));
app.post('/api/v1/stockpiles/:stockpileId/transfers', requireUuidParams('stockpileId'), requireIdempotencyKey, validateBody(stockpileTransferSchema), asyncRoute(async (req, res) => {
  return res.status(201).json(await transferBetweenStockpiles(req.params.stockpileId, req.body, req.auth, req.get('idempotency-key')));
}));
app.get('/api/v1/inventory/locations/:locationId/balances', requireUuidParams('locationId'), asyncRoute(async (req, res) => {
  return res.json(await listLocationBalances(req.params.locationId, req.auth));
}));
app.post('/api/v1/inventory/locations/:locationId/adjustments', requireUuidParams('locationId'), requireIdempotencyKey, validateBody(adjustmentSchema), asyncRoute(async (req, res) => {
  return res.status(201).json(await adjustInventory(req.params.locationId, req.body, req.auth, req.get('idempotency-key')));
}));

app.post('/api/v1/gold-trades', requireIdempotencyKey, validateBody(goldTradeSchema), asyncRoute(async (req, res) => {
  return res.status(201).json(await createGoldTrade(req.body, req.auth, req.get('idempotency-key')));
}));
app.get('/api/v1/gold-trades/:tradeId', requireUuidParams('tradeId'), asyncRoute(async (req, res) => {
  return res.json(await readGoldTrade(req.params.tradeId, req.auth));
}));
app.post('/api/v1/gold-trades/:tradeId/lines', requireUuidParams('tradeId'), requireIdempotencyKey, validateBody(goldTradeLineSchema), asyncRoute(async (req, res) => {
  return res.status(201).json(await addGoldTradeLine(req.params.tradeId, req.body, req.auth, req.get('idempotency-key')));
}));
app.post('/api/v1/gold-trades/:tradeId/lines/:lineId/measurements', requireUuidParams('tradeId','lineId'), requireIdempotencyKey, validateBody(goldTradeMeasurementSchema), asyncRoute(async (req, res) => {
  return res.status(201).json(await recordGoldTradeMeasurement(req.params.tradeId, req.params.lineId, req.body, req.auth, req.get('idempotency-key')));
}));
app.post('/api/v1/gold-trades/:tradeId/lines/:lineId/assays', requireUuidParams('tradeId','lineId'), requireIdempotencyKey, validateBody(goldTradeAssaySchema), asyncRoute(async (req, res) => {
  return res.status(201).json(await recordGoldTradeAssay(req.params.tradeId, req.params.lineId, req.body, req.auth, req.get('idempotency-key')));
}));
app.post('/api/v1/gold-trades/:tradeId/lines/:lineId/revisions', requireUuidParams('tradeId','lineId'), requireIdempotencyKey, validateBody(goldTradeRevisionSchema), asyncRoute(async (req, res) => {
  return res.status(201).json(await proposeGoldTradeRevision(req.params.tradeId, req.params.lineId, req.body, req.auth, req.get('idempotency-key')));
}));
app.post('/api/v1/gold-trades/:tradeId/lines/:lineId/decisions', requireUuidParams('tradeId','lineId'), requireIdempotencyKey, validateBody(goldTradeDecisionSchema), asyncRoute(async (req, res) => {
  return res.status(201).json(await decideGoldTradeLine(req.params.tradeId, req.params.lineId, req.body, req.auth, req.get('idempotency-key')));
}));
app.post('/api/v1/gold-trades/:tradeId/lines/:lineId/custody-offers', requireUuidParams('tradeId','lineId'), requireIdempotencyKey, validateBody(goldCustodyOfferSchema), asyncRoute(async (req, res) => {
  return res.status(201).json(await createGoldCustodyOffer(req.params.tradeId, req.params.lineId, req.body, req.auth, req.get('idempotency-key')));
}));
app.post('/api/v1/gold-trades/:tradeId/custody-transfers/:transferId/decisions', requireUuidParams('tradeId','transferId'), requireIdempotencyKey, validateBody(custodyDecisionSchema), asyncRoute(async (req, res) => {
  return res.status(200).json(await decideGoldCustodyTransfer(req.params.tradeId, req.params.transferId, req.body, req.auth, req.get('idempotency-key')));
}));
app.post('/api/v1/gold-trades/:tradeId/payments', requireUuidParams('tradeId'), requireIdempotencyKey, validateBody(goldPaymentSchema), asyncRoute(async (req, res) => {
  return res.status(201).json(await recordGoldTradePayment(req.params.tradeId, req.body, req.auth, req.get('idempotency-key')));
}));
app.post('/api/v1/gold-trades/:tradeId/payments/:paymentId/decisions', requireUuidParams('tradeId','paymentId'), requireIdempotencyKey, validateBody(goldPaymentDecisionSchema), asyncRoute(async (req, res) => {
  return res.status(201).json(await decideGoldTradePayment(req.params.tradeId, req.params.paymentId, req.body, req.auth, req.get('idempotency-key')));
}));

app.post('/api/v1/consignments', requireIdempotencyKey, validateBody(consignmentSchema), asyncRoute(async (req, res) => {
  return res.status(201).json(await createConsignment(req.body, req.auth, req.get('idempotency-key')));
}));
app.get('/api/v1/consignments/:consignmentId', requireUuidParams('consignmentId'), asyncRoute(async (req, res) => {
  return res.json(await readConsignment(req.params.consignmentId, req.auth));
}));
app.post('/api/v1/consignments/:consignmentId/dispatch', requireUuidParams('consignmentId'), requireIdempotencyKey, validateBody(dispatchSchema), asyncRoute(async (req, res) => {
  return res.status(200).json(await dispatchConsignment(req.params.consignmentId, req.body, req.auth, req.get('idempotency-key')));
}));
app.post('/api/v1/consignments/:consignmentId/transport-legs', requireUuidParams('consignmentId'), requireIdempotencyKey, validateBody(transportLegSchema), asyncRoute(async (req, res) => {
  return res.status(201).json(await addTransportLeg(req.params.consignmentId, req.body, req.auth, req.get('idempotency-key')));
}));
app.post('/api/v1/consignments/:consignmentId/receipts', requireUuidParams('consignmentId'), requireIdempotencyKey, validateBody(receiptSchema), asyncRoute(async (req, res) => {
  return res.status(201).json(await receiveConsignment(req.params.consignmentId, req.body, req.auth, req.get('idempotency-key')));
}));
app.post('/api/v1/consignments/:consignmentId/receipt-items/:receiptItemId/corrections', requireUuidParams('consignmentId', 'receiptItemId'), requireIdempotencyKey, validateBody(receiptCorrectionSchema), asyncRoute(async (req, res) => {
  return res.status(201).json(await correctConsignmentReceiptItem(req.params.consignmentId, req.params.receiptItemId, req.body, req.auth, req.get('idempotency-key')));
}));
app.post('/api/v1/consignments/:consignmentId/custody-offers', requireUuidParams('consignmentId'), requireIdempotencyKey, validateBody(custodyOfferSchema), asyncRoute(async (req, res) => {
  return res.status(201).json(await createCustodyOffer(req.params.consignmentId, req.body, req.auth, req.get('idempotency-key')));
}));
app.post('/api/v1/custody-transfers/:transferId/decisions', requireUuidParams('transferId'), requireIdempotencyKey, validateBody(custodyDecisionSchema), asyncRoute(async (req, res) => {
  return res.status(200).json(await decideCustodyTransfer(req.params.transferId, req.body, req.auth, req.get('idempotency-key')));
}));

app.post('/api/v1/residue-sales', requireIdempotencyKey, validateBody(residueSaleSchema), asyncRoute(async (req, res) => {
  return res.status(201).json(await createResidueSale(req.body, req.auth, req.get('idempotency-key')));
}));
app.get('/api/v1/residue-sales/:saleId', requireUuidParams('saleId'), asyncRoute(async (req, res) => {
  return res.json(await readResidueSale(req.params.saleId, req.auth));
}));
app.post('/api/v1/residue-sales/:saleId/lines/:lineId/revisions', requireUuidParams('saleId', 'lineId'), requireIdempotencyKey, validateBody(residueSaleRevisionSchema), asyncRoute(async (req, res) => {
  return res.status(201).json(await proposeResidueSaleLineRevision(req.params.saleId, req.params.lineId, req.body, req.auth, req.get('idempotency-key')));
}));
app.post('/api/v1/residue-sales/:saleId/lines/:lineId/decisions', requireUuidParams('saleId', 'lineId'), requireIdempotencyKey, validateBody(residueSaleDecisionSchema), asyncRoute(async (req, res) => {
  return res.status(201).json(await decideResidueSaleLine(req.params.saleId, req.params.lineId, req.body, req.auth, req.get('idempotency-key')));
}));

app.post('/api/v1/recovery-facilities/:facilityId/inventory-locations', requireUuidParams('facilityId'), requireIdempotencyKey, validateBody(recoveryLocationSchema), asyncRoute(async (req, res) => {
  return res.status(201).json(await createRecoveryInventoryLocation(req.params.facilityId, req.body, req.auth, req.get('idempotency-key')));
}));
app.post('/api/v1/recovery-facilities/:facilityId/recovery-events', requireUuidParams('facilityId'), requireIdempotencyKey, validateBody(recoveryEventSchema), asyncRoute(async (req, res) => {
  return res.status(201).json(await createRecoveryEvent(req.params.facilityId, req.body, req.auth, req.get('idempotency-key')));
}));
app.get('/api/v1/recovery-events/:eventId', requireUuidParams('eventId'), asyncRoute(async (req, res) => {
  return res.json(await readRecoveryEvent(req.params.eventId, req.auth));
}));

app.use((req, res, next) => next(new AppError(404, 'NOT_FOUND', 'The requested endpoint was not found.')));
app.use(errorHandler);

