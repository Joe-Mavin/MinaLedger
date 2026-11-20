import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { apiRequest, type HoleReference, type SiteReference } from '../api';
import { WorkspaceHeading } from '../AppShell';
import { getReferenceCache, saveReferenceCache, listCommands } from '../offline/database';
import { createEnvelope, queueCommand } from '../offline/commands';
import { synchronizeCommands } from '../offline/sync';
import type { ActingContext, CommandEnvelope, QueuedCommand } from '../offline/types';

interface ProductionEventRow {
  id: string;
  event_code: string;
  event_kind: string;
  occurred_at_claimed: string;
  recorded_at: string;
  current_status: string;
  hole_id: string;
  hole_code: string;
  output_count: number;
  siteId: string;
  siteName: string;
  details?: ProductionEventDetail;
  detailError?: string;
}

interface ProductionMeasurement {
  id: string;
  measurement_kind: 'DECLARED' | 'MEASURED' | 'VERIFIED';
  quantity_g: string;
  source_value: string;
  source_unit_code: string;
  conversion_version: string;
  source_role: string;
  source_party_id: string | null;
  occurred_at_claimed: string;
  entered_at: string;
  method_code: string | null;
  instrument_ref: string | null;
  supersedes_measurement_id: string | null;
}

interface ProductionOutput {
  id: string;
  batch_id: string;
  batch_code: string;
  material_kind: string;
  measurement_set_id: string;
  measurements: ProductionMeasurement[];
}

interface ProductionEventDetail {
  id: string;
  event_code: string;
  event_kind: string;
  occurred_at_claimed: string;
  recorded_at: string;
  current_status: string;
  hole_id: string;
  hole_code: string;
  auditSequence: number;
  participants: Array<{ party_id: string; role_code: string; relationship_id: string; relationship_kind: 'SITE' | 'HOLE' }>;
  captureProvenance: {
    id: string;
    actual_participant_party_id: string | null;
    participant_identity_state: 'IDENTIFIED' | 'UNRESOLVED' | 'UNKNOWN';
    source_kind: string;
    occurred_at_claimed: string;
    entered_at: string;
    source_reference: string | null;
    evidence_ref: string | null;
    acknowledgement_status: string | null;
    acknowledged_by_party_id: string | null;
  } | null;
  outputs: ProductionOutput[];
}

interface BeneficiaryRelationship {
  party_id: string;
  display_name: string;
  relationship_id: string;
  relationship_kind: 'SITE' | 'HOLE';
  role_code: string;
  relationship_status: string;
  valid_from: string;
  valid_to: string | null;
  hole_id: string | null;
}

interface AllocationRow {
  id: string;
  allocation_set_id: string;
  beneficiary_party_id: string;
  allocation_basis: 'QUANTITY' | 'SHARE';
  allocated_quantity_g: string | null;
  allocated_share: string | null;
}

interface AllocationReview {
  review_status: string;
  reason?: string | null;
  evidence_ref?: string | null;
  occurred_at?: string;
}

interface AllocationRevision {
  id: string;
  revision_no: number;
  revision_kind: string;
  basis_kind: 'QUANTITY' | 'SHARE';
  basis_measurement_id: string | null;
  supersedes_set_id: string | null;
  correction_reason: string | null;
  proposed_by_user_id: string;
  created_at: string;
  rows: AllocationRow[];
  reviewHistory: AllocationReview[];
}

interface AllocationHistory {
  productionEventOutputId: string;
  allocationChainId: string | null;
  activeApprovedSetId: string | null;
  revisions: AllocationRevision[];
}

interface ProposalEntry {
  beneficiaryPartyId: string;
  value: string;
}

function displayDate(value?: string | null): string {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function readable(value?: string | null): string {
  return (value ?? 'Unknown').replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function activeAt(relationship: BeneficiaryRelationship, occurredAt: string): boolean {
  const when = new Date(occurredAt).getTime();
  return relationship.relationship_status === 'ACTIVE'
    && new Date(relationship.valid_from).getTime() <= when
    && (!relationship.valid_to || new Date(relationship.valid_to).getTime() > when);
}

function scaledDecimal(value: string, places: number): bigint | null {
  if (!new RegExp(`^(0|[1-9][0-9]*)(\\.[0-9]{1,${places}})?$`).test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * (10n ** BigInt(places)) + BigInt(fraction.padEnd(places, '0'));
}

export function ProductionWorkspace({
  token, recorderUserId, actingContext, contextKey, online, sites, canProposeAllocations,
  onRecordProduction, onCommandQueued,
}: {
  token: string;
  recorderUserId: string;
  actingContext: ActingContext | null;
  contextKey: string;
  online: boolean;
  sites: SiteReference[];
  canProposeAllocations: boolean;
  onRecordProduction: (siteId: string, holeId: string) => void;
  onCommandQueued: () => Promise<void>;
}) {
  const [events, setEvents] = useState<ProductionEventRow[]>([]);
  const [selectedSiteFilter, setSelectedSiteFilter] = useState('all');
  const [selectedEvent, setSelectedEvent] = useState<ProductionEventRow | null>(null);
  const [selectedOutputId, setSelectedOutputId] = useState('');
  const [selectedBatchId, setSelectedBatchId] = useState('');
  const [allocations, setAllocations] = useState<AllocationHistory | null>(null);
  const [beneficiaries, setBeneficiaries] = useState<BeneficiaryRelationship[]>([]);
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [captureSiteId, setCaptureSiteId] = useState('');
  const [captureHoles, setCaptureHoles] = useState<HoleReference[]>([]);
  const [captureHoleId, setCaptureHoleId] = useState('');
  const [basisKind, setBasisKind] = useState<'QUANTITY' | 'SHARE'>('SHARE');
  const [basisMeasurementId, setBasisMeasurementId] = useState('');
  const [proposalEntries, setProposalEntries] = useState<ProposalEntry[]>([{ beneficiaryPartyId: '', value: '' }]);
  const [correctionSetId, setCorrectionSetId] = useState('');
  const [correctionReason, setCorrectionReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [trackedMutationId, setTrackedMutationId] = useState('');
  const [searchError, setSearchError] = useState('');

  const loadRegister = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      let rows: ProductionEventRow[] = [];
      if (online) {
        const responses = await Promise.all(sites.map(async (site) => {
          const eventsForSite = await apiRequest<Array<Omit<ProductionEventRow, 'siteId' | 'siteName' | 'details'>>>(
            `/api/v1/sites/${site.id}/production-events`, token,
          );
          return eventsForSite.map((event) => ({ ...event, siteId: site.id, siteName: site.name }));
        }));
        rows = responses.flat();
        rows.sort((left, right) => right.recorded_at.localeCompare(left.recorded_at));
        await saveReferenceCache({ key: `production-register:${contextKey}`, recorderUserId, contextKey, savedAt: new Date().toISOString(), value: rows });
      } else {
        const cached = await getReferenceCache<ProductionEventRow[]>(`production-register:${contextKey}`);
        if (cached?.recorderUserId !== recorderUserId || cached.contextKey !== contextKey) throw new Error('No production register is cached for this recorder and active role. Connect to load authorized events.');
        rows = cached.value;
      }

      const detailedRows = await Promise.all(rows.map(async (row) => {
        const cacheKey = `production-event:${row.siteId}:${row.id}`;
        try {
          if (!online) {
            const cached = await getReferenceCache<ProductionEventDetail>(cacheKey);
            if (cached?.recorderUserId !== recorderUserId || cached.contextKey !== contextKey) throw new Error('Event detail is not cached for this role.');
            return { ...row, details: cached.value };
          }
          const details = await apiRequest<ProductionEventDetail>(`/api/v1/sites/${row.siteId}/production-events/${row.id}`, token);
          await saveReferenceCache({ key: cacheKey, recorderUserId, contextKey, savedAt: new Date().toISOString(), value: details });
          await saveReferenceCache({
            key: `audit-version:material_event:${details.id}`, recorderUserId, contextKey,
            savedAt: new Date().toISOString(),
            value: { streamKind: 'material_event' as const, streamId: details.id, sequence: details.auditSequence },
          });
          return { ...row, details };
        } catch (detailError) {
          return { ...row, detailError: detailError instanceof Error ? detailError.message : 'Event details could not be loaded.' };
        }
      }));
      setEvents(detailedRows);
    } catch (loadError) {
      setEvents([]);
      setError(loadError instanceof Error ? loadError.message : 'Production events could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [contextKey, online, recorderUserId, sites, token]);

  useEffect(() => { void loadRegister(); }, [loadRegister]);

  useEffect(() => {
    if (!captureSiteId) {
      setCaptureHoles([]);
      setCaptureHoleId('');
      return;
    }
    let active = true;
    void (async () => {
      try {
        const holes = await apiRequest<HoleReference[]>(`/api/v1/sites/${captureSiteId}/holes`, token);
        if (active) setCaptureHoles(holes);
      } catch (loadError) {
        if (active) {
          setCaptureHoles([]);
          setCaptureHoleId('');
          setError(loadError instanceof Error ? loadError.message : 'Holes could not be loaded for the selected site.');
        }
      }
    })();
    return () => { active = false; };
  }, [captureSiteId, token]);

  useEffect(() => {
    const siteId = selectedEvent?.siteId;
    if (!siteId || !selectedEvent?.details || !online) return;
    let active = true;
    void apiRequest<BeneficiaryRelationship[]>(`/api/v1/sites/${siteId}/participants`, token)
      .then(async (rows) => {
        const eligible = rows.filter((row) => row.role_code === 'BENEFICIARY'
          && (row.relationship_kind === 'SITE' || row.hole_id === selectedEvent.details?.hole_id));
        await saveReferenceCache({ key: `production-beneficiaries:${siteId}`, recorderUserId, contextKey, savedAt: new Date().toISOString(), value: eligible });
        if (active) setBeneficiaries(eligible);
      })
      .catch(() => { if (active) setBeneficiaries([]); });
    return () => { active = false; };
  }, [contextKey, online, recorderUserId, selectedEvent, token]);

  useEffect(() => {
    if (!selectedEvent || !selectedOutputId) {
      setAllocations(null);
      return;
    }
    let active = true;
    const key = `production-allocations:${selectedEvent.siteId}:${selectedEvent.id}:${selectedOutputId}`;
    void (async () => {
      try {
        let history: AllocationHistory;
        if (online) {
          history = await apiRequest<AllocationHistory>(
            `/api/v1/sites/${selectedEvent.siteId}/production-events/${selectedEvent.id}/outputs/${selectedOutputId}/allocation-sets`, token,
          );
          await saveReferenceCache({ key, recorderUserId, contextKey, savedAt: new Date().toISOString(), value: history });
        } else {
          const cached = await getReferenceCache<AllocationHistory>(key);
          if (cached?.recorderUserId !== recorderUserId || cached.contextKey !== contextKey) throw new Error('Allocation history is not cached for this role.');
          history = cached.value;
        }
        if (active) {
          setAllocations(history);
          setSearchError('');
        }
      } catch (loadError) {
        if (active) {
          setAllocations(null);
          setSearchError(loadError instanceof Error ? loadError.message : 'Allocation history could not be loaded.');
        }
      }
    })();
    return () => { active = false; };
  }, [contextKey, online, recorderUserId, selectedEvent, selectedOutputId, token]);

  useEffect(() => {
    if (!online || !trackedMutationId) return undefined;
    let active = true;
    const refreshReceipt = async () => {
      const command = (await listCommands(recorderUserId)).find((row) => row.envelope.clientMutationId === trackedMutationId);
      if (!active || !command || !['server_accepted', 'needs_review', 'conflict', 'rejected'].includes(command.state)) return;
      if (command.state === 'server_accepted' || command.state === 'needs_review') {
        setMessage(`Server receipt: ${readable(command.state)}. This remains a proposal, not an approved agreement.`);
        const payload = command.envelope.payload as { siteId: string; eventId: string; outputId: string };
        if (selectedEvent?.id === payload.eventId && selectedOutputId === payload.outputId) {
          const history = await apiRequest<AllocationHistory>(
            `/api/v1/sites/${payload.siteId}/production-events/${payload.eventId}/outputs/${payload.outputId}/allocation-sets`, token,
          ).catch(() => null);
          if (active && history) {
            setAllocations(history);
            await saveReferenceCache({
              key: `production-allocations:${payload.siteId}:${payload.eventId}:${payload.outputId}`,
              recorderUserId, contextKey, savedAt: new Date().toISOString(), value: history,
            });
          }
        }
      } else {
        setError(`${readable(command.state)}: ${command.receipt?.error?.message ?? command.lastError ?? 'The server did not accept this proposal.'}`);
        setMessage('The command and its mutation ID remain in the queue for review.');
      }
      if (active) setTrackedMutationId('');
    };
    void refreshReceipt();
    const timer = window.setInterval(() => { void refreshReceipt(); }, 1_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [contextKey, online, recorderUserId, selectedEvent, selectedOutputId, token, trackedMutationId]);

  useEffect(() => {
    const siteId = selectedEvent?.siteId;
    if (!siteId || online) return;
    let active = true;
    void getReferenceCache<BeneficiaryRelationship[]>(`production-beneficiaries:${siteId}`).then((cached) => {
      if (active && cached?.recorderUserId === recorderUserId && cached.contextKey === contextKey) setBeneficiaries(cached.value);
    });
    return () => { active = false; };
  }, [contextKey, online, recorderUserId, selectedEvent]);

  const visibleEvents = useMemo(() => {
    const query = search.trim().toLowerCase();
    return events.filter((event) => {
      if (selectedSiteFilter !== 'all' && event.siteId !== selectedSiteFilter) return false;
      const occurred = new Date(event.occurred_at_claimed).getTime();
      if (dateFrom && occurred < new Date(`${dateFrom}T00:00:00`).getTime()) return false;
      if (dateTo && occurred > new Date(`${dateTo}T23:59:59`).getTime()) return false;
      const material = event.details?.outputs.map((output) => output.material_kind).join(' ') ?? '';
      const haystack = `${event.event_code} ${event.siteName} ${event.hole_code} ${event.current_status} ${material}`.toLowerCase();
      return !query || haystack.includes(query);
    });
  }, [dateFrom, dateTo, events, search, selectedSiteFilter]);

  const selectedOutput = selectedEvent?.details?.outputs.find((output) => output.id === selectedOutputId) ?? null;
  const latestRevision = allocations?.revisions.at(-1) ?? null;
  const canReviseLatest = Boolean(latestRevision && !allocations?.activeApprovedSetId);
  const eligibleBeneficiaries = useMemo(() => {
    if (!selectedEvent?.details) return [];
    const occurred = selectedEvent.details.occurred_at_claimed;
    const eligible = beneficiaries.filter((row) => activeAt(row, occurred)
      && (row.relationship_kind === 'SITE' || row.hole_id === selectedEvent.details?.hole_id));
    const seen = new Set<string>();
    return eligible.filter((row) => {
      if (seen.has(row.party_id)) return false;
      seen.add(row.party_id);
      return true;
    });
  }, [beneficiaries, selectedEvent]);

  async function openEvent(event: ProductionEventRow) {
    setSelectedEvent(event);
    setSelectedOutputId(event.details?.outputs[0]?.id ?? '');
    setSelectedBatchId('');
    setAllocations(null);
    setError('');
    setMessage('');
    setSearchError('');
    if (event.details && event.details.outputs.length > 0) {
      setProposalEntries([{ beneficiaryPartyId: '', value: '' }]);
      setBasisMeasurementId('');
      setCorrectionSetId('');
      setCorrectionReason('');
      return;
    }
    if (event.detailError) setError(event.detailError);
  }

  function startCorrection() {
    if (!latestRevision) return;
    setCorrectionSetId(latestRevision.id);
    setBasisKind(latestRevision.basis_kind);
    setBasisMeasurementId(latestRevision.basis_measurement_id ?? '');
    setCorrectionReason('');
    setProposalEntries(latestRevision.rows.map((row) => ({
      beneficiaryPartyId: row.beneficiary_party_id,
      value: latestRevision.basis_kind === 'QUANTITY' ? row.allocated_quantity_g ?? '' : row.allocated_share ?? '',
    })));
    setMessage(`Preparing revision ${latestRevision.revision_no + 1}. The existing proposal remains in the history.`);
  }

  async function submitProposal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedEvent?.details || !selectedOutput || !actingContext) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (!canProposeAllocations) throw new Error('The active role is read-only for production proposals.');
      if (proposalEntries.length === 0 || proposalEntries.some((row) => !row.beneficiaryPartyId || !row.value.trim())) {
        throw new Error('Choose an eligible beneficiary and enter a proposed value for each row.');
      }
      const ids = proposalEntries.map((row) => row.beneficiaryPartyId);
      if (new Set(ids).size !== ids.length) throw new Error('Each beneficiary can appear only once in a proposal revision.');
      const scale = basisKind === 'QUANTITY' ? 6 : 9;
      const values = proposalEntries.map((row) => scaledDecimal(row.value.trim(), scale));
      if (values.some((value) => value === null)) throw new Error(`Enter non-negative values with no more than ${scale} decimal places.`);
      const total = values.reduce<bigint>((sum, value) => sum + (value ?? 0n), 0n);
      if (basisKind === 'SHARE' && total > 1_000_000_000n) throw new Error('Proposed shares cannot total more than 1.0.');
      if (basisKind === 'QUANTITY' && !selectedOutput.measurements.some((measurement) => measurement.id === basisMeasurementId)) {
        throw new Error('Choose an observation attached to this exact production output as the quantity basis.');
      }
      if (allocations?.revisions.length && !correctionSetId) throw new Error('A later proposal must identify the latest proposal and explain the correction.');
      if (correctionSetId && correctionSetId !== latestRevision?.id) throw new Error('Refresh allocation history and revise its latest proposal.');
      if (correctionSetId && !correctionReason.trim()) throw new Error('Explain why this proposal revision is being submitted.');
      const input = {
        basisKind,
        ...(basisKind === 'QUANTITY' ? { basisMeasurementId } : {}),
        ...(correctionSetId ? { supersedesSetId: correctionSetId, correctionReason: correctionReason.trim() } : {}),
        rows: proposalEntries.map((row) => ({
          beneficiaryPartyId: row.beneficiaryPartyId,
          ...(basisKind === 'QUANTITY' ? { allocatedQuantityGrams: row.value.trim() } : { allocatedShare: row.value.trim() }),
        })),
      };
      const payload = { siteId: selectedEvent.siteId, eventId: selectedEvent.id, outputId: selectedOutput.id, input };
      let expectedVersion: CommandEnvelope['expectedVersion'] = {
        streamKind: 'material_event', streamId: selectedEvent.id, sequence: selectedEvent.details.auditSequence,
      };
      let envelope = await createEnvelope({
        recorderUserId, actingContext, commandType: 'production.allocation.propose', payload,
        occurredAtClaimed: selectedEvent.details.occurred_at_claimed,
        actualParticipant: { identityState: 'UNKNOWN' }, expectedVersion,
      });
      if (online) {
        const current = await apiRequest<{ expectedVersion: NonNullable<CommandEnvelope['expectedVersion']> }>('/api/v1/sync/versions', token, {
          method: 'POST', body: JSON.stringify(envelope),
        });
        expectedVersion = current.expectedVersion;
        envelope = { ...envelope, expectedVersion };
        await saveReferenceCache({
          key: `audit-version:${expectedVersion.streamKind}:${expectedVersion.streamId}`, recorderUserId, contextKey,
          savedAt: new Date().toISOString(), value: expectedVersion,
        });
      } else {
        const cached = await getReferenceCache<NonNullable<CommandEnvelope['expectedVersion']>>(`audit-version:material_event:${selectedEvent.id}`);
        if (cached?.recorderUserId !== recorderUserId || cached.contextKey !== contextKey || !cached.value.sequence) {
          throw new Error('Load this event and its current version while connected before queuing an allocation proposal offline.');
        }
        expectedVersion = cached.value;
        envelope = { ...envelope, expectedVersion };
      }
      await queueCommand(envelope, contextKey);
      setTrackedMutationId(envelope.clientMutationId);
      await onCommandQueued();
      setMessage(`Proposal saved locally as ${envelope.clientMutationId}. It is not an approved agreement.`);
      if (online) {
        await synchronizeCommands(recorderUserId, token);
        await onCommandQueued();
        const command = (await listCommands(recorderUserId)).find((row: QueuedCommand) => row.envelope.clientMutationId === envelope.clientMutationId);
        if (command?.state === 'server_accepted' || command?.state === 'needs_review') {
          setMessage(`Server receipt: ${readable(command.state)}. This remains a proposal, not an approved agreement.`);
          setTrackedMutationId('');
        } else if (command?.state === 'conflict' || command?.state === 'rejected') {
          setError(`${readable(command.state)}: ${command.receipt?.error?.message ?? command.lastError ?? 'The server did not accept this proposal.'}`);
          setMessage('The command and its mutation ID remain in the queue for review.');
          setTrackedMutationId('');
        }
        const history = await apiRequest<AllocationHistory>(
          `/api/v1/sites/${selectedEvent.siteId}/production-events/${selectedEvent.id}/outputs/${selectedOutput.id}/allocation-sets`, token,
        );
        setAllocations(history);
        await saveReferenceCache({
          key: `production-allocations:${selectedEvent.siteId}:${selectedEvent.id}:${selectedOutput.id}`,
          recorderUserId, contextKey, savedAt: new Date().toISOString(), value: history,
        });
        if (history.revisions.length) {
          setProposalEntries([{ beneficiaryPartyId: '', value: '' }]);
          setCorrectionSetId('');
          setCorrectionReason('');
        }
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'The allocation proposal could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  return <>
    <WorkspaceHeading
      eyebrow="PRODUCTION RECORDS"
      title="Production events and batches"
      description="Review authorized production records, their output batches and observations. Proposed allocations remain subject to separate review."
      action={<button className="secondary" type="button" onClick={() => void loadRegister()} disabled={loading || !online}>{loading ? 'Refreshing…' : 'Refresh register'}</button>}
    />
    {!online && <div className="notice warning">Offline view uses references cached for this recorder and active role. New commands remain local until connection returns; server authorization is checked during sync.</div>}
    {error && <div className="notice error" role="alert">{error}</div>}
    {message && <div className="notice success" role="status">{message}</div>}

    {canProposeAllocations && <section className="queue-section" aria-labelledby="production-capture-heading">
      <div className="section-heading"><div><p className="eyebrow">EXISTING OFFLINE CAPTURE</p><h2 id="production-capture-heading">Record production</h2></div><span className="local-badge">Saved locally first</span></div>
      {sites.length === 0 ? <p className="muted">The server has not returned any site references available for this active role.</p> : <div className="form-grid">
        <label>Site for this production event<select aria-label="Production site" value={captureSiteId} onChange={(event) => { setCaptureSiteId(event.target.value); setCaptureHoleId(''); }}>
          <option value="">Choose an authorized site</option>{sites.map((site) => <option key={site.id} value={site.id}>{site.name} · {site.siteCode}</option>)}
        </select></label>
        <label>Hole for this production event<select aria-label="Production hole" value={captureHoleId} onChange={(event) => setCaptureHoleId(event.target.value)} disabled={!captureSiteId}>
          <option value="">Choose a hole at the selected site</option>{captureHoles.map((hole) => <option key={hole.id} value={hole.id}>{hole.holeCode}{hole.name ? ` · ${hole.name}` : ''}</option>)}
        </select></label>
        <button className="primary" type="button" disabled={!captureSiteId || !captureHoleId} onClick={() => onRecordProduction(captureSiteId, captureHoleId)}>Continue to production capture</button>
        <p className="field-note span-two">Capture opens the existing structured form for participant relationship, occurrence time and source provenance. It queues the established production command; the server checks current role and scope.</p>
      </div>}
    </section>}

    <section className="queue-section" aria-labelledby="production-register-heading">
      <div className="section-heading"><div><p className="eyebrow">AUTHORIZED EVENT HISTORY</p><h2 id="production-register-heading">Production register <span className="count">{visibleEvents.length}</span></h2></div></div>
      <div className="form-grid production-filters">
        <label>Site<select aria-label="Filter production site" value={selectedSiteFilter} onChange={(event) => setSelectedSiteFilter(event.target.value)}><option value="all">All accessible sites</option>{sites.map((site) => <option key={site.id} value={site.id}>{site.name} · {site.siteCode}</option>)}</select></label>
        <label>Search event, site, hole or material<input value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        <label>From date<input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /></label>
        <label>To date<input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} /></label>
      </div>
      {loading ? <div className="empty-state" role="status">Loading production events…</div> : visibleEvents.length === 0 ? <div className="empty-state">No authorized production events match these filters.</div> : <div className="table-wrap"><table className="data-table"><thead><tr><th>Reference</th><th>Site / hole</th><th>Production date</th><th>Material</th><th>Recorded status</th><th>Details</th></tr></thead><tbody>
        {visibleEvents.map((event) => <tr key={event.id}><td><strong>{event.event_code}</strong><small>{event.id}</small></td><td>{event.siteName}<small>{event.hole_code}</small></td><td>{displayDate(event.occurred_at_claimed)}</td><td>{event.details?.outputs.map((output) => readable(output.material_kind)).join(', ') ?? (event.detailError ? 'Details unavailable' : `${event.output_count} output(s)`)}</td><td>{readable(event.current_status)}</td><td><button className="small-button" type="button" onClick={() => void openEvent(event)} disabled={!event.details}>Open event</button></td></tr>)}
      </tbody></table></div>}
    </section>

    {selectedEvent?.details && <section className="queue-section production-detail" aria-labelledby="production-detail-heading">
      <div className="section-heading"><div><p className="eyebrow">EVENT DETAIL</p><h2 id="production-detail-heading">{selectedEvent.details.event_code}</h2></div><button className="secondary" type="button" onClick={() => setSelectedEvent(null)}>Close detail</button></div>
      <dl className="detail-list"><div><dt>Site</dt><dd>{selectedEvent.siteName} · {selectedEvent.siteId}</dd></div><div><dt>Hole</dt><dd>{selectedEvent.details.hole_code} · {selectedEvent.details.hole_id}</dd></div><div><dt>Production date</dt><dd>{displayDate(selectedEvent.details.occurred_at_claimed)}</dd></div><div><dt>Recorded at</dt><dd>{displayDate(selectedEvent.details.recorded_at)}</dd></div><div><dt>Server status</dt><dd>{readable(selectedEvent.details.current_status)}</dd></div><div><dt>Server event version</dt><dd>{selectedEvent.details.auditSequence}</dd></div></dl>
      <section className="production-subsection" aria-labelledby="production-participants-heading"><h3 id="production-participants-heading">Recorded participants and capture provenance</h3>
        {selectedEvent.details.participants.length === 0 ? <p className="muted">No participant relationships were recorded on this event.</p> : <ul className="grant-list">{selectedEvent.details.participants.map((participant) => <li key={participant.relationship_id}><strong>{readable(participant.role_code)}</strong> · {readable(participant.relationship_kind)} relationship · {participant.party_id} <small>Relationship {participant.relationship_id}</small></li>)}</ul>}
        {selectedEvent.details.captureProvenance ? <div className="notice info"><strong>Actual participant identity: {readable(selectedEvent.details.captureProvenance.participant_identity_state)}</strong><p>Source: {readable(selectedEvent.details.captureProvenance.source_kind)} · claimed {displayDate(selectedEvent.details.captureProvenance.occurred_at_claimed)} · entered {displayDate(selectedEvent.details.captureProvenance.entered_at)}</p><p>Actual participant party: {selectedEvent.details.captureProvenance.actual_participant_party_id ?? 'Not identified'} · source reference: {selectedEvent.details.captureProvenance.source_reference ?? 'None recorded'} · evidence reference: {selectedEvent.details.captureProvenance.evidence_ref ?? 'None recorded'}</p>{selectedEvent.details.captureProvenance.acknowledgement_status && <p>Participant response: {readable(selectedEvent.details.captureProvenance.acknowledgement_status)}. A response is recorded separately from the recorder’s production entry.</p>}</div> : <p className="muted">No capture provenance was returned for this event.</p>}
      </section>
      <section className="production-subsection" aria-labelledby="production-batches-heading"><h3 id="production-batches-heading">Production output batches</h3>
        <div className="production-output-grid">{selectedEvent.details.outputs.map((output) => <article className="overview-card production-output" key={output.id}><span className="label">Original production material</span><strong>{output.batch_code}</strong><p>{readable(output.material_kind)} · batch {output.batch_id}</p><p>Output reference {output.id} · recorded in event {selectedEvent.details?.event_code}</p><button className="small-button" type="button" onClick={() => { setSelectedOutputId(output.id); setSelectedBatchId(output.batch_id); }}>Open batch detail</button></article>)}</div>
        {selectedBatchId && <div className="notice info production-batch-detail"><h4>Batch record {selectedOutput?.batch_code ?? selectedBatchId}</h4><p>Batch ID {selectedBatchId} · material {readable(selectedOutput?.material_kind)} · source production event {selectedEvent.details.event_code}.</p><p>This view is grounded in the production event output. No batch collection or processing-genealogy endpoint is exposed by the current API, so downstream transformations are not asserted here.</p><button className="small-button" type="button" onClick={() => setSelectedBatchId('')}>Close batch detail</button></div>}
      </section>
      <section className="production-subsection" aria-labelledby="production-observations-heading"><h3 id="production-observations-heading">Measurements and observation history</h3>
        {selectedEvent.details.outputs.map((output) => <article className="production-observation-group" key={output.id}><h4>{output.batch_code} · {readable(output.material_kind)}</h4>{output.measurements.length === 0 ? <p className="muted">No quantity observations are recorded for this output.</p> : <div className="table-wrap"><table className="data-table"><thead><tr><th>Observation</th><th>Quantity</th><th>Source value</th><th>Source</th><th>Occurred / entered</th><th>Correction link</th></tr></thead><tbody>{output.measurements.map((measurement) => <tr key={measurement.id}><td>{readable(measurement.measurement_kind)}<small>{measurement.id}</small></td><td>{measurement.quantity_g} g</td><td>{measurement.source_value} {measurement.source_unit_code}<small>Conversion {measurement.conversion_version}</small></td><td>{readable(measurement.source_role)}<small>{measurement.source_party_id ?? 'No source party'}</small></td><td>{displayDate(measurement.occurred_at_claimed)}<small>entered {displayDate(measurement.entered_at)}</small></td><td>{measurement.supersedes_measurement_id ?? 'Original observation'}{measurement.method_code && <small>Method {measurement.method_code}</small>}{measurement.instrument_ref && <small>Instrument {measurement.instrument_ref}</small>}</td></tr>)}</tbody></table></div>}</article>)}
      </section>
      <section className="production-subsection" aria-labelledby="production-allocations-heading"><h3 id="production-allocations-heading">Proposed allocations and history</h3>
        {allocations?.activeApprovedSetId ? <div className="notice warning">The API reports an active approved allocation record. This workspace does not create or change approval decisions.</div> : <p className="muted">Proposals are not approved agreements. No automatic share or financial entitlement is inferred from participant categories or relationships.</p>}
        {searchError && <p role="alert" className="error">{searchError}</p>}
        {!allocations ? <p className="muted">Loading allocation history…</p> : allocations.revisions.length === 0 ? <p className="muted">No allocation proposal has been recorded for this output.</p> : <div className="allocation-history">{allocations.revisions.map((revision) => <article className="queue-item" key={revision.id}><div className="queue-main"><div className="queue-title"><strong>Revision {revision.revision_no} · {readable(revision.revision_kind)}</strong><span className="state-pill">Proposal · {readable(revision.reviewHistory.at(-1)?.review_status ?? 'UNKNOWN')}</span></div><p className="queue-meta">Basis: {revision.basis_kind === 'QUANTITY' ? `quantity from observation ${revision.basis_measurement_id}` : 'proposed share'} · created {displayDate(revision.created_at)} · proposer user {revision.proposed_by_user_id}</p>{revision.supersedes_set_id && <p className="queue-meta">Supersedes {revision.supersedes_set_id}. Reason: {revision.correction_reason}</p>}<ul>{revision.rows.map((row) => <li key={row.id}>{row.beneficiary_party_id}: {row.allocation_basis === 'QUANTITY' ? `${row.allocated_quantity_g} g proposed` : `${row.allocated_share} proposed share`}</li>)}</ul>{revision.reviewHistory.map((review, index) => <p className="queue-meta" key={`${revision.id}:${index}`}>Review record: {readable(review.review_status)}{review.reason ? ` · ${review.reason}` : ''}{review.evidence_ref ? ` · evidence ${review.evidence_ref}` : ''}</p>)}</div></article>)}</div>}
        {canProposeAllocations && Boolean(allocations?.revisions.length) && canReviseLatest && !correctionSetId && <button className="secondary" type="button" onClick={startCorrection}>Prepare revision {latestRevision!.revision_no + 1}</button>}
        {canProposeAllocations && allocations && !searchError && (!allocations.revisions.length || Boolean(correctionSetId)) && <form className="allocation-form" onSubmit={(event) => void submitProposal(event)}>
          <h4>{correctionSetId ? `Revise proposal ${latestRevision?.revision_no ?? ''}` : 'New allocation proposal'}</h4>
          <p className="field-note">These rows record a proposal for review. They do not establish ownership, entitlement, agreement or approval.</p>
          <div className="form-grid">
            <label>Proposal basis<select value={basisKind} onChange={(event) => { const next = event.target.value as 'QUANTITY' | 'SHARE'; setBasisKind(next); setProposalEntries([{ beneficiaryPartyId: '', value: '' }]); setBasisMeasurementId(''); }}><option value="SHARE">Proposed share</option><option value="QUANTITY">Quantity from an observation</option></select></label>
            {basisKind === 'QUANTITY' && <label>Exact output observation<select aria-label="Allocation quantity basis" value={basisMeasurementId} onChange={(event) => setBasisMeasurementId(event.target.value)}><option value="">Choose a recorded observation</option>{selectedOutput?.measurements.map((measurement) => <option key={measurement.id} value={measurement.id}>{readable(measurement.measurement_kind)} · {measurement.quantity_g} g · {measurement.id}</option>)}</select></label>}
            {proposalEntries.map((entry, index) => <div className="allocation-row span-two" key={index}>
              <label>Recorded beneficiary relationship<select aria-label={`Beneficiary ${index + 1}`} value={entry.beneficiaryPartyId} onChange={(event) => setProposalEntries((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, beneficiaryPartyId: event.target.value } : row))}><option value="">Choose a recorded beneficiary relationship</option>{eligibleBeneficiaries.map((beneficiary) => <option key={beneficiary.relationship_id} value={beneficiary.party_id}>{beneficiary.display_name} · {readable(beneficiary.relationship_kind)} BENEFICIARY relationship · {beneficiary.relationship_id}</option>)}</select></label>
              <label>{basisKind === 'QUANTITY' ? 'Proposed quantity (grams)' : 'Proposed share (0 to 1)'}<input inputMode="decimal" aria-label={`Proposed value ${index + 1}`} value={entry.value} onChange={(event) => setProposalEntries((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, value: event.target.value } : row))} /></label>
              {proposalEntries.length > 1 && <button className="small-button" type="button" onClick={() => setProposalEntries((rows) => rows.filter((_, rowIndex) => rowIndex !== index))}>Remove beneficiary</button>}
            </div>)}
            <button className="secondary" type="button" onClick={() => setProposalEntries((rows) => [...rows, { beneficiaryPartyId: '', value: '' }])}>Add beneficiary row</button>
            {correctionSetId && <label className="span-two">Correction reason<input value={correctionReason} onChange={(event) => setCorrectionReason(event.target.value)} required maxLength={500} /></label>}
          </div>
          {eligibleBeneficiaries.length === 0 && <p className="field-note">No active recorded BENEFICIARY relationship effective at this production date is available. Other participant categories are not treated as beneficiaries.</p>}
          <div className="form-actions"><button className="primary" type="submit" disabled={busy || !selectedOutput || eligibleBeneficiaries.length === 0 || Boolean(correctionSetId && !canReviseLatest)}>{busy ? 'Saving…' : online ? 'Save proposed allocation' : 'Queue allocation proposal'}</button></div>
        </form>}
        {!online && canProposeAllocations && <p className="field-note">A proposal can be queued offline only after this event and its expected version, allocation history and eligible beneficiary references were loaded while connected. The server will check current authorization and version when it synchronizes.</p>}
      </section>
    </section>}
  </>;
}
