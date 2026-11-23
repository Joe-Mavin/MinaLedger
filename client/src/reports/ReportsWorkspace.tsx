import { useMemo, useState } from 'react';
import { apiRequest } from '../api';
import { WorkspaceHeading } from '../AppShell';

type JsonRecord = Record<string, unknown>;
interface ReportRecord {
  id: string;
  title: string;
  stage: string;
  date: string;
  status: string;
  siteId: string;
  facilityId: string;
  details: JsonRecord;
}
interface Issue { source: string; message: string }

function rows(value: unknown): JsonRecord[] { return Array.isArray(value) ? value.filter((item): item is JsonRecord => Boolean(item) && typeof item === 'object') : []; }
function field(row: JsonRecord, ...names: string[]): string {
  for (const name of names) {
    const value = row[name];
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  }
  return '';
}
function title(row: JsonRecord, fallback: string): string { return field(row, 'event_code', 'consignment_code', 'sale_code', 'batch_code', 'id', 'event_id') || fallback; }
function dateOf(row: JsonRecord): string { return field(row, 'occurred_at_claimed', 'created_at', 'recorded_at', 'agreed_at', 'dispatched_at', 'received_at', 'createdAt'); }
function activeObservations(value: unknown): JsonRecord[] {
  const all = rows(value);
  const superseded = new Set(all.map((item) => field(item, 'supersedes_measurement_id')).filter(Boolean));
  return all.filter((item) => !superseded.has(field(item, 'id')));
}
function measurementsOf(detail: JsonRecord): JsonRecord[] {
  const observations = [...rows(detail.measurements), ...rows(detail.outputs).flatMap((output) => rows(output.measurements)), ...rows(detail.inputs).flatMap((input) => rows(input.measurements))];
  const distinct = new Map<string, JsonRecord>();
  observations.forEach((observation, index) => distinct.set(field(observation, 'id') || `${index}:${JSON.stringify(observation)}`, observation));
  return [...distinct.values()];
}
function quantityDescription(record: JsonRecord): string {
  const quantity = field(record, 'quantity_g', 'quantity_grams', 'posted_quantity_g', 'accepted_receipt_quantity_g', 'dispatched_quantity_g');
  return quantity ? `${quantity} g (${field(record, 'measurement_kind', 'direction', 'outcome') || 'recorded quantity'})` : '';
}

async function get<T>(token: string, path: string): Promise<T> { return apiRequest<T>(path, token); }

export function ReportsWorkspace({ token, online }: { token: string; online: boolean }) {
  const [records, setRecords] = useState<ReportRecord[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [sites, setSites] = useState<JsonRecord[]>([]);
  const [facilities, setFacilities] = useState<JsonRecord[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [siteId, setSiteId] = useState('');
  const [facilityId, setFacilityId] = useState('');
  const [tradeId, setTradeId] = useState('');
  const [trade, setTrade] = useState<JsonRecord | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const loadReport = async () => {
    setBusy(true); setError(''); setIssues([]); setRecords([]); setTrade(null);
    const nextRecords: ReportRecord[] = [];
    const nextIssues: Issue[] = [];
    const add = (stage: string, row: JsonRecord, detail: JsonRecord, scope: { siteId?: string; facilityId?: string } = {}) => {
      nextRecords.push({
        id: field(row, 'id', 'event_id', 'trade_id') || `${stage}-${nextRecords.length}`,
        title: title(row, stage), stage, date: dateOf(row), status: field(row, 'current_status', 'status', 'outcome') || 'Recorded',
        siteId: scope.siteId ?? field(row, 'site_id', 'siteId'), facilityId: scope.facilityId ?? field(row, 'processing_facility_id', 'recovery_facility_id', 'facility_id', 'processingFacilityId'), details: detail,
      });
    };
    const attempt = async <T,>(label: string, operation: () => Promise<T>): Promise<T | null> => {
      try { return await operation(); }
      catch (loadError) { nextIssues.push({ source: label, message: loadError instanceof Error ? loadError.message : 'Request failed.' }); return null; }
    };
    try {
      const [siteRows, doraRows, recoveryRows] = await Promise.all([
        attempt('Sites', () => get<JsonRecord[]>(token, '/api/v1/sites')),
        attempt('Dora facilities', () => get<JsonRecord[]>(token, '/api/v1/doras')),
        attempt('Recovery facilities', () => get<JsonRecord[]>(token, '/api/v1/recovery-facilities')),
      ]);
      const knownSites = siteRows ?? [];
      const knownDoras = doraRows ?? [];
      const knownRecovery = recoveryRows ?? [];
      setSites(knownSites); setFacilities([...knownDoras, ...knownRecovery]);

      await Promise.all(knownSites.map(async (site) => {
        const id = field(site, 'id');
        const eventRows = await attempt(`Production events for ${field(site, 'name', 'siteCode') || id}`, () => get<JsonRecord[]>(token, `/api/v1/sites/${id}/production-events`));
        for (const event of eventRows ?? []) {
          const detail = await attempt(`Production event ${title(event, field(event, 'id'))}`, () => get<JsonRecord>(token, `/api/v1/sites/${id}/production-events/${field(event, 'id')}`));
          if (detail) add('Production', event, detail, { siteId: id });
        }
      }));

      const processingRows = await attempt('Processing events', () => get<JsonRecord[]>(token, '/api/v1/processing-events'));
      await Promise.all((processingRows ?? []).map(async (event) => {
        const id = field(event, 'id');
        const detail = await attempt(`Processing event ${title(event, id)}`, () => get<JsonRecord>(token, `/api/v1/processing-events/${id}`));
        if (detail) add('Dora processing', event, detail);
      }));

      await Promise.all(knownDoras.map(async (facility) => {
        const id = field(facility, 'id');
        const stockpiles = await attempt(`Stockpiles for ${field(facility, 'name') || id}`, () => get<JsonRecord[]>(token, `/api/v1/doras/${id}/stockpiles`));
        for (const stockpile of stockpiles ?? []) {
          const locationId = field(stockpile, 'id');
          const [balances, movements] = await Promise.all([
            attempt(`Balances for ${field(stockpile, 'stockpile_code') || locationId}`, () => get<JsonRecord[]>(token, `/api/v1/inventory/locations/${locationId}/balances`)),
            attempt(`Movements for ${field(stockpile, 'stockpile_code') || locationId}`, () => get<JsonRecord[]>(token, `/api/v1/inventory/locations/${locationId}/movements`)),
          ]);
          for (const row of balances ?? []) add('Residue inventory balance', row, { ...row, location: stockpile }, { facilityId: id });
          for (const row of movements ?? []) add('Inventory movement', row, { ...row, location: stockpile }, { facilityId: id });
        }
      }));

      const consignmentRows = await attempt('Consignments', () => get<JsonRecord[]>(token, '/api/v1/consignments'));
      await Promise.all((consignmentRows ?? []).map(async (item) => {
        const id = field(item, 'id');
        const detail = await attempt(`Consignment ${title(item, id)}`, () => get<JsonRecord>(token, `/api/v1/consignments/${id}`));
        if (detail) add('Consignment and custody', item, detail, { facilityId: field(item, 'destination_recovery_facility_id') });
      }));

      await Promise.all(knownRecovery.map(async (facility) => {
        const id = field(facility, 'id');
        const eventRows = await attempt(`Recovery events for ${field(facility, 'name') || id}`, () => get<JsonRecord[]>(token, `/api/v1/recovery-facilities/${id}/recovery-events`));
        for (const event of eventRows ?? []) {
          const detail = await attempt(`Recovery event ${title(event, field(event, 'id'))}`, () => get<JsonRecord>(token, `/api/v1/recovery-events/${field(event, 'id')}`));
          if (detail) add('Recovery', event, detail, { facilityId: id });
        }
      }));

      const saleRows = await attempt('Residue sales', () => get<JsonRecord[]>(token, '/api/v1/residue-sales'));
      await Promise.all((saleRows ?? []).map(async (sale) => {
        const id = field(sale, 'id');
        const detail = await attempt(`Residue sale ${title(sale, id)}`, () => get<JsonRecord>(token, `/api/v1/residue-sales/${id}`));
        if (detail) add('Residue sale', sale, detail);
      }));

      setRecords(nextRecords); setIssues(nextIssues);
      if (nextRecords.length === 0 && nextIssues.length === 0) setError('No production or operations records are available in this account scope.');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Report data could not be loaded.');
    } finally { setBusy(false); }
  };

  const loadTrade = async () => {
    setError(''); setTrade(null);
    try { setTrade(await get<JsonRecord>(token, `/api/v1/gold-trades/${encodeURIComponent(tradeId.trim())}`)); }
    catch (loadError) { setError(loadError instanceof Error ? loadError.message : 'Trade is unavailable or not authorized.'); }
  };

  const filtered = useMemo(() => records.filter((record) => {
    if (siteId && record.siteId !== siteId) return false;
    if (facilityId && record.facilityId !== facilityId) return false;
    const day = record.date.slice(0, 10);
    if ((from || to) && !day) return false;
    if (from && day < from) return false;
    if (to && day > to) return false;
    return true;
  }), [records, siteId, facilityId, from, to]);
  const stages = [...new Set(filtered.map((record) => record.stage))];
  const counts = (stage: string) => filtered.filter((record) => record.stage === stage).length;
  const measurementCount = filtered.reduce((sum, record) => {
    return sum + activeObservations(measurementsOf(record.details)).length;
  }, 0);

  return <>
    <WorkspaceHeading eyebrow="AUTHORIZED OPERATIONS DATA" title="Reports" description="A filtered view of records returned by the authenticated production and operations APIs. Metrics count records and observations; quantities remain within their own stage." action={<button className="secondary" type="button" onClick={() => window.print()} disabled={!records.length}>Print report</button>} />
    {!online && <div className="notice warning" role="status">Reports are online-only. They use live authorized API reads and are not stored in the offline cache.</div>}
    {error && <div className="notice info" role="status">{error}</div>}
    <section className="queue-section report-controls" aria-labelledby="report-filter-heading">
      <div className="section-heading"><div><p className="eyebrow">REPORT PERIOD AND SCOPE</p><h2 id="report-filter-heading">Filters</h2></div></div>
      <div className="form-grid">
        <label>From<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label>To<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
        <label>Authorized site<select value={siteId} onChange={(event) => setSiteId(event.target.value)}><option value="">All available sites</option>{sites.map((site) => <option key={field(site, 'id')} value={field(site, 'id')}>{field(site, 'name', 'siteCode')}</option>)}</select></label>
        <label>Authorized facility<select value={facilityId} onChange={(event) => setFacilityId(event.target.value)}><option value="">All available facilities</option>{facilities.map((facility) => <option key={field(facility, 'id')} value={field(facility, 'id')}>{field(facility, 'name')}</option>)}</select></label>
      </div>
      <div className="form-actions"><button className="primary" type="button" onClick={() => void loadReport()} disabled={!online || busy}>{busy ? 'Loading report...' : records.length ? 'Refresh report' : 'Load report'}</button></div>
      <p className="field-note">Filters apply to the current authorized response set. The API rechecks access on each read; refresh to reflect changed grants.</p>
    </section>
    {issues.length > 0 && <section className="notice warning" aria-label="Report source limitations"><strong>Some sources could not be loaded ({issues.length}).</strong><ul>{issues.slice(0, 8).map((issue, index) => <li key={`${issue.source}-${index}`}>{issue.source}: {issue.message}</li>)}</ul></section>}
    {records.length > 0 && <>
      <section className="overview-grid" aria-label="Report record counts">
        {stages.map((stage) => <article className="overview-card" key={stage}><span className="label">{stage} records</span><strong className="metric">{counts(stage)}</strong><p>Count of returned records in the selected scope and period.</p></article>)}
        <article className="overview-card"><span className="label">Active measurement observations</span><strong className="metric">{measurementCount}</strong><p>Superseded observations excluded; DECLARED, MEASURED and VERIFIED remain separate. No grams are summed across process stages.</p></article>
      </section>
      <section className="queue-section" aria-labelledby="report-records-heading">
        <div className="section-heading"><div><p className="eyebrow">REPORT DETAIL</p><h2 id="report-records-heading">Supporting records <span className="count">{filtered.length}</span></h2></div></div>
        {filtered.length === 0 ? <div className="empty-state">No records match the selected period and scope.</div> : <div className="queue-list">{filtered.map((record) => {
          const active = activeObservations(measurementsOf(record.details));
          return <article className="queue-item" key={`${record.stage}:${record.id}`}>
            <div className="queue-main"><div className="queue-title"><strong>{record.stage}: {record.title}</strong><span className="state-pill">{record.status}</span></div>
              <p className="queue-meta">Date {record.date || 'not recorded'} · site {record.siteId || 'not linked'} · facility {record.facilityId || 'not linked'}</p>
              {active.length > 0 && <ul className="queue-meta">{active.map((observation, index) => <li key={field(observation, 'id') || index}>{field(observation, 'measurement_kind') || 'Observation'} · {quantityDescription(observation) || 'quantity not provided'} · source {field(observation, 'source_role', 'source_party_id') || 'not recorded'}</li>)}</ul>}
              <details><summary>Supporting source data</summary><pre>{JSON.stringify(record.details, null, 2)}</pre></details>
            </div>
          </article>;
        })}</div>}
      </section>
    </>}
    <section className="queue-section" aria-labelledby="trade-report-heading">
      <div className="section-heading"><div><p className="eyebrow">PARTY-AUTHORIZED TRADE</p><h2 id="trade-report-heading">Trade and payment detail</h2></div></div>
      <p className="muted">There is no general trade collection endpoint. Enter a known trade UUID; the server only returns it to an authorized trade party.</p>
      <div className="form-grid"><label>Known trade UUID<input value={tradeId} onChange={(event) => setTradeId(event.target.value)} /></label><button className="secondary" type="button" onClick={() => void loadTrade()} disabled={!online || !tradeId.trim()}>Load authorized trade</button></div>
      {trade && <div className="overview-card"><strong>{title(trade, 'Authorized trade')}</strong><p>Trade, custody and payment decisions are shown as recorded states. A payment record is not proof of external money movement.</p><pre>{JSON.stringify(trade, null, 2)}</pre></div>}
    </section>
  </>;
}
