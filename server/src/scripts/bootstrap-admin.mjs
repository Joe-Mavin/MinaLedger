import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../database/connection.mjs';
import { appendAuditEvent } from '../modules/audit/audit.service.mjs';
import { logger } from '../config/logger.mjs';

const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
const displayName = process.env.BOOTSTRAP_ADMIN_DISPLAY_NAME?.trim();
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;

if (!email || !displayName || !password || Buffer.byteLength(password, 'utf8') < 12 || Buffer.byteLength(password, 'utf8') > 72) {
  throw new Error('Set BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_DISPLAY_NAME and a 12-72 byte BOOTSTRAP_ADMIN_PASSWORD.');
}

try {
  const created = await sequelize.transaction(async (transaction) => {
    await sequelize.query(`SELECT pg_advisory_xact_lock(hashtextextended('minaledger:bootstrap-admin', 0))`, { transaction });
    const [count] = await sequelize.query(`SELECT count(*)::int AS total FROM user_account`, { type: QueryTypes.SELECT, transaction });
    if (count.total !== 0) throw new Error('Bootstrap is allowed only before the first account exists.');
    const partyId = randomUUID();
    const userId = randomUUID();
    const passwordHash = await bcrypt.hash(password, 12);
    await sequelize.query(`INSERT INTO party(id,party_kind) VALUES (:partyId,'PERSON')`, { replacements: { partyId }, transaction });
    await sequelize.query(`INSERT INTO person_profile(party_id,display_name) VALUES (:partyId,:displayName)`, { replacements: { partyId, displayName }, transaction });
    await sequelize.query(`INSERT INTO user_account(id,person_party_id,email,password_hash) VALUES (:userId,:partyId,:email,:passwordHash)`, { replacements: { userId, partyId, email, passwordHash }, transaction });
    await sequelize.query(`INSERT INTO role_assignment(id,user_id,role_code,scope_kind,scope_id) VALUES (:id,:userId,'SYSTEM_ADMIN','GLOBAL','global')`, { replacements: { id: randomUUID(), userId }, transaction });
    await appendAuditEvent({ transaction, eventType: 'IDENTITY.BOOTSTRAP_ADMIN_CREATED', actorUserId: userId, actorPartyId: partyId, occurredAt: new Date(), payload: { user_id: userId, bootstrap: true }, streams: [{ kind: 'user_account', id: userId }] });
    return userId;
  });
  logger.info({ userId: created }, 'initial administrative account created');
} catch (error) {
  logger.error({ errorName: error.name, errorCode: error.original?.code }, 'administrative bootstrap failed');
  process.exitCode = 1;
} finally {
  delete process.env.BOOTSTRAP_ADMIN_PASSWORD;
  await sequelize.close();
}
