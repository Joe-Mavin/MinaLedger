import { expect, test } from '@playwright/test';

const userId = '18111111-1111-4111-8111-111111111111';
const partyId = '28222222-2222-4222-8222-222222222222';
const facilityId = '38333333-3333-4333-8333-333333333333';
const siteId = '48444444-4444-4444-8444-444444444444';
const sourceEventId = '58555555-5555-4555-8555-555555555555';
const sourceOutputId = '68666666-6666-4666-8666-666666666666';
const processEventId = '78777777-7777-4777-8777-777777777777';
const token = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.test`;

const sourceDetail = {
  id: sourceEventId,
  event_code: 'EVT-SOURCE-01',
  hole_id: '98999999-9999-4999-8999-999999999999',
  outputs: [{
    id: sourceOutputId, batch_id: 'a8aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', batch_code: 'BATCH-SOURCE-01',
    material_kind: 'GOLD_BEARING_FEED', measurements: [{ id: 'b8bbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', measurement_kind: 'MEASURED', quantity_g: '10.000000' }],
  }],
};

test('Dora operator records processing from the selected production output in the operations UI', async ({ page }) => {
  let createdEvent: Record<string, unknown> | null = null;
  const roles = [{ role_code: 'DORA_OPERATOR', scope_kind: 'FACILITY', scope_id: facilityId }];
  await page.route('**/api/v1/auth/login', (route) => route.fulfill({ json: {
    token, user: { id: userId, personPartyId: partyId, displayName: 'Fictional Dora Operator' }, roles,
  } }));
  await page.route('**/api/v1/me', (route) => route.fulfill({ json: {
    id: userId, person_party_id: partyId, display_name: 'Fictional Dora Operator', roles,
  } }));
  await page.route('**/api/v1/sites', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/doras', (route) => route.fulfill({ json: [{ id: facilityId, name: 'Fictional Dora', status: 'ACTIVE', site_ids: [siteId] }] }));
  await page.route(`**/api/v1/sites/${siteId}/doras`, (route) => route.fulfill({ status: 404, json: { error: { message: 'No site-scoped grant.' } } }));
  await page.route('**/api/v1/processing-events', (route) => route.fulfill({ json: createdEvent ? [{
    id: processEventId, event_code: 'EVT-PROCESS-01', occurred_at_claimed: new Date().toISOString(), recorded_at: new Date().toISOString(), current_status: 'SUBMITTED',
    processing_facility_id: facilityId, processing_facility_name: 'Fictional Dora', input_count: 1, output_count: 1, sourceSiteIds: [siteId], sourceHoleIds: [sourceDetail.hole_id],
  }] : [] }));
  await page.route('**/api/v1/recovery-facilities', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/consignments', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/residue-sales', (route) => route.fulfill({ json: [] }));
  await page.route(`**/api/v1/doras/${facilityId}/stockpiles`, (route) => route.fulfill({ json: [] }));
  await page.route(`**/api/v1/doras/${facilityId}/residue-outputs`, (route) => route.fulfill({ json: [] }));
  await page.route(`**/api/v1/doras/${facilityId}/recovery-destinations`, (route) => route.fulfill({ json: [] }));
  await page.route(`**/api/v1/sites/${siteId}/production-events`, (route) => route.fulfill({ json: [{ id: sourceEventId, event_code: 'EVT-SOURCE-01', hole_id: sourceDetail.hole_id }] }));
  await page.route(`**/api/v1/sites/${siteId}/production-events/${sourceEventId}`, (route) => route.fulfill({ json: sourceDetail }));
  await page.route(`**/api/v1/processing-events/${processEventId}`, (route) => route.fulfill({ json: {
    id: processEventId, event_code: 'EVT-PROCESS-01', occurred_at_claimed: new Date().toISOString(), recorded_at: new Date().toISOString(), current_status: 'SUBMITTED',
    processing_facility_id: facilityId, processing_facility_name: 'Fictional Dora', inputs: [{ id: 'c8cccccc-cccc-4ccc-8ccc-cccccccccccc', batch_id: sourceDetail.outputs[0].batch_id, batch_code: 'BATCH-SOURCE-01', material_kind: 'GOLD_BEARING_FEED', source_production_output_id: sourceOutputId, source_event_id: sourceEventId, measurements: [{ id: 'd8dddddd-dddd-4ddd-8ddd-dddddddddddd', measurement_kind: 'MEASURED', quantity_g: '9.5', source_role: 'WEIGHER' }] }],
    outputs: [{ id: 'e8eeeeee-eeee-4eee-8eee-eeeeeeeeeeee', batch_id: 'f8ffffff-ffff-4fff-8fff-ffffffffffff', batch_code: 'BATCH-RESIDUE-01', material_kind: 'RESIDUE', output_role: 'DORA_RETAINED_RESIDUE', measurements: [{ id: 'a9aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', measurement_kind: 'MEASURED', quantity_g: '4.2', source_role: 'WEIGHER' }] }],
  } }));
  await page.route(`**/api/v1/sites/${siteId}/processing-events`, async (route) => {
    createdEvent = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({ status: 201, json: { id: processEventId, eventCode: 'EVT-PROCESS-01', processingFacilityId: facilityId } });
  });

  await page.goto('/');
  await page.getByLabel('Email').fill('dora@example.test');
  await page.getByLabel('Password').fill('fictional-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Material operations' }).click();
  await expect(page.getByRole('heading', { name: 'Dora register' })).toBeVisible();
  await page.getByLabel('Authorized source site').selectOption(siteId);
  await expect(page.getByLabel('Production event')).toHaveValue(sourceEventId);
  await page.getByLabel('Quantity (g)').nth(0).fill('9.5');
  await page.getByLabel('Source value').nth(0).fill('9.5');
  await page.getByLabel('Quantity (g)').nth(1).fill('4.2');
  await page.getByRole('button', { name: 'Record processing event' }).click();

  await expect.poll(() => createdEvent).not.toBeNull();
  const payload = createdEvent as { processingFacilityId: string; inputs: Array<{ sourceProductionOutputId: string; measurements: Array<{ quantityGrams: string }> }>; outputs: Array<{ materialKind: string; outputRole: string; measurements: Array<{ quantityGrams: string }> }> };
  expect(payload.processingFacilityId).toBe(facilityId);
  expect(payload.inputs[0].sourceProductionOutputId).toBe(sourceOutputId);
  expect(payload.inputs[0].measurements[0].quantityGrams).toBe('9.5');
  expect(payload.outputs[0]).toMatchObject({ materialKind: 'RESIDUE', outputRole: 'DORA_RETAINED_RESIDUE' });
  expect(payload.outputs[0].measurements[0].quantityGrams).toBe('4.2');
  await expect(page.getByText('BATCH-RESIDUE-01')).toBeVisible();
  await expect(page.getByText(new RegExp(`source output ${sourceOutputId}`))).toBeVisible();
});

test('Auditor can inspect operations but receives no mutation controls', async ({ page }) => {
  const roles = [{ role_code: 'AUDITOR', scope_kind: 'FACILITY', scope_id: facilityId }];
  await page.route('**/api/v1/auth/login', (route) => route.fulfill({ json: {
    token, user: { id: userId, personPartyId: partyId, displayName: 'Fictional Auditor' }, roles,
  } }));
  await page.route('**/api/v1/me', (route) => route.fulfill({ json: { id: userId, person_party_id: partyId, display_name: 'Fictional Auditor', roles } }));
  await page.route('**/api/v1/sites', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/doras', (route) => route.fulfill({ json: [{ id: facilityId, name: 'Fictional Dora', status: 'ACTIVE', site_ids: [siteId] }] }));
  await page.route('**/api/v1/processing-events', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/recovery-facilities', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/consignments', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/residue-sales', (route) => route.fulfill({ json: [] }));
  await page.route(`**/api/v1/sites/${siteId}/doras`, (route) => route.fulfill({ status: 404, json: { error: { message: 'No site-scoped grant.' } } }));
  await page.route(`**/api/v1/doras/${facilityId}/stockpiles`, (route) => route.fulfill({ json: [] }));
  await page.route(`**/api/v1/doras/${facilityId}/residue-outputs`, (route) => route.fulfill({ json: [] }));

  await page.goto('/');
  await page.getByLabel('Email').fill('auditor@example.test');
  await page.getByLabel('Password').fill('fictional-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Material operations' }).click();
  await expect(page.getByRole('heading', { name: 'Dora register' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Update this Dora' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Register Dora at an authorized site' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Record actual source material and outputs' })).toHaveCount(0);
});

test('Dora workspace records a measured residue intake and a balance-preserving stockpile transfer', async ({ page }) => {
  const sourceLocationId = 'c8111111-1111-4111-8111-111111111111';
  const destinationLocationId = 'c8222222-2222-4222-8222-222222222222';
  const batchId = 'c8333333-3333-4333-8333-333333333333';
  let intakeBody: Record<string, unknown> | null = null;
  let transferBody: Record<string, unknown> | null = null;
  const roles = [{ role_code: 'DORA_OPERATOR', scope_kind: 'FACILITY', scope_id: facilityId }];
  await page.route('**/api/v1/auth/login', (route) => route.fulfill({ json: { token, user: { id: userId, personPartyId: partyId, displayName: 'Fictional Dora Operator' }, roles } }));
  await page.route('**/api/v1/me', (route) => route.fulfill({ json: { id: userId, person_party_id: partyId, display_name: 'Fictional Dora Operator', roles } }));
  await page.route('**/api/v1/sites', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/doras', (route) => route.fulfill({ json: [{ id: facilityId, name: 'Fictional Dora', status: 'ACTIVE', site_ids: [siteId] }] }));
  await page.route('**/api/v1/processing-events', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/recovery-facilities', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/consignments', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/residue-sales', (route) => route.fulfill({ json: [] }));
  await page.route(`**/api/v1/doras/${facilityId}/stockpiles`, (route) => route.fulfill({ json: [
    { id: sourceLocationId, stockpile_code: 'PILE-A', location_code: 'LOC-A', processing_facility_id: facilityId, batch_id: batchId, batch_code: 'BATCH-RESIDUE', material_kind: 'RESIDUE', origin_processing_event_id: processEventId, origin_output_id: sourceOutputId, quantity_g: '10.000000' },
    { id: destinationLocationId, stockpile_code: 'PILE-B', location_code: 'LOC-B', processing_facility_id: facilityId, batch_id: null, batch_code: null, material_kind: null, origin_processing_event_id: null, origin_output_id: null, quantity_g: null },
  ] }));
  await page.route(`**/api/v1/doras/${facilityId}/residue-outputs`, (route) => route.fulfill({ json: [{
    output_id: sourceOutputId, processing_event_id: processEventId, event_code: 'EVT-PROCESS-01', occurred_at_claimed: new Date().toISOString(),
    batch_id: batchId, batch_code: 'BATCH-RESIDUE', material_kind: 'RESIDUE', output_role: 'DORA_RETAINED_RESIDUE', measurement_id: 'd8444444-4444-4444-8444-444444444444',
    measurement_kind: 'MEASURED', quantity_g: '10.000000', source_value: '10', source_unit_code: 'g', conversion_version: 'manual-v1', source_role: 'RECORDER', method_code: 'scale-v1', evidence_ref: 'ticket-1',
  }] }));
  await page.route(`**/api/v1/doras/${facilityId}/recovery-destinations`, (route) => route.fulfill({ json: [] }));
  await page.route(`**/api/v1/inventory/locations/${sourceLocationId}/balances`, (route) => route.fulfill({ json: [{ batch_id: batchId, batch_code: 'BATCH-RESIDUE', material_kind: 'RESIDUE', quantity_g: '10.000000' }] }));
  await page.route(`**/api/v1/inventory/locations/${destinationLocationId}/balances`, (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/inventory/locations/*/movements', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/stockpiles/*/intake', async (route) => { intakeBody = route.request().postDataJSON() as Record<string, unknown>; await route.fulfill({ status: 201, json: { id: 'movement-intake' } }); });
  await page.route('**/api/v1/stockpiles/*/transfers', async (route) => { transferBody = route.request().postDataJSON() as Record<string, unknown>; await route.fulfill({ status: 201, json: { id: 'movement-transfer' } }); });

  await page.goto('/');
  await page.getByLabel('Email').fill('dora@example.test');
  await page.getByLabel('Password').fill('fictional-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Material operations' }).click();
  await page.getByRole('tab', { name: 'Residue inventory' }).click();
  await page.getByLabel('Source output').selectOption(sourceOutputId);
  await page.getByLabel('Destination stockpile').first().selectOption(sourceLocationId);
  await page.getByRole('button', { name: 'Receive residue' }).click();
  await expect.poll(() => intakeBody).not.toBeNull();
  expect((intakeBody as { outputs: Array<{ outputId: string; measurementId: string }> }).outputs[0]).toMatchObject({ outputId: sourceOutputId, measurementId: 'd8444444-4444-4444-8444-444444444444' });

  await page.getByLabel('Destination stockpile').last().selectOption(destinationLocationId);
  await page.getByLabel('Quantity to move (g)').fill('3.25');
  await page.getByLabel('Movement evidence reference').fill('paper-count-22');
  await page.getByRole('button', { name: 'Transfer material' }).click();
  await expect.poll(() => transferBody).not.toBeNull();
  const transfer = transferBody as { destinationStockpileId: string; items: Array<{ batchId: string; quantityGrams: string }>; evidenceRef: string };
  expect(transfer.destinationStockpileId).toBe(destinationLocationId);
  expect(transfer.items[0]).toMatchObject({ batchId, quantityGrams: '3.25' });
  expect(transfer.evidenceRef).toBe('paper-count-22');
});

test('Recovery operator can receive a dispatched consignment and record a sourced recovery event', async ({ page }) => {
  const recoveryFacilityId = 'd8111111-1111-4111-8111-111111111111';
  const locationId = 'd8222222-2222-4222-8222-222222222222';
  const consignmentId = 'd8333333-3333-4333-8333-333333333333';
  const itemId = 'd8444444-4444-4444-8444-444444444444';
  const residueBatchId = 'd8555555-5555-4555-8555-555555555555';
  const receiptItemId = 'd8666666-6666-4666-8666-666666666666';
  const recoveryEventId = 'd8777777-7777-4777-8777-777777777777';
  let receiptBody: Record<string, unknown> | null = null;
  let recoveryBody: Record<string, unknown> | null = null;
  const roles = [{ role_code: 'RECOVERY_FACILITY_OPERATOR', scope_kind: 'FACILITY', scope_id: recoveryFacilityId }];
  const detail = (status: string) => ({
    id: consignmentId, consignment_code: 'CON-01', status, destination_recovery_facility_id: recoveryFacilityId,
    transit_location_id: 'd8888888-8888-4888-8888-888888888888', created_at: new Date().toISOString(), dispatched_at: new Date().toISOString(), received_at: null,
    items: [{ id: itemId, batch_id: residueBatchId, batch_code: 'BATCH-RESIDUE-1', source_location_id: sourceOutputId, line_no: 1, dispatch_measurement_id: 'd8999999-9999-4999-8999-999999999999', dispatched_quantity_g: '5.000000', accepted_receipt_quantity_g: '0.000000', disputed_receipt_quantity_g: '0.000000', rejected_receipt_quantity_g: '0.000000' }],
    transportLegs: [], receipts: [], receiptItems: [], custodyTransfers: [],
  });
  await page.route('**/api/v1/auth/login', (route) => route.fulfill({ json: { token, user: { id: userId, personPartyId: partyId, displayName: 'Fictional Recovery Operator' }, roles } }));
  await page.route('**/api/v1/me', (route) => route.fulfill({ json: { id: userId, person_party_id: partyId, display_name: 'Fictional Recovery Operator', roles } }));
  await page.route('**/api/v1/sites', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/doras', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/processing-events', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/v1/recovery-facilities', (route) => route.fulfill({ json: [{ id: recoveryFacilityId, name: 'Fictional Recovery Facility', status: 'ACTIVE', party_id: partyId }] }));
  await page.route('**/api/v1/consignments', (route) => route.fulfill({ json: [{ id: consignmentId, consignment_code: 'CON-01', status: 'DISPATCHED', destination_recovery_facility_id: recoveryFacilityId, created_at: new Date().toISOString(), dispatched_at: new Date().toISOString(), received_at: null }] }));
  await page.route('**/api/v1/residue-sales', (route) => route.fulfill({ json: [] }));
  await page.route(`**/api/v1/recovery-facilities/${recoveryFacilityId}`, (route) => route.fulfill({ json: { id: recoveryFacilityId, name: 'Fictional Recovery Facility', status: 'ACTIVE', party_id: partyId, locations: [{ id: locationId, location_code: 'REC-LOC-1', physical_place_ref: 'safe-01', location_ref: 'safe-01' }] } }));
  await page.route(`**/api/v1/inventory/locations/${locationId}/balances`, (route) => route.fulfill({ json: [] }));
  await page.route(`**/api/v1/recovery-facilities/${recoveryFacilityId}/eligible-inputs`, (route) => route.fulfill({ json: [{ receipt_item_id: receiptItemId, consignment_id: consignmentId, batch_id: residueBatchId, batch_code: 'BATCH-RESIDUE-1', material_kind: 'RESIDUE', consignment_code: 'CON-01', quantity_g: '5.000000', available_quantity_g: '5.000000', evidence_ref: null }] }));
  await page.route(`**/api/v1/recovery-events/${recoveryEventId}`, (route) => route.fulfill({ json: { id: recoveryEventId, event_code: 'EVT-REC-1', occurred_at_claimed: new Date().toISOString(), method_ref: 'gravity-v1', inputs: [], outputs: [], stages: [], variances: [] } }));
  await page.route(`**/api/v1/consignments/${consignmentId}`, (route) => route.fulfill({ json: detail(receiptBody ? 'RECEIVED' : 'DISPATCHED') }));
  await page.route(`**/api/v1/consignments/${consignmentId}/receipts`, async (route) => { receiptBody = route.request().postDataJSON() as Record<string, unknown>; await route.fulfill({ status: 201, json: { id: 'receipt-1' } }); });
  await page.route(`**/api/v1/recovery-facilities/${recoveryFacilityId}/recovery-events`, async (route) => {
    if (route.request().method() === 'POST') { recoveryBody = route.request().postDataJSON() as Record<string, unknown>; await route.fulfill({ status: 201, json: { id: recoveryEventId } }); }
    else await route.fulfill({ json: recoveryBody ? [{ id: recoveryEventId, event_code: 'EVT-REC-1', occurred_at_claimed: new Date().toISOString(), recorded_at: new Date().toISOString(), current_status: 'SUBMITTED', method_ref: 'gravity-v1', input_count: 1, output_count: 1 }] : [] });
  });

  await page.goto('/');
  await page.getByLabel('Email').fill('recovery@example.test');
  await page.getByLabel('Password').fill('fictional-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('button', { name: 'Material operations' }).click();
  await page.getByRole('tab', { name: 'Consignments & custody' }).click();
  await page.getByLabel('Destination recovery location').selectOption(locationId);
  await page.getByLabel(`Quantity received (g)`).fill('4.75');
  await page.getByRole('button', { name: 'Record receipt' }).click();
  await expect.poll(() => receiptBody).not.toBeNull();
  expect((receiptBody as { items: Array<{ consignmentItemId: string; quantityGrams: string; outcome: string }> }).items[0]).toMatchObject({ consignmentItemId: itemId, quantityGrams: '4.75', outcome: 'ACCEPTED' });

  await page.getByRole('tab', { name: 'Recovery' }).click();
  await page.getByLabel('Recovery inventory location').selectOption(locationId);
  await page.getByLabel('Accepted residue receipt').selectOption(receiptItemId);
  await page.getByLabel('Consumed quantity (g)').fill('2');
  await page.getByLabel('Recorded output quantity (g)').fill('0.35');
  await page.getByLabel('Method reference').fill('gravity-v1');
  await page.getByRole('button', { name: 'Record recovery event' }).click();
  await expect.poll(() => recoveryBody).not.toBeNull();
  const recovery = recoveryBody as { inputs: Array<{ batchId: string; quantityGrams: string; sources: Array<{ receiptItemId: string; quantityGrams: string }> }>; outputs: Array<{ materialKind: string; outputRole: string; quantityGrams: string }> };
  expect(recovery.inputs[0]).toMatchObject({ batchId: residueBatchId, quantityGrams: '2', sources: [{ receiptItemId, quantityGrams: '2' }] });
  expect(recovery.outputs[0]).toMatchObject({ materialKind: 'RECOVERED_GOLD', outputRole: 'RECOVERED_GOLD', quantityGrams: '0.35' });
});
