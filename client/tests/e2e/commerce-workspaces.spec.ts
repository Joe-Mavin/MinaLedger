import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';

const siteId = '11111111-1111-4111-8111-111111111111';
const holeId = '22222222-2222-4222-8222-222222222222';
const eventId = '33333333-3333-4333-8333-333333333333';
const outputId = '44444444-4444-4444-8444-444444444444';
const measureSetId = '55555555-5555-4555-8555-555555555555';
const sourcePartyId = '66666666-6666-4666-8666-666666666666';
const sellerPartyId = '77777777-7777-4777-8777-777777777777';
const buyerPartyId = '88888888-8888-4888-8888-888888888888';
const batchId = '99999999-9999-4999-8999-999999999999';
const tradeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const lineId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const nextLineId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const sourceMeasurementId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const sourceAssayId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const paymentId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

type TestIdentity = { userId: string; partyId: string; displayName: string; role: string; scopeKind: string; scopeId: string };

const identities: Record<string, TestIdentity> = {
  'seller@example.test': { userId: '10101010-1010-4010-8010-101010101010', partyId: '12121212-1212-4212-8212-121212121212', displayName: 'Fictional Seller', role: 'LOCAL_MERCHANT', scopeKind: 'ORGANISATION', scopeId: sellerPartyId },
  'buyer@example.test': { userId: '20202020-2020-4020-8020-202020202020', partyId: '23232323-2323-4232-8232-232323232323', displayName: 'Fictional Buyer', role: 'LARGER_MERCHANT', scopeKind: 'ORGANISATION', scopeId: buyerPartyId },
  'field@example.test': { userId: '30303030-3030-4030-8030-303030303030', partyId: sourcePartyId, displayName: 'Fictional Field Officer', role: 'FIELD_OFFICER', scopeKind: 'PILOT', scopeId: 'default' },
  'auditor@example.test': { userId: '40404040-4040-4040-8040-404040404040', partyId: '45454545-4545-4545-8545-454545454545', displayName: 'Fictional Auditor', role: 'AUDITOR', scopeKind: 'SITE', scopeId: siteId },
};

function tokenFor(identity: TestIdentity): string {
  return `e30.${Buffer.from(JSON.stringify({ sub: identity.userId, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.test`;
}

async function installSessionRoutes(context: BrowserContext) {
  const tokenIdentities = new Map<string, TestIdentity>();
  await context.route('**/api/v1/auth/login', async (route) => {
    const input = route.request().postDataJSON() as { email: string };
    const identity = identities[input.email];
    if (!identity) return route.fulfill({ status: 401, json: { error: { message: 'Invalid credentials' } } });
    const token = tokenFor(identity);
    tokenIdentities.set(token, identity);
    return route.fulfill({ json: {
      token,
      user: { id: identity.userId, personPartyId: identity.partyId, displayName: identity.displayName },
      roles: [{ role_code: identity.role, scope_kind: identity.scopeKind, scope_id: identity.scopeId }],
    } });
  });
  await context.route('**/api/v1/me', async (route) => {
    const token = route.request().headers().authorization?.replace(/^Bearer /, '') ?? '';
    const identity = tokenIdentities.get(token);
    if (!identity) return route.fulfill({ status: 401, json: { error: { message: 'Session expired' } } });
    return route.fulfill({ json: {
      id: identity.userId, person_party_id: identity.partyId, display_name: identity.displayName,
      roles: [{ role_code: identity.role, scope_kind: identity.scopeKind, scope_id: identity.scopeId }],
    } });
  });
  await context.route('**/api/v1/sites', (route) => route.fulfill({ json: [{ id: siteId, siteCode: 'TEST-01', name: 'Fictional Mine' }] }));
  return tokenIdentities;
}

async function signIn(page: Page, email: string) {
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('fictional-test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: `Good day, ${identities[email]?.displayName}` })).toBeVisible();
}

function tradeFixture(status = 'PROPOSED') {
  const line = {
    id: lineId, trade_id: tradeId, batch_id: batchId, batch_code: 'GOLD-001', material_kind: 'RECOVERED_GOLD',
    source_event_id: eventId, source_event_kind: 'RECOVERY', source_event_status: 'RECORDED', revision_no: 1,
    revision_kind: 'INITIAL', transaction_quantity_g: '1.000000', accepted_trade_quantity_g: null,
    unit_price: '5000.00000000', line_amount: '5000.00000000', deduction_amount: '0.00000000',
    deduction_reason: null, assay_record_id: null, supersedes_line_id: null, correction_reason: null,
    proposed_by_user_id: identities['seller@example.test'].userId, is_accepted: false, is_current: true,
    measurements: [], custody: [], custodyTotals: { transferred_quantity_g: '0.000000', offered_quantity_g: '0.000000', disputed_quantity_g: '0.000000' },
  };
  return {
    id: tradeId, trade_code: 'GT-TEST-01', trade_kind: 'PURCHASE' as const, seller_party_id: sellerPartyId,
    buyer_party_id: buyerPartyId, status, trade_date: new Date('2026-11-20T10:00:00.000Z').toISOString(),
    currency_code: 'KES', terms_ref: 'fictional-terms-01', lines: [line], decisions: [], statusHistory: [], evidence: [], assays: [], payments: [],
    reconciliation: {
      amountAgreed: status === 'AGREED' ? '5000.00000000' : '0.00000000', amountSettled: '0.00000000',
      amountOutstanding: status === 'AGREED' ? '5000.00000000' : '0.00000000', amountReported: '0.00000000',
      amountDisputed: '0.00000000', currencyCode: 'KES', unresolvedPaymentReports: [], measurementDiscrepancies: [],
      unresolvedLines: status === 'AGREED' ? [] : [lineId], unresolvedDecisions: [],
    },
  };
}

test('measurement register opens authorized source history and records a participant-linked observation', async ({ page, context }) => {
  await installSessionRoutes(context);
  const event = {
    id: eventId, event_code: 'PROD-TEST-01', event_kind: 'PRODUCTION', occurred_at_claimed: '2026-11-20T08:00:00.000Z',
    recorded_at: '2026-11-20T08:10:00.000Z', current_status: 'RECORDED', hole_id: holeId, hole_code: 'H-01', output_count: 1,
  };
  const detail = {
    ...event, auditSequence: 4,
    participants: [{ party_id: sourcePartyId, role_code: 'MINER', relationship_id: 'abababab-abab-4bab-8bab-abababababab', relationship_kind: 'HOLE' }],
    captureProvenance: { actual_participant_party_id: sourcePartyId, participant_identity_state: 'IDENTIFIED' },
    outputs: [{ id: outputId, batch_id: batchId, batch_code: 'ORE-001', material_kind: 'GOLD_BEARING_FEED', measurement_set_id: measureSetId, measurements: [] as Array<Record<string, unknown>> }],
  };
  let submitted: Record<string, unknown> | null = null;
  await context.route(`**/api/v1/sites/${siteId}/production-events`, (route) => route.fulfill({ json: [event] }));
  await context.route('**/api/v1/processing-events', (route) => route.fulfill({ json: [] }));
  await context.route(`**/api/v1/sites/${siteId}/production-events/${eventId}`, (route) => route.fulfill({ json: detail }));
  await context.route(`**/api/v1/sites/${siteId}/production-events/${eventId}/outputs/${outputId}/measurements`, async (route) => {
    submitted = route.request().postDataJSON() as Record<string, unknown>;
    expect(route.request().headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/i);
    detail.outputs[0].measurements.push({
      id: 'abababab-1111-4111-8111-abababababab', measurement_set_id: measureSetId, measurement_kind: submitted.kind,
      quantity_g: submitted.quantityGrams, source_value: submitted.sourceValue, source_unit_code: submitted.sourceUnit,
      conversion_version: submitted.conversionVersion, source_role: submitted.sourceRole, source_party_id: submitted.sourcePartyId,
      occurred_at_claimed: submitted.occurredAt, entered_at: new Date().toISOString(), method_code: submitted.methodCode,
      instrument_ref: submitted.instrumentRef, supersedes_measurement_id: null,
    });
    return route.fulfill({ status: 201, json: { id: 'abababab-1111-4111-8111-abababababab' } });
  });

  await signIn(page, 'field@example.test');
  const navigation = page.getByRole('navigation', { name: 'Workspace navigation' });
  await navigation.getByRole('button', { name: 'Measurements & assays' }).click();
  await page.getByRole('button', { name: 'PROD-TEST-01' }).click();
  const form = page.getByRole('form', { name: 'Record measurement for ORE-001' });
  await expect(form).toBeVisible();
  await form.getByLabel('Observation kind').selectOption('DECLARED');
  await form.getByLabel('Source value').fill('5.25');
  await form.getByLabel('Source role').selectOption('WITNESS');
  await form.getByLabel('Source participant party ID').selectOption(sourcePartyId);
  await form.getByLabel('Method code').fill('FIELD_SCALE');
  await form.getByLabel('Instrument reference').fill('SCALE-001');
  await form.getByLabel('Evidence reference').fill('notebook-page-4');
  const invalidFields = await form.evaluate((element) => Array.from((element as HTMLFormElement).elements)
    .filter((control): control is HTMLInputElement | HTMLSelectElement => control instanceof HTMLInputElement || control instanceof HTMLSelectElement)
    .filter((control) => !control.checkValidity())
    .map((control) => ({ name: control.name, value: control.value, pattern: control instanceof HTMLInputElement ? control.pattern : '', message: control.validationMessage })));
  expect(invalidFields).toEqual([]);
  const requestObserved = new Promise<string>((resolve) => page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes(`/sites/${siteId}/production-events/${eventId}/outputs/${outputId}/measurements`)) resolve(request.url());
  }));
  await form.getByRole('button', { name: 'Record observation' }).click();
  await expect.poll(() => submitted).not.toBeNull();
  expect(await requestObserved).toContain('/api/v1/sites/');
  expect(submitted).toMatchObject({ kind: 'DECLARED', quantityGrams: '5.250000', sourceValue: '5.25', sourceUnit: 'g', sourceRole: 'WITNESS', sourcePartyId, methodCode: 'FIELD_SCALE', instrumentRef: 'SCALE-001', evidenceRef: 'notebook-page-4' });
  await expect(page.getByText(/Declared · 5\.250000 g/)).toBeVisible();
  await expect(page.getByText(new RegExp(`source party ${sourcePartyId}`))).toBeVisible();
  await expect(page.getByText(/This event-detail API does not return the measurement recorder ID/)).toBeVisible();
});

test('gold trade proposal is revised append-only and accepted by the seller and counterparty', async ({ page, context }) => {
  const tokenIdentities = await installSessionRoutes(context);
  let currentTrade: ReturnType<typeof tradeFixture> | null = null;
  let revised = false;
  let sellerDecision = false;
  let createBody: Record<string, unknown> | null = null;
  const decisionActors: string[] = [];
  await context.route('**/api/v1/gold-trades**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const token = route.request().headers().authorization?.replace(/^Bearer /, '') ?? '';
    const actor = tokenIdentities.get(token);
    if (url.pathname === '/api/v1/gold-trades' && method === 'POST') {
      createBody = route.request().postDataJSON() as Record<string, unknown>;
      expect(route.request().headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/i);
      currentTrade = tradeFixture();
      return route.fulfill({ status: 201, json: { id: tradeId, tradeCode: 'GT-TEST-01', status: 'PROPOSED', lines: [] } });
    }
    if (url.pathname === `/api/v1/gold-trades/${tradeId}/lines/${lineId}/revisions` && method === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      expect(body).toMatchObject({ quantityGrams: '1.250000', unitPrice: '5100', correctionReason: 'Corrected agreed weight' });
      revised = true;
      if (currentTrade) {
        currentTrade.lines[0].is_current = false;
        currentTrade.lines.push({ ...currentTrade.lines[0], id: nextLineId, revision_no: 2, revision_kind: 'REVISION', transaction_quantity_g: '1.250000', unit_price: '5100', line_amount: '6375.00000000', supersedes_line_id: lineId, correction_reason: 'Corrected agreed weight', is_current: true, measurements: [], custody: [] });
      }
      return route.fulfill({ status: 201, json: { revisionNo: 2, id: nextLineId } });
    }
    const decisionMatch = url.pathname.match(new RegExp(`/api/v1/gold-trades/${tradeId}/lines/([^/]+)/decisions`));
    if (decisionMatch && method === 'POST') {
      const line = decisionMatch[1];
      expect(line).toBe(revised ? nextLineId : lineId);
      expect(route.request().headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/i);
      const body = route.request().postDataJSON() as Record<string, unknown>;
      expect(body).toMatchObject({ decision: 'ACCEPT', quantityGrams: revised ? '1.250000' : '1.000000' });
      expect(actor?.role).toMatch(/MERCHANT/);
      const party = actor?.scopeId ?? '';
      decisionActors.push(party);
      if (party === sellerPartyId) sellerDecision = true;
      currentTrade?.decisions.push({
        id: `decision-${decisionActors.length}`, gold_trade_line_id: line, actor_user_id: actor?.userId ?? '', actor_party_id: party,
        decision: 'ACCEPT', occurred_at: String(body.occurredAt), reason: null, evidence_ref: null,
        accepted_quantity_g: String(body.quantityGrams), accepted_unit_price: String(body.unitPrice), accepted_line_amount: null, accepted_deduction_amount: null,
      });
      const agreed = decisionActors.includes(sellerPartyId) && decisionActors.includes(buyerPartyId);
      if (agreed && currentTrade) {
        currentTrade.status = 'AGREED';
        const currentLine = currentTrade.lines.find((row) => row.id === line);
        if (currentLine) { currentLine.is_accepted = true; currentLine.accepted_trade_quantity_g = String(body.quantityGrams); }
        currentTrade.reconciliation.amountAgreed = currentTrade.lines.filter((row) => row.is_current).map((row) => Number(row.line_amount)).reduce((sum, value) => sum + value, 0).toFixed(8);
        currentTrade.reconciliation.amountOutstanding = currentTrade.reconciliation.amountAgreed;
      }
      return route.fulfill({ status: 201, json: { id: `decision-${decisionActors.length}`, status: agreed ? 'AGREED' : 'PENDING_COUNTERPARTY' } });
    }
    if (url.pathname === `/api/v1/gold-trades/${tradeId}` && method === 'GET' && currentTrade) {
      const copy = structuredClone(currentTrade);
      if (!sellerDecision && actor?.scopeId === buyerPartyId) return route.fulfill({ status: 404, json: { error: { message: 'The requested resource was not found.' } } });
      return route.fulfill({ json: copy });
    }
    return route.fulfill({ status: 404, json: { error: { message: 'Not found' } } });
  });

  await signIn(page, 'seller@example.test');
  let navigation = page.getByRole('navigation', { name: 'Workspace navigation' });
  await navigation.getByRole('button', { name: 'Gold trades' }).click();
  await page.getByRole('button', { name: 'Create trade proposal' }).click();
  const proposal = page.getByRole('form', { name: 'Create gold trade proposal' });
  await proposal.getByLabel('Seller party ID').fill(sellerPartyId);
  await proposal.getByLabel('Buyer party ID').fill(buyerPartyId);
  await proposal.getByLabel('Source gold batch ID').fill(batchId);
  await proposal.getByLabel('Proposed quantity (g)').fill('1');
  await proposal.getByLabel('Proposed unit price').fill('5000');
  await proposal.getByRole('button', { name: 'Submit proposal' }).click();
  await expect(page.getByText(/Proposal GT-TEST-01 is open with status PROPOSED/)).toBeVisible();
  expect(createBody).toMatchObject({ tradeKind: 'PURCHASE', sellerPartyId, buyerPartyId, currencyCode: 'KES', lines: [{ batchId, quantityGrams: '1', unitPrice: '5000' }] });

  await page.getByRole('button', { name: 'Propose a revision' }).click();
  const revision = page.getByRole('form', { name: `Revise trade line ${lineId}` });
  await revision.getByLabel('New quantity (g)').fill('1.250000');
  await revision.getByLabel('New unit price').fill('5100');
  await revision.getByLabel('Correction reason').fill('Corrected agreed weight');
  await revision.getByRole('button', { name: 'Append revision' }).click();
  await expect(page.getByText(/revision 2 \(current\)/i)).toBeVisible();
  await expect(page.getByText(/Revision of line bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb: Corrected agreed weight/)).toBeVisible();
  await expect(page.getByRole('form', { name: 'Record seller party decision' })).toBeVisible();
  await page.getByRole('form', { name: 'Record seller party decision' }).getByRole('button', { name: 'Record seller decision' }).click();
  expect(decisionActors).toEqual([sellerPartyId]);
  await expect(page.getByRole('row').filter({ hasText: sellerPartyId })).toContainText('Accept');
  await expect(page.getByRole('form', { name: 'Record seller party decision' })).toHaveCount(0);

  const buyerPage = await context.newPage();
  await signIn(buyerPage, 'buyer@example.test');
  navigation = buyerPage.getByRole('navigation', { name: 'Workspace navigation' });
  await navigation.getByRole('button', { name: 'Gold trades' }).click();
  await buyerPage.getByLabel('Gold trade ID').fill(tradeId);
  await buyerPage.getByRole('button', { name: 'Open authorized trade' }).click();
  const buyerDecision = buyerPage.getByRole('form', { name: 'Record buyer party decision' });
  await expect(buyerDecision).toBeVisible();
  await expect(buyerPage.getByRole('form', { name: 'Record seller party decision' })).toHaveCount(0);
  await buyerDecision.getByRole('button', { name: 'Record buyer decision' }).click();
  await expect(buyerPage.getByText('Agreed', { exact: true })).toBeVisible();
  expect(decisionActors).toEqual([sellerPartyId, buyerPartyId]);
  await expect(buyerPage.getByText(/Both parties recorded acceptance/)).toBeVisible();
});

test('gold-trade measurement and assay corrections append successors with predecessor and reason', async ({ page, context }) => {
  await installSessionRoutes(context);
  const currentTrade = tradeFixture();
  currentTrade.lines[0].measurements = [{
    id: sourceMeasurementId, line_id: lineId, measurement_set_id: measureSetId, measurement_kind: 'MEASURED', quantity_g: '1.000000',
    source_value: '1', source_unit_code: 'g', conversion_version: 'canonical-mass-v1', source_role: 'RECORDER', source_party_id: sellerPartyId,
    entered_by_user_id: identities['seller@example.test'].userId, occurred_at_claimed: '2026-11-20T10:00:00.000Z', entered_at: '2026-11-20T10:01:00.000Z',
    method_code: 'SCALE', instrument_ref: null, evidence_ref: null, supersedes_measurement_id: null,
  }];
  currentTrade.assays = [{
    id: sourceAssayId, batch_id: batchId, gold_trade_line_id: lineId, assayer_party_id: sellerPartyId, sample_ref: 'SAMPLE-1', method_ref: 'OBSERVATION',
    result_value: '91.0', result_unit: 'percent', observed_at: '2026-11-20T10:00:00.000Z', evidence_ref: null, correction_of_id: null,
    correction_reason: null, recorded_by_user_id: identities['seller@example.test'].userId,
  }];
  const correctionBodies: Record<string, Record<string, unknown>> = {};
  await context.route('**/api/v1/gold-trades**', async (route) => {
    const url = new URL(route.request().url());
    const match = url.pathname.match(new RegExp(`/api/v1/gold-trades/${tradeId}/lines/${lineId}/(measurements|assays)$`));
    if (route.request().method() === 'GET' && url.pathname === `/api/v1/gold-trades/${tradeId}`) return route.fulfill({ json: structuredClone(currentTrade) });
    if (route.request().method() === 'POST' && match) {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      expect(route.request().headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/i);
      correctionBodies[match[1]] = body;
      if (match[1] === 'measurements') currentTrade.lines[0].measurements.push({
        id: '12121212-3434-4434-8434-121212121212', line_id: lineId, measurement_set_id: measureSetId, measurement_kind: 'MEASURED', quantity_g: '1.050000',
        source_value: '1.05', source_unit_code: 'g', conversion_version: 'canonical-mass-v1', source_role: 'RECORDER', source_party_id: sellerPartyId,
        entered_by_user_id: identities['seller@example.test'].userId, occurred_at_claimed: String(body.occurredAt), entered_at: new Date().toISOString(), method_code: null, instrument_ref: null,
        evidence_ref: null, supersedes_measurement_id: String(body.supersedesMeasurementId),
      });
      else currentTrade.assays.push({
        id: '34343434-1212-4412-8412-343434343434', batch_id: batchId, gold_trade_line_id: lineId, assayer_party_id: sellerPartyId, sample_ref: 'SAMPLE-1',
        method_ref: 'OBSERVATION', result_value: String(body.resultValue), result_unit: String(body.resultUnit), observed_at: String(body.observedAt), evidence_ref: null,
        correction_of_id: String(body.correctionOfId), correction_reason: String(body.correctionReason), recorded_by_user_id: identities['seller@example.test'].userId,
      });
      return route.fulfill({ status: 201, json: { id: 'correction-record', status: 'RECORDED' } });
    }
    return route.fulfill({ status: 404, json: { error: { message: 'Not found' } } });
  });

  await signIn(page, 'seller@example.test');
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Measurements & assays' }).click();
  await page.getByLabel('Gold trade ID').fill(tradeId);
  await page.getByRole('button', { name: 'Open authorized trade' }).click();
  await expect(page.getByText(/Recorded assay observation/)).toBeVisible();

  await page.getByRole('button', { name: 'Record trade measurement' }).click();
  await page.getByRole('button', { name: `Correct measured ${sourceMeasurementId}` }).click();
  const measurementCorrection = page.getByRole('form', { name: 'Correct trade measurement' });
  await measurementCorrection.getByLabel('Source value').fill('1.05');
  await measurementCorrection.getByLabel('Correction reason').fill('Scale reading corrected');
  await measurementCorrection.getByRole('button', { name: 'Append measurement correction' }).click();
  await expect.poll(() => correctionBodies.measurements).toMatchObject({ supersedesMeasurementId: sourceMeasurementId, correctionReason: 'Scale reading corrected', quantityGrams: '1.050000' });
  await expect(page.getByText(new RegExp(`Correction of ${sourceMeasurementId}`))).toBeVisible();

  await page.getByRole('button', { name: 'Record assay observation' }).click();
  await page.getByRole('button', { name: `Correct assay ${sourceAssayId}` }).click();
  const assayCorrection = page.getByRole('form', { name: 'Correct assay observation' });
  await assayCorrection.getByLabel('Result value').fill('92.5');
  await assayCorrection.getByLabel('Correction reason').fill('Transcription corrected');
  await assayCorrection.getByRole('button', { name: 'Append assay correction' }).click();
  await expect.poll(() => correctionBodies.assays).toMatchObject({ correctionOfId: sourceAssayId, correctionReason: 'Transcription corrected', resultValue: '92.5', resultUnit: 'percent' });
  await expect(page.getByText(new RegExp(`Correction of ${sourceAssayId}: Transcription corrected`))).toBeVisible();
});

test('payment reporting and seller decision stay distinct from verified money movement', async ({ page, context }) => {
  const tokenIdentities = await installSessionRoutes(context);
  const currentTrade = tradeFixture('AGREED');
  currentTrade.lines[0].is_accepted = true;
  currentTrade.lines[0].accepted_trade_quantity_g = '1.000000';
  currentTrade.reconciliation.amountAgreed = '5000.00000000';
  currentTrade.reconciliation.amountOutstanding = '5000.00000000';
  currentTrade.reconciliation.unresolvedLines = [];
  let reportBody: Record<string, unknown> | null = null;
  let decisionBody: Record<string, unknown> | null = null;
  await context.route('**/api/v1/gold-trades**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const actor = tokenIdentities.get(route.request().headers().authorization?.replace(/^Bearer /, '') ?? '');
    if (method === 'GET' && url.pathname === `/api/v1/gold-trades/${tradeId}`) return route.fulfill({ json: structuredClone(currentTrade) });
    if (method === 'POST' && url.pathname === `/api/v1/gold-trades/${tradeId}/payments`) {
      reportBody = route.request().postDataJSON() as Record<string, unknown>;
      expect(actor?.scopeId).toBe(buyerPartyId);
      expect(route.request().headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/i);
      currentTrade.payments.push({ id: paymentId, currency_code: 'KES', payer_party_id: buyerPartyId, payee_party_id: sellerPartyId, created_at: new Date().toISOString(), reported_amount: '2500.00000000', settled_amount: '0.00000000', current_status: 'REPORTED', disputed: false });
      currentTrade.reconciliation.amountReported = '2500.00000000';
      currentTrade.reconciliation.amountOutstanding = '5000.00000000';
      return route.fulfill({ status: 201, json: { id: paymentId, status: 'REPORTED', amount: '2500.00000000', currencyCode: 'KES', verifiedExternally: false } });
    }
    if (method === 'POST' && url.pathname === `/api/v1/gold-trades/${tradeId}/payments/${paymentId}/decisions`) {
      decisionBody = route.request().postDataJSON() as Record<string, unknown>;
      expect(actor?.scopeId).toBe(sellerPartyId);
      expect(route.request().headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/i);
      currentTrade.payments[0].settled_amount = '2500.00000000';
      currentTrade.payments[0].current_status = 'CONFIRMED';
      currentTrade.reconciliation.amountSettled = '2500.00000000';
      currentTrade.reconciliation.amountOutstanding = '2500.00000000';
      return route.fulfill({ status: 201, json: { id: 'payment-event-1', paymentId, status: 'CONFIRMED', amount: '2500.00000000', currencyCode: 'KES' } });
    }
    return route.fulfill({ status: 404, json: { error: { message: 'Not found' } } });
  });

  await signIn(page, 'buyer@example.test');
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Payments' }).click();
  await page.getByLabel('Gold trade ID').fill(tradeId);
  await page.getByRole('button', { name: 'Open authorized trade' }).click();
  const paymentForm = page.getByRole('form', { name: 'Report payment' });
  await expect(paymentForm).toBeVisible();
  await paymentForm.getByLabel('Amount').fill('2500');
  await paymentForm.getByLabel('Recorded method code').fill('CASH_RECORDED');
  await paymentForm.getByLabel('Reference', { exact: true }).fill('fictional-ref-1');
  await paymentForm.getByRole('button', { name: 'Report payment' }).click();
  expect(reportBody).toMatchObject({ amount: '2500', methodCode: 'CASH_RECORDED', reference: 'fictional-ref-1' });
  await expect(page.getByRole('row').filter({ hasText: paymentId })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: paymentId }).getByRole('cell', { name: 'Reported', exact: true })).toBeVisible();
  await expect(page.getByText(/does not connect to M-Pesa or a bank/)).toBeVisible();
  const buyerDecision = page.getByRole('form', { name: `Decide payment ${paymentId}` });
  await expect(buyerDecision.getByRole('combobox', { name: 'Decision' })).toHaveValue('DISPUTE');
  await expect(buyerDecision.getByRole('combobox', { name: 'Decision' }).locator('option[value="CONFIRM"]')).toHaveCount(0);

  const sellerPage = await context.newPage();
  await signIn(sellerPage, 'seller@example.test');
  await sellerPage.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Payments' }).click();
  await sellerPage.getByLabel('Gold trade ID').fill(tradeId);
  await sellerPage.getByRole('button', { name: 'Open authorized trade' }).click();
  const decisionForm = sellerPage.getByRole('form', { name: `Decide payment ${paymentId}` });
  await expect(decisionForm).toBeVisible();
  await expect(sellerPage.getByRole('form', { name: 'Report payment' })).toHaveCount(0);
  await expect(decisionForm.getByRole('combobox', { name: 'Decision' })).toHaveValue('CONFIRM');
  await decisionForm.getByRole('button', { name: 'Record payment decision' }).click();
  expect(decisionBody).toMatchObject({ decision: 'CONFIRM' });
  await expect(sellerPage.getByRole('row').filter({ hasText: paymentId }).getByRole('cell', { name: 'Confirmed', exact: true })).toBeVisible();
  await expect(sellerPage.getByText('KES 2500.00000000').first()).toBeVisible();
  await expect(sellerPage.getByText(/not independently verified money movement/)).toBeVisible();
});

test('auditor measurement detail is read-only and unsupported trade review stays denied', async ({ page, context }) => {
  await installSessionRoutes(context);
  const event = { id: eventId, event_code: 'PROD-AUDIT-01', event_kind: 'PRODUCTION', occurred_at_claimed: '2026-11-20T08:00:00.000Z', recorded_at: '2026-11-20T08:10:00.000Z', current_status: 'RECORDED', hole_id: holeId, hole_code: 'H-01', output_count: 1 };
  await context.route(`**/api/v1/sites/${siteId}/production-events`, (route) => route.fulfill({ json: [event] }));
  await context.route('**/api/v1/processing-events', (route) => route.fulfill({ json: [] }));
  await context.route(`**/api/v1/sites/${siteId}/production-events/${eventId}`, (route) => route.fulfill({ json: {
    ...event, auditSequence: 2, participants: [], captureProvenance: null,
    outputs: [{ id: outputId, batch_id: batchId, batch_code: 'ORE-AUDIT', material_kind: 'GOLD_BEARING_FEED', measurement_set_id: measureSetId, measurements: [] }],
  } }));
  await context.route(`**/api/v1/gold-trades/${tradeId}`, (route: Route) => route.fulfill({ status: 404, json: { error: { message: 'The requested resource was not found.' } } }));

  await signIn(page, 'auditor@example.test');
  const navigation = page.getByRole('navigation', { name: 'Workspace navigation' });
  await navigation.getByRole('button', { name: 'Measurements & assays' }).click();
  await page.getByRole('button', { name: 'PROD-AUDIT-01' }).click();
  await expect(page.getByText('ORE-AUDIT')).toBeVisible();
  await expect(page.getByRole('form', { name: /Record measurement/ })).toHaveCount(0);

  await navigation.getByRole('button', { name: 'Gold trades' }).click();
  await expect(page.getByRole('button', { name: 'Create trade proposal' })).toHaveCount(0);
  await page.getByLabel('Gold trade ID').fill(tradeId);
  await page.getByRole('button', { name: 'Open authorized trade' }).click();
  await expect(page.getByRole('alert')).toContainText('Auditor grant');
  await expect(page.getByRole('form', { name: /party decision/ })).toHaveCount(0);

  await navigation.getByRole('button', { name: 'Payments' }).click();
  await expect(page.getByRole('form', { name: 'Report payment' })).toHaveCount(0);
  await expect(page.getByText(/Auditor controls are read-only/)).toBeVisible();
});
