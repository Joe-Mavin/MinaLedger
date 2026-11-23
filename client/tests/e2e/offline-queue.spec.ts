import { expect, test } from '@playwright/test';

const userId = '11111111-1111-4111-8111-111111111111';
const partyId = '22222222-2222-4222-8222-222222222222';
const siteId = '33333333-3333-4333-8333-333333333333';
const holeId = '44444444-4444-4444-8444-444444444444';
const relationshipId = '66666666-6666-4666-8666-666666666666';
const participantPartyId = '55555555-5555-4555-8555-555555555555';
const productionEventId = '77777777-7777-4777-8777-777777777777';
const outputId = '88888888-8888-4888-8888-888888888888';
const captureId = '99999999-9999-4999-8999-999999999999';
const offlineBatchId = 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const validToken = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.test`;

test('session token stays tab-scoped and offline commands survive reload with their server state', async ({ page, context }) => {
  const submitted: Array<Record<string, unknown>> = [];
  const receiptLookups: string[] = [];
  let lostResponseMutationId: string | undefined;
  const offlineCommand = { mutationId: undefined as string | undefined };
  await page.route('**/api/v1/auth/login', (route) => route.fulfill({ json: {
    token: validToken,
    user: { id: userId, personPartyId: partyId, displayName: 'Fictional Recorder' },
    roles: [{ role_code: 'FIELD_OFFICER', scope_kind: 'SITE', scope_id: siteId }],
  } }));
  await page.route('**/api/v1/me', (route) => route.fulfill({ json: {
    id: userId, person_party_id: partyId, display_name: 'Fictional Recorder',
    roles: [{ role_code: 'FIELD_OFFICER', scope_kind: 'SITE', scope_id: siteId }],
  } }));
  await page.route('**/api/v1/sites', (route) => route.fulfill({ json: [{ id: siteId, siteCode: 'TEST-01', name: 'Fictional Site' }] }));
  await page.route(`**/api/v1/sites/${siteId}/holes`, (route) => route.fulfill({ json: [{ id: holeId, siteId, holeCode: 'H-01' }] }));
  await page.route(`**/api/v1/sites/${siteId}/holes/${holeId}/participants`, (route) => route.fulfill({ json: [{
    party_id: participantPartyId, display_name: 'Fictional Participant', relationship_id: relationshipId, role_code: 'MINER',
  }] }));
  await page.route(`**/api/v1/sites/${siteId}/production-events/${productionEventId}`, (route) => route.fulfill({ json: {
    id: productionEventId, siteId, hole_id: holeId, auditSequence: 5,
    participants: [{ party_id: participantPartyId, role_code: 'MINER', relationship_id: relationshipId, relationship_kind: 'HOLE' }],
    captureProvenance: {
      id: captureId, actual_participant_party_id: participantPartyId, participant_identity_state: 'IDENTIFIED',
      source_kind: 'PAPER_TRANSCRIPTION', occurred_at_claimed: new Date().toISOString(), entered_at: new Date().toISOString(),
      source_reference: 'paper-book-17', evidence_ref: null,
    },
    outputs: [{ id: outputId, batch_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', batch_code: 'B-1', material_kind: 'GOLD_BEARING_FEED', measurement_set_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', measurements: [] }],
  } }));
  await page.route('**/api/v1/sync/versions', async (route) => {
    const envelope = route.request().postDataJSON() as { commandType: string; payload: { eventId?: string } };
    await route.fulfill({ json: { expectedVersion: {
      streamKind: 'material_event', streamId: envelope.payload.eventId ?? productionEventId, sequence: 5,
    } } });
  });
  await page.route('**/api/v1/sync/commands', async (route) => {
    const envelope = route.request().postDataJSON() as Record<string, unknown>;
    submitted.push(envelope);
    if (envelope.clientMutationId === offlineCommand.mutationId) {
      lostResponseMutationId = String(envelope.clientMutationId);
      await route.abort();
      return;
    }
    await route.fulfill({ status: 202, json: { receipt: {
      clientMutationId: envelope.clientMutationId,
      status: envelope.commandType === 'production.create' ? 'needs_review' : 'server_accepted',
      receivedAt: new Date().toISOString(), resolvedAt: new Date().toISOString(),
      response: { id: envelope.commandType === 'production.create' ? productionEventId : 'measurement-1' }, error: null,
    } } });
  });
  await page.route('**/api/v1/sync/receipts/**', (route) => {
    const mutationId = route.request().url().split('/').at(-1) ?? '';
    receiptLookups.push(mutationId);
    if (lostResponseMutationId && route.request().url().endsWith(lostResponseMutationId)) {
      return route.fulfill({ status: 200, json: { receipt: {
        clientMutationId: lostResponseMutationId, status: 'server_accepted', receivedAt: new Date().toISOString(),
        resolvedAt: new Date().toISOString(), response: { id: 'event-2', batchId: offlineBatchId }, error: null,
      } } });
    }
    return route.fulfill({ status: 404, json: { error: { message: 'Not found' } } });
  });
  await page.route((url) => url.pathname === '/api/v1/material-batches' && url.searchParams.has('query'), (route) => route.fulfill({ json: [
    { id: offlineBatchId, batch_code: 'OFFLINE-BATCH-02', material_kind: 'GOLD_BEARING_FEED', current_status: 'RECORDED', qr_status: null },
  ] }));
  await page.route(`**/api/v1/material-batches/${offlineBatchId}/traceability`, (route) => route.fulfill({ json: {
    batch: { id: offlineBatchId, batch_code: 'OFFLINE-BATCH-02', material_kind: 'GOLD_BEARING_FEED', current_status: 'RECORDED' }, qr: null,
    relatedBatches: [{ id: offlineBatchId, batch_code: 'OFFLINE-BATCH-02', material_kind: 'GOLD_BEARING_FEED', current_status: 'RECORDED' }],
    productionEvents: [], processingEvents: [], inventoryMovements: [], consignments: [], recoveryEvents: [], residueSales: [], goldTrades: [],
    limitations: { pooledAttribution: 'Pooled recovery outputs remain aggregate.', tradeLookup: 'Trades require party access.' },
  } }));

  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.getByLabel('Email').fill('recorder@example.test');
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Field capture' }).click();
  await page.getByLabel('Assigned site').selectOption(siteId);
  await page.getByLabel('Assigned hole').selectOption(holeId);
  await page.getByLabel('Actual participant identity').selectOption('IDENTIFIED');
  await page.getByLabel('Linked hole participant').selectOption(relationshipId);
  await page.getByLabel('Information source').selectOption('PAPER_TRANSCRIPTION');
  await page.getByLabel('Source reference').fill('paper-book-17');
  await page.getByRole('button', { name: 'Save and sync' }).click();
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'My command queue' }).click();
  await expect(page.getByText('Received; review required')).toBeVisible();
  expect(submitted).toHaveLength(1);
  expect(submitted[0]?.commandType).toBe('production.create');
  expect(submitted[0]?.clientMutationId).toMatch(/^[0-9a-f-]{36}$/i);
  expect((submitted[0]?.payload as { input: { participantRelationshipIds: string[] } }).input.participantRelationshipIds).toEqual([relationshipId]);
  expect(await page.evaluate(() => localStorage.getItem('minaledger.accessToken'))).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem('minaledger.accessToken'))).toBe(validToken);

  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Field capture' }).click();
  await page.getByLabel('Command type').selectOption('production.measurement.add');
  await page.getByLabel('Production event ID').fill(productionEventId);
  await page.getByRole('button', { name: 'Load event and participant context' }).click();
  await expect(page.getByText(new RegExp(`Event ${productionEventId}`))).toBeVisible();
  await page.getByLabel('Production event output').selectOption(outputId);
  await page.getByLabel('Actual participant on event').selectOption(participantPartyId);
  await page.getByLabel('Quantity in grams').fill('2.500000');
  await page.getByLabel('Source value').fill('2.5');
  await page.getByRole('button', { name: 'Save and sync' }).click();
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'My command queue' }).click();
  await expect(page.getByText('Accepted by server')).toBeVisible();
  expect(submitted).toHaveLength(2);
  expect(submitted[1]?.commandType).toBe('production.measurement.add');
  expect(submitted[1]?.actualParticipant).toEqual({ identityState: 'IDENTIFIED', partyId: participantPartyId });
  expect(submitted[1]?.captureProvenance).toMatchObject({ id: captureId, actual_participant_party_id: participantPartyId, source_kind: 'PAPER_TRANSCRIPTION' });
  expect(submitted[1]?.expectedVersion).toEqual({ streamKind: 'material_event', streamId: productionEventId, sequence: 5 });
  expect(submitted[1]?.payload).toMatchObject({ eventId: productionEventId, outputId });

  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Field capture' }).click();
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText('Offline', { exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'My command queue' }).click();
  await expect(page.getByText('Received; review required')).toBeVisible();
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Field capture' }).click();
  await expect(page.getByText(/paper-book-17/)).toHaveCount(0);
  await expect(page.getByLabel('Assigned site')).toHaveValue(siteId);
  await page.getByLabel('Actual participant identity').selectOption('UNKNOWN');
  await page.getByLabel('Source reference').fill('offline-notebook-2');
  await page.getByRole('button', { name: 'Save to offline queue' }).click();
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'My command queue' }).click();
  const queuedOfflineCommand = page.locator('.queue-item').filter({ has: page.getByText('Waiting to upload', { exact: true }) });
  await expect(queuedOfflineCommand).toHaveCount(1);
  offlineCommand.mutationId = await queuedOfflineCommand.locator('code').textContent() ?? undefined;
  expect(offlineCommand.mutationId).toMatch(/^[0-9a-f-]{36}$/i);
  expect(submitted).toHaveLength(2);
  const cachedApiResponse = await page.evaluate(async () => Boolean(await caches.match('/api/v1/sites')));
  expect(cachedApiResponse).toBe(false);
  await context.setOffline(false);
  const offlineCommandRow = page.locator('.queue-item').filter({ has: page.getByText(offlineCommand.mutationId!, { exact: true }) });
  await expect(offlineCommandRow.getByText('Accepted by server', { exact: true })).toBeVisible();
  await expect.poll(() => submitted.filter((envelope) => envelope.clientMutationId === offlineCommand.mutationId)).toHaveLength(1);
  expect(submitted).toHaveLength(3);
  expect(submitted[2]?.clientMutationId).toBe(offlineCommand.mutationId);
  expect(lostResponseMutationId).toBe(offlineCommand.mutationId);
  expect(receiptLookups).toEqual([offlineCommand.mutationId]);

  const localState = await page.evaluate(async (mutationId) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('minaledger-field-v1', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<{ command: { envelope: { clientMutationId: string }; state: string }; receipt: { clientMutationId: string; status: string } }>((resolve, reject) => {
        const transaction = database.transaction(['commands', 'receipts'], 'readonly');
        const commandRequest = transaction.objectStore('commands').get(mutationId);
        const receiptRequest = transaction.objectStore('receipts').get(mutationId);
        transaction.oncomplete = () => resolve({ command: commandRequest.result, receipt: receiptRequest.result });
        transaction.onerror = () => reject(transaction.error);
      });
    } finally { database.close(); }
  }, offlineCommand.mutationId!);
  expect(localState.command).toMatchObject({ envelope: { clientMutationId: offlineCommand.mutationId }, state: 'server_accepted' });
  expect(localState.receipt).toMatchObject({ clientMutationId: offlineCommand.mutationId, status: 'server_accepted' });
  await expect(offlineCommandRow.getByText(`Related material batch ${offlineBatchId}`)).toBeVisible();
  await offlineCommandRow.getByRole('button', { name: 'Open related batch' }).click();
  await expect(page.getByRole('heading', { name: 'OFFLINE-BATCH-02' })).toBeVisible();
});

test('audit checkpoint UI distinguishes database acceptance from a live unanchored-tail verification', async ({ page }) => {
  const checkpointId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let getCount = 0;
  let created = false;
  await page.route('**/api/v1/auth/login', (route) => route.fulfill({ json: {
    token: validToken,
    user: { id: userId, personPartyId: partyId, displayName: 'Fictional Recorder' },
    roles: [{ role_code: 'FIELD_OFFICER', scope_kind: 'SITE', scope_id: siteId }],
  } }));
  await page.route('**/api/v1/me', (route) => route.fulfill({ json: {
    id: userId, person_party_id: partyId, display_name: 'Fictional Recorder',
    roles: [{ role_code: 'FIELD_OFFICER', scope_kind: 'SITE', scope_id: siteId }],
  } }));
  await page.route('**/api/v1/sites', (route) => route.fulfill({ json: [{ id: siteId, siteCode: 'TEST-01', name: 'Fictional Site' }] }));
  await page.route(`**/api/v1/sites/${siteId}/holes`, (route) => route.fulfill({ json: [{ id: holeId, siteId, holeCode: 'H-01' }] }));
  await page.route('**/api/v1/audit/streams', (route) => route.fulfill({ json: [{ streamKind: 'mining_site', streamId: siteId, sequence: 7, headHash: 'cd'.repeat(32), updatedAt: new Date().toISOString() }] }));
  await page.route('**/api/v1/audit/checkpoints', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: created ? [{ id: checkpointId, createdAt: new Date().toISOString(), manifestHash: 'ab'.repeat(32), status: 'VERIFIED', attemptCount: 1, streamCount: 1 }] : [] });
    const body = route.request().postDataJSON() as { clientMutationId: string; streams: Array<{ streamKind: string; streamId: string }> };
    expect(route.request().headers()['idempotency-key']).toBe(body.clientMutationId);
    expect(body.streams).toEqual([{ streamKind: 'mining_site', streamId: siteId }]);
    created = true;
    await route.fulfill({ status: 202, json: {
      checkpoint: { id: checkpointId, createdAt: new Date().toISOString(), createdByUserId: userId, manifestHash: 'ab'.repeat(32), streams: [{ streamKind: 'mining_site', streamId: siteId, sequence: 7, headHash: 'cd'.repeat(32) }] },
      databaseState: 'ACCEPTED',
      processing: { status: 'PENDING', attemptCount: 0, verification: null, attempts: [] },
      liveVerification: { checkpointStatus: 'VERIFIED', manifestStatus: 'VALID', streams: [{ streamKind: 'mining_site', streamId: siteId, coveredSequence: 7, currentSequence: 7, currentHeadStatus: 'CONSISTENT', checkpointStatus: 'VERIFIED', tailStatus: 'NONE', tailEntries: 0 }] },
      externalCommitment: 'NOT_IMPLEMENTED',
    } });
  });
  await page.route(`**/api/v1/audit/checkpoints/${checkpointId}`, async (route) => {
    getCount += 1;
    await route.fulfill({ status: 200, json: {
      checkpoint: { id: checkpointId, createdAt: new Date().toISOString(), createdByUserId: userId, manifestHash: 'ab'.repeat(32), streams: [{ streamKind: 'mining_site', streamId: siteId, sequence: 7, headHash: 'cd'.repeat(32) }] },
      databaseState: 'ACCEPTED',
      processing: { status: 'VERIFIED', attemptCount: 1, verification: { checkpointStatus: 'VERIFIED', manifestStatus: 'VALID', streams: [{ streamKind: 'mining_site', streamId: siteId, coveredSequence: 7, currentSequence: 8, currentHeadStatus: 'CONSISTENT', tailStatus: 'UNANCHORED', tailEntries: 1 }] }, attempts: [{ attempt_number: 1, outcome: 'VERIFIED', started_at: new Date().toISOString(), completed_at: new Date().toISOString() }] },
      liveVerification: { checkpointStatus: 'VERIFIED', manifestStatus: 'VALID', streams: [{ streamKind: 'mining_site', streamId: siteId, coveredSequence: 7, currentSequence: 8, currentHeadStatus: 'CONSISTENT', checkpointStatus: 'VERIFIED', tailStatus: 'UNANCHORED', tailEntries: 1 }] },
      externalCommitment: 'NOT_IMPLEMENTED',
    } });
  });

  await page.goto('/');
  await page.getByLabel('Email').fill('recorder@example.test');
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Audit evidence' }).click();
  await expect(page.getByLabel('Authorized audit stream')).toContainText(siteId);
  await page.getByRole('button', { name: 'Add stream to checkpoint' }).click();
  await page.getByRole('button', { name: 'Create checkpoint' }).click();
  await page.getByRole('button', { name: 'Open and verify' }).click();
  await expect(page.getByText('ACCEPTED', { exact: true })).toBeVisible();
  await expect(page.getByText(/VERIFIED.*VALID/)).toBeVisible();
  await expect(page.getByText(/Covered sequence 7; current sequence 8/)).toBeVisible();
  await expect(page.getByText(/unanchored tail UNANCHORED \(1 record\(s\)\)/i)).toBeVisible();
  await expect(page.getByText(/there is no external independent commitment/i)).toBeVisible();
  expect(getCount).toBeGreaterThan(0);
});
