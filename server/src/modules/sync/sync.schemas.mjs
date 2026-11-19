import { z } from 'zod';
import { acknowledgementSchema, measurementSchema, productionSchema } from '../production/production.schemas.mjs';

const dateTime = z.string().datetime({ offset: true });
const expectedVersionSchema = z.object({
  streamKind: z.enum(['mining_hole', 'material_event']),
  streamId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
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
    partyId: z.string().uuid(),
    roleCode: z.string().trim().min(1).max(40),
    scopeKind: z.enum(['GLOBAL', 'PILOT', 'ORGANISATION', 'SITE', 'HOLE', 'FACILITY']),
    scopeId: z.string().trim().min(1).max(80),
  }).strict(),
  commandType: z.enum(['production.create', 'production.measurement.add', 'capture.acknowledgement.add']),
  schemaVersion: z.literal(1),
  payload: z.unknown(),
  clientCreatedAt: dateTime,
  clientTimezone: z.string().trim().min(1).max(80),
  occurredAtClaimed: dateTime,
  expectedVersion: expectedVersionSchema.optional(),
  parentCommandIds: z.array(z.string().uuid()).max(50).default([]),
  revisionOf: z.string().uuid().optional(),
  captureProvenance: z.unknown().optional(),
  evidence: z.array(z.object({
    reference: z.string().trim().min(1).max(255),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  }).strict()).max(50).default([]),
  localState: z.enum(['pending_upload', 'uploading']),
}).strict().superRefine((value, context) => {
  if (value.parentCommandIds.includes(value.clientMutationId)) context.addIssue({ code: 'custom', path: ['parentCommandIds'], message: 'A command cannot depend on itself.' });
  if (value.revisionOf && !value.parentCommandIds.includes(value.revisionOf)) context.addIssue({ code: 'custom', path: ['revisionOf'], message: 'A linked revision must include its original command as a parent dependency.' });
});

export function parseCommandPayload(envelope) {
  const payload = z.object({
    siteId: z.string().uuid(),
    input: productionSchema,
  }).strict();
  if (envelope.commandType === 'production.create') return payload.safeParse(envelope.payload);
  if (envelope.commandType === 'production.measurement.add') {
    return z.object({
      siteId: z.string().uuid(), eventId: z.string().uuid(), outputId: z.string().uuid(), input: measurementSchema,
    }).strict().safeParse(envelope.payload);
  }
  return z.object({
    siteId: z.string().uuid(), eventId: z.string().uuid(), captureProvenanceId: z.string().uuid(),
    acknowledgement: acknowledgementSchema,
  }).strict().safeParse(envelope.payload);
}
