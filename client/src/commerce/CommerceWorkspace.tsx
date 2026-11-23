import { useCallback, useState } from 'react';
import { ApiError, apiRequest } from '../api';
import { WorkspaceHeading } from '../AppShell';
import { GoldTradesWorkspace } from './GoldTradesWorkspace';
import { MeasurementsWorkspace } from './MeasurementsWorkspace';
import { PaymentsWorkspace } from './PaymentsWorkspace';
import type { CommerceWorkspaceProps, GoldTrade } from './types';

export function CommerceWorkspace({ section, token, personPartyId, userId, actingRole, roles, sites, online }: CommerceWorkspaceProps) {
  const [lookupValue, setLookupValue] = useState('');
  const [trade, setTrade] = useState<GoldTrade | null>(null);
  const [loadingTrade, setLoadingTrade] = useState(false);
  const [lookupError, setLookupError] = useState('');
  const [lookupMessage, setLookupMessage] = useState('');

  const loadTrade = useCallback(async (tradeId: string) => {
    if (!online) {
      setLookupError('Trade detail lookup is online-only.');
      return null;
    }
    setLoadingTrade(true);
    setLookupError('');
    setLookupMessage('');
    try {
      const result = await apiRequest<GoldTrade>(`/api/v1/gold-trades/${encodeURIComponent(tradeId.trim())}`, token);
      setTrade(result);
      setLookupValue(result.id);
      return result;
    } catch (error) {
      setTrade(null);
      if (error instanceof ApiError && error.status === 404 && actingRole?.roleCode === 'AUDITOR') {
        setLookupError('Trade review is unavailable to this Auditor grant. The current backend trade-detail API requires representation by the seller or buyer.');
      } else if (error instanceof ApiError && error.status === 404) {
        setLookupError('This trade was not found or your current account is not authorized to view it.');
      } else {
        setLookupError(error instanceof Error ? error.message : 'Trade detail could not be loaded.');
      }
      return null;
    } finally {
      setLoadingTrade(false);
    }
  }, [actingRole?.roleCode, online, token]);

  const createMutation = useCallback(async <T,>(path: string, body: unknown): Promise<T> => {
    if (!online) throw new Error('Gold trade, measurement and payment changes are online-only.');
    return apiRequest<T>(path, token, {
      method: 'POST',
      headers: { 'Idempotency-Key': globalThis.crypto.randomUUID() },
      body: JSON.stringify(body),
    });
  }, [online, token]);

  const sectionTitle = section === 'measurements' ? 'Measurements & assays' : section === 'gold-trades' ? 'Gold trades' : 'Payments';

  return (
    <>
      <WorkspaceHeading
        eyebrow="COMMERCE AND EVIDENCE"
        title={sectionTitle}
        description="Use the authorized source and trade APIs. The server checks current account status and party access for every request."
      />
      {!online && <div className="notice warning" role="status">Offline. These measurement, trade and payment workflows are online-only; no unsupported offline command is queued.</div>}
      {lookupError && <div className="notice error" role="alert">{lookupError}</div>}
      {lookupMessage && <div className="notice success" role="status">{lookupMessage}</div>}

      <section className="queue-section" aria-labelledby="trade-lookup-heading">
        <div className="section-heading"><div><p className="eyebrow">PARTY-AUTHORIZED DETAIL</p><h2 id="trade-lookup-heading">Open a gold trade</h2></div></div>
        <p className="muted">The backend has a party-authorized trade detail endpoint but no trade collection or search endpoint. Enter a trade UUID supplied to your party or created in this session.</p>
        <form className="form-grid" onSubmit={(event) => { event.preventDefault(); void loadTrade(lookupValue); }}>
          <label>Gold trade ID<input aria-label="Gold trade ID" value={lookupValue} onChange={(event) => setLookupValue(event.target.value)} required /></label>
          <div className="form-actions"><button className="secondary" type="submit" disabled={!online || loadingTrade || !lookupValue.trim()}>{loadingTrade ? 'Opening…' : 'Open authorized trade'}</button></div>
        </form>
        {trade && <p className="notice info" role="status">Open: {trade.trade_code} · {trade.status} · {trade.trade_kind} · {trade.id}</p>}
      </section>

      {section === 'measurements' && <MeasurementsWorkspace
        token={token}
        personPartyId={personPartyId}
        actingRole={actingRole}
        roles={roles}
        sites={sites}
        online={online}
        trade={trade}
        write={createMutation}
        refreshTrade={() => trade ? loadTrade(trade.id) : Promise.resolve(null)}
        onError={setLookupError}
        onMessage={setLookupMessage}
      />}
      {section === 'gold-trades' && <GoldTradesWorkspace
        personPartyId={personPartyId}
        userId={userId}
        actingRole={actingRole}
        roles={roles}
        online={online}
        trade={trade}
        write={createMutation}
        refreshTrade={() => trade ? loadTrade(trade.id) : Promise.resolve(null)}
        onTradeCreated={async (tradeId) => {
          setLookupValue(tradeId);
          const opened = await loadTrade(tradeId);
          if (opened) setLookupMessage(`Proposal ${opened.trade_code} is open with status ${opened.status}. Both parties must record matching acceptance before it is agreed.`);
        }}
        onError={setLookupError}
        onMessage={setLookupMessage}
      />}
      {section === 'payments' && <PaymentsWorkspace
        personPartyId={personPartyId}
        actingRole={actingRole}
        roles={roles}
        online={online}
        trade={trade}
        write={createMutation}
        refreshTrade={() => trade ? loadTrade(trade.id) : Promise.resolve(null)}
        onError={setLookupError}
        onMessage={setLookupMessage}
      />}
    </>
  );
}
