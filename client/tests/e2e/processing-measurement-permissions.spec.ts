import { expect, test, type Page } from '@playwright/test';

const userId = '71000000-0000-4000-8000-000000000001';
const partyId = '71000000-0000-4000-8000-000000000002';
const facilityId = '71000000-0000-4000-8000-000000000003';
const otherFacilityId = '71000000-0000-4000-8000-000000000004';
const siteA = '71000000-0000-4000-8000-000000000005';
const siteB = '71000000-0000-4000-8000-000000000006';
const holeA = '71000000-0000-4000-8000-000000000007';
const holeB = '71000000-0000-4000-8000-000000000008';
const eventId = '71000000-0000-4000-8000-000000000009';
const inputId = '71000000-0000-4000-8000-000000000010';
const token = `e30.${Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.test`;

type Grant = { role_code: string; scope_kind: string; scope_id: string };

function dora(scopeId = facilityId): Grant {
  return { role_code: 'DORA_OPERATOR', scope_kind: 'FACILITY', scope_id: scopeId };
}

function sourceGrant(scopeKind: string, scopeId: string, roleCode = 'MINING_OPERATOR'): Grant {
  return { role_code: roleCode, scope_kind: scopeKind, scope_id: scopeId };
}

function processingEvent(sourceSiteIds = [siteA], sourceHoleIds = [holeA]) {
  return {
    id: eventId, event_code: 'PROCESS-PERMISSION-01', occurred_at_claimed: '2026-11-20T08:00:00.000Z',
    recorded_at: '2026-11-20T08:10:00.000Z', current_status: 'SUBMITTED',
    processing_facility_id: facilityId, processing_facility_name: 'Fictional Dora', input_count: 1, output_count: 0,
    sourceSiteIds, sourceHoleIds,
  };
}

function processingDetail(sourceSiteIds: string[], sourceHoleIds: string[]) {
  return {
    ...processingEvent(sourceSiteIds, sourceHoleIds),
    inputs: [{ id: inputId, batch_id: '71000000-0000-4000-8000-000000000011', batch_code: 'FEED-01', material_kind: 'GOLD_BEARING_FEED', measurements: [] }],
    outputs: [],
  };
}

async function openProcessingForm(page: Page, grants: Grant[], sites = [siteA], sourceSites = [siteA], sourceHoles = [holeA]) {
  const roles = grants.map((grant) => ({ ...grant }));
  await page.route('**/api/v1/auth/login', (route) => route.fulfill({ json: {
    token, user: { id: userId, personPartyId: partyId, displayName: 'Fictional Measurement Operator' }, roles,
  } }));
  await page.route('**/api/v1/me', (route) => route.fulfill({ json: {
    id: userId, person_party_id: partyId, display_name: 'Fictional Measurement Operator', roles,
  } }));
  await page.route('**/api/v1/sites', (route) => route.fulfill({ json: sites.map((id, index) => ({
    id, siteCode: `TEST-${index + 1}`, name: `Fictional Site ${index + 1}`,
  })) }));
  await page.route('**/api/v1/sites/*/production-events', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/processing-events', (route) => route.fulfill({ json: [processingEvent(sourceSites, sourceHoles)] }));
  await page.route(`**/api/v1/processing-events/${eventId}`, (route) => route.fulfill({ json: processingDetail(sourceSites, sourceHoles) }));

  await page.goto('/');
  await page.getByLabel('Email').fill('measurement-operator@example.test');
  await page.getByLabel('Password').fill('fictional-test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Good day, Fictional Measurement Operator' })).toBeVisible();
  // The app selects a mining role first when available. The server evaluates
  // all active grants, so this also guards against tying the capability to the
  // currently selected display context.
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Measurements & assays' }).click();
  await page.getByRole('tab', { name: 'Processing events' }).click();
  await page.getByRole('button', { name: 'PROCESS-PERMISSION-01' }).click();
  return page.getByRole('form', { name: 'Record measurement for FEED-01' });
}

async function submitMockedMeasurement(page: Page, form: Awaited<ReturnType<typeof openProcessingForm>>, status = 201) {
  let requestCount = 0;
  let body: Record<string, unknown> | null = null;
  await page.route(`**/api/v1/processing-events/${eventId}/inputs/${inputId}/measurements`, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    requestCount += 1;
    body = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status, json: status < 300 ? { id: '71000000-0000-4000-8000-000000000012' } : { error: { code: 'RESOURCE_NOT_FOUND', message: 'The requested resource was not found.' } } });
  });
  await form.getByLabel('Source value').fill('2.5');
  await form.getByRole('button', { name: 'Record observation' }).click();
  await expect.poll(() => requestCount).toBe(1);
  expect(body).toMatchObject({ kind: 'MEASURED', quantityGrams: '2.500000', sourceValue: '2.5', sourceUnit: 'g' });
}

test('UI offers processing measurement for DORA facility plus a matching mining hole grant', async ({ page }) => {
  const form = await openProcessingForm(page, [dora(), sourceGrant('HOLE', holeA)]);
  await expect(form).toBeVisible();
  await submitMockedMeasurement(page, form);
});

test('UI offers processing measurement for DORA facility plus a matching site-scoped write grant', async ({ page }) => {
  const form = await openProcessingForm(page, [dora(), sourceGrant('SITE', siteA)]);
  await expect(form).toBeVisible();
  await submitMockedMeasurement(page, form);
});

test('UI offers processing measurement for DORA facility plus a possible organization-scoped source grant', async ({ page }) => {
  // The mocked UI has no live membership or site_party_role / hole_party_role
  // facts. It proves only that the UI does not hide a possible valid grant;
  // database authorization is enforced by the real server middleware.
  const form = await openProcessingForm(page, [dora(), sourceGrant('ORGANISATION', '71000000-0000-4000-8000-000000000013', 'FIELD_OFFICER')]);
  await expect(form).toBeVisible();
  await submitMockedMeasurement(page, form);
});

test('UI treats an organization-scoped DORA grant as a facility candidate for server validation', async ({ page }) => {
  const form = await openProcessingForm(page, [
    sourceGrant('HOLE', holeA), sourceGrant('ORGANISATION', '71000000-0000-4000-8000-000000000014', 'DORA_OPERATOR'),
  ]);
  await expect(form).toBeVisible();
  await submitMockedMeasurement(page, form);
});

test('UI supports separate hole grants across multiple source sites and holes', async ({ page }) => {
  const form = await openProcessingForm(page, [
    dora(), sourceGrant('HOLE', holeA), sourceGrant('HOLE', holeB, 'FIELD_OFFICER'),
  ], [siteA, siteB], [siteA, siteB], [holeA, holeB]);
  await expect(form).toBeVisible();
  await submitMockedMeasurement(page, form);
});

test('UI keeps processing measurements read-only without a source-hole write grant', async ({ page }) => {
  await openProcessingForm(page, [dora()]);
  await expect(page.getByRole('form', { name: 'Record measurement for FEED-01' })).toHaveCount(0);
  await expect(page.getByText(/account has a DORA facility grant and a possible source-scope write grant/)).toBeVisible();
});

test('UI keeps processing measurements read-only without a facility grant for this event', async ({ page }) => {
  await openProcessingForm(page, [dora(otherFacilityId), sourceGrant('HOLE', holeA)]);
  await expect(page.getByRole('form', { name: 'Record measurement for FEED-01' })).toHaveCount(0);
});

test('Auditor remains read-only even when processing event details are displayed', async ({ page }) => {
  await openProcessingForm(page, [{ role_code: 'AUDITOR', scope_kind: 'FACILITY', scope_id: facilityId }]);
  await expect(page.getByRole('form', { name: 'Record measurement for FEED-01' })).toHaveCount(0);
});

test('displayed candidate action shows server denial when all source-hole grants do not authorize the event', async ({ page }) => {
  const form = await openProcessingForm(page, [dora(), sourceGrant('HOLE', holeA)], [siteA, siteB], [siteA, siteB], [holeA, holeB]);
  await expect(form).toBeVisible();
  // This intercepted 404 validates client rejection handling and is not proof
  // of database-backed authorization. The production middleware checks each
  // source hole and the facility independently for every measurement request.
  await submitMockedMeasurement(page, form, 404);
  await expect(page.getByRole('alert')).toContainText('The server denied this processing measurement.');
  await expect(page.getByRole('alert')).toContainText('The requested resource was not found.');
  await expect(form.getByLabel('Source value')).toHaveValue('2.5');
});
