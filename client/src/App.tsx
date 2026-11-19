import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { apiRequest, getHoleParticipants, getHoles, getSites, type HoleParticipantReference, type HoleReference, type SiteReference } from './api';
import { applyReceipt, clearReferenceCache, getReferenceCache, listCommands, saveReferenceCache, updateCommand } from './offline/database';
import { createEnvelope, queueCommand, recoverInterruptedUploads, saveDraft } from './offline/commands';
import { synchronizeCommands } from './offline/sync';
import type { ActingContext, CommandType, QueuedCommand, SyncState } from './offline/types';

interface RoleGrant {
  roleCode: string;
  scopeKind: string;
  scopeId: string;
}

interface Recorder {
  id: string;
  personPartyId: string;
  displayName: string;
  roles: RoleGrant[];
}

const STATE_LABELS: Record<SyncState, string> = {
  draft: 'Draft saved on this device',
  pending_upload: 'Waiting to upload',
  uploading: 'Uploading',
  server_received: 'Server received; awaiting a final result',
  needs_review: 'Received; review required',
  server_accepted: 'Accepted by server',
  conflict: 'Conflict; original preserved',
  rejected: 'Rejected; original preserved',
};

function normalizedRoles(rows: Array<Record<string, string>> = []): RoleGrant[] {
  return rows.map((row) => ({
    roleCode: row.roleCode ?? row.role_code,
    scopeKind: row.scopeKind ?? row.scope_kind,
    scopeId: String(row.scopeId ?? row.scope_id),
  }));
}

function roleKey(role: RoleGrant): string {
  return `${role.roleCode}:${role.scopeKind}:${role.scopeId}`;
}

function localDateTimeNow(): string {
  const date = new Date();
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function occurrenceIso(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Enter a valid occurrence time.');
  return date.toISOString();
}

async function loginRequest(email: string, password: string): Promise<{ token: string; user: Omit<Recorder, 'roles'>; roles: Array<Record<string, string>> }> {
  const response = await fetch(`${import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001'}/api/v1/auth/login`, {
    method: 'POST', cache: 'no-store', credentials: 'omit',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  const body = await response.json() as { token?: string; user?: Omit<Recorder, 'roles'>; roles?: Array<Record<string, string>>; error?: { message?: string } };
  if (!response.ok || !body.token || !body.user) throw new Error(body.error?.message ?? 'Sign-in failed.');
  return { token: body.token, user: body.user, roles: body.roles ?? [] };
}

function tokenIsUnexpired(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/'))) as { exp?: number };
    return Number(payload.exp) * 1000 > Date.now();
  } catch { return false; }
}

function localContextKey(context: ActingContext): string {
  return `${context.roleCode}:${context.scopeKind}:${context.scopeId}:${context.partyId}`;
}

export default function App() {
  const [recorder, setRecorder] = useState<Recorder | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [online, setOnline] = useState(navigator.onLine);
  const [sites, setSites] = useState<SiteReference[]>([]);
  const [holes, setHoles] = useState<HoleReference[]>([]);
  const [participants, setParticipants] = useState<HoleParticipantReference[]>([]);
  const [commands, setCommands] = useState<QueuedCommand[]>([]);
  const [selectedRoleKey, setSelectedRoleKey] = useState('');
  const [siteId, setSiteId] = useState('');
  const [holeId, setHoleId] = useState('');
  const [commandType, setCommandType] = useState<CommandType>('production.create');
  const [occurredAt, setOccurredAt] = useState(localDateTimeNow);
  const [identityState, setIdentityState] = useState<'IDENTIFIED' | 'UNRESOLVED' | 'UNKNOWN'>('UNKNOWN');
  const [participantRelationshipId, setParticipantRelationshipId] = useState('');
  const [sourceKind, setSourceKind] = useState('DIRECT');
  const [sourceReference, setSourceReference] = useState('');
  const [evidenceReference, setEvidenceReference] = useState('');
  const [materialKind, setMaterialKind] = useState('GOLD_BEARING_FEED');
  const [eventId, setEventId] = useState('');
  const [outputId, setOutputId] = useState('');
  const [captureId, setCaptureId] = useState('');
  const [measurementKind, setMeasurementKind] = useState('MEASURED');
  const [quantityGrams, setQuantityGrams] = useState('');
  const [sourceValue, setSourceValue] = useState('');
  const [sourceUnit, setSourceUnit] = useState('g');
  const [conversionVersion, setConversionVersion] = useState('manual-v1');
  const [sourceRole, setSourceRole] = useState('RECORDER');
  const [measurementSourcePartyId, setMeasurementSourcePartyId] = useState('');
  const [ackStatus, setAckStatus] = useState('ACKNOWLEDGED');
  const [ackMethod, setAckMethod] = useState('IN_PERSON');
  const [ackReason, setAckReason] = useState('');
  const [parentIdsText, setParentIdsText] = useState('');
  const [revisionSource, setRevisionSource] = useState<QueuedCommand | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedRole = useMemo(() => recorder?.roles.find((role) => roleKey(role) === selectedRoleKey) ?? null, [recorder, selectedRoleKey]);
  const actingContext: ActingContext | null = useMemo(() => selectedRole && recorder ? {
    partyId: selectedRole.scopeKind === 'ORGANISATION' ? selectedRole.scopeId : recorder.personPartyId,
    roleCode: selectedRole.roleCode,
    scopeKind: selectedRole.scopeKind,
    scopeId: selectedRole.scopeId,
  } : null, [recorder, selectedRole]);
  const contextKey = actingContext ? localContextKey(actingContext) : '';

  const refreshCommands = useCallback(async (userId: string) => {
    await recoverInterruptedUploads(userId);
    setCommands(await listCommands(userId));
  }, []);

  const refreshReferences = useCallback(async (user: Recorder, accessToken: string, roleScope: string) => {
    const key = `sites:${user.id}:${roleScope}`;
    if (navigator.onLine) {
      try {
        const siteRows = await getSites(accessToken);
        setSites(siteRows);
        await saveReferenceCache({ key, recorderUserId: user.id, contextKey: roleScope, savedAt: new Date().toISOString(), value: siteRows });
        return;
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Could not refresh assigned sites.');
      }
    }
    const cached = await getReferenceCache<SiteReference[]>(key);
    if (cached?.recorderUserId === user.id) setSites(cached.value);
  }, []);

  const loadSiteHoles = useCallback(async (selectedSiteId: string, user: Recorder, accessToken: string, roleScope: string) => {
    if (!selectedSiteId) { setHoles([]); return; }
    const key = `holes:${user.id}:${roleScope}:${selectedSiteId}`;
    if (navigator.onLine) {
      try {
        const rows = await getHoles(selectedSiteId, accessToken);
        setHoles(rows);
        await saveReferenceCache({ key, recorderUserId: user.id, contextKey: `${roleScope}:site:${selectedSiteId}`, savedAt: new Date().toISOString(), value: rows });
        return;
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Could not refresh assigned holes.');
      }
    }
    const cached = await getReferenceCache<HoleReference[]>(key);
    setHoles(cached?.recorderUserId === user.id ? cached.value : []);
  }, []);

  const loadHoleParticipants = useCallback(async (selectedSiteId: string, selectedHoleId: string, user: Recorder, accessToken: string, roleScope: string) => {
    if (!selectedSiteId || !selectedHoleId) { setParticipants([]); return; }
    const key = `participants:${user.id}:${roleScope}:${selectedSiteId}:${selectedHoleId}`;
    if (navigator.onLine) {
      try {
        const rows = await getHoleParticipants(selectedSiteId, selectedHoleId, accessToken);
        setParticipants(rows);
        await saveReferenceCache({ key, recorderUserId: user.id, contextKey: `${roleScope}:hole:${selectedHoleId}`, savedAt: new Date().toISOString(), value: rows });
        return;
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Could not refresh participants for this hole.');
      }
    }
    const cached = await getReferenceCache<HoleParticipantReference[]>(key);
    setParticipants(cached?.recorderUserId === user.id ? cached.value : []);
  }, []);

  const activateSession = useCallback(async (user: Recorder, accessToken: string) => {
    setRecorder(user);
    setToken(accessToken);
    sessionStorage.setItem('minaledger.accessToken', accessToken);
    sessionStorage.setItem('minaledger.sessionUser', JSON.stringify(user));
    const preferredRole = user.roles.find((role) => ['FIELD_OFFICER', 'MINING_OPERATOR', 'MINER'].includes(role.roleCode)) ?? user.roles[0];
    let activeRoleKey = preferredRole ? roleKey(preferredRole) : '';
    try {
      const savedContext = JSON.parse(sessionStorage.getItem('minaledger.selectedContext') ?? 'null') as { recorderUserId?: string; siteId?: string; holeId?: string; roleKey?: string } | null;
      if (savedContext?.recorderUserId === user.id) {
        if (savedContext.siteId) setSiteId(savedContext.siteId);
        if (savedContext.holeId) setHoleId(savedContext.holeId);
        if (savedContext.roleKey && user.roles.some((role) => roleKey(role) === savedContext.roleKey)) activeRoleKey = savedContext.roleKey;
      }
    } catch { sessionStorage.removeItem('minaledger.selectedContext'); }
    setSelectedRoleKey(activeRoleKey);
    await Promise.all([refreshCommands(user.id), refreshReferences(user, accessToken, activeRoleKey || 'no-role')]);
  }, [refreshCommands, refreshReferences]);

  useEffect(() => {
    const onlineHandler = () => setOnline(true);
    const offlineHandler = () => setOnline(false);
    window.addEventListener('online', onlineHandler);
    window.addEventListener('offline', offlineHandler);
    const savedToken = sessionStorage.getItem('minaledger.accessToken');
    if (savedToken) {
      const cachedUserJson = sessionStorage.getItem('minaledger.sessionUser');
      if (!navigator.onLine && cachedUserJson && tokenIsUnexpired(savedToken)) {
        try { void activateSession(JSON.parse(cachedUserJson) as Recorder, savedToken); }
        catch { sessionStorage.removeItem('minaledger.accessToken'); sessionStorage.removeItem('minaledger.sessionUser'); }
      } else if (tokenIsUnexpired(savedToken)) {
        apiRequest<Record<string, unknown>>('/api/v1/me', savedToken).then(async (profile) => {
          const user: Recorder = {
            id: String(profile.id), personPartyId: String(profile.person_party_id), displayName: String(profile.display_name),
            roles: normalizedRoles((profile.roles as Array<Record<string, string>>) ?? []),
          };
          await activateSession(user, savedToken);
        }).catch(() => {
          sessionStorage.removeItem('minaledger.accessToken');
          sessionStorage.removeItem('minaledger.sessionUser');
          setToken(null);
        });
      } else {
        sessionStorage.removeItem('minaledger.accessToken');
        sessionStorage.removeItem('minaledger.sessionUser');
      }
    }
    return () => {
      window.removeEventListener('online', onlineHandler);
      window.removeEventListener('offline', offlineHandler);
    };
  }, [activateSession]);

  useEffect(() => {
    if (recorder && token) void loadSiteHoles(siteId, recorder, token, selectedRoleKey || 'no-role');
  }, [siteId, recorder, token, selectedRoleKey, loadSiteHoles]);

  useEffect(() => {
    if (recorder && token) void loadHoleParticipants(siteId, holeId, recorder, token, selectedRoleKey || 'no-role');
  }, [siteId, holeId, recorder, token, selectedRoleKey, loadHoleParticipants]);

  useEffect(() => {
    if (online && recorder && token) void synchronizeCommands(recorder.id, token).then(() => refreshCommands(recorder.id)).catch((syncError) => setError(syncError instanceof Error ? syncError.message : 'Sync could not start.'));
  }, [online, recorder, token, refreshCommands]);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await loginRequest(email, password);
      const user: Recorder = { ...result.user, roles: normalizedRoles(result.roles) };
      setPassword('');
      await activateSession(user, result.token);
      setMessage('Signed in. The server will recheck access when each queued command syncs.');
    } catch (signInError) {
      setError(signInError instanceof Error ? signInError.message : 'Sign-in failed.');
    } finally { setBusy(false); }
  }

  async function signOut() {
    sessionStorage.removeItem('minaledger.accessToken');
    sessionStorage.removeItem('minaledger.sessionUser');
    sessionStorage.removeItem('minaledger.selectedContext');
    await clearReferenceCache().catch(() => undefined);
    setToken(null); setRecorder(null); setSites([]); setHoles([]); setCommands([]); setSelectedRoleKey('');
    setMessage('Signed out. Local commands remain on this device and are scoped to their recorder.');
  }

  useEffect(() => {
    if (!token || !recorder) return undefined;
    let expiresAt = 0;
    try { expiresAt = Number(JSON.parse(atob(token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/'))).exp) * 1000; }
    catch { expiresAt = 0; }
    const timeout = Math.max(0, expiresAt - Date.now());
    const timer = window.setTimeout(() => {
      sessionStorage.removeItem('minaledger.accessToken');
      sessionStorage.removeItem('minaledger.sessionUser');
      void clearReferenceCache().catch(() => undefined);
      setToken(null); setRecorder(null); setSites([]); setHoles([]); setSelectedRoleKey('');
      setMessage('Session expired. Sign in again to continue; local commands are preserved.');
    }, timeout);
    return () => window.clearTimeout(timer);
  }, [token, recorder]);

  async function syncNow() {
    if (!recorder || !token) return;
    setBusy(true); setError('');
    try {
      await synchronizeCommands(recorder.id, token);
      await refreshCommands(recorder.id);
      setMessage('Sync check finished. Review each command state below.');
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : 'Sync could not finish.');
    } finally { setBusy(false); }
  }

  function participantFor(type: CommandType) {
    if (type === 'capture.acknowledgement.add') return { identityState: 'IDENTIFIED' as const, partyId: recorder?.personPartyId };
    const participant = participants.find((row) => row.relationship_id === participantRelationshipId);
    return { identityState, ...(identityState === 'IDENTIFIED' && participant ? { partyId: participant.party_id } : {}) };
  }

  async function createLocalCommand(state: 'draft' | 'pending_upload') {
    if (!recorder || !actingContext || !siteId) throw new Error('Choose an assigned role and site first.');
    const occurredAtIso = occurrenceIso(occurredAt);
    const identity = participantFor(commandType);
    if (identity.identityState === 'IDENTIFIED' && !identity.partyId) throw new Error('An identified participant needs a party ID.');
    let payload: unknown;
    let captureProvenance: unknown;
    let evidence: Array<{ reference: string }> = [];
    const currentHole = holes.find((row) => row.id === holeId);
    if (commandType === 'production.create') {
      if (!holeId) throw new Error('Choose an assigned hole.');
      const participant = participants.find((row) => row.relationship_id === participantRelationshipId);
      if (identityState === 'IDENTIFIED' && !participant) throw new Error('Select the actual participant from this hole’s authorized participant list, or mark identity unresolved/unknown.');
      const capture = {
        participantIdentityState: identityState,
        ...(identityState === 'IDENTIFIED' ? { actualParticipantPartyId: participant!.party_id } : {}),
        sourceKind,
        occurredAt: occurredAtIso,
        ...(sourceReference.trim() ? { sourceReference: sourceReference.trim() } : {}),
        ...(evidenceReference.trim() ? { evidenceRef: evidenceReference.trim() } : {}),
      };
      captureProvenance = capture;
      payload = { siteId, input: {
        holeId, occurredAt: occurredAtIso,
        ...(identityState === 'IDENTIFIED' ? { participantRelationshipIds: [participant!.relationship_id] } : {}),
        captureProvenance: capture, outputs: [{ materialKind, measurements: [] }],
      } };
      if (evidenceReference.trim()) evidence = [{ reference: evidenceReference.trim() }];
    } else if (commandType === 'production.measurement.add') {
      if (!eventId.trim() || !outputId.trim()) throw new Error('Enter the production event and output IDs.');
      payload = {
        siteId, eventId: eventId.trim(), outputId: outputId.trim(),
        input: {
          kind: measurementKind, quantityGrams: quantityGrams.trim(), sourceValue: sourceValue.trim(), sourceUnit: sourceUnit.trim(),
          conversionVersion: conversionVersion.trim(), sourceRole,
          ...(measurementSourcePartyId.trim() ? { sourcePartyId: measurementSourcePartyId.trim() } : {}),
          occurredAt: occurredAtIso, ...(evidenceReference.trim() ? { evidenceRef: evidenceReference.trim() } : {}),
        },
      };
      if (evidenceReference.trim()) evidence = [{ reference: evidenceReference.trim() }];
    } else {
      if (!eventId.trim() || !captureId.trim()) throw new Error('Enter the production event and capture provenance IDs.');
      payload = {
        siteId, eventId: eventId.trim(), captureProvenanceId: captureId.trim(),
        acknowledgement: {
          status: ackStatus,
          ...(ackStatus === 'ACKNOWLEDGED' ? { acknowledgedByPartyId: recorder.personPartyId } : {}),
          method: ackMethod, occurredAt: occurredAtIso, ...(ackReason.trim() ? { reason: ackReason.trim() } : {}),
        },
      };
    }
    const parentCommandIds = parentIdsText.split(',').map((part) => part.trim()).filter(Boolean);
    const revisionOf = revisionSource?.envelope.clientMutationId;
    const envelope = await createEnvelope({
      recorderUserId: recorder.id, actingContext, commandType, payload, occurredAtClaimed: occurredAtIso,
      actualParticipant: identity, captureProvenance, evidence, parentCommandIds,
      ...(commandType === 'production.create' && currentHole?.auditSequence !== undefined
        ? { expectedVersion: { streamKind: 'mining_hole' as const, streamId: holeId, sequence: currentHole.auditSequence } }
        : {}),
      ...(revisionOf ? { revisionOf, parentCommandIds: [...new Set([...parentCommandIds, revisionOf])] } : {}),
    });
    if (state === 'draft') await saveDraft(envelope, contextKey);
    else await queueCommand(envelope, contextKey);
    await refreshCommands(recorder.id);
    setMessage(state === 'draft' ? 'Draft saved locally. It has not been sent to the server.' : 'Command saved locally. Server authorization and acceptance are still pending.');
    setRevisionSource(null);
    if (state === 'pending_upload' && online && token) {
      await synchronizeCommands(recorder.id, token);
      await refreshCommands(recorder.id);
    }
  }

  async function handleCreate(state: 'draft' | 'pending_upload') {
    setBusy(true); setError(''); setMessage('');
    try { await createLocalCommand(state); }
    catch (createError) { setError(createError instanceof Error ? createError.message : 'Command could not be saved.'); }
    finally { setBusy(false); }
  }

  async function queueSavedDraft(command: QueuedCommand) {
    await updateCommand(command.envelope.clientMutationId, (current) => ({ ...current, state: 'pending_upload' }));
    if (recorder) await refreshCommands(recorder.id);
    if (online && token) await syncNow();
  }

  async function checkReceipt(command: QueuedCommand) {
    if (!token || !recorder) return;
    setBusy(true);
    try {
      const result = await apiRequest<{ receipt: QueuedCommand['receipt'] }>(`/api/v1/sync/receipts/${command.envelope.clientMutationId}`, token);
      if (result.receipt) await applyReceipt(command.envelope.clientMutationId, result.receipt);
      await refreshCommands(recorder.id);
    } catch (receiptError) { setError(receiptError instanceof Error ? receiptError.message : 'Receipt check failed.'); }
    finally { setBusy(false); }
  }

  function prepareLinkedRevision(command: QueuedCommand) {
    if (command.envelope.commandType !== 'production.create') return;
    const payload = command.envelope.payload as { siteId: string; input: { holeId: string; occurredAt: string; participantRelationshipIds?: string[]; captureProvenance: Record<string, string>; outputs: Array<{ materialKind: string }> } };
    const capture = payload.input.captureProvenance;
    setCommandType('production.create'); setSiteId(payload.siteId); setHoleId(payload.input.holeId);
    setOccurredAt(new Date(new Date(command.envelope.occurredAtClaimed).getTime() - new Date(command.envelope.occurredAtClaimed).getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
    setIdentityState((capture.participantIdentityState as 'IDENTIFIED' | 'UNRESOLVED' | 'UNKNOWN') ?? 'UNKNOWN');
    setParticipantRelationshipId(payload.input.participantRelationshipIds?.[0] ?? ''); setSourceKind(capture.sourceKind ?? 'DIRECT');
    setSourceReference(capture.sourceReference ?? ''); setEvidenceReference(capture.evidenceRef ?? '');
    setMaterialKind(payload.input.outputs[0]?.materialKind ?? 'GOLD_BEARING_FEED');
    setRevisionSource(command);
    setMessage('Edit the original facts, then queue a new linked command. The submitted record remains unchanged.');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  if (!recorder || !token) {
    return (
      <main className="login-shell">
        <section className="login-card" aria-labelledby="login-title">
          <div className="brand-mark" aria-hidden="true">M</div>
          <p className="eyebrow">KENYA FIELD CAPTURE</p>
          <h1 id="login-title">MinaLedger</h1>
          <p className="intro">Sign in while connected. Your short-lived session stays in this browser tab.</p>
          {!online && <div role="status" className="notice warning">Offline. Sign-in needs a connection; previously saved commands stay on this device.</div>}
          <form onSubmit={signIn} className="form-stack">
            <label>Email<input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
            <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
            {error && <p className="error" role="alert">{error}</p>}
            <button className="primary" type="submit" disabled={busy || !online}>{busy ? 'Signing in…' : 'Sign in'}</button>
          </form>
          <p className="fine-print">Offline commands are local reports, not accepted business events. The server checks current account and role access during sync.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark small">M</span><span>MinaLedger <small>FIELD</small></span></div>
        <div className="top-actions"><span className={`connection ${online ? 'online' : 'offline'}`} role="status"><i />{online ? 'Online' : 'Offline'}</span><button className="quiet" type="button" onClick={signOut}>Sign out</button></div>
      </header>
      <div className="workspace">
        <section className="welcome-row">
          <div><p className="eyebrow">FIELD WORKSPACE</p><h1>Good day, {recorder.displayName}</h1><p className="muted">Recorder: <strong>{recorder.id}</strong></p></div>
          <button className="secondary" onClick={syncNow} disabled={busy || !online}>{busy ? 'Working…' : 'Sync queue'}</button>
        </section>
        {!online && <div className="notice warning">Offline capture is available from cached site and hole references. Current authorization will be checked when the server receives each command.</div>}
        {error && <div className="notice error" role="alert">{error}</div>}
        {message && <div className="notice success" role="status">{message}</div>}

        <section className="context-panel" aria-label="Recorder and acting context">
          <div><span className="label">Authenticated recorder</span><strong>{recorder.displayName}</strong></div>
          <label className="context-select">Acting role and scope
            <select aria-label="Acting role and scope" value={selectedRoleKey} onChange={(event) => {
              const value = event.target.value; setSelectedRoleKey(value);
              if (recorder) sessionStorage.setItem('minaledger.selectedContext', JSON.stringify({ recorderUserId: recorder.id, siteId, holeId, roleKey: value }));
            }}>
              {recorder.roles.map((role) => <option key={roleKey(role)} value={roleKey(role)}>{role.roleCode.replaceAll('_', ' ')} · {role.scopeKind.toLowerCase()} {role.scopeId}</option>)}
            </select>
          </label>
          <div><span className="label">Local device</span><strong>Shared device · session only</strong></div>
        </section>

        <section className="capture-card" aria-labelledby="capture-heading">
          <div className="section-heading"><div><p className="eyebrow">NEW COMMAND</p><h2 id="capture-heading">Record field information</h2></div><span className="local-badge">Saved locally first</span></div>
          <div className="form-grid">
            <label>Command type<select value={commandType} onChange={(event) => setCommandType(event.target.value as CommandType)}>
              <option value="production.create">Production event</option>
              <option value="production.measurement.add">Output measurement</option>
              <option value="capture.acknowledgement.add">Participant response</option>
            </select></label>
            <label>Assigned site<select value={siteId} onChange={(event) => {
              const value = event.target.value; setSiteId(value); setHoleId('');
              if (recorder) sessionStorage.setItem('minaledger.selectedContext', JSON.stringify({ recorderUserId: recorder.id, siteId: value, holeId: '', roleKey: selectedRoleKey }));
            }} required>
              <option value="">Choose a site</option>{sites.map((site) => <option key={site.id} value={site.id}>{site.name} · {site.siteCode}</option>)}
            </select></label>
            <label>Claimed occurrence time<input type="datetime-local" value={occurredAt} onChange={(event) => setOccurredAt(event.target.value)} required /></label>
            {commandType === 'production.create' && <>
              <label>Assigned hole<select value={holeId} onChange={(event) => {
                const value = event.target.value; setHoleId(value); setParticipantRelationshipId('');
                if (recorder) sessionStorage.setItem('minaledger.selectedContext', JSON.stringify({ recorderUserId: recorder.id, siteId, holeId: value, roleKey: selectedRoleKey }));
              }} required>
                <option value="">Choose a hole</option>{holes.map((hole) => <option key={hole.id} value={hole.id}>{hole.holeCode}{hole.name ? ` · ${hole.name}` : ''}</option>)}
              </select></label>
              <label>Output material<select value={materialKind} onChange={(event) => setMaterialKind(event.target.value)}>
                {['GOLD_BEARING_FEED', 'RESIDUE', 'GOLD_DORE', 'RECOVERED_GOLD', 'PROCESS_OUTPUT'].map((kind) => <option key={kind} value={kind}>{kind.replaceAll('_', ' ')}</option>)}
              </select></label>
              <label>Actual participant identity<select value={identityState} onChange={(event) => setIdentityState(event.target.value as typeof identityState)}>
                <option value="IDENTIFIED">Identified</option><option value="UNRESOLVED">Unresolved</option><option value="UNKNOWN">Unknown</option>
              </select></label>
              {identityState === 'IDENTIFIED' && <label>Linked hole participant<select value={participantRelationshipId} onChange={(event) => setParticipantRelationshipId(event.target.value)} required>
                <option value="">Choose a participant assigned to this hole</option>{participants.map((participant) => <option key={participant.relationship_id} value={participant.relationship_id}>{participant.display_name} · {participant.role_code.replaceAll('_', ' ')}</option>)}
              </select></label>}
              <label>Information source<select value={sourceKind} onChange={(event) => setSourceKind(event.target.value)}>
                <option value="DIRECT">Direct entry</option><option value="ASSISTED_VERBAL">Assisted verbal</option><option value="WITNESS">Witness account</option><option value="PAPER_TRANSCRIPTION">Paper transcription</option><option value="OTHER">Other</option>
              </select></label>
              <label>Source reference<input value={sourceReference} onChange={(event) => setSourceReference(event.target.value)} placeholder="Optional paper or source reference" /></label>
              <label>Evidence reference<input value={evidenceReference} onChange={(event) => setEvidenceReference(event.target.value)} placeholder="Optional evidence reference" /></label>
            </>}
            {commandType === 'production.measurement.add' && <>
              <label>Production event ID<input value={eventId} onChange={(event) => setEventId(event.target.value)} placeholder="UUID" /></label>
              <label>Output ID<input value={outputId} onChange={(event) => setOutputId(event.target.value)} placeholder="UUID" /></label>
              <label>Observation type<select value={measurementKind} onChange={(event) => setMeasurementKind(event.target.value)}><option>MEASURED</option><option>DECLARED</option><option>VERIFIED</option></select></label>
              <label>Quantity in grams<input inputMode="decimal" value={quantityGrams} onChange={(event) => setQuantityGrams(event.target.value)} /></label>
              <label>Source value<input inputMode="decimal" value={sourceValue} onChange={(event) => setSourceValue(event.target.value)} /></label>
              <label>Source unit<input value={sourceUnit} onChange={(event) => setSourceUnit(event.target.value)} /></label>
              <label>Conversion version<input value={conversionVersion} onChange={(event) => setConversionVersion(event.target.value)} /></label>
              <label>Source role<select value={sourceRole} onChange={(event) => setSourceRole(event.target.value)}>{['SELLER', 'BUYER', 'RECORDER', 'WITNESS', 'WEIGHER', 'OTHER'].map((role) => <option key={role}>{role}</option>)}</select></label>
              <label>Source party ID<input value={measurementSourcePartyId} onChange={(event) => setMeasurementSourcePartyId(event.target.value)} placeholder="Required unless source role is RECORDER" /></label>
              <label>Evidence reference<input value={evidenceReference} onChange={(event) => setEvidenceReference(event.target.value)} /></label>
            </>}
            {commandType === 'capture.acknowledgement.add' && <>
              <label>Production event ID<input value={eventId} onChange={(event) => setEventId(event.target.value)} placeholder="UUID" /></label>
              <label>Capture provenance ID<input value={captureId} onChange={(event) => setCaptureId(event.target.value)} placeholder="UUID" /></label>
              <label>Participant response<select value={ackStatus} onChange={(event) => setAckStatus(event.target.value)}>{['ACKNOWLEDGED', 'PENDING', 'NOT_OBTAINED', 'DECLINED', 'DISPUTED'].map((status) => <option key={status}>{status}</option>)}</select></label>
              <label>Response method<input value={ackMethod} onChange={(event) => setAckMethod(event.target.value)} /></label>
              <label>Reason or note<input value={ackReason} onChange={(event) => setAckReason(event.target.value)} /></label>
              <p className="field-note">Only the identified participant account can submit a response. Recorder entry does not imply participant agreement.</p>
            </>}
            <label className="span-two">Parent command IDs<input value={parentIdsText} onChange={(event) => setParentIdsText(event.target.value)} placeholder="Optional UUIDs, separated by commas" /></label>
          </div>
          {revisionSource && <div className="notice info">Linked revision of {revisionSource.envelope.clientMutationId}. The earlier submission stays unchanged.</div>}
          <div className="form-actions"><button className="secondary" onClick={() => handleCreate('draft')} disabled={busy}>Save draft</button><button className="primary" onClick={() => handleCreate('pending_upload')} disabled={busy || !selectedRole}>{busy ? 'Saving…' : online ? 'Save and sync' : 'Save to offline queue'}</button></div>
        </section>

        <section className="queue-section" aria-labelledby="queue-heading">
          <div className="section-heading"><div><p className="eyebrow">THIS RECORDER ONLY</p><h2 id="queue-heading">Command queue <span className="count">{commands.length}</span></h2></div><p className="muted">Local save is not server acceptance.</p></div>
          {commands.length === 0 ? <div className="empty-state">No local commands for this recorder.</div> : <div className="queue-list">
            {commands.map((command) => <article className="queue-item" key={command.envelope.clientMutationId}>
              <div className="queue-main"><div className="queue-title"><strong>{command.envelope.commandType.replaceAll('.', ' ')}</strong><span className={`state-pill state-${command.state}`}>{STATE_LABELS[command.state]}</span></div>
                <p className="queue-meta">Mutation ID <code>{command.envelope.clientMutationId}</code></p>
                <p className="queue-meta">{new Date(command.createdAt).toLocaleString()} · {command.envelope.actingContext.roleCode} · {command.envelope.actingContext.scopeKind.toLowerCase()} {command.envelope.actingContext.scopeId}</p>
                {command.envelope.parentCommandIds.length > 0 && <p className="queue-meta">Linked to {command.envelope.parentCommandIds.join(', ')}</p>}
                {command.receipt?.error && <p className="error">{command.receipt.error.code}: {command.receipt.error.message}</p>}
                {command.state === 'needs_review' && <p className="review-note">This record is stored as submitted information. Review is required; it is not participant approval.</p>}
                {command.lastError && <p className="queue-meta">{command.lastError}</p>}
              </div>
              <div className="queue-actions">
                {command.state === 'draft' && <button className="small-button" onClick={() => queueSavedDraft(command)}>Queue</button>}
                {command.state === 'server_received' && <button className="small-button" onClick={() => checkReceipt(command)} disabled={busy}>Check receipt</button>}
                {(command.state === 'conflict' || command.state === 'rejected') && command.envelope.commandType === 'production.create' && <button className="small-button" onClick={() => prepareLinkedRevision(command)}>Prepare linked revision</button>}
              </div>
            </article>)}
          </div>}
        </section>
        <footer><span>Session-only sign-in</span><span>Local browser storage is not encrypted</span><span>Commands remain scoped to their recorder</span></footer>
      </div>
    </main>
  );
}
