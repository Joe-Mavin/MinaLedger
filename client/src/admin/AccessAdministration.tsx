import { useEffect, useMemo, useRef, useState, type Dispatch, type FormEvent, type SetStateAction } from 'react';
import { apiRequest, type HoleReference, type SiteReference } from '../api';
import { WorkspaceHeading } from '../AppShell';

export interface RegisteredOrganization {
  partyId: string;
  displayName: string;
  organisationKind: string;
}

export interface SessionAdminAccount {
  id: string;
  personPartyId: string;
  email: string;
  displayName: string;
  organisationPartyId: string;
  assignments: CreatedRoleAssignment[];
}

interface CreatedRoleAssignment {
  id: string;
  roleCode: string;
  scopeKind: string;
  scopeId: string;
  status: 'ACTIVE' | 'REVOKED';
}

interface ResourceOption {
  id: string;
  label: string;
}

interface MutationIdentity {
  signature: string;
  id: string;
}

const SYSTEM_ROLES = [
  'SYSTEM_ADMIN', 'FIELD_OFFICER', 'MINING_OPERATOR', 'MINER', 'DORA_OPERATOR',
  'RECOVERY_FACILITY_OPERATOR', 'LOCAL_MERCHANT', 'LARGER_MERCHANT', 'AUDITOR',
];
const NO_SCOPES: string[] = [];

const ROLE_SCOPES: Record<string, string[]> = {
  SYSTEM_ADMIN: ['GLOBAL'],
  FIELD_OFFICER: ['PILOT', 'SITE'],
  MINING_OPERATOR: ['SITE', 'HOLE'],
  MINER: ['HOLE'],
  DORA_OPERATOR: ['FACILITY'],
  RECOVERY_FACILITY_OPERATOR: ['FACILITY'],
  LOCAL_MERCHANT: ['ORGANISATION'],
  LARGER_MERCHANT: ['ORGANISATION'],
  AUDITOR: ['SITE', 'HOLE', 'FACILITY'],
};

function readable(value: string): string {
  return value.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function mutationIdentity(previous: MutationIdentity | null, payload: unknown): MutationIdentity {
  const signature = JSON.stringify(payload);
  return previous?.signature === signature ? previous : { signature, id: crypto.randomUUID() };
}

export function AccessAdministration({ token, ownRoles, sites, organizations, accounts, setAccounts, onOrganizationCreated }: {
  token: string;
  ownRoles: Array<{ roleCode: string; scopeKind: string; scopeId: string }>;
  sites: SiteReference[];
  organizations: RegisteredOrganization[];
  accounts: SessionAdminAccount[];
  setAccounts: Dispatch<SetStateAction<SessionAdminAccount[]>>;
  onOrganizationCreated: (organization: RegisteredOrganization) => void;
}) {
  const [view, setView] = useState<'accounts' | 'organizations'>('accounts');
  const [accountName, setAccountName] = useState('');
  const [accountEmail, setAccountEmail] = useState('');
  const [accountPassword, setAccountPassword] = useState('');
  const [accountOrganization, setAccountOrganization] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [organizationKind, setOrganizationKind] = useState('');
  const [selectedRole, setSelectedRole] = useState('FIELD_OFFICER');
  const [selectedScope, setSelectedScope] = useState('PILOT');
  const [selectedScopeId, setSelectedScopeId] = useState('default');
  const [holes, setHoles] = useState<ResourceOption[]>([]);
  const [facilities, setFacilities] = useState<ResourceOption[]>([]);
  const [resourcesLoading, setResourcesLoading] = useState(false);
  const [resourcesError, setResourcesError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const accountMutation = useRef<MutationIdentity | null>(null);
  const organizationMutation = useRef<MutationIdentity | null>(null);
  const assignmentMutations = useRef<Record<string, MutationIdentity | undefined>>({});
  const revokeMutations = useRef<Record<string, MutationIdentity | undefined>>({});

  const allowedScopes = ROLE_SCOPES[selectedRole] ?? NO_SCOPES;
  const scopeResources = useMemo((): ResourceOption[] => {
    if (selectedScope === 'GLOBAL') return [{ id: 'global', label: 'Global system administration' }];
    if (selectedScope === 'PILOT') return [{ id: 'default', label: 'Default pilot' }];
    if (selectedScope === 'SITE') return sites.map((site) => ({ id: site.id, label: `${site.name} · ${site.siteCode}` }));
    if (selectedScope === 'HOLE') return holes;
    if (selectedScope === 'FACILITY') return selectedRole === 'RECOVERY_FACILITY_OPERATOR' ? [] : facilities;
    if (selectedScope === 'ORGANISATION') return organizations.map((organization) => ({ id: organization.partyId, label: `${organization.displayName} · ${organization.organisationKind}` }));
    return [];
  }, [selectedScope, selectedRole, sites, holes, facilities, organizations]);

  useEffect(() => {
    let active = true;
    setResourcesLoading(true);
    setResourcesError('');
    void Promise.all([
      ...sites.map(async (site) => ({ site, rows: await apiRequest<HoleReference[]>(`/api/v1/sites/${site.id}/holes`, token) })),
      ...sites.map(async (site) => ({ site, rows: await apiRequest<Array<{ id: string; name: string }>>(`/api/v1/sites/${site.id}/doras`, token) })),
    ]).then((results) => {
      if (!active) return;
      const holeRows = results.slice(0, sites.length).flatMap((result) => result.rows as HoleReference[]);
      const facilityRows = results.slice(sites.length).flatMap((result) => result.rows as Array<{ id: string; name: string }>);
      setHoles(holeRows.map((hole) => ({ id: hole.id, label: `${hole.holeCode} · ${sites.find((site) => site.id === hole.siteId)?.siteCode ?? 'Site'}` })));
      setFacilities(facilityRows.map((facility) => ({ id: facility.id, label: `${facility.name} · ${facility.id}` })));
    }).catch((loadError) => {
      if (active) setResourcesError(loadError instanceof Error ? loadError.message : 'Valid resource scopes could not be loaded.');
    }).finally(() => { if (active) setResourcesLoading(false); });
    return () => { active = false; };
  }, [sites, token]);

  useEffect(() => {
    if (!allowedScopes.includes(selectedScope)) setSelectedScope(allowedScopes[0] ?? '');
  }, [allowedScopes, selectedScope]);

  useEffect(() => {
    if (selectedScope === 'GLOBAL') setSelectedScopeId('global');
    else if (selectedScope === 'PILOT') setSelectedScopeId('default');
    else if (!scopeResources.some((resource) => resource.id === selectedScopeId)) setSelectedScopeId(scopeResources[0]?.id ?? '');
  }, [selectedScope, selectedScopeId, scopeResources]);

  async function createOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = { displayName: organizationName.trim(), organisationKind: organizationKind.trim() };
    const identity = mutationIdentity(organizationMutation.current, body);
    organizationMutation.current = identity;
    setBusy(true); setError(''); setMessage('');
    try {
      const created = await apiRequest<RegisteredOrganization>('/api/v1/admin/organisations', token, { method: 'POST', headers: { 'Idempotency-Key': identity.id }, body: JSON.stringify(body) });
      onOrganizationCreated(created);
      setOrganizationName(''); setOrganizationKind(''); organizationMutation.current = null;
      setMessage(`Organization registered: ${created.displayName}. The existing API does not provide a persistent organization directory.`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Organization registration failed. Retry the unchanged request if its result is uncertain.');
    } finally { setBusy(false); }
  }

  async function createAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = { displayName: accountName.trim(), email: accountEmail.trim(), password: accountPassword, ...(accountOrganization ? { organisationPartyId: accountOrganization } : {}) };
    const identity = mutationIdentity(accountMutation.current, body);
    accountMutation.current = identity;
    setBusy(true); setError(''); setMessage('');
    try {
      const created = await apiRequest<Omit<SessionAdminAccount, 'assignments' | 'organisationPartyId'> & { organisationPartyId?: string }>('/api/v1/admin/users', token, { method: 'POST', headers: { 'Idempotency-Key': identity.id }, body: JSON.stringify(body) });
      setAccounts((current) => [{ ...created, organisationPartyId: accountOrganization, assignments: [] }, ...current]);
      setAccountName(''); setAccountEmail(''); setAccountPassword(''); setAccountOrganization(''); accountMutation.current = null;
      setMessage(`Login account created for ${created.displayName}. No participant record was created automatically.`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Account creation failed. Retry the unchanged request if its result is uncertain.');
    } finally { setBusy(false); }
  }

  async function assignRole(account: SessionAdminAccount) {
    setError(''); setMessage('');
    if (account.assignments.some((assignment) => assignment.status === 'ACTIVE' && assignment.roleCode === selectedRole && assignment.scopeKind === selectedScope && assignment.scopeId === selectedScopeId)) {
      setError('This account already has that active role assignment in the current session.');
      return;
    }
    if (selectedScope === 'ORGANISATION' && account.organisationPartyId !== selectedScopeId) {
      setError('The account must have an active membership in the exact organization selected for its role scope. Select that organization when creating the account.');
      return;
    }
    if (!selectedScopeId || !scopeResources.some((resource) => resource.id === selectedScopeId)) {
      setError('Select a valid scope returned by the authorized API. No arbitrary scope IDs can be submitted.');
      return;
    }
    const body = { roleCode: selectedRole, scopeKind: selectedScope, scopeId: selectedScopeId };
    const identity = mutationIdentity(assignmentMutations.current[account.id] ?? null, body);
    assignmentMutations.current[account.id] = identity;
    setBusy(true);
    try {
      const created = await apiRequest<CreatedRoleAssignment & { userId: string }>(`/api/v1/admin/users/${account.id}/roles`, token, { method: 'POST', headers: { 'Idempotency-Key': identity.id }, body: JSON.stringify(body) });
      setAccounts((current) => current.map((row) => row.id === account.id ? { ...row, assignments: [...row.assignments, { ...created, status: 'ACTIVE' }] } : row));
      assignmentMutations.current[account.id] = undefined;
      setMessage(`${readable(created.roleCode)} assigned at ${readable(created.scopeKind)} scope. The server validated the target and scope.`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Role assignment failed. The server remains authoritative for role-scope validity.');
    } finally { setBusy(false); }
  }

  async function revokeRole(accountId: string, assignment: CreatedRoleAssignment) {
    if (!window.confirm(`Revoke ${readable(assignment.roleCode)} at ${readable(assignment.scopeKind)} scope? This removes the grant from future authenticated requests.`)) return;
    const body = { assignmentId: assignment.id };
    const identity = mutationIdentity(revokeMutations.current[assignment.id] ?? null, body);
    revokeMutations.current[assignment.id] = identity;
    setBusy(true); setError(''); setMessage('');
    try {
      await apiRequest(`/api/v1/admin/role-assignments/${assignment.id}/revoke`, token, { method: 'POST', headers: { 'Idempotency-Key': identity.id } });
      setAccounts((current) => current.map((account) => account.id === accountId ? { ...account, assignments: account.assignments.map((row) => row.id === assignment.id ? { ...row, status: 'REVOKED' } : row) } : account));
      revokeMutations.current[assignment.id] = undefined;
      setMessage(`${readable(assignment.roleCode)} grant revoked. The append-only server history remains intact.`);
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : 'Role revocation failed.');
    } finally { setBusy(false); }
  }

  return (
    <div className="admin-workspace">
      <WorkspaceHeading eyebrow="ACCESS AND ORGANIZATIONS" title="Access administration" description="Create accounts and grant only server-validated roles. Organization and account directories are not available from the current API." />
      {error && <div className="notice error" role="alert">{error}</div>}
      {message && <div className="notice success" role="status">{message}</div>}
      <nav className="admin-tabs" aria-label="Administration sections">
        <button type="button" className={view === 'accounts' ? 'selected' : ''} aria-current={view === 'accounts' ? 'page' : undefined} onClick={() => setView('accounts')}>Accounts and roles</button>
        <button type="button" className={view === 'organizations' ? 'selected' : ''} aria-current={view === 'organizations' ? 'page' : undefined} onClick={() => setView('organizations')}>Organizations</button>
      </nav>

      {view === 'organizations' && <>
        <section className="queue-section" aria-labelledby="organization-register-heading">
          <div className="section-heading"><div><p className="eyebrow">ORGANIZATION REGISTER</p><h2 id="organization-register-heading">Register an organization</h2></div></div>
          <p className="notice info">The backend supports organization creation but has no authorized organization-list, detail, or membership-list endpoint. The records below are only those created during this active app session; they are not presented as a complete directory.</p>
          <form className="form-grid" onSubmit={createOrganization}>
            <label>Organization name<input value={organizationName} onChange={(event) => setOrganizationName(event.target.value)} maxLength={160} required /></label>
            <label>Organization kind<input value={organizationKind} onChange={(event) => setOrganizationKind(event.target.value)} maxLength={40} required /></label>
            <p className="field-note span-two">Registering an organization does not label it a cooperative, assign site rights, add members, or create participant relationships.</p>
            <div className="form-actions span-two"><button className="primary" type="submit" disabled={busy}>{busy ? 'Registering…' : 'Register organization'}</button></div>
          </form>
        </section>
        <section className="queue-section" aria-labelledby="session-organizations-heading">
          <div className="section-heading"><div><p className="eyebrow">SESSION-CREATED ONLY</p><h2 id="session-organizations-heading">Organizations created in this session <span className="count">{organizations.length}</span></h2></div></div>
          {organizations.length === 0 ? <div className="empty-state">No organization was created in this session. Existing organizations cannot be listed until the API exposes an authorized directory.</div> : <div className="created-record-list">{organizations.map((organization) => <article className="created-record" key={organization.partyId}><div><strong>{organization.displayName}</strong><span>{readable(organization.organisationKind)}</span><code>{organization.partyId}</code></div></article>)}</div>}
        </section>
      </>}

      {view === 'accounts' && <>
        <section className="queue-section" aria-labelledby="current-grants-heading">
          <div className="section-heading"><div><p className="eyebrow">SIGNED-IN ADMINISTRATOR</p><h2 id="current-grants-heading">Your active role assignments</h2></div></div>
          {ownRoles.length === 0 ? <div className="empty-state">No active grants were returned by the authenticated profile endpoint.</div> : <ul className="grant-list">{ownRoles.map((role) => <li key={`${role.roleCode}:${role.scopeKind}:${role.scopeId}`}><strong>{readable(role.roleCode)}</strong><span>{readable(role.scopeKind)} · {role.scopeId}</span></li>)}</ul>}
          <p className="registry-policy">This is the signed-in account’s profile only. The API does not expose an account directory or role-assignment IDs for other users.</p>
        </section>
        <section className="queue-section" aria-labelledby="account-create-heading">
          <div className="section-heading"><div><p className="eyebrow">NEW LOGIN IDENTITY</p><h2 id="account-create-heading">Create account</h2></div></div>
          <p className="notice info">A login account is a separate identity from a site/hole participant. This form does not create a participant, relationship, entitlement, or role grant automatically.</p>
          <form className="form-grid" onSubmit={createAccount}>
            <label>Display name<input value={accountName} onChange={(event) => setAccountName(event.target.value)} maxLength={160} required /></label>
            <label>Email address<input type="email" autoComplete="off" value={accountEmail} onChange={(event) => setAccountEmail(event.target.value)} maxLength={320} required /></label>
            <label>Initial password<input type="password" autoComplete="new-password" value={accountPassword} onChange={(event) => setAccountPassword(event.target.value)} minLength={12} maxLength={72} required /><small>At least 12 characters. It is sent to the API and not saved in this browser.</small></label>
            <label>Organization membership, if required<select value={accountOrganization} onChange={(event) => setAccountOrganization(event.target.value)}><option value="">No organization membership</option>{organizations.map((organization) => <option value={organization.partyId} key={organization.partyId}>{organization.displayName}</option>)}</select></label>
            <p className="field-note span-two">Organization memberships can be selected only from organizations created in this app session because the existing API does not provide a directory.</p>
            <div className="form-actions span-two"><button className="primary" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button></div>
          </form>
        </section>
        {accounts.map((account) => <section className="queue-section" aria-labelledby={`account-${account.id}`} key={account.id}>
          <div className="section-heading"><div><p className="eyebrow">CREATED THIS SESSION</p><h2 id={`account-${account.id}`}>{account.displayName}</h2></div></div>
          <p className="queue-meta">Email {account.email} · user ID <code>{account.id}</code> · person party ID <code>{account.personPartyId}</code></p>
          <p className="queue-meta">Organization membership: {account.organisationPartyId || 'None recorded'}</p>
          <div className="admin-scope-picker">
            <label>System role<select value={selectedRole} onChange={(event) => { const value = event.target.value; setSelectedRole(value); setSelectedScope(ROLE_SCOPES[value]?.[0] ?? ''); setSelectedScopeId(''); }}>{SYSTEM_ROLES.map((role) => <option value={role} key={role}>{readable(role)}</option>)}</select></label>
            <label>Authorization scope<select value={selectedScope} onChange={(event) => setSelectedScope(event.target.value)}>{allowedScopes.map((scope) => <option value={scope} key={scope}>{readable(scope)}</option>)}</select></label>
            {selectedScope === 'GLOBAL' || selectedScope === 'PILOT' ? <label>Scope value<input value={selectedScope === 'GLOBAL' ? 'global' : 'default'} readOnly /></label> : <label>Authorized resource<select value={selectedScopeId} onChange={(event) => setSelectedScopeId(event.target.value)} disabled={resourcesLoading || scopeResources.length === 0} required><option value="">{resourcesLoading ? 'Loading scopes…' : scopeResources.length === 0 ? 'No valid scope is available' : 'Choose an API-returned resource'}</option>{scopeResources.map((resource) => <option value={resource.id} key={resource.id}>{resource.label}</option>)}</select></label>}
            <button className="secondary" type="button" onClick={() => void assignRole(account)} disabled={busy || (selectedScope !== 'GLOBAL' && selectedScope !== 'PILOT' && !selectedScopeId) || (selectedScope === 'ORGANISATION' && account.organisationPartyId !== selectedScopeId) || (selectedRole === 'RECOVERY_FACILITY_OPERATOR' && scopeResources.length === 0)}>{busy ? 'Working…' : 'Assign role'}</button>
          </div>
          {resourcesError && <p className="field-note">Some resources could not be loaded: {resourcesError}</p>}
          {['SITE', 'HOLE', 'FACILITY'].includes(selectedScope) && scopeResources.length === 0 && selectedRole !== 'RECOVERY_FACILITY_OPERATOR' && <p className="notice info">No authorized resource is available to select. The current API has no system-administrator directory for all sites, holes or facilities; this form does not accept hand-entered scope IDs.</p>}
          {selectedRole === 'RECOVERY_FACILITY_OPERATOR' && <p className="notice warning">Recovery facility listing is unavailable in the backend. This interface cannot safely choose a recovery scope, so assignment is disabled.</p>}
          <h3 className="subheading">Role assignments returned during this session</h3>
          {account.assignments.length === 0 ? <div className="empty-state">No role assignment has been made for this new account in this session.</div> : <ul className="grant-list">{account.assignments.map((assignment) => <li key={assignment.id}><strong>{readable(assignment.roleCode)}</strong><span>{readable(assignment.scopeKind)} · {assignment.scopeId} · {assignment.status.toLowerCase()}</span>{assignment.status === 'ACTIVE' && <button className="small-button danger-button" type="button" onClick={() => void revokeRole(account.id, assignment)} disabled={busy}>Revoke grant</button>}</li>)}</ul>}
          <p className="registry-policy">The API does not list assignments for existing accounts. Only grants created in this session have an assignment ID here and can be revoked from this screen.</p>
        </section>)}
      </>}
    </div>
  );
}
