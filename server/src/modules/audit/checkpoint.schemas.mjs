import { z } from 'zod';

export const checkpointStreamKinds = [
  'mining_site', 'mining_hole', 'material_event', 'processing_facility',
  'recovery_facility', 'gold_trade', 'consignment',
];

export const createAuditCheckpointSchema = z.object({
  clientMutationId: z.string().uuid(),
  streams: z.array(z.object({
    streamKind: z.enum(checkpointStreamKinds),
    streamId: z.string().uuid(),
  }).strict()).min(1).max(50),
}).strict().superRefine((value, context) => {
  const seen = new Set();
  value.streams.forEach((stream, index) => {
    const key = `${stream.streamKind}:${stream.streamId}`;
    if (seen.has(key)) context.addIssue({ code: 'custom', path: ['streams', index], message: 'A stream may appear only once in a checkpoint.' });
    seen.add(key);
  });
});
