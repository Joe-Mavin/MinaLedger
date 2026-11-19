import { expect, test } from '@playwright/test';

const userId = '11111111-1111-4111-8111-111111111111';
const partyId = '22222222-2222-4222-8222-222222222222';
const siteId = '33333333-3333-4333-8333-333333333333';
const holeId = '44444444-4444-4444-8444-444444444444';
const relationshipId = '66666666-6666-4666-8666-666666666666';
const participantPartyId = '55555555-5555-4555-8555-555555555555';
const validToken = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.test`;

test('session token stays tab-scoped and offline commands survive reload with their server state', async ({ page, context }) => {
  const submitted: Array<Record<string, unknown>> = [];
  let lostResponseMutationId: string | undefined;
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
  await page.route('**/api/v1/sync/commands', async (route) => {
    const envelope = route.request().postDataJSON() as Record<string, unknown>;
    submitted.push(envelope);
    if (submitted.length === 2) {
      lostResponseMutationId = String(envelope.clientMutationId);
      await route.abort();
      return;
    }
    await route.fulfill({ status: 202, json: { receipt: {
      clientMutationId: envelope.clientMutationId, status: 'needs_review', receivedAt: new Date().toISOString(),
      resolvedAt: new Date().toISOString(), response: { id: 'event-1' }, error: null,
    } } });
  });
  await page.route('**/api/v1/sync/receipts/**', (route) => {
    if (lostResponseMutationId && route.request().url().endsWith(lostResponseMutationId)) {
      return route.fulfill({ status: 200, json: { receipt: {
        clientMutationId: lostResponseMutationId, status: 'server_accepted', receivedAt: new Date().toISOString(),
        resolvedAt: new Date().toISOString(), response: { id: 'event-2' }, error: null,
      } } });
    }
    return route.fulfill({ status: 404, json: { error: { message: 'Not found' } } });
  });

  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.getByLabel('Email').fill('recorder@example.test');
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Assigned site').selectOption(siteId);
  await page.getByLabel('Assigned hole').selectOption(holeId);
  await page.getByLabel('Actual participant identity').selectOption('IDENTIFIED');
  await page.getByLabel('Linked hole participant').selectOption(relationshipId);
  await page.getByLabel('Information source').selectOption('PAPER_TRANSCRIPTION');
  await page.getByLabel('Source reference').fill('paper-book-17');
  await page.getByRole('button', { name: 'Save and sync' }).click();
  await expect(page.getByText('Received; review required')).toBeVisible();
  expect(submitted).toHaveLength(1);
  expect(submitted[0]?.commandType).toBe('production.create');
  expect(submitted[0]?.clientMutationId).toMatch(/^[0-9a-f-]{36}$/i);
  expect((submitted[0]?.payload as { input: { participantRelationshipIds: string[] } }).input.participantRelationshipIds).toEqual([relationshipId]);
  expect(await page.evaluate(() => localStorage.getItem('minaledger.accessToken'))).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem('minaledger.accessToken'))).toBe(validToken);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText('Offline', { exact: true })).toBeVisible();
  await expect(page.getByText('Received; review required')).toBeVisible();
  await expect(page.getByText(/paper-book-17/)).toHaveCount(0);
  await expect(page.getByLabel('Assigned site')).toHaveValue(siteId);
  await page.getByLabel('Actual participant identity').selectOption('UNKNOWN');
  await page.getByLabel('Source reference').fill('offline-notebook-2');
  await page.getByRole('button', { name: 'Save to offline queue' }).click();
  await expect(page.getByText('Waiting to upload')).toBeVisible();
  expect(submitted).toHaveLength(1);
  const cachedApiResponse = await page.evaluate(async () => Boolean(await caches.match('/api/v1/sites')));
  expect(cachedApiResponse).toBe(false);
  await context.setOffline(false);
  await expect(page.getByText('Accepted by server')).toBeVisible();
  expect(submitted).toHaveLength(2);
  expect(submitted[1]?.clientMutationId).toBe(lostResponseMutationId);
});
