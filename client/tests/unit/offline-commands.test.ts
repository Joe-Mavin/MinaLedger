import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { webcrypto } from 'node:crypto';
import { clearLocalDatabaseForTests } from '../../src/offline/database';
import { createLinkedRevision } from '../../src/offline/commands';
import type { CommandEnvelope, QueuedCommand } from '../../src/offline/types';

Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });

test('linked corrections get new IDs, retain provenance and resource version, and can be corrected again after rejection', async () => {
  await clearLocalDatabaseForTests();
  const occurredAt = '2026-11-10T08:30:00.000Z';
  const originalEnvelope: CommandEnvelope = {
    clientMutationId: '11111111-1111-4111-8111-111111111111',
    deviceId: '22222222-2222-4222-8222-222222222222', recorderUserId: '33333333-3333-4333-8333-333333333333',
    actualParticipant: { identityState: 'IDENTIFIED', partyId: '44444444-4444-4444-8444-444444444444' },
    actingContext: { partyId: '55555555-5555-4555-8555-555555555555', roleCode: 'FIELD_OFFICER', scopeKind: 'SITE', scopeId: '66666666-6666-4666-8666-666666666666' },
    commandType: 'inventory.adjustment.create', schemaVersion: 1,
    payload: { locationId: '77777777-7777-4777-8777-777777777777', input: { countedQuantityGrams: '2.000000' } },
    clientCreatedAt: occurredAt, clientTimezone: 'Africa/Nairobi', occurredAtClaimed: occurredAt,
    expectedVersion: { streamKind: 'inventory_location', streamId: '77777777-7777-4777-8777-777777777777', sequence: 4 },
    parentCommandIds: [], revisionOf: undefined, captureProvenance: { sourceKind: 'PAPER_TRANSCRIPTION', reference: 'book-4' },
    evidence: [{ reference: 'evidence-1', sha256: 'a'.repeat(64) }], localState: 'pending_upload',
  };
  const originalSnapshot = structuredClone(originalEnvelope);
  const original: QueuedCommand = {
    envelope: originalEnvelope, state: 'conflict', recorderUserId: originalEnvelope.recorderUserId,
    contextKey: 'test', createdAt: occurredAt, retryCount: 0,
  };
  const correction = await createLinkedRevision({
    original, recorderUserId: original.recorderUserId, actingContext: originalEnvelope.actingContext,
    payload: { ...originalEnvelope.payload, correction: 'first correction' },
    expectedVersion: { ...originalEnvelope.expectedVersion!, sequence: 5 },
  });
  assert.notEqual(correction.clientMutationId, originalEnvelope.clientMutationId);
  assert.equal(correction.revisionOf, originalEnvelope.clientMutationId);
  assert.deepEqual(correction.parentCommandIds, [originalEnvelope.clientMutationId]);
  assert.deepEqual(correction.actualParticipant, originalEnvelope.actualParticipant);
  assert.deepEqual(correction.captureProvenance, originalEnvelope.captureProvenance);
  assert.deepEqual(correction.evidence, originalEnvelope.evidence);
  assert.equal(correction.expectedVersion?.sequence, 5);
  assert.deepEqual(originalEnvelope, originalSnapshot, 'the submitted envelope remains immutable');

  const rejectedCorrection: QueuedCommand = { ...original, envelope: correction, state: 'rejected' };
  const repeatedCorrection = await createLinkedRevision({
    original: rejectedCorrection, recorderUserId: original.recorderUserId, actingContext: originalEnvelope.actingContext,
    payload: { ...correction.payload as object, correction: 'second correction' },
    expectedVersion: { ...correction.expectedVersion!, sequence: 6 },
  });
  assert.notEqual(repeatedCorrection.clientMutationId, correction.clientMutationId);
  assert.equal(repeatedCorrection.revisionOf, correction.clientMutationId);
  assert.deepEqual(repeatedCorrection.parentCommandIds, [originalEnvelope.clientMutationId, correction.clientMutationId]);
  await assert.rejects(createLinkedRevision({
    original: { ...original, state: 'server_accepted' }, recorderUserId: original.recorderUserId,
    actingContext: originalEnvelope.actingContext, payload: originalEnvelope.payload,
  }), /Only a conflicted or rejected command can be corrected/);
  await clearLocalDatabaseForTests();
});
