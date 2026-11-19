import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { webcrypto } from 'node:crypto';
import { clearLocalDatabaseForTests, getDeviceId, listCommands, saveReferenceCache, clearReferenceCache } from '../../src/offline/database';
import { assertSupportedSchemaVersion } from '../../src/offline/commands';
import type { QueuedCommand } from '../../src/offline/types';

const recorderId = '11111111-1111-4111-8111-111111111111';
const mutationId = '22222222-2222-4222-8222-222222222222';
Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });

test('IndexedDB queue persists, prevents duplicate mutation IDs, scopes references and rejects unsupported schemas', async () => {
  await clearLocalDatabaseForTests();
  const now = new Date().toISOString();
  const command: QueuedCommand = {
    envelope: {
      clientMutationId: mutationId, deviceId: '33333333-3333-4333-8333-333333333333', recorderUserId: recorderId,
      actualParticipant: { identityState: 'UNKNOWN' }, actingContext: { partyId: recorderId, roleCode: 'FIELD_OFFICER', scopeKind: 'SITE', scopeId: 'site-1' },
      commandType: 'production.create', schemaVersion: 1, payload: { siteId: 'site-1' }, clientCreatedAt: now,
      clientTimezone: 'Africa/Nairobi', occurredAtClaimed: now, parentCommandIds: [], evidence: [], localState: 'pending_upload',
    },
    state: 'pending_upload', recorderUserId: recorderId, contextKey: 'test-context', createdAt: now, retryCount: 0,
  };
  const { addCommand } = await import('../../src/offline/database');
  await addCommand(command);
  assert.equal((await listCommands(recorderId))[0]?.envelope.clientMutationId, mutationId, 'command remains available after its IndexedDB connection closes');
  await assert.rejects(addCommand(command), (error: unknown) => (error as DOMException).name === 'ConstraintError');
  const deviceOne = await getDeviceId();
  assert.equal(await getDeviceId(), deviceOne, 'device ID is persistent and is not an authentication credential');
  await saveReferenceCache({ key: `sites:${recorderId}`, recorderUserId: recorderId, contextKey: 'assigned-sites', savedAt: now, value: [{ id: 'site-1' }] });
  await clearReferenceCache();
  assert.equal((await listCommands(recorderId)).length, 1, 'logout cache cleanup keeps unsynchronized commands');
  assertSupportedSchemaVersion(1);
  assert.throws(() => assertSupportedSchemaVersion(2), /not supported/);
  await clearLocalDatabaseForTests();
});

test('IndexedDB failure is returned to the caller instead of presenting an unsaved command as queued', async () => {
  await clearLocalDatabaseForTests();
  const saved = globalThis.indexedDB;
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined });
  try {
    const { openFieldDatabase } = await import('../../src/offline/database');
    await assert.rejects(openFieldDatabase(), /does not provide IndexedDB/);
  } finally {
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: saved });
  }
});
