import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { apiRequest, getHoleParticipants, getHoles, getProductionEvent, getSites, type HoleParticipantReference, type HoleReference, type ProductionEventReference, type SiteReference } from './api';
import { API_BASE_URL } from './apiBase';
import { applyReceipt, clearReferenceCache, getReferenceCache, listCommands, saveReferenceCache, updateCommand } from './offline/database';
import { createEnvelope, createLinkedRevision, queueCommand, recoverInterruptedUploads, saveDraft } from './offline/commands';
import { synchronizeCommands } from './offline/sync';
import type { ActingContext, CommandEnvelope, CommandType, QueuedCommand, SyncState } from './offline/types';

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

type CheckpointStreamKind = 'mining_site' | 'mining_hole' | 'material_event' | 'processing_facility' | 'recovery_facility' | 'gold_trade' | 'consignment';
interface AuditVerificationView {
  checkpointStatus: string;
  manifestStatus: string;
  streams: Array<{ streamKind: string; streamId: string; coveredSequence: number; currentSequence: number | null; currentHeadStatus?: string; tailStatus: string; tailEntries: number; checkpointFailure?: string; tailFailure?: string }>;
}
interface AuditCheckpointView {
  checkpoint: { id: string; createdAt: string; createdByUserId: string; manifestHash: string; streams: Array<{ streamKind: string; streamId: string; sequence: number; headHash: string }> };
  databaseState: string;
  processing: { status: string; attemptCount: number; lastErrorCode?: string | null; verification?: AuditVerificationView | null };
  liveVerification: AuditVerificationView;
  externalCommitment: string;
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
  const response = await fetch(`${API_BASE_URL}/api/v1/auth/login`, {
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
  const [measurementEventContext, setMeasurementEventContext] = useState<ProductionEventReference | null>(null);
  const [measurementParticipantPartyId, setMeasurementParticipantPartyId] = useState('');
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
  const [genericPayloadJson, setGenericPayloadJson] = useState('{}');
  const [revisionPayloadText, setRevisionPayloadText] = useState('{}');
  const [revisionSource, setRevisionSource] = useState<QueuedCommand | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkpointStreamKind, setCheckpointStreamKind] = useState<CheckpointStreamKind>('mining_site');
  const [checkpointStreamId, setCheckpointStreamId] = useState('');
  const [checkpointStreams, setCheckpointStreams] = useState<Array<{ streamKind: CheckpointStreamKind; streamId: string }>>([]);
  const [checkpointRecord, setCheckpointRecord] = useState<AuditCheckpointView | null>(null);
  const [checkpointError, setCheckpointError] = useState('');

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

  const activeCheckpointId = checkpointRecord?.checkpoint.id;
  const activeCheckpointStatus = checkpointRecord?.processing.status;
  useEffect(() => {
    if (!token || !activeCheckpointId || !['PENDING', 'PROCESSING', 'RETRY'].includes(activeCheckpointStatus ?? '')) return undefined;
    let active = true;
    const refreshCheckpoint = async () => {
      try {
        const result = await apiRequest<AuditCheckpointView>(`/api/v1/audit/checkpoints/${activeCheckpointId}`, token);
        if (active) setCheckpointRecord(result);
      } catch (loadError) {
        if (active) setCheckpointError(loadError instanceof Error ? loadError.message : 'Checkpoint status could not be refreshed.');
      }
    };
    const timer = window.setInterval(() => { void refreshCheckpoint(); }, 2_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [token, activeCheckpointId, activeCheckpointStatus]);

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
    setCheckpointRecord(null); setCheckpointStreams([]); setCheckpointError('');
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
      setCheckpointRecord(null); setCheckpointStreams([]); setCheckpointError('');
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

  function addCheckpointStream() {
    setCheckpointError('');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(checkpointStreamId.trim())) {
      setCheckpointError('Enter a valid stream UUID.');
      return;
    }
    if (checkpointStreams.some((stream) => stream.streamKind === checkpointStreamKind && stream.streamId === checkpointStreamId.trim())) {
      setCheckpointError('That stream is already selected.');
      return;
    }
    setCheckpointStreams((current) => [...current, { streamKind: checkpointStreamKind, streamId: checkpointStreamId.trim() }]);
    setCheckpointStreamId('');
  }

  async function createCheckpoint(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || checkpointStreams.length === 0) return;
    setBusy(true); setCheckpointError('');
    const clientMutationId = crypto.randomUUID();
    try {
      const result = await apiRequest<AuditCheckpointView>('/api/v1/audit/checkpoints', token, {
        method: 'POST', headers: { 'Idempotency-Key': clientMutationId },
        body: JSON.stringify({ clientMutationId, streams: checkpointStreams }),
      });
      setCheckpointRecord(result);
    } catch (createError) {
      setCheckpointError(createError instanceof Error ? createError.message : 'Checkpoint creation failed.');
    } finally { setBusy(false); }
  }

  async function refreshCheckpointStatus() {
    if (!token || !checkpointRecord) return;
    setCheckpointError('');
    try {
      setCheckpointRecord(await apiRequest<AuditCheckpointView>(`/api/v1/audit/checkpoints/${checkpointRecord.checkpoint.id}`, token));
    } catch (loadError) {
      setCheckpointError(loadError instanceof Error ? loadError.message : 'Checkpoint status could not be refreshed.');
    }
  }

  function participantFor(type: CommandType) {
    if (type === 'capture.acknowledgement.add') return { identityState: 'IDENTIFIED' as const, partyId: recorder?.personPartyId };
    const participant = participants.find((row) => row.relationship_id === participantRelationshipId);
    return { identityState, ...(identityState === 'IDENTIFIED' && participant ? { partyId: participant.party_id } : {}) };
  }

  function expectedTarget(type: CommandType, value: unknown): CommandEnvelope['expectedVersion'] {
    const payload = value as Record<string, unknown>;
    if (type === 'production.allocation.propose') return { streamKind: 'material_event', streamId: String(payload.eventId), sequence: 0 };
    if (type === 'stockpile.transfer') return { streamKind: 'inventory_location', streamId: String(payload.sourceLocationId), sequence: 0 };
    if (type === 'inventory.adjustment.create') return { streamKind: 'inventory_location', streamId: String(payload.locationId), sequence: 0 };
    if (type.startsWith('consignment.')) return { streamKind: 'consignment', streamId: String(payload.consignmentId), sequence: 0 };
    if (type === 'custody.transfer.decide') return { streamKind: 'custody_transfer', streamId: String(payload.transferId), sequence: 0 };
    if (type.startsWith('gold_trade.')) return { streamKind: 'gold_trade', streamId: String(payload.tradeId), sequence: 0 };
    return undefined;
  }

  function correctedVersion(command: QueuedCommand): CommandEnvelope['expectedVersion'] | undefined {
    const details = command.receipt?.error?.details as { streamKind?: string; streamId?: string; currentSequence?: number } | undefined;
    if (details?.streamKind && details.streamId && Number.isInteger(details.currentSequence)) {
      return { streamKind: details.streamKind as NonNullable<CommandEnvelope['expectedVersion']>['streamKind'], streamId: details.streamId, sequence: Number(details.currentSequence) };
    }
    return command.envelope.expectedVersion;
  }

  async function loadMeasurementContext() {
    if (!siteId || !eventId.trim() || !token) throw new Error('Choose an assigned site and enter a production event before loading its participant context.');
    const event = await getProductionEvent(siteId, eventId.trim(), token);
    setMeasurementEventContext(event);
    setOutputId(event.outputs[0]?.id ?? '');
    setMeasurementParticipantPartyId(event.captureProvenance?.actual_participant_party_id ?? '');
    setMessage(`Loaded event ${event.id} from hole ${event.hole_id}; participant and capture context came from that event.`);
  }

  async function createLocalCommand(state: 'draft' | 'pending_upload') {
    if (!recorder || !actingContext) throw new Error('Choose an assigned role first.');
    const occurredAtIso = occurrenceIso(occurredAt);
    let identity = ['production.create', 'production.measurement.add', 'capture.acknowledgement.add'].includes(commandType)
      ? participantFor(commandType) : { identityState: 'UNKNOWN' as const };
    if (identity.identityState === 'IDENTIFIED' && !identity.partyId) throw new Error('An identified participant needs a party ID.');
    let payload: unknown;
    let captureProvenance: unknown;
    let evidence: Array<{ reference: string }> = [];
    const currentHole = holes.find((row) => row.id === holeId);
    if (commandType === 'production.create') {
      if (!siteId) throw new Error('Choose an assigned site.');
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
    } else if (commandType === 'production.measurement.add' && !revisionSource) {
      if (!siteId) throw new Error('Choose the assigned site for this production event.');
      if (!measurementEventContext || measurementEventContext.id !== eventId.trim() || measurementEventContext.siteId !== siteId) throw new Error('Load the selected production event from the assigned site before entering a measurement.');
      if (!outputId || !measurementEventContext.outputs.some((output) => output.id === outputId)) throw new Error('Choose an output belonging to the loaded production event.');
      const capture = measurementEventContext.captureProvenance;
      if (capture?.participant_identity_state === 'IDENTIFIED') {
        if (!measurementParticipantPartyId || measurementParticipantPartyId !== capture.actual_participant_party_id) throw new Error('Confirm the identified participant recorded on the loaded production event.');
        identity = { identityState: 'IDENTIFIED', partyId: measurementParticipantPartyId };
      } else {
        identity = { identityState: capture?.participant_identity_state ?? 'UNKNOWN' };
      }
      captureProvenance = capture ?? undefined;
      payload = {
        siteId, eventId: eventId.trim(), outputId: outputId.trim(),
        input: {
          kind: measurementKind, quantityGrams: quantityGrams.trim(), sourceValue: sourceValue.trim(), sourceUnit: sourceUnit.trim(),
          conversionVersion: conversionVersion.trim(), sourceRole,
          ...(measurementSourcePartyId.trim() ? { sourcePartyId: measurementSourcePartyId.trim() } : {}),
          occurredAt: occurredAtIso, ...(evidenceReference.trim() ? { evidenceRef: evidenceReference.trim() } : {}),
        },
      };
      if (capture?.evidence_ref) evidence = [{ reference: capture.evidence_ref }];
      if (evidenceReference.trim()) evidence = [{ reference: evidenceReference.trim() }];
    } else if (commandType === 'capture.acknowledgement.add' && !revisionSource) {
        if (!siteId || !eventId.trim() || !captureId.trim()) throw new Error('Choose a site and enter the production event and capture provenance IDs.');
        payload = {
          siteId, eventId: eventId.trim(), captureProvenanceId: captureId.trim(),
          acknowledgement: {
            status: ackStatus,
            ...(ackStatus === 'ACKNOWLEDGED' ? { acknowledgedByPartyId: recorder.personPartyId } : {}),
            method: ackMethod, occurredAt: occurredAtIso, ...(ackReason.trim() ? { reason: ackReason.trim() } : {}),
          },
        };
    } else {
      try { payload = JSON.parse(revisionSource ? revisionPayloadText : genericPayloadJson) as unknown; }
      catch { throw new Error('Enter valid JSON for the selected command payload.'); }
      if (revisionSource) {
        identity = revisionSource.envelope.actualParticipant;
        captureProvenance = revisionSource.envelope.captureProvenance;
        evidence = revisionSource.envelope.evidence;
      }
    }
    const parentCommandIds = parentIdsText.split(',').map((part) => part.trim()).filter(Boolean);
    const versionTarget = expectedTarget(commandType, payload);
    let expectedVersion: CommandEnvelope['expectedVersion'] = commandType === 'production.create' && currentHole?.auditSequence !== undefined
      ? { streamKind: 'mining_hole' as const, streamId: holeId, sequence: currentHole.auditSequence }
      : commandType === 'production.measurement.add' && measurementEventContext
        ? { streamKind: 'material_event' as const, streamId: eventId.trim(), sequence: measurementEventContext.auditSequence }
        : undefined;
    if (revisionSource) expectedVersion = correctedVersion(revisionSource) ?? expectedVersion;
    if (revisionSource && commandType === 'production.create') {
      const original = revisionSource.envelope.payload as { input: { occurredAt: string; participantRelationshipIds?: string[]; captureProvenance: unknown } };
      const revised = payload as { siteId: string; input: Record<string, unknown> };
      payload = { ...revised, input: {
        ...revised.input, occurredAt: original.input.occurredAt,
        ...(original.input.participantRelationshipIds ? { participantRelationshipIds: original.input.participantRelationshipIds } : {}),
        captureProvenance: original.input.captureProvenance,
      } };
    }
    let envelope = revisionSource
      ? await createLinkedRevision({ original: revisionSource, recorderUserId: recorder.id, actingContext, payload, expectedVersion, parentCommandIds })
      : await createEnvelope({ recorderUserId: recorder.id, actingContext, commandType, payload, occurredAtClaimed: occurredAtIso,
        actualParticipant: identity, captureProvenance, evidence, parentCommandIds, ...(expectedVersion ? { expectedVersion } : {}) });
    const needsVersion = !['production.create', 'capture.acknowledgement.add'].includes(commandType);
    if (needsVersion) {
      if (online && token) {
        const result = await apiRequest<{ expectedVersion: NonNullable<CommandEnvelope['expectedVersion']> }>('/api/v1/sync/versions', token, {
          method: 'POST', body: JSON.stringify(envelope),
        });
        const currentVersion = result.expectedVersion;
        expectedVersion = currentVersion;
        envelope = { ...envelope, expectedVersion: currentVersion };
        await saveReferenceCache({
          key: `audit-version:${currentVersion.streamKind}:${currentVersion.streamId}`,
          recorderUserId: recorder.id, contextKey, savedAt: new Date().toISOString(), value: currentVersion,
        });
      } else {
        const key = expectedVersion ? `audit-version:${expectedVersion.streamKind}:${expectedVersion.streamId}`
          : versionTarget ? `audit-version:${versionTarget.streamKind}:${versionTarget.streamId}` : '';
        const cached = key ? await getReferenceCache<NonNullable<CommandEnvelope['expectedVersion']>>(key) : undefined;
        if (cached?.recorderUserId === recorder.id && cached.value.streamId === (expectedVersion?.streamId ?? versionTarget?.streamId)) expectedVersion = cached.value;
        if (expectedVersion) envelope = { ...envelope, expectedVersion };
      }
      if (!expectedVersion) throw new Error('Load this resource version while connected before queuing the command offline.');
    }
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
    setCommandType(command.envelope.commandType);
    setRevisionSource(command);
    setRevisionPayloadText(JSON.stringify(command.envelope.payload, null, 2));
    setParentIdsText(command.envelope.clientMutationId);
    setOccurredAt(new Date(new Date(command.envelope.occurredAtClaimed).getTime() - new Date(command.envelope.occurredAtClaimed).getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
    if (command.envelope.commandType !== 'production.create') {
      setMessage(`Prepare a linked ${command.envelope.commandType} correction. The original envelope and provenance remain unchanged.`);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    const payload = command.envelope.payload as { siteId: string; input: { holeId: string; occurredAt: string; participantRelationshipIds?: string[]; captureProvenance: Record<string, string>; outputs: Array<{ materialKind: string }> } };
    const capture = payload.input.captureProvenance;
    setCommandType('production.create'); setSiteId(payload.siteId); setHoleId(payload.input.holeId);
    setOccurredAt(new Date(new Date(command.envelope.occurredAtClaimed).getTime() - new Date(command.envelope.occurredAtClaimed).getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
    setIdentityState((capture.participantIdentityState as 'IDENTIFIED' | 'UNRESOLVED' | 'UNKNOWN') ?? 'UNKNOWN');
    setParticipantRelationshipId(payload.input.participantRelationshipIds?.[0] ?? ''); setSourceKind(capture.sourceKind ?? 'DIRECT');
    setSourceReference(capture.sourceReference ?? ''); setEvidenceReference(capture.evidenceRef ?? '');
    setMaterialKind(payload.input.outputs[0]?.materialKind ?? 'GOLD_BEARING_FEED');
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
            <label>Command type<select value={commandType} disabled={Boolean(revisionSource)} onChange={(event) => { setCommandType(event.target.value as CommandType); setMeasurementEventContext(null); }}>
              <option value="production.create">Production event</option>
              <option value="production.measurement.add">Output measurement</option>
              <option value="capture.acknowledgement.add">Participant response</option>
              <option value="production.allocation.propose">Allocation proposal or revision</option>
              <option value="stockpile.transfer">Stockpile inventory transfer</option>
              <option value="inventory.adjustment.create">Inventory count adjustment</option>
              <option value="consignment.dispatch">Consignment dispatch</option>
              <option value="consignment.receipt.add">Consignment receipt</option>
              <option value="consignment.receipt.correct">Receipt correction</option>
              <option value="consignment.custody.offer">Consignment custody offer</option>
              <option value="custody.transfer.decide">Custody decision</option>
              <option value="gold_trade.assay.record">Gold-trade assay observation</option>
              <option value="gold_trade.measurement.add">Gold-trade measurement</option>
              <option value="gold_trade.custody.offer">Gold-trade custody offer</option>
            </select></label>
            <label>Assigned site<select value={siteId} onChange={(event) => {
              const value = event.target.value; setSiteId(value); setHoleId(''); setMeasurementEventContext(null); setMeasurementParticipantPartyId(''); setOutputId('');
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
              <label>Production event ID<input value={eventId} onChange={(event) => { setEventId(event.target.value); setMeasurementEventContext(null); setMeasurementParticipantPartyId(''); setOutputId(''); }} placeholder="UUID" /></label>
              <button className="secondary" type="button" onClick={() => { setBusy(true); void loadMeasurementContext().catch((loadError) => setError(loadError instanceof Error ? loadError.message : 'Could not load event context.')).finally(() => setBusy(false)); }} disabled={busy || !online || !siteId || !eventId.trim()}>Load event and participant context</button>
              {measurementEventContext && <>
                <div className="notice info span-two">Event {measurementEventContext.id} · Hole {measurementEventContext.hole_id} · capture source {measurementEventContext.captureProvenance?.source_kind ?? 'not recorded'} · event version {measurementEventContext.auditSequence}</div>
                <label>Output<select aria-label="Production event output" value={outputId} onChange={(event) => setOutputId(event.target.value)} required>
                  <option value="">Choose an output from this event</option>{measurementEventContext.outputs.map((output) => <option key={output.id} value={output.id}>{output.batch_code} · {output.material_kind.replaceAll('_', ' ')}</option>)}
                </select></label>
                <label>Actual participant on event<select aria-label="Actual participant on event" value={measurementParticipantPartyId} onChange={(event) => setMeasurementParticipantPartyId(event.target.value)} disabled={measurementEventContext.captureProvenance?.participant_identity_state !== 'IDENTIFIED'}>
                  <option value="">{measurementEventContext.captureProvenance?.participant_identity_state === 'IDENTIFIED' ? 'Confirm the event participant' : `Event participant is ${measurementEventContext.captureProvenance?.participant_identity_state.toLowerCase() ?? 'unknown'}`}</option>
                  {measurementEventContext.captureProvenance?.actual_participant_party_id && <option value={measurementEventContext.captureProvenance.actual_participant_party_id}>{measurementEventContext.captureProvenance.actual_participant_party_id}</option>}
                </select></label>
              </>}
              {!measurementEventContext && <p className="field-note span-two">Load the event first. The measurement envelope will carry that event’s actual participant and capture provenance.</p>}
              <label>Observation type<select value={measurementKind} onChange={(event) => setMeasurementKind(event.target.value)}><option>MEASURED</option><option>DECLARED</option><option>VERIFIED</option></select></label>
              <label>Quantity in grams<input inputMode="decimal" value={quantityGrams} onChange={(event) => setQuantityGrams(event.target.value)} /></label>
              <label>Source value<input inputMode="decimal" value={sourceValue} onChange={(event) => setSourceValue(event.target.value)} /></label>
              <label>Source unit<input value={sourceUnit} onChange={(event) => setSourceUnit(event.target.value)} /></label>
              <label>Conversion version<input value={conversionVersion} onChange={(event) => setConversionVersion(event.target.value)} /></label>
              <label>Source role<select value={sourceRole} onChange={(event) => setSourceRole(event.target.value)}>{['SELLER', 'BUYER', 'RECORDER', 'WITNESS', 'WEIGHER', 'OTHER'].map((role) => <option key={role}>{role}</option>)}</select></label>
              <label>Measurement source party ID<input value={measurementSourcePartyId} onChange={(event) => setMeasurementSourcePartyId(event.target.value)} placeholder="Separate from the event participant; required for witness/weigher/other" /></label>
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
            {(!['production.create', 'production.measurement.add', 'capture.acknowledgement.add'].includes(commandType) || (revisionSource && commandType !== 'production.create')) && <>
              <label className="span-two">Allowlisted command payload (JSON)<textarea rows={12} spellCheck={false} value={revisionSource ? revisionPayloadText : genericPayloadJson} onChange={(event) => revisionSource ? setRevisionPayloadText(event.target.value) : setGenericPayloadJson(event.target.value)} aria-label="Allowlisted command payload JSON" /></label>
              <p className="field-note span-two">Use the command payload shape documented for the existing API. The app validates its JSON, then asks the authenticated server to authorize the resource and attach its current audit version before queueing.</p>
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
                {(command.state === 'conflict' || command.state === 'rejected') && <button className="small-button" onClick={() => prepareLinkedRevision(command)}>Prepare linked revision</button>}
              </div>
            </article>)}
          </div>}
        </section>
        <section className="queue-section" aria-labelledby="checkpoint-heading">
          <div className="section-heading"><div><p className="eyebrow">DATABASE EVIDENCE</p><h2 id="checkpoint-heading">Audit checkpoints</h2></div></div>
          <p className="muted">Create an immutable checkpoint for streams you are authorized to read. Checkpoints cover the listed sequence and head only; later events remain an unanchored tail. No external or blockchain commitment is implemented.</p>
          <form onSubmit={createCheckpoint}>
            <div className="form-grid">
              <label>Aggregate stream<select aria-label="Checkpoint stream kind" value={checkpointStreamKind} onChange={(event) => setCheckpointStreamKind(event.target.value as CheckpointStreamKind)}>
                <option value="mining_site">Mining site</option><option value="mining_hole">Mining hole</option><option value="material_event">Material event</option>
                <option value="processing_facility">Processing facility</option><option value="recovery_facility">Recovery facility</option><option value="gold_trade">Gold trade</option><option value="consignment">Consignment</option>
              </select></label>
              <label>Stream ID<input aria-label="Checkpoint stream ID" value={checkpointStreamId} onChange={(event) => setCheckpointStreamId(event.target.value)} placeholder="UUID" /></label>
              <button className="secondary" type="button" onClick={addCheckpointStream}>Add stream</button>
              <div className="span-two" aria-label="Selected checkpoint streams">
                {checkpointStreams.map((stream) => <p className="queue-meta" key={`${stream.streamKind}:${stream.streamId}`}>{stream.streamKind} · {stream.streamId} <button className="small-button" type="button" onClick={() => setCheckpointStreams((current) => current.filter((item) => item !== stream))}>Remove</button></p>)}
              </div>
              <button className="primary" type="submit" disabled={busy || !online || checkpointStreams.length === 0}>{busy ? 'Creating…' : 'Create checkpoint'}</button>
            </div>
          </form>
          {checkpointError && <p role="alert" className="error">{checkpointError}</p>}
          {checkpointRecord && <div className="notice info" aria-live="polite">
            <strong>Outbox {checkpointRecord.processing.status.toLowerCase()} (attempts {checkpointRecord.processing.attemptCount})</strong>
            <button className="small-button" type="button" onClick={() => void refreshCheckpointStatus()} disabled={busy}>Refresh verification</button>
            <p>Database state: {checkpointRecord.databaseState}. External commitment: {checkpointRecord.externalCommitment}.</p>
            <p>Manifest SHA-256: <code>{checkpointRecord.checkpoint.manifestHash}</code></p>
            {checkpointRecord.processing.lastErrorCode && <p role="alert">Processing error: {checkpointRecord.processing.lastErrorCode}</p>}
            {checkpointRecord.processing.verification && <p>Saved covered checkpoint: {checkpointRecord.processing.verification.checkpointStatus}; manifest: {checkpointRecord.processing.verification.manifestStatus}.</p>}
            {checkpointRecord.liveVerification && <>
              <p>Live database verification: {checkpointRecord.liveVerification.checkpointStatus}; manifest: {checkpointRecord.liveVerification.manifestStatus}.</p>
              {checkpointRecord.liveVerification.streams.map((stream) => <p key={`${stream.streamKind}:${stream.streamId}`}>
                {stream.streamKind} {stream.streamId}: covered through sequence {stream.coveredSequence}; current head {stream.currentHeadStatus?.toLowerCase() ?? 'unavailable'}; tail {stream.tailStatus.toLowerCase()} ({stream.tailEntries} {stream.tailEntries === 1 ? 'entry' : 'entries'}).
                {stream.checkpointFailure ? ` Checkpoint issue: ${stream.checkpointFailure}.` : ''}{stream.tailFailure ? ` Tail issue: ${stream.tailFailure}.` : ''}
              </p>)}
            </>}
          </div>}
        </section>
        <footer><span>Session-only sign-in</span><span>Local browser storage is not encrypted</span><span>Commands remain scoped to their recorder</span></footer>
      </div>
    </main>
  );
}
