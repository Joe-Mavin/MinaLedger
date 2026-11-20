export type WorkspaceSection = 'overview' | 'capture' | 'queue' | 'audit';

export interface NavigationItem {
  id: WorkspaceSection;
  label: string;
  description: string;
}

const BASE_NAVIGATION: NavigationItem[] = [
  { id: 'overview', label: 'Overview', description: 'Authorized site references and this recorder’s local work.' },
  { id: 'queue', label: 'My command queue', description: 'Offline commands belonging to this recorder.' },
];

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

export function getNavigationItems(roleCode: string | undefined): NavigationItem[] {
  const items = [...BASE_NAVIGATION];
  if (roleCode && CAPTURE_ROLES.has(roleCode)) {
    items.splice(1, 0, { id: 'capture', label: 'Field capture', description: 'Prepare an allowlisted command for the server.' });
  }
  if (roleCode && AUDIT_ROLES.has(roleCode)) {
    items.push({ id: 'audit', label: 'Audit evidence', description: 'Create and verify checkpoints for authorized streams.' });
  }
  return items;
}
