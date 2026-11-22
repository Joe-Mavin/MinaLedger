export type WorkspaceSection = 'overview' | 'capture' | 'queue' | 'audit' | 'registry' | 'access' | 'production' | 'operations';

export interface NavigationItem {
  id: WorkspaceSection;
  label: string;
  description: string;
}

const BASE_NAVIGATION: NavigationItem[] = [
  { id: 'overview', label: 'Overview', description: 'Authorized site references and this recorder’s local work.' },
  { id: 'queue', label: 'My command queue', description: 'Offline commands belonging to this recorder.' },
];

const REGISTRY_SCOPES: Record<string, string[]> = {
  FIELD_OFFICER: ['PILOT', 'SITE', 'ORGANISATION'],
  MINING_OPERATOR: ['SITE', 'ORGANISATION'],
  AUDITOR: ['SITE', 'ORGANISATION'],
};

const PRODUCTION_READ_SCOPES: Record<string, string[]> = {
  FIELD_OFFICER: ['PILOT', 'SITE', 'ORGANISATION'],
  MINING_OPERATOR: ['SITE', 'ORGANISATION'],
  MINER: ['SITE', 'ORGANISATION'],
  AUDITOR: ['SITE', 'ORGANISATION'],
};

const OPERATIONS_SCOPES: Record<string, string[]> = {
  FIELD_OFFICER: ['PILOT', 'SITE', 'ORGANISATION', 'HOLE'],
  MINING_OPERATOR: ['SITE', 'ORGANISATION', 'HOLE'],
  MINER: ['SITE', 'ORGANISATION', 'HOLE'],
  DORA_OPERATOR: ['FACILITY', 'ORGANISATION'],
  RECOVERY_FACILITY_OPERATOR: ['FACILITY', 'ORGANISATION'],
  AUDITOR: ['SITE', 'ORGANISATION', 'FACILITY'],
};

const CAPTURE_ROLES = new Set([
  'FIELD_OFFICER',
  'MINING_OPERATOR',
  'MINER',
  'DORA_OPERATOR',
  'RECOVERY_FACILITY_OPERATOR',
  'LOCAL_MERCHANT',
  'LARGER_MERCHANT',
]);

const AUDIT_ROLES = new Set([
  'FIELD_OFFICER',
  'MINING_OPERATOR',
  'MINER',
  'DORA_OPERATOR',
  'RECOVERY_FACILITY_OPERATOR',
  'LOCAL_MERCHANT',
  'LARGER_MERCHANT',
  'AUDITOR',
]);

export function getNavigationItems(roleCode: string | undefined, scopeKind?: string, scopeId?: string): NavigationItem[] {
  const items = [...BASE_NAVIGATION];
  if (roleCode === 'SYSTEM_ADMIN' && scopeKind === 'GLOBAL' && scopeId === 'global') {
    items.splice(1, 0, { id: 'access', label: 'Access administration', description: 'Create accounts, organizations and supported role grants.' });
  }
  if (roleCode && CAPTURE_ROLES.has(roleCode)) {
    items.splice(1, 0, { id: 'capture', label: 'Field capture', description: 'Prepare an allowlisted command for the server.' });
  }
  if (roleCode && scopeKind && REGISTRY_SCOPES[roleCode]?.includes(scopeKind)) {
    items.splice(1, 0, { id: 'registry', label: 'Registry', description: 'Review authorized sites, holes and recorded participants.' });
  }
  if (roleCode && scopeKind && PRODUCTION_READ_SCOPES[roleCode]?.includes(scopeKind)) {
    items.splice(1, 0, { id: 'production', label: 'Production', description: 'Review production events, material outputs and proposed allocations.' });
  }
  if (roleCode && scopeKind && OPERATIONS_SCOPES[roleCode]?.includes(scopeKind)) {
    items.splice(1, 0, { id: 'operations', label: 'Material operations', description: 'Inspect Dora processing, residue inventory, consignments, custody and recovery.' });
  }
  if (roleCode && AUDIT_ROLES.has(roleCode)) {
    items.push({ id: 'audit', label: 'Audit evidence', description: 'Create and verify checkpoints for authorized streams.' });
  }
  return items;
}
