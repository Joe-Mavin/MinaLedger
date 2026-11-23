import { useCallback, useEffect, useState } from 'react';
import { apiRequest } from '../api';
import { WorkspaceHeading } from '../AppShell';

type StreamKind = 'mining_site' | 'mining_hole' | 'material_event' | 'processing_facility' | 'recovery_facility' | 'gold_trade' | 'consignment';
type AuditStream = { streamKind: StreamKind; streamId: string; sequence: number; headHash: string; updatedAt: string };
type SelectedStream = Pick<AuditStream, 'streamKind' | 'streamId'>;
type CheckpointSummary = { id: string; createdAt: string; manifestHash: string; status: string; attemptCount: number; lastErrorCode?: string | null; streamCount: number };
interface VerificationView {
  checkpointStatus: string;
  manifestStatus: string;
  streams: Array<{ streamKind: string; streamId: string; coveredSequence: number; currentSequence: number | null; currentHeadStatus?: string; checkpointStatus?: string; tailStatus: string; tailEntries: number; checkpointFailure?: string; tailFailure?: string }>;
}
interface CheckpointView {
  checkpoint: { id: string; createdAt: string; createdByUserId: string; manifestHash: string; streams: Array<{ streamKind: string; streamId: string; sequence: number; headHash: string }> };
  databaseState: string;
  processing: { status: string; attemptCount: number; lastErrorCode?: string | null; verification?: VerificationView | null; attempts: Array<{ attempt_number: number; outcome: string; error_code?: string | null; started_at: string; completed_at?: string | null }> };
  liveVerification: VerificationView;
  externalCommitment: string;
}

const ACTIVE_OUTBOX = new Set(['PENDING', 'PROCESSING', 'RETRY']);

export function AuditEvidenceWorkspace({ token, online, readOnly = false }: { token: string; online: boolean; readOnly?: boolean }) {
  const [streams, setStreams] = useState<AuditStream[]>([]);
  const [history, setHistory] = useState<CheckpointSummary[]>([]);
  const [selectedStreamKey, setSelectedStreamKey] = useState('');
  const [selectedStreams, setSelectedStreams] = useState<SelectedStream[]>([]);
  const [checkpoint, setCheckpoint] = useState<CheckpointView | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  const refreshIndex = useCallback(async () => {
    if (!online) return;
    setLoading(true);
    setError('');
    try {
      const [streamRows, checkpointRows] = await Promise.all([
        apiRequest<AuditStream[]>('/api/v1/audit/streams', token),
        apiRequest<CheckpointSummary[]>('/api/v1/audit/checkpoints', token),
      ]);
      setStreams(streamRows);
      setHistory(checkpointRows);
      if (streamRows.length) setSelectedStreamKey((current) => current || `${streamRows[0].streamKind}:${streamRows[0].streamId}`);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Authorized audit evidence could not be loaded.');
    } finally { setLoading(false); }
  }, [online, token]);

  useEffect(() => { void refreshIndex(); }, [refreshIndex]);

  useEffect(() => {
    const checkpointId = checkpoint?.checkpoint.id;
    if (!online || !checkpointId || !ACTIVE_OUTBOX.has(checkpoint.processing.status)) return undefined;
    let active = true;
    const refresh = async () => {
      try {
        const result = await apiRequest<CheckpointView>(`/api/v1/audit/checkpoints/${checkpointId}`, token);
        if (active) setCheckpoint(result);
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : 'Checkpoint status could not be refreshed.');
      }
    };
    const timer = window.setInterval(() => { void refresh(); }, 2_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [token, online, checkpoint?.checkpoint.id, checkpoint?.processing.status]);

  const addSelectedStream = () => {
    const stream = streams.find((row) => `${row.streamKind}:${row.streamId}` === selectedStreamKey);
    if (!stream) return;
    if (selectedStreams.some((row) => row.streamKind === stream.streamKind && row.streamId === stream.streamId)) {
      setError('That stream is already selected.');
      return;
    }
    setError('');
    setSelectedStreams((current) => [...current, { streamKind: stream.streamKind, streamId: stream.streamId }]);
  };

  const createCheckpoint = async () => {
    if (!selectedStreams.length) return;
    const clientMutationId = crypto.randomUUID();
    setBusy(true);
    setError('');
    try {
      const result = await apiRequest<CheckpointView>('/api/v1/audit/checkpoints', token, {
        method: 'POST', headers: { 'Idempotency-Key': clientMutationId },
        body: JSON.stringify({ clientMutationId, streams: selectedStreams }),
      });
      setCheckpoint(result);
      await refreshIndex();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Checkpoint creation failed.');
    } finally { setBusy(false); }
  };

  const openCheckpoint = async (checkpointId: string) => {
    setBusy(true);
    setError('');
    try { setCheckpoint(await apiRequest<CheckpointView>(`/api/v1/audit/checkpoints/${checkpointId}`, token)); }
    catch (openError) { setError(openError instanceof Error ? openError.message : 'Checkpoint details could not be opened.'); }
    finally { setBusy(false); }
  };

  return <>
    <WorkspaceHeading eyebrow="DATABASE EVIDENCE" title="Audit evidence" description="Discover authorized streams, create database checkpoints, and inspect their saved processing status and live verification." />
    {readOnly && <div className="notice info">Auditor view is read-only. You can inspect authorized streams and checkpoints.</div>}
    {!online && <div className="notice warning" role="status">Audit stream discovery, checkpoint creation and verification are online-only.</div>}
    {error && <div className="notice error" role="alert">{error}</div>}

    <section className="queue-section" aria-labelledby="audit-streams-heading">
      <div className="section-heading"><div><p className="eyebrow">SERVER-DISCOVERED SCOPE</p><h2 id="audit-streams-heading">Eligible audit streams</h2></div><button className="secondary" type="button" onClick={() => void refreshIndex()} disabled={!online || loading}>{loading ? 'Refreshing…' : 'Refresh streams'}</button></div>
      <p className="muted">The authenticated server filters these streams against current access. Audit records are hash-linked events; a checkpoint commits to a particular stream prefix.</p>
      {loading && <div className="empty-state" role="status">Loading authorized streams and checkpoint history…</div>}
      {!loading && online && streams.length === 0 && <div className="empty-state">No audit streams are currently discoverable for this account.</div>}
      {!loading && readOnly && streams.length > 0 && <ul className="site-list">{streams.map((stream) => <li key={`${stream.streamKind}:${stream.streamId}`}><span className="site-dot" aria-hidden="true" /><span><strong>{stream.streamKind.replaceAll('_', ' ')}</strong><small>{stream.streamId} · sequence {stream.sequence}</small></span></li>)}</ul>}
      {!loading && streams.length > 0 && !readOnly && <form className="form-grid" onSubmit={(event) => { event.preventDefault(); addSelectedStream(); }}>
        <label>Authorized stream<select aria-label="Authorized audit stream" value={selectedStreamKey} onChange={(event) => setSelectedStreamKey(event.target.value)}>
          {streams.map((stream) => <option key={`${stream.streamKind}:${stream.streamId}`} value={`${stream.streamKind}:${stream.streamId}`}>{stream.streamKind.replaceAll('_', ' ')} · {stream.streamId} · sequence {stream.sequence}</option>)}
        </select></label>
        <button className="secondary" type="submit">Add stream to checkpoint</button>
        <div className="span-two" aria-label="Selected checkpoint streams">
          {selectedStreams.map((stream) => <p className="queue-meta" key={`${stream.streamKind}:${stream.streamId}`}>
            {stream.streamKind.replaceAll('_', ' ')} · {stream.streamId}
            <button className="small-button" type="button" onClick={() => setSelectedStreams((current) => current.filter((item) => item !== stream))}>Remove</button>
          </p>)}
        </div>
        <button className="primary" type="button" onClick={() => void createCheckpoint()} disabled={busy || !online || selectedStreams.length === 0}>{busy ? 'Creating…' : 'Create checkpoint'}</button>
      </form>}
    </section>

    <section className="queue-section" aria-labelledby="checkpoint-history-heading">
      <div className="section-heading"><div><p className="eyebrow">AUTHORIZED HISTORY</p><h2 id="checkpoint-history-heading">Checkpoint history</h2></div></div>
      {history.length === 0 && !loading ? <div className="empty-state">No checkpoints are visible for streams you can currently access.</div> : <div className="queue-list">{history.map((item) => <article className="queue-item" key={item.id}>
        <div className="queue-main"><div className="queue-title"><strong>{new Date(item.createdAt).toLocaleString()}</strong><span className="state-pill">{item.status.toLowerCase()}</span></div><p className="queue-meta">{item.streamCount} stream(s) · {item.attemptCount} verification attempt(s) · {item.id}</p>{item.lastErrorCode && <p className="error">Last processing error: {item.lastErrorCode}</p>}</div>
        <div className="queue-actions"><button className="small-button" type="button" onClick={() => void openCheckpoint(item.id)} disabled={busy}>Open and verify</button></div>
      </article>)}</div>}
    </section>

    {checkpoint && <section className="queue-section" aria-labelledby="checkpoint-detail-heading">
      <div className="section-heading"><div><p className="eyebrow">CHECKPOINT DETAIL</p><h2 id="checkpoint-detail-heading">Verification result</h2></div><button className="secondary" type="button" onClick={() => void openCheckpoint(checkpoint.checkpoint.id)} disabled={busy}>Refresh verification</button></div>
      <div className="overview-grid">
        <article className="overview-card"><span className="label">Database record</span><strong>{checkpoint.databaseState}</strong><p>Accepted into the same PostgreSQL trust boundary as the audit events.</p></article>
        <article className="overview-card"><span className="label">Outbox processing</span><strong>{checkpoint.processing.status} · {checkpoint.processing.attemptCount} attempt(s)</strong><p>Processing status is separate from database acceptance.</p></article>
        <article className="overview-card"><span className="label">Live verification</span><strong>{checkpoint.liveVerification.checkpointStatus} · {checkpoint.liveVerification.manifestStatus}</strong><p>Manifest SHA-256: <code>{checkpoint.checkpoint.manifestHash}</code></p></article>
      </div>
      <p className="muted">A checkpoint covers the listed stream prefix. Later records may remain in an unanchored tail. The checkpoint and its verifier share PostgreSQL; there is no external independent commitment or deployed distributed blockchain.</p>
      {checkpoint.processing.lastErrorCode && <p className="notice error" role="alert">Processing error: {checkpoint.processing.lastErrorCode}</p>}
      {checkpoint.liveVerification.streams.map((stream) => <article className="overview-card" key={`${stream.streamKind}:${stream.streamId}`}>
        <h3>{stream.streamKind.replaceAll('_', ' ')} · {stream.streamId}</h3>
        <p>Covered sequence {stream.coveredSequence}; current sequence {stream.currentSequence ?? 'unavailable'}; current head {stream.currentHeadStatus ?? 'unavailable'}.</p>
        <p>Checkpoint {stream.checkpointStatus}; unanchored tail {stream.tailStatus} ({stream.tailEntries} record(s)).</p>
        {(stream.checkpointFailure || stream.tailFailure) && <p role="alert">{stream.checkpointFailure ?? stream.tailFailure}</p>}
      </article>)}
      {checkpoint.processing.attempts.length > 0 && <details><summary>Verification attempt history ({checkpoint.processing.attempts.length})</summary><ul>{checkpoint.processing.attempts.map((attempt) => <li key={attempt.attempt_number}>Attempt {attempt.attempt_number}: {attempt.outcome} · started {new Date(attempt.started_at).toLocaleString()}{attempt.error_code ? ` · ${attempt.error_code}` : ''}</li>)}</ul></details>}
      <p className="notice warning">Hashes and checkpoints make changes detectable within this database history. They are not an external independent audit anchor or blockchain.</p>
    </section>}
  </>;
}
