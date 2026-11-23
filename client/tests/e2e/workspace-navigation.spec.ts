import { expect, test } from '@playwright/test';

const userId = 'a1111111-1111-4111-8111-111111111111';
const personPartyId = 'a2222222-2222-4222-8222-222222222222';
const siteId = 'a3333333-3333-4333-8333-333333333333';
const holeId = 'a4444444-4444-4444-8444-444444444444';
const facilityId = 'a5555555-5555-4555-8555-555555555555';
const organisationId = 'a6666666-6666-4666-8666-666666666666';
const token = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.test`;

const roleScopes: Record<string, { scope_kind: string; scope_id: string }> = {
  SYSTEM_ADMIN: { scope_kind: 'GLOBAL', scope_id: 'global' },
  FIELD_OFFICER: { scope_kind: 'PILOT', scope_id: 'default' },
  MINING_OPERATOR: { scope_kind: 'SITE', scope_id: siteId },
  MINER: { scope_kind: 'HOLE', scope_id: holeId },
  DORA_OPERATOR: { scope_kind: 'FACILITY', scope_id: facilityId },
  RECOVERY_FACILITY_OPERATOR: { scope_kind: 'FACILITY', scope_id: facilityId },
  LOCAL_MERCHANT: { scope_kind: 'ORGANISATION', scope_id: organisationId },
  LARGER_MERCHANT: { scope_kind: 'ORGANISATION', scope_id: organisationId },
  AUDITOR: { scope_kind: 'SITE', scope_id: siteId },
};

const expectedNavigation: Record<string, string[]> = {
  SYSTEM_ADMIN: ['Overview', 'Access administration', 'My command queue'],
  FIELD_OFFICER: ['Overview', 'Material operations', 'Production', 'Registry', 'Field capture', 'Measurements & assays', 'Gold trades', 'Payments', 'Traceability', 'Reports', 'My command queue', 'Audit evidence'],
  MINING_OPERATOR: ['Overview', 'Material operations', 'Production', 'Registry', 'Field capture', 'Measurements & assays', 'Gold trades', 'Payments', 'Traceability', 'Reports', 'My command queue', 'Audit evidence'],
  MINER: ['Overview', 'Material operations', 'Field capture', 'Measurements & assays', 'Gold trades', 'Payments', 'Traceability', 'Reports', 'My command queue', 'Audit evidence'],
  DORA_OPERATOR: ['Overview', 'Material operations', 'Field capture', 'Measurements & assays', 'Gold trades', 'Payments', 'Traceability', 'Reports', 'My command queue', 'Audit evidence'],
  RECOVERY_FACILITY_OPERATOR: ['Overview', 'Material operations', 'Field capture', 'Measurements & assays', 'Gold trades', 'Payments', 'Traceability', 'Reports', 'My command queue', 'Audit evidence'],
  LOCAL_MERCHANT: ['Overview', 'Field capture', 'Measurements & assays', 'Gold trades', 'Payments', 'Traceability', 'Reports', 'My command queue', 'Audit evidence'],
  LARGER_MERCHANT: ['Overview', 'Field capture', 'Measurements & assays', 'Gold trades', 'Payments', 'Traceability', 'Reports', 'My command queue', 'Audit evidence'],
  AUDITOR: ['Overview', 'Material operations', 'Production', 'Registry', 'Measurements & assays', 'Gold trades', 'Payments', 'Traceability', 'Reports', 'My command queue', 'Audit evidence'],
};

const rolesWithSiteRead: string[] = ['FIELD_OFFICER', 'MINING_OPERATOR', 'AUDITOR'];

async function mockRoleSession(page: import('@playwright/test').Page, roleCode: string, roles = [roleCode]) {
  const grants = roles.map((code) => ({ role_code: code, ...roleScopes[code] }));
  await page.route('**/api/v1/auth/login', (route) => route.fulfill({ json: {
    token,
    user: { id: userId, personPartyId, displayName: `Fictional ${roleCode}` },
    roles: grants,
  } }));
  await page.route('**/api/v1/me', (route) => route.fulfill({ json: {
    id: userId, person_party_id: personPartyId, display_name: `Fictional ${roleCode}`, roles: grants,
  } }));
  await page.route('**/api/v1/sites', (route) => {
    expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
    return route.fulfill({ json: rolesWithSiteRead.includes(roleCode) ? [{ id: siteId, siteCode: 'DEMO-01', name: 'Fictional Demo Site' }] : [] });
  });
}

for (const roleCode of Object.keys(expectedNavigation)) {
  test(`${roleCode} sees only implemented workspace destinations`, async ({ page }) => {
    await mockRoleSession(page, roleCode);
    await page.goto('/');
    await page.getByLabel('Email').fill('fictional@example.test');
    await page.getByLabel('Password').fill('fictional-test-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('heading', { name: `Good day, Fictional ${roleCode}` })).toBeVisible();
    const navigation = page.getByRole('navigation', { name: 'Workspace navigation' });
    const visible = await navigation.getByRole('button').allTextContents();
    expect(visible.map((label) => label.trim())).toEqual(expectedNavigation[roleCode]);
    await expect(page.getByLabel('Acting role and scope', { exact: true })).toContainText(roleCode.replaceAll('_', ' '));
    await expect(page.getByRole('banner').getByLabel(new RegExp(`Current acting role and scope: ${roleCode.replaceAll('_', ' ')}`))).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Site references' })).toBeVisible();
    if (rolesWithSiteRead.includes(roleCode)) await expect(page.getByText('Fictional Demo Site')).toBeVisible();
    else await expect(page.getByText('The authenticated API returned no site references for this account.')).toBeVisible();

    if (roleCode === 'FIELD_OFFICER') {
      await page.screenshot({ path: 'test-results/stage-7a-field-officer-overview.png', fullPage: true });
    }
  });
}

test('switching the acting grant updates available navigation and preserves server-managed scope', async ({ page }) => {
  await mockRoleSession(page, 'FIELD_OFFICER', ['FIELD_OFFICER', 'AUDITOR']);
  await page.goto('/');
  await page.getByLabel('Email').fill('fictional@example.test');
  await page.getByLabel('Password').fill('fictional-test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();

  const navigation = page.getByRole('navigation', { name: 'Workspace navigation' });
  await expect(navigation.getByRole('button', { name: 'Field capture' })).toBeVisible();
  await expect(navigation.getByRole('button', { name: 'Registry' })).toBeVisible();
  await navigation.getByRole('button', { name: 'Field capture' }).click();
  await expect(page.getByRole('heading', { name: 'Capture field information' })).toBeVisible();
  await page.getByLabel('Acting role and scope', { exact: true }).selectOption(`AUDITOR:SITE:${siteId}`);
  await expect(navigation.getByRole('button', { name: 'Field capture' })).toHaveCount(0);
  await expect(navigation.getByRole('button', { name: 'Registry' })).toBeVisible();
  await expect(navigation.getByRole('button', { name: 'Audit evidence' })).toBeVisible();
  await expect(page.getByLabel('Acting role and scope', { exact: true })).toContainText('AUDITOR');
  await expect(page.getByRole('banner').getByLabel(/Current acting role and scope: AUDITOR/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Good day, Fictional FIELD_OFFICER' })).toBeVisible();
});

test('fictional UI fixtures are repeatable and isolated to each browser context', async ({ browser }) => {
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const firstPage = await firstContext.newPage();
  const secondPage = await secondContext.newPage();
  try {
    await mockRoleSession(firstPage, 'FIELD_OFFICER');
    await firstPage.goto('/');
    await firstPage.getByLabel('Email').fill('fictional@example.test');
    await firstPage.getByLabel('Password').fill('fictional-test-password');
    await firstPage.getByRole('button', { name: 'Sign in' }).click();
    await expect(firstPage.getByText('Fictional Demo Site')).toBeVisible();
    const firstToken = await firstPage.evaluate(() => sessionStorage.getItem('minaledger.accessToken'));
    expect(firstToken).toBe(token);

    await secondPage.goto('/');
    await expect(secondPage.getByLabel('Email')).toBeVisible();
    expect(await secondPage.evaluate(() => sessionStorage.getItem('minaledger.accessToken'))).toBeNull();
    expect(await secondPage.evaluate(() => indexedDB.databases())).toEqual([]);

    await firstPage.reload();
    await expect(firstPage.getByText('Fictional Demo Site')).toBeVisible();
    expect(await firstPage.evaluate(() => sessionStorage.getItem('minaledger.accessToken'))).toBe(token);
  } finally {
    await firstContext.close();
    await secondContext.close();
  }
});

test('field workspace adapts to a narrow mobile viewport without page-level horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockRoleSession(page, 'FIELD_OFFICER');
  await page.goto('/');
  await page.getByLabel('Email').fill('fictional@example.test');
  await page.getByLabel('Password').fill('fictional-test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Fictional Demo Site')).toBeVisible();
  await expect(page.getByRole('banner').getByText('Fictional FIELD_OFFICER', { exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Field capture' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'test-results/stage-7a-field-officer-mobile.png', fullPage: true });
});
