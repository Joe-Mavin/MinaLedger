import { z } from 'zod';

const decimal = (places) => z.string().regex(new RegExp(`^(0|[1-9][0-9]*)(\\.[0-9]{1,${places}})?$`));
const dateTime = z.string().datetime({ offset: true });

export const measurementSchema = z.object({
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

export const newMeasurementSchema = measurementSchema.omit({ supersedesMeasurementId: true });

export const productionSchema = z.object({
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

export const acknowledgementSchema = z.object({
  status: z.enum(['ACKNOWLEDGED', 'PENDING', 'DECLINED', 'DISPUTED', 'NOT_OBTAINED']),
  acknowledgedByPartyId: z.string().uuid().optional(),
  method: z.string().max(80).optional(),
  occurredAt: dateTime.optional(),
  reason: z.string().max(500).optional(),
}).strict().superRefine((value, context) => {
  if (value.status === 'ACKNOWLEDGED' && !value.acknowledgedByPartyId) context.addIssue({ code: 'custom', path: ['acknowledgedByPartyId'], message: 'ACKNOWLEDGED requires the acknowledging party.' });
  if (value.status !== 'ACKNOWLEDGED' && value.acknowledgedByPartyId) context.addIssue({ code: 'custom', path: ['acknowledgedByPartyId'], message: 'Only an ACKNOWLEDGED event names an acknowledging party.' });
});
