import { expect, test } from '@playwright/test';

const userId = '71000000-0000-4000-8000-000000000001';
const partyId = '71000000-0000-4000-8000-000000000002';
const siteId = '71000000-0000-4000-8000-000000000003';
const facilityId = '71000000-0000-4000-8000-000000000004';
const recoveryFacilityId = '71000000-0000-4000-8000-000000000014';
const batchId = '71000000-0000-4000-8000-000000000005';
const holeId = '71000000-0000-4000-8000-000000000013';
const eventA = '71000000-0000-4000-8000-000000000006';
const eventB = '71000000-0000-4000-8000-000000000007';
const checkpointId = '71000000-0000-4000-8000-000000000008';
const token = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.test`;
const qrPayload = 'QrPayload0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcd';

function emptyTrace(origins: Array<{ site_id: string | null; hole_id: string | null; processing_facility_id: string | null; recovery_facility_id: string | null }>, qr: null | { id: string; status: string; rotatedFromId: string | null; createdAt: string } = null) {
  return {
    batch: { id: batchId, batch_code: 'BATCH-M6-ROLE', material_kind: 'GOLD_BEARING_FEED', current_status: 'ACTIVE' },
    origins, qr,
    relatedBatches: [{ id: batchId, batch_code: 'BATCH-M6-ROLE', material_kind: 'GOLD_BEARING_FEED', current_status: 'ACTIVE' }],
    productionEvents: [], processingEvents: [], inventoryMovements: [], consignments: [], recoveryEvents: [], residueSales: [], goldTrades: [],
    limitations: { pooledAttribution: 'Pooled outputs remain aggregate.', tradeLookup: 'Trade detail requires party access.' },
  };
}

async function loginAs(page: import('@playwright/test').Page, roleCode: string, scopeKind = 'FACILITY', scopeId = facilityId, additionalRoles: Array<{ role_code: string; scope_kind: string; scope_id: string }> = []) {
  const roles = [{ role_code: roleCode, scope_kind: scopeKind, scope_id: scopeId }, ...additionalRoles];
  const roleCodes = new Set(roles.map((role) => role.role_code));
  await page.route('**/api/v1/auth/login', (route) => route.fulfill({ json: {
    token, user: { id: userId, personPartyId: partyId, displayName: `Fictional ${roleCode}` }, roles,
  } }));
  await page.route('**/api/v1/me', (route) => route.fulfill({ json: {
    id: userId, person_party_id: partyId, display_name: `Fictional ${roleCode}`, roles,
  } }));
  await page.route('**/api/v1/sites', (route) => route.fulfill({ json: roleCodes.has('MINING_OPERATOR') || roleCodes.has('FIELD_OFFICER') ? [{ id: siteId, siteCode: 'DEMO-01', name: 'Fictional Site' }] : [] }));
  await page.route('**/api/v1/doras', (route) => route.fulfill({ json: roleCodes.has('DORA_OPERATOR') ? [{ id: facilityId, name: 'Fictional Dora', status: 'ACTIVE' }] : [] }));
  await page.route('**/api/v1/recovery-facilities', (route) => route.fulfill({ json: roleCodes.has('RECOVERY_FACILITY_OPERATOR') ? [{ id: recoveryFacilityId, name: 'Fictional Recovery Facility', status: 'ACTIVE' }] : [] }));
  await page.goto('/');
  await page.getByLabel('Email').fill('milestone6@example.test');
  await page.getByLabel('Password').fill('fictional-test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('authorized traceability search follows source links and QR create, lookup, and rotation stay authenticated', async ({ page }) => {
  let qrStatus = 'NONE';
  let createCount = 0;
  let rotateCount = 0;
  const traceData = () => ({
    batch: { id: batchId, batch_code: 'BATCH-M6-01', material_kind: 'GOLD_BEARING_FEED', current_status: 'ACTIVE' },
    origins: [{ site_id: siteId, hole_id: holeId, processing_facility_id: null, recovery_facility_id: null }],
    qr: qrStatus === 'NONE' ? null : { id: '71000000-0000-4000-8000-000000000009', status: 'ACTIVE', rotatedFromId: qrStatus === 'ROTATED' ? '71000000-0000-4000-8000-000000000010' : null, createdAt: new Date().toISOString() },
    relatedBatches: [{ id: batchId, batch_code: 'BATCH-M6-01', material_kind: 'GOLD_BEARING_FEED', current_status: 'ACTIVE' }],
    productionEvents: [{ id: eventA, event_code: 'EVT-M6-01', current_status: 'RECORDED', occurred_at_claimed: '2026-11-01T08:00:00.000Z', outputs: [{ batch_id: batchId, batch_code: 'BATCH-M6-01', measurements: [{ id: '71000000-0000-4000-8000-000000000011', measurement_kind: 'MEASURED', quantity_g: '5.000000', source_role: 'WEIGHER' }] }] }],
    processingEvents: [], inventoryMovements: [], consignments: [], recoveryEvents: [], residueSales: [], goldTrades: [],
    limitations: { pooledAttribution: 'Pooled recovery outputs remain aggregate.', tradeLookup: 'Trades require party access.' },
  });
  await loginAs(page, 'FIELD_OFFICER', 'SITE', siteId);
  await page.route((url) => url.pathname === '/api/v1/material-batches' && url.searchParams.has('query'), (route) => {
    expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
    return route.fulfill({ json: { results: [{ id: batchId, batch_code: 'BATCH-M6-01', material_kind: 'GOLD_BEARING_FEED', current_status: 'ACTIVE', qr_status: qrStatus === 'NONE' ? null : 'ACTIVE' }], complete: true } });
  });
  await page.route(`**/api/v1/material-batches/${batchId}/traceability`, (route) => route.fulfill({ json: traceData() }));
  await page.route(`**/api/v1/material-batches/${batchId}/qr`, async (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
    expect(route.request().headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/i);
    createCount += 1; qrStatus = 'ACTIVE';
    return route.fulfill({ status: 201, json: { qrRecordId: '71000000-0000-4000-8000-000000000009', materialBatchId: batchId, payload: qrPayload, status: 'ACTIVE', rotatedFromId: null } });
  });
  await page.route(`**/api/v1/material-batches/${batchId}/qr/rotate`, async (route) => {
    expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
    rotateCount += 1; qrStatus = 'ROTATED';
    return route.fulfill({ status: 201, json: { qrRecordId: '71000000-0000-4000-8000-000000000012', materialBatchId: batchId, payload: 'RotatedQr0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcd', status: 'ACTIVE', rotatedFromId: '71000000-0000-4000-8000-000000000009' } });
  });
  await page.route(`**/api/v1/qr/${qrPayload}`, async (route) => {
    expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
    if (qrStatus === 'ROTATED') return route.fulfill({ status: 404, json: { error: { message: 'The requested resource was not found.' } } });
    return route.fulfill({ json: { qr_record_id: '71000000-0000-4000-8000-000000000009', material_batch_id: batchId, status: 'ACTIVE', batch_code: 'BATCH-M6-01', material_kind: 'GOLD_BEARING_FEED', current_status: 'ACTIVE', origins: [{ site_id: siteId, hole_id: '71000000-0000-4000-8000-000000000013' }] } });
  });

  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Traceability' }).click();
  await page.getByLabel('Batch code or UUID').fill('BATCH-M6');
  await page.getByRole('button', { name: 'Find batch' }).click();
  await page.getByRole('button', { name: 'Open trace' }).click();
  await expect(page.getByRole('heading', { name: 'BATCH-M6-01' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Production and source measurements' })).toBeVisible();
  await expect(page.getByText('EVT-M6-01', { exact: true })).toBeVisible();
  await expect(page.getByText('No authorized processing event is linked to this batch.')).toBeVisible();
  await page.getByRole('button', { name: 'Create QR identity' }).click();
  await expect(page.getByText(qrPayload)).toBeVisible();
  expect(createCount).toBe(1);
  await page.getByRole('textbox', { name: 'QR token' }).fill(qrPayload);
  await page.getByRole('button', { name: 'Resolve with this signed-in account' }).click();
  await expect(page.getByText(/Authenticated lookup resolved BATCH-M6-01/)).toBeVisible();
  await page.getByRole('button', { name: 'Rotate QR identity' }).click();
  await expect(page.getByText(/RotatedQr0123456789/)).toBeVisible();
  expect(rotateCount).toBe(1);
  await page.getByRole('button', { name: 'Resolve with this signed-in account' }).click();
  await expect(page.getByRole('alert')).toContainText('not found');
});

const qrWriteRoleCases = [
  { roleCode: 'FIELD_OFFICER', scopeKind: 'SITE', scopeId: siteId, origins: [{ site_id: siteId, hole_id: holeId, processing_facility_id: null, recovery_facility_id: null }], additionalRoles: [] },
  { roleCode: 'MINING_OPERATOR', scopeKind: 'HOLE', scopeId: holeId, origins: [{ site_id: siteId, hole_id: holeId, processing_facility_id: null, recovery_facility_id: null }], additionalRoles: [] },
  { roleCode: 'DORA_OPERATOR', scopeKind: 'FACILITY', scopeId: facilityId, origins: [{ site_id: siteId, hole_id: holeId, processing_facility_id: facilityId, recovery_facility_id: null }], additionalRoles: [{ role_code: 'MINING_OPERATOR', scope_kind: 'SITE', scope_id: siteId }] },
  { roleCode: 'RECOVERY_FACILITY_OPERATOR', scopeKind: 'FACILITY', scopeId: recoveryFacilityId, origins: [{ site_id: null, hole_id: null, processing_facility_id: null, recovery_facility_id: recoveryFacilityId }], additionalRoles: [] },
];

for (const scenario of qrWriteRoleCases) {
  test(`${scenario.roleCode} sees QR controls only for a matching active scope`, async ({ page }) => {
    let qrStatus: 'NONE' | 'ACTIVE' = 'NONE';
    await loginAs(page, scenario.roleCode, scenario.scopeKind, scenario.scopeId, scenario.additionalRoles);
    await page.getByLabel('Acting role and scope', { exact: true }).selectOption(`${scenario.roleCode}:${scenario.scopeKind}:${scenario.scopeId}`);
    await page.route((url) => url.pathname === '/api/v1/material-batches' && url.searchParams.has('query'), (route) => route.fulfill({ json: {
      results: [{ id: batchId, batch_code: 'BATCH-M6-ROLE', material_kind: 'GOLD_BEARING_FEED', current_status: 'ACTIVE', qr_status: qrStatus === 'NONE' ? null : 'ACTIVE' }], complete: true,
    } }));
    await page.route(`**/api/v1/material-batches/${batchId}/traceability`, (route) => route.fulfill({ json: emptyTrace(scenario.origins, qrStatus === 'ACTIVE' ? {
      id: '71000000-0000-4000-8000-000000000009', status: 'ACTIVE', rotatedFromId: null, createdAt: new Date().toISOString(),
    } : null) }));
    await page.route(`**/api/v1/material-batches/${batchId}/qr`, (route) => {
      qrStatus = 'ACTIVE';
      return route.fulfill({ status: 201, json: { payload: 'RoleQrPayload0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcd', status: 'ACTIVE' } });
    });
    await page.route(`**/api/v1/material-batches/${batchId}/qr/rotate`, (route) => route.fulfill({ status: 201, json: { payload: 'RoleRotatedQr0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcd', status: 'ACTIVE' } }));
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Traceability' }).click();
    await page.getByLabel('Batch code or UUID').fill('BATCH-M6-ROLE');
    await page.getByRole('button', { name: 'Find batch' }).click();
    await page.getByRole('button', { name: 'Open trace' }).click();
    await expect(page.getByRole('button', { name: 'Create QR identity' })).toBeVisible();
    await page.getByRole('button', { name: 'Create QR identity' }).click();
    await expect(page.getByRole('button', { name: 'Rotate QR identity' })).toBeVisible();
    await page.getByRole('button', { name: 'Rotate QR identity' }).click();
    await expect(page.getByText(/RoleRotatedQr/)).toBeVisible();
  });
}

for (const roleCode of ['MINER', 'LOCAL_MERCHANT', 'LARGER_MERCHANT']) {
  test(`${roleCode} cannot see QR write controls`, async ({ page }) => {
    await loginAs(page, roleCode, roleCode === 'MINER' ? 'SITE' : 'ORGANISATION', siteId);
    await page.route((url) => url.pathname === '/api/v1/material-batches' && url.searchParams.has('query'), (route) => route.fulfill({ json: {
      results: [{ id: batchId, batch_code: 'BATCH-M6-ROLE', material_kind: 'GOLD_BEARING_FEED', current_status: 'ACTIVE', qr_status: null }], complete: true,
    } }));
    await page.route(`**/api/v1/material-batches/${batchId}/traceability`, (route) => route.fulfill({ json: emptyTrace([
      { site_id: siteId, hole_id: holeId, processing_facility_id: null, recovery_facility_id: null },
    ]) }));
    await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Traceability' }).click();
    await page.getByLabel('Batch code or UUID').fill('BATCH-M6-ROLE');
    await page.getByRole('button', { name: 'Find batch' }).click();
    await page.getByRole('button', { name: 'Open trace' }).click();
    await expect(page.getByRole('button', { name: 'Create QR identity' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Rotate QR identity' })).toHaveCount(0);
  });
}

test('a supported role with a nonmatching site scope cannot see QR write controls', async ({ page }) => {
  await loginAs(page, 'MINING_OPERATOR', 'SITE', '71000000-0000-4000-8000-000000000099');
  await page.route((url) => url.pathname === '/api/v1/material-batches' && url.searchParams.has('query'), (route) => route.fulfill({ json: {
    results: [{ id: batchId, batch_code: 'BATCH-M6-ROLE', material_kind: 'GOLD_BEARING_FEED', current_status: 'ACTIVE', qr_status: null }], complete: true,
  } }));
  await page.route(`**/api/v1/material-batches/${batchId}/traceability`, (route) => route.fulfill({ json: emptyTrace([
    { site_id: siteId, hole_id: holeId, processing_facility_id: null, recovery_facility_id: null },
  ]) }));
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Traceability' }).click();
  await page.getByLabel('Batch code or UUID').fill('BATCH-M6-ROLE');
  await page.getByRole('button', { name: 'Find batch' }).click();
  await page.getByRole('button', { name: 'Open trace' }).click();
  await expect(page.getByRole('button', { name: 'Create QR identity' })).toHaveCount(0);
});

test('QR write controls remain visible for a plausible role and show server authorization rejections', async ({ page }) => {
  await loginAs(page, 'FIELD_OFFICER', 'SITE', siteId);
  await page.route((url) => url.pathname === '/api/v1/material-batches' && url.searchParams.has('query'), (route) => route.fulfill({ json: {
    results: [{ id: batchId, batch_code: 'BATCH-M6-ROLE', material_kind: 'GOLD_BEARING_FEED', current_status: 'ACTIVE', qr_status: null }], complete: true,
  } }));
  await page.route(`**/api/v1/material-batches/${batchId}/traceability`, (route) => route.fulfill({ json: emptyTrace([
    { site_id: siteId, hole_id: holeId, processing_facility_id: null, recovery_facility_id: null },
  ]) }));
  let status = 403;
  await page.route(`**/api/v1/material-batches/${batchId}/qr`, (route) => route.fulfill({ status, json: { error: { code: 'RESOURCE_DENIED', message: 'The QR write is not allowed for this account.' } } }));
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Traceability' }).click();
  await page.getByLabel('Batch code or UUID').fill('BATCH-M6-ROLE');
  await page.getByRole('button', { name: 'Find batch' }).click();
  await page.getByRole('button', { name: 'Open trace' }).click();
  await page.getByRole('button', { name: 'Create QR identity' }).click();
  await expect(page.getByRole('alert')).toContainText('server denied this QR action (HTTP 403)');
  await expect(page.getByRole('alert')).toContainText('The QR write is not allowed for this account.');
  status = 404;
  await page.getByRole('button', { name: 'Create QR identity' }).click();
  await expect(page.getByRole('alert')).toContainText('server denied this QR action (HTTP 404)');
});

test('batch search clearly warns when the authorized result scan is incomplete', async ({ page }) => {
  await loginAs(page, 'FIELD_OFFICER', 'SITE', siteId);
  await page.route((url) => url.pathname === '/api/v1/material-batches' && url.searchParams.has('query'), (route) => route.fulfill({ json: { results: [], complete: false } }));
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Traceability' }).click();
  await page.getByLabel('Batch code or UUID').fill('BATCH-M6');
  await page.getByRole('button', { name: 'Find batch' }).click();
  await expect(page.getByText(/This search may be incomplete/)).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('traceability explains missing genealogy and hides QR writes for an auditor', async ({ page }) => {
  await loginAs(page, 'AUDITOR', 'SITE', siteId);
  await page.route((url) => url.pathname === '/api/v1/material-batches' && url.searchParams.has('query'), (route) => route.fulfill({ json: { results: [{ id: batchId, batch_code: 'BATCH-EMPTY', material_kind: 'GOLD_BEARING_FEED', current_status: 'ACTIVE', qr_status: null }], complete: true } }));
  await page.route(`**/api/v1/material-batches/${batchId}/traceability`, (route) => route.fulfill({ json: {
    batch: { id: batchId, batch_code: 'BATCH-EMPTY', material_kind: 'GOLD_BEARING_FEED', current_status: 'ACTIVE' }, qr: null,
    origins: [{ site_id: siteId, hole_id: holeId, processing_facility_id: null, recovery_facility_id: null }],
    relatedBatches: [{ id: batchId, batch_code: 'BATCH-EMPTY', material_kind: 'GOLD_BEARING_FEED', current_status: 'ACTIVE' }],
    productionEvents: [], processingEvents: [], inventoryMovements: [], consignments: [], recoveryEvents: [], residueSales: [], goldTrades: [],
    limitations: { pooledAttribution: 'Pooled outputs remain aggregate.', tradeLookup: 'Party access required.' },
  } }));
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Traceability' }).click();
  await page.getByLabel('Batch code or UUID').fill('BATCH-EMPTY');
  await page.getByRole('button', { name: 'Find batch' }).click();
  await page.getByRole('button', { name: 'Open trace' }).click();
  await expect(page.getByText('No authorized production event is linked to this batch.')).toBeVisible();
  await expect(page.getByText('No QR identity')).toBeVisible();
  await expect(page.getByText('QR creation and rotation are hidden in the read-only auditor workspace.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create QR identity' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Rotate QR identity' })).toHaveCount(0);
});

test('audit stream picker and checkpoint history are authorized, while auditor controls stay read-only', async ({ page }) => {
  const stream = { streamKind: 'mining_site', streamId: siteId, sequence: 3, headHash: 'ab'.repeat(32), updatedAt: new Date().toISOString() };
  await loginAs(page, 'AUDITOR', 'SITE', siteId);
  await page.route('**/api/v1/audit/streams', (route) => route.fulfill({ json: [stream] }));
  await page.route('**/api/v1/audit/checkpoints', (route) => route.fulfill({ json: [{ id: checkpointId, createdAt: new Date().toISOString(), manifestHash: 'cd'.repeat(32), status: 'VERIFIED', attemptCount: 1, streamCount: 1 }] }));
  await page.route(`**/api/v1/audit/checkpoints/${checkpointId}`, (route) => route.fulfill({ json: {
    checkpoint: { id: checkpointId, createdAt: new Date().toISOString(), createdByUserId: userId, manifestHash: 'cd'.repeat(32), streams: [{ streamKind: 'mining_site', streamId: siteId, sequence: 3, headHash: 'ab'.repeat(32) }] },
    databaseState: 'ACCEPTED', processing: { status: 'VERIFIED', attemptCount: 1, attempts: [{ attempt_number: 1, outcome: 'VERIFIED', started_at: new Date().toISOString() }] },
    liveVerification: { checkpointStatus: 'VERIFIED', manifestStatus: 'VALID', streams: [{ streamKind: 'mining_site', streamId: siteId, coveredSequence: 3, currentSequence: 3, currentHeadStatus: 'CONSISTENT', checkpointStatus: 'VERIFIED', tailStatus: 'NONE', tailEntries: 0 }] }, externalCommitment: 'NOT_IMPLEMENTED',
  } }));
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Audit evidence' }).click();
  await expect(page.getByText('Auditor view is read-only.')).toBeVisible();
  await expect(page.getByLabel('Authorized audit stream')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create checkpoint' })).toHaveCount(0);
  await expect(page.locator('.site-list').getByText(new RegExp(siteId))).toBeVisible();
  await page.getByRole('button', { name: 'Open and verify' }).click();
  await expect(page.getByRole('heading', { name: 'Verification result' })).toBeVisible();
  await expect(page.getByText(/VERIFIED.*VALID/)).toBeVisible();
});

test('reports filter authorized source records and count active observations without cross-stage quantity totals', async ({ page }) => {
  await loginAs(page, 'MINING_OPERATOR', 'SITE', siteId);
  await page.route(`**/api/v1/sites/${siteId}/production-events`, (route) => route.fulfill({ json: [
    { id: eventA, event_code: 'EVT-OLD', current_status: 'RECORDED', occurred_at_claimed: '2026-11-01T08:00:00.000Z' },
    { id: eventB, event_code: 'EVT-NEW', current_status: 'RECORDED', occurred_at_claimed: '2026-11-22T08:00:00.000Z' },
  ] }));
  await page.route(`**/api/v1/sites/${siteId}/production-events/${eventA}`, (route) => route.fulfill({ json: {
    id: eventA, event_code: 'EVT-OLD', occurred_at_claimed: '2026-11-01T08:00:00.000Z', current_status: 'RECORDED',
    measurements: [{ id: 'old', measurement_kind: 'MEASURED', quantity_g: '9.000000' }, { id: 'new', supersedes_measurement_id: 'old', measurement_kind: 'VERIFIED', quantity_g: '8.000000' }],
  } }));
  await page.route(`**/api/v1/sites/${siteId}/production-events/${eventB}`, (route) => route.fulfill({ json: {
    id: eventB, event_code: 'EVT-NEW', occurred_at_claimed: '2026-11-22T08:00:00.000Z', current_status: 'RECORDED',
    measurements: [{ id: 'current', measurement_kind: 'DECLARED', quantity_g: '12.000000' }],
  } }));
  await page.route('**/api/v1/processing-events', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/consignments', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/residue-sales', (route) => route.fulfill({ json: [] }));
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Reports' }).click();
  await page.getByRole('button', { name: 'Load report' }).click();
  await expect(page.getByText('Production records')).toBeVisible();
  await expect(page.getByText('Active measurement observations')).toBeVisible();
  await expect(page.locator('.queue-meta li')).toHaveCount(2);
  await expect(page.locator('.queue-meta li').filter({ hasText: '9.000000' })).toHaveCount(0);
  await expect(page.locator('.queue-meta li').filter({ hasText: '8.000000' })).toBeVisible();
  await expect(page.locator('.queue-meta li').filter({ hasText: '12.000000' })).toBeVisible();
  await page.getByLabel('From').fill('2026-11-20');
  await expect(page.locator('section[aria-labelledby="report-records-heading"] .queue-item')).toHaveCount(1);
  await expect(page.locator('section[aria-labelledby="report-records-heading"] .queue-item').first()).toContainText('EVT-NEW');
  await expect(page.getByText('No grams are summed across process stages.')).toBeVisible();
});

test('reports present an honest empty state when authorized sources have no records', async ({ page }) => {
  await loginAs(page, 'MINING_OPERATOR', 'SITE', siteId);
  await page.route(`**/api/v1/sites/${siteId}/production-events`, (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/processing-events', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/consignments', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/residue-sales', (route) => route.fulfill({ json: [] }));
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Reports' }).click();
  await page.getByRole('button', { name: 'Load report' }).click();
  await expect(page.getByText('No production or operations records are available in this account scope.')).toBeVisible();
});

test('traceability keeps the workspace usable at a narrow mobile width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAs(page, 'DORA_OPERATOR');
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Traceability' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
