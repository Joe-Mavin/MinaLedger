import { expect, test } from '@playwright/test';

const userId = 'b1111111-1111-4111-8111-111111111111';
const personPartyId = 'b2222222-2222-4222-8222-222222222222';
const siteId = 'b3333333-3333-4333-8333-333333333333';
const createdSiteId = 'b4444444-4444-4444-8444-444444444444';
const existingHoleId = 'b5555555-5555-4555-8555-555555555555';
const participantPartyId = 'b6666666-6666-4666-8666-666666666666';
const relationshipId = 'b7777777-7777-4777-8777-777777777777';
const organizationId = 'b8888888-8888-4888-8888-888888888888';
const accountId = 'b9999999-9999-4999-8999-999999999999';
const assignmentId = 'baaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const holeId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const token = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.test`;

interface RegistrySite {
  id: string;
  siteCode: string;
  name: string;
  countyCode: string | null;
  locality: string | null;
  status: string;
}

interface RegistryHole {
  id: string;
  siteId: string;
  holeCode: string;
  name: string;
  status: string;
  auditSequence: number;
}

async function signIn(page: import('@playwright/test').Page, roleCode: string, scopeKind: string, scopeId: string) {
  await page.route('**/api/v1/auth/login', (route) => route.fulfill({ json: {
    token,
    user: { id: userId, personPartyId, displayName: `Fictional ${roleCode}` },
    roles: [{ role_code: roleCode, scope_kind: scopeKind, scope_id: scopeId }],
  } }));
  await page.route('**/api/v1/me', (route) => route.fulfill({ json: {
    id: userId, person_party_id: personPartyId, display_name: `Fictional ${roleCode}`,
    roles: [{ role_code: roleCode, scope_kind: scopeKind, scope_id: scopeId }],
  } }));
  await page.goto('/');
  await page.getByLabel('Email').fill('fictional@example.test');
  await page.getByLabel('Password').fill('fictional-test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: `Good day, Fictional ${roleCode}` })).toBeVisible();
}

test('site, hole and participant registry sends supported create and update requests', async ({ page }) => {
  const sites: RegistrySite[] = [{ id: siteId, siteCode: 'DEMO-01', name: 'Fictional Demo Site', countyCode: 'KE-01', locality: 'Fictional locality', status: 'ACTIVE' }];
  const holes: RegistryHole[] = [{ id: existingHoleId, siteId, holeCode: 'HOLE-A', name: 'Fictional first hole', status: 'ACTIVE', auditSequence: 2 }];
  const participants = [{
    party_id: participantPartyId, party_kind: 'PERSON', display_name: 'Fictional Miner', relationship_id: relationshipId,
    relationship_kind: 'HOLE', role_code: 'MINER', relationship_status: 'ACTIVE', valid_from: '2026-11-01T00:00:00.000Z', valid_to: null,
    source_reference: 'FORM-01', evidence_ref: 'EVIDENCE-01', hole_id: existingHoleId,
    participant_categories: [{ participantKind: 'MINER', status: 'ACTIVE', validFrom: '2026-11-01T00:00:00.000Z', validTo: null }],
  }];
  const createdSiteParticipants: typeof participants = [];
  const requests: Array<{ method: string; path: string; body: Record<string, unknown>; key: string | undefined }> = [];

  await page.route('**/api/v1/sites**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = request.postDataJSON?.() as Record<string, string | undefined> | undefined;
    if (method !== 'GET') {
      requests.push({ method, path, body: body ?? {}, key: request.headers()['idempotency-key'] });
    }
    if (path === '/api/v1/sites' && method === 'GET') return route.fulfill({ json: sites });
    if (path === '/api/v1/sites' && method === 'POST') {
      const created: RegistrySite = { id: createdSiteId, siteCode: 'DEMO-02', name: body?.name ?? '', countyCode: body?.countyCode ?? null, locality: body?.locality ?? null, status: 'ACTIVE' };
      sites.unshift(created);
      return route.fulfill({ status: 201, json: created });
    }
    if (path === `/api/v1/sites/${siteId}` && method === 'GET') return route.fulfill({ json: sites.find((site) => site.id === siteId) });
    if (path === `/api/v1/sites/${createdSiteId}` && method === 'GET') return route.fulfill({ json: sites.find((site) => site.id === createdSiteId) });
    if (path === `/api/v1/sites/${createdSiteId}` && method === 'PATCH') {
      const updated = { ...sites.find((site) => site.id === createdSiteId)!, ...body };
      sites.splice(0, sites.length, ...sites.map((site) => site.id === createdSiteId ? updated : site));
      return route.fulfill({ json: updated });
    }
    if (path === `/api/v1/sites/${siteId}/holes` && method === 'GET') return route.fulfill({ json: holes.filter((hole) => hole.siteId === siteId) });
    if (path === `/api/v1/sites/${createdSiteId}/holes` && method === 'GET') return route.fulfill({ json: holes.filter((hole) => hole.siteId === createdSiteId) });
    if (path === `/api/v1/sites/${createdSiteId}/holes` && method === 'POST') {
      const created: RegistryHole = { id: holeId, siteId: createdSiteId, holeCode: body?.holeCode ?? '', name: body?.name ?? '', status: 'ACTIVE', auditSequence: 1 };
      holes.push(created);
      return route.fulfill({ status: 201, json: created });
    }
    if (path === `/api/v1/sites/${siteId}/participants` && method === 'GET') return route.fulfill({ json: participants });
    if (path === `/api/v1/sites/${createdSiteId}/participants` && method === 'GET') return route.fulfill({ json: createdSiteParticipants });
    if (path === `/api/v1/sites/${createdSiteId}/holes/${holeId}` && method === 'GET') return route.fulfill({ json: holes.find((hole) => hole.id === holeId) });
    if (path === `/api/v1/sites/${createdSiteId}/participants` && method === 'GET') return route.fulfill({ json: participants });
    if (path === `/api/v1/sites/${createdSiteId}/participants` && method === 'POST') {
      const created = {
        partyId: participantPartyId, relationshipId, displayName: String(body?.displayName),
        participantKind: body?.participantKind, roleCode: body?.roleCode, holeId: body?.holeId ?? null,
      };
      createdSiteParticipants.push({
        party_id: participantPartyId, party_kind: body?.partyKind ?? 'PERSON', display_name: body?.displayName ?? '', relationship_id: relationshipId,
        relationship_kind: body?.holeId ? 'HOLE' : 'SITE', role_code: body?.roleCode ?? '', relationship_status: 'ACTIVE',
        valid_from: body?.validFrom ?? '2026-11-20T00:00:00.000Z', valid_to: body?.validTo ?? null,
        source_reference: body?.sourceReference ?? null, evidence_ref: body?.evidenceRef ?? null, hole_id: body?.holeId ?? null,
        participant_categories: [{ participantKind: body?.participantKind ?? '', status: 'ACTIVE', validFrom: body?.validFrom ?? '2026-11-20T00:00:00.000Z', validTo: body?.validTo ?? null }],
      });
      return route.fulfill({ status: 201, json: created });
    }
    return route.fulfill({ status: 404, json: { error: { message: `Unmocked registry request: ${method} ${path}` } } });
  });

  await signIn(page, 'FIELD_OFFICER', 'PILOT', 'default');
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Registry' }).click();
  await expect(page.getByRole('heading', { name: 'Fictional Demo Site' })).toBeVisible();
  await expect(page.getByText('KE-01', { exact: true })).toBeVisible();
  await expect(page.getByText('Fictional Miner')).toBeVisible();
  await page.screenshot({ path: 'test-results/stage-7a-registry-desktop.png', fullPage: true });

  await page.getByRole('button', { name: 'Register site', exact: true }).first().click();
  await page.getByLabel('Site code').fill('DEMO-02');
  await page.getByLabel('Site name').fill('Fictional Newly Registered Site');
  await page.getByLabel('County code, if recorded').fill('KE-02');
  await page.getByLabel('Locality, if recorded').fill('Fictional valley');
  await page.locator('form').filter({ has: page.getByLabel('Site code') }).getByRole('button', { name: 'Register site', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Fictional Newly Registered Site' })).toBeVisible();

  await page.getByRole('button', { name: 'Edit permitted details' }).click();
  await page.getByLabel('Locality', { exact: true }).fill('Updated fictional valley');
  await page.getByRole('button', { name: 'Save details' }).click();
  await expect(page.getByText('Updated fictional valley', { exact: true })).toBeVisible();

  await page.getByLabel('Hole code').fill('HOLE-NEW');
  await page.getByLabel('Name, if used').fill('Fictional new hole');
  await page.getByRole('button', { name: 'Register hole' }).click();
  await expect(page.getByRole('button', { name: /HOLE-NEW/ })).toBeVisible();
  await page.getByRole('button', { name: /HOLE-NEW/ }).click();
  await expect(page.getByRole('heading', { name: 'HOLE-NEW' })).toBeVisible();

  await page.getByRole('button', { name: 'Add participant relationship' }).click();
  await page.getByLabel('Person name').fill('Fictional Registry Miner');
  await page.getByLabel('Participant category').selectOption('MINER');
  await page.getByLabel('Relationship scope').selectOption(`HOLE:${holeId}`);
  await page.getByRole('combobox', { name: 'Hole relationship', exact: true }).selectOption('MINER');
  await page.getByLabel('Source reference').fill('PAPER-REGISTER-02');
  await page.getByLabel('Evidence reference').fill('FICTITIOUS-EVIDENCE-02');
  await page.getByRole('button', { name: 'Save participant relationship' }).click();
  await expect(page.getByText(/Fictional Registry Miner registered as Miner and associated as Miner/)).toBeVisible();
  await expect(page.getByText(/No login account was created by this action/)).toBeVisible();

  expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual(expect.arrayContaining([
    'POST /api/v1/sites', `PATCH /api/v1/sites/${createdSiteId}`, `POST /api/v1/sites/${createdSiteId}/holes`, `POST /api/v1/sites/${createdSiteId}/participants`,
  ]));
  expect(requests.filter(({ method }) => method !== 'GET').every(({ key }) => Boolean(key))).toBe(true);
  const participantRequest = requests.find(({ method, path }) => method === 'POST' && path.endsWith('/participants'));
  expect(participantRequest?.body).toMatchObject({
    partyKind: 'PERSON', displayName: 'Fictional Registry Miner', participantKind: 'MINER', roleCode: 'MINER',
    holeId, sourceReference: 'PAPER-REGISTER-02', evidenceRef: 'FICTITIOUS-EVIDENCE-02',
  });
});

test('system administrator can create an organization and account, assign and revoke a supported scoped role', async ({ page }) => {
  const requests: Array<{ method: string; path: string; body: Record<string, unknown>; key: string | undefined }> = [];
  await page.route('**/api/v1/sites', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/admin/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = request.postDataJSON?.() as Record<string, unknown> | undefined;
    requests.push({ method, path, body: body ?? {}, key: request.headers()['idempotency-key'] });
    if (path === '/api/v1/admin/organisations' && method === 'POST') return route.fulfill({ status: 201, json: { partyId: organizationId, displayName: 'Fictional Session Group', organisationKind: 'TEST_GROUP' } });
    if (path === '/api/v1/admin/users' && method === 'POST') return route.fulfill({ status: 201, json: { id: accountId, personPartyId: personPartyId, email: 'registry-account@example.test', displayName: 'Fictional Registry Account' } });
    if (path === `/api/v1/admin/users/${accountId}/roles` && method === 'POST') return route.fulfill({ status: 201, json: { id: assignmentId, userId: accountId, roleCode: 'LOCAL_MERCHANT', scopeKind: 'ORGANISATION', scopeId: organizationId } });
    if (path === `/api/v1/admin/role-assignments/${assignmentId}/revoke` && method === 'POST') return route.fulfill({ json: { id: assignmentId, status: 'REVOKED' } });
    return route.fulfill({ status: 404, json: { error: { message: `Unmocked admin request: ${method} ${path}` } } });
  });

  await signIn(page, 'SYSTEM_ADMIN', 'GLOBAL', 'global');
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Access administration' }).click();
  await expect(page.getByRole('heading', { name: 'Access administration' })).toBeVisible();
  await page.getByRole('button', { name: 'Organizations' }).click();
  await page.getByLabel('Organization name').fill('Fictional Session Group');
  await page.getByLabel('Organization kind').fill('TEST_GROUP');
  await page.getByRole('button', { name: 'Register organization' }).click();
  await expect(page.getByText('Fictional Session Group', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/stage-7a-access-desktop.png', fullPage: true });

  await page.getByRole('button', { name: 'Accounts and roles' }).click();
  await page.getByLabel('Display name').fill('Fictional Registry Account');
  await page.getByLabel('Email address').fill('registry-account@example.test');
  await page.getByLabel('Initial password').fill('Fictional-Long-Password-123');
  await page.getByLabel('Organization membership, if required').selectOption(organizationId);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Fictional Registry Account' })).toBeVisible();
  const accountCard = page.locator('section.queue-section').filter({ has: page.getByRole('heading', { name: 'Fictional Registry Account' }) });
  await accountCard.getByLabel('System role').selectOption('LOCAL_MERCHANT');
  await expect(accountCard.getByLabel('Authorization scope')).toHaveValue('ORGANISATION');
  await expect(accountCard.getByLabel('Authorized resource')).toHaveValue(organizationId);
  await accountCard.getByRole('button', { name: 'Assign role' }).click();
  const createdGrant = accountCard.locator('.grant-list li').filter({ hasText: 'Local Merchant' });
  await expect(createdGrant).toContainText(/active/i);
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Overview' }).click();
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Access administration' }).click();
  await expect(page.getByRole('heading', { name: 'Fictional Registry Account' })).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await accountCard.getByRole('button', { name: 'Revoke grant' }).click();
  await expect(createdGrant).toContainText(/revoked/i);

  expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual(expect.arrayContaining([
    'POST /api/v1/admin/organisations', 'POST /api/v1/admin/users', `POST /api/v1/admin/users/${accountId}/roles`, `POST /api/v1/admin/role-assignments/${assignmentId}/revoke`,
  ]));
  expect(requests.every(({ key }) => Boolean(key))).toBe(true);
  expect(requests.find(({ path }) => path === '/api/v1/admin/organisations')?.body).toEqual({ displayName: 'Fictional Session Group', organisationKind: 'TEST_GROUP' });
  expect(requests.find(({ path }) => path === '/api/v1/admin/users')?.body).toMatchObject({ email: 'registry-account@example.test', organisationPartyId: organizationId });
  expect(requests.find(({ path }) => path.endsWith('/roles'))?.body).toEqual({ roleCode: 'LOCAL_MERCHANT', scopeKind: 'ORGANISATION', scopeId: organizationId });
});
