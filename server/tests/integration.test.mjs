import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error('Set TEST_DATABASE_URL to a dedicated PostgreSQL database whose name ends in _test.');
process.env.DATABASE_URL = testUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-that-is-at-least-thirty-two-bytes';
process.env.LOG_LEVEL = 'silent';

const { QueryTypes } = await import('sequelize');
const { sequelize } = await import('../src/database/connection.mjs');
const { runMigrations } = await import('../src/database/migrate.mjs');
const { app } = await import('../src/app.mjs');
const { appendAuditEvent, hashPayload, hashStreamEntry, readAuditStream, verifyAuditEntries, verifyAuditStream } = await import('../src/modules/audit/audit.service.mjs');
const { checkpointManifestHash, claimAuditCheckpoint, processAuditCheckpoint, verifyCheckpointSnapshot } = await import('../src/modules/audit/checkpoint.service.mjs');
const { postTransfer } = await import('../src/modules/inventory/inventory.service.mjs');
const request = (await import('supertest')).default;

const ids = {};
const password = 'minaledger-test-password-2026';
const happenedAt = '2026-11-10T08:30:00.000Z';
let resetDone = false;

const db = (sql, replacements = {}, transaction = undefined, type = undefined) => sequelize.query(sql, {
  replacements, transaction, ...(type ? { type } : {}),
});
const sqlError = (code) => (error) => error.parent?.code === code || error.original?.code === code;

async function seedParty(kind, displayName, organisationKind = null) {
  const partyId = randomUUID();
  await db(`INSERT INTO party(id,party_kind) VALUES (:id,:kind)`, { id: partyId, kind });
  if (kind === 'PERSON') await db(`INSERT INTO person_profile(party_id,display_name) VALUES (:id,:name)`, { id: partyId, name: displayName });
  else await db(`INSERT INTO organisation_profile(party_id,display_name,organisation_kind) VALUES (:id,:name,:kind)`, { id: partyId, name: displayName, kind: organisationKind ?? 'TEST_ORGANISATION' });
  return partyId;
}

async function seedUser(email, displayName, role = null) {
  const partyId = await seedParty('PERSON', displayName);
  const userId = randomUUID();
  const passwordHash = await bcrypt.hash(password, 8);
  await db(`INSERT INTO user_account(id,person_party_id,email,password_hash) VALUES (:id,:partyId,:email,:hash)`, { id: userId, partyId, email, hash: passwordHash });
  let roleAssignmentId = null;
  if (role) {
    roleAssignmentId = randomUUID();
    await db(`INSERT INTO role_assignment(id,user_id,role_code,scope_kind,scope_id) VALUES (:id,:userId,:roleCode,:scopeKind,:scopeId)`, { id: roleAssignmentId, userId, ...role });
  }
  return { userId, partyId, roleAssignmentId };
}

function testToken(userId) {
  return jwt.sign({}, process.env.JWT_SECRET, {
    subject: userId,
    issuer: 'minaledger-api',
    audience: 'minaledger-client',
    expiresIn: '15m',
    jwtid: randomUUID(),
  });
}

function makeSyncEnvelope({ userId, partyId, roleCode, scopeKind, scopeId, commandType, payload, occurredAt = happenedAt, actualParticipant = { identityState: 'UNKNOWN' }, captureProvenance, expectedVersion, parentCommandIds = [], revisionOf }) {
  return {
    clientMutationId: randomUUID(), deviceId: randomUUID(), recorderUserId: userId,
    actualParticipant, actingContext: { partyId, roleCode, scopeKind, scopeId }, commandType, schemaVersion: 1,
    payload, clientCreatedAt: new Date().toISOString(), clientTimezone: 'Africa/Nairobi', occurredAtClaimed: occurredAt,
    ...(expectedVersion ? { expectedVersion } : {}), parentCommandIds, ...(revisionOf ? { revisionOf } : {}),
    ...(captureProvenance ? { captureProvenance } : {}), evidence: [], localState: 'pending_upload',
  };
}

async function versionSyncEnvelope(token, envelope) {
  const response = await request(app).post('/api/v1/sync/versions').set('Authorization', `Bearer ${token}`).send(envelope);
  assert.equal(response.status, 200, response.text);
  return { ...envelope, expectedVersion: response.body.expectedVersion };
}

async function submitSyncEnvelope(token, envelope) {
  return request(app).post('/api/v1/sync/commands')
    .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', envelope.clientMutationId).send(envelope);
}

function validRecoveryEventBody(locationId) {
  return {
    recoveryInventoryLocationId: locationId,
    occurredAt: happenedAt,
    inputs: [{
      batchId: randomUUID(), quantityGrams: '1.000000',
      sources: [{ receiptItemId: randomUUID(), quantityGrams: '1.000000' }],
    }],
    outputs: [{ materialKind: 'RECOVERED_GOLD', outputRole: 'RECOVERED_GOLD', quantityGrams: '0.100000' }],
  };
}

async function createLocation(code, kind = 'OTHER') {
  const id = randomUUID();
  await db(`INSERT INTO inventory_location(id,location_code,location_kind,custodian_party_id) VALUES (:id,:code,:kind,:partyId)`, { id, code, kind, partyId: ids.adminPartyId });
  return id;
}

async function createOpeningBalance(batchId, locationId, quantityGrams) {
  const countId = randomUUID();
  const measurementSetId = randomUUID();
  const measurementId = randomUUID();
  const movementId = randomUUID();
  const lineId = randomUUID();
  await sequelize.transaction(async (transaction) => {
    await db(`INSERT INTO inventory_count(id,location_id,batch_id,counted_at_claimed,actor_user_id,evidence_ref) VALUES (:id,:locationId,:batchId,:countedAt,:actor,'fictional-test-count')`, { id: countId, locationId, batchId, countedAt: happenedAt, actor: ids.adminUserId }, transaction);
    await db(`INSERT INTO material_measurement_set(id,batch_id,inventory_count_id) VALUES (:id,:batchId,:countId)`, { id: measurementSetId, batchId, countId }, transaction);
    await db(`INSERT INTO material_measurement(id,measurement_set_id,measurement_kind,quantity_g,source_value,source_unit_code,conversion_version,source_role,source_party_id,entered_by_user_id,occurred_at_claimed)
      VALUES (:id,:setId,'MEASURED',:quantity,:quantity,'g','test-v1','RECORDER',:partyId,:userId,:occurredAt)`, { id: measurementId, setId: measurementSetId, quantity: quantityGrams, partyId: ids.adminPartyId, userId: ids.adminUserId, occurredAt: happenedAt }, transaction);
    await db(`INSERT INTO inventory_movement(id,movement_kind,current_status,actor_user_id,occurred_at_claimed) VALUES (:id,'OPENING_BALANCE','DRAFT',:actor,:occurredAt)`, { id: movementId, actor: ids.adminUserId, occurredAt: happenedAt }, transaction);
    await db(`INSERT INTO inventory_movement_line(id,inventory_movement_id,batch_id,location_id,direction,posted_quantity_g,basis_measurement_set_id,basis_measurement_id,inventory_count_id,line_no)
      VALUES (:id,:movementId,:batchId,:locationId,'IN',:quantity,:setId,:measurementId,:countId,1)`, { id: lineId, movementId, batchId, locationId, quantity: quantityGrams, setId: measurementSetId, measurementId, countId }, transaction);
    await db(`UPDATE inventory_movement SET current_status='ACCEPTED' WHERE id=:id`, { id: movementId }, transaction);
  });
  return { movementId, countId, measurementSetId, measurementId, lineId };
}

async function createMeasuredConsignment(batchId, quantityGrams, suffix) {
  const transitLocationId = randomUUID();
  const consignmentId = randomUUID();
  const itemId = randomUUID();
  const measurementSetId = randomUUID();
  const measurementId = randomUUID();
  await sequelize.transaction(async (transaction) => {
    await db(`INSERT INTO inventory_location(id,location_code,location_kind,custodian_party_id) VALUES (:id,:code,'CONSIGNMENT_TRANSIT',:partyId)`, { id: transitLocationId, code: `TRANSIT-${suffix}`, partyId: ids.adminPartyId }, transaction);
    await db(`INSERT INTO consignment(id,consignment_code,sender_party_id,recipient_party_id,transit_location_id) VALUES (:id,:code,:sender,:recipient,:locationId)`, { id: consignmentId, code: `CON-${suffix}`, sender: ids.adminPartyId, recipient: ids.minerPartyId, locationId: transitLocationId }, transaction);
    await db(`INSERT INTO consignment_item(id,consignment_id,batch_id,line_no) VALUES (:id,:consignmentId,:batchId,1)`, { id: itemId, consignmentId, batchId }, transaction);
    await db(`INSERT INTO material_measurement_set(id,batch_id,consignment_item_id,consignment_stage) VALUES (:id,:batchId,:itemId,'DISPATCH')`, { id: measurementSetId, batchId, itemId }, transaction);
    await db(`INSERT INTO material_measurement(id,measurement_set_id,measurement_kind,quantity_g,source_value,source_unit_code,conversion_version,source_role,source_party_id,entered_by_user_id,occurred_at_claimed)
      VALUES (:id,:setId,'MEASURED',:quantity,:quantity,'g','test-v1','WEIGHER',:partyId,:userId,:occurredAt)`, { id: measurementId, setId: measurementSetId, quantity: quantityGrams, partyId: ids.adminPartyId, userId: ids.adminUserId, occurredAt: happenedAt }, transaction);
  });
  const common = { batchId, measurementSetId, measurementId, consignmentItemId: itemId, consignmentStage: 'DISPATCH', quantityGrams };
  return { consignmentId, itemId, transitLocationId, measurementSetId, measurementId, out: { ...common, direction: 'OUT' }, in: { ...common, locationId: transitLocationId, direction: 'IN' } };
}

before(async () => {
  await sequelize.authenticate();
  const [database] = await db('SELECT current_database() AS name', {}, undefined, QueryTypes.SELECT);
  assert.match(database.name, /_test$/i, 'refusing to reset a database not explicitly named as a test database');
  await db('DROP SCHEMA IF EXISTS public CASCADE');
  await db('CREATE SCHEMA public');
  await runMigrations(sequelize);
  resetDone = true;
  ids.adminPartyId = await seedParty('PERSON', 'Test Administrator');
  ids.adminUserId = randomUUID();
  await db(`INSERT INTO user_account(id,person_party_id,email,password_hash) VALUES (:id,:partyId,'admin@example.test',:hash)`, { id: ids.adminUserId, partyId: ids.adminPartyId, hash: await bcrypt.hash(password, 8) });
  await db(`INSERT INTO role_assignment(id,user_id,role_code,scope_kind,scope_id) VALUES (:id,:userId,'SYSTEM_ADMIN','GLOBAL','global')`, { id: randomUUID(), userId: ids.adminUserId });
  const pilot = await seedUser('pilot@example.test', 'Fictional Field Recorder', { roleCode: 'FIELD_OFFICER', scopeKind: 'PILOT', scopeId: 'default' });
  ids.pilotUserId = pilot.userId;
  ids.pilotPartyId = pilot.partyId;
  ids.adminToken = testToken(ids.adminUserId);
  ids.pilotToken = testToken(pilot.userId);
});

after(async () => {
  if (resetDone) {
    const [database] = await db('SELECT current_database() AS name', {}, undefined, QueryTypes.SELECT);
    if (/_test$/i.test(database.name)) {
      await db('DROP SCHEMA IF EXISTS public CASCADE');
      await db('CREATE SCHEMA public');
    }
  }
  await sequelize.close();
});

test('PostgreSQL foundation integrity and API integration', async (t) => {
  await t.test('Phase 2, Phase 3 and Phase 4 integrity migrations roll back and reapply before use', async () => {
    const rollbackSql = await readFile(new URL('../src/database/rollback/003_phase_two_integrity.sql', import.meta.url), 'utf8');
    const migrationSql = await readFile(new URL('../src/database/migrations/003_phase_two_integrity.sql', import.meta.url), 'utf8');
    const rollbackProbe = new Error('migration rollback probe');
    await assert.rejects(sequelize.transaction(async (transaction) => {
      await sequelize.query(rollbackSql, { transaction, raw: true });
      await sequelize.query(migrationSql, { transaction, raw: true });
      throw rollbackProbe;
    }), (error) => error === rollbackProbe);
    const columns = await db(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='hole_party_role'
        AND column_name IN ('source_reference','evidence_ref') ORDER BY column_name`, {}, undefined, QueryTypes.SELECT);
    assert.deepEqual(columns.map((row) => row.column_name), ['evidence_ref', 'source_reference']);

    const rollbackFour = await readFile(new URL('../src/database/rollback/004_phase_three_residue_recovery.sql', import.meta.url), 'utf8');
    const migrationFour = await readFile(new URL('../src/database/migrations/004_phase_three_residue_recovery.sql', import.meta.url), 'utf8');
    const phaseThreeRollbackProbe = new Error('Phase 3 migration rollback probe');
    await assert.rejects(sequelize.transaction(async (transaction) => {
      await sequelize.query(rollbackFour, { transaction, raw: true });
      await sequelize.query(migrationFour, { transaction, raw: true });
      throw phaseThreeRollbackProbe;
    }), (error) => error === phaseThreeRollbackProbe);
    const phaseThreeTables = await db(`SELECT table_name AS phase_three_table_name FROM information_schema.tables WHERE table_schema='public'
      AND table_name IN ('consignment_receipt','recovery_output_input_link','residue_sale_decision_event','phase_three_migration_marker') ORDER BY table_name`, {}, undefined, QueryTypes.SELECT);
    assert.deepEqual(phaseThreeTables.map((row) => row.phase_three_table_name), ['consignment_receipt', 'phase_three_migration_marker', 'recovery_output_input_link', 'residue_sale_decision_event']);

    const rollbackFive = await readFile(new URL('../src/database/rollback/005_phase_three_integrity_corrections.sql', import.meta.url), 'utf8');
    const migrationFive = await readFile(new URL('../src/database/migrations/005_phase_three_integrity_corrections.sql', import.meta.url), 'utf8');
    const phaseThreeCorrectionsRollbackProbe = new Error('Phase 3 corrections rollback probe');
    await assert.rejects(sequelize.transaction(async (transaction) => {
      await sequelize.query(rollbackFive, { transaction, raw: true });
      await sequelize.query(migrationFive, { transaction, raw: true });
      throw phaseThreeCorrectionsRollbackProbe;
    }), (error) => error === phaseThreeCorrectionsRollbackProbe);
    const correctionColumns = await db(`SELECT column_name FROM information_schema.columns WHERE table_schema='public'
      AND ((table_name='consignment_receipt_item' AND column_name IN ('supersedes_receipt_item_id','correction_reason'))
        OR (table_name='residue_sale_line' AND column_name='resolves_decision_mismatch')) ORDER BY table_name,column_name`, {}, undefined, QueryTypes.SELECT);
    assert.equal(correctionColumns.length, 3);

    const rollbackSix = await readFile(new URL('../src/database/rollback/006_phase_four_gold_trades.sql', import.meta.url), 'utf8');
    const migrationSix = await readFile(new URL('../src/database/migrations/006_phase_four_gold_trades.sql', import.meta.url), 'utf8');
    const phaseFourRollbackProbe = new Error('Phase 4 migration rollback probe');
    await assert.rejects(sequelize.transaction(async (transaction) => {
      await sequelize.query(rollbackSix, { transaction, raw: true });
      await sequelize.query(migrationSix, { transaction, raw: true });
      throw phaseFourRollbackProbe;
    }), (error) => error === phaseFourRollbackProbe);
    const phaseFourColumns = await db(`SELECT column_name FROM information_schema.columns WHERE table_schema='public'
      AND table_name='gold_trade' AND column_name IN ('trade_date','created_by_user_id','status') ORDER BY column_name`, {}, undefined, QueryTypes.SELECT);
    assert.deepEqual(phaseFourColumns.map((row) => row.column_name), ['created_by_user_id','status','trade_date']);
    const phaseFourCustodyColumns = await db(`SELECT column_name FROM information_schema.columns WHERE table_schema='public'
      AND table_name='custody_transfer' AND column_name IN ('gold_trade_line_id','quantity_g','measurement_set_id','measurement_id') ORDER BY column_name`, {}, undefined, QueryTypes.SELECT);
    assert.deepEqual(phaseFourCustodyColumns.map((row) => row.column_name), ['gold_trade_line_id','measurement_id','measurement_set_id','quantity_g']);

    const rollbackSeven = await readFile(new URL('../src/database/rollback/007_phase_four_integrity_corrections.sql', import.meta.url), 'utf8');
    const migrationSeven = await readFile(new URL('../src/database/migrations/007_phase_four_integrity_corrections.sql', import.meta.url), 'utf8');
    const phaseFourCorrectionsRollbackProbe = new Error('Phase 4 correction migration rollback probe');
    await assert.rejects(sequelize.transaction(async (transaction) => {
      await sequelize.query(rollbackSeven, { transaction, raw: true });
      await sequelize.query(migrationSeven, { transaction, raw: true });
      throw phaseFourCorrectionsRollbackProbe;
    }), (error) => error === phaseFourCorrectionsRollbackProbe);
    const phaseFourCorrectionColumns = await db(`SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public'
      AND ((table_name='gold_trade_line' AND column_name='is_current')
        OR (table_name='assay_record' AND column_name='gold_trade_line_id')) ORDER BY table_name,column_name`, {}, undefined, QueryTypes.SELECT);
    assert.deepEqual(phaseFourCorrectionColumns.map((row) => `${row.table_name}.${row.column_name}`), ['assay_record.gold_trade_line_id','gold_trade_line.is_current']);
    const phaseFourCorrectionIndex = await db(`SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname='gold_trade_line_one_current_batch_idx'`, {}, undefined, QueryTypes.SELECT);
    assert.equal(phaseFourCorrectionIndex.length, 1);

    const rollbackEight = await readFile(new URL('../src/database/rollback/008_phase_four_observation_integrity.sql', import.meta.url), 'utf8');
    const migrationEight = await readFile(new URL('../src/database/migrations/008_phase_four_observation_integrity.sql', import.meta.url), 'utf8');
    const phaseFourObservationRollbackProbe = new Error('Phase 4 observation integrity migration rollback probe');
    await assert.rejects(sequelize.transaction(async (transaction) => {
      await sequelize.query(rollbackEight, { transaction, raw: true });
      await sequelize.query(migrationEight, { transaction, raw: true });
      throw phaseFourObservationRollbackProbe;
    }), (error) => error === phaseFourObservationRollbackProbe);
    const phaseFourObservationTriggers = await db(`SELECT event_object_table AS table_name FROM information_schema.triggers
      WHERE trigger_schema='public' AND trigger_name='phase_four_observation_state_guard' ORDER BY event_object_table`, {}, undefined, QueryTypes.SELECT);
    assert.deepEqual(phaseFourObservationTriggers.map((row) => row.table_name), ['assay_record', 'material_measurement']);

    const rollbackNine = await readFile(new URL('../src/database/rollback/009_offline_sync.sql', import.meta.url), 'utf8');
    const migrationNine = await readFile(new URL('../src/database/migrations/009_offline_sync.sql', import.meta.url), 'utf8');
    const phaseFiveRollbackProbe = new Error('Phase 5 sync migration rollback probe');
    await assert.rejects(sequelize.transaction(async (transaction) => {
      await sequelize.query(rollbackNine, { transaction, raw: true });
      const absent = await sequelize.query(`SELECT to_regclass('public.sync_command_receipt') AS table_name`, { type: QueryTypes.SELECT, transaction });
      assert.equal(absent[0].table_name, null);
      await sequelize.query(migrationNine, { transaction, raw: true });
      const present = await sequelize.query(`SELECT to_regclass('public.sync_command_receipt') AS table_name`, { type: QueryTypes.SELECT, transaction });
      assert.equal(present[0].table_name, 'sync_command_receipt');
      throw phaseFiveRollbackProbe;
    }), (error) => error === phaseFiveRollbackProbe);
    const phaseFiveTables = await db(`SELECT table_name AS sync_table_name FROM information_schema.tables WHERE table_schema='public'
      AND table_name IN ('sync_command_receipt','sync_command_receipt_history') ORDER BY table_name`, {}, undefined, QueryTypes.SELECT);
    assert.deepEqual(phaseFiveTables.map((row) => row.sync_table_name), ['sync_command_receipt', 'sync_command_receipt_history']);

    const rollbackTen = await readFile(new URL('../src/database/rollback/010_offline_workflows.sql', import.meta.url), 'utf8');
    const migrationTen = await readFile(new URL('../src/database/migrations/010_offline_workflows.sql', import.meta.url), 'utf8');
    const phaseFiveWorkflowRollbackProbe = new Error('Phase 5 workflow migration rollback probe');
    await assert.rejects(sequelize.transaction(async (transaction) => {
      await sequelize.query(rollbackTen, { transaction, raw: true });
      await sequelize.query(migrationTen, { transaction, raw: true });
      const constraint = await sequelize.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid='sync_command_receipt'::regclass AND conname='sync_command_receipt_command_type_check'`, { type: QueryTypes.SELECT, transaction });
      assert.match(constraint[0].definition, /production\.allocation\.propose/);
      throw phaseFiveWorkflowRollbackProbe;
    }), (error) => error === phaseFiveWorkflowRollbackProbe);

    const rollbackEleven = await readFile(new URL('../src/database/rollback/011_audit_checkpoints.sql', import.meta.url), 'utf8');
    const migrationEleven = await readFile(new URL('../src/database/migrations/011_audit_checkpoints.sql', import.meta.url), 'utf8');
    const phaseSixRollbackProbe = new Error('Phase 6 checkpoint migration rollback probe');
    await assert.rejects(sequelize.transaction(async (transaction) => {
      await sequelize.query(rollbackEleven, { transaction, raw: true });
      const absent = await sequelize.query(`SELECT to_regclass('public.audit_checkpoint') AS table_name`, { type: QueryTypes.SELECT, transaction });
      assert.equal(absent[0].table_name, null);
      await sequelize.query(migrationEleven, { transaction, raw: true });
      const present = await sequelize.query(`SELECT to_regclass('public.audit_checkpoint') AS table_name`, { type: QueryTypes.SELECT, transaction });
      assert.equal(present[0].table_name, 'audit_checkpoint');
      throw phaseSixRollbackProbe;
    }), (error) => error === phaseSixRollbackProbe);
  });

  await t.test('health, password authentication, live roles, and profile serialization', async () => {
    const live = await request(app).get('/livez');
    assert.equal(live.status, 200);
    assert.equal(live.body.status, 'ok');
    assert.equal(Object.hasOwn(live.body, 'database'), false);
    const ready = await request(app).get('/readyz');
    assert.equal(ready.status, 200);
    assert.equal(ready.body.database, 'connected');
    const health = await request(app).get('/healthz');
    assert.equal(health.status, 200);
    assert.equal(health.body.database, 'connected');
    const login = await request(app).post('/api/v1/auth/login').send({ email: 'pilot@example.test', password });
    assert.equal(login.status, 200);
    assert.ok(login.body.token);
    assert.equal(JSON.stringify(login.body).includes('password_hash'), false);
    const profile = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${login.body.token}`);
    assert.equal(profile.status, 200);
    assert.equal(profile.body.roles[0].role_code, 'FIELD_OFFICER');
    assert.equal((await request(app).post('/api/v1/auth/login').send({ email: 'pilot@example.test', password: 'wrong-password' })).status, 401);
    assert.equal((await request(app).get('/api/v1/me')).status, 401);
  });

  await t.test('idempotent site commands and allowed site metadata updates', async () => {
    const body = { siteCode: 'FICTIONAL-SITE-01', name: 'Fictional Test Site', countyCode: 'TEST', locality: 'Test locality' };
    const key = randomUUID();
    const created = await request(app).post('/api/v1/sites').set('Authorization', `Bearer ${ids.pilotToken}`).set('Idempotency-Key', key).send(body);
    assert.equal(created.status, 201, created.text);
    ids.siteId = created.body.id;
    const retry = await request(app).post('/api/v1/sites').set('Authorization', `Bearer ${ids.pilotToken}`).set('Idempotency-Key', key).send(body);
    assert.equal(retry.status, 201);
    assert.equal(retry.body.id, ids.siteId);
    assert.equal(retry.body.replayed, true);
    const changed = await request(app).post('/api/v1/sites').set('Authorization', `Bearer ${ids.pilotToken}`).set('Idempotency-Key', key).send({ ...body, name: 'Changed body' });
    assert.equal(changed.status, 409);
    const updated = await request(app).patch(`/api/v1/sites/${ids.siteId}`).set('Authorization', `Bearer ${ids.pilotToken}`).set('Idempotency-Key', randomUUID()).send({ locality: 'Updated fictional locality' });
    assert.equal(updated.status, 200, updated.text);
    assert.equal(updated.body.locality, 'Updated fictional locality');
    assert.equal((await verifyAuditStream('mining_site', ids.siteId)).valid, true);
  });

  await t.test('account administration, scoped roles, and organisation boundaries', async () => {
    const accountBody = { email: 'site-recorder@example.test', displayName: 'Fictional Site Recorder', password };
    const account = await request(app).post('/api/v1/admin/users').set('Authorization', `Bearer ${ids.adminToken}`).set('Idempotency-Key', randomUUID()).send(accountBody);
    assert.equal(account.status, 201, account.text);
    assert.equal(JSON.stringify(account.body).includes('password'), false);
    ids.siteUserId = account.body.id;
    ids.siteUserPartyId = account.body.personPartyId;
    const grant = await request(app).post(`/api/v1/admin/users/${ids.siteUserId}/roles`).set('Authorization', `Bearer ${ids.adminToken}`).set('Idempotency-Key', randomUUID()).send({ roleCode: 'FIELD_OFFICER', scopeKind: 'SITE', scopeId: ids.siteId });
    assert.equal(grant.status, 201, grant.text);
    ids.siteRoleId = grant.body.id;
    ids.siteToken = testToken(ids.siteUserId);

    ids.siteBId = randomUUID();
    await db(`INSERT INTO mining_site(id,site_code,name,created_by_user_id) VALUES (:id,'FICTIONAL-SITE-02','Second Fictional Site',:userId)`, { id: ids.siteBId, userId: ids.adminUserId });
    assert.equal((await request(app).get(`/api/v1/sites/${ids.siteId}`).set('Authorization', `Bearer ${ids.siteToken}`)).status, 200);
    assert.equal((await request(app).get(`/api/v1/sites/${ids.siteBId}`).set('Authorization', `Bearer ${ids.siteToken}`)).status, 403);
    const listed = await request(app).get('/api/v1/sites').set('Authorization', `Bearer ${ids.siteToken}`);
    assert.deepEqual(listed.body.map((site) => site.id), [ids.siteId]);
    assert.equal((await request(app).get(`/api/v1/sites/${ids.siteId}`).set('Authorization', `Bearer ${ids.adminToken}`)).status, 403);

    const org = await request(app).post('/api/v1/admin/organisations').set('Authorization', `Bearer ${ids.adminToken}`).set('Idempotency-Key', randomUUID()).send({ displayName: 'Fictional Optional Group', organisationKind: 'COOPERATIVE' });
    assert.equal(org.status, 201, org.text);
    ids.organisationId = org.body.partyId;
    const orgUser = await seedUser('organisation-recorder@example.test', 'Fictional Organisation Recorder');
    await db(`INSERT INTO organisation_membership(id,person_party_id,organisation_party_id,membership_type) VALUES (:id,:personId,:orgId,'MEMBER')`, { id: randomUUID(), personId: orgUser.partyId, orgId: ids.organisationId });
    await db(`INSERT INTO role_assignment(id,user_id,role_code,scope_kind,scope_id) VALUES (:id,:userId,'MINING_OPERATOR','ORGANISATION',:orgId)`, { id: randomUUID(), userId: orgUser.userId, orgId: ids.organisationId });
    await db(`INSERT INTO site_party_role(id,site_id,party_id,role_code,asserted_by_user_id) VALUES (:id,:siteId,:partyId,'SITE_OPERATOR',:actor)`, { id: randomUUID(), siteId: ids.siteBId, partyId: ids.organisationId, actor: ids.adminUserId });
    ids.orgToken = testToken(orgUser.userId);
    ids.orgUserId = orgUser.userId;
    ids.orgUserPartyId = orgUser.partyId;
    assert.equal((await request(app).get(`/api/v1/sites/${ids.siteBId}`).set('Authorization', `Bearer ${ids.orgToken}`)).status, 200);
    assert.equal((await request(app).get(`/api/v1/sites/${ids.siteId}`).set('Authorization', `Bearer ${ids.orgToken}`)).status, 403);
    const orgSites = await request(app).get('/api/v1/sites').set('Authorization', `Bearer ${ids.orgToken}`);
    assert.deepEqual(orgSites.body.map((site) => site.id), [ids.siteBId]);
  });

  await t.test('site holes and multiple independently typed participants', async () => {
    const first = await request(app).post(`/api/v1/sites/${ids.siteId}/holes`).set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', randomUUID()).send({ holeCode: 'HOLE-A', name: 'First fictional hole' });
    const second = await request(app).post(`/api/v1/sites/${ids.siteId}/holes`).set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', randomUUID()).send({ holeCode: 'HOLE-B', name: 'Second fictional hole' });
    assert.equal(first.status, 201, first.text);
    assert.equal(second.status, 201, second.text);
    ids.holeId = first.body.id;
    ids.secondHoleId = second.body.id;
    assert.equal((await request(app).get(`/api/v1/sites/${ids.siteId}/holes`).set('Authorization', `Bearer ${ids.siteToken}`)).body.length, 2);

    const landownerA = await request(app).post(`/api/v1/sites/${ids.siteId}/participants`).set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', randomUUID()).send({ partyKind: 'PERSON', displayName: 'Fictional Landowner A', participantKind: 'LANDOWNER', roleCode: 'LANDOWNER' });
    const landownerB = await request(app).post(`/api/v1/sites/${ids.siteId}/participants`).set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', randomUUID()).send({ partyKind: 'PERSON', displayName: 'Fictional Landowner B', participantKind: 'LANDOWNER', roleCode: 'LANDOWNER' });
    const miner = await request(app).post(`/api/v1/sites/${ids.siteId}/participants`).set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', randomUUID()).send({ partyKind: 'PERSON', displayName: 'Fictional Miner', participantKind: 'MINER', roleCode: 'MINER', holeId: ids.holeId });
    assert.equal(landownerA.status, 201, landownerA.text);
    assert.equal(landownerB.status, 201, landownerB.text);
    assert.equal(miner.status, 201, miner.text);
    ids.minerPartyId = miner.body.partyId;
    const samePartyOperator = await request(app).post(`/api/v1/sites/${ids.siteId}/participants`).set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', randomUUID()).send({
      partyId: ids.minerPartyId, participantKind: 'MINING_OPERATOR', roleCode: 'HOLE_OPERATOR', holeId: ids.holeId,
      validFrom: '2026-11-01T00:00:00.000Z',
    });
    const secondHoleOperator = await request(app).post(`/api/v1/sites/${ids.siteId}/participants`).set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', randomUUID()).send({
      partyKind: 'PERSON', displayName: 'Fictional Independent Hole Operator', participantKind: 'MINING_OPERATOR', roleCode: 'HOLE_OPERATOR', holeId: ids.secondHoleId,
      validFrom: '2026-11-01T00:00:00.000Z',
    });
    assert.equal(samePartyOperator.status, 201, samePartyOperator.text);
    assert.equal(secondHoleOperator.status, 201, secondHoleOperator.text);
    ids.holeOperatorRelationshipId = samePartyOperator.body.relationshipId;
    ids.secondHoleOperatorPartyId = secondHoleOperator.body.partyId;
    const participants = await request(app).get(`/api/v1/sites/${ids.siteId}/participants`).set('Authorization', `Bearer ${ids.siteToken}`);
    assert.equal(participants.body.length, 5);
    assert.equal(new Set(participants.body.filter((row) => row.role_code === 'LANDOWNER').map((row) => row.party_id)).size, 2);
    const minerRelationship = participants.body.find((row) => row.relationship_id === miner.body.relationshipId);
    assert.equal(minerRelationship.party_kind, 'PERSON');
    assert.equal(minerRelationship.relationship_kind, 'HOLE');
    assert.equal(minerRelationship.hole_id, ids.holeId);
    assert.deepEqual(minerRelationship.participant_categories.map((category) => category.participantKind).sort(), ['MINER', 'MINING_OPERATOR']);
    assert.ok(minerRelationship.participant_categories.every((category) => category.validFrom));
    assert.equal(minerRelationship.relationship_status, 'ACTIVE');
    await assert.rejects(db(`INSERT INTO mining_hole(id,site_id,hole_code) VALUES (:id,:siteId,'INVALID-HOLE')`, { id: randomUUID(), siteId: randomUUID() }), sqlError('23503'));
    await assert.rejects(db(`INSERT INTO hole_party_role(id,hole_id,party_id,role_code,asserted_by_user_id) VALUES (:id,:holeId,:partyId,'NOT_A_ROLE',:actor)`, { id: randomUUID(), holeId: ids.holeId, partyId: ids.minerPartyId, actor: ids.siteUserId }), sqlError('23514'));
  });

  await t.test('production measurement attribution, rollback, ownership, and event-time provenance', async () => {
    const body = {
      holeId: ids.holeId, occurredAt: happenedAt, shiftOrPeriodRef: 'FICTIONAL-PERIOD-1',
      participantRelationshipIds: [ids.holeOperatorRelationshipId],
      captureProvenance: {
        actualParticipantPartyId: ids.minerPartyId, participantIdentityState: 'IDENTIFIED', sourceKind: 'ASSISTED_VERBAL',
        occurredAt: happenedAt, acknowledgement: { status: 'PENDING', reason: 'Awaiting participant review' },
      },
      outputs: [
        { materialKind: 'GOLD_BEARING_FEED', outputKind: 'TEST_FEED', measurements: [{ kind: 'MEASURED', quantityGrams: '10.000000', sourceValue: '10', sourceUnit: 'g', conversionVersion: 'test-v1', sourceRole: 'WITNESS', sourcePartyId: ids.minerPartyId, occurredAt: happenedAt }] },
        { materialKind: 'GOLD_DORE', outputKind: 'TEST_DORE', measurements: [{ kind: 'DECLARED', quantityGrams: '5.000000', sourceValue: '5', sourceUnit: 'g', conversionVersion: 'test-v1', sourceRole: 'RECORDER', occurredAt: happenedAt }] },
      ],
    };
    const response = await request(app).post(`/api/v1/sites/${ids.siteId}/production-events`).set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', randomUUID()).send(body);
    assert.equal(response.status, 201, response.text);
    ids.productionEventId = response.body.id;
    ids.outputs = response.body.outputs;
    ids.batchId = ids.outputs[0].batchId;
    ids.measurementSetId = ids.outputs[0].measurementSetId;
    ids.measurementId = ids.outputs[0].measurements[0].id;
    ids.secondBatchId = ids.outputs[1].batchId;
    assert.notEqual(new Date(response.body.recordedAt).toISOString(), happenedAt);
    const stored = await request(app).get(`/api/v1/sites/${ids.siteId}/production-events/${ids.productionEventId}`).set('Authorization', `Bearer ${ids.siteToken}`);
    assert.equal(stored.status, 200, stored.text);
    assert.equal(stored.body.outputs.length, 2);
    assert.equal(stored.body.outputs[0].measurements[0].quantity_g, '10.000000');
    assert.equal(stored.body.participants.length, 1);
    assert.equal(stored.body.participants[0].party_id, ids.minerPartyId);
    assert.equal(stored.body.captureProvenance.source_kind, 'ASSISTED_VERBAL');
    assert.equal(stored.body.captureProvenance.acknowledgement_status, 'PENDING');
    assert.equal((await db(`SELECT source_party_id FROM material_measurement WHERE id=:id`, { id: ids.measurementId }, undefined, QueryTypes.SELECT))[0].source_party_id, ids.minerPartyId);
    const columns = await db(`SELECT column_name FROM information_schema.columns WHERE table_name='material_batch' AND column_name LIKE '%quantity%'`, {}, undefined, QueryTypes.SELECT);
    assert.deepEqual(columns, []);

    await assert.rejects(sequelize.transaction(async (transaction) => {
      await db(`INSERT INTO material_batch(id,batch_code,material_kind) VALUES (:id,'NO-SOURCE','RESIDUE')`, { id: randomUUID() }, transaction);
      await db('SET CONSTRAINTS ALL IMMEDIATE', {}, transaction);
    }), sqlError('23514'));
    await assert.rejects(db(`INSERT INTO material_measurement_set(id,batch_id) VALUES (:id,:batchId)`, { id: randomUUID(), batchId: ids.batchId }), sqlError('23514'));
    await assert.rejects(db(`INSERT INTO material_measurement_set(id,batch_id,material_event_output_id) VALUES (:id,:batchId,:outputId)`, { id: randomUUID(), batchId: ids.batchId, outputId: ids.outputs[1].id }), sqlError('23503'));
    await assert.rejects(db(`UPDATE material_measurement SET quantity_g=11 WHERE id=:id`, { id: ids.measurementId }), sqlError('55000'));
    await assert.rejects(db(`DELETE FROM material_measurement WHERE id=:id`, { id: ids.measurementId }), sqlError('55000'));
    const appended = await request(app).post(`/api/v1/sites/${ids.siteId}/production-events/${ids.productionEventId}/outputs/${ids.outputs[0].id}/measurements`).set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', randomUUID()).send({ kind: 'MEASURED', quantityGrams: '9.750000', sourceValue: '9.75', sourceUnit: 'g', conversionVersion: 'test-v1', sourceRole: 'WEIGHER', sourcePartyId: ids.minerPartyId, occurredAt: happenedAt });
    assert.equal(appended.status, 201, appended.text);
    assert.equal((await db(`SELECT quantity_g FROM material_measurement WHERE id=:id`, { id: ids.measurementId }, undefined, QueryTypes.SELECT))[0].quantity_g, '10.000000');
    const corrected = await request(app).post(`/api/v1/sites/${ids.siteId}/production-events/${ids.productionEventId}/outputs/${ids.outputs[0].id}/measurements`)
      .set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', randomUUID())
      .send({ kind: 'MEASURED', quantityGrams: '9.700000', sourceValue: '9.7', sourceUnit: 'g', conversionVersion: 'test-v1', sourceRole: 'WEIGHER', sourcePartyId: ids.minerPartyId, occurredAt: happenedAt, supersedesMeasurementId: appended.body.id });
    assert.equal(corrected.status, 201, corrected.text);
    assert.equal((await db(`SELECT supersedes_measurement_id FROM material_measurement WHERE id=:id`, { id: corrected.body.id }, undefined, QueryTypes.SELECT))[0].supersedes_measurement_id, appended.body.id);

    const unrelatedSourceParty = await seedParty('PERSON', 'Fictional Unrelated Weigher');
    const measurementCountsBeforeReject = await db(`SELECT
      (SELECT count(*)::int FROM material_measurement) AS measurements,
      (SELECT count(*)::int FROM audit_event) AS audit_events`, {}, undefined, QueryTypes.SELECT);
    const unrelatedMeasurement = await request(app).post(`/api/v1/sites/${ids.siteId}/production-events/${ids.productionEventId}/outputs/${ids.outputs[0].id}/measurements`)
      .set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', randomUUID())
      .send({ kind: 'MEASURED', quantityGrams: '9.600000', sourceValue: '9.6', sourceUnit: 'g', conversionVersion: 'test-v1', sourceRole: 'WEIGHER', sourcePartyId: unrelatedSourceParty, occurredAt: happenedAt });
    assert.equal(unrelatedMeasurement.status, 400, unrelatedMeasurement.text);
    assert.equal(unrelatedMeasurement.body.error.code, 'INVALID_MEASUREMENT_SOURCE');
    await assert.rejects(db(`INSERT INTO material_measurement(
      id,measurement_set_id,measurement_kind,quantity_g,source_value,source_unit_code,conversion_version,
      source_role,source_party_id,entered_by_user_id,occurred_at_claimed
    ) VALUES (:id,:setId,'MEASURED','1.000000','1','g','test-v1','WEIGHER',:sourceParty,:userId,:at)`, {
      id: randomUUID(), setId: ids.measurementSetId, sourceParty: unrelatedSourceParty, userId: ids.siteUserId, at: happenedAt,
    }), sqlError('23514'));
    const missingMeasurementSource = await request(app).post(`/api/v1/sites/${ids.siteId}/production-events/${ids.productionEventId}/outputs/${ids.outputs[0].id}/measurements`)
      .set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', randomUUID())
      .send({ kind: 'MEASURED', quantityGrams: '9.600000', sourceValue: '9.6', sourceUnit: 'g', conversionVersion: 'test-v1', sourceRole: 'WEIGHER', occurredAt: happenedAt });
    assert.equal(missingMeasurementSource.status, 400, missingMeasurementSource.text);
    assert.equal(missingMeasurementSource.body.error.code, 'INVALID_MEASUREMENT_SOURCE');
    const measurementCountsAfterReject = await db(`SELECT
      (SELECT count(*)::int FROM material_measurement) AS measurements,
      (SELECT count(*)::int FROM audit_event) AS audit_events`, {}, undefined, QueryTypes.SELECT);
    assert.deepEqual(measurementCountsAfterReject[0], measurementCountsBeforeReject[0]);

    const eventCountsBeforeReject = await db(`SELECT
      (SELECT count(*)::int FROM material_event WHERE event_kind='PRODUCTION') AS events,
      (SELECT count(*)::int FROM material_batch) AS batches,
      (SELECT count(*)::int FROM material_measurement) AS measurements,
      (SELECT count(*)::int FROM audit_event) AS audit_events`, {}, undefined, QueryTypes.SELECT);
    const invalidSourceEvent = await request(app).post(`/api/v1/sites/${ids.siteId}/production-events`)
      .set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', randomUUID()).send({
        holeId: ids.holeId, occurredAt: happenedAt, participantRelationshipIds: [ids.holeOperatorRelationshipId],
        outputs: [{ materialKind: 'RESIDUE', measurements: [{
          kind: 'MEASURED', quantityGrams: '1.000000', sourceValue: '1', sourceUnit: 'g',
          conversionVersion: 'test-v1', sourceRole: 'WEIGHER', sourcePartyId: unrelatedSourceParty, occurredAt: happenedAt,
        }] }],
      });
    assert.equal(invalidSourceEvent.status, 400, invalidSourceEvent.text);
    assert.equal(invalidSourceEvent.body.error.code, 'INVALID_MEASUREMENT_SOURCE');
    const eventCountsAfterReject = await db(`SELECT
      (SELECT count(*)::int FROM material_event WHERE event_kind='PRODUCTION') AS events,
      (SELECT count(*)::int FROM material_batch) AS batches,
      (SELECT count(*)::int FROM material_measurement) AS measurements,
      (SELECT count(*)::int FROM audit_event) AS audit_events`, {}, undefined, QueryTypes.SELECT);
    assert.deepEqual(eventCountsAfterReject[0], eventCountsBeforeReject[0]);

    const expiredSource = await request(app).post(`/api/v1/sites/${ids.siteId}/participants`)
      .set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', randomUUID()).send({
        partyKind: 'PERSON', displayName: 'Fictional Expired Weigher', participantKind: 'SERVICE_PROVIDER',
        roleCode: 'OTHER', holeId: ids.holeId, validFrom: '2026-11-01T00:00:00.000Z', validTo: '2026-11-11T00:00:00.000Z',
      });
    assert.equal(expiredSource.status, 201, expiredSource.text);
    const expiredSourceEvent = await request(app).post(`/api/v1/sites/${ids.siteId}/production-events`)
      .set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', randomUUID()).send({
        holeId: ids.holeId, occurredAt: happenedAt, participantRelationshipIds: [expiredSource.body.relationshipId],
        outputs: [{ materialKind: 'RESIDUE' }],
      });
    assert.equal(expiredSourceEvent.status, 201, expiredSourceEvent.text);
    const expiredMeasurement = await request(app).post(`/api/v1/sites/${ids.siteId}/production-events/${expiredSourceEvent.body.id}/outputs/${expiredSourceEvent.body.outputs[0].id}/measurements`)
      .set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', randomUUID()).send({
        kind: 'MEASURED', quantityGrams: '1.000000', sourceValue: '1', sourceUnit: 'g',
        conversionVersion: 'test-v1', sourceRole: 'OTHER', sourcePartyId: expiredSource.body.partyId,
        occurredAt: '2026-11-12T08:30:00.000Z',
      });
    assert.equal(expiredMeasurement.status, 400, expiredMeasurement.text);
    assert.equal(expiredMeasurement.body.error.code, 'INVALID_MEASUREMENT_SOURCE');

    const inactiveSource = await request(app).post(`/api/v1/sites/${ids.siteId}/participants`)
      .set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', randomUUID()).send({
        partyKind: 'PERSON', displayName: 'Fictional Inactive Weigher', participantKind: 'SERVICE_PROVIDER',
        roleCode: 'OTHER', holeId: ids.holeId, validFrom: '2026-11-01T00:00:00.000Z',
      });
    assert.equal(inactiveSource.status, 201, inactiveSource.text);
    const inactiveSourceEvent = await request(app).post(`/api/v1/sites/${ids.siteId}/production-events`)
      .set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', randomUUID()).send({
        holeId: ids.holeId, occurredAt: happenedAt, participantRelationshipIds: [inactiveSource.body.relationshipId],
        outputs: [{ materialKind: 'RESIDUE' }],
      });
    assert.equal(inactiveSourceEvent.status, 201, inactiveSourceEvent.text);
    await db(`UPDATE hole_party_role SET status='REVOKED' WHERE id=:id`, { id: inactiveSource.body.relationshipId });
    const inactiveMeasurement = await request(app).post(`/api/v1/sites/${ids.siteId}/production-events/${inactiveSourceEvent.body.id}/outputs/${inactiveSourceEvent.body.outputs[0].id}/measurements`)
      .set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', randomUUID()).send({
        kind: 'MEASURED', quantityGrams: '1.000000', sourceValue: '1', sourceUnit: 'g',
        conversionVersion: 'test-v1', sourceRole: 'OTHER', sourcePartyId: inactiveSource.body.partyId, occurredAt: happenedAt,
      });
    assert.equal(inactiveMeasurement.status, 400, inactiveMeasurement.text);
    assert.equal(inactiveMeasurement.body.error.code, 'INVALID_MEASUREMENT_SOURCE');
    await assert.rejects(db(`INSERT INTO production_event_participant(id,production_event_id,party_id,hole_party_role_id) VALUES (:id,:eventId,:partyId,:relationshipId)`, {
      id: randomUUID(), eventId: ids.productionEventId, partyId: ids.minerPartyId, relationshipId: randomUUID(),
    }), sqlError('23514'));
  });

  await t.test('Phase 5 sync receipts reuse production services, preserve provenance, and enforce live authorization', async () => {
    const submit = (token, envelope) => request(app).post('/api/v1/sync/commands')
      .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', envelope.clientMutationId).send(envelope);
    const context = { userId: ids.siteUserId, partyId: ids.siteUserPartyId, roleCode: 'FIELD_OFFICER', scopeKind: 'SITE', scopeId: ids.siteId };
    const directCapture = {
      actualParticipantPartyId: ids.minerPartyId, participantIdentityState: 'IDENTIFIED', sourceKind: 'DIRECT',
      occurredAt: happenedAt, sourceReference: 'fictional-direct-note', evidenceRef: 'fictional-evidence-001',
    };
    const directInput = { holeId: ids.holeId, occurredAt: happenedAt, participantRelationshipIds: [ids.holeOperatorRelationshipId], captureProvenance: directCapture, outputs: [{ materialKind: 'RESIDUE' }] };
    const directEnvelope = makeSyncEnvelope({
      ...context, commandType: 'production.create', payload: { siteId: ids.siteId, input: directInput },
      actualParticipant: { identityState: 'IDENTIFIED', partyId: ids.minerPartyId }, captureProvenance: directCapture,
    });
    const created = await submit(ids.siteToken, directEnvelope);
    assert.equal(created.status, 200, created.text);
    assert.equal(created.body.receipt.status, 'server_accepted');
    const acceptedEvent = created.body.receipt.response;
    assert.equal(acceptedEvent.siteId, ids.siteId);
    assert.equal(acceptedEvent.captureProvenance.sourceKind, 'DIRECT');
    assert.equal((await db(`SELECT count(*)::int AS total FROM sync_command_receipt WHERE client_mutation_id=:id AND status='SERVER_ACCEPTED'`, { id: directEnvelope.clientMutationId }, undefined, QueryTypes.SELECT))[0].total, 1);

    const replay = await submit(ids.siteToken, directEnvelope);
    assert.equal(replay.status, 200, replay.text);
    assert.equal(replay.body.receipt.response.id, acceptedEvent.id);
    const changedReuse = await submit(ids.siteToken, { ...directEnvelope, payload: { siteId: ids.siteId, input: { ...directInput, shiftOrPeriodRef: 'changed-under-same-id' } } });
    assert.equal(changedReuse.status, 409, changedReuse.text);
    assert.equal(changedReuse.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
    const ownerReceipt = await request(app).get(`/api/v1/sync/receipts/${directEnvelope.clientMutationId}`).set('Authorization', `Bearer ${ids.siteToken}`);
    assert.equal(ownerReceipt.status, 200, ownerReceipt.text);
    const privateReceipt = await request(app).get(`/api/v1/sync/receipts/${directEnvelope.clientMutationId}`).set('Authorization', `Bearer ${ids.pilotToken}`);
    assert.equal(privateReceipt.status, 404);

    const [holeHead] = await db(`SELECT last_sequence FROM audit_stream_head WHERE stream_kind='mining_hole' AND stream_id=:holeId`, { holeId: ids.holeId }, undefined, QueryTypes.SELECT);
    const paperCapture = {
      actualParticipantPartyId: ids.minerPartyId, participantIdentityState: 'IDENTIFIED', sourceKind: 'PAPER_TRANSCRIPTION',
      occurredAt: happenedAt, sourceReference: 'fictional-paper-book-17', evidenceRef: 'fictional-paper-image-17',
    };
    const paperInput = { holeId: ids.holeId, occurredAt: happenedAt, participantRelationshipIds: [ids.holeOperatorRelationshipId], captureProvenance: paperCapture, outputs: [{ materialKind: 'GOLD_BEARING_FEED' }] };
    const paperEnvelope = makeSyncEnvelope({
      ...context, commandType: 'production.create', payload: { siteId: ids.siteId, input: paperInput },
      actualParticipant: { identityState: 'IDENTIFIED', partyId: ids.minerPartyId }, captureProvenance: paperCapture,
    });
    const paper = await submit(ids.siteToken, paperEnvelope);
    assert.equal(paper.status, 202, paper.text);
    assert.equal(paper.body.receipt.status, 'needs_review');
    const paperEvent = paper.body.receipt.response;
    assert.equal(paperEvent.captureProvenance.sourceKind, 'PAPER_TRANSCRIPTION');
    assert.equal(paperEvent.captureProvenance.actualParticipantPartyId, ids.minerPartyId);
    const [storedPaper] = await db(`SELECT cp.source_kind,cp.source_reference,cp.evidence_ref,cp.occurred_at_claimed,cp.entered_at,cp.entered_by_user_id
      FROM capture_provenance cp WHERE cp.id=:captureId`, { captureId: paperEvent.captureProvenance.id }, undefined, QueryTypes.SELECT);
    assert.equal(storedPaper.source_kind, 'PAPER_TRANSCRIPTION');
    assert.equal(storedPaper.source_reference, 'fictional-paper-book-17');
    assert.notEqual(new Date(storedPaper.entered_at).toISOString(), happenedAt);
    assert.equal(storedPaper.entered_by_user_id, ids.siteUserId);

    const staleEnvelope = makeSyncEnvelope({
      ...context, commandType: 'production.create', payload: { siteId: ids.siteId, input: directInput },
      actualParticipant: { identityState: 'IDENTIFIED', partyId: ids.minerPartyId }, captureProvenance: directCapture,
      expectedVersion: { streamKind: 'mining_hole', streamId: ids.holeId, sequence: Number(holeHead.last_sequence) },
    });
    const stale = await submit(ids.siteToken, staleEnvelope);
    assert.equal(stale.status, 409, stale.text);
    assert.equal(stale.body.receipt.status, 'conflict');
    assert.equal(stale.body.receipt.error.code, 'STALE_VERSION');
    const linkedRevision = makeSyncEnvelope({
      ...context, commandType: 'production.create', payload: { siteId: ids.siteId, input: { ...directInput, shiftOrPeriodRef: 'linked-correction' } },
      actualParticipant: { identityState: 'IDENTIFIED', partyId: ids.minerPartyId }, captureProvenance: directCapture,
      parentCommandIds: [staleEnvelope.clientMutationId], revisionOf: staleEnvelope.clientMutationId,
    });
    const corrected = await submit(ids.siteToken, linkedRevision);
    assert.equal(corrected.status, 200, corrected.text);
    assert.equal(corrected.body.receipt.status, 'server_accepted');
    assert.notEqual(corrected.body.receipt.response.id, acceptedEvent.id);

    const output = acceptedEvent.outputs[0];
    const measurementInput = { kind: 'MEASURED', quantityGrams: '2.500000', sourceValue: '2.5', sourceUnit: 'g', conversionVersion: 'sync-test-v1', sourceRole: 'RECORDER', occurredAt: happenedAt };
    const measurementEnvelope = makeSyncEnvelope({
      ...context, commandType: 'production.measurement.add',
      payload: { siteId: ids.siteId, eventId: acceptedEvent.id, outputId: output.id, input: measurementInput },
      actualParticipant: { identityState: 'IDENTIFIED', partyId: ids.minerPartyId },
    });
    const measured = await submit(ids.siteToken, measurementEnvelope);
    assert.equal(measured.status, 200, measured.text);
    assert.equal(measured.body.receipt.status, 'server_accepted');
    assert.equal(measured.body.receipt.response.quantityGrams, '2.500000');
    const participantMismatch = makeSyncEnvelope({
      ...context, commandType: 'production.measurement.add', actualParticipant: { identityState: 'UNKNOWN' },
      payload: { siteId: ids.siteId, eventId: acceptedEvent.id, outputId: output.id, input: { ...measurementInput, quantityGrams: '2.600000', sourceValue: '2.6' } },
    });
    const mismatchReceipt = await submit(ids.siteToken, participantMismatch);
    assert.equal(mismatchReceipt.status, 422, mismatchReceipt.text);
    assert.equal(mismatchReceipt.body.receipt.error.code, 'CAPTURE_PROVENANCE_MISMATCH');

    const invalidMeasurement = makeSyncEnvelope({
      ...context, commandType: 'production.measurement.add',
      payload: { siteId: ids.siteId, eventId: acceptedEvent.id, outputId: randomUUID(), input: { ...measurementInput, quantityGrams: '2.700000', sourceValue: '2.7' } },
      actualParticipant: { identityState: 'IDENTIFIED', partyId: ids.minerPartyId },
    });
    const firstCorrection = await submit(ids.siteToken, invalidMeasurement);
    assert.equal(firstCorrection.status, 422, firstCorrection.text);
    const stillInvalidRevision = makeSyncEnvelope({
      ...context, commandType: 'production.measurement.add',
      payload: invalidMeasurement.payload, actualParticipant: invalidMeasurement.actualParticipant,
      parentCommandIds: [invalidMeasurement.clientMutationId], revisionOf: invalidMeasurement.clientMutationId,
    });
    const repeatedRejection = await submit(ids.siteToken, stillInvalidRevision);
    assert.equal(repeatedRejection.status, 422, repeatedRejection.text);
    const correctedMeasurement = makeSyncEnvelope({
      ...context, commandType: 'production.measurement.add',
      payload: { siteId: ids.siteId, eventId: acceptedEvent.id, outputId: output.id, input: { ...measurementInput, quantityGrams: '2.700000', sourceValue: '2.7' } },
      actualParticipant: invalidMeasurement.actualParticipant,
      parentCommandIds: [invalidMeasurement.clientMutationId, stillInvalidRevision.clientMutationId], revisionOf: stillInvalidRevision.clientMutationId,
    });
    const acceptedCorrection = await submit(ids.siteToken, correctedMeasurement);
    assert.equal(acceptedCorrection.status, 200, acceptedCorrection.text);
    assert.equal(acceptedCorrection.body.receipt.response.quantityGrams, '2.700000');
    assert.notEqual(correctedMeasurement.clientMutationId, invalidMeasurement.clientMutationId);
    const correctionReceipts = await db(`SELECT client_mutation_id,status,envelope->>'revisionOf' AS revision_of FROM sync_command_receipt
      WHERE client_mutation_id IN (:ids) ORDER BY server_received_at`, { ids: [invalidMeasurement.clientMutationId, stillInvalidRevision.clientMutationId, correctedMeasurement.clientMutationId] }, undefined, QueryTypes.SELECT);
    assert.deepEqual(correctionReceipts.map((row) => row.status), ['REJECTED', 'REJECTED', 'SERVER_ACCEPTED']);
    assert.equal(correctionReceipts[2].revision_of, stillInvalidRevision.clientMutationId);

    const participantUserId = randomUUID();
    await db(`INSERT INTO user_account(id,person_party_id,email,password_hash) VALUES (:id,:partyId,'sync-participant@example.test',:hash)`, {
      id: participantUserId, partyId: ids.minerPartyId, hash: await bcrypt.hash(password, 8),
    });
    await db(`INSERT INTO role_assignment(id,user_id,role_code,scope_kind,scope_id) VALUES (:id,:userId,'MINER','HOLE',:holeId)`, {
      id: randomUUID(), userId: participantUserId, holeId: ids.holeId,
    });
    const participantToken = testToken(participantUserId);
    const acknowledgementTime = new Date().toISOString();
    const acknowledgement = makeSyncEnvelope({
      userId: participantUserId, partyId: ids.minerPartyId, roleCode: 'MINER', scopeKind: 'HOLE', scopeId: ids.holeId,
      commandType: 'capture.acknowledgement.add',
      payload: { siteId: ids.siteId, eventId: paperEvent.id, captureProvenanceId: paperEvent.captureProvenance.id,
        acknowledgement: { status: 'ACKNOWLEDGED', acknowledgedByPartyId: ids.minerPartyId, method: 'IN_PERSON', occurredAt: acknowledgementTime } },
      occurredAt: acknowledgementTime, actualParticipant: { identityState: 'IDENTIFIED', partyId: ids.minerPartyId },
      parentCommandIds: [paperEnvelope.clientMutationId],
    });
    const acknowledged = await submit(participantToken, acknowledgement);
    assert.equal(acknowledged.status, 200, acknowledged.text);
    assert.equal(acknowledged.body.receipt.status, 'server_accepted');
    const [ackRow] = await db(`SELECT status,acknowledged_by_party_id,recorded_by_user_id FROM capture_acknowledgement_event WHERE id=:id`, { id: acknowledged.body.receipt.response.id }, undefined, QueryTypes.SELECT);
    assert.equal(ackRow.status, 'ACKNOWLEDGED');
    assert.equal(ackRow.acknowledged_by_party_id, ids.minerPartyId);
    assert.equal(ackRow.recorded_by_user_id, participantUserId);

    const unauthorizedAck = makeSyncEnvelope({
      ...context, commandType: 'capture.acknowledgement.add',
      payload: { siteId: ids.siteId, eventId: paperEvent.id, captureProvenanceId: paperEvent.captureProvenance.id,
        acknowledgement: { status: 'DISPUTED', method: 'IN_PERSON', occurredAt: acknowledgementTime, reason: 'fictional dispute' } },
      occurredAt: acknowledgementTime, actualParticipant: { identityState: 'IDENTIFIED', partyId: ids.minerPartyId },
    });
    const forged = await submit(ids.siteToken, unauthorizedAck);
    assert.equal(forged.status, 422, forged.text);
    assert.equal(forged.body.receipt.error.code, 'RESOURCE_NOT_FOUND');

    const disputeTime = new Date().toISOString();
    const dispute = makeSyncEnvelope({
      userId: participantUserId, partyId: ids.minerPartyId, roleCode: 'MINER', scopeKind: 'HOLE', scopeId: ids.holeId,
      commandType: 'capture.acknowledgement.add',
      payload: { siteId: ids.siteId, eventId: paperEvent.id, captureProvenanceId: paperEvent.captureProvenance.id,
        acknowledgement: { status: 'DISPUTED', method: 'IN_PERSON', occurredAt: disputeTime, reason: 'fictional participant dispute' } },
      occurredAt: disputeTime, actualParticipant: { identityState: 'IDENTIFIED', partyId: ids.minerPartyId },
    });
    const disputed = await submit(participantToken, dispute);
    assert.equal(disputed.status, 200, disputed.text);
    assert.equal(disputed.body.receipt.response.status, 'DISPUTED');
    const disputeHistory = await db(`SELECT status FROM capture_acknowledgement_event WHERE capture_provenance_id=:captureId ORDER BY recorded_at,id`, { captureId: paperEvent.captureProvenance.id }, undefined, QueryTypes.SELECT);
    assert.deepEqual(disputeHistory.map((row) => row.status), ['ACKNOWLEDGED', 'DISPUTED']);

    const missingParent = makeSyncEnvelope({
      ...context, commandType: 'production.create', payload: { siteId: ids.siteId, input: directInput },
      actualParticipant: { identityState: 'IDENTIFIED', partyId: ids.minerPartyId }, captureProvenance: directCapture,
      parentCommandIds: [randomUUID()],
    });
    const dependency = await submit(ids.siteToken, missingParent);
    assert.equal(dependency.status, 409, dependency.text);
    assert.equal(dependency.body.receipt.error.code, 'DEPENDENCY_NOT_ACCEPTED');

    const revokedUser = await seedUser('revoked-sync-recorder@example.test', 'Revoked Sync Recorder', { roleCode: 'FIELD_OFFICER', scopeKind: 'HOLE', scopeId: ids.holeId });
    await db(`UPDATE role_assignment SET status='REVOKED',valid_to=now() WHERE id=:id`, { id: revokedUser.roleAssignmentId });
    const revokedEnvelope = makeSyncEnvelope({
      userId: revokedUser.userId, partyId: revokedUser.partyId, roleCode: 'FIELD_OFFICER', scopeKind: 'HOLE', scopeId: ids.holeId,
      commandType: 'production.create', payload: { siteId: ids.siteId, input: directInput },
      actualParticipant: { identityState: 'IDENTIFIED', partyId: ids.minerPartyId }, captureProvenance: directCapture,
    });
    const revoked = await submit(testToken(revokedUser.userId), revokedEnvelope);
    assert.equal(revoked.status, 422, revoked.text);
    assert.equal(revoked.body.receipt.error.code, 'ACTING_CONTEXT_REVOKED');

    const crossSiteEnvelope = makeSyncEnvelope({
      ...context, commandType: 'production.create', payload: { siteId: ids.siteBId, input: { ...directInput, holeId: randomUUID() } },
      actualParticipant: { identityState: 'IDENTIFIED', partyId: ids.minerPartyId }, captureProvenance: directCapture,
    });
    const crossSite = await submit(ids.siteToken, crossSiteEnvelope);
    assert.equal(crossSite.status, 422, crossSite.text);
    assert.equal(crossSite.body.receipt.error.code, 'RESOURCE_NOT_FOUND');
    const arbitrary = await submit(ids.siteToken, { ...directEnvelope, commandType: 'production.allocation.propose' });
    assert.equal(arbitrary.status, 400);
    assert.equal(arbitrary.body.error.code, 'INVALID_COMMAND_PAYLOAD');

    await assert.rejects(db(`UPDATE sync_command_receipt SET envelope='{}'::jsonb WHERE client_mutation_id=:id`, { id: directEnvelope.clientMutationId }), sqlError('55000'));
    await assert.rejects(db(`DELETE FROM sync_command_receipt_history WHERE receipt_id=(SELECT id FROM sync_command_receipt WHERE client_mutation_id=:id)`, { id: directEnvelope.clientMutationId }), sqlError('55000'));
    assert.equal((await verifyAuditStream('mining_hole', ids.holeId)).valid, true);
  });

  await t.test('hole-scoped access stays within assigned holes across nested endpoints', async () => {
    ids.holeB1Id = randomUUID();
    await db(`INSERT INTO mining_hole(id,site_id,hole_code,name) VALUES (:id,:siteId,'HOLE-B1','Third fictional hole')`, { id: ids.holeB1Id, siteId: ids.siteBId });
    const siteAuditor = await seedUser('site-auditor@example.test', 'Fictional Site Auditor', {
      roleCode: 'AUDITOR', scopeKind: 'SITE', scopeId: ids.siteId,
    });
    ids.siteAuditorToken = testToken(siteAuditor.userId);

    const holeA2Participant = await request(app).post(`/api/v1/sites/${ids.siteId}/participants`)
      .set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', randomUUID())
      .send({ partyKind: 'PERSON', displayName: 'Fictional Hole A2 Miner', participantKind: 'MINER', roleCode: 'MINER', holeId: ids.secondHoleId });
    assert.equal(holeA2Participant.status, 201, holeA2Participant.text);

    const holeA2EventResponse = await request(app).post(`/api/v1/sites/${ids.siteId}/production-events`)
      .set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', randomUUID())
      .send({
        holeId: ids.secondHoleId, occurredAt: happenedAt, shiftOrPeriodRef: 'FICTIONAL-A2-PERIOD',
        outputs: [{ materialKind: 'RESIDUE', outputKind: 'HOLE-A2-OUTPUT', measurements: [{ kind: 'MEASURED', quantityGrams: '3.000000', sourceValue: '3', sourceUnit: 'g', conversionVersion: 'test-v1', sourceRole: 'RECORDER', occurredAt: happenedAt }] }],
      });
    assert.equal(holeA2EventResponse.status, 201, holeA2EventResponse.text);
    const holeA2Event = holeA2EventResponse.body;
    const holeA2Output = holeA2Event.outputs[0];
    ids.holeA2BatchId = holeA2Output.batchId;

    const holeA1User = await seedUser('hole-a1-recorder@example.test', 'Fictional Hole A1 Recorder', {
      roleCode: 'FIELD_OFFICER', scopeKind: 'HOLE', scopeId: ids.holeId,
    });
    ids.holeA1RoleId = holeA1User.roleAssignmentId;
    const holeA1Token = testToken(holeA1User.userId);
    const holeB1User = await seedUser('hole-b1-recorder@example.test', 'Fictional Hole B1 Recorder', {
      roleCode: 'FIELD_OFFICER', scopeKind: 'HOLE', scopeId: ids.holeB1Id,
    });
    const holeB1Token = testToken(holeB1User.userId);

    const a1 = await request(app).get(`/api/v1/sites/${ids.siteId}/holes/${ids.holeId}`).set('Authorization', `Bearer ${holeA1Token}`);
    assert.equal(a1.status, 200, a1.text);
    const a1Holes = await request(app).get(`/api/v1/sites/${ids.siteId}/holes`).set('Authorization', `Bearer ${holeA1Token}`);
    assert.deepEqual(a1Holes.body.map((hole) => hole.id), [ids.holeId]);
    assert.equal((await request(app).get(`/api/v1/sites/${ids.siteId}/holes/${ids.secondHoleId}`).set('Authorization', `Bearer ${holeA1Token}`)).status, 404);
    assert.equal((await request(app).get(`/api/v1/sites/${ids.siteBId}/holes/${ids.holeB1Id}`).set('Authorization', `Bearer ${holeA1Token}`)).status, 404);
    assert.equal((await request(app).get(`/api/v1/sites/${ids.siteBId}/holes`).set('Authorization', `Bearer ${holeA1Token}`)).status, 404);
    assert.equal((await request(app).get(`/api/v1/sites/${ids.siteBId}/holes/${ids.holeId}`).set('Authorization', `Bearer ${holeA1Token}`)).status, 404);
    assert.equal((await request(app).get(`/api/v1/sites/${ids.siteId}`).set('Authorization', `Bearer ${holeA1Token}`)).status, 403);

    const a1Participants = await request(app).get(`/api/v1/sites/${ids.siteId}/holes/${ids.holeId}/participants`).set('Authorization', `Bearer ${holeA1Token}`);
    assert.equal(a1Participants.status, 200, a1Participants.text);
    assert.ok(a1Participants.body.some((participant) => participant.party_id === ids.minerPartyId));
    const a2Participants = await request(app).get(`/api/v1/sites/${ids.siteId}/holes/${ids.secondHoleId}/participants`).set('Authorization', `Bearer ${holeA1Token}`);
    assert.equal(a2Participants.status, 404);
    assert.equal((await request(app).get(`/api/v1/sites/${ids.siteId}/participants`).set('Authorization', `Bearer ${holeA1Token}`)).status, 403);

    const holeA1Association = await request(app).post(`/api/v1/sites/${ids.siteId}/participants`)
      .set('Authorization', `Bearer ${holeA1Token}`).set('Idempotency-Key', randomUUID())
      .send({ partyKind: 'PERSON', displayName: 'Fictional A1 Witness', participantKind: 'FIELD_OFFICER', roleCode: 'FIELD_RECORDER', holeId: ids.holeId });
    assert.equal(holeA1Association.status, 201, holeA1Association.text);
    const holeA2Association = await request(app).post(`/api/v1/sites/${ids.siteId}/participants`)
      .set('Authorization', `Bearer ${holeA1Token}`).set('Idempotency-Key', randomUUID())
      .send({ partyKind: 'PERSON', displayName: 'Fictional Unauthorized Witness', participantKind: 'FIELD_OFFICER', roleCode: 'FIELD_RECORDER', holeId: ids.secondHoleId });
    assert.equal(holeA2Association.status, 403);

    const siteWideEvents = await request(app).get(`/api/v1/sites/${ids.siteId}/production-events`).set('Authorization', `Bearer ${holeA1Token}`);
    assert.equal(siteWideEvents.status, 200, siteWideEvents.text);
    const siteReadableEvents = await request(app).get(`/api/v1/sites/${ids.siteId}/production-events`).set('Authorization', `Bearer ${ids.siteToken}`);
    assert.equal(siteReadableEvents.status, 200, siteReadableEvents.text);
    const eventsWithinHoleGrant = siteReadableEvents.body.filter((event) => event.hole_id === ids.holeId).map((event) => event.id).sort();
    assert.deepEqual(siteWideEvents.body.map((event) => event.id).sort(), eventsWithinHoleGrant);
    assert.ok(siteWideEvents.body.every((event) => event.hole_id === ids.holeId));
    assert.equal(siteWideEvents.body.some((event) => event.hole_id === ids.secondHoleId), false);
    const a1Event = await request(app).get(`/api/v1/sites/${ids.siteId}/production-events/${ids.productionEventId}`).set('Authorization', `Bearer ${holeA1Token}`);
    assert.equal(a1Event.status, 200, a1Event.text);
    assert.equal(a1Event.body.outputs[0].batch_id, ids.outputs[0].batchId);
    const a2Event = await request(app).get(`/api/v1/sites/${ids.siteId}/production-events/${holeA2Event.id}`).set('Authorization', `Bearer ${holeA1Token}`);
    assert.equal(a2Event.status, 404);
    assert.doesNotMatch(JSON.stringify(a2Event.body), new RegExp(holeA2Event.eventCode));
    assert.equal((await request(app).get(`/api/v1/sites/${ids.siteBId}/production-events/${ids.productionEventId}`).set('Authorization', `Bearer ${holeA1Token}`)).status, 404);

    const measurementInput = { kind: 'MEASURED', quantityGrams: '9.800000', sourceValue: '9.8', sourceUnit: 'g', conversionVersion: 'test-v1', sourceRole: 'WEIGHER', sourcePartyId: ids.minerPartyId, occurredAt: happenedAt };
    const a1Measurement = await request(app).post(`/api/v1/sites/${ids.siteId}/production-events/${ids.productionEventId}/outputs/${ids.outputs[0].id}/measurements`)
      .set('Authorization', `Bearer ${holeA1Token}`).set('Idempotency-Key', randomUUID()).send(measurementInput);
    assert.equal(a1Measurement.status, 201, a1Measurement.text);
    const a2Measurement = await request(app).post(`/api/v1/sites/${ids.siteId}/production-events/${holeA2Event.id}/outputs/${holeA2Output.id}/measurements`)
      .set('Authorization', `Bearer ${holeA1Token}`).set('Idempotency-Key', randomUUID()).send(measurementInput);
    assert.equal(a2Measurement.status, 404);
    const crossOutput = await request(app).post(`/api/v1/sites/${ids.siteId}/production-events/${ids.productionEventId}/outputs/${holeA2Output.id}/measurements`)
      .set('Authorization', `Bearer ${holeA1Token}`).set('Idempotency-Key', randomUUID()).send(measurementInput);
    assert.equal(crossOutput.status, 404);
    assert.equal((await request(app).get(`/api/v1/sites/${ids.siteId}/production-events/${holeA2Event.id}`).set('Authorization', `Bearer ${ids.siteAuditorToken}`)).status, 200);
    const auditorWrite = await request(app).post(`/api/v1/sites/${ids.siteId}/production-events/${holeA2Event.id}/outputs/${holeA2Output.id}/measurements`)
      .set('Authorization', `Bearer ${ids.siteAuditorToken}`).set('Idempotency-Key', randomUUID()).send(measurementInput);
    assert.equal(auditorWrite.status, 404);
    const unauthorizedProduction = await request(app).post(`/api/v1/sites/${ids.siteId}/production-events`)
      .set('Authorization', `Bearer ${holeA1Token}`).set('Idempotency-Key', randomUUID())
      .send({ holeId: ids.secondHoleId, occurredAt: happenedAt, outputs: [{ materialKind: 'RESIDUE' }] });
    assert.equal(unauthorizedProduction.status, 404);

    assert.equal((await request(app).get(`/api/v1/sites/${ids.siteId}`).set('Authorization', `Bearer ${ids.siteToken}`)).status, 200);
    assert.equal((await request(app).get(`/api/v1/sites/${ids.siteId}/holes/${ids.secondHoleId}`).set('Authorization', `Bearer ${ids.siteToken}`)).status, 200);
    assert.equal((await request(app).get(`/api/v1/sites/${ids.siteId}/participants`).set('Authorization', `Bearer ${ids.siteToken}`)).status, 200);
    const siteEvents = await request(app).get(`/api/v1/sites/${ids.siteId}/production-events`).set('Authorization', `Bearer ${ids.siteToken}`);
    assert.equal(siteEvents.status, 200, siteEvents.text);
    assert.ok(siteEvents.body.some((event) => event.id === holeA2Event.id));
    assert.equal((await request(app).get(`/api/v1/sites/${ids.siteId}/production-events/${holeA2Event.id}`).set('Authorization', `Bearer ${ids.siteToken}`)).status, 200);

    assert.equal((await request(app).get(`/api/v1/sites/${ids.siteBId}/holes/${ids.holeB1Id}`).set('Authorization', `Bearer ${holeB1Token}`)).status, 200);
    assert.deepEqual((await request(app).get(`/api/v1/sites/${ids.siteBId}/holes`).set('Authorization', `Bearer ${holeB1Token}`)).body.map((hole) => hole.id), [ids.holeB1Id]);
    assert.equal((await request(app).get(`/api/v1/sites/${ids.siteId}/holes/${ids.holeId}`).set('Authorization', `Bearer ${holeB1Token}`)).status, 404);
    assert.equal((await request(app).get(`/api/v1/sites/${ids.siteId}`).set('Authorization', `Bearer ${holeB1Token}`)).status, 403);
    assert.equal((await request(app).get(`/api/v1/sites/${ids.siteId}`).set('Authorization', `Bearer ${ids.orgToken}`)).status, 403);
    assert.equal((await request(app).get(`/api/v1/sites/${ids.siteBId}`).set('Authorization', `Bearer ${ids.orgToken}`)).status, 200);

    const adminAction = await request(app).post('/api/v1/admin/organisations').set('Authorization', `Bearer ${ids.adminToken}`).set('Idempotency-Key', randomUUID()).send({ displayName: 'Fictional Authorization Test Group', organisationKind: 'TEST_ORGANISATION' });
    assert.equal(adminAction.status, 201, adminAction.text);

    const addedSiteRole = await request(app).post(`/api/v1/admin/users/${holeA1User.userId}/roles`)
      .set('Authorization', `Bearer ${ids.adminToken}`).set('Idempotency-Key', randomUUID())
      .send({ roleCode: 'FIELD_OFFICER', scopeKind: 'SITE', scopeId: ids.siteBId });
    assert.equal(addedSiteRole.status, 201, addedSiteRole.text);
    assert.equal((await request(app).get(`/api/v1/sites/${ids.siteBId}`).set('Authorization', `Bearer ${holeA1Token}`)).status, 200);
    assert.equal((await request(app).get(`/api/v1/sites/${ids.siteId}/holes/${ids.holeId}`).set('Authorization', `Bearer ${holeA1Token}`)).status, 200);

    const revokeHoleRole = await request(app).post(`/api/v1/admin/role-assignments/${ids.holeA1RoleId}/revoke`)
      .set('Authorization', `Bearer ${ids.adminToken}`).set('Idempotency-Key', randomUUID()).send({});
    assert.equal(revokeHoleRole.status, 200, revokeHoleRole.text);
    assert.equal((await request(app).get(`/api/v1/sites/${ids.siteId}/holes/${ids.holeId}`).set('Authorization', `Bearer ${holeA1Token}`)).status, 404);
    assert.equal((await request(app).get(`/api/v1/sites/${ids.siteId}/production-events/${ids.productionEventId}`).set('Authorization', `Bearer ${holeA1Token}`)).status, 404);
    assert.equal((await request(app).get(`/api/v1/sites/${ids.siteBId}`).set('Authorization', `Bearer ${holeA1Token}`)).status, 200);
  });

  await t.test('allocation basis, revisions, homogeneous rows, approval totals, and current pointer', async () => {
    const beneficiary = await seedParty('PERSON', 'Fictional Allocation Beneficiary');
    await db(`INSERT INTO site_party_role(id,site_id,party_id,role_code,valid_from,asserted_by_user_id)
      VALUES (:id,:siteId,:partyId,'BENEFICIARY','2026-11-01T00:00:00.000Z',:actor)`, {
      id: randomUUID(), siteId: ids.siteId, partyId: beneficiary, actor: ids.siteUserId,
    });
    const chainId = randomUUID();
    const setId = randomUUID();
    await sequelize.transaction(async (transaction) => {
      await db(`INSERT INTO production_allocation_chain(id,production_event_output_id) VALUES (:id,:outputId)`, { id: chainId, outputId: ids.outputs[0].id }, transaction);
      await db(`INSERT INTO production_allocation_set(id,allocation_chain_id,revision_no,revision_kind,basis_kind,basis_measurement_set_id,basis_measurement_id,proposed_by_user_id)
        VALUES (:id,:chainId,1,'ORIGINAL','QUANTITY',:measurementSetId,:measurementId,:userId)`, { id: setId, chainId, measurementSetId: ids.measurementSetId, measurementId: ids.measurementId, userId: ids.siteUserId }, transaction);
      await db(`INSERT INTO production_allocation_row(id,allocation_set_id,beneficiary_party_id,allocation_basis,allocated_quantity_g) VALUES (:id,:setId,:beneficiary,'QUANTITY','6.000000')`, { id: randomUUID(), setId, beneficiary }, transaction);
      await db(`INSERT INTO allocation_set_review_event(id,production_allocation_set_id,review_sequence,review_status,actor_user_id,occurred_at) VALUES (:id,:setId,1,'PENDING',:actor,:at)`, { id: randomUUID(), setId, actor: ids.siteUserId, at: happenedAt }, transaction);
      await db(`INSERT INTO allocation_set_review_event(id,production_allocation_set_id,review_sequence,review_status,authorized_basis_measurement_id,actor_user_id,occurred_at) VALUES (:id,:setId,2,'APPROVED',:measurementId,:actor,:at)`, { id: randomUUID(), setId, measurementId: ids.measurementId, actor: ids.adminUserId, at: happenedAt }, transaction);
      await db(`UPDATE production_allocation_chain SET active_approved_set_id=:setId WHERE id=:chainId`, { setId, chainId }, transaction);
    });
    ids.allocationChainId = chainId;
    ids.allocationSetId = setId;
    assert.equal((await db(`SELECT active_approved_set_id FROM production_allocation_chain WHERE id=:id`, { id: chainId }, undefined, QueryTypes.SELECT))[0].active_approved_set_id, setId);
    const wrongBasisBeneficiary = await seedParty('PERSON', 'Fictional Other Beneficiary');
    await db(`INSERT INTO site_party_role(id,site_id,party_id,role_code,valid_from,asserted_by_user_id)
      VALUES (:id,:siteId,:partyId,'BENEFICIARY','2026-11-01T00:00:00.000Z',:actor)`, {
      id: randomUUID(), siteId: ids.siteId, partyId: wrongBasisBeneficiary, actor: ids.siteUserId,
    });
    await assert.rejects(db(`INSERT INTO production_allocation_row(id,allocation_set_id,beneficiary_party_id,allocation_basis,allocated_share) VALUES (:id,:setId,:beneficiary,'SHARE',0.5)`, { id: randomUUID(), setId, beneficiary: wrongBasisBeneficiary }), sqlError('23503'));
    await assert.rejects(db(`INSERT INTO production_allocation_row(id,allocation_set_id,beneficiary_party_id,allocation_basis,allocated_quantity_g) VALUES (:id,:setId,:beneficiary,'QUANTITY','1.000000')`, {
      id: randomUUID(), setId, beneficiary: await seedParty('PERSON', 'Fictional Unrelated Beneficiary'),
    }), sqlError('23514'));
    const missingValueBeneficiary = await seedParty('PERSON', 'Fictional Missing Allocation Value');
    await db(`INSERT INTO site_party_role(id,site_id,party_id,role_code,valid_from,asserted_by_user_id)
      VALUES (:id,:siteId,:partyId,'BENEFICIARY','2026-11-01T00:00:00.000Z',:actor)`, {
      id: randomUUID(), siteId: ids.siteId, partyId: missingValueBeneficiary, actor: ids.siteUserId,
    });
    await assert.rejects(db(`INSERT INTO production_allocation_row(id,allocation_set_id,beneficiary_party_id,allocation_basis,allocated_quantity_g,allocated_share) VALUES (:id,:setId,:beneficiary,'QUANTITY',NULL,NULL)`, {
      id: randomUUID(), setId, beneficiary: missingValueBeneficiary,
    }), sqlError('23514'));
    await assert.rejects(db(`UPDATE production_allocation_row SET allocated_quantity_g='7.000000' WHERE allocation_set_id=:setId`, { setId }), sqlError('55000'));

    await assert.rejects(sequelize.transaction(async (transaction) => {
      const correctionId = randomUUID();
      await db(`INSERT INTO production_allocation_set(id,allocation_chain_id,revision_no,revision_kind,basis_kind,basis_measurement_set_id,basis_measurement_id,supersedes_set_id,correction_reason,proposed_by_user_id)
        VALUES (:id,:chainId,2,'CORRECTION','QUANTITY',:measurementSetId,:measurementId,:prior,'Fictional correction test',:userId)`, { id: correctionId, chainId, measurementSetId: ids.measurementSetId, measurementId: ids.measurementId, prior: setId, userId: ids.siteUserId }, transaction);
      await db(`INSERT INTO production_allocation_row(id,allocation_set_id,beneficiary_party_id,allocation_basis,allocated_quantity_g) VALUES (:id,:setId,:beneficiary,'QUANTITY','11.000000')`, { id: randomUUID(), setId: correctionId, beneficiary }, transaction);
      await db(`INSERT INTO allocation_set_review_event(id,production_allocation_set_id,review_sequence,review_status,actor_user_id,occurred_at) VALUES (:id,:setId,1,'PENDING',:actor,:at)`, { id: randomUUID(), setId: correctionId, actor: ids.siteUserId, at: happenedAt }, transaction);
      await db(`INSERT INTO allocation_set_review_event(id,production_allocation_set_id,review_sequence,review_status,authorized_basis_measurement_id,actor_user_id,occurred_at) VALUES (:id,:setId,2,'APPROVED',:measurementId,:actor,:at)`, { id: randomUUID(), setId: correctionId, measurementId: ids.measurementId, actor: ids.adminUserId, at: happenedAt }, transaction);
      await db(`UPDATE production_allocation_chain SET active_approved_set_id=:setId WHERE id=:chainId`, { setId: correctionId, chainId }, transaction);
      await db('SET CONSTRAINTS ALL IMMEDIATE', {}, transaction);
    }), sqlError('23514'));
    const [chain] = await db(`SELECT active_approved_set_id FROM production_allocation_chain WHERE id=:id`, { id: chainId }, undefined, QueryTypes.SELECT);
    assert.equal(chain.active_approved_set_id, setId);
    assert.equal((await db(`SELECT count(*)::int AS total FROM production_allocation_set WHERE allocation_chain_id=:id`, { id: chainId }, undefined, QueryTypes.SELECT))[0].total, 1);

    const otherChain = randomUUID();
    await db(`INSERT INTO production_allocation_chain(id,production_event_output_id) VALUES (:id,:outputId)`, { id: otherChain, outputId: ids.outputs[1].id });
    await assert.rejects(db(`INSERT INTO production_allocation_set(id,allocation_chain_id,revision_no,revision_kind,basis_kind,basis_measurement_set_id,basis_measurement_id,proposed_by_user_id)
      VALUES (:id,:chainId,1,'ORIGINAL','QUANTITY',:measurementSetId,:measurementId,:userId)`, { id: randomUUID(), chainId: otherChain, measurementSetId: ids.measurementSetId, measurementId: ids.measurementId, userId: ids.siteUserId }), sqlError('23514'));
  });

  await t.test('allocation proposals require effective beneficiaries and keep review policy gated', async () => {
    const created = await request(app).post(`/api/v1/sites/${ids.siteId}/production-events`)
      .set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', randomUUID()).send({
        holeId: ids.holeId, occurredAt: happenedAt, participantRelationshipIds: [ids.holeOperatorRelationshipId],
        outputs: [
          { materialKind: 'GOLD_BEARING_FEED', measurements: [
            { kind: 'MEASURED', quantityGrams: '10.000000', sourceValue: '10', sourceUnit: 'g', conversionVersion: 'test-v1', sourceRole: 'WEIGHER', sourcePartyId: ids.minerPartyId, occurredAt: happenedAt },
            { kind: 'DECLARED', quantityGrams: '11.000000', sourceValue: '11', sourceUnit: 'g', conversionVersion: 'test-v1', sourceRole: 'RECORDER', occurredAt: happenedAt },
          ] },
          { materialKind: 'RESIDUE', measurements: [
            { kind: 'MEASURED', quantityGrams: '4.000000', sourceValue: '4', sourceUnit: 'g', conversionVersion: 'test-v1', sourceRole: 'WEIGHER', sourcePartyId: ids.minerPartyId, occurredAt: happenedAt },
          ] },
        ],
      });
    assert.equal(created.status, 201, created.text);
    ids.phase2ProductionEventId = created.body.id;
    ids.phase2Outputs = created.body.outputs;
    const minerBeneficiary = await request(app).post(`/api/v1/sites/${ids.siteId}/participants`)
      .set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', randomUUID())
      .send({ partyId: ids.minerPartyId, participantKind: 'MINER', roleCode: 'BENEFICIARY', holeId: ids.holeId, validFrom: '2026-11-01T00:00:00.000Z', sourceReference: 'FICTIONAL-AGREEMENT-1', evidenceRef: 'FICTIONAL-EVIDENCE-1' });
    assert.equal(minerBeneficiary.status, 201, minerBeneficiary.text);
    const nonMinerBeneficiary = await request(app).post(`/api/v1/sites/${ids.siteId}/participants`)
      .set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', randomUUID())
      .send({ partyKind: 'PERSON', displayName: 'Fictional Family Beneficiary', participantKind: 'FAMILY_OR_AGREED_BENEFICIARY', roleCode: 'BENEFICIARY', holeId: ids.holeId, validFrom: '2026-11-01T00:00:00.000Z', sourceReference: 'FICTIONAL-AGREEMENT-2' });
    assert.equal(nonMinerBeneficiary.status, 201, nonMinerBeneficiary.text);
    ids.phase2BeneficiaryId = nonMinerBeneficiary.body.partyId;
    assert.equal(nonMinerBeneficiary.body.participantKind, 'FAMILY_OR_AGREED_BENEFICIARY');
    const persistedRelationship = await db(`SELECT role_code, source_reference, evidence_ref, asserted_by_user_id FROM hole_party_role WHERE id=:id`, { id: nonMinerBeneficiary.body.relationshipId }, undefined, QueryTypes.SELECT);
    assert.equal(persistedRelationship[0].role_code, 'BENEFICIARY');
    assert.equal(persistedRelationship[0].source_reference, 'FICTIONAL-AGREEMENT-2');
    assert.equal(persistedRelationship[0].asserted_by_user_id, ids.siteUserId);
    const unrelatedBeneficiaryId = await seedParty('PERSON', 'Fictional Unrelated Beneficiary');
    const unrelatedProposal = await request(app).post(`/api/v1/sites/${ids.siteId}/production-events/${ids.phase2ProductionEventId}/outputs/${ids.phase2Outputs[1].id}/allocation-sets`)
      .set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', randomUUID()).send({
        basisKind: 'SHARE', rows: [{ beneficiaryPartyId: unrelatedBeneficiaryId, allocatedShare: '0.100000000' }],
      });
    assert.equal(unrelatedProposal.status, 400, unrelatedProposal.text);
    assert.equal(unrelatedProposal.body.error.code, 'INVALID_ALLOCATION_BENEFICIARY');

    const expiredBeneficiary = await request(app).post(`/api/v1/sites/${ids.siteId}/participants`)
      .set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', randomUUID())
      .send({ partyKind: 'PERSON', displayName: 'Fictional Expired Beneficiary', participantKind: 'FAMILY_OR_AGREED_BENEFICIARY', roleCode: 'BENEFICIARY', holeId: ids.holeId, validFrom: '2026-11-01T00:00:00.000Z', validTo: '2026-11-09T00:00:00.000Z' });
    assert.equal(expiredBeneficiary.status, 201, expiredBeneficiary.text);
    const expiredProposal = await request(app).post(`/api/v1/sites/${ids.siteId}/production-events/${ids.phase2ProductionEventId}/outputs/${ids.phase2Outputs[1].id}/allocation-sets`)
      .set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', randomUUID()).send({
        basisKind: 'SHARE', rows: [{ beneficiaryPartyId: expiredBeneficiary.body.partyId, allocatedShare: '0.100000000' }],
      });
    assert.equal(expiredProposal.status, 400, expiredProposal.text);
    assert.equal(expiredProposal.body.error.code, 'INVALID_ALLOCATION_BENEFICIARY');

    const inactiveBeneficiary = await request(app).post(`/api/v1/sites/${ids.siteId}/participants`)
      .set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', randomUUID())
      .send({ partyKind: 'ORGANISATION', displayName: 'Fictional Service Provider', organisationKind: 'SERVICE_PROVIDER', participantKind: 'SERVICE_PROVIDER', roleCode: 'BENEFICIARY', holeId: ids.holeId, validFrom: '2026-11-01T00:00:00.000Z' });
    assert.equal(inactiveBeneficiary.status, 201, inactiveBeneficiary.text);
    await db(`UPDATE hole_party_role SET status='REVOKED' WHERE id=:id`, { id: inactiveBeneficiary.body.relationshipId });
    const inactiveProposal = await request(app).post(`/api/v1/sites/${ids.siteId}/production-events/${ids.phase2ProductionEventId}/outputs/${ids.phase2Outputs[1].id}/allocation-sets`)
      .set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', randomUUID()).send({
        basisKind: 'SHARE', rows: [{ beneficiaryPartyId: inactiveBeneficiary.body.partyId, allocatedShare: '0.100000000' }],
      });
    assert.equal(inactiveProposal.status, 400, inactiveProposal.text);
    assert.equal(inactiveProposal.body.error.code, 'INVALID_ALLOCATION_BENEFICIARY');

    const quantityProposal = {
      basisKind: 'QUANTITY', basisMeasurementId: ids.phase2Outputs[0].measurements[0].id,
      rows: [
        { beneficiaryPartyId: ids.minerPartyId, allocatedQuantityGrams: '6.000000' },
        { beneficiaryPartyId: ids.phase2BeneficiaryId, allocatedQuantityGrams: '4.000000' },
      ],
    };
    const proposalKey = randomUUID();
    const first = await request(app).post(`/api/v1/sites/${ids.siteId}/production-events/${ids.phase2ProductionEventId}/outputs/${ids.phase2Outputs[0].id}/allocation-sets`)
      .set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', proposalKey).send(quantityProposal);
    const replay = await request(app).post(`/api/v1/sites/${ids.siteId}/production-events/${ids.phase2ProductionEventId}/outputs/${ids.phase2Outputs[0].id}/allocation-sets`)
      .set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', proposalKey).send(quantityProposal);
    assert.equal(first.status, 201, first.text);
    assert.equal(replay.status, 201, replay.text);
    assert.equal(replay.body.id, first.body.id);
    assert.equal(replay.body.replayed, true);
    assert.equal(first.body.reviewStatus, 'PENDING');
    assert.equal(first.body.approvalAvailable, false);
    ids.phase2QuantitySetId = first.body.id;

    const correctionBody = {
      basisKind: 'QUANTITY', basisMeasurementId: ids.phase2Outputs[0].measurements[0].id,
      supersedesSetId: ids.phase2QuantitySetId, correctionReason: 'Fictional complete revision test',
      rows: [
        { beneficiaryPartyId: ids.minerPartyId, allocatedQuantityGrams: '5.500000' },
        { beneficiaryPartyId: ids.phase2BeneficiaryId, allocatedQuantityGrams: '4.500000' },
      ],
    };
    const correction = await request(app).post(`/api/v1/sites/${ids.siteId}/production-events/${ids.phase2ProductionEventId}/outputs/${ids.phase2Outputs[0].id}/allocation-sets`)
      .set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', randomUUID()).send(correctionBody);
    assert.equal(correction.status, 201, correction.text);
    ids.phase2CorrectedSetId = correction.body.id;
    const competingBody = { ...correctionBody, supersedesSetId: ids.phase2CorrectedSetId, correctionReason: 'Concurrent complete revision test', rows: [
      { beneficiaryPartyId: ids.minerPartyId, allocatedQuantityGrams: '5.000000' },
      { beneficiaryPartyId: ids.phase2BeneficiaryId, allocatedQuantityGrams: '5.000000' },
    ] };
    const competing = await Promise.all([randomUUID(), randomUUID()].map((key) => request(app)
      .post(`/api/v1/sites/${ids.siteId}/production-events/${ids.phase2ProductionEventId}/outputs/${ids.phase2Outputs[0].id}/allocation-sets`)
      .set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', key).send(competingBody)));
    assert.deepEqual(competing.map((response) => response.status).sort(), [201, 409]);

    const shareSet = await request(app).post(`/api/v1/sites/${ids.siteId}/production-events/${ids.phase2ProductionEventId}/outputs/${ids.phase2Outputs[1].id}/allocation-sets`)
      .set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', randomUUID()).send({
        basisKind: 'SHARE', rows: [
          { beneficiaryPartyId: ids.minerPartyId, allocatedShare: '0.600000000' },
          { beneficiaryPartyId: ids.phase2BeneficiaryId, allocatedShare: '0.400000000' },
        ],
      });
    assert.equal(shareSet.status, 201, shareSet.text);
    assert.equal(shareSet.body.basisKind, 'SHARE');

    const allocationContext = { userId: ids.siteUserId, partyId: ids.siteUserPartyId, roleCode: 'FIELD_OFFICER', scopeKind: 'SITE', scopeId: ids.siteId };
    const allocationPayload = { siteId: ids.siteId, eventId: ids.phase2ProductionEventId, outputId: ids.phase2Outputs[1].id, input: {
      basisKind: 'SHARE', supersedesSetId: shareSet.body.id, correctionReason: 'Offline complete allocation revision.',
      rows: [
        { beneficiaryPartyId: ids.minerPartyId, allocatedShare: '0.550000000' },
        { beneficiaryPartyId: ids.phase2BeneficiaryId, allocatedShare: '0.450000000' },
      ],
    } };
    const allocationCommand = await versionSyncEnvelope(ids.siteToken, makeSyncEnvelope({
      ...allocationContext, commandType: 'production.allocation.propose', payload: allocationPayload,
    }));
    const offlineAllocation = await submitSyncEnvelope(ids.siteToken, allocationCommand);
    assert.equal(offlineAllocation.status, 200, offlineAllocation.text);
    assert.equal(offlineAllocation.body.receipt.response.supersedesSetId, shareSet.body.id);
    const staleAllocation = makeSyncEnvelope({
      ...allocationContext, commandType: 'production.allocation.propose',
      expectedVersion: allocationCommand.expectedVersion,
      payload: { ...allocationPayload, input: { ...allocationPayload.input, supersedesSetId: offlineAllocation.body.receipt.response.id, correctionReason: 'Offline stale allocation revision.' } },
    });
    const staleAllocationResult = await submitSyncEnvelope(ids.siteToken, staleAllocation);
    assert.equal(staleAllocationResult.status, 409, staleAllocationResult.text);
    assert.equal(staleAllocationResult.body.receipt.error.code, 'STALE_VERSION');

    const mixed = await request(app).post(`/api/v1/sites/${ids.siteId}/production-events/${ids.phase2ProductionEventId}/outputs/${ids.phase2Outputs[1].id}/allocation-sets`)
      .set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', randomUUID()).send({
        basisKind: 'SHARE', rows: [{ beneficiaryPartyId: ids.minerPartyId, allocatedShare: '0.5', allocatedQuantityGrams: '1.000000' }],
      });
    assert.equal(mixed.status, 400);

    const history = await request(app).get(`/api/v1/sites/${ids.siteId}/production-events/${ids.phase2ProductionEventId}/outputs/${ids.phase2Outputs[0].id}/allocation-sets`)
      .set('Authorization', `Bearer ${ids.siteToken}`);
    assert.equal(history.status, 200, history.text);
    assert.equal(history.body.revisions.length, 3);
    assert.deepEqual(history.body.revisions.map((set) => set.reviewHistory[0].review_status), ['PENDING', 'PENDING', 'PENDING']);
    assert.equal(history.body.activeApprovedSetId, null);
    assert.equal(history.body.revisions[0].rows.length, 2);
    assert.equal((await request(app).post(`/api/v1/sites/${ids.siteId}/production-events/${ids.phase2ProductionEventId}/outputs/${ids.phase2Outputs[0].id}/allocation-sets/${first.body.id}/approve`)
      .set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', randomUUID()).send({})).status, 404);

    const gatedCorrection = await request(app).post(`/api/v1/sites/${ids.siteId}/production-events/${ids.productionEventId}/outputs/${ids.outputs[0].id}/allocation-sets`)
      .set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', randomUUID()).send({
        basisKind: 'QUANTITY', basisMeasurementId: ids.measurementId, supersedesSetId: ids.allocationSetId,
        correctionReason: 'Policy gate check', rows: [{ beneficiaryPartyId: ids.minerPartyId, allocatedQuantityGrams: '5.000000' }],
      });
    assert.equal(gatedCorrection.status, 409);
    assert.equal(gatedCorrection.body.error.code, 'ALLOCATION_REVIEW_REQUIRED');
    assert.equal((await verifyAuditStream('material_event', ids.phase2ProductionEventId)).valid, true);
  });

  await t.test('Dora processing validates sources and preserves inputs, outputs, and residue lineage', async () => {
    const doraOne = await request(app).post(`/api/v1/sites/${ids.siteId}/doras`)
      .set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', randomUUID()).send({ name: 'Fictional Dora One' });
    const doraTwo = await request(app).post(`/api/v1/sites/${ids.siteId}/doras`)
      .set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', randomUUID()).send({ name: 'Fictional Dora Two' });
    assert.equal(doraOne.status, 201, doraOne.text);
    assert.equal(doraTwo.status, 201, doraTwo.text);
    ids.doraOneId = doraOne.body.id;
    ids.doraTwoId = doraTwo.body.id;
    assert.notEqual(ids.doraOneId, ids.doraTwoId);
    assert.equal((await request(app).get(`/api/v1/sites/${ids.siteId}/doras`).set('Authorization', `Bearer ${ids.siteToken}`)).body.length, 2);
    assert.equal((await request(app).get(`/api/v1/doras/${ids.doraOneId}`).set('Authorization', `Bearer ${ids.siteToken}`)).status, 404);

    const doraUser = await seedUser('dora-operator@example.test', 'Fictional Dora Operator', {
      roleCode: 'DORA_OPERATOR', scopeKind: 'FACILITY', scopeId: ids.doraOneId,
    });
    ids.doraUserId = doraUser.userId;
    ids.doraPartyId = doraUser.partyId;
    await db(`INSERT INTO role_assignment(id,user_id,role_code,scope_kind,scope_id) VALUES (:id,:userId,'FIELD_OFFICER','HOLE',:holeId)`, {
      id: randomUUID(), userId: doraUser.userId, holeId: ids.holeId,
    });
    ids.doraWeigherPartyId = await seedParty('PERSON', 'Fictional Dora Weigher');
    await db(`INSERT INTO facility_party_role(id,processing_facility_id,party_id,role_code,valid_from,asserted_by_user_id) VALUES (:id,:facilityId,:partyId,'WEIGHER','2026-11-01T00:00:00.000Z',:actor)`, {
      id: randomUUID(), facilityId: ids.doraOneId, partyId: ids.doraWeigherPartyId, actor: ids.siteUserId,
    });
    ids.doraToken = testToken(doraUser.userId);
    assert.equal((await request(app).get(`/api/v1/doras/${ids.doraOneId}`).set('Authorization', `Bearer ${ids.doraToken}`)).status, 200);
    assert.equal((await request(app).get(`/api/v1/doras/${ids.doraTwoId}`).set('Authorization', `Bearer ${ids.doraToken}`)).status, 404);

    const processingBody = {
      processingFacilityId: ids.doraOneId, occurredAt: happenedAt,
      compensationArrangementCode: 'RESIDUE_SERVICE_CONSIDERATION', serviceTermsRef: 'FICTIONAL-SERVICE-TERMS-1',
      inputs: [
        { sourceProductionOutputId: ids.phase2Outputs[0].id, measurements: [{ kind: 'MEASURED', quantityGrams: '9.500000', sourceValue: '9.5', sourceUnit: 'g', conversionVersion: 'test-v1', sourceRole: 'WEIGHER', sourcePartyId: ids.doraWeigherPartyId, occurredAt: happenedAt }] },
        { sourceProductionOutputId: ids.phase2Outputs[1].id, measurements: [{ kind: 'MEASURED', quantityGrams: '3.750000', sourceValue: '3.75', sourceUnit: 'g', conversionVersion: 'test-v1', sourceRole: 'WEIGHER', sourcePartyId: ids.doraWeigherPartyId, occurredAt: happenedAt }] },
      ],
      outputs: [
        { materialKind: 'GOLD_DORE', outputRole: 'MINER_RETAINED_GOLD', measurements: [{ kind: 'MEASURED', quantityGrams: '7.000000', sourceValue: '7', sourceUnit: 'g', conversionVersion: 'test-v1', sourceRole: 'WEIGHER', sourcePartyId: ids.doraWeigherPartyId, occurredAt: happenedAt }] },
        { materialKind: 'RESIDUE', outputRole: 'DORA_RETAINED_RESIDUE', measurements: [{ kind: 'MEASURED', quantityGrams: '4.000000', sourceValue: '4', sourceUnit: 'g', conversionVersion: 'test-v1', sourceRole: 'WEIGHER', sourcePartyId: ids.doraWeigherPartyId, occurredAt: happenedAt }] },
      ],
    };
    const processKey = randomUUID();
    const [processed, processReplay] = await Promise.all([
      request(app).post(`/api/v1/sites/${ids.siteId}/processing-events`)
        .set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', processKey).send(processingBody),
      request(app).post(`/api/v1/sites/${ids.siteId}/processing-events`)
        .set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', processKey).send(processingBody),
    ]);
    assert.equal(processed.status, 201, processed.text);
    assert.equal(processReplay.status, 201, processReplay.text);
    assert.equal(processReplay.body.id, processed.body.id);
    assert.equal([processed, processReplay].filter((response) => response.body.replayed).length, 1);
    ids.processingEventId = processed.body.id;
    ids.processingOutputs = processed.body.outputs;
    assert.equal(processed.body.processingFacilityId, ids.doraOneId);
    assert.equal(processed.body.inputs.length, 2);
    assert.equal(processed.body.outputs.length, 2);
    assert.deepEqual(processed.body.outputs.map((row) => row.outputRole), ['MINER_RETAINED_GOLD', 'DORA_RETAINED_RESIDUE']);
    assert.notEqual(processed.body.outputs[0].batchId, processed.body.outputs[1].batchId);

    const processDetails = await request(app).get(`/api/v1/processing-events/${ids.processingEventId}`).set('Authorization', `Bearer ${ids.doraToken}`);
    assert.equal(processDetails.status, 200, processDetails.text);
    assert.equal(processDetails.body.inputs.length, 2);
    assert.equal(processDetails.body.outputs.find((row) => row.output_role === 'DORA_RETAINED_RESIDUE').measurements.length, 1);
    assert.equal(processDetails.body.outputs[0].measurements[0].source_party_id, ids.doraWeigherPartyId);
    assert.equal((await request(app).get(`/api/v1/processing-events/${ids.processingEventId}`).set('Authorization', `Bearer ${ids.siteToken}`)).status, 404);

    const appended = await request(app).post(`/api/v1/processing-events/${ids.processingEventId}/outputs/${ids.processingOutputs[0].id}/measurements`)
      .set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', randomUUID()).send({
        kind: 'MEASURED', quantityGrams: '6.900000', sourceValue: '6.9', sourceUnit: 'g', conversionVersion: 'test-v1', sourceRole: 'WEIGHER', sourcePartyId: ids.doraWeigherPartyId,
        occurredAt: happenedAt, supersedesMeasurementId: ids.processingOutputs[0].measurements[0].id,
      });
    assert.equal(appended.status, 201, appended.text);
    assert.equal((await db(`SELECT supersedes_measurement_id FROM material_measurement WHERE id=:id`, { id: appended.body.id }, undefined, QueryTypes.SELECT))[0].supersedes_measurement_id, ids.processingOutputs[0].measurements[0].id);

    const beforeFailures = await db(`SELECT
      (SELECT count(*)::int FROM material_event WHERE event_kind='PROCESSING') AS events,
      (SELECT count(*)::int FROM processing_event_input) AS processing_inputs,
      (SELECT count(*)::int FROM processing_event_output) AS processing_outputs,
      (SELECT count(*)::int FROM material_event_input WHERE event_id IN (SELECT event_id FROM processing_event)) AS input_rows,
      (SELECT count(*)::int FROM material_batch) AS batches,
      (SELECT count(*)::int FROM material_measurement_set) AS measurement_sets,
      (SELECT count(*)::int FROM material_measurement) AS measurements,
      (SELECT count(*)::int FROM audit_event) AS audit_events`, {}, undefined, QueryTypes.SELECT);
    const unknownInput = await request(app).post(`/api/v1/sites/${ids.siteId}/processing-events`)
      .set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', randomUUID()).send({ ...processingBody, inputs: [{ ...processingBody.inputs[0], sourceProductionOutputId: randomUUID() }] });
    assert.equal(unknownInput.status, 404);
    const invalidOutput = await request(app).post(`/api/v1/sites/${ids.siteId}/processing-events`)
      .set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', randomUUID()).send({ ...processingBody, outputs: [
        { materialKind: 'GOLD_DORE', outputRole: 'DORA_RETAINED_RESIDUE', measurements: processingBody.outputs[0].measurements },
      ] });
    assert.equal(invalidOutput.status, 400, invalidOutput.text);
    const unrelatedProcessingParty = await seedParty('PERSON', 'Fictional Unrelated Processing Weigher');
    const invalidSourceProcessing = await request(app).post(`/api/v1/sites/${ids.siteId}/processing-events`)
      .set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', randomUUID()).send({
        ...processingBody,
        inputs: [{
          ...processingBody.inputs[0],
          measurements: [{ ...processingBody.inputs[0].measurements[0], sourcePartyId: unrelatedProcessingParty }],
        }],
      });
    assert.equal(invalidSourceProcessing.status, 400, invalidSourceProcessing.text);
    assert.equal(invalidSourceProcessing.body.error.code, 'INVALID_MEASUREMENT_SOURCE');
    const afterFailures = await db(`SELECT
      (SELECT count(*)::int FROM material_event WHERE event_kind='PROCESSING') AS events,
      (SELECT count(*)::int FROM processing_event_input) AS processing_inputs,
      (SELECT count(*)::int FROM processing_event_output) AS processing_outputs,
      (SELECT count(*)::int FROM material_event_input WHERE event_id IN (SELECT event_id FROM processing_event)) AS input_rows,
      (SELECT count(*)::int FROM material_batch) AS batches,
      (SELECT count(*)::int FROM material_measurement_set) AS measurement_sets,
      (SELECT count(*)::int FROM material_measurement) AS measurements,
      (SELECT count(*)::int FROM audit_event) AS audit_events`, {}, undefined, QueryTypes.SELECT);
    assert.deepEqual(afterFailures[0], beforeFailures[0]);
    assert.equal((await verifyAuditStream('processing_facility', ids.doraOneId)).valid, true);

    await assert.rejects(sequelize.transaction(async (transaction) => {
      const badEventId = randomUUID();
      const badInputId = randomUUID();
      await db(`INSERT INTO material_event(id,event_code,event_kind,occurred_at_claimed,responsible_party_id,actor_user_id)
        VALUES (:id,:code,'PROCESSING',:at,:partyId,:userId)`, { id: badEventId, code: `EVT-${badEventId}`, at: happenedAt, partyId: doraUser.partyId, userId: doraUser.userId }, transaction);
      await db(`INSERT INTO processing_event(event_id,processing_facility_id,operator_party_id) VALUES (:id,:facilityId,:partyId)`, { id: badEventId, facilityId: ids.doraOneId, partyId: doraUser.partyId }, transaction);
      await db(`INSERT INTO material_event_input(id,event_id,batch_id,input_sequence) VALUES (:id,:eventId,:batchId,1)`, { id: badInputId, eventId: badEventId, batchId: ids.phase2Outputs[0].batchId }, transaction);
      await db(`INSERT INTO processing_event_input(material_event_input_id,processing_event_id,source_production_output_id) VALUES (:inputId,:eventId,:sourceId)`, { inputId: badInputId, eventId: badEventId, sourceId: ids.phase2Outputs[1].id }, transaction);
    }), sqlError('23514'));
  });

  await t.test('QR writes require lineage access; lookup stays authorized and revocation works', async () => {
    const secondDoraUser = await seedUser('other-dora-operator@example.test', 'Fictional Other Dora Operator', {
      roleCode: 'DORA_OPERATOR', scopeKind: 'FACILITY', scopeId: ids.doraTwoId,
    });
    await db(`INSERT INTO role_assignment(id,user_id,role_code,scope_kind,scope_id) VALUES (:id,:userId,'FIELD_OFFICER','HOLE',:holeId)`, {
      id: randomUUID(), userId: secondDoraUser.userId, holeId: ids.holeId,
    });
    ids.doraTwoOperatorUserId = secondDoraUser.userId;
    ids.doraTwoToken = testToken(secondDoraUser.userId);
    const secondDoraProfile = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${ids.doraTwoToken}`);
    assert.equal(secondDoraProfile.status, 200, secondDoraProfile.text);
    assert.ok(secondDoraProfile.body.roles.some((role) => role.role_code === 'DORA_OPERATOR' && role.scope_id === ids.doraTwoId));

    const siteAuditorProfile = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${ids.siteAuditorToken}`);
    assert.equal(siteAuditorProfile.status, 200, siteAuditorProfile.text);
    assert.ok(siteAuditorProfile.body.roles.some((role) => role.role_code === 'AUDITOR' && role.scope_kind === 'SITE' && role.scope_id === ids.siteId));

    const processingQr = await request(app).post(`/api/v1/material-batches/${ids.processingOutputs[1].batchId}/qr`)
      .set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', randomUUID()).send({});
    assert.equal(processingQr.status, 201, processingQr.text);
    assert.match(processingQr.body.payload, /^[A-Za-z0-9_-]{40,60}$/);
    assert.equal(processingQr.body.payload.includes(ids.processingOutputs[1].batchId), false);
    assert.equal((await db(`SELECT octet_length(public_token_hash) AS size FROM qr_record WHERE id=:id`, { id: processingQr.body.qrRecordId }, undefined, QueryTypes.SELECT))[0].size, 32);
    assert.equal((await request(app).get(`/api/v1/qr/${processingQr.body.payload}`)).status, 401);
    assert.equal((await request(app).get(`/api/v1/qr/${processingQr.body.payload}`).set('Authorization', `Bearer ${ids.siteToken}`)).status, 404);
    const resolved = await request(app).get(`/api/v1/qr/${processingQr.body.payload}`).set('Authorization', `Bearer ${ids.doraToken}`);
    assert.equal(resolved.status, 200, resolved.text);
    assert.equal(resolved.body.material_batch_id, ids.processingOutputs[1].batchId);
    assert.ok(resolved.body.origins.some((origin) => origin.processing_facility_id === ids.doraOneId));

    const deniedFacilityCreate = await request(app).post(`/api/v1/material-batches/${ids.processingOutputs[1].batchId}/qr`)
      .set('Authorization', `Bearer ${ids.doraTwoToken}`).set('Idempotency-Key', randomUUID()).send({});
    const deniedFacilityRotate = await request(app).post(`/api/v1/material-batches/${ids.processingOutputs[1].batchId}/qr/rotate`)
      .set('Authorization', `Bearer ${ids.doraTwoToken}`).set('Idempotency-Key', randomUUID()).send({});
    assert.equal(deniedFacilityCreate.status, 404);
    assert.equal(deniedFacilityRotate.status, 404);

    const sourceBatchId = ids.phase2Outputs[0].batchId;
    const qrKey = randomUUID();
    const sourceQr = await request(app).post(`/api/v1/material-batches/${sourceBatchId}/qr`)
      .set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', qrKey).send({});
    const sourceReplay = await request(app).post(`/api/v1/material-batches/${sourceBatchId}/qr`)
      .set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', qrKey).send({});
    assert.equal(sourceQr.status, 201, sourceQr.text);
    assert.equal(sourceReplay.body.payload, sourceQr.body.payload);
    const [sourceBatch] = await db(`SELECT batch_code FROM material_batch WHERE id=:id`, { id: sourceBatchId }, undefined, QueryTypes.SELECT);
    const sourceSearch = await request(app).get(`/api/v1/material-batches?query=${encodeURIComponent(sourceBatch.batch_code)}`)
      .set('Authorization', `Bearer ${ids.siteToken}`);
    assert.equal(sourceSearch.status, 200, sourceSearch.text);
    assert.ok(sourceSearch.body.some((row) => row.id === sourceBatchId && row.batch_code === sourceBatch.batch_code));
    const sourceTrace = await request(app).get(`/api/v1/material-batches/${sourceBatchId}/traceability`)
      .set('Authorization', `Bearer ${ids.siteToken}`);
    assert.equal(sourceTrace.status, 200, sourceTrace.text);
    assert.equal(sourceTrace.body.batch.id, sourceBatchId);
    assert.ok(sourceTrace.body.productionEvents.some((event) => event.id === ids.phase2ProductionEventId));
    const processingTrace = await request(app).get(`/api/v1/material-batches/${ids.processingOutputs[1].batchId}/traceability`)
      .set('Authorization', `Bearer ${ids.doraToken}`);
    assert.equal(processingTrace.status, 200, processingTrace.text);
    assert.ok(processingTrace.body.processingEvents.some((event) => event.id === ids.processingEventId));
    assert.ok(processingTrace.body.productionEvents.some((event) => event.id === ids.phase2ProductionEventId), 'hole-scoped production source remains visible through its authorized record service');

    const siteOperator = await seedUser('site-mining-operator@example.test', 'Fictional Site Mining Operator', {
      roleCode: 'MINING_OPERATOR', scopeKind: 'SITE', scopeId: ids.siteId,
    });
    const siteOperatorToken = testToken(siteOperator.userId);
    const siteOperatorQr = await request(app).post(`/api/v1/material-batches/${ids.outputs[0].batchId}/qr`)
      .set('Authorization', `Bearer ${siteOperatorToken}`).set('Idempotency-Key', randomUUID()).send({});
    assert.equal(siteOperatorQr.status, 201, siteOperatorQr.text);
    const siteOperatorRotation = await request(app).post(`/api/v1/material-batches/${ids.outputs[0].batchId}/qr/rotate`)
      .set('Authorization', `Bearer ${siteOperatorToken}`).set('Idempotency-Key', randomUUID()).send({});
    assert.equal(siteOperatorRotation.status, 201, siteOperatorRotation.text);

    const auditorCreate = await request(app).post(`/api/v1/material-batches/${sourceBatchId}/qr`)
      .set('Authorization', `Bearer ${ids.siteAuditorToken}`).set('Idempotency-Key', randomUUID()).send({});
    const auditorRotate = await request(app).post(`/api/v1/material-batches/${sourceBatchId}/qr/rotate`)
      .set('Authorization', `Bearer ${ids.siteAuditorToken}`).set('Idempotency-Key', randomUUID()).send({});
    assert.equal(auditorCreate.status, 404);
    assert.equal(auditorRotate.status, 404);
    assert.equal((await request(app).get(`/api/v1/qr/${sourceQr.body.payload}`).set('Authorization', `Bearer ${ids.siteAuditorToken}`)).status, 200);

    const holeUser = await seedUser('hole-qr-operator@example.test', 'Fictional Hole QR Operator', {
      roleCode: 'FIELD_OFFICER', scopeKind: 'HOLE', scopeId: ids.secondHoleId,
    });
    const holeToken = testToken(holeUser.userId);
    const holeQr = await request(app).post(`/api/v1/material-batches/${ids.holeA2BatchId}/qr`)
      .set('Authorization', `Bearer ${holeToken}`).set('Idempotency-Key', randomUUID()).send({});
    assert.equal(holeQr.status, 201, holeQr.text);
    const holeRotated = await request(app).post(`/api/v1/material-batches/${ids.holeA2BatchId}/qr/rotate`)
      .set('Authorization', `Bearer ${holeToken}`).set('Idempotency-Key', randomUUID()).send({});
    assert.equal(holeRotated.status, 201, holeRotated.text);
    const crossHoleCreate = await request(app).post(`/api/v1/material-batches/${sourceBatchId}/qr`)
      .set('Authorization', `Bearer ${holeToken}`).set('Idempotency-Key', randomUUID()).send({});
    const crossHoleRotate = await request(app).post(`/api/v1/material-batches/${sourceBatchId}/qr/rotate`)
      .set('Authorization', `Bearer ${holeToken}`).set('Idempotency-Key', randomUUID()).send({});
    assert.equal(crossHoleCreate.status, 404);
    assert.equal(crossHoleRotate.status, 404);

    const otherSiteUser = await seedUser('other-site-qr-operator@example.test', 'Fictional Other Site Operator', {
      roleCode: 'FIELD_OFFICER', scopeKind: 'SITE', scopeId: ids.siteBId,
    });
    const otherSiteToken = testToken(otherSiteUser.userId);
    const unrelatedSearch = await request(app).get(`/api/v1/material-batches?query=${encodeURIComponent(sourceBatch.batch_code)}`)
      .set('Authorization', `Bearer ${otherSiteToken}`);
    assert.equal(unrelatedSearch.status, 200, unrelatedSearch.text);
    assert.deepEqual(unrelatedSearch.body, []);
    const unrelatedTrace = await request(app).get(`/api/v1/material-batches/${sourceBatchId}/traceability`)
      .set('Authorization', `Bearer ${otherSiteToken}`);
    assert.equal(unrelatedTrace.status, 404, unrelatedTrace.text);
    const crossSiteCreate = await request(app).post(`/api/v1/material-batches/${sourceBatchId}/qr`)
      .set('Authorization', `Bearer ${otherSiteToken}`).set('Idempotency-Key', randomUUID()).send({});
    const crossSiteRotate = await request(app).post(`/api/v1/material-batches/${sourceBatchId}/qr/rotate`)
      .set('Authorization', `Bearer ${otherSiteToken}`).set('Idempotency-Key', randomUUID()).send({});
    assert.equal(crossSiteCreate.status, 404);
    assert.equal(crossSiteRotate.status, 404);

    const rotated = await request(app).post(`/api/v1/material-batches/${sourceBatchId}/qr/rotate`)
      .set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', randomUUID()).send({});
    assert.equal(rotated.status, 201, rotated.text);
    assert.notEqual(rotated.body.payload, sourceQr.body.payload);
    assert.equal((await request(app).get(`/api/v1/qr/${sourceQr.body.payload}`).set('Authorization', `Bearer ${ids.siteToken}`)).status, 404);
    assert.equal((await request(app).get(`/api/v1/qr/${rotated.body.payload}`).set('Authorization', `Bearer ${ids.siteToken}`)).status, 200);
    const rotation = await db(`SELECT status,rotated_from_id FROM qr_record WHERE id=:id`, { id: rotated.body.qrRecordId }, undefined, QueryTypes.SELECT);
    assert.equal(rotation[0].status, 'ACTIVE');
    assert.equal(rotation[0].rotated_from_id, sourceQr.body.qrRecordId);
  });

  await t.test('Phase 3 residue pooling, consignment, custody, receipt, and recovery workflows', async (phase) => {
    ids.phaseThree = {};
    await db(`INSERT INTO role_assignment(id,user_id,role_code,scope_kind,scope_id) VALUES (:id,:userId,'DORA_OPERATOR','FACILITY',:facilityId)`, {
      id: randomUUID(), userId: ids.doraUserId, facilityId: ids.doraTwoId,
    });
    const secondDoraProcessing = await request(app).post(`/api/v1/sites/${ids.siteId}/processing-events`)
      .set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', randomUUID()).send({
        processingFacilityId: ids.doraTwoId, occurredAt: happenedAt,
        inputs: [{ sourceProductionOutputId: ids.phase2Outputs[0].id, measurements: [{ kind: 'MEASURED', quantityGrams: '3.000000', sourceValue: '3', sourceUnit: 'g', conversionVersion: 'test-v1', sourceRole: 'RECORDER' }] }],
        outputs: [
          { materialKind: 'RESIDUE', outputRole: 'DORA_RETAINED_RESIDUE', measurements: [{ kind: 'VERIFIED', quantityGrams: '3.000000', sourceValue: '3', sourceUnit: 'g', conversionVersion: 'test-v1', sourceRole: 'RECORDER' }] },
          { materialKind: 'GOLD_DORE', outputRole: 'MINER_RETAINED_GOLD', measurements: [{ kind: 'MEASURED', quantityGrams: '1.000000', sourceValue: '1', sourceUnit: 'g', conversionVersion: 'test-v1', sourceRole: 'RECORDER' }] },
        ],
      });
    assert.equal(secondDoraProcessing.status, 201, secondDoraProcessing.text);
    ids.phaseThree.secondDoraResidue = secondDoraProcessing.body.outputs[0];

    ids.phaseThree.recoveryPartyId = await seedParty('ORGANISATION', 'Fictional Recovery Facility', 'RECOVERY_FACILITY');
    ids.phaseThree.recoveryFacilityId = randomUUID();
    await db(`INSERT INTO recovery_facility(id,party_id,name,status) VALUES (:id,:partyId,'Fictional Recovery Facility','ACTIVE')`, {
      id: ids.phaseThree.recoveryFacilityId, partyId: ids.phaseThree.recoveryPartyId,
    });
    const recoveryOperator = await seedUser('recovery-operator@example.test', 'Fictional Recovery Operator', {
      roleCode: 'RECOVERY_FACILITY_OPERATOR', scopeKind: 'FACILITY', scopeId: ids.phaseThree.recoveryFacilityId,
    });
    ids.phaseThree.recoveryUserId = recoveryOperator.userId;
    ids.phaseThree.recoveryPartyUserId = recoveryOperator.partyId;
    ids.phaseThree.recoveryRoleId = recoveryOperator.roleAssignmentId;
    ids.phaseThree.recoveryToken = testToken(recoveryOperator.userId);
    const recoveryAuditor = await seedUser('recovery-auditor@example.test', 'Fictional Recovery Auditor', {
      roleCode: 'AUDITOR', scopeKind: 'FACILITY', scopeId: ids.phaseThree.recoveryFacilityId,
    });
    ids.phaseThree.recoveryAuditorToken = testToken(recoveryAuditor.userId);
    ids.phaseThree.otherRecoveryPartyId = await seedParty('ORGANISATION', 'Unrelated Fictional Recovery Facility', 'RECOVERY_FACILITY');
    ids.phaseThree.otherRecoveryFacilityId = randomUUID();
    await db(`INSERT INTO recovery_facility(id,party_id,name,status) VALUES (:id,:partyId,'Unrelated Fictional Recovery Facility','ACTIVE')`, {
      id: ids.phaseThree.otherRecoveryFacilityId, partyId: ids.phaseThree.otherRecoveryPartyId,
    });
    const unrelatedRecoveryUser = await seedUser('unrelated-recovery-operator@example.test', 'Unrelated Fictional Recovery Operator', {
      roleCode: 'RECOVERY_FACILITY_OPERATOR', scopeKind: 'FACILITY', scopeId: ids.phaseThree.otherRecoveryFacilityId,
    });
    ids.phaseThree.otherRecoveryToken = testToken(unrelatedRecoveryUser.userId);

    await phase.test('authorized Dora operators create typed stockpile locations', async () => {
      const first = await request(app).post(`/api/v1/doras/${ids.doraOneId}/stockpiles`).set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', randomUUID()).send({ stockpileCode: 'P3-DORA1-PILE-A', locationCode: 'P3-DORA1-LOC-A' });
      const second = await request(app).post(`/api/v1/doras/${ids.doraOneId}/stockpiles`).set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', randomUUID()).send({ stockpileCode: 'P3-DORA1-PILE-B', locationCode: 'P3-DORA1-LOC-B' });
      const other = await request(app).post(`/api/v1/doras/${ids.doraTwoId}/stockpiles`).set('Authorization', `Bearer ${ids.doraTwoToken}`).set('Idempotency-Key', randomUUID()).send({ stockpileCode: 'P3-DORA2-PILE-A', locationCode: 'P3-DORA2-LOC-A' });
      assert.equal(first.status, 201, first.text);
      assert.equal(second.status, 201, second.text);
      assert.equal(other.status, 201, other.text);
      ids.phaseThree.stockpileOne = first.body.id;
      ids.phaseThree.stockpileTwo = second.body.id;
      ids.phaseThree.stockpileOtherDora = other.body.id;
      assert.equal((await db(`SELECT count(*)::int AS total FROM inventory_location l JOIN residue_stockpile s ON s.inventory_location_id=l.id WHERE l.id IN (:one,:two,:other) AND l.location_kind='STOCKPILE'`, { one: first.body.id, two: second.body.id, other: other.body.id }, undefined, QueryTypes.SELECT))[0].total, 3);
    });

    await phase.test('Dora residue intake preserves selected output lineage and idempotent retries', async () => {
      const body = { occurredAt: happenedAt, evidenceRef: 'fictional-stockpile-intake-a', outputs: [{ outputId: ids.processingOutputs[1].id, measurementId: ids.processingOutputs[1].measurements[0].id }] };
      const key = randomUUID();
      const [first, retry] = await Promise.all([
        request(app).post(`/api/v1/stockpiles/${ids.phaseThree.stockpileOne}/intake`).set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', key).send(body),
        request(app).post(`/api/v1/stockpiles/${ids.phaseThree.stockpileOne}/intake`).set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', key).send(body),
      ]);
      assert.equal(first.status, 201, first.text);
      assert.equal(retry.status, 201, retry.text);
      assert.equal([first, retry].filter((response) => response.body.replayed).length, 1);
      assert.equal(retry.body.id, first.body.id);
      const [intake] = await db(`SELECT source_material_event_output_id,batch_id FROM inventory_movement_line WHERE inventory_movement_id=:movementId`, { movementId: first.body.id }, undefined, QueryTypes.SELECT);
      assert.equal(intake.source_material_event_output_id, ids.processingOutputs[1].id);
      assert.equal(intake.batch_id, ids.processingOutputs[1].batchId);
      assert.equal((await request(app).post(`/api/v1/stockpiles/${ids.phaseThree.stockpileOne}/intake`).set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', randomUUID()).send(body)).body.error.code, 'RESIDUE_ALREADY_RECEIVED');
    });

    await phase.test('unrelated facilities and invalid source outputs cannot stockpile material', async () => {
      const ownWrongOutput = await request(app).post(`/api/v1/stockpiles/${ids.phaseThree.stockpileOne}/intake`).set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', randomUUID()).send({ occurredAt: happenedAt, outputs: [{ outputId: ids.phaseThree.secondDoraResidue.id, measurementId: ids.phaseThree.secondDoraResidue.measurements[0].id }] });
      const goldOutput = await request(app).post(`/api/v1/stockpiles/${ids.phaseThree.stockpileOne}/intake`).set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', randomUUID()).send({ occurredAt: happenedAt, outputs: [{ outputId: ids.processingOutputs[0].id, measurementId: ids.processingOutputs[0].measurements[0].id }] });
      const crossFacility = await request(app).post(`/api/v1/stockpiles/${ids.phaseThree.stockpileOne}/intake`).set('Authorization', `Bearer ${ids.doraTwoToken}`).set('Idempotency-Key', randomUUID()).send({ occurredAt: happenedAt, outputs: [{ outputId: ids.processingOutputs[1].id, measurementId: ids.processingOutputs[1].measurements[0].id }] });
      assert.equal(ownWrongOutput.status, 400);
      assert.equal(goldOutput.status, 400);
      assert.equal(crossFacility.status, 404);
      const [total] = await db(`SELECT count(*)::int AS total FROM inventory_movement_line WHERE source_material_event_output_id IN (:residueId,:otherResidueId)`, { residueId: ids.processingOutputs[1].id, otherResidueId: ids.phaseThree.secondDoraResidue.id }, undefined, QueryTypes.SELECT);
      assert.equal(total.total, 1);
    });

    await phase.test('Dora intake requires a current measured or verified output observation', async () => {
      async function createResidueOutput(kind, quantityGrams, code) {
        const response = await request(app).post(`/api/v1/sites/${ids.siteId}/processing-events`)
          .set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', randomUUID()).send({
            processingFacilityId: ids.doraOneId, occurredAt: happenedAt,
            inputs: [{ sourceProductionOutputId: ids.phase2Outputs[0].id, measurements: [{ kind: 'MEASURED', quantityGrams: '1.000000', sourceValue: '1', sourceUnit: 'g', conversionVersion: 'test-v1', sourceRole: 'RECORDER' }] }],
            outputs: [{ materialKind: 'RESIDUE', outputRole: 'DORA_RETAINED_RESIDUE', outputKind: code, measurements: [{ kind, quantityGrams, sourceValue: quantityGrams, sourceUnit: 'g', conversionVersion: 'test-v1', sourceRole: 'RECORDER', occurredAt: happenedAt }] }],
          });
        assert.equal(response.status, 201, response.text);
        return { eventId: response.body.id, output: response.body.outputs[0] };
      }

      const declared = await createResidueOutput('DECLARED', '0.750000', 'DECLARED-RESIDUE');
      const declaredIntake = await request(app).post(`/api/v1/stockpiles/${ids.phaseThree.stockpileOne}/intake`)
        .set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', randomUUID()).send({
          occurredAt: happenedAt, outputs: [{ outputId: declared.output.id, measurementId: declared.output.measurements[0].id }],
        });
      assert.equal(declaredIntake.status, 400);
      assert.equal(declaredIntake.body.error.code, 'INVALID_RESIDUE_SOURCE');

      const measured = await createResidueOutput('MEASURED', '0.600000', 'CORRECTED-RESIDUE');
      const sibling = await createResidueOutput('MEASURED', '0.250000', 'SIBLING-RESIDUE');
      const corrected = await request(app).post(`/api/v1/processing-events/${measured.eventId}/outputs/${measured.output.id}/measurements`)
        .set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', randomUUID()).send({
          kind: 'MEASURED', quantityGrams: '0.550000', sourceValue: '0.55', sourceUnit: 'g', conversionVersion: 'test-v1',
          sourceRole: 'RECORDER', occurredAt: happenedAt, supersedesMeasurementId: measured.output.measurements[0].id,
        });
      assert.equal(corrected.status, 201, corrected.text);
      const staleIntake = await request(app).post(`/api/v1/stockpiles/${ids.phaseThree.stockpileOne}/intake`)
        .set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', randomUUID()).send({
          occurredAt: happenedAt, outputs: [{ outputId: measured.output.id, measurementId: measured.output.measurements[0].id }],
        });
      const crossOutputMeasurement = await request(app).post(`/api/v1/stockpiles/${ids.phaseThree.stockpileOne}/intake`)
        .set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', randomUUID()).send({
          occurredAt: happenedAt, outputs: [{ outputId: measured.output.id, measurementId: sibling.output.measurements[0].id }],
        });
      assert.equal(staleIntake.status, 400);
      assert.equal(crossOutputMeasurement.status, 400);

      await assert.rejects(sequelize.transaction(async (transaction) => {
        const movementId = randomUUID();
        await db(`INSERT INTO inventory_movement(id,movement_kind,current_status,actor_user_id,occurred_at_claimed)
          VALUES (:id,'INTAKE','DRAFT',:actor,:at)`, { id: movementId, actor: ids.doraUserId, at: happenedAt }, transaction);
        await db(`INSERT INTO inventory_movement_line(id,inventory_movement_id,batch_id,location_id,direction,posted_quantity_g,basis_measurement_set_id,basis_measurement_id,source_material_event_output_id,line_no)
          VALUES (:id,:movementId,:batchId,:locationId,'IN','0.540000',:setId,:measurementId,:outputId,1)`, {
          id: randomUUID(), movementId, batchId: measured.output.batchId, locationId: ids.phaseThree.stockpileOne,
          setId: measured.output.measurementSetId, measurementId: corrected.body.id, outputId: measured.output.id,
        }, transaction);
        await db(`UPDATE inventory_movement SET current_status='ACCEPTED' WHERE id=:id`, { id: movementId }, transaction);
      }), sqlError('23514'));

      const validIntake = await request(app).post(`/api/v1/stockpiles/${ids.phaseThree.stockpileOne}/intake`)
        .set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', randomUUID()).send({
          occurredAt: happenedAt, outputs: [{ outputId: measured.output.id, measurementId: corrected.body.id }],
        });
      assert.equal(validIntake.status, 201, validIntake.text);
      const history = await db(`SELECT measurement_kind,quantity_g,supersedes_measurement_id FROM material_measurement
        WHERE id IN (:prior,:current) ORDER BY quantity_g DESC`, { prior: measured.output.measurements[0].id, current: corrected.body.id }, undefined, QueryTypes.SELECT);
      assert.equal(history.length, 2);
      assert.equal(history[0].quantity_g, '0.600000');
      assert.equal(history[1].quantity_g, '0.550000');
      assert.equal(history[1].supersedes_measurement_id, measured.output.measurements[0].id);
      const [posted] = await db(`SELECT posted_quantity_g FROM inventory_movement_line WHERE source_material_event_output_id=:outputId`, { outputId: measured.output.id }, undefined, QueryTypes.SELECT);
      assert.equal(posted.posted_quantity_g, '0.550000');
    });

    await phase.test('a second Dora source batch enters its own stockpile with full origin', async () => {
      const output = ids.phaseThree.secondDoraResidue;
      const response = await request(app).post(`/api/v1/stockpiles/${ids.phaseThree.stockpileOtherDora}/intake`).set('Authorization', `Bearer ${ids.doraTwoToken}`).set('Idempotency-Key', randomUUID()).send({ occurredAt: happenedAt, outputs: [{ outputId: output.id, measurementId: output.measurements[0].id }] });
      assert.equal(response.status, 201, response.text);
      const [origin] = await db(`SELECT pe.processing_facility_id,peo.output_role FROM material_event_output eo JOIN processing_event_output peo ON peo.material_event_output_id=eo.id JOIN processing_event pe ON pe.event_id=peo.processing_event_id WHERE eo.id=:outputId`, { outputId: output.id }, undefined, QueryTypes.SELECT);
      assert.equal(origin.processing_facility_id, ids.doraTwoId);
      assert.equal(origin.output_role, 'DORA_RETAINED_RESIDUE');
    });

    await phase.test('pooling can move a measured partial batch between stockpiles without a second ledger', async () => {
      const response = await request(app).post(`/api/v1/stockpiles/${ids.phaseThree.stockpileOne}/transfers`).set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', randomUUID()).send({
        destinationStockpileId: ids.phaseThree.stockpileTwo, occurredAt: happenedAt, evidenceRef: 'fictional-pile-split',
        items: [{ batchId: ids.processingOutputs[1].batchId, quantityGrams: '1.500000' }],
      });
      assert.equal(response.status, 201, response.text);
      ids.phaseThree.poolMovementId = response.body.id;
      const balances = await db(`SELECT location_id,quantity_g FROM inventory_balance WHERE batch_id=:batchId AND location_id IN (:source,:target) ORDER BY location_id`, { batchId: ids.processingOutputs[1].batchId, source: ids.phaseThree.stockpileOne, target: ids.phaseThree.stockpileTwo }, undefined, QueryTypes.SELECT);
      assert.equal(balances.find((row) => row.location_id === ids.phaseThree.stockpileOne).quantity_g, '2.500000');
      assert.equal(balances.find((row) => row.location_id === ids.phaseThree.stockpileTwo).quantity_g, '1.500000');
      assert.equal((await db(`SELECT count(*)::int AS total FROM inventory_movement_line WHERE inventory_movement_id=:id`, { id: response.body.id }, undefined, QueryTypes.SELECT))[0].total, 2);
      assert.equal((await db(`SELECT count(*)::int AS total FROM information_schema.tables WHERE table_schema='public' AND table_name='stockpile_movement'`, {}, undefined, QueryTypes.SELECT))[0].total, 0);

      const otherDoraBatchId = ids.phaseThree.secondDoraResidue.batchId;
      const pooledAcrossDoras = await request(app).post(`/api/v1/stockpiles/${ids.phaseThree.stockpileOtherDora}/transfers`).set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', randomUUID()).send({
        destinationStockpileId: ids.phaseThree.stockpileTwo, occurredAt: happenedAt, evidenceRef: 'fictional-cross-dora-pooling',
        items: [{ batchId: otherDoraBatchId, quantityGrams: '0.500000' }],
      });
      assert.equal(pooledAcrossDoras.status, 201, pooledAcrossDoras.text);
      let crossDoraBalances = await db(`SELECT location_id,quantity_g FROM inventory_balance WHERE batch_id=:batchId AND location_id IN (:source,:target) ORDER BY location_id`, { batchId: otherDoraBatchId, source: ids.phaseThree.stockpileOtherDora, target: ids.phaseThree.stockpileTwo }, undefined, QueryTypes.SELECT);
      assert.equal(crossDoraBalances.find((row) => row.location_id === ids.phaseThree.stockpileOtherDora).quantity_g, '2.500000');
      assert.equal(crossDoraBalances.find((row) => row.location_id === ids.phaseThree.stockpileTwo).quantity_g, '0.500000');
      const restored = await request(app).post(`/api/v1/stockpiles/${ids.phaseThree.stockpileTwo}/transfers`).set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', randomUUID()).send({
        destinationStockpileId: ids.phaseThree.stockpileOtherDora, occurredAt: happenedAt, evidenceRef: 'fictional-cross-dora-pooling-restore',
        items: [{ batchId: otherDoraBatchId, quantityGrams: '0.500000' }],
      });
      assert.equal(restored.status, 201, restored.text);
      crossDoraBalances = await db(`SELECT location_id,quantity_g FROM inventory_balance WHERE batch_id=:batchId AND location_id IN (:source,:target) ORDER BY location_id`, { batchId: otherDoraBatchId, source: ids.phaseThree.stockpileOtherDora, target: ids.phaseThree.stockpileTwo }, undefined, QueryTypes.SELECT);
      assert.equal(crossDoraBalances.find((row) => row.location_id === ids.phaseThree.stockpileOtherDora).quantity_g, '3.000000');
      assert.equal(crossDoraBalances.find((row) => row.location_id === ids.phaseThree.stockpileTwo).quantity_g, '0.000000');
    });

    await phase.test('offline inventory commands serialize, retain receipts, and enforce live facility roles', async () => {
      const doraContext = { userId: ids.doraUserId, partyId: ids.doraPartyId, roleCode: 'DORA_OPERATOR', scopeKind: 'FACILITY', scopeId: ids.doraOneId };
      const makeStockpileTransfer = () => makeSyncEnvelope({
        ...doraContext, commandType: 'stockpile.transfer', actualParticipant: { identityState: 'UNKNOWN' },
        payload: { sourceLocationId: ids.phaseThree.stockpileOne, input: {
          destinationStockpileId: ids.phaseThree.stockpileTwo, occurredAt: happenedAt, evidenceRef: 'offline-pooling-transfer',
          items: [{ batchId: ids.processingOutputs[1].batchId, quantityGrams: '0.100000' }],
        } },
      });
      const versionedPair = await Promise.all([makeStockpileTransfer(), makeStockpileTransfer()].map((envelope) => versionSyncEnvelope(ids.doraToken, envelope)));
      const concurrent = await Promise.all(versionedPair.map((envelope) => submitSyncEnvelope(ids.doraToken, envelope)));
      assert.deepEqual(concurrent.map((response) => response.status).sort(), [200, 409], JSON.stringify(concurrent.map((response) => response.body)));
      const winnerIndex = concurrent.findIndex((response) => response.status === 200);
      const loserIndex = 1 - winnerIndex;
      assert.equal(concurrent[loserIndex].body.receipt.error.code, 'STALE_VERSION');
      const retry = await submitSyncEnvelope(ids.doraToken, versionedPair[winnerIndex]);
      assert.equal(retry.status, 200, retry.text);
      assert.equal(retry.body.receipt.response.id, concurrent[winnerIndex].body.receipt.response.id);
      assert.equal((await db(`SELECT count(*)::int AS total FROM sync_command_receipt_history h JOIN sync_command_receipt r ON r.id=h.receipt_id
        WHERE r.client_mutation_id=:id AND h.to_status='SERVER_ACCEPTED'`, { id: versionedPair[winnerIndex].clientMutationId }, undefined, QueryTypes.SELECT))[0].total, 1);

      const staleRevision = makeSyncEnvelope({
        ...doraContext, commandType: 'stockpile.transfer', actualParticipant: { identityState: 'UNKNOWN' },
        payload: versionedPair[loserIndex].payload, parentCommandIds: [versionedPair[loserIndex].clientMutationId], revisionOf: versionedPair[loserIndex].clientMutationId,
      });
      const correctedRevision = await versionSyncEnvelope(ids.doraToken, staleRevision);
      const correctedTransfer = await submitSyncEnvelope(ids.doraToken, correctedRevision);
      assert.equal(correctedTransfer.status, 200, correctedTransfer.text);
      assert.equal(correctedTransfer.body.receipt.status, 'server_accepted');

      const revoked = await seedUser('revoked-offline-stockpile@example.test', 'Revoked Offline Stockpile Operator', {
        roleCode: 'DORA_OPERATOR', scopeKind: 'FACILITY', scopeId: ids.doraOneId,
      });
      const revokedToken = testToken(revoked.userId);
      await db(`UPDATE role_assignment SET status='REVOKED',valid_to=now() WHERE id=:id`, { id: revoked.roleAssignmentId });
      const revokedEnvelope = makeSyncEnvelope({
        userId: revoked.userId, partyId: revoked.partyId, roleCode: 'DORA_OPERATOR', scopeKind: 'FACILITY', scopeId: ids.doraOneId,
        commandType: 'stockpile.transfer', actualParticipant: { identityState: 'UNKNOWN' },
        expectedVersion: correctedRevision.expectedVersion,
        payload: versionedPair[0].payload,
      });
      const revokedWrite = await submitSyncEnvelope(revokedToken, revokedEnvelope);
      assert.equal(revokedWrite.status, 422, revokedWrite.text);
      assert.equal(revokedWrite.body.receipt.error.code, 'ACTING_CONTEXT_REVOKED');

      const unrelated = await seedUser('other-dora-offline@example.test', 'Other Dora Offline Operator', {
        roleCode: 'DORA_OPERATOR', scopeKind: 'FACILITY', scopeId: ids.doraTwoId,
      });
      const unrelatedEnvelope = makeSyncEnvelope({
        userId: unrelated.userId, partyId: unrelated.partyId, roleCode: 'DORA_OPERATOR', scopeKind: 'FACILITY', scopeId: ids.doraTwoId,
        commandType: 'stockpile.transfer', actualParticipant: { identityState: 'UNKNOWN' },
        expectedVersion: correctedRevision.expectedVersion, payload: versionedPair[0].payload,
      });
      const crossFacility = await submitSyncEnvelope(testToken(unrelated.userId), unrelatedEnvelope);
      assert.equal(crossFacility.status, 422, crossFacility.text);
      assert.equal(crossFacility.body.receipt.error.code, 'RESOURCE_NOT_FOUND');
    });

    await phase.test('stockpile transfers reject overdraw, same-location transfer, and cross-Dora access', async () => {
      const overdraw = await request(app).post(`/api/v1/stockpiles/${ids.phaseThree.stockpileOne}/transfers`).set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', randomUUID()).send({ destinationStockpileId: ids.phaseThree.stockpileTwo, occurredAt: happenedAt, evidenceRef: 'fictional-overdraw', items: [{ batchId: ids.processingOutputs[1].batchId, quantityGrams: '9.000000' }] });
      const sameLocation = await request(app).post(`/api/v1/stockpiles/${ids.phaseThree.stockpileOne}/transfers`).set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', randomUUID()).send({ destinationStockpileId: ids.phaseThree.stockpileOne, occurredAt: happenedAt, evidenceRef: 'fictional-same-pile', items: [{ batchId: ids.processingOutputs[1].batchId, quantityGrams: '1.000000' }] });
      const crossDora = await request(app).post(`/api/v1/stockpiles/${ids.phaseThree.stockpileOne}/transfers`).set('Authorization', `Bearer ${ids.doraTwoToken}`).set('Idempotency-Key', randomUUID()).send({ destinationStockpileId: ids.phaseThree.stockpileOtherDora, occurredAt: happenedAt, evidenceRef: 'fictional-cross-pile', items: [{ batchId: ids.processingOutputs[1].batchId, quantityGrams: '1.000000' }] });
      assert.equal(overdraw.status, 409);
      assert.equal(sameLocation.status, 400);
      assert.equal(crossDora.status, 404);
      assert.equal((await request(app).get(`/api/v1/doras/${ids.doraOneId}/stockpiles`).set('Authorization', `Bearer ${ids.doraToken}`)).status, 200);
      assert.equal((await request(app).get(`/api/v1/doras/${ids.doraOneId}/stockpiles`).set('Authorization', `Bearer ${ids.doraTwoToken}`)).status, 404);
    });

    await phase.test('residue sale proposal is commercial only and has no payment or inventory effect', async () => {
      const [movementBefore] = await db(`SELECT count(*)::int AS total FROM inventory_movement`, {}, undefined, QueryTypes.SELECT);
      const response = await request(app).post('/api/v1/residue-sales').set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', randomUUID()).send({
        processingFacilityId: ids.doraOneId, recoveryFacilityId: ids.phaseThree.recoveryFacilityId,
        agreedAt: happenedAt, currencyCode: 'USD', termsRef: 'fictional-residue-sale-terms',
        lines: [{ batchId: ids.processingOutputs[1].batchId, quantityGrams: '1.500000', unitPrice: '100.00000000', lineAmount: '150.00000000' }],
      });
      assert.equal(response.status, 201, response.text);
      assert.equal(response.body.status, 'PROPOSED');
      ids.phaseThree.saleId = response.body.id;
      ids.phaseThree.proposedSaleLineId = response.body.lines[0].id;
      const [movementAfter] = await db(`SELECT count(*)::int AS total FROM inventory_movement`, {}, undefined, QueryTypes.SELECT);
      const [payments] = await db(`SELECT count(*)::int AS total FROM payment WHERE residue_sale_id=:saleId`, { saleId: response.body.id }, undefined, QueryTypes.SELECT);
      assert.equal(movementAfter.total, movementBefore.total);
      assert.equal(payments.total, 0);
      assert.equal(response.body.lines[0].accepted, false);
    });

    await phase.test('sale decision mismatches resolve through a successor requiring both counterparties', async () => {
      const sellerBody = { decision: 'ACCEPT', acceptedQuantityGrams: '1.250000', occurredAt: happenedAt };
      const sellerKey = randomUUID();
      const sellerPath = `/api/v1/residue-sales/${ids.phaseThree.saleId}/lines/${ids.phaseThree.proposedSaleLineId}/decisions`;
      const [sellerDecision, sellerRetry] = await Promise.all([
        request(app).post(sellerPath).set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', sellerKey).send(sellerBody),
        request(app).post(sellerPath).set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', sellerKey).send(sellerBody),
      ]);
      assert.equal(sellerDecision.status, 201, sellerDecision.text);
      assert.equal(sellerRetry.status, 201, sellerRetry.text);
      assert.equal([sellerDecision, sellerRetry].filter((response) => response.body.replayed).length, 1);
      assert.equal(sellerDecision.body.acceptedLineId, null);
      const buyerBody = { decision: 'ACCEPT', acceptedQuantityGrams: '1.000000', occurredAt: happenedAt };
      const buyerDecision = await request(app).post(sellerPath).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`).set('Idempotency-Key', randomUUID()).send(buyerBody);
      assert.equal(buyerDecision.status, 201, buyerDecision.text);
      assert.equal(buyerDecision.body.acceptedLineId, null);
      const duplicateSeller = await request(app).post(sellerPath).set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', randomUUID()).send(sellerBody);
      const unrelatedDecision = await request(app).post(sellerPath).set('Authorization', `Bearer ${ids.phaseThree.otherRecoveryToken}`).set('Idempotency-Key', randomUUID()).send(buyerBody);
      assert.equal(duplicateSeller.status, 409);
      assert.equal(duplicateSeller.body.error.code, 'SALE_DECISION_ALREADY_RECORDED');
      assert.equal(unrelatedDecision.status, 404);

      const revisionBody = { quantityGrams: '1.500000', correctionReason: 'Counterparties propose a shared revised quantity.', occurredAt: happenedAt, unitPrice: '100.00000000', lineAmount: '150.00000000' };
      const revisionKey = randomUUID();
      const revisionPath = `/api/v1/residue-sales/${ids.phaseThree.saleId}/lines/${ids.phaseThree.proposedSaleLineId}/revisions`;
      const [revision, revisionRetry] = await Promise.all([
        request(app).post(revisionPath).set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', revisionKey).send(revisionBody),
        request(app).post(revisionPath).set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', revisionKey).send(revisionBody),
      ]);
      assert.equal(revision.status, 201, revision.text);
      assert.equal(revisionRetry.status, 201, revisionRetry.text);
      assert.equal([revision, revisionRetry].filter((response) => response.body.replayed).length, 1);
      ids.phaseThree.successorSaleLineId = revision.body.id;
      await assert.rejects(sequelize.transaction((transaction) => db(`UPDATE residue_sale_line SET resolves_decision_mismatch=false WHERE id=:id`, { id: revision.body.id }, transaction)), sqlError('55000'));
      const beforeAgreement = await request(app).get(`/api/v1/residue-sales/${ids.phaseThree.saleId}`).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`);
      const priorLine = beforeAgreement.body.lines.find((row) => row.id === ids.phaseThree.proposedSaleLineId);
      const priorDecisions = beforeAgreement.body.decisions.filter((row) => row.residue_sale_line_id === ids.phaseThree.proposedSaleLineId);
      assert.equal(priorLine.is_accepted, false);
      assert.deepEqual(priorDecisions.map((row) => row.accepted_quantity_g).sort(), ['1.000000', '1.250000']);
      assert.equal(revision.body.supersedesLineId, priorLine.id);
      const successorDecisionPath = `/api/v1/residue-sales/${ids.phaseThree.saleId}/lines/${ids.phaseThree.successorSaleLineId}/decisions`;
      const successorSeller = await request(app).post(successorDecisionPath).set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', randomUUID()).send({ decision: 'ACCEPT', acceptedQuantityGrams: '1.500000', occurredAt: happenedAt });
      assert.equal(successorSeller.status, 201, successorSeller.text);
      assert.equal(successorSeller.body.acceptedLineId, null);
      const successorBuyer = await request(app).post(successorDecisionPath).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`).set('Idempotency-Key', randomUUID()).send({ decision: 'ACCEPT', acceptedQuantityGrams: '1.500000', occurredAt: happenedAt });
      assert.equal(successorBuyer.status, 201, successorBuyer.text);
      assert.ok(successorBuyer.body.acceptedLineId);
      ids.phaseThree.acceptedSaleLineId = successorBuyer.body.acceptedLineId;
      const [accepted] = await db(`SELECT is_accepted,accepted_trade_quantity_g,supersedes_line_id FROM residue_sale_line WHERE id=:id`, { id: ids.phaseThree.acceptedSaleLineId }, undefined, QueryTypes.SELECT);
      assert.equal(accepted.is_accepted, true);
      assert.equal(accepted.accepted_trade_quantity_g, '1.500000');
      assert.equal(accepted.supersedes_line_id, ids.phaseThree.successorSaleLineId);
      const afterAgreement = await request(app).get(`/api/v1/residue-sales/${ids.phaseThree.saleId}`).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`);
      assert.equal(afterAgreement.body.decisions.filter((row) => row.residue_sale_line_id === ids.phaseThree.proposedSaleLineId).length, 2);
      assert.equal(afterAgreement.body.decisions.filter((row) => row.residue_sale_line_id === ids.phaseThree.successorSaleLineId).length, 2);
      assert.equal((await verifyAuditStream('residue_sale', ids.phaseThree.saleId)).valid, true);

      const secondProposal = await request(app).post('/api/v1/residue-sales').set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', randomUUID()).send({
        processingFacilityId: ids.doraOneId, recoveryFacilityId: ids.phaseThree.recoveryFacilityId, agreedAt: happenedAt, currencyCode: 'USD',
        lines: [{ batchId: ids.processingOutputs[1].batchId, quantityGrams: '1.500000' }],
      });
      const overQuantity = await request(app).post(`/api/v1/residue-sales/${secondProposal.body.id}/lines/${secondProposal.body.lines[0].id}/decisions`).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`).set('Idempotency-Key', randomUUID()).send({ ...buyerBody, acceptedQuantityGrams: '2.000000' });
      assert.equal(secondProposal.status, 201, secondProposal.text);
      assert.equal(overQuantity.status, 400);
      assert.equal((await request(app).get(`/api/v1/residue-sales/${ids.phaseThree.saleId}`).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`)).status, 200);

      const overInventorySale = await request(app).post('/api/v1/residue-sales').set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', randomUUID()).send({
        processingFacilityId: ids.doraTwoId, recoveryFacilityId: ids.phaseThree.recoveryFacilityId, agreedAt: happenedAt, currencyCode: 'USD',
        lines: [{ batchId: ids.phaseThree.secondDoraResidue.batchId, quantityGrams: '3.100000' }],
      });
      assert.equal(overInventorySale.status, 201, overInventorySale.text);
      const overInventoryPath = `/api/v1/residue-sales/${overInventorySale.body.id}/lines/${overInventorySale.body.lines[0].id}/decisions`;
      const overInventorySeller = await request(app).post(overInventoryPath).set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', randomUUID()).send({ decision: 'ACCEPT', acceptedQuantityGrams: '3.100000', occurredAt: happenedAt });
      const overInventoryBuyer = await request(app).post(overInventoryPath).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`).set('Idempotency-Key', randomUUID()).send({ decision: 'ACCEPT', acceptedQuantityGrams: '3.100000', occurredAt: happenedAt });
      assert.equal(overInventorySeller.status, 201, overInventorySeller.text);
      assert.equal(overInventoryBuyer.status, 409);
      assert.equal(overInventoryBuyer.body.error.code, 'INSUFFICIENT_ELIGIBLE_RESIDUE');
      await assert.rejects(sequelize.transaction(async (transaction) => {
        await db(`INSERT INTO residue_sale_decision_event(id,residue_sale_line_id,actor_user_id,actor_party_id,decision,accepted_quantity_g,occurred_at)
          VALUES (:id,:lineId,:actor,:party,'ACCEPT','3.100000',:at)`, {
          id: randomUUID(), lineId: overInventorySale.body.lines[0].id, actor: ids.phaseThree.recoveryUserId,
          party: ids.phaseThree.recoveryPartyId, at: happenedAt,
        }, transaction);
        await db(`INSERT INTO residue_sale_line(id,residue_sale_id,batch_id,revision_no,revision_kind,transaction_quantity_g,accepted_trade_quantity_g,supersedes_line_id,correction_reason,is_accepted)
          VALUES (:id,:saleId,:batchId,2,'CORRECTION','3.100000','3.100000',:prior,'Fictional direct database acceptance',true)`, {
          id: randomUUID(), saleId: overInventorySale.body.id, batchId: ids.phaseThree.secondDoraResidue.batchId, prior: overInventorySale.body.lines[0].id,
        }, transaction);
      }), sqlError('23514'));
    });

    await phase.test('itemized consignment can combine residue from separate Doras and map a sale line', async () => {
      const body = {
        recoveryFacilityId: ids.phaseThree.recoveryFacilityId, occurredAt: happenedAt,
        items: [
          { sourceStockpileId: ids.phaseThree.stockpileTwo, batchId: ids.processingOutputs[1].batchId, quantityGrams: '1.500000', residueSaleLineId: ids.phaseThree.acceptedSaleLineId },
          { sourceStockpileId: ids.phaseThree.stockpileOtherDora, batchId: ids.phaseThree.secondDoraResidue.batchId, quantityGrams: '3.000000' },
        ],
      };
      const response = await request(app).post('/api/v1/consignments').set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', randomUUID()).send(body);
      assert.equal(response.status, 201, response.text);
      assert.equal(response.body.items.length, 2);
      assert.equal(new Set(response.body.items.map((row) => row.batchId)).size, 2);
      ids.phaseThree.consignmentId = response.body.id;
      ids.phaseThree.consignmentItems = response.body.items;
      const [mapped] = await db(`SELECT rssi.mapped_quantity_g,rsl.batch_id,ci.batch_id AS item_batch FROM residue_sale_shipment_item rssi JOIN residue_sale_line rsl ON rsl.id=rssi.residue_sale_line_id JOIN consignment_item ci ON ci.id=rssi.consignment_item_id WHERE ci.consignment_id=:id`, { id: response.body.id }, undefined, QueryTypes.SELECT);
      assert.equal(mapped.mapped_quantity_g, '1.500000');
      assert.equal(mapped.batch_id, mapped.item_batch);
    });

    await phase.test('unrelated Dora and read-only auditor cannot create the consignment', async () => {
      const body = { recoveryFacilityId: ids.phaseThree.recoveryFacilityId, occurredAt: happenedAt, items: [{ sourceStockpileId: ids.phaseThree.stockpileTwo, batchId: ids.processingOutputs[1].batchId, quantityGrams: '0.500000' }] };
      const unrelatedProfile = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${ids.doraTwoToken}`);
      assert.equal(unrelatedProfile.status, 200, unrelatedProfile.text);
      assert.ok(unrelatedProfile.body.roles.some((role) => role.role_code === 'DORA_OPERATOR' && role.scope_id === ids.doraTwoId));
      const auditorProfile = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${ids.siteAuditorToken}`);
      assert.equal(auditorProfile.status, 200, auditorProfile.text);
      assert.ok(auditorProfile.body.roles.some((role) => role.role_code === 'AUDITOR' && role.scope_kind === 'SITE' && role.scope_id === ids.siteId));
      const unrelated = await request(app).post('/api/v1/consignments').set('Authorization', `Bearer ${ids.doraTwoToken}`).set('Idempotency-Key', randomUUID()).send(body);
      const auditor = await request(app).post('/api/v1/consignments').set('Authorization', `Bearer ${ids.siteAuditorToken}`).set('Idempotency-Key', randomUUID()).send(body);
      assert.equal(unrelated.status, 404, unrelated.text);
      assert.equal(unrelated.body.error.code, 'RESOURCE_NOT_FOUND');
      assert.equal(auditor.status, 404, auditor.text);
      assert.equal(auditor.body.error.code, 'RESOURCE_NOT_FOUND');
      assert.equal((await request(app).get(`/api/v1/consignments/${ids.phaseThree.consignmentId}`).set('Authorization', `Bearer ${ids.phaseThree.otherRecoveryToken}`)).status, 404);
    });

    await phase.test('dispatch posts paired stockpile OUT and transit IN exactly once', async () => {
      const items = ids.phaseThree.consignmentItems.map((row) => ({ consignmentItemId: row.id, measurementId: row.measurementId }));
      const body = { occurredAt: happenedAt, evidenceRef: 'fictional-dispatch-manifest', items };
      const key = randomUUID();
      const [first, retry] = await Promise.all([
        request(app).post(`/api/v1/consignments/${ids.phaseThree.consignmentId}/dispatch`).set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', key).send(body),
        request(app).post(`/api/v1/consignments/${ids.phaseThree.consignmentId}/dispatch`).set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', key).send(body),
      ]);
      assert.equal(first.status, 200, first.text);
      assert.equal(retry.status, 200, retry.text);
      assert.equal([first, retry].filter((response) => response.body.replayed).length, 1);
      assert.equal(retry.body.id, first.body.id);
      const postings = await db(`SELECT direction,count(*)::int AS lines,sum(posted_quantity_g)::NUMERIC(20,6) AS quantity_g FROM inventory_movement_line WHERE inventory_movement_id=:movementId GROUP BY direction ORDER BY direction`, { movementId: first.body.id }, undefined, QueryTypes.SELECT);
      assert.deepEqual(postings.map((row) => [row.direction, row.lines]), [['IN', 2], ['OUT', 2]]);
      assert.equal((await request(app).get(`/api/v1/consignments/${ids.phaseThree.consignmentId}`).set('Authorization', `Bearer ${ids.doraToken}`)).body.status, 'DISPATCHED');
      const [saleOut] = await db(`SELECT sum(posted_quantity_g)::NUMERIC(20,6) AS quantity_g FROM inventory_movement_line WHERE inventory_movement_id=:id AND residue_sale_line_id=:lineId`, { id: first.body.id, lineId: ids.phaseThree.acceptedSaleLineId }, undefined, QueryTypes.SELECT);
      assert.equal(saleOut.quantity_g, '1.500000');
    });

    await phase.test('over-dispatch fails atomically and leaves no movement', async () => {
      const manifest = await request(app).post('/api/v1/consignments').set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', randomUUID()).send({
        recoveryFacilityId: ids.phaseThree.recoveryFacilityId, occurredAt: happenedAt,
        items: [{ sourceStockpileId: ids.phaseThree.stockpileOne, batchId: ids.processingOutputs[1].batchId, quantityGrams: '20.000000' }],
      });
      assert.equal(manifest.status, 201, manifest.text);
      const [before] = await db(`SELECT count(*)::int AS total FROM inventory_movement`, {}, undefined, QueryTypes.SELECT);
      const dispatch = await request(app).post(`/api/v1/consignments/${manifest.body.id}/dispatch`).set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', randomUUID()).send({ occurredAt: happenedAt, items: [{ consignmentItemId: manifest.body.items[0].id, measurementId: manifest.body.items[0].measurementId }] });
      const [after] = await db(`SELECT count(*)::int AS total FROM inventory_movement`, {}, undefined, QueryTypes.SELECT);
      assert.equal(dispatch.status, 409);
      assert.equal(after.total, before.total);
      assert.equal((await db(`SELECT status FROM consignment WHERE id=:id`, { id: manifest.body.id }, undefined, QueryTypes.SELECT))[0].status, 'DRAFT');
    });

    await phase.test('transport legs record journey evidence without changing inventory', async () => {
      const [before] = await db(`SELECT count(*)::int AS total FROM inventory_movement`, {}, undefined, QueryTypes.SELECT);
      const response = await request(app).post(`/api/v1/consignments/${ids.phaseThree.consignmentId}/transport-legs`).set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', randomUUID()).send({
        carrierPartyId: ids.doraWeigherPartyId, vehicleRef: 'FICTIONAL-TRUCK-01', departureAt: happenedAt, arrivalAt: '2026-11-10T10:30:00.000Z', evidenceRef: 'fictional-transport-note',
      });
      assert.equal(response.status, 201, response.text);
      const [after] = await db(`SELECT count(*)::int AS total FROM inventory_movement`, {}, undefined, QueryTypes.SELECT);
      assert.equal(after.total, before.total);
      assert.equal((await request(app).post(`/api/v1/consignments/${ids.phaseThree.consignmentId}/transport-legs`).set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', randomUUID()).send({ departureAt: '2026-11-10T11:00:00.000Z', arrivalAt: happenedAt })).status, 400);
    });

    await phase.test('recovery facility creates a typed inventory location and auditors retain read-only access', async () => {
      const response = await request(app).post(`/api/v1/recovery-facilities/${ids.phaseThree.recoveryFacilityId}/inventory-locations`).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`).set('Idempotency-Key', randomUUID()).send({ locationCode: 'P3-RECOVERY-VAULT-A', physicalPlaceRef: 'fictional-vault-a' });
      assert.equal(response.status, 201, response.text);
      ids.phaseThree.recoveryLocationId = response.body.id;
      const [type] = await db(`SELECT l.location_kind,ril.recovery_facility_id FROM inventory_location l JOIN recovery_inventory_location ril ON ril.inventory_location_id=l.id WHERE l.id=:id`, { id: response.body.id }, undefined, QueryTypes.SELECT);
      assert.equal(type.location_kind, 'RECOVERY_FACILITY');
      assert.equal(type.recovery_facility_id, ids.phaseThree.recoveryFacilityId);
      assert.equal((await request(app).get(`/api/v1/inventory/locations/${response.body.id}/balances`).set('Authorization', `Bearer ${ids.phaseThree.recoveryAuditorToken}`)).status, 200);
      const deniedWrite = await request(app).post(`/api/v1/recovery-facilities/${ids.phaseThree.recoveryFacilityId}/inventory-locations`).set('Authorization', `Bearer ${ids.phaseThree.recoveryAuditorToken}`).set('Idempotency-Key', randomUUID()).send({ locationCode: 'P3-RECOVERY-AUDITOR-LOCATION' });
      assert.equal(deniedWrite.status, 404);
    });

    await phase.test('Dora offers custody separately from dispatch and the receiving facility accepts it explicitly', async () => {
      const [before] = await db(`SELECT count(*)::int AS total FROM inventory_movement`, {}, undefined, QueryTypes.SELECT);
      const offer = await request(app).post(`/api/v1/consignments/${ids.phaseThree.consignmentId}/custody-offers`).set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', randomUUID()).send({ destinationLocationId: ids.phaseThree.recoveryLocationId, occurredAt: happenedAt, evidenceRef: 'fictional-custody-offer' });
      assert.equal(offer.status, 201, offer.text);
      ids.phaseThree.custodyTransferId = offer.body.id;
      assert.equal(offer.body.status, 'OFFERED');
      const [afterOffer] = await db(`SELECT count(*)::int AS total FROM inventory_movement`, {}, undefined, QueryTypes.SELECT);
      assert.equal(afterOffer.total, before.total);
      const denied = await request(app).post(`/api/v1/custody-transfers/${offer.body.id}/decisions`).set('Authorization', `Bearer ${ids.phaseThree.otherRecoveryToken}`).set('Idempotency-Key', randomUUID()).send({ decision: 'ACCEPT', occurredAt: happenedAt });
      assert.equal(denied.status, 404);
      const accepted = await request(app).post(`/api/v1/custody-transfers/${offer.body.id}/decisions`).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`).set('Idempotency-Key', randomUUID()).send({ decision: 'ACCEPT', occurredAt: happenedAt });
      assert.equal(accepted.status, 200, accepted.text);
      assert.equal(accepted.body.status, 'ACCEPTED');
      const [afterAccept] = await db(`SELECT count(*)::int AS total FROM inventory_movement`, {}, undefined, QueryTypes.SELECT);
      assert.equal(afterAccept.total, before.total);
    });

    await phase.test('offline dispatch, custody, receipt conflict, correction, and repeated receipt revision use domain services', async () => {
      const doraContext = { userId: ids.doraUserId, partyId: ids.doraPartyId, roleCode: 'DORA_OPERATOR', scopeKind: 'FACILITY', scopeId: ids.doraOneId };
      const recoveryContext = {
        userId: ids.phaseThree.recoveryUserId, partyId: ids.phaseThree.recoveryPartyUserId,
        roleCode: 'RECOVERY_FACILITY_OPERATOR', scopeKind: 'FACILITY', scopeId: ids.phaseThree.recoveryFacilityId,
      };
      const offlineLocation = await request(app).post(`/api/v1/recovery-facilities/${ids.phaseThree.recoveryFacilityId}/inventory-locations`)
        .set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`).set('Idempotency-Key', randomUUID())
        .send({ locationCode: 'P5-OFFLINE-RECEIPT-VAULT', physicalPlaceRef: 'fictional-offline-receipt-vault' });
      assert.equal(offlineLocation.status, 201, offlineLocation.text);
      const offlineRecoveryLocationId = offlineLocation.body.id;
      const created = await request(app).post('/api/v1/consignments').set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', randomUUID()).send({
        recoveryFacilityId: ids.phaseThree.recoveryFacilityId, occurredAt: happenedAt,
        items: [{ sourceStockpileId: ids.phaseThree.stockpileOne, batchId: ids.processingOutputs[1].batchId, quantityGrams: '0.050000' }],
      });
      assert.equal(created.status, 201, created.text);
      const item = created.body.items[0];
      const dispatchCommand = await versionSyncEnvelope(ids.doraToken, makeSyncEnvelope({
        ...doraContext, commandType: 'consignment.dispatch',
        payload: { consignmentId: created.body.id, input: { occurredAt: happenedAt, evidenceRef: 'offline-dispatch-manifest', items: [{ consignmentItemId: item.id, measurementId: item.measurementId }] } },
      }));
      const [dispatch, dispatchRetry] = await Promise.all([
        submitSyncEnvelope(ids.doraToken, dispatchCommand), submitSyncEnvelope(ids.doraToken, dispatchCommand),
      ]);
      assert.deepEqual([dispatch.status, dispatchRetry.status], [200, 200], JSON.stringify([dispatch.body, dispatchRetry.body]));
      assert.equal(dispatch.body.receipt.response.id, dispatchRetry.body.receipt.response.id);

      const offerCommand = await versionSyncEnvelope(ids.doraToken, makeSyncEnvelope({
        ...doraContext, commandType: 'consignment.custody.offer', parentCommandIds: [dispatchCommand.clientMutationId],
        payload: { consignmentId: created.body.id, input: { destinationLocationId: offlineRecoveryLocationId, occurredAt: happenedAt, evidenceRef: 'offline-custody-offer' } },
      }));
      const offered = await submitSyncEnvelope(ids.doraToken, offerCommand);
      assert.equal(offered.status, 200, offered.text);
      const transferId = offered.body.receipt.response.id;
      const decisionCommand = await versionSyncEnvelope(ids.phaseThree.recoveryToken, makeSyncEnvelope({
        ...recoveryContext, commandType: 'custody.transfer.decide', parentCommandIds: [offerCommand.clientMutationId],
        payload: { transferId, input: { decision: 'ACCEPT', occurredAt: happenedAt, evidenceRef: 'offline-custody-acceptance' } },
      }));
      const acceptedCustody = await submitSyncEnvelope(ids.phaseThree.recoveryToken, decisionCommand);
      assert.equal(acceptedCustody.status, 200, acceptedCustody.text);
      assert.equal(acceptedCustody.body.receipt.response.status, 'ACCEPTED');
      const repeatedCustodyDecision = await submitSyncEnvelope(ids.phaseThree.recoveryToken, await versionSyncEnvelope(ids.phaseThree.recoveryToken, makeSyncEnvelope({
        ...recoveryContext, commandType: 'custody.transfer.decide',
        payload: { transferId, input: { decision: 'ACCEPT', occurredAt: happenedAt } },
      })));
      assert.equal(repeatedCustodyDecision.status, 409, repeatedCustodyDecision.text);

      const firstReceipt = await versionSyncEnvelope(ids.phaseThree.recoveryToken, makeSyncEnvelope({
        ...recoveryContext, commandType: 'consignment.receipt.add', parentCommandIds: [decisionCommand.clientMutationId],
        payload: { consignmentId: created.body.id, input: {
          recoveryInventoryLocationId: offlineRecoveryLocationId, occurredAt: happenedAt, evidenceRef: 'offline-partial-receipt-a',
          items: [{ consignmentItemId: item.id, quantityGrams: '0.020000', outcome: 'ACCEPTED' }],
        } },
      }));
      const firstReceiptResult = await submitSyncEnvelope(ids.phaseThree.recoveryToken, firstReceipt);
      assert.equal(firstReceiptResult.status, 200, firstReceiptResult.text);
      assert.equal(firstReceiptResult.body.receipt.response.status, 'PART_RECEIVED');

      const staleReceipt = makeSyncEnvelope({
        ...recoveryContext, commandType: 'consignment.receipt.add', parentCommandIds: [firstReceipt.clientMutationId],
        payload: { consignmentId: created.body.id, input: {
          recoveryInventoryLocationId: offlineRecoveryLocationId, occurredAt: happenedAt, evidenceRef: 'offline-partial-receipt-b',
          items: [{ consignmentItemId: item.id, quantityGrams: '0.020000', outcome: 'ACCEPTED' }],
        } },
        expectedVersion: firstReceipt.expectedVersion,
      });
      const receiptConflict = await submitSyncEnvelope(ids.phaseThree.recoveryToken, staleReceipt);
      assert.equal(receiptConflict.status, 409, receiptConflict.text);
      assert.equal(receiptConflict.body.receipt.error.code, 'STALE_VERSION');
      const correctedReceipt = await versionSyncEnvelope(ids.phaseThree.recoveryToken, makeSyncEnvelope({
        ...recoveryContext, commandType: 'consignment.receipt.add', revisionOf: staleReceipt.clientMutationId,
        parentCommandIds: [firstReceipt.clientMutationId, staleReceipt.clientMutationId],
        payload: staleReceipt.payload,
      }));
      const correctionResult = await submitSyncEnvelope(ids.phaseThree.recoveryToken, correctedReceipt);
      assert.equal(correctionResult.status, 200, correctionResult.text);
      assert.equal(correctionResult.body.receipt.response.status, 'PART_RECEIVED');

      const itemReceiptId = correctionResult.body.receipt.response.items[0].id;
      const receiptCorrection = await versionSyncEnvelope(ids.phaseThree.recoveryToken, makeSyncEnvelope({
        ...recoveryContext, commandType: 'consignment.receipt.correct', parentCommandIds: [correctedReceipt.clientMutationId],
        payload: { consignmentId: created.body.id, receiptItemId: itemReceiptId, input: {
          recoveryInventoryLocationId: offlineRecoveryLocationId, quantityGrams: '0.015000', outcome: 'ACCEPTED',
          correctionReason: 'Offline scale review corrected the second partial receipt.', occurredAt: happenedAt,
          measurement: { kind: 'MEASURED', sourceValue: '0.015', sourceUnit: 'g', conversionVersion: 'test-v1', sourceRole: 'RECORDER', occurredAt: happenedAt },
        } },
      }));
      const correctedItem = await submitSyncEnvelope(ids.phaseThree.recoveryToken, receiptCorrection);
      assert.equal(correctedItem.status, 200, correctedItem.text);
      assert.equal(correctedItem.body.receipt.response.item.supersedesReceiptItemId, itemReceiptId);
      assert.equal((await db(`SELECT count(*)::int AS total FROM consignment_receipt_item WHERE supersedes_receipt_item_id=:id`, { id: itemReceiptId }, undefined, QueryTypes.SELECT))[0].total, 1);
    });

    await phase.test('partial receipt transfers only accepted quantities and leaves disputes in transit', async () => {
      const items = ids.phaseThree.consignmentItems;
      const [before] = await db(`SELECT count(*)::int AS total FROM inventory_movement`, {}, undefined, QueryTypes.SELECT);
      const body = {
        recoveryInventoryLocationId: ids.phaseThree.recoveryLocationId, occurredAt: happenedAt, evidenceRef: 'fictional-partial-receipt',
        items: [
          { consignmentItemId: items[0].id, quantityGrams: '0.500000', outcome: 'ACCEPTED' },
          { consignmentItemId: items[1].id, quantityGrams: '0.500000', outcome: 'DISPUTED', reason: 'Recorded count needs review.' },
        ],
      };
      const key = randomUUID();
      const [first, retry] = await Promise.all([
        request(app).post(`/api/v1/consignments/${ids.phaseThree.consignmentId}/receipts`).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`).set('Idempotency-Key', key).send(body),
        request(app).post(`/api/v1/consignments/${ids.phaseThree.consignmentId}/receipts`).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`).set('Idempotency-Key', key).send(body),
      ]);
      assert.equal(first.status, 201, first.text);
      assert.equal(retry.status, 201, retry.text);
      assert.equal([first, retry].filter((response) => response.body.replayed).length, 1);
      assert.equal(retry.body.id, first.body.id);
      ids.phaseThree.partialReceipt = first.body;
      assert.equal(first.body.status, 'DISPUTED');
      const [after] = await db(`SELECT count(*)::int AS total FROM inventory_movement`, {}, undefined, QueryTypes.SELECT);
      assert.equal(after.total, before.total + 1);
      const [transit] = await db(`SELECT quantity_g FROM inventory_balance WHERE location_id=(SELECT transit_location_id FROM consignment WHERE id=:id) AND batch_id=:batchId`, { id: ids.phaseThree.consignmentId, batchId: ids.processingOutputs[1].batchId }, undefined, QueryTypes.SELECT);
      assert.equal(transit.quantity_g, '1.000000');
      const [destination] = await db(`SELECT quantity_g FROM inventory_balance WHERE location_id=:locationId AND batch_id=:batchId`, { locationId: ids.phaseThree.recoveryLocationId, batchId: ids.processingOutputs[1].batchId }, undefined, QueryTypes.SELECT);
      assert.equal(destination.quantity_g, '0.500000');
    });

    await phase.test('receipt corrections supersede evidence and reverse/repost accepted inventory atomically', async () => {
      const original = ids.phaseThree.partialReceipt.items.find((row) => row.consignmentItemId === ids.phaseThree.consignmentItems[0].id);
      const correction = await request(app).post(`/api/v1/consignments/${ids.phaseThree.consignmentId}/receipt-items/${original.id}/corrections`)
        .set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`).set('Idempotency-Key', randomUUID()).send({
          recoveryInventoryLocationId: ids.phaseThree.recoveryLocationId, occurredAt: happenedAt,
          quantityGrams: '0.400000', outcome: 'ACCEPTED', correctionReason: 'Fictional reread corrected the presented quantity.',
          measurement: { kind: 'MEASURED', sourceValue: '0.4', sourceUnit: 'g', conversionVersion: 'test-v1', sourceRole: 'RECORDER', occurredAt: happenedAt },
        });
      assert.equal(correction.status, 201, correction.text);
      assert.equal(correction.body.item.supersedesReceiptItemId, original.id);
      assert.ok(correction.body.reversal.id);
      assert.ok(correction.body.movement.id);
      ids.phaseThree.correctedPartialReceiptItem = correction.body.item;
      const history = await db(`SELECT id,quantity_g,outcome,supersedes_receipt_item_id,correction_reason FROM consignment_receipt_item
        WHERE id IN (:original,:successor) ORDER BY recorded_at,id`, { original: original.id, successor: correction.body.item.id }, undefined, QueryTypes.SELECT);
      assert.equal(history.length, 2);
      assert.equal(history.find((row) => row.id === original.id).quantity_g, '0.500000');
      assert.equal(history.find((row) => row.id === correction.body.item.id).quantity_g, '0.400000');
      assert.equal(history.find((row) => row.id === correction.body.item.id).supersedes_receipt_item_id, original.id);
      const read = await request(app).get(`/api/v1/consignments/${ids.phaseThree.consignmentId}`).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`);
      const item = read.body.items.find((row) => row.id === ids.phaseThree.consignmentItems[0].id);
      assert.equal(item.presented_receipt_quantity_g, '0.400000');
      assert.equal(item.accepted_receipt_quantity_g, '0.400000');
      assert.equal(item.disputed_receipt_quantity_g, '0.000000');
      assert.equal(item.rejected_receipt_quantity_g, '0.000000');
    });

    await phase.test('receipt claim limit rejects API and direct database over-receipt', async () => {
      const item = ids.phaseThree.consignmentItems[0];
      const excess = await request(app).post(`/api/v1/consignments/${ids.phaseThree.consignmentId}/receipts`)
        .set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`).set('Idempotency-Key', randomUUID()).send({
          recoveryInventoryLocationId: ids.phaseThree.recoveryLocationId, occurredAt: happenedAt,
          items: [{ consignmentItemId: item.id, quantityGrams: '1.100001', outcome: 'DISPUTED', reason: 'Fictional excessive claim.', measurement: { kind: 'MEASURED', sourceValue: '1.100001', sourceUnit: 'g', conversionVersion: 'test-v1', sourceRole: 'RECORDER' } }],
        });
      assert.equal(excess.status, 409);
      assert.equal(excess.body.error.code, 'RECEIPT_CLAIMS_EXCEED_DISPATCH');

      await assert.rejects(sequelize.transaction(async (transaction) => {
        const [itemRow] = await db(`SELECT batch_id FROM consignment_item WHERE id=:id`, { id: item.id }, transaction, QueryTypes.SELECT);
        const receiptId = randomUUID();
        const setId = randomUUID();
        const measurementId = randomUUID();
        await db(`INSERT INTO consignment_receipt(id,consignment_id,received_by_user_id,occurred_at_claimed)
          VALUES (:id,:consignmentId,:actor,:at)`, { id: receiptId, consignmentId: ids.phaseThree.consignmentId, actor: ids.phaseThree.recoveryUserId, at: happenedAt }, transaction);
        await db(`INSERT INTO material_measurement_set(id,batch_id,consignment_item_id,consignment_stage)
          VALUES (:id,:batchId,:itemId,'RECEIPT')`, { id: setId, batchId: itemRow.batch_id, itemId: item.id }, transaction);
        await db(`INSERT INTO material_measurement(id,measurement_set_id,measurement_kind,quantity_g,source_value,source_unit_code,conversion_version,source_role,source_party_id,entered_by_user_id,occurred_at_claimed)
          VALUES (:id,:setId,'MEASURED','1.100001','1.100001','g','test-v1','RECORDER',:party,:actor,:at)`, {
          id: measurementId, setId, party: ids.phaseThree.recoveryPartyUserId, actor: ids.phaseThree.recoveryUserId, at: happenedAt,
        }, transaction);
        await db(`INSERT INTO consignment_receipt_item(id,receipt_id,consignment_id,consignment_item_id,batch_id,quantity_g,outcome,measurement_set_id,measurement_id,discrepancy_reason)
          VALUES (:id,:receiptId,:consignmentId,:itemId,:batchId,'1.100001','DISPUTED',:setId,:measurementId,'Fictional excessive database claim')`, {
          id: randomUUID(), receiptId, consignmentId: ids.phaseThree.consignmentId, itemId: item.id, batchId: itemRow.batch_id, setId, measurementId,
        }, transaction);
      }), sqlError('23514'));
    });

    await phase.test('concurrent partial receipt claims serialize at the remaining dispatched quantity', async () => {
      const item = ids.phaseThree.consignmentItems[0];
      const body = {
        recoveryInventoryLocationId: ids.phaseThree.recoveryLocationId, occurredAt: happenedAt,
        items: [{ consignmentItemId: item.id, quantityGrams: '0.600000', outcome: 'ACCEPTED', measurement: { kind: 'MEASURED', sourceValue: '0.6', sourceUnit: 'g', conversionVersion: 'test-v1', sourceRole: 'RECORDER' } }],
      };
      const [first, competing] = await Promise.all([
        request(app).post(`/api/v1/consignments/${ids.phaseThree.consignmentId}/receipts`).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`).set('Idempotency-Key', randomUUID()).send(body),
        request(app).post(`/api/v1/consignments/${ids.phaseThree.consignmentId}/receipts`).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`).set('Idempotency-Key', randomUUID()).send(body),
      ]);
      assert.deepEqual([first.status, competing.status].sort(), [201, 409]);
      const accepted = [first, competing].find((response) => response.status === 201);
      const rejected = [first, competing].find((response) => response.status === 409);
      assert.equal(rejected.body.error.code, 'RECEIPT_CLAIMS_EXCEED_DISPATCH');
      ids.phaseThree.concurrentReceiptItem = accepted.body.items[0];
      const read = await request(app).get(`/api/v1/consignments/${ids.phaseThree.consignmentId}`).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`);
      assert.equal(read.body.items.find((row) => row.id === item.id).accepted_receipt_quantity_g, '1.000000');
    });

    await phase.test('disputed and rejected receipt claims remain evidence and create no movement', async () => {
      const [before] = await db(`SELECT count(*)::int AS total FROM inventory_movement`, {}, undefined, QueryTypes.SELECT);
      const response = await request(app).post(`/api/v1/consignments/${ids.phaseThree.consignmentId}/receipts`).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`).set('Idempotency-Key', randomUUID()).send({
        recoveryInventoryLocationId: ids.phaseThree.recoveryLocationId, occurredAt: happenedAt,
        items: [{ consignmentItemId: ids.phaseThree.consignmentItems[1].id, quantityGrams: '0.250000', outcome: 'REJECTED', reason: 'Package measurement was not accepted.' }],
      });
      assert.equal(response.status, 201, response.text);
      assert.equal(response.body.status, 'DISPUTED');
      const [after] = await db(`SELECT count(*)::int AS total FROM inventory_movement`, {}, undefined, QueryTypes.SELECT);
      assert.equal(after.total, before.total);
      assert.equal((await db(`SELECT outcome FROM consignment_receipt_item WHERE id=:id`, { id: response.body.items[0].id }, undefined, QueryTypes.SELECT))[0].outcome, 'REJECTED');
      ids.phaseThree.rejectedReceiptItem = response.body.items[0];
      ids.phaseThree.disputedReceiptItem = ids.phaseThree.partialReceipt.items.find((row) => row.consignmentItemId === ids.phaseThree.consignmentItems[1].id);
    });

    await phase.test('disputed and rejected quantities can be corrected without erasing prior evidence', async () => {
      const disputed = await request(app).post(`/api/v1/consignments/${ids.phaseThree.consignmentId}/receipt-items/${ids.phaseThree.disputedReceiptItem.id}/corrections`)
        .set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`).set('Idempotency-Key', randomUUID()).send({
          recoveryInventoryLocationId: ids.phaseThree.recoveryLocationId, occurredAt: happenedAt, quantityGrams: '0.500000', outcome: 'ACCEPTED',
          correctionReason: 'Fictional follow-up evidence resolves the discrepancy.',
          measurement: { kind: 'MEASURED', sourceValue: '0.5', sourceUnit: 'g', conversionVersion: 'test-v1', sourceRole: 'RECORDER' },
        });
      const rejected = await request(app).post(`/api/v1/consignments/${ids.phaseThree.consignmentId}/receipt-items/${ids.phaseThree.rejectedReceiptItem.id}/corrections`)
        .set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`).set('Idempotency-Key', randomUUID()).send({
          recoveryInventoryLocationId: ids.phaseThree.recoveryLocationId, occurredAt: happenedAt, quantityGrams: '0.250000', outcome: 'ACCEPTED',
          correctionReason: 'Fictional follow-up evidence resolves the rejected observation.',
          measurement: { kind: 'MEASURED', sourceValue: '0.25', sourceUnit: 'g', conversionVersion: 'test-v1', sourceRole: 'RECORDER' },
        });
      assert.equal(disputed.status, 201, disputed.text);
      assert.equal(rejected.status, 201, rejected.text);
      ids.phaseThree.correctedDisputedReceiptItem = disputed.body.item;
      ids.phaseThree.correctedRejectedReceiptItem = rejected.body.item;
      const [history] = await db(`SELECT count(*)::int AS total FROM consignment_receipt_item WHERE consignment_item_id=:itemId`, { itemId: ids.phaseThree.consignmentItems[1].id }, undefined, QueryTypes.SELECT);
      assert.equal(history.total, 4);
      assert.equal((await db(`SELECT outcome FROM consignment_receipt_item WHERE id=:id`, { id: ids.phaseThree.disputedReceiptItem.id }, undefined, QueryTypes.SELECT))[0].outcome, 'DISPUTED');
      assert.equal((await db(`SELECT outcome FROM consignment_receipt_item WHERE id=:id`, { id: ids.phaseThree.rejectedReceiptItem.id }, undefined, QueryTypes.SELECT))[0].outcome, 'REJECTED');
    });

    await phase.test('full receipt reconciles the remaining dispatch and closes transit inventory', async () => {
      const body = {
        recoveryInventoryLocationId: ids.phaseThree.recoveryLocationId, occurredAt: happenedAt, evidenceRef: 'fictional-final-receipt',
        items: [
          { consignmentItemId: ids.phaseThree.consignmentItems[0].id, quantityGrams: '0.500000', outcome: 'ACCEPTED' },
          { consignmentItemId: ids.phaseThree.consignmentItems[1].id, quantityGrams: '2.250000', outcome: 'ACCEPTED' },
        ],
      };
      const response = await request(app).post(`/api/v1/consignments/${ids.phaseThree.consignmentId}/receipts`).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`).set('Idempotency-Key', randomUUID()).send(body);
      assert.equal(response.status, 201, response.text);
      assert.equal(response.body.status, 'RECEIVED');
      const [transit] = await db(`SELECT COALESCE(sum(quantity_g),0)::NUMERIC(20,6) AS quantity_g FROM inventory_balance WHERE location_id=(SELECT transit_location_id FROM consignment WHERE id=:id)`, { id: ids.phaseThree.consignmentId }, undefined, QueryTypes.SELECT);
      assert.equal(transit.quantity_g, '0.000000');
      assert.equal((await db(`SELECT status FROM consignment WHERE id=:id`, { id: ids.phaseThree.consignmentId }, undefined, QueryTypes.SELECT))[0].status, 'RECEIVED');
      assert.equal((await db(`SELECT quantity_g FROM inventory_balance WHERE location_id=:locationId AND batch_id=:batchId`, {
        locationId: ids.phaseThree.recoveryLocationId, batchId: ids.phaseThree.consignmentItems[0].batchId,
      }, undefined, QueryTypes.SELECT))[0].quantity_g, '1.500000');
      const read = await request(app).get(`/api/v1/consignments/${ids.phaseThree.consignmentId}`).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`);
      const itemStats = read.body.items.find((row) => row.id === ids.phaseThree.consignmentItems[1].id);
      assert.equal(read.body.items.find((row) => row.id === ids.phaseThree.consignmentItems[0].id).dispatched_quantity_g, '1.500000');
      assert.equal(itemStats.presented_receipt_quantity_g, '3.000000');
      assert.equal(itemStats.accepted_receipt_quantity_g, '3.000000');
      assert.equal(itemStats.disputed_receipt_quantity_g, '0.000000');
      assert.equal(itemStats.rejected_receipt_quantity_g, '0.000000');
      ids.phaseThree.firstConsignmentFinalReceiptItems = response.body.items;
    });

    await phase.test('partial repeated dispatches can source one batch across multiple consignments', async () => {
      const created = await request(app).post('/api/v1/consignments').set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', randomUUID()).send({
        recoveryFacilityId: ids.phaseThree.recoveryFacilityId, occurredAt: happenedAt,
        items: [{ sourceStockpileId: ids.phaseThree.stockpileOne, batchId: ids.processingOutputs[1].batchId, quantityGrams: '1.000000' }],
      });
      assert.equal(created.status, 201, created.text);
      ids.phaseThree.secondConsignmentId = created.body.id;
      ids.phaseThree.secondConsignmentItem = created.body.items[0];
      const dispatch = await request(app).post(`/api/v1/consignments/${created.body.id}/dispatch`).set('Authorization', `Bearer ${ids.doraToken}`).set('Idempotency-Key', randomUUID()).send({ occurredAt: happenedAt, items: [{ consignmentItemId: created.body.items[0].id, measurementId: created.body.items[0].measurementId }] });
      assert.equal(dispatch.status, 200, dispatch.text);
      const receipt = await request(app).post(`/api/v1/consignments/${created.body.id}/receipts`).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`).set('Idempotency-Key', randomUUID()).send({
        recoveryInventoryLocationId: ids.phaseThree.recoveryLocationId, occurredAt: happenedAt,
        items: [{ consignmentItemId: created.body.items[0].id, quantityGrams: '1.000000', outcome: 'ACCEPTED' }],
      });
      assert.equal(receipt.status, 201, receipt.text);
      assert.equal(receipt.body.status, 'RECEIVED');
      ids.phaseThree.secondConsignmentReceiptItem = receipt.body.items[0];
    });

    await phase.test('recovery event consumes multiple batches from multiple consignments and preserves output genealogy', async () => {
      const firstItems = ids.phaseThree.firstConsignmentFinalReceiptItems;
      const firstBatchReceipt = ids.phaseThree.correctedPartialReceiptItem;
      const firstFinalBatchReceipt = firstItems.find((row) => row.batchId === ids.processingOutputs[1].batchId);
      const secondBatchReceipt = firstItems.find((row) => row.batchId === ids.phaseThree.secondDoraResidue.batchId);
      assert.equal(firstBatchReceipt.outcome, 'ACCEPTED');
      const body = {
        recoveryInventoryLocationId: ids.phaseThree.recoveryLocationId, occurredAt: happenedAt, methodRef: 'fictional-recovery-run-1',
        stages: [{ stageCode: 'LEACHING', occurredAt: happenedAt, note: 'Broad event classification only.' }, { stageCode: 'FINAL_RECOVERY', occurredAt: happenedAt }],
        inputs: [
          { batchId: ids.processingOutputs[1].batchId, quantityGrams: '2.500000', sources: [
            { receiptItemId: firstBatchReceipt.id, quantityGrams: '0.400000' },
            { receiptItemId: ids.phaseThree.concurrentReceiptItem.id, quantityGrams: '0.600000' },
            { receiptItemId: firstFinalBatchReceipt.id, quantityGrams: '0.500000' },
            { receiptItemId: ids.phaseThree.secondConsignmentReceiptItem.id, quantityGrams: '1.000000' },
          ] },
          { batchId: ids.phaseThree.secondDoraResidue.batchId, quantityGrams: '3.000000', sources: [
            { receiptItemId: ids.phaseThree.correctedDisputedReceiptItem.id, quantityGrams: '0.500000' },
            { receiptItemId: ids.phaseThree.correctedRejectedReceiptItem.id, quantityGrams: '0.250000' },
            { receiptItemId: secondBatchReceipt.id, quantityGrams: '2.250000' },
          ] },
        ],
        outputs: [
          { materialKind: 'RECOVERED_GOLD', outputRole: 'RECOVERED_GOLD', quantityGrams: '0.250000' },
          { materialKind: 'PROCESS_OUTPUT', outputRole: 'OTHER_OUTPUT', quantityGrams: '0.100000' },
        ],
        variances: [{ varianceKind: 'PROCESS', expectedQuantityGrams: '5.500000', observedQuantityGrams: '0.350000', reason: 'Fictional recorded process variance; review required.' }],
      };
      const key = randomUUID();
      const [first, retry] = await Promise.all([
        request(app).post(`/api/v1/recovery-facilities/${ids.phaseThree.recoveryFacilityId}/recovery-events`).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`).set('Idempotency-Key', key).send(body),
        request(app).post(`/api/v1/recovery-facilities/${ids.phaseThree.recoveryFacilityId}/recovery-events`).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`).set('Idempotency-Key', key).send(body),
      ]);
      assert.equal(first.status, 201, first.text);
      assert.equal(retry.status, 201, retry.text);
      assert.equal([first, retry].filter((response) => response.body.replayed).length, 1);
      assert.equal(retry.body.id, first.body.id);
      ids.phaseThree.recoveryEventId = first.body.id;
      assert.equal(first.body.inputs.length, 2);
      assert.equal(first.body.outputs.length, 2);
      assert.equal(first.body.stages.length, 2);
      assert.equal(first.body.variances.length, 1);
      const [genealogy] = await db(`SELECT count(*)::int AS total FROM recovery_output_input_link WHERE recovery_event_id=:id`, { id: first.body.id }, undefined, QueryTypes.SELECT);
      assert.equal(genealogy.total, 4);
      const detail = await request(app).get(`/api/v1/recovery-events/${first.body.id}`).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`);
      assert.equal(detail.status, 200, detail.text);
      assert.equal(detail.body.outputs.every((output) => output.contributing_batch_ids.length === 2), true);
      assert.equal(detail.body.inputs.reduce((sum, row) => sum + row.sources.length, 0), 7);
      assert.equal((await request(app).get(`/api/v1/recovery-events/${first.body.id}`).set('Authorization', `Bearer ${ids.phaseThree.otherRecoveryToken}`)).status, 404);
    });

    await phase.test('recovery cannot consume another facility, unsupported material, or already consumed sources', async () => {
      const attempt = await request(app).post(`/api/v1/recovery-facilities/${ids.phaseThree.otherRecoveryFacilityId}/recovery-events`).set('Authorization', `Bearer ${ids.phaseThree.otherRecoveryToken}`).set('Idempotency-Key', randomUUID()).send(validRecoveryEventBody(ids.phaseThree.recoveryLocationId));
      assert.equal(attempt.status, 404);
      const usedReceipt = ids.phaseThree.correctedPartialReceiptItem;
      const usedReceiptCorrection = await request(app).post(`/api/v1/consignments/${ids.phaseThree.consignmentId}/receipt-items/${usedReceipt.id}/corrections`)
        .set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`).set('Idempotency-Key', randomUUID()).send({
          recoveryInventoryLocationId: ids.phaseThree.recoveryLocationId, occurredAt: happenedAt, quantityGrams: '0.400000', outcome: 'ACCEPTED',
          correctionReason: 'Fictional follow-up attempted after recovery use.',
          measurement: { kind: 'MEASURED', sourceValue: '0.4', sourceUnit: 'g', conversionVersion: 'test-v1', sourceRole: 'RECORDER' },
        });
      assert.equal(usedReceiptCorrection.status, 409);
      assert.equal(usedReceiptCorrection.body.error.code, 'RECEIPT_ALREADY_USED_IN_RECOVERY');
      await assert.rejects(sequelize.transaction(async (transaction) => {
        const [prior] = await db(`SELECT consignment_id,consignment_item_id,batch_id,quantity_g FROM consignment_receipt_item WHERE id=:id`, { id: usedReceipt.id }, transaction, QueryTypes.SELECT);
        const receiptId = randomUUID();
        const measurementSetId = randomUUID();
        const measurementId = randomUUID();
        await db(`INSERT INTO consignment_receipt(id,consignment_id,received_by_user_id,occurred_at_claimed)
          VALUES (:id,:consignmentId,:actor,:at)`, { id: receiptId, consignmentId: prior.consignment_id, actor: ids.phaseThree.recoveryUserId, at: happenedAt }, transaction);
        await db(`INSERT INTO material_measurement_set(id,batch_id,consignment_item_id,consignment_stage)
          VALUES (:id,:batchId,:itemId,'RECEIPT')`, { id: measurementSetId, batchId: prior.batch_id, itemId: prior.consignment_item_id }, transaction);
        await db(`INSERT INTO material_measurement(id,measurement_set_id,measurement_kind,quantity_g,source_value,source_unit_code,conversion_version,source_role,source_party_id,entered_by_user_id,occurred_at_claimed)
          VALUES (:id,:setId,'MEASURED',:quantity,:quantity,'g','test-v1','RECORDER',:party,:actor,:at)`, {
          id: measurementId, setId: measurementSetId, quantity: prior.quantity_g, party: ids.phaseThree.recoveryPartyUserId, actor: ids.phaseThree.recoveryUserId, at: happenedAt,
        }, transaction);
        await db(`INSERT INTO consignment_receipt_item(id,receipt_id,consignment_id,consignment_item_id,batch_id,quantity_g,outcome,measurement_set_id,measurement_id,supersedes_receipt_item_id,correction_reason)
          VALUES (:id,:receiptId,:consignmentId,:itemId,:batchId,:quantity,'ACCEPTED',:setId,:measurementId,:prior,'Fictional direct database correction after recovery use')`, {
          id: randomUUID(), receiptId, consignmentId: prior.consignment_id, itemId: prior.consignment_item_id, batchId: prior.batch_id,
          quantity: prior.quantity_g, setId: measurementSetId, measurementId, prior: usedReceipt.id,
        }, transaction);
      }), sqlError('23514'));
      const supersededSource = ids.phaseThree.partialReceipt.items.find((row) => row.batchId === ids.processingOutputs[1].batchId);
      const staleSourceAttempt = await request(app).post(`/api/v1/recovery-facilities/${ids.phaseThree.recoveryFacilityId}/recovery-events`).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`).set('Idempotency-Key', randomUUID()).send({
        recoveryInventoryLocationId: ids.phaseThree.recoveryLocationId, occurredAt: happenedAt,
        inputs: [{ batchId: ids.processingOutputs[1].batchId, quantityGrams: '0.100000', sources: [{ receiptItemId: supersededSource.id, quantityGrams: '0.100000' }] }],
        outputs: [{ materialKind: 'RECOVERED_GOLD', outputRole: 'RECOVERED_GOLD', quantityGrams: '0.010000' }],
      });
      assert.equal(staleSourceAttempt.status, 400);
      assert.equal(staleSourceAttempt.body.error.code, 'INVALID_RECOVERY_SOURCE');
      await assert.rejects(sequelize.transaction(async (transaction) => {
        const [inputRow] = await db(`SELECT material_event_input_id FROM recovery_event_input WHERE recovery_event_id=:eventId AND batch_id=:batchId`, {
          eventId: ids.phaseThree.recoveryEventId, batchId: ids.processingOutputs[1].batchId,
        }, transaction, QueryTypes.SELECT);
        await db(`INSERT INTO recovery_event_input_source(id,recovery_event_input_id,recovery_event_id,batch_id,consignment_receipt_item_id,consignment_item_id,source_quantity_g)
          VALUES (:id,:inputId,:eventId,:batchId,:receiptId,:itemId,'0.100000')`, {
          id: randomUUID(), inputId: inputRow.material_event_input_id, eventId: ids.phaseThree.recoveryEventId,
          batchId: ids.processingOutputs[1].batchId, receiptId: supersededSource.id, itemId: supersededSource.consignmentItemId,
        }, transaction);
      }), sqlError('23514'));
      const source = ids.phaseThree.correctedPartialReceiptItem;
      const [before] = await db(`SELECT count(*)::int AS total FROM material_event WHERE event_kind='RECOVERY'`, {}, undefined, QueryTypes.SELECT);
      const overuse = await request(app).post(`/api/v1/recovery-facilities/${ids.phaseThree.recoveryFacilityId}/recovery-events`).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`).set('Idempotency-Key', randomUUID()).send({
        recoveryInventoryLocationId: ids.phaseThree.recoveryLocationId, occurredAt: happenedAt,
        inputs: [{ batchId: ids.processingOutputs[1].batchId, quantityGrams: '0.100000', sources: [{ receiptItemId: source.id, quantityGrams: '0.100000' }] }],
        outputs: [{ materialKind: 'RECOVERED_GOLD', outputRole: 'RECOVERED_GOLD', quantityGrams: '0.010000' }],
      });
      const [after] = await db(`SELECT count(*)::int AS total FROM material_event WHERE event_kind='RECOVERY'`, {}, undefined, QueryTypes.SELECT);
      assert.equal(overuse.status, 409);
      assert.equal(after.total, before.total);
      const [badKinds] = await db(`SELECT count(*)::int AS total FROM recovery_event_input WHERE recovery_event_id=:id AND batch_id=:batchId`, { id: ids.phaseThree.recoveryEventId, batchId: ids.phaseThree.secondDoraResidue.batchId }, undefined, QueryTypes.SELECT);
      assert.equal(badKinds.total, 1);
    });

    await phase.test('recovery outputs are aggregate records and are not assigned to source miners', async () => {
      const [outputCount] = await db(`SELECT count(*)::int AS total FROM recovery_event_output WHERE recovery_event_id=:id`, { id: ids.phaseThree.recoveryEventId }, undefined, QueryTypes.SELECT);
      const [allocationCount] = await db(`SELECT count(*)::int AS total FROM production_allocation_row WHERE allocation_set_id IN (SELECT id FROM production_allocation_set WHERE allocation_chain_id IN (SELECT id FROM production_allocation_chain WHERE production_event_output_id IN (SELECT material_event_output_id FROM recovery_event_output WHERE recovery_event_id=:id)))`, { id: ids.phaseThree.recoveryEventId }, undefined, QueryTypes.SELECT);
      assert.equal(outputCount.total, 2);
      assert.equal(allocationCount.total, 0);
      assert.equal((await verifyAuditStream('recovery_facility', ids.phaseThree.recoveryFacilityId)).valid, true);
    });

    await phase.test('read-only auditors can read balances but cannot adjust or create recovery events', async () => {
      const read = await request(app).get(`/api/v1/inventory/locations/${ids.phaseThree.recoveryLocationId}/balances`).set('Authorization', `Bearer ${ids.phaseThree.recoveryAuditorToken}`);
      assert.equal(read.status, 200, read.text);
      const eventWrite = await request(app).post(`/api/v1/recovery-facilities/${ids.phaseThree.recoveryFacilityId}/recovery-events`).set('Authorization', `Bearer ${ids.phaseThree.recoveryAuditorToken}`).set('Idempotency-Key', randomUUID()).send(validRecoveryEventBody(ids.phaseThree.recoveryLocationId));
      const adjustment = await request(app).post(`/api/v1/inventory/locations/${ids.phaseThree.recoveryLocationId}/adjustments`).set('Authorization', `Bearer ${ids.phaseThree.recoveryAuditorToken}`).set('Idempotency-Key', randomUUID()).send({ batchId: ids.phaseThree.secondDoraResidue.batchId, countedQuantityGrams: '1.000000', reason: 'not permitted', evidenceRef: 'fictional-evidence', occurredAt: happenedAt });
      assert.equal(eventWrite.status, 404);
      assert.equal(adjustment.status, 404, adjustment.text);
    });

    await phase.test('recovery inventory adjustment is count-backed and append-only', async () => {
      const [output] = await db(`SELECT ro.batch_id FROM recovery_event_output ro JOIN material_batch mb ON mb.id=ro.batch_id WHERE ro.recovery_event_id=:id AND mb.material_kind='RECOVERED_GOLD'`, { id: ids.phaseThree.recoveryEventId }, undefined, QueryTypes.SELECT);
      const result = await request(app).post(`/api/v1/inventory/locations/${ids.phaseThree.recoveryLocationId}/adjustments`).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`).set('Idempotency-Key', randomUUID()).send({
        batchId: output.batch_id, countedQuantityGrams: '0.200000', reason: 'Fictional evidenced count variance.', evidenceRef: 'fictional-count-record', occurredAt: happenedAt,
      });
      assert.equal(result.status, 201, result.text);
      const [movement] = await db(`SELECT movement_kind,current_status FROM inventory_movement WHERE id=:id`, { id: result.body.id }, undefined, QueryTypes.SELECT);
      assert.equal(movement.movement_kind, 'ADJUSTMENT');
      assert.equal(movement.current_status, 'ACCEPTED');
      assert.equal((await request(app).get(`/api/v1/inventory/locations/${ids.phaseThree.recoveryLocationId}/balances`).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`)).body.find((row) => row.batch_id === output.batch_id).quantity_g, '0.200000');
      assert.equal((await db(`SELECT count(*)::int AS total FROM inventory_movement_line WHERE inventory_movement_id=:id AND inventory_count_id IS NOT NULL`, { id: result.body.id }, undefined, QueryTypes.SELECT))[0].total, 1);

      const concurrentAdjustments = await Promise.all([
        request(app).post(`/api/v1/inventory/locations/${ids.phaseThree.recoveryLocationId}/adjustments`).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`).set('Idempotency-Key', randomUUID()).send({
          batchId: output.batch_id, countedQuantityGrams: '0.300000', reason: 'Fictional concurrent count A.', evidenceRef: 'fictional-concurrent-count-a', occurredAt: happenedAt,
        }),
        request(app).post(`/api/v1/inventory/locations/${ids.phaseThree.recoveryLocationId}/adjustments`).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`).set('Idempotency-Key', randomUUID()).send({
          batchId: output.batch_id, countedQuantityGrams: '0.300000', reason: 'Fictional concurrent count B.', evidenceRef: 'fictional-concurrent-count-b', occurredAt: happenedAt,
        }),
      ]);
      assert.deepEqual(concurrentAdjustments.map((response) => response.status).sort(), [201, 409]);
      assert.equal(concurrentAdjustments.find((response) => response.status === 409).body.error.code, 'NO_ADJUSTMENT_REQUIRED');
      assert.equal((await request(app).get(`/api/v1/inventory/locations/${ids.phaseThree.recoveryLocationId}/balances`).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`)).body.find((row) => row.batch_id === output.batch_id).quantity_g, '0.300000');
    });

    await phase.test('offline count adjustment supports repeated immutable corrections and records full history', async () => {
      const [output] = await db(`SELECT ro.batch_id FROM recovery_event_output ro JOIN material_batch mb ON mb.id=ro.batch_id WHERE ro.recovery_event_id=:id AND mb.material_kind='RECOVERED_GOLD'`, { id: ids.phaseThree.recoveryEventId }, undefined, QueryTypes.SELECT);
      const context = {
        userId: ids.phaseThree.recoveryUserId, partyId: ids.phaseThree.recoveryPartyUserId,
        roleCode: 'RECOVERY_FACILITY_OPERATOR', scopeKind: 'FACILITY', scopeId: ids.phaseThree.recoveryFacilityId,
      };
      const makeAdjustment = (countedQuantityGrams, links = {}) => makeSyncEnvelope({
        ...context, commandType: 'inventory.adjustment.create', ...links,
        payload: { locationId: ids.phaseThree.recoveryLocationId, input: {
          batchId: output.batch_id, countedQuantityGrams, reason: 'Offline witnessed inventory count.', evidenceRef: 'offline-count-evidence', occurredAt: happenedAt,
          measurement: { kind: 'MEASURED', sourceValue: countedQuantityGrams, sourceUnit: 'g', conversionVersion: 'test-v1', sourceRole: 'RECORDER', occurredAt: happenedAt },
        } },
      });
      const noChange = makeAdjustment('0.300000');
      const noChangeResult = await submitSyncEnvelope(ids.phaseThree.recoveryToken, await versionSyncEnvelope(ids.phaseThree.recoveryToken, noChange));
      assert.equal(noChangeResult.status, 409, noChangeResult.text);
      assert.equal(noChangeResult.body.receipt.error.code, 'NO_ADJUSTMENT_REQUIRED');

      const firstCorrection = makeAdjustment('0.400000', { parentCommandIds: [noChange.clientMutationId], revisionOf: noChange.clientMutationId });
      const corrected = await submitSyncEnvelope(ids.phaseThree.recoveryToken, await versionSyncEnvelope(ids.phaseThree.recoveryToken, firstCorrection));
      assert.equal(corrected.status, 200, corrected.text);

      const repeatedNoChange = makeAdjustment('0.400000', {
        parentCommandIds: [noChange.clientMutationId, firstCorrection.clientMutationId], revisionOf: firstCorrection.clientMutationId,
      });
      const repeatedResult = await submitSyncEnvelope(ids.phaseThree.recoveryToken, await versionSyncEnvelope(ids.phaseThree.recoveryToken, repeatedNoChange));
      assert.equal(repeatedResult.status, 409, repeatedResult.text);
      assert.equal(repeatedResult.body.receipt.error.code, 'NO_ADJUSTMENT_REQUIRED');

      const finalCorrection = makeAdjustment('0.500000', {
        parentCommandIds: [noChange.clientMutationId, firstCorrection.clientMutationId, repeatedNoChange.clientMutationId],
        revisionOf: repeatedNoChange.clientMutationId,
      });
      const finalResult = await submitSyncEnvelope(ids.phaseThree.recoveryToken, await versionSyncEnvelope(ids.phaseThree.recoveryToken, finalCorrection));
      assert.equal(finalResult.status, 200, finalResult.text);
      assert.equal((await request(app).get(`/api/v1/inventory/locations/${ids.phaseThree.recoveryLocationId}/balances`).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`)).body.find((row) => row.batch_id === output.batch_id).quantity_g, '0.500000');
      const history = await db(`SELECT client_mutation_id,status,envelope->>'revisionOf' AS revision_of FROM sync_command_receipt
        WHERE client_mutation_id IN (:ids) ORDER BY server_received_at`, { ids: [noChange.clientMutationId, firstCorrection.clientMutationId, repeatedNoChange.clientMutationId, finalCorrection.clientMutationId] }, undefined, QueryTypes.SELECT);
      assert.deepEqual(history.map((row) => row.status), ['CONFLICT', 'SERVER_ACCEPTED', 'CONFLICT', 'SERVER_ACCEPTED']);
      assert.equal(history[3].revision_of, repeatedNoChange.clientMutationId);
    });

    await phase.test('receipt, movement, and variance evidence cannot be overwritten', async () => {
      await assert.rejects(db(`UPDATE consignment_receipt_item SET outcome='REJECTED' WHERE id=:id`, { id: ids.phaseThree.partialReceipt.items[0].id }), sqlError('55000'));
      const [variance] = await db(`SELECT id FROM recovery_variance WHERE recovery_event_id=:id`, { id: ids.phaseThree.recoveryEventId }, undefined, QueryTypes.SELECT);
      await assert.rejects(db(`UPDATE recovery_variance SET reason='Changed' WHERE id=:id`, { id: variance.id }), sqlError('55000'));
      const [acceptedMovement] = await db(`SELECT id FROM inventory_movement WHERE event_id=:id`, { id: ids.phaseThree.recoveryEventId }, undefined, QueryTypes.SELECT);
      await assert.rejects(db(`UPDATE inventory_movement SET reason='Changed' WHERE id=:id`, { id: acceptedMovement.id }), sqlError('55000'));
    });

    await phase.test('operations registers apply live facility, hole, and participant-side authorization', async () => {
      const doraProfile = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${ids.doraToken}`);
      assert.equal(doraProfile.status, 200, doraProfile.text);
      const activeDoraFacilityGrants = doraProfile.body.roles
        .filter((role) => role.role_code === 'DORA_OPERATOR' && role.scope_kind === 'FACILITY')
        .map((role) => role.scope_id).sort();
      assert.deepEqual(activeDoraFacilityGrants, [ids.doraOneId, ids.doraTwoId].sort());
      const doras = await request(app).get('/api/v1/doras').set('Authorization', `Bearer ${ids.doraToken}`);
      assert.equal(doras.status, 200, doras.text);
      assert.deepEqual(doras.body.map((row) => row.id).sort(), activeDoraFacilityGrants);
      const destinations = await request(app).get(`/api/v1/doras/${ids.doraOneId}/recovery-destinations`).set('Authorization', `Bearer ${ids.doraToken}`);
      assert.equal(destinations.status, 200, destinations.text);
      assert.ok(destinations.body.some((row) => row.id === ids.phaseThree.recoveryFacilityId));
      const bothFacilityDestinations = await request(app).get(`/api/v1/doras/${ids.doraTwoId}/recovery-destinations`).set('Authorization', `Bearer ${ids.doraToken}`);
      assert.equal(bothFacilityDestinations.status, 200, bothFacilityDestinations.text);
      assert.deepEqual(bothFacilityDestinations.body.map((row) => row.id).sort(), destinations.body.map((row) => row.id).sort());
      const secondDoraProfile = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${ids.doraTwoToken}`);
      assert.equal(secondDoraProfile.status, 200, secondDoraProfile.text);
      assert.deepEqual(secondDoraProfile.body.roles.filter((role) => role.role_code === 'DORA_OPERATOR' && role.scope_kind === 'FACILITY').map((role) => role.scope_id), [ids.doraTwoId]);
      assert.equal((await request(app).get(`/api/v1/doras/${ids.doraOneId}/recovery-destinations`).set('Authorization', `Bearer ${ids.doraTwoToken}`)).status, 404);
      const processing = await request(app).get('/api/v1/processing-events').set('Authorization', `Bearer ${ids.doraToken}`);
      assert.equal(processing.status, 200, processing.text);
      assert.ok(processing.body.some((row) => row.id === ids.processingEventId));
      const sourceEvents = await request(app).get(`/api/v1/sites/${ids.siteId}/production-events`).set('Authorization', `Bearer ${ids.doraToken}`);
      assert.equal(sourceEvents.status, 200, sourceEvents.text);
      assert.ok(sourceEvents.body.some((row) => row.id === ids.phase2ProductionEventId));
      assert.ok(sourceEvents.body.some((row) => row.id === ids.productionEventId));
      assert.ok(sourceEvents.body.every((row) => row.hole_id === ids.holeId));
      const completeSiteEventList = await request(app).get(`/api/v1/sites/${ids.siteId}/production-events`).set('Authorization', `Bearer ${ids.siteToken}`);
      assert.equal(completeSiteEventList.status, 200, completeSiteEventList.text);
      assert.deepEqual(sourceEvents.body.map((row) => row.id).sort(), completeSiteEventList.body.filter((row) => row.hole_id === ids.holeId).map((row) => row.id).sort());
      assert.equal((await request(app).get('/api/v1/processing-events').set('Authorization', `Bearer ${ids.siteToken}`)).body.some((row) => row.id === ids.processingEventId), false);

      const facilities = await request(app).get('/api/v1/recovery-facilities').set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`);
      assert.equal(facilities.status, 200, facilities.text);
      assert.ok(facilities.body.some((row) => row.id === ids.phaseThree.recoveryFacilityId));
      const recoveryProfile = await request(app).get('/api/v1/me').set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`);
      assert.equal(recoveryProfile.status, 200, recoveryProfile.text);
      const recoveryOperatorGrants = recoveryProfile.body.roles.filter((role) => role.role_code === 'RECOVERY_FACILITY_OPERATOR');
      assert.equal(recoveryOperatorGrants.length, 1);
      assert.equal(recoveryOperatorGrants[0].scope_kind, 'FACILITY');
      assert.equal(recoveryOperatorGrants[0].scope_id, ids.phaseThree.recoveryFacilityId);
      const activeRecoveryAssignments = await db(
        `SELECT role_code,scope_kind,scope_id FROM role_assignment
         WHERE user_id=:userId AND status='ACTIVE' AND valid_from<=now() AND (valid_to IS NULL OR valid_to>now())
         ORDER BY role_code,scope_kind,scope_id`,
        { userId: ids.phaseThree.recoveryUserId }, undefined, QueryTypes.SELECT,
      );
      assert.deepEqual(activeRecoveryAssignments, [{
        role_code: 'RECOVERY_FACILITY_OPERATOR', scope_kind: 'FACILITY', scope_id: ids.phaseThree.recoveryFacilityId,
      }]);
      assert.notEqual(ids.phaseThree.recoveryFacilityId, ids.phaseThree.otherRecoveryFacilityId);
      const directFacilityRelationships = await db(
        `SELECT recovery_facility_id,party_id,role_code FROM facility_party_role
         WHERE recovery_facility_id IN (:facilityIds) AND party_id=:operatorPartyId AND status='ACTIVE'
           AND valid_from<=now() AND (valid_to IS NULL OR valid_to>now())`,
        { facilityIds: [ids.phaseThree.recoveryFacilityId, ids.phaseThree.otherRecoveryFacilityId], operatorPartyId: ids.phaseThree.recoveryPartyUserId },
        undefined, QueryTypes.SELECT,
      );
      assert.deepEqual(directFacilityRelationships, []);
      const facility = await request(app).get(`/api/v1/recovery-facilities/${ids.phaseThree.recoveryFacilityId}`).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`);
      assert.equal(facility.status, 200, facility.text);
      assert.ok(facility.body.locations.some((row) => row.id === ids.phaseThree.recoveryLocationId));
      const unrelatedFacilityForOwnOperator = await request(app).get(`/api/v1/recovery-facilities/${ids.phaseThree.otherRecoveryFacilityId}`).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`);
      assert.equal(unrelatedFacilityForOwnOperator.status, 404, unrelatedFacilityForOwnOperator.text);
      assert.equal(unrelatedFacilityForOwnOperator.body.error.code, 'RESOURCE_NOT_FOUND');
      const unrelatedFacilityForItsOperator = await request(app).get(`/api/v1/recovery-facilities/${ids.phaseThree.otherRecoveryFacilityId}`).set('Authorization', `Bearer ${ids.phaseThree.otherRecoveryToken}`);
      assert.equal(unrelatedFacilityForItsOperator.status, 200, unrelatedFacilityForItsOperator.text);
      assert.equal(unrelatedFacilityForItsOperator.body.id, ids.phaseThree.otherRecoveryFacilityId);
      const ownFacilityForAuditor = await request(app).get(`/api/v1/recovery-facilities/${ids.phaseThree.recoveryFacilityId}`).set('Authorization', `Bearer ${ids.phaseThree.recoveryAuditorToken}`);
      assert.equal(ownFacilityForAuditor.status, 200, ownFacilityForAuditor.text);
      assert.equal((await request(app).get(`/api/v1/recovery-facilities/${ids.phaseThree.otherRecoveryFacilityId}`).set('Authorization', `Bearer ${ids.phaseThree.recoveryAuditorToken}`)).status, 404);
      const recoveryEvents = await request(app).get(`/api/v1/recovery-facilities/${ids.phaseThree.recoveryFacilityId}/recovery-events`).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`);
      assert.equal(recoveryEvents.status, 200, recoveryEvents.text);
      assert.ok(recoveryEvents.body.some((row) => row.id === ids.phaseThree.recoveryEventId));
      const [recoveredBatch] = await db(`SELECT batch_id FROM recovery_event_output WHERE recovery_event_id=:eventId AND output_role='RECOVERED_GOLD' LIMIT 1`, { eventId: ids.phaseThree.recoveryEventId }, undefined, QueryTypes.SELECT);
      const recoveryQr = await request(app).post(`/api/v1/material-batches/${recoveredBatch.batch_id}/qr`)
        .set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`).set('Idempotency-Key', randomUUID()).send({});
      assert.equal(recoveryQr.status, 201, recoveryQr.text);
      const recoveryLookup = await request(app).get(`/api/v1/qr/${recoveryQr.body.payload}`).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`);
      assert.equal(recoveryLookup.status, 200, recoveryLookup.text);
      assert.ok(recoveryLookup.body.origins.some((origin) => origin.recovery_facility_id === ids.phaseThree.recoveryFacilityId));
      const recoveryTrace = await request(app).get(`/api/v1/material-batches/${recoveredBatch.batch_id}/traceability`).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`);
      assert.equal(recoveryTrace.status, 200, recoveryTrace.text);
      assert.ok(recoveryTrace.body.recoveryEvents.some((event) => event.id === ids.phaseThree.recoveryEventId));
      const rotatedRecoveryQr = await request(app).post(`/api/v1/material-batches/${recoveredBatch.batch_id}/qr/rotate`)
        .set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`).set('Idempotency-Key', randomUUID()).send({});
      assert.equal(rotatedRecoveryQr.status, 201, rotatedRecoveryQr.text);
      assert.equal((await request(app).get(`/api/v1/qr/${recoveryQr.body.payload}`).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`)).status, 404);
      assert.equal((await request(app).post(`/api/v1/material-batches/${recoveredBatch.batch_id}/qr`).set('Authorization', `Bearer ${ids.phaseThree.otherRecoveryToken}`).set('Idempotency-Key', randomUUID()).send({})).status, 404);
      assert.equal((await request(app).get(`/api/v1/recovery-facilities/${ids.phaseThree.otherRecoveryFacilityId}`).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`)).status, 404);
      const eligibleInputs = await request(app).get(`/api/v1/recovery-facilities/${ids.phaseThree.recoveryFacilityId}/eligible-inputs`).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`);
      assert.equal(eligibleInputs.status, 200, eligibleInputs.text);
      const consignmentList = await request(app).get('/api/v1/consignments').set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`);
      assert.equal(consignmentList.status, 200, consignmentList.text);
      assert.ok(consignmentList.body.some((row) => row.id === ids.phaseThree.consignmentId));
      const saleList = await request(app).get('/api/v1/residue-sales').set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`);
      assert.equal(saleList.status, 200, saleList.text);
      assert.ok(saleList.body.some((row) => row.id === ids.phaseThree.saleId));
      const movements = await request(app).get(`/api/v1/inventory/locations/${ids.phaseThree.recoveryLocationId}/movements`).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`);
      assert.equal(movements.status, 200, movements.text);
      assert.ok(movements.body.some((row) => row.consignment_stage === 'RECEIPT'));
      assert.equal((await request(app).get('/api/v1/consignments').set('Authorization', `Bearer ${ids.phaseThree.otherRecoveryToken}`)).body.some((row) => row.id === ids.phaseThree.consignmentId), false);
    });

    await phase.test('recovery facility permissions are live and role revocation takes effect immediately', async () => {
      const revoked = await request(app).post(`/api/v1/admin/role-assignments/${ids.phaseThree.recoveryRoleId}/revoke`).set('Authorization', `Bearer ${ids.adminToken}`).set('Idempotency-Key', randomUUID()).send({});
      assert.equal(revoked.status, 200, revoked.text);
      const stillToken = await request(app).get(`/api/v1/inventory/locations/${ids.phaseThree.recoveryLocationId}/balances`).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`);
      assert.equal(stillToken.status, 404);
      const revokedFacilityRead = await request(app).get(`/api/v1/recovery-facilities/${ids.phaseThree.recoveryFacilityId}`).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`);
      assert.equal(revokedFacilityRead.status, 404, revokedFacilityRead.text);
      assert.equal((await request(app).get(`/api/v1/inventory/locations/${ids.phaseThree.recoveryLocationId}/balances`).set('Authorization', `Bearer ${ids.phaseThree.recoveryAuditorToken}`)).status, 200);
    });
  });

  await t.test('one inventory journal, nonnegative concurrent movements, rollback, and commercial cap', async () => {
    ids.sourceLocationId = await createLocation('FICTIONAL-SOURCE-1');
    await createOpeningBalance(ids.batchId, ids.sourceLocationId, '20.000000');
    const firstConsignment = await createMeasuredConsignment(ids.batchId, '7.000000', 'FIRST');
    const firstTransfer = await postTransfer({ lines: [{ ...firstConsignment.out, locationId: ids.sourceLocationId }, firstConsignment.in], occurredAt: happenedAt }, { userId: ids.siteUserId, personPartyId: ids.siteUserPartyId }, randomUUID());
    assert.equal(firstTransfer.status, 'ACCEPTED');
    let balances = await db(`SELECT location_id,quantity_g FROM inventory_balance WHERE batch_id=:batchId ORDER BY location_id`, { batchId: ids.batchId }, undefined, QueryTypes.SELECT);
    assert.equal(balances.find((row) => row.location_id === ids.sourceLocationId).quantity_g, '13.000000');
    assert.equal(balances.find((row) => row.location_id === firstConsignment.transitLocationId).quantity_g, '7.000000');
    assert.equal((await db(`SELECT count(*)::int AS total FROM information_schema.tables WHERE table_name='stockpile_movement' AND table_schema='public'`, {}, undefined, QueryTypes.SELECT))[0].total, 0);

    const raceA = await createMeasuredConsignment(ids.batchId, '8.000000', 'RACE-A');
    const raceB = await createMeasuredConsignment(ids.batchId, '8.000000', 'RACE-B');
    const settled = await Promise.allSettled([
      postTransfer({ lines: [{ ...raceA.out, locationId: ids.sourceLocationId }, raceA.in], occurredAt: happenedAt }, { userId: ids.siteUserId, personPartyId: ids.siteUserPartyId }, randomUUID()),
      postTransfer({ lines: [{ ...raceB.out, locationId: ids.sourceLocationId }, raceB.in], occurredAt: happenedAt }, { userId: ids.siteUserId, personPartyId: ids.siteUserPartyId }, randomUUID()),
    ]);
    assert.equal(settled.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(settled.filter((result) => result.status === 'rejected').length, 1);
    balances = await db(`SELECT quantity_g FROM inventory_balance WHERE location_id=:locationId AND batch_id=:batchId`, { locationId: ids.sourceLocationId, batchId: ids.batchId }, undefined, QueryTypes.SELECT);
    assert.equal(balances[0].quantity_g, '5.000000');

    const failureLocation = await createLocation('FICTIONAL-SOURCE-ROLLBACK');
    await createOpeningBalance(ids.secondBatchId, failureLocation, '10.000000');
    const malformed = await createMeasuredConsignment(ids.secondBatchId, '2.000000', 'ROLLBACK');
    const [before] = await db(`SELECT count(*)::int AS total FROM inventory_movement`, {}, undefined, QueryTypes.SELECT);
    const [auditBefore] = await db(`SELECT count(*)::int AS total FROM audit_event`, {}, undefined, QueryTypes.SELECT);
    await assert.rejects(postTransfer({ lines: [
      { ...malformed.out, batchId: ids.secondBatchId, locationId: failureLocation },
      { ...malformed.in, batchId: ids.secondBatchId, quantityGrams: '1.000000' },
    ], occurredAt: happenedAt }, { userId: ids.siteUserId, personPartyId: ids.siteUserPartyId }, randomUUID()));
    const [after] = await db(`SELECT count(*)::int AS total FROM inventory_movement`, {}, undefined, QueryTypes.SELECT);
    const [auditAfter] = await db(`SELECT count(*)::int AS total FROM audit_event`, {}, undefined, QueryTypes.SELECT);
    assert.equal(after.total, before.total);
    assert.equal(auditAfter.total, auditBefore.total);

    const commercialLocation = await createLocation('FICTIONAL-COMMERCIAL-SOURCE');
    const [tradeBatch] = await db(`SELECT batch_id FROM recovery_event_output WHERE recovery_event_id=:eventId AND output_role='RECOVERED_GOLD' LIMIT 1`, { eventId: ids.phaseThree.recoveryEventId }, undefined, QueryTypes.SELECT);
    const tradeBatchId = tradeBatch.batch_id;
    await createOpeningBalance(tradeBatchId, commercialLocation, '10.000000');
    const buyerPartyId = ids.organisationId;
    const sellerPartyId = ids.adminPartyId;
    await db(`INSERT INTO party_participation(id,party_id,participant_kind) VALUES (:id,:partyId,'LOCAL_MERCHANT')`, { id: randomUUID(), partyId: buyerPartyId });
    await db(`INSERT INTO role_assignment(id,user_id,role_code,scope_kind,scope_id) VALUES (:id,:userId,'LOCAL_MERCHANT','ORGANISATION',:scopeId)`, { id: randomUUID(), userId: ids.orgUserId, scopeId: buyerPartyId });
    const tradeDate = new Date(Date.now() + 60_000).toISOString();
    const createdTrade = await request(app).post('/api/v1/gold-trades').set('Authorization', `Bearer ${ids.adminToken}`).set('Idempotency-Key', randomUUID()).send({
      tradeKind: 'PURCHASE', sellerPartyId, buyerPartyId, tradeDate, currencyCode: 'USD',
      lines: [{ batchId: tradeBatchId, quantityGrams: '2.000000', unitPrice: '1.00000000' }],
    });
    assert.equal(createdTrade.status, 201, createdTrade.text);
    const tradeId = createdTrade.body.id;
    const proposalLineId = createdTrade.body.lines[0].id;
    const measured = await request(app).post(`/api/v1/gold-trades/${tradeId}/lines/${proposalLineId}/measurements`).set('Authorization', `Bearer ${ids.adminToken}`).set('Idempotency-Key', randomUUID()).send({
      kind: 'MEASURED', quantityGrams: '2.000000', sourceValue: '2', sourceUnit: 'g', conversionVersion: 'canonical-mass-v1', sourceRole: 'SELLER', occurredAt: tradeDate,
    });
    assert.equal(measured.status, 201, measured.text);
    const firstAcceptance = await request(app).post(`/api/v1/gold-trades/${tradeId}/lines/${proposalLineId}/decisions`).set('Authorization', `Bearer ${ids.adminToken}`).set('Idempotency-Key', randomUUID()).send({ decision: 'ACCEPT', quantityGrams: '2.000000', unitPrice: '1.00000000', occurredAt: tradeDate });
    assert.equal(firstAcceptance.status, 201, firstAcceptance.text);
    const secondAcceptance = await request(app).post(`/api/v1/gold-trades/${tradeId}/lines/${proposalLineId}/decisions`).set('Authorization', `Bearer ${ids.orgToken}`).set('Idempotency-Key', randomUUID()).send({ decision: 'ACCEPT', quantityGrams: '2.000000', unitPrice: '1.00000000', occurredAt: tradeDate });
    assert.equal(secondAcceptance.status, 201, secondAcceptance.text);
    const tradeLineId = secondAcceptance.body.acceptedLineId;
    const overCap = await createMeasuredConsignment(tradeBatchId, '3.000000', 'TRADE-OVER-CAP');
    await assert.rejects(postTransfer({ lines: [
      { ...overCap.out, locationId: commercialLocation, goldTradeLineId: tradeLineId }, overCap.in,
    ], occurredAt: happenedAt }, { userId: ids.siteUserId, personPartyId: ids.siteUserPartyId }, randomUUID()));
    const [netOut] = await db(`SELECT COALESCE(sum(posted_quantity_g),0)::NUMERIC(20,6) AS quantity_g FROM inventory_movement_line ml JOIN inventory_movement m ON m.id=ml.inventory_movement_id WHERE m.current_status='ACCEPTED' AND ml.gold_trade_line_id=:lineId`, { lineId: tradeLineId }, undefined, QueryTypes.SELECT);
    assert.equal(netOut.quantity_g, '0.000000');

    const acceptedConsignment = await createMeasuredConsignment(tradeBatchId, '2.000000', 'TRADE-ACCEPTED');
    const acceptedTransfer = await postTransfer({ lines: [
      { ...acceptedConsignment.out, locationId: commercialLocation, goldTradeLineId: tradeLineId }, acceptedConsignment.in,
    ], occurredAt: happenedAt }, { userId: ids.siteUserId, personPartyId: ids.siteUserPartyId }, randomUUID());
    const acceptedLines = await db(`SELECT id,direction,location_id,batch_id,posted_quantity_g FROM inventory_movement_line WHERE inventory_movement_id=:movementId ORDER BY direction`, { movementId: acceptedTransfer.id }, undefined, QueryTypes.SELECT);
    assert.equal(acceptedLines.length, 2);
    const originalOut = acceptedLines.find((line) => line.direction === 'OUT');
    const originalIn = acceptedLines.find((line) => line.direction === 'IN');
    const reversalId = randomUUID();
    await sequelize.transaction(async (transaction) => {
      await db(`INSERT INTO inventory_movement(id,movement_kind,current_status,actor_user_id,occurred_at_claimed,reverses_movement_id)
        VALUES (:id,'REVERSAL','DRAFT',:actor,:at,:targetId)`, { id: reversalId, actor: ids.siteUserId, at: happenedAt, targetId: acceptedTransfer.id }, transaction);
      await db(`INSERT INTO inventory_movement_line(id,inventory_movement_id,batch_id,location_id,direction,posted_quantity_g,reverses_line_id,line_no)
        VALUES (:outId,:movementId,:batchId,:sourceId,'IN','1.000000',:originalOut,1),
               (:inId,:movementId,:batchId,:destinationId,'OUT','1.000000',:originalIn,2)`, {
        outId: randomUUID(), inId: randomUUID(), movementId: reversalId, batchId: tradeBatchId,
        sourceId: originalOut.location_id, destinationId: originalIn.location_id,
        originalOut: originalOut.id, originalIn: originalIn.id,
      }, transaction);
      await db(`UPDATE inventory_movement SET current_status='ACCEPTED' WHERE id=:id`, { id: reversalId }, transaction);
      await db('SET CONSTRAINTS ALL IMMEDIATE', {}, transaction);
    });

    await assert.rejects(sequelize.transaction(async (transaction) => {
      await db(`INSERT INTO gold_trade_line(id,trade_id,batch_id,revision_no,revision_kind,transaction_quantity_g,accepted_trade_quantity_g,is_accepted,supersedes_line_id,correction_reason)
        VALUES (:id,:tradeId,:batchId,4,'CORRECTION','0.500000','0.500000',true,:previousId,'Lowered acceptance test')`, {
        id: randomUUID(), tradeId, batchId: tradeBatchId, previousId: tradeLineId,
      }, transaction);
    }), sqlError('23514'));
    const postCorrectionOverCap = await createMeasuredConsignment(tradeBatchId, '1.500000', 'TRADE-CORRECTION-OVER-CAP');
    await assert.rejects(postTransfer({ lines: [
      { ...postCorrectionOverCap.out, locationId: commercialLocation, goldTradeLineId: tradeLineId }, postCorrectionOverCap.in,
    ], occurredAt: happenedAt }, { userId: ids.siteUserId, personPartyId: ids.siteUserPartyId }, randomUUID()), sqlError('23514'));

    const commercialBalances = await db(`SELECT location_id,quantity_g FROM inventory_balance WHERE batch_id=:batchId AND location_id IN (:sourceId,:destinationId) ORDER BY location_id`, {
      batchId: tradeBatchId, sourceId: commercialLocation, destinationId: acceptedConsignment.transitLocationId,
    }, undefined, QueryTypes.SELECT);
    assert.equal(commercialBalances.find((row) => row.location_id === commercialLocation).quantity_g, '9.000000');
    assert.equal(commercialBalances.find((row) => row.location_id === acceptedConsignment.transitLocationId).quantity_g, '1.000000');
    await assert.rejects(db(`UPDATE gold_trade SET currency_code='KES' WHERE id=:id`, { id: tradeId }), sqlError('55000'));
    await assert.rejects(db(`INSERT INTO payment(id,gold_trade_id,currency_code,payer_party_id,payee_party_id) VALUES (:id,:tradeId,'KES',:buyer,:seller)`, { id: randomUUID(), tradeId, buyer: buyerPartyId, seller: sellerPartyId }), sqlError('23503'));
    await assert.rejects(db(`INSERT INTO payment(id,gold_trade_id,currency_code,payer_party_id,payee_party_id) VALUES (:id,:tradeId,'USD',:unrelated,:seller)`, { id: randomUUID(), tradeId, unrelated: ids.adminPartyId, seller: sellerPartyId }), sqlError('23514'));
  });

  await t.test('Phase 4 recovered-gold trade, bilateral terms, custody journal, payment reconciliation and authorization', async () => {
    const [recovered] = await db(`SELECT ro.batch_id,location.custodian_party_id AS seller_party_id,ril.inventory_location_id AS source_location_id
      FROM recovery_event_output ro JOIN recovery_event re ON re.event_id=ro.recovery_event_id
      JOIN recovery_inventory_location ril ON ril.recovery_facility_id=re.recovery_facility_id
      JOIN inventory_location location ON location.id=ril.inventory_location_id
      JOIN inventory_balance b ON b.location_id=ril.inventory_location_id AND b.batch_id=ro.batch_id AND b.quantity_g>0
      WHERE ro.recovery_event_id=:eventId AND ro.output_role='RECOVERED_GOLD' LIMIT 1`, { eventId: ids.phaseThree.recoveryEventId }, undefined, QueryTypes.SELECT);
    assert.ok(recovered, 'the recovery output is available at the recovery facility inventory location');
    const sellerPartyId = recovered.seller_party_id;
    const sellerToken = ids.phaseThree.recoveryToken;
    const buyerPartyId = await seedParty('ORGANISATION', 'Fictional Gold Merchant', 'LOCAL_MERCHANT');
    await db(`INSERT INTO party_participation(id,party_id,participant_kind) VALUES (:id,:partyId,'LOCAL_MERCHANT')`, { id: randomUUID(), partyId: buyerPartyId });
    const buyer = await seedUser('gold-buyer@example.test', 'Fictional Gold Buyer', { roleCode: 'LOCAL_MERCHANT', scopeKind: 'ORGANISATION', scopeId: buyerPartyId });
    await db(`INSERT INTO organisation_membership(id,person_party_id,organisation_party_id,membership_type) VALUES (:id,:person,:org,'MEMBER')`, { id: randomUUID(), person: buyer.partyId, org: buyerPartyId });
    const buyerToken = testToken(buyer.userId);
    const buyerLocationId = randomUUID();
    await sequelize.transaction(async (transaction) => {
      await db(`INSERT INTO inventory_location(id,location_code,location_kind,custodian_party_id) VALUES (:id,'FICTIONAL-GOLD-MERCHANT-LOCATION','MERCHANT',:partyId)`, { id: buyerLocationId, partyId: buyerPartyId }, transaction);
      await db(`INSERT INTO merchant_inventory_location(inventory_location_id,merchant_party_id) VALUES (:id,:partyId)`, { id: buyerLocationId, partyId: buyerPartyId }, transaction);
    });
    const tradeDate = new Date(Date.now() + 60_000).toISOString();
    const proposalBody = {
      tradeCode: 'FICTIONAL-RECOVERED-GOLD-TRADE', tradeKind: 'PURCHASE', sellerPartyId, buyerPartyId, tradeDate,
      currencyCode: 'KES', termsRef: 'FICTIONAL-TERMS-01',
      evidence: { kind: 'TERMS', reference: 'FICTIONAL-TERMS-EVIDENCE', occurredAt: tradeDate },
      lines: [{ batchId: recovered.batch_id, quantityGrams: '0.055000', unitPrice: '2400.00000000' }],
    };
    const unauthorized = await request(app).post('/api/v1/gold-trades').set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', randomUUID()).send(proposalBody);
    assert.equal(unauthorized.status, 404, unauthorized.text);
    const invalidMaterial = await request(app).post('/api/v1/gold-trades').set('Authorization', `Bearer ${sellerToken}`).set('Idempotency-Key', randomUUID()).send({ ...proposalBody, tradeCode: 'FICTIONAL-NON-GOLD-TRADE', lines: [{ batchId: ids.batchId, quantityGrams: '0.001000', unitPrice: '1.00000000' }] });
    assert.equal(invalidMaterial.status, 400, invalidMaterial.text);
    const insufficient = await request(app).post('/api/v1/gold-trades').set('Authorization', `Bearer ${sellerToken}`).set('Idempotency-Key', randomUUID()).send({ ...proposalBody, tradeCode: 'FICTIONAL-INSUFFICIENT-TRADE', lines: [{ batchId: recovered.batch_id, quantityGrams: '1.000000', unitPrice: '1.00000000' }] });
    assert.equal(insufficient.status, 409, insufficient.text);
    const tradeMutationId = randomUUID();
    const created = await request(app).post('/api/v1/gold-trades').set('Authorization', `Bearer ${sellerToken}`).set('Idempotency-Key', tradeMutationId).send(proposalBody);
    assert.equal(created.status, 201, created.text);
    const tradeId = created.body.id;
    const replay = await request(app).post('/api/v1/gold-trades').set('Authorization', `Bearer ${sellerToken}`).set('Idempotency-Key', tradeMutationId).send(proposalBody);
    assert.equal(replay.status, 201, replay.text);
    assert.equal(replay.body.id, tradeId);
    assert.equal(replay.body.replayed, true);
    const initialLineId = created.body.lines[0].id;

    const sellerDeclared = await request(app).post(`/api/v1/gold-trades/${tradeId}/lines/${initialLineId}/measurements`).set('Authorization', `Bearer ${sellerToken}`).set('Idempotency-Key', randomUUID()).send({
      kind: 'DECLARED', quantityGrams: '0.055000', sourceValue: '55.000', sourceUnit: 'mg', conversionVersion: 'canonical-mass-v1', sourceRole: 'SELLER', occurredAt: tradeDate, evidenceRef: 'FICTIONAL-SELLER-WEIGHT',
    });
    assert.equal(sellerDeclared.status, 201, sellerDeclared.text);
    const sellerCorrection = await request(app).post(`/api/v1/gold-trades/${tradeId}/lines/${initialLineId}/measurements`).set('Authorization', `Bearer ${sellerToken}`).set('Idempotency-Key', randomUUID()).send({
      kind: 'DECLARED', quantityGrams: '0.054000', sourceValue: '54.000', sourceUnit: 'mg', conversionVersion: 'canonical-mass-v1', sourceRole: 'SELLER', occurredAt: tradeDate,
      supersedesMeasurementId: sellerDeclared.body.id, correctionReason: 'Fictional scale transcription corrected against the original ticket.',
    });
    assert.equal(sellerCorrection.status, 201, sellerCorrection.text);
    const buyerDeclared = await request(app).post(`/api/v1/gold-trades/${tradeId}/lines/${initialLineId}/measurements`).set('Authorization', `Bearer ${buyerToken}`).set('Idempotency-Key', randomUUID()).send({
      kind: 'DECLARED', quantityGrams: '0.052000', sourceValue: '52.000', sourceUnit: 'mg', conversionVersion: 'canonical-mass-v1', sourceRole: 'BUYER', occurredAt: tradeDate,
    });
    assert.equal(buyerDeclared.status, 201, buyerDeclared.text);
    const buyerMeasured = await request(app).post(`/api/v1/gold-trades/${tradeId}/lines/${initialLineId}/measurements`).set('Authorization', `Bearer ${buyerToken}`).set('Idempotency-Key', randomUUID()).send({
      kind: 'MEASURED', quantityGrams: '0.050000', sourceValue: '50.000', sourceUnit: 'mg', conversionVersion: 'canonical-mass-v1', sourceRole: 'BUYER', methodCode: 'FICTIONAL-SCALE', instrumentRef: 'SCALE-TEST-01', occurredAt: tradeDate, evidenceRef: 'FICTIONAL-BUYER-WEIGHT',
    });
    assert.equal(buyerMeasured.status, 201, buyerMeasured.text);
    const invalidConversion = await request(app).post(`/api/v1/gold-trades/${tradeId}/lines/${initialLineId}/measurements`).set('Authorization', `Bearer ${buyerToken}`).set('Idempotency-Key', randomUUID()).send({
      kind: 'MEASURED', quantityGrams: '0.050000', sourceValue: '51.000', sourceUnit: 'mg', conversionVersion: 'canonical-mass-v1', sourceRole: 'BUYER', occurredAt: tradeDate,
    });
    assert.equal(invalidConversion.status, 400);
    const assay = await request(app).post(`/api/v1/gold-trades/${tradeId}/lines/${initialLineId}/assays`).set('Authorization', `Bearer ${sellerToken}`).set('Idempotency-Key', randomUUID()).send({
      assayerPartyId: sellerPartyId, sampleRef: 'SAMPLE-01', methodRef: 'RECORDED-FIRE-ASSAY', resultValue: '92.50000000', resultUnit: 'PERCENT', observedAt: tradeDate, evidenceRef: 'FICTIONAL-ASSAY-REPORT',
    });
    assert.equal(assay.status, 201, assay.text);
    assert.equal(assay.body.status, 'RECORDED');
    assert.notEqual(assay.body.status, 'VERIFIED');
    const assayCorrection = await request(app).post(`/api/v1/gold-trades/${tradeId}/lines/${initialLineId}/assays`).set('Authorization', `Bearer ${sellerToken}`).set('Idempotency-Key', randomUUID()).send({
      assayerPartyId: sellerPartyId, sampleRef: 'SAMPLE-01-CORRECTED', methodRef: 'RECORDED-FIRE-ASSAY', resultValue: '93.00000000', resultUnit: 'PERCENT', observedAt: tradeDate,
      correctionOfId: assay.body.id, correctionReason: 'Fictional transcription correction; prior result remains visible.', evidenceRef: 'FICTIONAL-ASSAY-CORRECTION',
    });
    assert.equal(assayCorrection.status, 201, assayCorrection.text);

    const buyerTradeContext = { userId: buyer.userId, partyId: buyerPartyId, roleCode: 'LOCAL_MERCHANT', scopeKind: 'ORGANISATION', scopeId: buyerPartyId };
    const offlineGoldMeasurement = await versionSyncEnvelope(buyerToken, makeSyncEnvelope({
      ...buyerTradeContext, commandType: 'gold_trade.measurement.add', occurredAt: tradeDate,
      payload: { tradeId, lineId: initialLineId, input: {
        kind: 'MEASURED', quantityGrams: '0.051000', sourceValue: '51.000', sourceUnit: 'mg', conversionVersion: 'canonical-mass-v1',
        sourceRole: 'BUYER', sourcePartyId: buyerPartyId, methodCode: 'OFFLINE-ASSAY-SAMPLE', occurredAt: tradeDate, evidenceRef: 'FICTIONAL-OFFLINE-BUYER-WEIGHT',
      } },
    }));
    const offlineMeasurementResult = await submitSyncEnvelope(buyerToken, offlineGoldMeasurement);
    assert.equal(offlineMeasurementResult.status, 200, offlineMeasurementResult.text);
    assert.equal(offlineMeasurementResult.body.receipt.response.quantityGrams, '0.051000');

    const offlineGoldAssay = await versionSyncEnvelope(buyerToken, makeSyncEnvelope({
      ...buyerTradeContext, commandType: 'gold_trade.assay.record', occurredAt: tradeDate,
      payload: { tradeId, lineId: initialLineId, input: {
        assayerPartyId: buyerPartyId, sampleRef: 'OFFLINE-SAMPLE-02', methodRef: 'RECORDED-FIRE-ASSAY', resultValue: '94.00000000',
        resultUnit: 'PERCENT', observedAt: tradeDate, evidenceRef: 'FICTIONAL-OFFLINE-ASSAY-REPORT', correctionOfId: assayCorrection.body.id,
        correctionReason: 'Offline assay transcription corrected against the signed report.',
      } },
    }));
    const offlineAssayResult = await submitSyncEnvelope(buyerToken, offlineGoldAssay);
    assert.equal(offlineAssayResult.status, 200, offlineAssayResult.text);
    assert.equal(offlineAssayResult.body.receipt.response.correctionOfId, assayCorrection.body.id);

    const sellerAccept = await request(app).post(`/api/v1/gold-trades/${tradeId}/lines/${initialLineId}/decisions`).set('Authorization', `Bearer ${sellerToken}`).set('Idempotency-Key', randomUUID()).send({
      decision: 'ACCEPT', quantityGrams: '0.050000', unitPrice: '2500.00000000', deductionAmount: '5.00000000', deductionReason: 'Fictional agreed refining deduction', occurredAt: tradeDate,
    });
    assert.equal(sellerAccept.status, 201, sellerAccept.text);
    const duplicateDecision = await request(app).post(`/api/v1/gold-trades/${tradeId}/lines/${initialLineId}/decisions`).set('Authorization', `Bearer ${sellerToken}`).set('Idempotency-Key', randomUUID()).send({
      decision: 'ACCEPT', quantityGrams: '0.050000', unitPrice: '2500.00000000', deductionAmount: '5.00000000', deductionReason: 'Fictional agreed refining deduction', occurredAt: tradeDate,
    });
    assert.equal(duplicateDecision.status, 409, duplicateDecision.text);
    const mismatchedBuyerAccept = await request(app).post(`/api/v1/gold-trades/${tradeId}/lines/${initialLineId}/decisions`).set('Authorization', `Bearer ${buyerToken}`).set('Idempotency-Key', randomUUID()).send({
      decision: 'ACCEPT', quantityGrams: '0.049000', unitPrice: '2600.00000000', deductionAmount: '5.00000000', deductionReason: 'Fictional agreed refining deduction', occurredAt: tradeDate,
    });
    assert.equal(mismatchedBuyerAccept.status, 201, mismatchedBuyerAccept.text);
    assert.equal(mismatchedBuyerAccept.body.status, 'DISPUTED');
    assert.equal((await db(`SELECT count(*)::int AS total FROM gold_trade_line WHERE trade_id=:tradeId AND is_accepted`, { tradeId }, undefined, QueryTypes.SELECT))[0].total, 0);
    const revision = await request(app).post(`/api/v1/gold-trades/${tradeId}/lines/${initialLineId}/revisions`).set('Authorization', `Bearer ${sellerToken}`).set('Idempotency-Key', randomUUID()).send({
      quantityGrams: '0.050000', unitPrice: '2500.00000000', deductionAmount: '5.00000000', deductionReason: 'Fictional agreed refining deduction',
      correctionReason: 'Counterparties submit a fresh shared price proposal.', occurredAt: tradeDate, evidenceRef: 'FICTIONAL-REVISED-TERMS',
    });
    assert.equal(revision.status, 201, revision.text);
    const sellerFreshAccept = await request(app).post(`/api/v1/gold-trades/${tradeId}/lines/${revision.body.id}/decisions`).set('Authorization', `Bearer ${sellerToken}`).set('Idempotency-Key', randomUUID()).send({
      decision: 'ACCEPT', quantityGrams: '0.050000', unitPrice: '2500.00000000', deductionAmount: '5.00000000', deductionReason: 'Fictional agreed refining deduction', occurredAt: tradeDate,
    });
    assert.equal(sellerFreshAccept.status, 201, sellerFreshAccept.text);
    assert.equal((await db(`SELECT status FROM gold_trade WHERE id=:id`, { id: tradeId }, undefined, QueryTypes.SELECT))[0].status, 'PROPOSED');
    assert.equal((await db(`SELECT is_accepted FROM gold_trade_line WHERE id=:id`, { id: revision.body.id }, undefined, QueryTypes.SELECT))[0].is_accepted, false);
    const buyerFreshAccept = await request(app).post(`/api/v1/gold-trades/${tradeId}/lines/${revision.body.id}/decisions`).set('Authorization', `Bearer ${buyerToken}`).set('Idempotency-Key', randomUUID()).send({
      decision: 'ACCEPT', quantityGrams: '0.050000', unitPrice: '2500.00000000', deductionAmount: '5.00000000', deductionReason: 'Fictional agreed refining deduction', occurredAt: tradeDate,
    });
    assert.equal(buyerFreshAccept.status, 201, buyerFreshAccept.text);
    assert.equal(buyerFreshAccept.body.status, 'AGREED');
    const acceptedLineId = buyerFreshAccept.body.acceptedLineId;
    const acceptedMeasurement = await request(app).post(`/api/v1/gold-trades/${tradeId}/lines/${acceptedLineId}/measurements`).set('Authorization', `Bearer ${buyerToken}`).set('Idempotency-Key', randomUUID()).send({
      kind: 'MEASURED', quantityGrams: '0.050000', sourceValue: '50.000', sourceUnit: 'mg', conversionVersion: 'canonical-mass-v1', sourceRole: 'BUYER', occurredAt: tradeDate, evidenceRef: 'FICTIONAL-AGREED-WEIGHT',
    });
    assert.equal(acceptedMeasurement.status, 201, acceptedMeasurement.text);
    const [acceptedMeasurementSet] = await db(`SELECT id FROM material_measurement_set WHERE gold_trade_line_id=:lineId`, { lineId: acceptedLineId }, undefined, QueryTypes.SELECT);
    const recordCustodyMeasurement = async (quantityGrams, sourceValue, evidenceRef) => {
      const observation = await request(app).post(`/api/v1/gold-trades/${tradeId}/lines/${acceptedLineId}/measurements`).set('Authorization', `Bearer ${sellerToken}`).set('Idempotency-Key', randomUUID()).send({
        kind: 'MEASURED', quantityGrams, sourceValue, sourceUnit: 'mg', conversionVersion: 'canonical-mass-v1', sourceRole: 'SELLER', methodCode: 'CUSTODY_HANDOVER', occurredAt: tradeDate, evidenceRef,
      });
      assert.equal(observation.status, 201, observation.text);
      return observation.body.id;
    };
    const inexactHandover = await request(app).post(`/api/v1/gold-trades/${tradeId}/lines/${acceptedLineId}/custody-offers`).set('Authorization', `Bearer ${sellerToken}`).set('Idempotency-Key', randomUUID()).send({
      sourceLocationId: recovered.source_location_id, destinationLocationId: buyerLocationId, measurementSetId: acceptedMeasurementSet.id, measurementId: acceptedMeasurement.body.id,
      quantityGrams: '0.020000', occurredAt: tradeDate,
    });
    assert.equal(inexactHandover.status, 400, inexactHandover.text);
    assert.equal(inexactHandover.body.error.code, 'CUSTODY_MEASUREMENT_MISMATCH');
    const firstHandoverMeasurementId = await recordCustodyMeasurement('0.020000', '20.000', 'FICTIONAL-HANDOVER-WEIGHT');

    const offered = await request(app).post(`/api/v1/gold-trades/${tradeId}/lines/${acceptedLineId}/custody-offers`).set('Authorization', `Bearer ${sellerToken}`).set('Idempotency-Key', randomUUID()).send({
      sourceLocationId: recovered.source_location_id, destinationLocationId: buyerLocationId, measurementSetId: acceptedMeasurementSet.id, measurementId: firstHandoverMeasurementId,
      quantityGrams: '0.020000', occurredAt: tradeDate, evidenceRef: 'FICTIONAL-HANDOVER-OFFER',
    });
    assert.equal(offered.status, 201, offered.text);
    const custodyDecisionKey = randomUUID();
    const acceptedHandover = await request(app).post(`/api/v1/gold-trades/${tradeId}/custody-transfers/${offered.body.id}/decisions`).set('Authorization', `Bearer ${buyerToken}`).set('Idempotency-Key', custodyDecisionKey).send({ decision: 'ACCEPT', occurredAt: tradeDate, evidenceRef: 'FICTIONAL-HANDOVER-ACK' });
    assert.equal(acceptedHandover.status, 200, acceptedHandover.text);
    assert.ok(acceptedHandover.body.inventoryMovementId);
    const custodyRetry = await request(app).post(`/api/v1/gold-trades/${tradeId}/custody-transfers/${offered.body.id}/decisions`).set('Authorization', `Bearer ${buyerToken}`).set('Idempotency-Key', custodyDecisionKey).send({ decision: 'ACCEPT', occurredAt: tradeDate, evidenceRef: 'FICTIONAL-HANDOVER-ACK' });
    assert.equal(custodyRetry.status, 200, custodyRetry.text);
    assert.equal(custodyRetry.body.inventoryMovementId, acceptedHandover.body.inventoryMovementId);
    const [transferLines] = await db(`SELECT count(*)::int AS total FROM inventory_movement_line WHERE inventory_movement_id=:movementId`, { movementId: acceptedHandover.body.inventoryMovementId }, undefined, QueryTypes.SELECT);
    assert.equal(transferLines.total, 2);
    const [handoverMeasurement] = await db(`SELECT mm.quantity_g FROM inventory_movement_line ml JOIN material_measurement mm ON mm.id=ml.basis_measurement_id WHERE ml.inventory_movement_id=:movementId AND ml.direction='OUT'`, { movementId: acceptedHandover.body.inventoryMovementId }, undefined, QueryTypes.SELECT);
    assert.equal(handoverMeasurement.quantity_g, '0.020000');
    const [inventoryBalance] = await db(`SELECT quantity_g FROM inventory_balance WHERE batch_id=:batchId AND location_id=:locationId`, { batchId: recovered.batch_id, locationId: buyerLocationId }, undefined, QueryTypes.SELECT);
    assert.equal(inventoryBalance.quantity_g, '0.020000');
    const disputedMeasurementId = await recordCustodyMeasurement('0.010000', '10.000', 'FICTIONAL-DISPUTED-HANDOVER-WEIGHT');
    const disputedOffer = await request(app).post(`/api/v1/gold-trades/${tradeId}/lines/${acceptedLineId}/custody-offers`).set('Authorization', `Bearer ${sellerToken}`).set('Idempotency-Key', randomUUID()).send({
      sourceLocationId: recovered.source_location_id, destinationLocationId: buyerLocationId, measurementSetId: acceptedMeasurementSet.id, measurementId: disputedMeasurementId,
      quantityGrams: '0.010000', occurredAt: tradeDate,
    });
    assert.equal(disputedOffer.status, 201, disputedOffer.text);
    const disputedHandover = await request(app).post(`/api/v1/gold-trades/${tradeId}/custody-transfers/${disputedOffer.body.id}/decisions`).set('Authorization', `Bearer ${buyerToken}`).set('Idempotency-Key', randomUUID()).send({ decision: 'DISPUTE', occurredAt: tradeDate, reason: 'Fictional scale readings differ.' });
    assert.equal(disputedHandover.status, 200, disputedHandover.text);
    assert.equal(disputedHandover.body.status, 'DISPUTED');
    const raceMeasurementIds = await Promise.all(['RACE-A','RACE-B'].map((suffix) => recordCustodyMeasurement('0.020000', '20.000', `FICTIONAL-CUSTODY-WEIGHT-${suffix}`)));
    const raceOffers = await Promise.all(['RACE-A','RACE-B'].map((suffix, index) => request(app).post(`/api/v1/gold-trades/${tradeId}/lines/${acceptedLineId}/custody-offers`).set('Authorization', `Bearer ${sellerToken}`).set('Idempotency-Key', randomUUID()).send({
      sourceLocationId: recovered.source_location_id, destinationLocationId: buyerLocationId, measurementSetId: acceptedMeasurementSet.id, measurementId: raceMeasurementIds[index],
      quantityGrams: '0.020000', occurredAt: tradeDate, evidenceRef: `FICTIONAL-CUSTODY-${suffix}`,
    })));
    assert.deepEqual(raceOffers.map((response) => response.status), [201,201]);
    const raceDecisions = await Promise.all(raceOffers.map((response) => request(app).post(`/api/v1/gold-trades/${tradeId}/custody-transfers/${response.body.id}/decisions`).set('Authorization', `Bearer ${buyerToken}`).set('Idempotency-Key', randomUUID()).send({ decision: 'ACCEPT', occurredAt: tradeDate })));
    assert.equal(raceDecisions.filter((response) => response.status === 200).length, 1);
    assert.equal(raceDecisions.filter((response) => response.status !== 200).length, 1);
    const [merchantBalanceAfterRace] = await db(`SELECT quantity_g FROM inventory_balance WHERE batch_id=:batchId AND location_id=:locationId`, { batchId: recovered.batch_id, locationId: buyerLocationId }, undefined, QueryTypes.SELECT);
    assert.equal(merchantBalanceAfterRace.quantity_g, '0.040000');

    const activeSellerRoleId = randomUUID();
    await db(`INSERT INTO role_assignment(id,user_id,role_code,scope_kind,scope_id) VALUES (:id,:userId,'RECOVERY_FACILITY_OPERATOR','FACILITY',:facilityId)`, {
      id: activeSellerRoleId, userId: ids.phaseThree.recoveryUserId, facilityId: ids.phaseThree.recoveryFacilityId,
    });
    const offlineSellerContext = {
      userId: ids.phaseThree.recoveryUserId, partyId: ids.phaseThree.recoveryPartyUserId,
      roleCode: 'RECOVERY_FACILITY_OPERATOR', scopeKind: 'FACILITY', scopeId: ids.phaseThree.recoveryFacilityId,
    };
    const offlineCustodyMeasurement = await request(app).post(`/api/v1/gold-trades/${tradeId}/lines/${acceptedLineId}/measurements`)
      .set('Authorization', `Bearer ${sellerToken}`).set('Idempotency-Key', randomUUID()).send({
        kind: 'MEASURED', quantityGrams: '0.005000', sourceValue: '5.000', sourceUnit: 'mg', conversionVersion: 'canonical-mass-v1',
        sourceRole: 'SELLER', methodCode: 'OFFLINE-CUSTODY-WEIGHING', occurredAt: tradeDate, evidenceRef: 'FICTIONAL-OFFLINE-GOLD-WEIGHT',
      });
    assert.equal(offlineCustodyMeasurement.status, 201, offlineCustodyMeasurement.text);
    const offlineGoldOffer = await versionSyncEnvelope(sellerToken, makeSyncEnvelope({
      ...offlineSellerContext, commandType: 'gold_trade.custody.offer', occurredAt: tradeDate,
      payload: { tradeId, lineId: acceptedLineId, input: {
        sourceLocationId: recovered.source_location_id, destinationLocationId: buyerLocationId,
        measurementSetId: acceptedMeasurementSet.id, measurementId: offlineCustodyMeasurement.body.id,
        quantityGrams: '0.005000', occurredAt: tradeDate, evidenceRef: 'FICTIONAL-OFFLINE-GOLD-HANDOVER',
      } },
    }));
    const offeredOfflineGold = await submitSyncEnvelope(sellerToken, offlineGoldOffer);
    assert.equal(offeredOfflineGold.status, 200, offeredOfflineGold.text);
    const offlineGoldTransferId = offeredOfflineGold.body.receipt.response.id;
    const offlineBuyerContext = { userId: buyer.userId, partyId: buyerPartyId, roleCode: 'LOCAL_MERCHANT', scopeKind: 'ORGANISATION', scopeId: buyerPartyId };
    const offlineGoldDecision = await versionSyncEnvelope(buyerToken, makeSyncEnvelope({
      ...offlineBuyerContext, commandType: 'custody.transfer.decide', occurredAt: tradeDate,
      parentCommandIds: [offlineGoldOffer.clientMutationId],
      payload: { transferId: offlineGoldTransferId, input: { decision: 'ACCEPT', occurredAt: tradeDate, evidenceRef: 'FICTIONAL-OFFLINE-GOLD-HANDOVER-ACK' } },
    }));
    const acceptedOfflineGold = await submitSyncEnvelope(buyerToken, offlineGoldDecision);
    assert.equal(acceptedOfflineGold.status, 200, acceptedOfflineGold.text);
    assert.ok(acceptedOfflineGold.body.receipt.response.inventoryMovementId);

    const insufficientMeasurementId = await recordCustodyMeasurement('0.190000', '190.000', 'FICTIONAL-INVENTORY-OVERDRAW-WEIGHT');
    const insufficientHandover = await request(app).post(`/api/v1/gold-trades/${tradeId}/lines/${acceptedLineId}/custody-offers`).set('Authorization', `Bearer ${sellerToken}`).set('Idempotency-Key', randomUUID()).send({
      sourceLocationId: recovered.source_location_id, destinationLocationId: buyerLocationId, measurementSetId: acceptedMeasurementSet.id, measurementId: insufficientMeasurementId,
      quantityGrams: '0.190000', occurredAt: tradeDate,
    });
    assert.equal(insufficientHandover.status, 409, insufficientHandover.text);

    const unauthorizedPayment = await request(app).post(`/api/v1/gold-trades/${tradeId}/payments`).set('Authorization', `Bearer ${ids.siteToken}`).set('Idempotency-Key', randomUUID()).send({ amount: '1.00000000', methodCode: 'CASH_RECORDED', occurredAt: tradeDate });
    assert.equal(unauthorizedPayment.status, 404);
    const paymentMutationKey = randomUUID();
    const firstPayment = await request(app).post(`/api/v1/gold-trades/${tradeId}/payments`).set('Authorization', `Bearer ${buyerToken}`).set('Idempotency-Key', paymentMutationKey).send({ amount: '20.00000000', methodCode: 'CASH_RECORDED', reference: 'FICTIONAL-CASH-01', occurredAt: tradeDate });
    assert.equal(firstPayment.status, 201, firstPayment.text);
    const duplicatePayment = await request(app).post(`/api/v1/gold-trades/${tradeId}/payments`).set('Authorization', `Bearer ${buyerToken}`).set('Idempotency-Key', paymentMutationKey).send({ amount: '20.00000000', methodCode: 'CASH_RECORDED', reference: 'FICTIONAL-CASH-01', occurredAt: tradeDate });
    assert.equal(duplicatePayment.status, 201, duplicatePayment.text);
    assert.equal(duplicatePayment.body.id, firstPayment.body.id);
    assert.equal(duplicatePayment.body.replayed, true);
    const disputedPayment = await request(app).post(`/api/v1/gold-trades/${tradeId}/payments/${firstPayment.body.id}/decisions`).set('Authorization', `Bearer ${sellerToken}`).set('Idempotency-Key', randomUUID()).send({ decision: 'DISPUTE', occurredAt: tradeDate, reason: 'Fictional receipt confirmation is pending.' });
    assert.equal(disputedPayment.status, 201, disputedPayment.text);
    const confirmedPayment = await request(app).post(`/api/v1/gold-trades/${tradeId}/payments/${firstPayment.body.id}/decisions`).set('Authorization', `Bearer ${sellerToken}`).set('Idempotency-Key', randomUUID()).send({ decision: 'CONFIRM', occurredAt: tradeDate, evidenceRef: 'FICTIONAL-RECEIPT-01' });
    assert.equal(confirmedPayment.status, 201, confirmedPayment.text);
    for (const [amount, reference] of [['50.00000000','FICTIONAL-CASH-02'],['50.00000000','FICTIONAL-CASH-03']]) {
      const payment = await request(app).post(`/api/v1/gold-trades/${tradeId}/payments`).set('Authorization', `Bearer ${buyerToken}`).set('Idempotency-Key', randomUUID()).send({ amount, methodCode: 'BANK_TRANSFER_RECORDED', reference, occurredAt: tradeDate });
      assert.equal(payment.status, 201, payment.text);
      const confirmation = await request(app).post(`/api/v1/gold-trades/${tradeId}/payments/${payment.body.id}/decisions`).set('Authorization', `Bearer ${sellerToken}`).set('Idempotency-Key', randomUUID()).send({ decision: 'CONFIRM', occurredAt: tradeDate });
      assert.equal(confirmation.status, 201, confirmation.text);
    }
    const overpayment = await request(app).post(`/api/v1/gold-trades/${tradeId}/payments`).set('Authorization', `Bearer ${buyerToken}`).set('Idempotency-Key', randomUUID()).send({ amount: '0.01000000', methodCode: 'CASH_RECORDED', occurredAt: tradeDate });
    assert.equal(overpayment.status, 409, overpayment.text);
    const reconciliation = await request(app).get(`/api/v1/gold-trades/${tradeId}`).set('Authorization', `Bearer ${buyerToken}`);
    assert.equal(reconciliation.status, 200, reconciliation.text);
    assert.equal(reconciliation.body.status, 'AGREED');
    assert.equal(reconciliation.body.reconciliation.amountAgreed, '120.00000000');
    assert.equal(reconciliation.body.reconciliation.amountSettled, '120.00000000');
    assert.equal(reconciliation.body.reconciliation.amountOutstanding, '0.00000000');
    assert.deepEqual(reconciliation.body.reconciliation.unresolvedPaymentReports, []);
    assert.ok(reconciliation.body.assays.some((item) => item.id === assay.body.id));
    assert.ok(reconciliation.body.assays.some((item) => item.correction_of_id === assay.body.id));
    assert.ok(reconciliation.body.lines.find((line) => line.id === initialLineId).measurements.some((item) => item.id === sellerDeclared.body.id));
    assert.ok(reconciliation.body.lines.find((line) => line.id === initialLineId).measurements.some((item) => item.supersedes_measurement_id === sellerDeclared.body.id));
    assert.equal((await request(app).get(`/api/v1/gold-trades/${tradeId}`).set('Authorization', `Bearer ${ids.siteToken}`)).status, 404);
    assert.equal((await verifyAuditStream('gold_trade', tradeId)).valid, true);
  });

  await t.test('Phase 4 assay and measurement attribution, assay lineage, and current batch-line integrity', async (phaseFourIntegrity) => {
    const [recovered] = await db(`SELECT ro.batch_id,location.custodian_party_id AS seller_party_id,ril.inventory_location_id AS source_location_id
      FROM recovery_event_output ro JOIN recovery_event re ON re.event_id=ro.recovery_event_id
      JOIN recovery_inventory_location ril ON ril.recovery_facility_id=re.recovery_facility_id
      JOIN inventory_location location ON location.id=ril.inventory_location_id
      WHERE ro.recovery_event_id=:eventId AND ro.output_role='RECOVERED_GOLD' LIMIT 1`, { eventId: ids.phaseThree.recoveryEventId }, undefined, QueryTypes.SELECT);
    assert.ok(recovered);
    const sellerPartyId = recovered.seller_party_id;
    const sellerToken = ids.phaseThree.recoveryToken;
    const sellerPerson = ids.phaseThree.recoveryPartyUserId;
    const buyerPartyId = await seedParty('ORGANISATION', 'Fictional Integrity Test Merchant', 'LOCAL_MERCHANT');
    await db(`INSERT INTO party_participation(id,party_id,participant_kind) VALUES (:id,:partyId,'LOCAL_MERCHANT')`, { id: randomUUID(), partyId: buyerPartyId });
    const buyer = await seedUser('gold-integrity-buyer@example.test', 'Fictional Integrity Test Buyer', { roleCode: 'LOCAL_MERCHANT', scopeKind: 'ORGANISATION', scopeId: buyerPartyId });
    await db(`INSERT INTO organisation_membership(id,person_party_id,organisation_party_id,membership_type) VALUES (:id,:person,:org,'MEMBER')`, { id: randomUUID(), person: buyer.partyId, org: buyerPartyId });
    const buyerToken = testToken(buyer.userId);
    const labPartyId = await seedParty('ORGANISATION', 'Fictional Assay and Weighing Group');
    const labMembershipId = randomUUID();
    await db(`INSERT INTO organisation_membership(id,person_party_id,organisation_party_id,membership_type) VALUES (:id,:person,:org,'MEMBER')`, { id: labMembershipId, person: buyer.partyId, org: labPartyId });
    await db(`INSERT INTO role_assignment(id,user_id,role_code,scope_kind,scope_id) VALUES (:id,:userId,'FIELD_OFFICER','ORGANISATION',:org)`, { id: randomUUID(), userId: buyer.userId, org: labPartyId });
    const unrelatedPartyId = await seedParty('ORGANISATION', 'Fictional Unrelated Measurement Source');
    const tradeDate = new Date(Date.now() + 60_000).toISOString();
    const batchA = recovered.batch_id;
    const batchB = ids.processingOutputs[0].batchId;
    assert.notEqual(batchA, batchB);
    const batchBLocationId = randomUUID();
    await db(`INSERT INTO inventory_location(id,location_code,location_kind,custodian_party_id)
      VALUES (:id,:code,'OTHER',:seller)`, { id: batchBLocationId, code: `GOLD-INTEGRITY-${randomUUID()}`, seller: sellerPartyId });
    await createOpeningBalance(batchB, batchBLocationId, '2.000000');

    const proposal = (batchId, assayRecordId = undefined) => ({
      tradeKind: 'PURCHASE', sellerPartyId, buyerPartyId, tradeDate, currencyCode: 'KES',
      lines: [{ batchId, quantityGrams: '0.010000', unitPrice: '2400.00000000', ...(assayRecordId ? { assayRecordId } : {}) }],
    });
    const createTrade = async (body) => request(app).post('/api/v1/gold-trades').set('Authorization', `Bearer ${sellerToken}`)
      .set('Idempotency-Key', randomUUID()).send(body);
    const duplicateProposal = await createTrade({ ...proposal(batchA), lines: [proposal(batchA).lines[0], proposal(batchA).lines[0]] });
    assert.equal(duplicateProposal.status, 400, duplicateProposal.text);
    assert.equal(duplicateProposal.body.error.code, 'DUPLICATE_BATCH');

    const tradeAResponse = await createTrade(proposal(batchA));
    assert.equal(tradeAResponse.status, 201, tradeAResponse.text);
    const tradeA = tradeAResponse.body.id;
    const lineA = tradeAResponse.body.lines[0].id;
    await assert.rejects(db(`INSERT INTO gold_trade_line(id,trade_id,batch_id,revision_no,revision_kind,transaction_quantity_g,unit_price,line_amount,is_current)
      VALUES (:id,:tradeId,:batchId,1,'ORIGINAL','0.010000','2400.00000000','24.00000000',true)`, {
      id: randomUUID(), tradeId: tradeA, batchId: batchA,
    }), sqlError('23505'));
    const measurement = (sourceRole, sourcePartyId = undefined) => ({
      kind: 'DECLARED', quantityGrams: '0.010000', sourceValue: '10.000', sourceUnit: 'mg',
      conversionVersion: 'canonical-mass-v1', sourceRole, occurredAt: tradeDate,
      ...(sourcePartyId ? { sourcePartyId } : {}),
    });
    const recordMeasurement = (tradeId, lineId, sourceRole, token, sourcePartyId = undefined) => request(app)
      .post(`/api/v1/gold-trades/${tradeId}/lines/${lineId}/measurements`).set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID()).send(measurement(sourceRole, sourcePartyId));
    for (const [role, token, source] of [
      ['SELLER', sellerToken, undefined], ['BUYER', buyerToken, undefined], ['RECORDER', sellerToken, undefined],
      ['WITNESS', sellerToken, sellerPerson], ['WEIGHER', sellerToken, sellerPerson], ['OTHER', sellerToken, sellerPerson],
      ['WITNESS', buyerToken, labPartyId],
    ]) {
      const response = await recordMeasurement(tradeA, lineA, role, token, source);
      assert.equal(response.status, 201, `${role} source: ${response.text}`);
    }
    for (const [role, token, source] of [
      ['SELLER', buyerToken, undefined], ['BUYER', sellerToken, undefined], ['RECORDER', sellerToken, buyerPartyId],
      ['WITNESS', sellerToken, undefined], ['WEIGHER', sellerToken, undefined], ['OTHER', sellerToken, undefined],
      ['WITNESS', sellerToken, unrelatedPartyId], ['WEIGHER', sellerToken, unrelatedPartyId], ['OTHER', sellerToken, unrelatedPartyId],
    ]) {
      const response = await recordMeasurement(tradeA, lineA, role, token, source);
      assert.equal(response.status, 400, `${role} source: ${response.text}`);
    }
    const [lineMeasurementSet] = await db(`SELECT id FROM material_measurement_set WHERE gold_trade_line_id=:lineId`, { lineId: lineA }, undefined, QueryTypes.SELECT);
    await assert.rejects(db(`INSERT INTO material_measurement(id,measurement_set_id,measurement_kind,quantity_g,source_value,source_unit_code,conversion_version,source_role,source_party_id,entered_by_user_id,occurred_at_claimed)
      VALUES (:id,:setId,'DECLARED','0.010000','10.000','mg','canonical-mass-v1','OTHER',:sourceParty,:actor,:occurredAt)`, {
      id: randomUUID(), setId: lineMeasurementSet.id, sourceParty: unrelatedPartyId,
      actor: ids.phaseThree.recoveryUserId, occurredAt: tradeDate,
    }), sqlError('23514'));
    const assayBody = (assayerPartyId) => ({ assayerPartyId, sampleRef: 'FICTIONAL-SAMPLE', methodRef: 'RECORDED-ASSAY', resultValue: '92.50000000', resultUnit: 'PERCENT', observedAt: tradeDate, evidenceRef: 'FICTIONAL-ASSAY-EVIDENCE' });
    const recordAssay = (tradeId, lineId, token, body) => request(app).post(`/api/v1/gold-trades/${tradeId}/lines/${lineId}/assays`)
      .set('Authorization', `Bearer ${token}`).set('Idempotency-Key', randomUUID()).send(body);
    const assayAResponse = await recordAssay(tradeA, lineA, sellerToken, assayBody(sellerPartyId));
    assert.equal(assayAResponse.status, 201, assayAResponse.text);
    assert.equal(assayAResponse.body.status, 'RECORDED');
    await assert.rejects(db(`INSERT INTO assay_record(id,batch_id,assayer_party_id,result_value,result_unit,observed_at,recorded_by_user_id,gold_trade_line_id)
      VALUES (:id,:batchId,:assayer,'90.00000000','PERCENT',:observedAt,:actor,:lineId)`, {
      id: randomUUID(), batchId: batchA, assayer: unrelatedPartyId, observedAt: tradeDate,
      actor: ids.phaseThree.recoveryUserId, lineId: lineA,
    }), sqlError('23514'));
    const unauthorizedAssayer = await recordAssay(tradeA, lineA, sellerToken, assayBody(unrelatedPartyId));
    assert.equal(unauthorizedAssayer.status, 400, unauthorizedAssayer.text);
    const representedOrgAssayer = await recordAssay(tradeA, lineA, buyerToken, assayBody(labPartyId));
    assert.equal(representedOrgAssayer.status, 201, representedOrgAssayer.text);
    await db(`UPDATE organisation_membership SET status='REVOKED' WHERE id=:id`, { id: labMembershipId });
    const revokedMeasurement = await recordMeasurement(tradeA, lineA, 'WEIGHER', buyerToken, labPartyId);
    assert.equal(revokedMeasurement.status, 400, revokedMeasurement.text);
    const revokedAssayer = await recordAssay(tradeA, lineA, buyerToken, assayBody(labPartyId));
    assert.equal(revokedAssayer.status, 400, revokedAssayer.text);
    const assayCorrection = await recordAssay(tradeA, lineA, sellerToken, {
      ...assayBody(sellerPartyId), correctionOfId: assayAResponse.body.id,
      correctionReason: 'Fictional transcription correction retained with its original record.',
    });
    assert.equal(assayCorrection.status, 201, assayCorrection.text);
    const staleAssayCorrection = await recordAssay(tradeA, lineA, sellerToken, {
      ...assayBody(sellerPartyId), correctionOfId: assayAResponse.body.id, correctionReason: 'A second correction cannot supersede the already corrected record.',
    });
    assert.equal(staleAssayCorrection.status, 400, staleAssayCorrection.text);
    const missingAssayCorrection = await recordAssay(tradeA, lineA, sellerToken, {
      ...assayBody(sellerPartyId), correctionOfId: randomUUID(), correctionReason: 'The referenced record does not exist.',
    });
    assert.equal(missingAssayCorrection.status, 400, missingAssayCorrection.text);
    await assert.rejects(db(`UPDATE assay_record SET result_value='99.00000000' WHERE id=:id`, { id: assayCorrection.body.id }), sqlError('55000'));
    await assert.rejects(db(`DELETE FROM assay_record WHERE id=:id`, { id: assayCorrection.body.id }), sqlError('55000'));

    const tradeBResponse = await createTrade(proposal(batchB));
    assert.equal(tradeBResponse.status, 201, tradeBResponse.text);
    const tradeB = tradeBResponse.body.id;
    const lineB = tradeBResponse.body.lines[0].id;
    const assayBResponse = await recordAssay(tradeB, lineB, sellerToken, assayBody(sellerPartyId));
    assert.equal(assayBResponse.status, 201, assayBResponse.text);
    const wrongBatchCorrection = await recordAssay(tradeB, lineB, sellerToken, {
      ...assayBody(sellerPartyId), correctionOfId: assayCorrection.body.id,
      correctionReason: 'A correction cannot cross gold batch lineage.',
    });
    assert.equal(wrongBatchCorrection.status, 400, wrongBatchCorrection.text);
    const wrongInitialAssay = await createTrade(proposal(batchB, assayCorrection.body.id));
    assert.equal(wrongInitialAssay.status, 400, wrongInitialAssay.text);
    assert.equal(wrongInitialAssay.body.error.code, 'INVALID_ASSAY');
    const wrongAddedAssay = await request(app).post(`/api/v1/gold-trades/${tradeA}/lines`).set('Authorization', `Bearer ${sellerToken}`)
      .set('Idempotency-Key', randomUUID()).send({ ...proposal(batchB).lines[0], assayRecordId: assayCorrection.body.id });
    assert.equal(wrongAddedAssay.status, 400, wrongAddedAssay.text);
    const wrongRevisionAssay = await request(app).post(`/api/v1/gold-trades/${tradeB}/lines/${lineB}/revisions`).set('Authorization', `Bearer ${sellerToken}`)
      .set('Idempotency-Key', randomUUID()).send({ quantityGrams: '0.010000', unitPrice: '2400.00000000', correctionReason: 'Fictional price proposal revision.', occurredAt: tradeDate, assayRecordId: assayCorrection.body.id });
    assert.equal(wrongRevisionAssay.status, 400, wrongRevisionAssay.text);

    const directBadLineId = randomUUID();
    await assert.rejects(db(`INSERT INTO gold_trade_line(id,trade_id,batch_id,revision_no,revision_kind,transaction_quantity_g,unit_price,line_amount,assay_record_id,is_current)
      VALUES (:id,:tradeId,:batchId,1,'ORIGINAL','0.010000','2400.00000000','24.00000000',:assayId,true)`, {
      id: directBadLineId, tradeId: tradeA, batchId: batchB, assayId: assayCorrection.body.id,
    }), sqlError('23503'));

    const correctInitialAssay = await createTrade(proposal(batchA, assayCorrection.body.id));
    assert.equal(correctInitialAssay.status, 201, correctInitialAssay.text);
    const duplicateAdd = await request(app).post(`/api/v1/gold-trades/${tradeA}/lines`).set('Authorization', `Bearer ${sellerToken}`)
      .set('Idempotency-Key', randomUUID()).send(proposal(batchA).lines[0]);
    assert.equal(duplicateAdd.status, 409, duplicateAdd.text);
    assert.equal(duplicateAdd.body.error.code, 'DUPLICATE_BATCH');

    const validRevision = await request(app).post(`/api/v1/gold-trades/${tradeB}/lines/${lineB}/revisions`).set('Authorization', `Bearer ${sellerToken}`)
      .set('Idempotency-Key', randomUUID()).send({ quantityGrams: '0.010000', unitPrice: '2400.00000000', correctionReason: 'Fictional valid linked successor for this batch.', occurredAt: tradeDate, assayRecordId: assayBResponse.body.id });
    assert.equal(validRevision.status, 201, validRevision.text);
    const staleRevision = await request(app).post(`/api/v1/gold-trades/${tradeB}/lines/${lineB}/revisions`).set('Authorization', `Bearer ${sellerToken}`)
      .set('Idempotency-Key', randomUUID()).send({ quantityGrams: '0.010000', unitPrice: '2400.00000000', correctionReason: 'A superseded line cannot receive another successor.', occurredAt: tradeDate });
    assert.equal(staleRevision.status, 409, staleRevision.text);
    const currentLineCount = await db(`SELECT count(*)::int AS total FROM gold_trade_line WHERE trade_id=:tradeId AND batch_id=:batchId AND is_current`, { tradeId: tradeB, batchId: batchB }, undefined, QueryTypes.SELECT);
    assert.equal(currentLineCount[0].total, 1);

    const repeatTradeResponse = await createTrade(proposal(batchA));
    assert.equal(repeatTradeResponse.status, 201, repeatTradeResponse.text);
    const repeatKey = randomUUID();
    const addBody = { ...proposal(batchB).lines[0], assayRecordId: assayBResponse.body.id };
    const firstAdd = await request(app).post(`/api/v1/gold-trades/${repeatTradeResponse.body.id}/lines`).set('Authorization', `Bearer ${sellerToken}`).set('Idempotency-Key', repeatKey).send(addBody);
    assert.equal(firstAdd.status, 201, firstAdd.text);
    const repeatedAdd = await request(app).post(`/api/v1/gold-trades/${repeatTradeResponse.body.id}/lines`).set('Authorization', `Bearer ${sellerToken}`).set('Idempotency-Key', repeatKey).send(addBody);
    assert.equal(repeatedAdd.status, 201, repeatedAdd.text);
    assert.equal(repeatedAdd.body.id, firstAdd.body.id);
    assert.equal(repeatedAdd.body.replayed, true);

    const raceTradeResponse = await createTrade(proposal(batchA));
    assert.equal(raceTradeResponse.status, 201, raceTradeResponse.text);
    const concurrentAdds = await Promise.all([0, 1].map(() => request(app).post(`/api/v1/gold-trades/${raceTradeResponse.body.id}/lines`)
      .set('Authorization', `Bearer ${sellerToken}`).set('Idempotency-Key', randomUUID()).send(proposal(batchB).lines[0])));
    assert.deepEqual(concurrentAdds.map((response) => response.status).sort(), [201, 409]);
    const raceCurrentLineCount = await db(`SELECT count(*)::int AS total FROM gold_trade_line WHERE trade_id=:tradeId AND batch_id=:batchId AND is_current`, { tradeId: raceTradeResponse.body.id, batchId: batchB }, undefined, QueryTypes.SELECT);
    assert.equal(raceCurrentLineCount[0].total, 1);

    await phaseFourIntegrity.test('observations serialize with trade closure and line revision', async () => {
      const observationCounts = async (lineId) => {
        const [counts] = await db(`SELECT
          (SELECT count(*)::int FROM material_measurement measurement JOIN material_measurement_set measurement_set ON measurement_set.id=measurement.measurement_set_id WHERE measurement_set.gold_trade_line_id=:lineId) AS measurements,
          (SELECT count(*)::int FROM assay_record WHERE gold_trade_line_id=:lineId) AS assays`, { lineId }, undefined, QueryTypes.SELECT);
        return counts;
      };
      const waitForBlockedWrites = async (tradeId) => {
        const deadline = Date.now() + 8_000;
        while (Date.now() < deadline) {
          const [waiters] = await db(`SELECT count(*)::int AS total FROM pg_stat_activity
            WHERE datname=current_database() AND state='active' AND wait_event_type='Lock'
              AND position('FOR UPDATE' IN upper(query))>0 AND position(:tradeId IN query)>0`, { tradeId }, undefined, QueryTypes.SELECT);
          if (waiters.total >= 2) return;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error(`Both observation requests did not reach the trade row lock for ${tradeId}.`);
      };
      const raceObservationsWith = async (tradeId, applyChange) => {
        let releaseLock;
        let acquiredLock;
        const lockAcquired = new Promise((resolve) => { acquiredLock = resolve; });
        const heldTransaction = sequelize.transaction(async (transaction) => {
          await db(`SELECT id FROM gold_trade WHERE id=:tradeId FOR UPDATE`, { tradeId }, transaction);
          await new Promise((resolve) => {
            releaseLock = resolve;
            acquiredLock();
          });
          await applyChange(transaction);
        });
        await lockAcquired;
        const pendingResponses = Promise.all([
          recordMeasurement(tradeId, (await db(`SELECT id FROM gold_trade_line WHERE trade_id=:tradeId AND is_current`, { tradeId }, undefined, QueryTypes.SELECT))[0].id, 'SELLER', sellerToken),
          recordAssay(tradeId, (await db(`SELECT id FROM gold_trade_line WHERE trade_id=:tradeId AND is_current`, { tradeId }, undefined, QueryTypes.SELECT))[0].id, sellerToken, assayBody(sellerPartyId)),
        ]);
        let blockedWriteError;
        try {
          await waitForBlockedWrites(tradeId);
        } catch (error) {
          blockedWriteError = error;
        } finally {
          releaseLock();
        }
        await heldTransaction;
        const responses = await pendingResponses;
        if (blockedWriteError) throw blockedWriteError;
        return responses;
      };
      const closeTrade = async (tradeId, transaction) => {
        await db(`INSERT INTO gold_trade_status_event(id,gold_trade_id,previous_status,next_status,actor_user_id,actor_party_id,occurred_at,reason)
          VALUES (:id,:tradeId,'PROPOSED','CLOSED',:actor,:party,:occurredAt,'Fictional integration-test closure.')`, {
          id: randomUUID(), tradeId, actor: buyer.userId, party: buyerPartyId, occurredAt: tradeDate,
        }, transaction);
        await db(`UPDATE gold_trade SET status='CLOSED' WHERE id=:tradeId`, { tradeId }, transaction);
      };

      const closingTradeResponse = await createTrade(proposal(batchA));
      assert.equal(closingTradeResponse.status, 201, closingTradeResponse.text);
      const closingTradeId = closingTradeResponse.body.id;
      const closingLineId = closingTradeResponse.body.lines[0].id;
      const closeRace = await raceObservationsWith(closingTradeId, (transaction) => closeTrade(closingTradeId, transaction));
      assert.deepEqual(closeRace.map((response) => [response.status, response.body.error.code]).sort((left, right) => left[1].localeCompare(right[1])), [
        [409, 'TRADE_CLOSED'], [409, 'TRADE_CLOSED'],
      ]);
      assert.deepEqual(await observationCounts(closingLineId), { measurements: 0, assays: 0 });
      assert.equal((await recordMeasurement(closingTradeId, closingLineId, 'SELLER', sellerToken)).body.error.code, 'TRADE_CLOSED');
      assert.equal((await recordAssay(closingTradeId, closingLineId, sellerToken, assayBody(sellerPartyId))).body.error.code, 'TRADE_CLOSED');
      assert.deepEqual(await observationCounts(closingLineId), { measurements: 0, assays: 0 });

      const [closedMeasurementSet] = await db(`SELECT id FROM material_measurement_set WHERE gold_trade_line_id=:lineId`, { lineId: closingLineId }, undefined, QueryTypes.SELECT);
      await assert.rejects(db(`INSERT INTO assay_record(id,batch_id,assayer_party_id,result_value,result_unit,observed_at,recorded_by_user_id,gold_trade_line_id)
        VALUES (:id,:batchId,:assayer,'92.50000000','PERCENT',:observedAt,:actor,:lineId)`, {
        id: randomUUID(), batchId: batchA, assayer: sellerPartyId, observedAt: tradeDate, actor: sellerPerson, lineId: closingLineId,
      }), sqlError('23514'));
      await assert.rejects(db(`INSERT INTO material_measurement(id,measurement_set_id,measurement_kind,quantity_g,source_value,source_unit_code,conversion_version,source_role,source_party_id,entered_by_user_id,occurred_at_claimed)
        VALUES (:id,:setId,'DECLARED','0.010000','10.000','mg','canonical-mass-v1','SELLER',:source,:actor,:occurredAt)`, {
        id: randomUUID(), setId: closedMeasurementSet.id, source: sellerPartyId, actor: sellerPerson, occurredAt: tradeDate,
      }), sqlError('23514'));
      assert.deepEqual(await observationCounts(closingLineId), { measurements: 0, assays: 0 });

      const revisionTradeResponse = await createTrade(proposal(batchB));
      assert.equal(revisionTradeResponse.status, 201, revisionTradeResponse.text);
      const revisionTradeId = revisionTradeResponse.body.id;
      const priorLineId = revisionTradeResponse.body.lines[0].id;
      const successorLineId = randomUUID();
      const successorMeasurementSetId = randomUUID();
      const revisionRace = await raceObservationsWith(revisionTradeId, async (transaction) => {
        await db(`INSERT INTO gold_trade_line(id,trade_id,batch_id,revision_no,revision_kind,transaction_quantity_g,unit_price,line_amount,supersedes_line_id,correction_reason,is_current)
          VALUES (:id,:tradeId,:batchId,2,'CORRECTION','0.010000','2400.00000000','24.00000000',:prior,'Fictional concurrent revision.',false)`, {
          id: successorLineId, tradeId: revisionTradeId, batchId: batchB, prior: priorLineId,
        }, transaction);
        await db(`INSERT INTO material_measurement_set(id,batch_id,gold_trade_line_id) VALUES (:id,:batchId,:lineId)`, {
          id: successorMeasurementSetId, batchId: batchB, lineId: successorLineId,
        }, transaction);
        await db(`UPDATE gold_trade_line SET is_current=false WHERE id=:lineId`, { lineId: priorLineId }, transaction);
        await db(`UPDATE gold_trade_line SET is_current=true WHERE id=:lineId`, { lineId: successorLineId }, transaction);
      });
      assert.deepEqual(revisionRace.map((response) => [response.status, response.body.error.code]).sort((left, right) => left[1].localeCompare(right[1])), [
        [409, 'STALE_TRADE_LINE'], [409, 'STALE_TRADE_LINE'],
      ]);
      assert.deepEqual(await observationCounts(priorLineId), { measurements: 0, assays: 0 });
      assert.deepEqual(await observationCounts(successorLineId), { measurements: 0, assays: 0 });
      const [currentLines] = await db(`SELECT count(*)::int AS total FROM gold_trade_line WHERE trade_id=:tradeId AND is_current`, { tradeId: revisionTradeId }, undefined, QueryTypes.SELECT);
      assert.equal(currentLines.total, 1);
      assert.equal((await recordMeasurement(revisionTradeId, priorLineId, 'SELLER', sellerToken)).body.error.code, 'STALE_TRADE_LINE');
      assert.equal((await recordAssay(revisionTradeId, priorLineId, sellerToken, assayBody(sellerPartyId))).body.error.code, 'STALE_TRADE_LINE');

      const [supersededMeasurementSet] = await db(`SELECT id FROM material_measurement_set WHERE gold_trade_line_id=:lineId`, { lineId: priorLineId }, undefined, QueryTypes.SELECT);
      await assert.rejects(db(`INSERT INTO assay_record(id,batch_id,assayer_party_id,result_value,result_unit,observed_at,recorded_by_user_id,gold_trade_line_id)
        VALUES (:id,:batchId,:assayer,'92.50000000','PERCENT',:observedAt,:actor,:lineId)`, {
        id: randomUUID(), batchId: batchB, assayer: sellerPartyId, observedAt: tradeDate, actor: sellerPerson, lineId: priorLineId,
      }), sqlError('23514'));
      await assert.rejects(db(`INSERT INTO material_measurement(id,measurement_set_id,measurement_kind,quantity_g,source_value,source_unit_code,conversion_version,source_role,source_party_id,entered_by_user_id,occurred_at_claimed)
        VALUES (:id,:setId,'DECLARED','0.010000','10.000','mg','canonical-mass-v1','SELLER',:source,:actor,:occurredAt)`, {
        id: randomUUID(), setId: supersededMeasurementSet.id, source: sellerPartyId, actor: sellerPerson, occurredAt: tradeDate,
      }), sqlError('23514'));
      assert.deepEqual(await observationCounts(priorLineId), { measurements: 0, assays: 0 });
    });
  });

  await t.test('append-only per-aggregate audit chains verify sequence, payload, and concurrent appends', async () => {
    const streamId = randomUUID();
    await Promise.all(Array.from({ length: 12 }, (_, index) => sequelize.transaction(async (transaction) => {
      await appendAuditEvent({ transaction, eventType: 'TEST.SYNTHETIC_EVENT', actorUserId: ids.siteUserId, actorPartyId: ids.siteUserPartyId, occurredAt: new Date(happenedAt), payload: { test_index: index }, streams: [{ kind: 'synthetic_test_stream', id: streamId }] });
    })));
    const rows = await readAuditStream('synthetic_test_stream', streamId);
    assert.deepEqual(rows.map((row) => Number(row.sequence)), Array.from({ length: 12 }, (_, index) => index + 1));
    assert.equal((await verifyAuditStream('synthetic_test_stream', streamId)).valid, true);
    const tampered = rows.map((row) => ({ ...row }));
    tampered[4].canonical_payload = '{"test_index":999}';
    assert.equal(verifyAuditEntries(tampered).valid, false);
    const [entry] = await db(`SELECT audit_event_id FROM audit_stream_entry WHERE stream_kind='synthetic_test_stream' AND stream_id=:streamId LIMIT 1`, { streamId }, undefined, QueryTypes.SELECT);
    await assert.rejects(db(`UPDATE audit_event SET event_type='CHANGED' WHERE id=:id`, { id: entry.audit_event_id }), sqlError('55000'));
    await assert.rejects(db(`DELETE FROM audit_stream_entry WHERE audit_event_id=:id`, { id: entry.audit_event_id }), sqlError('55000'));
  });

  await t.test('database checkpoints are scoped, immutable, retryable, and distinguish covered history from the unanchored tail', async () => {
    const postCheckpoint = (streams, clientMutationId = randomUUID(), token = ids.siteToken) => request(app)
      .post('/api/v1/audit/checkpoints').set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', clientMutationId).send({ clientMutationId, streams });
    const siteStream = { streamKind: 'mining_site', streamId: ids.siteId };
    const holeStream = { streamKind: 'mining_hole', streamId: ids.holeId };

    const denied = await postCheckpoint([siteStream], randomUUID(), ids.phaseThree.recoveryToken);
    assert.equal(denied.status, 404, denied.text);
    assert.equal((await request(app).get(`/api/v1/sites/${ids.siteId}`).set('Authorization', `Bearer ${ids.siteToken}`)).status, 200);
    const [authorizedSiteHead] = await db(`SELECT last_sequence FROM audit_stream_head WHERE stream_kind='mining_site' AND stream_id=:id`, { id: ids.siteId }, undefined, QueryTypes.SELECT);
    assert.ok(authorizedSiteHead?.last_sequence, 'the authorized site must have an existing audit stream head');
    const discoveredSiteStreams = await request(app).get('/api/v1/audit/streams').set('Authorization', `Bearer ${ids.siteToken}`);
    assert.equal(discoveredSiteStreams.status, 200, discoveredSiteStreams.text);
    assert.ok(discoveredSiteStreams.body.some((stream) => stream.streamKind === 'mining_site' && stream.streamId === ids.siteId));
    const isolatedStreams = await request(app).get('/api/v1/audit/streams').set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`);
    assert.equal(isolatedStreams.status, 200, isolatedStreams.text);
    assert.equal(isolatedStreams.body.some((stream) => stream.streamKind === 'mining_site' && stream.streamId === ids.siteId), false);

    const oneKey = randomUUID();
    const created = await postCheckpoint([siteStream], oneKey);
    assert.equal(created.status, 202, created.text);
    assert.equal(created.body.databaseState, 'ACCEPTED');
    assert.equal(created.body.processing.status, 'PENDING');
    assert.equal(created.body.externalCommitment, 'NOT_IMPLEMENTED');
    assert.equal(created.body.checkpoint.streams.length, 1);
    const visibleHistory = await request(app).get('/api/v1/audit/checkpoints').set('Authorization', `Bearer ${ids.siteToken}`);
    assert.equal(visibleHistory.status, 200, visibleHistory.text);
    assert.ok(visibleHistory.body.some((checkpoint) => checkpoint.id === created.body.checkpoint.id));
    const hiddenHistory = await request(app).get('/api/v1/audit/checkpoints').set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`);
    assert.equal(hiddenHistory.status, 200, hiddenHistory.text);
    assert.equal(hiddenHistory.body.some((checkpoint) => checkpoint.id === created.body.checkpoint.id), false);
    const duplicate = await postCheckpoint([siteStream], oneKey);
    assert.equal(duplicate.status, 202, duplicate.text);
    assert.equal(duplicate.body.checkpoint.id, created.body.checkpoint.id);
    const collision = await postCheckpoint([siteStream, holeStream], oneKey);
    assert.equal(collision.status, 409, collision.text);
    assert.equal(collision.body.error.code, 'IDEMPOTENCY_KEY_REUSED');

    const multi = await postCheckpoint([holeStream, siteStream]);
    assert.equal(multi.status, 202, multi.text);
    assert.equal(multi.body.checkpoint.streams.length, 2);
    assert.deepEqual(multi.body.checkpoint.streams.map((row) => row.streamKind), ['mining_hole', 'mining_site']);

    const concurrentStreams = [siteStream, holeStream];
    const concurrentAppend = sequelize.transaction(async (transaction) => appendAuditEvent({
      transaction, eventType: 'TEST.CHECKPOINT_CONCURRENT_APPEND', actorUserId: ids.siteUserId,
      actorPartyId: ids.siteUserPartyId, occurredAt: new Date(happenedAt), payload: { synthetic: true },
      streams: [{ kind: 'mining_site', id: ids.siteId }],
    }));
    const [racingCheckpoint, appendResult] = await Promise.all([postCheckpoint(concurrentStreams), concurrentAppend]);
    assert.equal(racingCheckpoint.status, 202, racingCheckpoint.text);
    assert.ok(appendResult.id);

    const checkpointId = created.body.checkpoint.id;
    await assert.rejects(db(`UPDATE audit_checkpoint SET provenance='{}'::jsonb WHERE id=:id`, { id: checkpointId }), sqlError('55000'));
    await assert.rejects(db(`DELETE FROM audit_checkpoint WHERE id=:id`, { id: checkpointId }), sqlError('55000'));
    await assert.rejects(db(`UPDATE audit_checkpoint_stream SET sequence=sequence+1 WHERE checkpoint_id=:id`, { id: checkpointId }), sqlError('55000'));
    await assert.rejects(db(`DELETE FROM audit_checkpoint_stream WHERE checkpoint_id=:id`, { id: checkpointId }), sqlError('55000'));
    await assert.rejects(db(`DELETE FROM audit_checkpoint_outbox WHERE checkpoint_id=:id`, { id: checkpointId }), sqlError('55000'));

    const abandonedClaim = await claimAuditCheckpoint(multi.body.checkpoint.id, { leaseMs: 1 });
    assert.ok(abandonedClaim);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const recovered = await processAuditCheckpoint(multi.body.checkpoint.id);
    assert.deepEqual(recovered, { processed: true, checkpointId: multi.body.checkpoint.id, outcome: 'VERIFIED' });
    const duplicateExecution = await processAuditCheckpoint(multi.body.checkpoint.id);
    assert.deepEqual(duplicateExecution, { processed: false });
    const multiState = await request(app).get(`/api/v1/audit/checkpoints/${multi.body.checkpoint.id}`).set('Authorization', `Bearer ${ids.siteToken}`);
    assert.equal(multiState.status, 200, multiState.text);
    assert.equal(multiState.body.processing.status, 'VERIFIED');
    assert.equal(multiState.body.processing.attemptCount, 2);
    assert.equal(multiState.body.processing.verification.checkpointStatus, 'VERIFIED');
    assert.equal(JSON.stringify(multiState.body).includes('canonical_payload'), false);
    assert.equal(JSON.stringify(multiState.body).includes('payload_salt'), false);

    const retryFailed = await processAuditCheckpoint(racingCheckpoint.body.checkpoint.id, {
      verifier: async () => { const error = new Error('simulated temporary storage interruption'); error.code = 'TEMPORARY_FAILURE'; throw error; },
    });
    assert.equal(retryFailed.outcome, 'RETRY');
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    const retrySucceeded = await processAuditCheckpoint(racingCheckpoint.body.checkpoint.id);
    assert.equal(retrySucceeded.outcome, 'VERIFIED');
    const [retryHistory] = await db(`SELECT array_agg(outcome ORDER BY attempt_number) AS outcomes FROM audit_checkpoint_verification WHERE checkpoint_id=:id`, { id: racingCheckpoint.body.checkpoint.id }, undefined, QueryTypes.SELECT);
    assert.deepEqual(retryHistory.outcomes, ['RETRYABLE_FAILURE', 'VERIFIED']);

    const invalidCheckpoint = await postCheckpoint([holeStream]);
    assert.equal(invalidCheckpoint.status, 202, invalidCheckpoint.text);
    const rejectedVerification = await processAuditCheckpoint(invalidCheckpoint.body.checkpoint.id, {
      verifier: async () => ({ checkpointStatus: 'VERIFIED', manifestStatus: 'VALID', streams: [{
        streamKind: 'mining_hole', streamId: ids.holeId, currentHeadStatus: 'MISMATCH', tailStatus: 'INVALID',
      }], externalCommitment: 'NOT_IMPLEMENTED' }),
    });
    assert.equal(rejectedVerification.outcome, 'INVALID');
    const invalidState = await request(app).get(`/api/v1/audit/checkpoints/${invalidCheckpoint.body.checkpoint.id}`).set('Authorization', `Bearer ${ids.siteToken}`);
    assert.equal(invalidState.body.processing.status, 'INVALID');

    const checkpointRow = (await db(`SELECT id,created_by_user_id,created_at,provenance,manifest_version,manifest_hash FROM audit_checkpoint WHERE id=:id`, { id: checkpointId }, undefined, QueryTypes.SELECT))[0];
    const checkpointStreams = await db(`SELECT stream_kind,stream_id,sequence,encode(head_hash,'hex') AS head_hash FROM audit_checkpoint_stream WHERE checkpoint_id=:id ORDER BY stream_kind,stream_id`, { id: checkpointId }, undefined, QueryTypes.SELECT);
    await sequelize.transaction(async (transaction) => appendAuditEvent({
      transaction, eventType: 'TEST.CHECKPOINT_UNANCHORED_TAIL', actorUserId: ids.siteUserId,
      actorPartyId: ids.siteUserPartyId, occurredAt: new Date(happenedAt), payload: { tail: 'original' },
      streams: [{ kind: 'mining_site', id: ids.siteId }],
    }));
    const siteRows = await readAuditStream('mining_site', ids.siteId);
    const [siteHead] = await db(`SELECT last_sequence,encode(head_hash,'hex') AS head_hash FROM audit_stream_head WHERE stream_kind='mining_site' AND stream_id=:id`, { id: ids.siteId }, undefined, QueryTypes.SELECT);
    const originalSnapshot = { streamKind: 'mining_site', streamId: ids.siteId, rows: siteRows, head: { last_sequence: Number(siteHead.last_sequence), head_hash: siteHead.head_hash } };
    const baseline = verifyCheckpointSnapshot({ checkpoint: checkpointRow, checkpointStreams, snapshots: [originalSnapshot] });
    assert.equal(baseline.checkpointStatus, 'VERIFIED');
    assert.equal(baseline.streams[0].tailStatus, 'UNANCHORED');
    assert.ok(baseline.streams[0].tailEntries >= 1);

    const changedPayloadRows = siteRows.map((row) => ({ ...row }));
    changedPayloadRows[0].canonical_payload = '{"tampered":true}';
    assert.equal(verifyCheckpointSnapshot({ checkpoint: checkpointRow, checkpointStreams, snapshots: [{ ...originalSnapshot, rows: changedPayloadRows }] }).checkpointStatus, 'INVALID');
    const deletedRows = siteRows.filter((row) => Number(row.sequence) !== 1);
    assert.equal(verifyCheckpointSnapshot({ checkpoint: checkpointRow, checkpointStreams, snapshots: [{ ...originalSnapshot, rows: deletedRows }] }).checkpointStatus, 'INVALID');
    const reorderedRows = [...siteRows].reverse();
    assert.equal(verifyCheckpointSnapshot({ checkpoint: checkpointRow, checkpointStreams, snapshots: [{ ...originalSnapshot, rows: reorderedRows }] }).checkpointStatus, 'INVALID');

    const badManifest = { ...checkpointRow, manifest_hash: Buffer.alloc(32, 7) };
    assert.equal(verifyCheckpointSnapshot({ checkpoint: badManifest, checkpointStreams, snapshots: [originalSnapshot] }).manifestStatus, 'INVALID');
    const wrongCoveredHead = checkpointStreams.map((stream) => ({ ...stream, head_hash: 'ff'.repeat(32) }));
    const forgedCoveredCheckpoint = { ...checkpointRow, manifest_hash: checkpointManifestHash(checkpointRow, wrongCoveredHead) };
    assert.equal(verifyCheckpointSnapshot({ checkpoint: forgedCoveredCheckpoint, checkpointStreams: wrongCoveredHead, snapshots: [originalSnapshot] }).checkpointStatus, 'INVALID');
    const wrongCurrentHead = { ...originalSnapshot, head: { ...originalSnapshot.head, head_hash: 'ee'.repeat(32) } };
    const headResult = verifyCheckpointSnapshot({ checkpoint: checkpointRow, checkpointStreams, snapshots: [wrongCurrentHead] });
    assert.equal(headResult.checkpointStatus, 'VERIFIED');
    assert.equal(headResult.streams[0].currentHeadStatus, 'MISMATCH');
    assert.equal(headResult.streams[0].tailStatus, 'INVALID');

    const rewrittenTailRows = siteRows.map((row) => ({ ...row }));
    const checkpointSequence = Number(checkpointStreams[0].sequence);
    let rewrittenTailHash = checkpointStreams[0].head_hash;
    const tailEntries = rewrittenTailRows.filter((row) => Number(row.sequence) > checkpointSequence);
    assert.ok(tailEntries.length >= 1, 'the added event should be beyond the checkpoint sequence');
    for (const [index, rewrittenTail] of tailEntries.entries()) {
      rewrittenTail.canonical_payload = JSON.stringify({ tail: `rewritten by database operator ${index + 1}` });
      rewrittenTail.payload_salt = randomBytes(32).toString('hex');
      rewrittenTail.payload_commitment = hashPayload(rewrittenTail.canonical_payload, Buffer.from(rewrittenTail.payload_salt, 'hex')).toString('hex');
      rewrittenTail.previous_hash = rewrittenTailHash;
      rewrittenTail.entry_hash = hashStreamEntry({
        stream_kind: rewrittenTail.stream_kind, stream_id: rewrittenTail.stream_id, sequence: Number(rewrittenTail.sequence),
        previous_hash: rewrittenTailHash, payload_commitment: rewrittenTail.payload_commitment,
      }).toString('hex');
      rewrittenTailHash = rewrittenTail.entry_hash;
    }
    const rewrittenHead = { ...originalSnapshot, rows: rewrittenTailRows, head: { last_sequence: Number(siteHead.last_sequence), head_hash: rewrittenTailHash } };
    const rewrittenTailResult = verifyCheckpointSnapshot({ checkpoint: checkpointRow, checkpointStreams, snapshots: [rewrittenHead] });
    assert.equal(rewrittenTailResult.checkpointStatus, 'VERIFIED');
    assert.equal(rewrittenTailResult.streams[0].tailStatus, 'UNANCHORED');

    const oneState = await request(app).get(`/api/v1/audit/checkpoints/${checkpointId}`).set('Authorization', `Bearer ${ids.siteToken}`);
    assert.equal(oneState.status, 200, oneState.text);
    assert.equal(oneState.body.liveVerification.streams[0].tailStatus, 'UNANCHORED');
    assert.equal(oneState.body.liveVerification.streams[0].coveredSequence, Number(checkpointStreams[0].sequence));
    assert.equal(oneState.body.liveVerification.streams[0].tailEntries, 2);
    const unauthorizedRead = await request(app).get(`/api/v1/audit/checkpoints/${checkpointId}`).set('Authorization', `Bearer ${ids.phaseThree.recoveryToken}`);
    assert.equal(unauthorizedRead.status, 404, unauthorizedRead.text);

    const temporaryReader = await seedUser(`checkpoint-reader-${randomUUID()}@example.test`, 'Checkpoint Reader', {
      roleCode: 'FIELD_OFFICER', scopeKind: 'SITE', scopeId: ids.siteId,
    });
    const temporaryToken = testToken(temporaryReader.userId);
    const temporaryCheckpoint = await postCheckpoint([siteStream], randomUUID(), temporaryToken);
    assert.equal(temporaryCheckpoint.status, 202, temporaryCheckpoint.text);
    const revokedReaderRole = await request(app).post(`/api/v1/admin/role-assignments/${temporaryReader.roleAssignmentId}/revoke`)
      .set('Authorization', `Bearer ${ids.adminToken}`).set('Idempotency-Key', randomUUID()).send({});
    assert.equal(revokedReaderRole.status, 200, revokedReaderRole.text);
    const revokedReaderRead = await request(app).get(`/api/v1/audit/checkpoints/${temporaryCheckpoint.body.checkpoint.id}`)
      .set('Authorization', `Bearer ${temporaryToken}`);
    assert.equal(revokedReaderRead.status, 404, revokedReaderRead.text);

    const rollbackEleven = await readFile(new URL('../src/database/rollback/011_audit_checkpoints.sql', import.meta.url), 'utf8');
    await assert.rejects(sequelize.transaction(async (transaction) => sequelize.query(rollbackEleven, { transaction, raw: true })), /cannot roll back audit checkpoints/);
  });

  await t.test('role revocation takes effect immediately and event writes roll back together', async () => {
    const revoked = await request(app).post(`/api/v1/admin/role-assignments/${ids.siteRoleId}/revoke`).set('Authorization', `Bearer ${ids.adminToken}`).set('Idempotency-Key', randomUUID()).send({});
    assert.equal(revoked.status, 200, revoked.text);
    const stillSignedIn = await request(app).get(`/api/v1/sites/${ids.siteId}`).set('Authorization', `Bearer ${ids.siteToken}`);
    assert.equal(stillSignedIn.status, 403);
    const [before] = await db(`SELECT count(*)::int AS total FROM material_event`, {}, undefined, QueryTypes.SELECT);
    const invalid = await request(app).post(`/api/v1/sites/${ids.siteId}/production-events`).set('Authorization', `Bearer ${ids.pilotToken}`).set('Idempotency-Key', randomUUID()).send({ holeId: randomUUID(), occurredAt: happenedAt, outputs: [{ materialKind: 'RESIDUE' }] });
    assert.equal(invalid.status, 400);
    const [after] = await db(`SELECT count(*)::int AS total FROM material_event`, {}, undefined, QueryTypes.SELECT);
    assert.equal(after.total, before.total);
  });
});
