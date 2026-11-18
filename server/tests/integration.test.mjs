import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import bcrypt from 'bcryptjs';

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
const { appendAuditEvent, readAuditStream, verifyAuditEntries, verifyAuditStream } = await import('../src/modules/audit/audit.service.mjs');
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

async function signIn(email, secret = password) {
  const response = await request(app).post('/api/v1/auth/login').send({ email, password: secret });
  assert.equal(response.status, 200, response.text);
  return response.body.token;
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
  ids.adminToken = await signIn('admin@example.test');
  ids.pilotToken = await signIn('pilot@example.test');
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
  await t.test('Phase 2 integrity migration rolls back and reapplies before its new participant kinds are used', async () => {
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
  });

  await t.test('health, password authentication, live roles, and profile serialization', async () => {
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
    ids.siteToken = await signIn('site-recorder@example.test');

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
    ids.orgToken = await signIn('organisation-recorder@example.test');
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

  await t.test('hole-scoped access stays within assigned holes across nested endpoints', async () => {
    ids.holeB1Id = randomUUID();
    await db(`INSERT INTO mining_hole(id,site_id,hole_code,name) VALUES (:id,:siteId,'HOLE-B1','Third fictional hole')`, { id: ids.holeB1Id, siteId: ids.siteBId });

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
    const holeA1Token = await signIn('hole-a1-recorder@example.test');
    const holeB1User = await seedUser('hole-b1-recorder@example.test', 'Fictional Hole B1 Recorder', {
      roleCode: 'FIELD_OFFICER', scopeKind: 'HOLE', scopeId: ids.holeB1Id,
    });
    const holeB1Token = await signIn('hole-b1-recorder@example.test');

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
    assert.equal(siteWideEvents.status, 403);
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
    const siteAuditor = await seedUser('site-auditor@example.test', 'Fictional Site Auditor', {
      roleCode: 'AUDITOR', scopeKind: 'SITE', scopeId: ids.siteId,
    });
    const siteAuditorToken = await signIn('site-auditor@example.test');
    ids.siteAuditorToken = siteAuditorToken;
    assert.equal((await request(app).get(`/api/v1/sites/${ids.siteId}/production-events/${holeA2Event.id}`).set('Authorization', `Bearer ${siteAuditorToken}`)).status, 200);
    const auditorWrite = await request(app).post(`/api/v1/sites/${ids.siteId}/production-events/${holeA2Event.id}/outputs/${holeA2Output.id}/measurements`)
      .set('Authorization', `Bearer ${siteAuditorToken}`).set('Idempotency-Key', randomUUID()).send(measurementInput);
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
    await db(`INSERT INTO role_assignment(id,user_id,role_code,scope_kind,scope_id) VALUES (:id,:userId,'FIELD_OFFICER','HOLE',:holeId)`, {
      id: randomUUID(), userId: doraUser.userId, holeId: ids.holeId,
    });
    ids.doraWeigherPartyId = await seedParty('PERSON', 'Fictional Dora Weigher');
    await db(`INSERT INTO facility_party_role(id,processing_facility_id,party_id,role_code,valid_from,asserted_by_user_id) VALUES (:id,:facilityId,:partyId,'WEIGHER','2026-11-01T00:00:00.000Z',:actor)`, {
      id: randomUUID(), facilityId: ids.doraOneId, partyId: ids.doraWeigherPartyId, actor: ids.siteUserId,
    });
    ids.doraToken = await signIn('dora-operator@example.test');
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
    assert.equal(processReplay.body.replayed, true);
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
    assert.equal(resolved.body.origins[0].processing_facility_id, ids.doraOneId);

    const secondDoraUser = await seedUser('other-dora-operator@example.test', 'Fictional Other Dora Operator', {
      roleCode: 'DORA_OPERATOR', scopeKind: 'FACILITY', scopeId: ids.doraTwoId,
    });
    await db(`INSERT INTO role_assignment(id,user_id,role_code,scope_kind,scope_id) VALUES (:id,:userId,'FIELD_OFFICER','HOLE',:holeId)`, {
      id: randomUUID(), userId: secondDoraUser.userId, holeId: ids.holeId,
    });
    const secondDoraToken = await signIn('other-dora-operator@example.test');
    const deniedFacilityCreate = await request(app).post(`/api/v1/material-batches/${ids.processingOutputs[1].batchId}/qr`)
      .set('Authorization', `Bearer ${secondDoraToken}`).set('Idempotency-Key', randomUUID()).send({});
    const deniedFacilityRotate = await request(app).post(`/api/v1/material-batches/${ids.processingOutputs[1].batchId}/qr/rotate`)
      .set('Authorization', `Bearer ${secondDoraToken}`).set('Idempotency-Key', randomUUID()).send({});
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

    const siteOperator = await seedUser('site-mining-operator@example.test', 'Fictional Site Mining Operator', {
      roleCode: 'MINING_OPERATOR', scopeKind: 'SITE', scopeId: ids.siteId,
    });
    const siteOperatorToken = await signIn('site-mining-operator@example.test');
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
    const holeToken = await signIn('hole-qr-operator@example.test');
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
    const otherSiteToken = await signIn('other-site-qr-operator@example.test');
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
    await createOpeningBalance(ids.batchId, commercialLocation, '10.000000');
    const buyerPartyId = ids.organisationId;
    const sellerPartyId = ids.minerPartyId;
    const tradeId = randomUUID();
    const tradeLineId = randomUUID();
    const tradeMeasurementSetId = randomUUID();
    const tradeMeasurementId = randomUUID();
    await sequelize.transaction(async (transaction) => {
      await db(`INSERT INTO gold_trade(id,trade_code,trade_kind,buyer_party_id,seller_party_id,agreed_at,currency_code) VALUES (:id,'FICTIONAL-TRADE','PURCHASE',:buyer,:seller,:at,'USD')`, { id: tradeId, buyer: buyerPartyId, seller: sellerPartyId, at: happenedAt }, transaction);
      await db(`INSERT INTO gold_trade_line(id,trade_id,batch_id,revision_no,revision_kind,transaction_quantity_g,accepted_trade_quantity_g,is_accepted) VALUES (:id,:tradeId,:batchId,1,'ORIGINAL','2.000000','2.000000',true)`, { id: tradeLineId, tradeId, batchId: ids.batchId }, transaction);
      await db(`INSERT INTO material_measurement_set(id,batch_id,gold_trade_line_id) VALUES (:id,:batchId,:lineId)`, { id: tradeMeasurementSetId, batchId: ids.batchId, lineId: tradeLineId }, transaction);
      await db(`INSERT INTO material_measurement(id,measurement_set_id,measurement_kind,quantity_g,source_value,source_unit_code,conversion_version,source_role,source_party_id,entered_by_user_id,occurred_at_claimed) VALUES (:id,:setId,'MEASURED','2.000000','2','g','test-v1','SELLER',:partyId,:userId,:at)`, { id: tradeMeasurementId, setId: tradeMeasurementSetId, partyId: sellerPartyId, userId: ids.siteUserId, at: happenedAt }, transaction);
    });
    const overCap = await createMeasuredConsignment(ids.batchId, '3.000000', 'TRADE-OVER-CAP');
    await assert.rejects(postTransfer({ lines: [
      { ...overCap.out, locationId: commercialLocation, goldTradeLineId: tradeLineId }, overCap.in,
    ], occurredAt: happenedAt }, { userId: ids.siteUserId, personPartyId: ids.siteUserPartyId }, randomUUID()));
    const [netOut] = await db(`SELECT COALESCE(sum(posted_quantity_g),0)::NUMERIC(20,6) AS quantity_g FROM inventory_movement_line ml JOIN inventory_movement m ON m.id=ml.inventory_movement_id WHERE m.current_status='ACCEPTED' AND ml.gold_trade_line_id=:lineId`, { lineId: tradeLineId }, undefined, QueryTypes.SELECT);
    assert.equal(netOut.quantity_g, '0.000000');

    const acceptedConsignment = await createMeasuredConsignment(ids.batchId, '2.000000', 'TRADE-ACCEPTED');
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
        outId: randomUUID(), inId: randomUUID(), movementId: reversalId, batchId: ids.batchId,
        sourceId: originalOut.location_id, destinationId: originalIn.location_id,
        originalOut: originalOut.id, originalIn: originalIn.id,
      }, transaction);
      await db(`UPDATE inventory_movement SET current_status='ACCEPTED' WHERE id=:id`, { id: reversalId }, transaction);
      await db('SET CONSTRAINTS ALL IMMEDIATE', {}, transaction);
    });

    const correctionId = randomUUID();
    await db(`UPDATE gold_trade_line SET is_accepted=false WHERE id=:id`, { id: tradeLineId });
    await assert.rejects(sequelize.transaction(async (transaction) => {
      await db(`INSERT INTO gold_trade_line(id,trade_id,batch_id,revision_no,revision_kind,transaction_quantity_g,accepted_trade_quantity_g,is_accepted,supersedes_line_id,correction_reason)
        VALUES (:id,:tradeId,:batchId,2,'CORRECTION','0.500000','0.500000',true,:previousId,'Lowered acceptance test')`, {
        id: randomUUID(), tradeId, batchId: ids.batchId, previousId: tradeLineId,
      }, transaction);
    }), sqlError('23514'));
    const correctionMeasurementSetId = randomUUID();
    await sequelize.transaction(async (transaction) => {
      await db(`INSERT INTO gold_trade_line(id,trade_id,batch_id,revision_no,revision_kind,transaction_quantity_g,accepted_trade_quantity_g,is_accepted,supersedes_line_id,correction_reason)
        VALUES (:id,:tradeId,:batchId,2,'CORRECTION','1.000000','1.000000',true,:previousId,'Accepted quantity corrected after partial reversal')`, {
        id: correctionId, tradeId, batchId: ids.batchId, previousId: tradeLineId,
      }, transaction);
      await db(`INSERT INTO material_measurement_set(id,batch_id,gold_trade_line_id) VALUES (:id,:batchId,:lineId)`, { id: correctionMeasurementSetId, batchId: ids.batchId, lineId: correctionId }, transaction);
      await db(`INSERT INTO material_measurement(id,measurement_set_id,measurement_kind,quantity_g,source_value,source_unit_code,conversion_version,source_role,source_party_id,entered_by_user_id,occurred_at_claimed)
        VALUES (:id,:setId,'MEASURED','1.000000','1','g','test-v1','SELLER',:partyId,:userId,:at)`, {
        id: randomUUID(), setId: correctionMeasurementSetId, partyId: sellerPartyId, userId: ids.siteUserId, at: happenedAt,
      }, transaction);
    });
    const postCorrectionOverCap = await createMeasuredConsignment(ids.batchId, '1.500000', 'TRADE-CORRECTION-OVER-CAP');
    await assert.rejects(postTransfer({ lines: [
      { ...postCorrectionOverCap.out, locationId: commercialLocation, goldTradeLineId: correctionId }, postCorrectionOverCap.in,
    ], occurredAt: happenedAt }, { userId: ids.siteUserId, personPartyId: ids.siteUserPartyId }, randomUUID()), sqlError('23514'));

    const commercialBalances = await db(`SELECT location_id,quantity_g FROM inventory_balance WHERE batch_id=:batchId AND location_id IN (:sourceId,:destinationId) ORDER BY location_id`, {
      batchId: ids.batchId, sourceId: commercialLocation, destinationId: acceptedConsignment.transitLocationId,
    }, undefined, QueryTypes.SELECT);
    assert.equal(commercialBalances.find((row) => row.location_id === commercialLocation).quantity_g, '9.000000');
    assert.equal(commercialBalances.find((row) => row.location_id === acceptedConsignment.transitLocationId).quantity_g, '1.000000');
    await assert.rejects(db(`UPDATE gold_trade SET currency_code='KES' WHERE id=:id`, { id: tradeId }), sqlError('55000'));
    await assert.rejects(db(`INSERT INTO payment(id,gold_trade_id,currency_code,payer_party_id,payee_party_id) VALUES (:id,:tradeId,'KES',:buyer,:seller)`, { id: randomUUID(), tradeId, buyer: buyerPartyId, seller: sellerPartyId }), sqlError('23503'));
    await assert.rejects(db(`INSERT INTO payment(id,gold_trade_id,currency_code,payer_party_id,payee_party_id) VALUES (:id,:tradeId,'USD',:unrelated,:seller)`, { id: randomUUID(), tradeId, unrelated: ids.adminPartyId, seller: sellerPartyId }), sqlError('23514'));
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
