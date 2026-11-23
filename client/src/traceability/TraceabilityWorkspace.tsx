import { useCallback, useEffect, useState } from 'react';
import { apiRequest, ApiError } from '../api';
import { WorkspaceHeading } from '../AppShell';

interface RoleGrant { roleCode: string; scopeKind: string; scopeId: string }
interface MaterialBatch { id: string; batch_code: string; material_kind: string; current_status: string; created_at?: string }
interface BatchResult extends MaterialBatch { qr_status?: string | null }
type RecordRow = Record<string, unknown>;
interface TraceabilityData {
  batch: MaterialBatch;
  qr: { id: string; status: string; rotatedFromId: string | null; createdAt: string } | null;
  relatedBatches: MaterialBatch[];
  productionEvents: RecordRow[];
  processingEvents: RecordRow[];
  inventoryMovements: RecordRow[];
  consignments: RecordRow[];
  recoveryEvents: RecordRow[];
  residueSales: RecordRow[];
  goldTrades: RecordRow[];
  limitations: { pooledAttribution: string; tradeLookup: string };
}
interface QrRecord { qr_record_id: string; material_batch_id: string; status: string; batch_code: string; material_kind: string; current_status: string; origins: RecordRow[] }

function text(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function recordTitle(record: RecordRow): string {
  return text(record.event_code ?? record.consignment_code ?? record.sale_code ?? record.trade_code ?? record.id ?? 'Recorded item');
}

function recordStatus(record: RecordRow): string {
  return text(record.current_status ?? record.status ?? record.outcome ?? 'Recorded');
}

const GROUPS: Array<{ key: keyof Pick<TraceabilityData, 'productionEvents' | 'processingEvents' | 'inventoryMovements' | 'consignments' | 'recoveryEvents' | 'residueSales' | 'goldTrades'>; title: string; empty: string }> = [
  { key: 'productionEvents', title: 'Production and source measurements', empty: 'No authorized production event is linked to this batch.' },
  { key: 'processingEvents', title: 'Dora processing and output measurements', empty: 'No authorized processing event is linked to this batch.' },
  { key: 'inventoryMovements', title: 'Residue inventory movements', empty: 'No inventory movement is linked to this batch.' },
  { key: 'consignments', title: 'Consignments, dispatch, custody and receipt', empty: 'No authorized consignment is linked to this batch.' },
  { key: 'recoveryEvents', title: 'Recovery inputs and outputs', empty: 'No recovery event is linked to this batch.' },
  { key: 'residueSales', title: 'Residue sale records', empty: 'No residue sale is linked to this batch.' },
  { key: 'goldTrades', title: 'Authorized gold trades and payment records', empty: 'No trade available to this account is linked to this batch.' },
];

export function TraceabilityWorkspace({ token, roles, actingRoleCode, online, initialBatchId = '' }: {
  token: string; roles: RoleGrant[]; actingRoleCode: string; online: boolean; initialBatchId?: string;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<BatchResult[]>([]);
  const [trace, setTrace] = useState<TraceabilityData | null>(null);
  const [qrToken, setQrToken] = useState('');
  const [resolvedQr, setResolvedQr] = useState<QrRecord | null>(null);
  const [issuedToken, setIssuedToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const openTrace = useCallback(async (batchId: string) => {
    setBusy(true); setError('');
    try {
      setTrace(await apiRequest<TraceabilityData>(`/api/v1/material-batches/${batchId}/traceability`, token));
    } catch (loadError) {
      setTrace(null);
      setError(loadError instanceof ApiError && loadError.status === 404
        ? 'No batch with accessible source lineage was found for this account.'
        : loadError instanceof Error ? loadError.message : 'Traceability could not be loaded.');
    } finally { setBusy(false); }
  }, [token]);

  const search = useCallback(async (value: string, openExactMatch = false) => {
    const clean = value.trim();
    if (clean.length < 2) { setError('Enter at least two characters or a known batch UUID.'); return; }
    setBusy(true); setError(''); setTrace(null); setResults([]); setIssuedToken(''); setResolvedQr(null);
    try {
      const rows = await apiRequest<BatchResult[]>(`/api/v1/material-batches?query=${encodeURIComponent(clean)}`, token);
      setResults(rows);
      if (!rows.length) setError('No accessible material batches matched this search.');
      if (openExactMatch) {
        const exact = rows.find((batch) => batch.id.toLowerCase() === clean.toLowerCase());
        if (exact) await openTrace(exact.id);
      }
    } catch (searchError) { setError(searchError instanceof Error ? searchError.message : 'Batch search failed.'); }
    finally { setBusy(false); }
  }, [token, openTrace]);

  useEffect(() => { if (initialBatchId) { setQuery(initialBatchId); void search(initialBatchId, true); } }, [initialBatchId, search]);

  const mutateQr = async (rotate: boolean) => {
    if (!trace) return;
    const mutationId = crypto.randomUUID();
    setBusy(true); setError(''); setIssuedToken('');
    try {
      const result = await apiRequest<{ payload: string; status: string }>(`/api/v1/material-batches/${trace.batch.id}/qr${rotate ? '/rotate' : ''}`, token, {
        method: 'POST', headers: { 'Idempotency-Key': mutationId }, body: JSON.stringify({}),
      });
      setIssuedToken(result.payload);
      await openTrace(trace.batch.id);
    } catch (writeError) {
      setError(writeError instanceof Error ? writeError.message : 'QR identity change was rejected by the server.');
    } finally { setBusy(false); }
  };

  const resolveQr = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setError(''); setResolvedQr(null); setTrace(null);
    try {
      const result = await apiRequest<QrRecord>(`/api/v1/qr/${encodeURIComponent(qrToken.trim())}`, token);
      setResolvedQr(result);
      await openTrace(result.material_batch_id);
    } catch (lookupError) { setError(lookupError instanceof Error ? lookupError.message : 'QR lookup failed or the batch is outside your access.'); }
    finally { setBusy(false); }
  };

  const canManageQr = actingRoleCode !== 'AUDITOR' && roles.length > 0;

  return <>
    <WorkspaceHeading eyebrow="SOURCE-LINKED GOLD RECORDS" title="Traceability" description="Find an authorized batch, resolve its authenticated QR identity and follow records that exist in its source lineage." />
    {!online && <div className="notice warning" role="status">Batch search, QR actions and trace details require a connection. No authenticated API response is cached for offline use.</div>}
    {error && <div className="notice error" role="alert">{error}</div>}
    <section className="queue-section" aria-labelledby="trace-search-heading">
      <div className="section-heading"><div><p className="eyebrow">AUTHORIZED BATCH SEARCH</p><h2 id="trace-search-heading">Find a material batch</h2></div></div>
      <form className="form-grid" onSubmit={(event) => { event.preventDefault(); void search(query); }}>
        <label>Batch code or UUID<input aria-label="Batch code or UUID" value={query} onChange={(event) => setQuery(event.target.value)} minLength={2} maxLength={80} /></label>
        <button className="primary" type="submit" disabled={!online || busy || query.trim().length < 2}>{busy ? 'Searching...' : 'Find batch'}</button>
      </form>
      {results.length > 0 && <div className="queue-list">{results.map((batch) => <article className="queue-item" key={batch.id}>
        <div className="queue-main"><div className="queue-title"><strong>{batch.batch_code}</strong><span className="state-pill">{batch.current_status}</span></div><p className="queue-meta">{batch.material_kind} · QR {batch.qr_status ?? 'not created'} · {batch.id}</p></div>
        <div className="queue-actions"><button className="small-button" type="button" onClick={() => void openTrace(batch.id)} disabled={!online || busy}>Open trace</button></div>
      </article>)}</div>}
    </section>

    <section className="queue-section" aria-labelledby="qr-lookup-heading">
      <div className="section-heading"><div><p className="eyebrow">AUTHENTICATED RESOLUTION</p><h2 id="qr-lookup-heading">Resolve QR token</h2></div></div>
      <form className="form-grid" onSubmit={(event) => void resolveQr(event)}>
        <label>QR token<input aria-label="QR token" value={qrToken} onChange={(event) => setQrToken(event.target.value)} minLength={40} maxLength={60} /></label>
        <button className="secondary" type="submit" disabled={!online || busy || qrToken.trim().length < 40}>Resolve with this signed-in account</button>
      </form>
      {resolvedQr && <div className="notice info" role="status"><strong>Authenticated lookup resolved {resolvedQr.batch_code} ({resolvedQr.material_kind}); QR state {resolvedQr.status}.</strong><p>Returned authorized source identifiers:</p><ul>{resolvedQr.origins.map((origin, index) => <li key={index}>{origin.site_id ? `Site ${text(origin.site_id)} · hole ${text(origin.hole_id)}` : origin.processing_facility_id ? `Dora facility ${text(origin.processing_facility_id)}` : origin.recovery_facility_id ? `Recovery facility ${text(origin.recovery_facility_id)}` : 'Source origin is unavailable'}</li>)}</ul></div>}
    </section>

    {trace && <>
      <section className="queue-section" aria-labelledby="trace-batch-heading">
        <div className="section-heading"><div><p className="eyebrow">MATERIAL BATCH</p><h2 id="trace-batch-heading">{trace.batch.batch_code}</h2></div><span className="state-pill">{trace.batch.current_status}</span></div>
        <p>{trace.batch.material_kind} · {trace.batch.id}</p>
        <div className="overview-grid">
          <article className="overview-card"><span className="label">QR status</span><strong>{trace.qr?.status ?? 'No QR identity'}</strong><p>{trace.qr ? `Record ${trace.qr.id}${trace.qr.rotatedFromId ? `; rotated from ${trace.qr.rotatedFromId}` : ''}` : 'A QR identity has not been created for this batch.'}</p></article>
          <article className="overview-card"><span className="label">Related batches in authorized lineage</span><strong>{trace.relatedBatches.length}</strong><p>Visible records only; links are limited by current source access.</p><ul>{trace.relatedBatches.map((batch) => <li key={batch.id}><button className="text-button" type="button" onClick={() => { setQuery(batch.batch_code); void openTrace(batch.id); }}>{batch.batch_code} · {batch.material_kind} · {batch.current_status}</button></li>)}</ul></article>
        </div>
        {canManageQr && <div className="form-actions">
          {!trace.qr && <button className="primary" type="button" onClick={() => void mutateQr(false)} disabled={!online || busy}>Create QR identity</button>}
          {trace.qr?.status === 'ACTIVE' && <button className="secondary" type="button" onClick={() => void mutateQr(true)} disabled={!online || busy}>Rotate QR identity</button>}
        </div>}
        {actingRoleCode === 'AUDITOR' && <p className="muted">QR creation and rotation are hidden in the read-only auditor workspace.</p>}
        {issuedToken && <div className="notice success" role="status"><strong>New active QR token</strong><p>This token is shown once by this response. Store or print it through the approved field process.</p><code className="qr-token">{issuedToken}</code></div>}
      </section>
      <section className="queue-section" aria-labelledby="trace-lineage-heading">
        <div className="section-heading"><div><p className="eyebrow">RECORDED GENEALOGY</p><h2 id="trace-lineage-heading">Follow the source records</h2></div></div>
        <p className="muted">Each stage remains separate. Transfers do not create material, and reported measurements are observations with their recorded source and kind.</p>
        {GROUPS.map((group) => {
          const rows = trace[group.key];
          return <section className="trace-group" key={group.key} aria-label={group.title}>
            <div className="section-heading"><h3>{group.title}</h3><span className="count">{rows.length}</span></div>
            {rows.length === 0 ? <div className="empty-state">{group.empty}</div> : <div className="queue-list">{rows.map((row, index) => <article className="queue-item" key={text(row.id ?? row.event_id ?? row.event_code ?? index)}>
              <div className="queue-main"><div className="queue-title"><strong>{recordTitle(row)}</strong><span className="state-pill">{recordStatus(row)}</span></div><p className="queue-meta">{text(row.occurred_at_claimed ?? row.created_at ?? row.recorded_at ?? row.agreed_at ?? row.createdAt)}</p><details><summary>Supporting record data</summary><pre>{JSON.stringify(row, null, 2)}</pre></details></div>
            </article>)}</div>}
          </section>;
        })}
        <p className="notice warning">{trace.limitations.pooledAttribution} {trace.limitations.tradeLookup}</p>
      </section>
    </>}
  </>;
}
