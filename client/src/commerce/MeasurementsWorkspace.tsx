import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { apiRequest, type SiteReference } from '../api';
import {
  activeMeasurementStatus, actingPartyId, displayDate, gramsFromSource, readable, toDateTimeInput,
  type ActingRole, type GoldTrade, type GoldTradeLine, type GoldTradeMeasurement, type GoldAssay,
  type ProductionEvent, type ProductionMeasurement, type ProcessingEvent, type ProcessingItem,
} from './types';

const TRADE_PARTICIPANT_ROLES = new Set([
  'FIELD_OFFICER', 'MINING_OPERATOR', 'MINER', 'DORA_OPERATOR', 'RECOVERY_FACILITY_OPERATOR', 'LOCAL_MERCHANT', 'LARGER_MERCHANT',
]);
const PRODUCTION_READER_ROLES = new Set(['FIELD_OFFICER', 'MINING_OPERATOR', 'MINER', 'AUDITOR']);
const SOURCE_ROLE_OPTIONS = ['RECORDER', 'WITNESS', 'WEIGHER', 'OTHER'];

interface Props {
  token: string;
  personPartyId: string;
  actingRole: ActingRole | null;
  roles: ActingRole[];
  sites: SiteReference[];
  online: boolean;
  trade: GoldTrade | null;
  write: <T>(path: string, body: unknown) => Promise<T>;
  refreshTrade: () => Promise<GoldTrade | null>;
  onError: (message: string) => void;
  onMessage: (message: string) => void;
}

type TradeFormState = { lineId: string; kind: 'measurement' | 'assay'; correctionId?: string } | null;

function asError(error: unknown): string {
  return error instanceof Error ? error.message : 'The request could not be completed.';
}

function canWriteProduction(role: ActingRole | null, siteId: string, holeId: string, sites: SiteReference[]): boolean {
  if (!role || !['FIELD_OFFICER', 'MINING_OPERATOR'].includes(role.roleCode)) return false;
  if (role.scopeKind === 'PILOT') return role.roleCode === 'FIELD_OFFICER' && role.scopeId === 'default';
  if (role.scopeKind === 'SITE') return role.scopeId === siteId;
  if (role.scopeKind === 'HOLE') return role.scopeId === holeId;
  return role.scopeKind === 'ORGANISATION' && sites.some((site) => site.id === siteId);
}

function canWriteProcessing(role: ActingRole | null, allRoles: ActingRole[], event: ProcessingEvent, sites: SiteReference[]): boolean {
  const facilityGrant = role?.roleCode === 'DORA_OPERATOR'
    && (role.scopeKind === 'ORGANISATION' || (role.scopeKind === 'FACILITY' && role.scopeId === event.processing_facility_id));
  if (!facilityGrant) return false;
  const sourceSites = event.sourceSiteIds ?? [];
  const sourceHoles = event.sourceHoleIds ?? [];
  if (!sourceSites.length || !sourceHoles.length) return false;
  const sourceSitesCovered = sourceSites.every((siteId) => allRoles.some((grant) => {
    if (!['FIELD_OFFICER', 'MINING_OPERATOR'].includes(grant.roleCode)) return false;
    return (grant.scopeKind === 'PILOT' && grant.roleCode === 'FIELD_OFFICER' && grant.scopeId === 'default')
      || (grant.scopeKind === 'SITE' && grant.scopeId === siteId)
      || (grant.scopeKind === 'ORGANISATION' && sites.some((site) => site.id === siteId));
  }));
  const sourceHolesCovered = sourceHoles.every((holeId) => allRoles.some((grant) => {
    if (!['FIELD_OFFICER', 'MINING_OPERATOR'].includes(grant.roleCode)) return false;
    if (grant.scopeKind === 'HOLE') return grant.scopeId === holeId;
    if (grant.scopeKind === 'PILOT') return grant.roleCode === 'FIELD_OFFICER' && grant.scopeId === 'default';
    return sourceSites.length === 1 && grant.scopeKind === 'SITE' && grant.scopeId === sourceSites[0];
  }));
  return sourceSitesCovered && sourceHolesCovered;
}

function measurementSummary(measurements: ProductionMeasurement[]): string {
  if (!measurements.length) return 'No measurement is recorded for this source yet.';
  return `${measurements.length} recorded observation${measurements.length === 1 ? '' : 's'}; declared, measured and verified kinds remain distinct.`;
}

function MeasurementForm({
  contextLabel, onSubmit, online, children, sourceParticipants,
}: {
  contextLabel: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<boolean>;
  online: boolean;
  children: ReactNode;
  sourceParticipants?: NonNullable<ProductionEvent['participants']>;
}) {
  const [sourceValue, setSourceValue] = useState('');
  const [sourceUnit, setSourceUnit] = useState('g');
  const [sourceRole, setSourceRole] = useState('RECORDER');
  const [busy, setBusy] = useState(false);
  const grams = gramsFromSource(sourceValue, sourceUnit);

  return (
    <form className="form-stack" aria-label={`Record measurement for ${contextLabel}`} onSubmit={async (event) => {
      event.preventDefault();
      if (!grams) return;
      const form = event.currentTarget;
      setBusy(true);
      try {
        if (await onSubmit(event)) {
          form.reset();
          setSourceValue('');
          setSourceUnit('g');
          setSourceRole('RECORDER');
        }
      } finally { setBusy(false); }
    }}>
      <div className="form-grid">
        <label>Observation kind<select name="kind" defaultValue="MEASURED"><option value="DECLARED">Declared by a party</option><option value="MEASURED">Measured observation</option></select></label>
        <label>Source value<input name="sourceValue" value={sourceValue} onChange={(event) => setSourceValue(event.target.value)} inputMode="decimal" pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]{1,12})?" required /></label>
        <label>Source unit<select name="sourceUnit" value={sourceUnit} onChange={(event) => setSourceUnit(event.target.value)}><option value="g">g</option><option value="kg">kg</option><option value="mg">mg</option></select></label>
        <label>Canonical quantity (g)<input aria-label="Canonical quantity (g)" value={grams ?? 'Enter a source value exactly representable to 6 decimal grams'} readOnly /></label>
        <label>Source role<select name="sourceRole" value={sourceRole} onChange={(event) => setSourceRole(event.target.value)}>{SOURCE_ROLE_OPTIONS.map((role) => <option value={role} key={role}>{readable(role)}</option>)}</select></label>
        {sourceRole !== 'RECORDER' && (sourceParticipants?.length ? <label>Source participant party ID<select name="sourcePartyId" defaultValue="" required><option value="">Choose a participant on this event</option>{sourceParticipants.map((participant) => <option key={participant.relationship_id} value={participant.party_id}>{participant.party_id} · {readable(participant.role_code)} · {readable(participant.relationship_kind)} relationship</option>)}</select></label> : <label>Source participant party ID<input name="sourcePartyId" required /></label>)}
        <label>Method code<input name="methodCode" maxLength={80} /></label>
        <label>Instrument reference<input name="instrumentRef" maxLength={160} /></label>
        <label>Occurred at<input type="datetime-local" name="occurredAt" defaultValue={toDateTimeInput()} required /></label>
        <label>Evidence reference<input name="evidenceRef" maxLength={255} /></label>
      </div>
      <p className="muted">Only DECLARED or MEASURED can be recorded here. VERIFIED is shown only when the backend has already recorded it. This form does not certify a scale or laboratory result.</p>
      {children}
      <button className="primary" type="submit" disabled={!online || busy || !grams}>{busy ? 'Recording…' : 'Record observation'}</button>
    </form>
  );
}

function showMeasurement(measurement: ProductionMeasurement, all: ProductionMeasurement[]) {
  return (
    <article className="overview-card" key={measurement.id}>
      <div className="section-heading"><h4>{readable(measurement.measurement_kind)} · {measurement.quantity_g} g</h4><span className="label">{activeMeasurementStatus(measurement, all)}</span></div>
      <p>Source: {measurement.source_value} {measurement.source_unit_code} · {measurement.conversion_version}</p>
      <p>Role: {readable(measurement.source_role)} · source party {measurement.source_party_id ?? 'not returned'}</p>
      <p>Method: {measurement.method_code ?? 'not recorded'} · instrument {measurement.instrument_ref ?? 'not recorded'}</p>
      <p>Occurred: {displayDate(measurement.occurred_at_claimed)} · entered: {displayDate(measurement.entered_at)}</p>
      <p>Recorder: {measurement.entered_by_user_id ?? 'not returned by this source-detail API'} · evidence: {measurement.evidence_ref ?? 'not returned by this source-detail API'}</p>
      {measurement.supersedes_measurement_id && <small>Correction predecessor: {measurement.supersedes_measurement_id}</small>}
      <small>Measurement {measurement.id} · set {measurement.measurement_set_id}</small>
    </article>
  );
}

export function MeasurementsWorkspace({ token, personPartyId, actingRole, roles, sites, online, trade, write, refreshTrade, onError, onMessage }: Props) {
  const canReadProduction = Boolean(actingRole && PRODUCTION_READER_ROLES.has(actingRole.roleCode));
  const canReadProcessing = Boolean(actingRole && ['FIELD_OFFICER', 'MINING_OPERATOR', 'MINER', 'DORA_OPERATOR', 'AUDITOR'].includes(actingRole.roleCode));
  const [sourceTab, setSourceTab] = useState<'production' | 'processing'>('production');
  const [loadingSources, setLoadingSources] = useState(false);
  const [productionEvents, setProductionEvents] = useState<ProductionEvent[]>([]);
  const [processingEvents, setProcessingEvents] = useState<ProcessingEvent[]>([]);
  const [sourceError, setSourceError] = useState('');
  const [selectedProduction, setSelectedProduction] = useState<ProductionEvent | null>(null);
  const [selectedProcessing, setSelectedProcessing] = useState<ProcessingEvent | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [activeTradeForm, setActiveTradeForm] = useState<TradeFormState>(null);

  useEffect(() => {
    if (!online) return;
    let current = true;
    setLoadingSources(true);
    setSourceError('');
    const productionRequest = canReadProduction
      ? Promise.all(sites.map(async (site) => {
        const rows = await apiRequest<Omit<ProductionEvent, 'siteId' | 'siteName'>[]>(`/api/v1/sites/${site.id}/production-events`, token);
        return rows.map((row) => ({ ...row, siteId: site.id, siteName: site.name }));
      })).then((groups) => groups.flat()).catch((error: unknown) => {
        if (current) setSourceError((message) => [message, `Production sources: ${asError(error)}`].filter(Boolean).join(' '));
        return [] as ProductionEvent[];
      })
      : Promise.resolve([] as ProductionEvent[]);
    const processingRequest = canReadProcessing
      ? apiRequest<ProcessingEvent[]>('/api/v1/processing-events', token).catch((error: unknown) => {
        if (current) setSourceError((message) => [message, `Processing sources: ${asError(error)}`].filter(Boolean).join(' '));
        return [] as ProcessingEvent[];
      })
      : Promise.resolve([] as ProcessingEvent[]);
    void Promise.all([productionRequest, processingRequest]).then(([production, processing]) => {
      if (!current) return;
      setProductionEvents(production);
      setProcessingEvents(processing);
      if (!canReadProduction && canReadProcessing) setSourceTab('processing');
      setLoadingSources(false);
    });
    return () => { current = false; };
  }, [canReadProcessing, canReadProduction, online, sites, token]);

  const activeParty = actingPartyId(personPartyId, actingRole);
  const ambiguousTradeParty = Boolean(trade && partyMayBeRepresented(personPartyId, roles, trade.seller_party_id) && partyMayBeRepresented(personPartyId, roles, trade.buyer_party_id));
  const canReviewTrade = Boolean(actingRole && TRADE_PARTICIPANT_ROLES.has(actingRole.roleCode)
    && !['AUDITOR', 'SYSTEM_ADMIN'].includes(actingRole.roleCode) && !ambiguousTradeParty
    && trade && [trade.seller_party_id, trade.buyer_party_id].includes(activeParty));

  const openProduction = async (row: ProductionEvent) => {
    setLoadingDetail(true);
    setSelectedProcessing(null);
    setSelectedProduction(row);
    setSourceError('');
    try {
      const detail = await apiRequest<ProductionEvent>(`/api/v1/sites/${row.siteId}/production-events/${row.id}`, token);
      setSelectedProduction({ ...row, ...detail });
    } catch (error) { setSourceError(asError(error)); }
    finally { setLoadingDetail(false); }
  };

  const openProcessing = async (row: ProcessingEvent) => {
    setLoadingDetail(true);
    setSelectedProduction(null);
    setSelectedProcessing(row);
    setSourceError('');
    try {
      const detail = await apiRequest<ProcessingEvent>(`/api/v1/processing-events/${row.id}`, token);
      setSelectedProcessing({ ...row, ...detail });
    } catch (error) { setSourceError(asError(error)); }
    finally { setLoadingDetail(false); }
  };

  const recordSourceMeasurement = async (event: FormEvent<HTMLFormElement>, path: string, refresh: () => Promise<unknown>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const sourceValue = String(data.get('sourceValue'));
    const sourceUnit = String(data.get('sourceUnit'));
    const quantityGrams = gramsFromSource(sourceValue, sourceUnit);
    if (!quantityGrams) { onError('Enter a source value that converts exactly to six decimal places in grams.'); return false; }
    const occurredAt = new Date(String(data.get('occurredAt')));
    if (Number.isNaN(occurredAt.getTime())) { onError('Enter a valid observation time.'); return false; }
    const sourceRole = String(data.get('sourceRole'));
    const sourcePartyId = String(data.get('sourcePartyId') ?? '').trim();
    if (sourceRole !== 'RECORDER' && !sourcePartyId) { onError('Enter the source participant party ID.'); return false; }
    try {
      await write(path, {
        kind: String(data.get('kind')),
        quantityGrams,
        sourceValue,
        sourceUnit,
        conversionVersion: 'canonical-mass-v1',
        sourceRole,
        ...(sourcePartyId ? { sourcePartyId } : {}),
        ...(data.get('methodCode') ? { methodCode: String(data.get('methodCode')) } : {}),
        ...(data.get('instrumentRef') ? { instrumentRef: String(data.get('instrumentRef')) } : {}),
        occurredAt: occurredAt.toISOString(),
        ...(data.get('evidenceRef') ? { evidenceRef: String(data.get('evidenceRef')) } : {}),
      });
      onError('');
      onMessage('The server recorded the observation. Refreshing the authorized source detail to show its history.');
      await refresh();
      return true;
    } catch (error) { onError(asError(error)); return false; }
  };

  return (
    <>
      {sourceError && <div className="notice error" role="alert">{sourceError}</div>}
      <section className="queue-section" aria-labelledby="measurement-register-heading">
        <div className="section-heading"><div><p className="eyebrow">AUTHORIZED SOURCE RECORDS</p><h2 id="measurement-register-heading">Measurement register</h2></div></div>
        <div className="workspace-tabs" role="tablist" aria-label="Measurement source registers">
          <button type="button" role="tab" aria-selected={sourceTab === 'production'} onClick={() => { setSourceTab('production'); setSelectedProcessing(null); }}>Production events</button>
          <button type="button" role="tab" aria-selected={sourceTab === 'processing'} onClick={() => { setSourceTab('processing'); setSelectedProduction(null); }}>Processing events</button>
        </div>
        {!online && <div className="empty-state">Source registers and details require an online, authenticated request.</div>}
        {online && loadingSources && <div className="empty-state" role="status">Loading authorized source events…</div>}
        {online && !loadingSources && sourceTab === 'production' && !canReadProduction && <div className="empty-state">The active role has no production-event read route. The server grants event access by site and hole scope.</div>}
        {online && !loadingSources && sourceTab === 'processing' && !canReadProcessing && <div className="empty-state">The active role has no processing-event read route. The server checks both processing-facility and source-hole access.</div>}
        {online && !loadingSources && sourceTab === 'production' && canReadProduction && productionEvents.length === 0 && <div className="empty-state">No authorized production events are available for the loaded site references.</div>}
        {online && !loadingSources && sourceTab === 'processing' && canReadProcessing && processingEvents.length === 0 && <div className="empty-state">No processing events are visible under both the active facility and source-hole grants.</div>}
        {online && !loadingSources && sourceTab === 'production' && productionEvents.length > 0 && <div className="table-wrap"><table className="data-table"><thead><tr><th>Event</th><th>Site / hole</th><th>Occurred</th><th>Status</th><th>Outputs</th></tr></thead><tbody>{productionEvents.map((row) => <tr key={row.id}><td><button className="link-button" type="button" onClick={() => void openProduction(row)}>{row.event_code}</button><small>{row.id}</small></td><td>{row.siteName}<small>{row.hole_code} · {row.hole_id}</small></td><td>{displayDate(row.occurred_at_claimed)}</td><td>{readable(row.current_status)}</td><td>{row.output_count}</td></tr>)}</tbody></table></div>}
        {online && !loadingSources && sourceTab === 'processing' && processingEvents.length > 0 && <div className="table-wrap"><table className="data-table"><thead><tr><th>Event</th><th>Facility</th><th>Occurred</th><th>Status</th><th>Inputs / outputs</th></tr></thead><tbody>{processingEvents.map((row) => <tr key={row.id}><td><button className="link-button" type="button" onClick={() => void openProcessing(row)}>{row.event_code}</button><small>{row.id}</small></td><td>{row.processing_facility_name}<small>{row.processing_facility_id}</small></td><td>{displayDate(row.occurred_at_claimed)}</td><td>{readable(row.current_status)}</td><td>{row.input_count} / {row.output_count}</td></tr>)}</tbody></table></div>}
      </section>

      {loadingDetail && <div role="status" className="empty-state">Loading source detail and recorded observations…</div>}
      {selectedProduction?.outputs && <section className="queue-section" aria-labelledby="production-measurement-detail-heading">
        <div className="section-heading"><div><p className="eyebrow">{selectedProduction.event_code} · {selectedProduction.siteName} · {selectedProduction.hole_code}</p><h2 id="production-measurement-detail-heading">Source event and measurement history</h2></div></div>
        <p>Status {readable(selectedProduction.current_status)} · event occurrence {displayDate(selectedProduction.occurred_at_claimed)} · {selectedProduction.outputs.length} output records</p>
        {selectedProduction.outputs.map((output) => <article className="overview-card" key={output.id}>
          <h3>{output.batch_code} · {readable(output.material_kind)}</h3>
          <p>Source production output {output.id} · batch {output.batch_id} · measurement set {output.measurement_set_id}</p>
          <p>{measurementSummary(output.measurements)}</p>
          {output.measurements.map((measurement) => showMeasurement(measurement, output.measurements))}
          {canWriteProduction(actingRole, selectedProduction.siteId, selectedProduction.hole_id, sites) && <MeasurementForm contextLabel={output.batch_code} online={online} sourceParticipants={selectedProduction.participants} onSubmit={(event) => recordSourceMeasurement(event, `/api/v1/sites/${selectedProduction.siteId}/production-events/${selectedProduction.id}/outputs/${output.id}/measurements`, async () => {
            const detail = await apiRequest<ProductionEvent>(`/api/v1/sites/${selectedProduction.siteId}/production-events/${selectedProduction.id}`, token);
            setSelectedProduction({ ...selectedProduction, ...detail });
          })}><small>Record against this production output; the backend validates source attribution and the active hole grant.</small></MeasurementForm>}
          {!canWriteProduction(actingRole, selectedProduction.siteId, selectedProduction.hole_id, sites) && <p className="muted">Read-only for the current role and scope. Historical records remain visible; this workspace does not edit or replace them.</p>}
        </article>)}
        <p className="notice info">This event-detail API does not return the measurement recorder ID or evidence reference. Those fields are shown as unavailable rather than inferred from the session.</p>
      </section>}

      {selectedProcessing?.inputs && selectedProcessing.outputs && <section className="queue-section" aria-labelledby="processing-measurement-detail-heading">
        <div className="section-heading"><div><p className="eyebrow">{selectedProcessing.event_code} · {selectedProcessing.processing_facility_name}</p><h2 id="processing-measurement-detail-heading">Processing sources and measurement history</h2></div></div>
        <p>Facility {selectedProcessing.processing_facility_id} · occurrence {displayDate(selectedProcessing.occurred_at_claimed)} · source holes {selectedProcessing.sourceHoleIds?.join(', ') ?? 'not returned'}</p>
        {[...selectedProcessing.inputs.map((item) => ({ ...item, kind: 'input' as const })), ...selectedProcessing.outputs.map((item) => ({ ...item, kind: 'output' as const }))].map((item) => <ProcessingMeasurementCard
          key={`${item.kind}:${item.id}`}
          item={item}
          itemKind={item.kind}
          event={selectedProcessing}
          token={token}
          sites={sites}
          actingRole={actingRole}
          roles={roles}
          online={online}
          onRecord={(event) => recordSourceMeasurement(event, `/api/v1/processing-events/${selectedProcessing.id}/${item.kind === 'input' ? 'inputs' : 'outputs'}/${item.id}/measurements`, async () => {
            const detail = await apiRequest<ProcessingEvent>(`/api/v1/processing-events/${selectedProcessing.id}`, token);
            setSelectedProcessing({ ...selectedProcessing, ...detail });
          })}
        />)}
        <p className="notice info">The processing-detail API returns source and recorder IDs, method and timestamps, but not measurement evidence references. No assay is implied by a recorded weight.</p>
      </section>}

      <section className="queue-section" aria-labelledby="trade-measurements-heading">
        <div className="section-heading"><div><p className="eyebrow">GOLD TRADE DETAIL</p><h2 id="trade-measurements-heading">Trade observations and assay records</h2></div></div>
        {!trade && <div className="empty-state">Open a party-authorized trade above to inspect its measurement and assay history.</div>}
        {trade && <>
          <p>{trade.trade_code} · {readable(trade.status)} · seller {trade.seller_party_id} · buyer {trade.buyer_party_id}</p>
          <p className="notice info">An assay record is an observation, not proof of laboratory certification. Trade measurements require exact conversion to grams. Corrections append a successor and require the original record and a reason.</p>
          {trade.lines.map((line) => <TradeObservationCard
            key={line.id}
            line={line}
            trade={trade}
            actingRole={actingRole}
            online={online}
            activeForm={activeTradeForm}
            setActiveForm={setActiveTradeForm}
            write={write}
            refreshTrade={refreshTrade}
            onError={onError}
            onMessage={onMessage}
            canWrite={Boolean(canReviewTrade)}
          />)}
          {actingRole?.roleCode === 'AUDITOR' && <p className="muted">Auditor access is read-only. The current backend trade-detail route requires seller or buyer party representation; an Auditor grant alone does not authorize this response.</p>}
          {ambiguousTradeParty && <p className="notice warning">Trade observation writes are disabled because the API has no explicit acting-party field and this account can represent both trade parties.</p>}
        </>}
      </section>
    </>
  );
}

function partyMayBeRepresented(personPartyId: string, roles: ActingRole[], partyId: string): boolean {
  if (personPartyId === partyId) return true;
  return roles.some((role) => TRADE_PARTICIPANT_ROLES.has(role.roleCode) && role.scopeKind === 'ORGANISATION' && role.scopeId === partyId);
}

function ProcessingMeasurementCard({
  item, itemKind, event, token, sites, actingRole, roles, online, onRecord,
}: {
  item: ProcessingItem;
  itemKind: 'input' | 'output';
  event: ProcessingEvent;
  token: string;
  sites: SiteReference[];
  actingRole: ActingRole | null;
  roles: ActingRole[];
  online: boolean;
  onRecord: (event: FormEvent<HTMLFormElement>) => Promise<boolean>;
}) {
  const canWrite = canWriteProcessing(actingRole, roles, event, sites);
  return <article className="overview-card">
    <h3>{readable(itemKind)} · {item.batch_code} · {readable(item.material_kind)}</h3>
    <p>Batch {item.batch_id} · measurement set {item.measurement_set_id}{item.source_event_id ? ` · source event ${item.source_event_id}` : ''}</p>
    <p>{measurementSummary(item.measurements)}</p>
    {item.measurements.map((measurement) => showMeasurement(measurement, item.measurements))}
    {canWrite && <MeasurementForm contextLabel={item.batch_code} online={online} onSubmit={onRecord}><small>Every processing observation must remain linked to the selected input/output and its source-hole context.</small></MeasurementForm>}
    {!canWrite && <p className="muted">Read-only for the selected role. Writing requires a DORA facility grant and write access to every source hole; the server checks both.</p>}
    {item.source_production_output_id && <SourceEventReference eventId={item.source_event_id} token={token} />}
  </article>;
}

function SourceEventReference({ eventId, token }: { eventId?: string; token: string }) {
  const [siteName, setSiteName] = useState('Source event is linked in the processing record.');
  useEffect(() => {
    if (!eventId) return;
    let current = true;
    void (async () => {
      try {
        const siteResponse = await apiRequest<Array<{ id: string; name: string }>>('/api/v1/sites', token);
        for (const site of siteResponse) {
          try {
            const rows = await apiRequest<Array<{ id: string; event_code: string }>>(`/api/v1/sites/${site.id}/production-events`, token);
            const found = rows.find((row) => row.id === eventId);
            if (found && current) { setSiteName(`${site.name} · ${found.event_code} · ${eventId}`); return; }
          } catch { /* Other sites are checked by the authenticated API and may be outside this session's scope. */ }
        }
      } catch { /* The existing production event link remains displayed by its UUID. */ }
    })();
    return () => { current = false; };
  }, [eventId, token]);
  return <small>Linked source production event: {siteName}</small>;
}

function TradeObservationCard({
  line, trade, actingRole, online, activeForm, setActiveForm, write, refreshTrade, onError, onMessage, canWrite,
}: {
  line: GoldTradeLine;
  trade: GoldTrade;
  actingRole: ActingRole | null;
  online: boolean;
  activeForm: TradeFormState;
  setActiveForm: (value: TradeFormState) => void;
  write: <T>(path: string, body: unknown) => Promise<T>;
  refreshTrade: () => Promise<GoldTrade | null>;
  onError: (message: string) => void;
  onMessage: (message: string) => void;
  canWrite: boolean;
}) {
  const lineMeasurements = useMemo(() => line.measurements ?? [], [line.measurements]);
  const lineAssays = useMemo(() => (trade.assays ?? []).filter((assay) => assay.gold_trade_line_id === line.id), [line.id, trade.assays]);
  const active = activeForm?.lineId === line.id ? activeForm : null;
  const currentMeasurementIds = useMemo(() => new Set(lineMeasurements.filter((row) => !lineMeasurements.some((child) => child.supersedes_measurement_id === row.id)).map((row) => row.id)), [lineMeasurements]);
  const currentAssayIds = useMemo(() => new Set(lineAssays.filter((row) => !lineAssays.some((child) => child.correction_of_id === row.id)).map((row) => row.id)), [lineAssays]);
  const canCorrect = canWrite && online && line.is_current && trade.status !== 'CLOSED' && TRADE_PARTICIPANT_ROLES.has(actingRole?.roleCode ?? '');

  const recordWeight = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const sourceValue = String(data.get('sourceValue'));
    const sourceUnit = String(data.get('sourceUnit'));
    const quantityGrams = gramsFromSource(sourceValue, sourceUnit);
    if (!quantityGrams) { onError('The source value must convert exactly to six decimal places in grams.'); return; }
    const correctionReason = String(data.get('correctionReason') ?? '').trim();
    if (active?.correctionId && !correctionReason) { onError('A measurement correction requires a reason.'); return; }
    const occurredAt = new Date(String(data.get('occurredAt')));
    if (Number.isNaN(occurredAt.getTime())) { onError('Enter a valid observation time.'); return; }
    const body = {
      kind: String(data.get('kind')),
      quantityGrams,
      sourceValue,
      sourceUnit,
      conversionVersion: 'canonical-mass-v1',
      sourceRole: String(data.get('sourceRole')),
      ...(data.get('sourcePartyId') ? { sourcePartyId: String(data.get('sourcePartyId')) } : {}),
      ...(data.get('methodCode') ? { methodCode: String(data.get('methodCode')) } : {}),
      ...(data.get('instrumentRef') ? { instrumentRef: String(data.get('instrumentRef')) } : {}),
      occurredAt: occurredAt.toISOString(),
      ...(data.get('evidenceRef') ? { evidenceRef: String(data.get('evidenceRef')) } : {}),
      ...(active?.correctionId ? { supersedesMeasurementId: active.correctionId, correctionReason } : {}),
    };
    try {
      await write(`/api/v1/gold-trades/${trade.id}/lines/${line.id}/measurements`, body);
      setActiveForm(null);
      onError('');
      onMessage(active?.correctionId ? 'The correction was appended; the predecessor remains in history.' : 'The measurement was recorded on this trade line.');
      await refreshTrade();
    } catch (error) { onError(asError(error)); }
  };

  const recordAssay = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const occurredAt = new Date(String(data.get('observedAt')));
    if (Number.isNaN(occurredAt.getTime())) { onError('Enter a valid assay observation time.'); return; }
    const correctionReason = String(data.get('correctionReason') ?? '').trim();
    if (active?.correctionId && !correctionReason) { onError('An assay correction requires a reason.'); return; }
    const body = {
      resultValue: String(data.get('resultValue')),
      resultUnit: String(data.get('resultUnit')),
      ...(data.get('assayerPartyId') ? { assayerPartyId: String(data.get('assayerPartyId')) } : {}),
      ...(data.get('sampleRef') ? { sampleRef: String(data.get('sampleRef')) } : {}),
      ...(data.get('methodRef') ? { methodRef: String(data.get('methodRef')) } : {}),
      observedAt: occurredAt.toISOString(),
      ...(data.get('evidenceRef') ? { evidenceRef: String(data.get('evidenceRef')) } : {}),
      ...(active?.correctionId ? { correctionOfId: active.correctionId, correctionReason } : {}),
    };
    try {
      await write(`/api/v1/gold-trades/${trade.id}/lines/${line.id}/assays`, body);
      setActiveForm(null);
      onError('');
      onMessage(active?.correctionId ? 'The assay correction was appended; the prior observation remains in history.' : 'The assay observation was recorded. This is not a certification claim.');
      await refreshTrade();
    } catch (error) { onError(asError(error)); }
  };

  const selectedMeasurement = active?.kind === 'measurement' && active.correctionId ? lineMeasurements.find((row) => row.id === active.correctionId) : undefined;
  const selectedAssay = active?.kind === 'assay' && active.correctionId ? lineAssays.find((row) => row.id === active.correctionId) : undefined;

  return <article className="overview-card">
    <h3>{line.batch_code} · {readable(line.material_kind)} · revision {line.revision_no}{line.is_current ? ' · current' : ' · superseded'}</h3>
    <p>Trade line {line.id} · batch {line.batch_id} · source event {line.source_event_id ?? 'not returned'} · proposed {line.transaction_quantity_g} g</p>
    <p>Proposal by user {line.proposed_by_user_id} · accepted quantity {line.accepted_trade_quantity_g ?? 'not agreed'} g · price {trade.currency_code} {line.unit_price}/g</p>
    <h4>Weight observations</h4>
    {lineMeasurements.length ? lineMeasurements.map((measurement) => <TradeMeasurementRecord key={measurement.id} measurement={measurement} all={lineMeasurements} />) : <p className="muted">No trade-line measurement is recorded.</p>}
    {lineAssays.length > 0 && <><h4>Assay observations linked to this line</h4>{lineAssays.map((assay) => <TradeAssayRecord key={assay.id} assay={assay} current={currentAssayIds.has(assay.id)} />)}</>}
    {canCorrect && <div className="button-row">
      <button type="button" className="secondary" onClick={() => setActiveForm(active?.kind === 'measurement' ? null : { lineId: line.id, kind: 'measurement' })}>Record trade measurement</button>
      <button type="button" className="secondary" onClick={() => setActiveForm(active?.kind === 'assay' ? null : { lineId: line.id, kind: 'assay' })}>Record assay observation</button>
    </div>}
    {canCorrect && active?.kind === 'measurement' && <>
      <div className="button-row">{lineMeasurements.filter((row) => currentMeasurementIds.has(row.id)).map((row) => <button key={row.id} className="quiet" type="button" onClick={() => setActiveForm({ lineId: line.id, kind: 'measurement', correctionId: row.id })}>Correct {row.measurement_kind.toLowerCase()} {row.id}</button>)}</div>
      <TradeWeightForm line={line} trade={trade} initial={selectedMeasurement} correction={Boolean(selectedMeasurement)} online={online} onSubmit={(event) => void recordWeight(event)} onCancel={() => setActiveForm(null)} />
    </>}
    {canCorrect && active?.kind === 'assay' && <>
      <div className="button-row">{lineAssays.filter((row) => currentAssayIds.has(row.id)).map((row) => <button key={row.id} className="quiet" type="button" onClick={() => setActiveForm({ lineId: line.id, kind: 'assay', correctionId: row.id })}>Correct assay {row.id}</button>)}</div>
      <TradeAssayForm initial={selectedAssay} correction={Boolean(selectedAssay)} online={online} onSubmit={(event) => void recordAssay(event)} onCancel={() => setActiveForm(null)} />
    </>}
    {!canCorrect && <p className="muted">Trade observations are read-only for this active role, trade party, or superseded line. The backend enforces party access and current-line status.</p>}
  </article>;
}

function TradeMeasurementRecord({ measurement, all }: { measurement: GoldTradeMeasurement; all: GoldTradeMeasurement[] }) {
  const active = !all.some((next) => next.supersedes_measurement_id === measurement.id);
  return <article className="overview-card">
    <h5>{readable(measurement.measurement_kind)} · {measurement.quantity_g} g · {active ? 'current' : 'superseded'}</h5>
    <p>Source {measurement.source_value} {measurement.source_unit_code} · role {readable(measurement.source_role)} · source party {measurement.source_party_id}</p>
    <p>Method {measurement.method_code ?? 'not recorded'} · instrument {measurement.instrument_ref ?? 'not recorded'}</p>
    <p>Occurred {displayDate(measurement.occurred_at_claimed)} · entered {displayDate(measurement.entered_at)} · recorder {measurement.entered_by_user_id}</p>
    <p>Evidence {measurement.evidence_ref ?? 'not recorded'} · measurement {measurement.id}</p>
    {measurement.supersedes_measurement_id && <small>Correction of {measurement.supersedes_measurement_id}</small>}
  </article>;
}

function TradeAssayRecord({ assay, current }: { assay: GoldAssay; current: boolean }) {
  return <article className="overview-card">
    <h5>Recorded assay observation · {current ? 'current' : 'superseded'}</h5>
    <p>Result {assay.result_value} {assay.result_unit} · assayer party {assay.assayer_party_id}</p>
    <p>Sample {assay.sample_ref ?? 'not recorded'} · method {assay.method_ref ?? 'not recorded'} · observed {displayDate(assay.observed_at)}</p>
    <p>Evidence {assay.evidence_ref ?? 'not recorded'} · recorder {assay.recorded_by_user_id} · record {assay.id}</p>
    {assay.correction_of_id && <small>Correction of {assay.correction_of_id}: {assay.correction_reason}</small>}
  </article>;
}

function TradeWeightForm({ line, trade, initial, correction, online, onSubmit, onCancel }: {
  line: GoldTradeLine;
  trade: GoldTrade;
  initial?: GoldTradeMeasurement;
  correction: boolean;
  online: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  const [source, setSource] = useState(initial?.source_value ?? '');
  const [unit, setUnit] = useState(initial?.source_unit_code ?? 'g');
  const grams = gramsFromSource(source, unit);
  return <form className="form-stack" aria-label={correction ? 'Correct trade measurement' : 'Record trade measurement'} onSubmit={(event) => { event.preventDefault(); if (grams) onSubmit(event); }}>
    <div className="form-grid">
      <label>Observation kind<select name="kind" defaultValue={initial?.measurement_kind ?? 'MEASURED'}><option value="DECLARED">Declared</option><option value="MEASURED">Measured</option></select></label>
      <label>Source value<input name="sourceValue" value={source} onChange={(event) => setSource(event.target.value)} inputMode="decimal" pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]{1,12})?" required /></label>
      <label>Source unit<select name="sourceUnit" value={unit} onChange={(event) => setUnit(event.target.value)}><option value="g">g</option><option value="kg">kg</option><option value="mg">mg</option></select></label>
      <label>Canonical quantity (g)<input value={grams ?? 'Enter an exactly convertible value'} readOnly /></label>
      <label>Source role<select name="sourceRole" defaultValue={initial?.source_role ?? 'RECORDER'}>{['SELLER', 'BUYER', 'RECORDER', 'WITNESS', 'WEIGHER', 'OTHER'].map((role) => <option key={role} value={role}>{readable(role)}</option>)}</select></label>
      <label>Source party ID<input name="sourcePartyId" defaultValue={initial?.source_party_id ?? ''} placeholder={`Seller ${trade.seller_party_id} / buyer ${trade.buyer_party_id}; other roles require a related party`} /></label>
      <label>Method code<input name="methodCode" defaultValue={initial?.method_code ?? ''} maxLength={80} /></label>
      <label>Instrument reference<input name="instrumentRef" defaultValue={initial?.instrument_ref ?? ''} maxLength={160} /></label>
      <label>Occurred at<input type="datetime-local" name="occurredAt" defaultValue={toDateTimeInput(initial?.occurred_at_claimed ? new Date(initial.occurred_at_claimed) : new Date())} required /></label>
      <label>Evidence reference<input name="evidenceRef" defaultValue={initial?.evidence_ref ?? ''} maxLength={255} /></label>
      {correction && <label>Correction reason<input name="correctionReason" required maxLength={500} /></label>}
    </div>
    {correction && <p className="muted">This creates a new measurement linked to {initial?.id}; the original remains in history.</p>}
    <div className="button-row"><button className="primary" type="submit" disabled={!online || !grams}>{correction ? 'Append measurement correction' : 'Record measurement'}</button><button className="quiet" type="button" onClick={onCancel}>Cancel</button></div>
    <small>Line {line.id} · batch {line.batch_id}. The backend requires exact source conversion and validates party/source relationships.</small>
  </form>;
}

function TradeAssayForm({ initial, correction, online, onSubmit, onCancel }: {
  initial?: GoldAssay;
  correction: boolean;
  online: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  return <form className="form-stack" aria-label={correction ? 'Correct assay observation' : 'Record assay observation'} onSubmit={onSubmit}>
    <div className="form-grid">
      <label>Result value<input name="resultValue" defaultValue={initial?.result_value ?? ''} inputMode="decimal" pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]{1,8})?" required /></label>
      <label>Result unit<input name="resultUnit" defaultValue={initial?.result_unit ?? ''} maxLength={40} required /></label>
      <label>Assayer party ID<input name="assayerPartyId" defaultValue={initial?.assayer_party_id ?? ''} /></label>
      <label>Sample reference<input name="sampleRef" defaultValue={initial?.sample_ref ?? ''} maxLength={160} /></label>
      <label>Method reference<input name="methodRef" defaultValue={initial?.method_ref ?? ''} maxLength={160} /></label>
      <label>Observed at<input type="datetime-local" name="observedAt" defaultValue={toDateTimeInput(initial?.observed_at ? new Date(initial.observed_at) : new Date())} required /></label>
      <label>Evidence reference<input name="evidenceRef" defaultValue={initial?.evidence_ref ?? ''} maxLength={255} /></label>
      {correction && <label>Correction reason<input name="correctionReason" required maxLength={500} /></label>}
    </div>
    {correction && <p className="muted">This creates a successor to {initial?.id}; the original assay record remains in history.</p>}
    <div className="button-row"><button className="primary" type="submit" disabled={!online}>{correction ? 'Append assay correction' : 'Record assay observation'}</button><button className="quiet" type="button" onClick={onCancel}>Cancel</button></div>
  </form>;
}
