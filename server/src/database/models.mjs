import { DataTypes } from 'sequelize';
import { sequelize } from './connection.mjs';

const commonId = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };
const createdAt = { type: DataTypes.DATE, field: 'created_at', allowNull: false, defaultValue: DataTypes.NOW };

export const Party = sequelize.define('party', {
  id: commonId,
  partyKind: { type: DataTypes.STRING(20), field: 'party_kind', allowNull: false },
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'ACTIVE' },
  createdAt,
}, { tableName: 'party' });

export const PersonProfile = sequelize.define('person_profile', {
  partyId: { type: DataTypes.UUID, primaryKey: true, field: 'party_id' },
  displayName: { type: DataTypes.STRING(160), field: 'display_name', allowNull: false },
}, { tableName: 'person_profile' });

export const OrganisationProfile = sequelize.define('organisation_profile', {
  partyId: { type: DataTypes.UUID, primaryKey: true, field: 'party_id' },
  displayName: { type: DataTypes.STRING(160), field: 'display_name', allowNull: false },
  organisationKind: { type: DataTypes.STRING(40), field: 'organisation_kind', allowNull: false },
}, { tableName: 'organisation_profile' });

export const UserAccount = sequelize.define('user_account', {
  id: { ...commonId },
  personPartyId: { type: DataTypes.UUID, field: 'person_party_id', allowNull: false, unique: true },
  email: { type: DataTypes.STRING(320), allowNull: false, unique: true },
  passwordHash: { type: DataTypes.STRING(100), field: 'password_hash', allowNull: false },
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'ACTIVE' },
  createdAt,
}, { tableName: 'user_account', defaultScope: { attributes: { exclude: ['passwordHash'] } } });

export const OrganisationMembership = sequelize.define('organisation_membership', {
  id: { ...commonId },
  personPartyId: { type: DataTypes.UUID, field: 'person_party_id', allowNull: false },
  organisationPartyId: { type: DataTypes.UUID, field: 'organisation_party_id', allowNull: false },
  membershipType: { type: DataTypes.STRING(40), field: 'membership_type', allowNull: false },
  validFrom: { type: DataTypes.DATE, field: 'valid_from', allowNull: false, defaultValue: DataTypes.NOW },
  validTo: { type: DataTypes.DATE, field: 'valid_to' },
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'ACTIVE' },
  createdAt,
}, { tableName: 'organisation_membership' });

export const RoleAssignment = sequelize.define('role_assignment', {
  id: { ...commonId },
  userId: { type: DataTypes.UUID, field: 'user_id', allowNull: false },
  roleCode: { type: DataTypes.STRING(40), field: 'role_code', allowNull: false },
  scopeKind: { type: DataTypes.STRING(30), field: 'scope_kind', allowNull: false },
  scopeId: { type: DataTypes.STRING(80), field: 'scope_id', allowNull: false },
  grantedByUserId: { type: DataTypes.UUID, field: 'granted_by_user_id' },
  validFrom: { type: DataTypes.DATE, field: 'valid_from', allowNull: false, defaultValue: DataTypes.NOW },
  validTo: { type: DataTypes.DATE, field: 'valid_to' },
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'ACTIVE' },
  createdAt,
}, { tableName: 'role_assignment' });

export const MiningSite = sequelize.define('mining_site', {
  id: commonId,
  siteCode: { type: DataTypes.STRING(80), field: 'site_code', allowNull: false, unique: true },
  name: { type: DataTypes.STRING(160), allowNull: false },
  countyCode: { type: DataTypes.STRING(80), field: 'county_code' },
  locality: { type: DataTypes.STRING(160) },
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'ACTIVE' },
  createdByUserId: { type: DataTypes.UUID, field: 'created_by_user_id', allowNull: false },
  createdAt,
}, { tableName: 'mining_site' });

export const MiningHole = sequelize.define('mining_hole', {
  id: commonId,
  siteId: { type: DataTypes.UUID, field: 'site_id', allowNull: false },
  holeCode: { type: DataTypes.STRING(80), field: 'hole_code', allowNull: false },
  name: { type: DataTypes.STRING(160) },
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'ACTIVE' },
  createdAt,
}, { tableName: 'mining_hole' });

export const MaterialBatch = sequelize.define('material_batch', {
  id: commonId,
  batchCode: { type: DataTypes.STRING(100), field: 'batch_code', allowNull: false, unique: true },
  materialKind: { type: DataTypes.STRING(40), field: 'material_kind', allowNull: false },
  currentStatus: { type: DataTypes.STRING(20), field: 'current_status', allowNull: false, defaultValue: 'ACTIVE' },
  createdAt,
}, { tableName: 'material_batch' });

export const MaterialEvent = sequelize.define('material_event', {
  id: commonId,
  eventCode: { type: DataTypes.STRING(100), field: 'event_code', allowNull: false, unique: true },
  eventKind: { type: DataTypes.STRING(30), field: 'event_kind', allowNull: false },
  occurredAtClaimed: { type: DataTypes.DATE, field: 'occurred_at_claimed', allowNull: false },
  recordedAt: { type: DataTypes.DATE, field: 'recorded_at', allowNull: false, defaultValue: DataTypes.NOW },
  responsiblePartyId: { type: DataTypes.UUID, field: 'responsible_party_id', allowNull: false },
  actorUserId: { type: DataTypes.UUID, field: 'actor_user_id', allowNull: false },
  currentStatus: { type: DataTypes.STRING(20), field: 'current_status', allowNull: false, defaultValue: 'SUBMITTED' },
  schemaVersion: { type: DataTypes.INTEGER, field: 'schema_version', allowNull: false, defaultValue: 1 },
  notesRef: { type: DataTypes.STRING(255), field: 'notes_ref' },
  supersedesEventId: { type: DataTypes.UUID, field: 'supersedes_event_id' },
  createdAt,
}, { tableName: 'material_event' });

export const ProductionEvent = sequelize.define('production_event', {
  eventId: { type: DataTypes.UUID, primaryKey: true, field: 'event_id' },
  holeId: { type: DataTypes.UUID, field: 'hole_id', allowNull: false },
  shiftOrPeriodRef: { type: DataTypes.STRING(100), field: 'shift_or_period_ref' },
}, { tableName: 'production_event' });

MiningSite.hasMany(MiningHole, { foreignKey: 'siteId', as: 'holes' });
MiningHole.belongsTo(MiningSite, { foreignKey: 'siteId', as: 'site' });
Party.hasOne(PersonProfile, { foreignKey: 'partyId', as: 'personProfile' });
Party.hasOne(OrganisationProfile, { foreignKey: 'partyId', as: 'organisationProfile' });
UserAccount.belongsTo(Party, { foreignKey: 'personPartyId', as: 'person' });

export const models = {
  Party, PersonProfile, OrganisationProfile, UserAccount, OrganisationMembership,
  RoleAssignment, MiningSite, MiningHole, MaterialBatch, MaterialEvent, ProductionEvent,
};
