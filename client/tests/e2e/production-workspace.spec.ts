import { expect, test, type Page } from '@playwright/test';

const userId = 'b1111111-1111-4111-8111-111111111111';
const partyId = 'b2222222-2222-4222-8222-222222222222';
const siteId = 'b3333333-3333-4333-8333-333333333333';
const holeId = 'b4444444-4444-4444-8444-444444444444';
const beneficiaryId = 'b5555555-5555-4555-8555-555555555555';
const beneficiaryRelationshipId = 'b6666666-6666-4666-8666-666666666666';
const minerPartyId = 'b6666667-6666-4666-8666-666666666666';
const eventId = 'b7777777-7777-4777-8777-777777777777';
const outputId = 'b8888888-8888-4888-8888-888888888888';
const batchId = 'b9999999-9999-4999-8999-999999999999';
const measurementId = 'baaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const captureId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const token = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.test`;

type Envelope = {
  clientMutationId: string;
  commandType: string;
  payload: { siteId: string; eventId?: string; outputId?: string; input?: Record<string, unknown> };
  expectedVersion?: { streamKind: string; streamId: string; sequence: number };
  actualParticipant: { identityState: string; partyId?: string };
};

function eventDetail() {
  return {
    id: eventId, event_code: 'EVT-FICTIONAL-01', event_kind: 'PRODUCTION',
    occurred_at_claimed: '2026-11-20T08:15:00.000Z', recorded_at: '2026-11-20T08:20:00.000Z',
    current_status: 'SUBMITTED', hole_id: holeId, hole_code: 'H-01', auditSequence: 11,
    participants: [{ party_id: minerPartyId, role_code: 'MINER', relationship_id: beneficiaryRelationshipId, relationship_kind: 'HOLE' }],
    captureProvenance: {
      id: captureId, actual_participant_party_id: null, participant_identity_state: 'UNKNOWN', source_kind: 'PAPER_TRANSCRIPTION',
      occurred_at_claimed: '2026-11-20T08:15:00.000Z', entered_at: '2026-11-20T08:20:00.000Z',
      source_reference: 'FICTIONAL-NOTEBOOK-01', evidence_ref: 'FICTIONAL-EVIDENCE-01', acknowledgement_status: null,
      acknowledged_by_party_id: null,
    },
    outputs: [{
      id: outputId, batch_id: batchId, batch_code: 'BATCH-FICTIONAL-01', material_kind: 'GOLD_BEARING_FEED', measurement_set_id: 'bccccccc-cccc-4ccc-8ccc-cccccccccccc',
      measurements: [{
        id: measurementId, measurement_kind: 'DECLARED', quantity_g: '12.500000', source_value: '0.0125', source_unit_code: 'kg',
        conversion_version: 'manual-v1', source_role: 'RECORDER', source_party_id: null,
        occurred_at_claimed: '2026-11-20T08:15:00.000Z', entered_at: '2026-11-20T08:20:00.000Z',
        method_code: 'MANUAL', instrument_ref: null, supersedes_measurement_id: null,
      }],
    }],
  };
}

function emptyAllocations() {
  return { productionEventOutputId: outputId, allocationChainId: null, activeApprovedSetId: null, revisions: [] as Array<Record<string, unknown>> };
}

async function installProductionApi(page: Page, roleCode: 'FIELD_OFFICER' | 'AUDITOR', onCommand?: (envelope: Envelope) => void) {
  let allocationHistory = emptyAllocations();
  let versionSequence = 11;
  const requests: Envelope[] = [];
  const allocationSetIds: string[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = request.postDataJSON?.() as Envelope | undefined;
    if (path === '/api/v1/auth/login' && method === 'POST') return route.fulfill({ json: {
      token,
      user: { id: userId, personPartyId: partyId, displayName: `Fictional ${roleCode}` },
      roles: [{ role_code: roleCode, scope_kind: 'SITE', scope_id: siteId }],
    } });
    if (path === '/api/v1/me') return route.fulfill({ json: {
      id: userId, person_party_id: partyId, display_name: `Fictional ${roleCode}`,
      roles: [{ role_code: roleCode, scope_kind: 'SITE', scope_id: siteId }],
    } });
    if (path === '/api/v1/sites') return route.fulfill({ json: [{ id: siteId, siteCode: 'TEST-01', name: 'Fictional Mine' }] });
    if (path === `/api/v1/sites/${siteId}/holes`) return route.fulfill({ json: [{ id: holeId, siteId, holeCode: 'H-01', auditSequence: 3 }] });
    if (path === `/api/v1/sites/${siteId}/holes/${holeId}/participants`) return route.fulfill({ json: [{
      party_id: beneficiaryId, display_name: 'Fictional Miner', relationship_id: beneficiaryRelationshipId, role_code: 'MINER',
    }] });
    if (path === `/api/v1/sites/${siteId}/production-events` && method === 'GET') return route.fulfill({ json: [{
      id: eventId, event_code: 'EVT-FICTIONAL-01', event_kind: 'PRODUCTION',
      occurred_at_claimed: '2026-11-20T08:15:00.000Z', recorded_at: '2026-11-20T08:20:00.000Z',
      current_status: 'SUBMITTED', hole_id: holeId, hole_code: 'H-01', output_count: 1,
    }] });
    if (path === `/api/v1/sites/${siteId}/production-events/${eventId}` && method === 'GET') return route.fulfill({ json: eventDetail() });
    if (path === `/api/v1/sites/${siteId}/participants` && method === 'GET') return route.fulfill({ json: [{
      party_id: beneficiaryId, display_name: 'Fictional Beneficiary', relationship_id: beneficiaryRelationshipId,
      relationship_kind: 'SITE', role_code: 'BENEFICIARY', relationship_status: 'ACTIVE',
      valid_from: '2020-01-01T00:00:00.000Z', valid_to: null, hole_id: null,
    }] });
    if (path === `/api/v1/sites/${siteId}/production-events/${eventId}/outputs/${outputId}/allocation-sets` && method === 'GET') {
      return route.fulfill({ json: allocationHistory });
    }
    if (path === '/api/v1/sync/versions' && method === 'POST') return route.fulfill({ json: { expectedVersion: {
      streamKind: 'material_event', streamId: body?.payload.eventId ?? eventId, sequence: versionSequence++,
    } } });
    if (path === '/api/v1/sync/commands' && method === 'POST' && body) {
      requests.push(body);
      onCommand?.(body);
      let responseId = eventId;
      let receiptStatus = 'needs_review';
      if (body.commandType === 'production.allocation.propose') {
        const input = body.payload.input as { basisKind: 'SHARE' | 'QUANTITY'; basisMeasurementId?: string; supersedesSetId?: string; correctionReason?: string; rows: Array<{ beneficiaryPartyId: string; allocatedShare?: string; allocatedQuantityGrams?: string }> };
        const previous = allocationHistory.revisions.at(-1) as Record<string, unknown> | undefined;
        const revisionId = `bd${String(allocationHistory.revisions.length + 1).padStart(6, '0')}-dddd-4ddd-8ddd-dddddddddddd`;
        allocationSetIds.push(revisionId);
        responseId = revisionId;
        receiptStatus = 'server_accepted';
        const revision = {
          id: revisionId, revision_no: allocationHistory.revisions.length + 1,
          revision_kind: previous ? 'CORRECTION' : 'ORIGINAL', basis_kind: input.basisKind,
          basis_measurement_id: input.basisMeasurementId ?? null, supersedes_set_id: input.supersedesSetId ?? null,
          correction_reason: input.correctionReason ?? null, proposed_by_user_id: userId, created_at: new Date().toISOString(),
          rows: input.rows.map((row, index) => ({
            id: `be${String(index + 1).padStart(6, '0')}-eeee-4eee-8eee-eeeeeeeeeeee`,
            allocation_set_id: revisionId, beneficiary_party_id: row.beneficiaryPartyId,
            allocation_basis: input.basisKind, allocated_quantity_g: row.allocatedQuantityGrams ?? null, allocated_share: row.allocatedShare ?? null,
          })),
          reviewHistory: [{ review_status: 'PENDING', reason: null, evidence_ref: null, occurred_at: new Date().toISOString() }],
        };
        allocationHistory = {
          productionEventOutputId: outputId, allocationChainId: 'bf000000-0000-4000-8000-000000000000',
          activeApprovedSetId: null, revisions: [...allocationHistory.revisions, revision],
        };
      }
      return route.fulfill({ status: 202, json: { receipt: {
        clientMutationId: body.clientMutationId, status: receiptStatus,
        receivedAt: new Date().toISOString(), resolvedAt: new Date().toISOString(), response: { id: responseId }, error: null,
      } } });
    }
    return route.fulfill({ status: 404, json: { error: { message: `Unmocked production request: ${method} ${path}` } } });
  });
  return { requests, allocationSetIds };
}

async function signIn(page: Page, roleCode: 'FIELD_OFFICER' | 'AUDITOR') {
  await page.goto('/');
  await page.getByLabel('Email').fill('fictional@example.test');
  await page.getByLabel('Password').fill('fictional-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: `Good day, Fictional ${roleCode}` }).waitFor();
}

test('field officer records through Capture, inspects production details and opens its source batch', async ({ page }) => {
  const submitted: Envelope[] = [];
  await installProductionApi(page, 'FIELD_OFFICER', (envelope) => submitted.push(envelope));
  await signIn(page, 'FIELD_OFFICER');
  const navigation = page.getByRole('navigation', { name: 'Workspace navigation' });
  await navigation.getByRole('button', { name: 'Production' }).click();
  await expect(page.getByRole('heading', { name: 'Production register' })).toBeVisible();
  await expect(page.getByText('Gold Bearing Feed')).toBeVisible();

  await page.getByLabel('Production site', { exact: true }).selectOption(siteId);
  await page.getByLabel('Production hole', { exact: true }).selectOption(holeId);
  await page.getByRole('button', { name: 'Continue to production capture' }).click();
  await expect(page.getByRole('heading', { name: 'Capture field information' })).toBeVisible();
  await expect(page.getByLabel('Assigned site')).toHaveValue(siteId);
  await expect(page.getByLabel('Assigned hole')).toHaveValue(holeId);
  await page.getByLabel('Source reference').fill('FICTIONAL-FIELD-NOTE-02');
  await page.getByLabel('Add a quantity observation to this output').check();
  await page.getByLabel('Initial observation type').selectOption('DECLARED');
  await page.getByLabel('Initial quantity in grams').fill('12.500000');
  await page.getByLabel('Initial source value').fill('0.0125');
  await page.getByLabel('Initial source unit').fill('kg');
  await page.getByRole('button', { name: 'Save and sync' }).click();
  await navigation.getByRole('button', { name: 'My command queue' }).click();
  await expect(page.getByText('Received; review required', { exact: true })).toBeVisible();
  expect(submitted).toHaveLength(1);
  expect(submitted[0]).toMatchObject({
    commandType: 'production.create', actualParticipant: { identityState: 'UNKNOWN' },
    payload: { siteId, input: {
      holeId, captureProvenance: { sourceReference: 'FICTIONAL-FIELD-NOTE-02' },
      outputs: [{ measurements: [{ kind: 'DECLARED', quantityGrams: '12.500000', sourceValue: '0.0125', sourceUnit: 'kg' }] }],
    } },
    expectedVersion: { streamKind: 'mining_hole', streamId: holeId, sequence: 3 },
  });

  await navigation.getByRole('button', { name: 'Production' }).click();
  await page.getByRole('button', { name: 'Open event' }).click();
  await expect(page.getByRole('heading', { name: 'EVT-FICTIONAL-01' })).toBeVisible();
  await expect(page.getByText(/Actual participant identity: Unknown/)).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Declared' })).toContainText('12.500000 g');
  await expect(page.getByText('12.500000 g', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open batch detail' }).click();
  await expect(page.getByRole('heading', { name: 'Batch record BATCH-FICTIONAL-01' })).toBeVisible();
  await expect(page.getByText(/source production event EVT-FICTIONAL-01/)).toBeVisible();
  await expect(page.getByText(/No batch collection or processing-genealogy endpoint/)).toBeVisible();
});

test('field officer proposes and revises a pending allocation through the offline command queue', async ({ page }) => {
  const submitted: Envelope[] = [];
  const fixture = await installProductionApi(page, 'FIELD_OFFICER', (envelope) => submitted.push(envelope));
  await signIn(page, 'FIELD_OFFICER');
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Production' }).click();
  await page.getByRole('button', { name: 'Open event' }).click();
  await expect(page.getByRole('heading', { name: 'New allocation proposal' })).toBeVisible();
  await expect(page.getByText(/Proposals are not approved agreements/)).toBeVisible();
  await page.getByLabel('Beneficiary 1').selectOption(beneficiaryId);
  await page.getByLabel('Proposed value 1').fill('0.4');
  await page.getByRole('button', { name: 'Save proposed allocation' }).click();
  await expect(page.getByText(/Server receipt: Server Accepted/)).toBeVisible();
  await expect(page.getByText('Revision 1 · Original')).toBeVisible();
  await expect(page.getByText('Proposal · Pending')).toBeVisible();
  expect(submitted).toHaveLength(1);
  const first = submitted[0]!;
  expect(first.commandType).toBe('production.allocation.propose');
  expect(first.expectedVersion).toMatchObject({ streamKind: 'material_event', streamId: eventId, sequence: 11 });
  expect(first.payload.input).toMatchObject({ basisKind: 'SHARE', rows: [{ beneficiaryPartyId: beneficiaryId, allocatedShare: '0.4' }] });
  const firstSetId = fixture.allocationSetIds[0]!;

  await page.getByRole('button', { name: 'Prepare revision 2' }).click();
  await page.getByLabel('Proposed value 1').fill('0.5');
  await page.getByLabel('Correction reason').fill('Updated after a fictional review discussion.');
  await page.getByRole('button', { name: 'Save proposed allocation' }).click();
  await expect(page.getByText(/Server receipt: Server Accepted/)).toBeVisible();
  await expect(page.getByText('Revision 2 · Correction')).toBeVisible();
  await expect(page.getByText(/Supersedes bd000001-dddd-4ddd-8ddd-dddddddddddd\. Reason: Updated after a fictional review discussion\./)).toBeVisible();
  await expect(page.getByText('Proposal · Pending')).toHaveCount(2);
  expect(submitted).toHaveLength(2);
  expect(submitted[1]?.clientMutationId).not.toBe(submitted[0]?.clientMutationId);
  expect(submitted[1]?.payload.input).toMatchObject({
    basisKind: 'SHARE', supersedesSetId: firstSetId, correctionReason: 'Updated after a fictional review discussion.',
    rows: [{ beneficiaryPartyId: beneficiaryId, allocatedShare: '0.5' }],
  });
  await expect(page.getByText(/not an approved agreement/)).toBeVisible();
});

test('auditor can inspect production and allocation history without proposal or capture actions', async ({ page }) => {
  await installProductionApi(page, 'AUDITOR');
  await signIn(page, 'AUDITOR');
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Production' }).click();
  await expect(page.getByRole('heading', { name: 'Production register' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Record production' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open event' }).click();
  await expect(page.getByRole('heading', { name: 'Proposed allocations and history' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'New allocation proposal' })).toHaveCount(0);
  await expect(page.getByText('Proposals are not approved agreements.')).toBeVisible();
});
