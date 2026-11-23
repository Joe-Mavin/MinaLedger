import { useState, type FormEvent } from 'react';
import { displayDate, actingPartyId, readable, toDateTimeInput, type ActingRole, type GoldTrade } from './types';

const TRADE_ROLES = new Set([
  'FIELD_OFFICER', 'MINING_OPERATOR', 'MINER', 'DORA_OPERATOR', 'RECOVERY_FACILITY_OPERATOR', 'LOCAL_MERCHANT', 'LARGER_MERCHANT',
]);

interface Props {
  personPartyId: string;
  userId: string;
  actingRole: ActingRole | null;
  roles: ActingRole[];
  online: boolean;
  trade: GoldTrade | null;
  write: <T>(path: string, body: unknown) => Promise<T>;
  refreshTrade: () => Promise<GoldTrade | null>;
  onTradeCreated: (tradeId: string) => Promise<void>;
  onError: (message: string) => void;
  onMessage: (message: string) => void;
}

function apiError(error: unknown): string {
  return error instanceof Error ? error.message : 'The server could not complete the request.';
}

export function GoldTradesWorkspace({ personPartyId, userId, actingRole, roles, online, trade, write, refreshTrade, onTradeCreated, onError, onMessage }: Props) {
  const [busy, setBusy] = useState(false);
  const [showProposal, setShowProposal] = useState(false);
  const [showAddLine, setShowAddLine] = useState(false);
  const canPropose = Boolean(actingRole && TRADE_ROLES.has(actingRole.roleCode));
  const canRepresentTrade = Boolean(actingRole && TRADE_ROLES.has(actingRole.roleCode)
    && trade && [trade.seller_party_id, trade.buyer_party_id].includes(actingPartyId(personPartyId, actingRole)));
  const sellerIsRepresented = Boolean(trade && partyMayBeRepresented(personPartyId, roles, trade.seller_party_id));
  const buyerIsRepresented = Boolean(trade && partyMayBeRepresented(personPartyId, roles, trade.buyer_party_id));
  const ambiguousParty = sellerIsRepresented && buyerIsRepresented;
  const canWrite = Boolean(canRepresentTrade && !ambiguousParty && actingRole?.roleCode !== 'AUDITOR' && actingRole?.roleCode !== 'SYSTEM_ADMIN');

  const createProposal = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const tradeDate = new Date(String(data.get('tradeDate')));
    if (Number.isNaN(tradeDate.getTime())) { onError('Enter a valid trade date.'); return; }
    const currencyCode = String(data.get('currencyCode')).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currencyCode)) { onError('Enter a three-letter currency code.'); return; }
    const deductionAmount = String(data.get('deductionAmount') ?? '').trim();
    const body = {
      tradeKind: String(data.get('tradeKind')),
      sellerPartyId: String(data.get('sellerPartyId')).trim(),
      buyerPartyId: String(data.get('buyerPartyId')).trim(),
      tradeDate: tradeDate.toISOString(),
      currencyCode,
      ...(data.get('tradeCode') ? { tradeCode: String(data.get('tradeCode')).trim() } : {}),
      ...(data.get('termsRef') ? { termsRef: String(data.get('termsRef')).trim() } : {}),
      lines: [{
        batchId: String(data.get('batchId')).trim(),
        quantityGrams: String(data.get('quantityGrams')).trim(),
        unitPrice: String(data.get('unitPrice')).trim(),
        ...(deductionAmount ? { deductionAmount, deductionReason: String(data.get('deductionReason')).trim() } : {}),
      }],
      ...(data.get('evidenceRef') ? { evidence: { kind: 'TERMS', reference: String(data.get('evidenceRef')).trim(), occurredAt: tradeDate.toISOString() } } : {}),
    };
    if (partyMayBeRepresented(personPartyId, roles, body.sellerPartyId) && partyMayBeRepresented(personPartyId, roles, body.buyerPartyId)) {
      onError('This account can represent both proposed parties, but the create API has no explicit acting-party field. Use a party-specific account for this proposal.');
      return;
    }
    setBusy(true);
    onError('');
    try {
      const created = await write<{ id: string }>('/api/v1/gold-trades', body);
      setShowProposal(false);
      await onTradeCreated(created.id);
    } catch (error) { onError(apiError(error)); }
    finally { setBusy(false); }
  };

  const addLine = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!trade) return;
    const data = new FormData(event.currentTarget);
    const deductionAmount = String(data.get('deductionAmount') ?? '').trim();
    setBusy(true);
    onError('');
    try {
      const result = await write<{ id: string }>(`/api/v1/gold-trades/${trade.id}/lines`, {
        batchId: String(data.get('batchId')).trim(),
        quantityGrams: String(data.get('quantityGrams')).trim(),
        unitPrice: String(data.get('unitPrice')).trim(),
        ...(deductionAmount ? { deductionAmount, deductionReason: String(data.get('deductionReason')).trim() } : {}),
      });
      setShowAddLine(false);
      onMessage(`Line ${result.id} was proposed. It remains subject to party decisions.`);
      await refreshTrade();
    } catch (error) { onError(apiError(error)); }
    finally { setBusy(false); }
  };

  return (
    <>
      <section className="queue-section" aria-labelledby="gold-trade-register-heading">
        <div className="section-heading"><div><p className="eyebrow">EXISTING PARTY-BOUND TRADE SERVICE</p><h2 id="gold-trade-register-heading">Trade proposals and details</h2></div>
          {canPropose && <button className="primary" type="button" onClick={() => setShowProposal(!showProposal)}>Create trade proposal</button>}
        </div>
        <p className="muted">The backend has no trade collection endpoint, so it cannot produce a complete register or server-side filters. Open a known trade UUID above, or create a proposal using an eligible gold batch; the API validates batch source, inventory and party scope.</p>
        {actingRole?.roleCode === 'AUDITOR' && <p className="notice info">Auditors are read-only. The current detail API does not grant trade access from an Auditor role alone; it requires the account to represent a trade party.</p>}
        {showProposal && canPropose && <form className="form-stack" aria-label="Create gold trade proposal" onSubmit={(event) => void createProposal(event)}>
          <div className="form-grid">
            <label>Trade kind<select name="tradeKind"><option value="PURCHASE">Purchase</option><option value="RESALE">Resale</option></select></label>
            <label>Trade date<input name="tradeDate" type="datetime-local" defaultValue={toDateTimeInput()} required /></label>
            <label>Seller party ID<input name="sellerPartyId" required /></label>
            <label>Buyer party ID<input name="buyerPartyId" required /></label>
            <label>Source gold batch ID<input name="batchId" required /></label>
            <label>Proposed quantity (g)<input name="quantityGrams" inputMode="decimal" pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?" required /></label>
            <label>Proposed unit price<input name="unitPrice" inputMode="decimal" pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]{1,8})?" required /></label>
            <label>Currency code<input name="currencyCode" defaultValue="KES" pattern="[A-Za-z]{3}" maxLength={3} required /></label>
            <label>Trade code (optional)<input name="tradeCode" maxLength={100} /></label>
            <label>Terms reference<input name="termsRef" maxLength={255} /></label>
            <label>Terms evidence reference<input name="evidenceRef" maxLength={255} /></label>
            <label>Deduction amount (optional)<input name="deductionAmount" inputMode="decimal" pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]{1,8})?" /></label>
            <label>Deduction reason<input name="deductionReason" maxLength={500} /></label>
          </div>
          <p className="muted">Enter the parties’ agreed terms. No price feed or material directory is available. A proposal is not an accepted trade, and a user-provided batch ID is checked by the server.</p>
          <div className="button-row"><button className="primary" type="submit" disabled={!online || busy}>{busy ? 'Submitting…' : 'Submit proposal'}</button><button className="quiet" type="button" onClick={() => setShowProposal(false)}>Cancel</button></div>
        </form>}
        {trade && ambiguousParty && <p className="notice warning">Trade mutations are disabled because this account currently appears able to represent both parties. The existing API has no explicit acting-party field and may resolve the seller first.</p>}
        {trade && <TradeDetails trade={trade} actingRole={actingRole} personPartyId={personPartyId} userId={userId} canWrite={Boolean(canWrite)} online={online} busy={busy} setBusy={setBusy} setError={onError} setMessage={onMessage} write={write} refreshTrade={refreshTrade} showAddLine={showAddLine} setShowAddLine={setShowAddLine} onAddLine={addLine} />}
        {!trade && !showProposal && <div className="empty-state">No trade detail is open. Search by an authorized trade UUID above; a list of all trades is not available from the current API.</div>}
      </section>
    </>
  );
}

function partyMayBeRepresented(personPartyId: string, roles: ActingRole[], partyId: string): boolean {
  if (personPartyId === partyId) return true;
  return roles.some((role) => TRADE_ROLES.has(role.roleCode) && role.scopeKind === 'ORGANISATION' && role.scopeId === partyId);
}

function TradeDetails({ trade, actingRole, personPartyId, userId, canWrite, online, busy, setBusy, setError, setMessage, write, refreshTrade, showAddLine, setShowAddLine, onAddLine }: {
  trade: GoldTrade;
  actingRole: ActingRole | null;
  personPartyId: string;
  userId: string;
  canWrite: boolean;
  online: boolean;
  busy: boolean;
  setBusy: (value: boolean) => void;
  setError: (value: string) => void;
  setMessage: (value: string) => void;
  write: <T>(path: string, body: unknown) => Promise<T>;
  refreshTrade: () => Promise<GoldTrade | null>;
  showAddLine: boolean;
  setShowAddLine: (value: boolean) => void;
  onAddLine: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const activeParty = actingPartyId(personPartyId, actingRole);
  const partySide = activeParty === trade.seller_party_id ? 'seller' : activeParty === trade.buyer_party_id ? 'buyer' : '';
  const open = ['PROPOSED', 'DISPUTED'].includes(trade.status);
  const currentLines = trade.lines.filter((line) => line.is_current);
  const decisions = trade.decisions ?? [];
  const undecidedByThisParty = currentLines.filter((line) => !decisions.some((decision) => decision.gold_trade_line_id === line.id && decision.actor_party_id === activeParty));

  return <>
    <div className="workspace-grid">
      <article className="overview-card"><span className="label">Trade status</span><strong>{readable(trade.status)}</strong><p>{trade.trade_code} · {readable(trade.trade_kind)} · {displayDate(trade.trade_date)}</p></article>
      <article className="overview-card"><span className="label">Parties</span><p>Seller: {trade.seller_party_id}</p><p>Buyer: {trade.buyer_party_id}</p><p>Currency: {trade.currency_code}</p></article>
      <article className="overview-card"><span className="label">Active party context</span><p>{partySide ? `${readable(partySide)} · ${activeParty}` : `${readable(actingRole?.roleCode)} does not match either party ID`}</p><p>Backend party representation remains authoritative.</p></article>
    </div>
    <section className="queue-section"><div className="section-heading"><div><p className="eyebrow">SOURCE MATERIAL AND TERMS</p><h3>Trade lines</h3></div>{canWrite && open && <button className="secondary" type="button" onClick={() => setShowAddLine(!showAddLine)}>Add source batch</button>}</div>
      {trade.terms_ref && <p>Terms reference: {trade.terms_ref}</p>}
      {trade.lines.map((line) => <TradeLineCard key={line.id} line={line} trade={trade} decisions={decisions} userId={userId} canWrite={canWrite} open={open} online={online} busy={busy} setBusy={setBusy} setError={setError} setMessage={setMessage} write={write} refreshTrade={refreshTrade} />)}
      {showAddLine && canWrite && open && <form className="form-stack" aria-label="Add gold trade source batch" onSubmit={onAddLine}><div className="form-grid">
        <label>Source gold batch ID<input name="batchId" required /></label><label>Proposed quantity (g)<input name="quantityGrams" inputMode="decimal" pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?" required /></label><label>Unit price<input name="unitPrice" inputMode="decimal" pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]{1,8})?" required /></label><label>Deduction amount<input name="deductionAmount" inputMode="decimal" pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]{1,8})?" /></label><label>Deduction reason<input name="deductionReason" maxLength={500} /></label>
      </div><button className="primary" type="submit" disabled={!online || busy}>Propose line</button></form>}
    </section>
    <section className="queue-section"><div className="section-heading"><div><p className="eyebrow">BILATERAL DECISIONS</p><h3>Decision history</h3></div></div>
      {decisions.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Party</th><th>Decision</th><th>Terms</th><th>Recorded</th><th>Reason / evidence</th></tr></thead><tbody>{decisions.map((decision) => <tr key={decision.id}><td>{decision.actor_party_id}<small>User {decision.actor_user_id}</small></td><td>{readable(decision.decision)}<small>Line {decision.gold_trade_line_id}</small></td><td>{decision.accepted_quantity_g ? `${decision.accepted_quantity_g} g · ${trade.currency_code} ${decision.accepted_unit_price}/g` : 'No accepted terms supplied'}</td><td>{displayDate(decision.occurred_at)}</td><td>{decision.reason ?? 'No reason'}{decision.evidence_ref ? <small>{decision.evidence_ref}</small> : null}</td></tr>)}</tbody></table></div> : <div className="empty-state">No party decision is recorded. A proposal remains proposed until both parties accept identical terms.</div>}
      {canWrite && open && undecidedByThisParty.map((line) => <TradeDecisionForm key={line.id} trade={trade} line={line} partySide={partySide} actingParty={activeParty} online={online} busy={busy} setBusy={setBusy} setError={setError} setMessage={setMessage} write={write} refreshTrade={refreshTrade} />)}
      {canWrite && open && undecidedByThisParty.length === 0 && currentLines.length > 0 && <p className="notice info">This party has already recorded a decision on each current line. The other party must act, or a new proposal revision must be submitted through the existing service.</p>}
      {!canWrite && <p className="muted">This role and party context are read-only. The server requires the authenticated user to represent the party recorded on each decision.</p>}
    </section>
    <section className="queue-section"><div className="section-heading"><div><p className="eyebrow">STATUS HISTORY</p><h3>Proposal history</h3></div></div>
      {trade.statusHistory.length ? <ol className="history-list">{trade.statusHistory.map((row, index) => <li key={`${row.actor_user_id}:${row.occurred_at}:${index}`}><strong>{readable(row.next_status)}</strong> · party {row.actor_party_id} · {displayDate(row.occurred_at)}{row.reason ? ` · ${row.reason}` : ''}</li>)}</ol> : <p>No status history returned.</p>}
      <p>Terms/evidence records: {trade.evidence?.length ?? 0}</p>
      {trade.evidence?.map((item) => <p key={item.id}>{readable(item.evidence_kind)} · {item.evidence_ref} · party {item.actor_party_id} · {displayDate(item.occurred_at)}</p>)}
    </section>
    <section className="queue-section"><div className="section-heading"><div><p className="eyebrow">RECONCILIATION AND MOVEMENT</p><h3>Agreement, discrepancy and custody</h3></div></div>
      <div className="workspace-grid"><article className="overview-card"><span className="label">Current proposal lines</span><strong>{currentLines.length}</strong><p>{trade.reconciliation.unresolvedLines.length} unresolved line(s)</p></article><article className="overview-card"><span className="label">Accepted trade amount</span><strong>{trade.currency_code} {trade.reconciliation.amountAgreed}</strong><p>Reported {trade.reconciliation.amountReported} · unresolved report {trade.reconciliation.amountDisputed}</p></article><article className="overview-card"><span className="label">Recorded confirmation</span><strong>{trade.currency_code} {trade.reconciliation.amountSettled}</strong><p>Outstanding against accepted terms: {trade.currency_code} {trade.reconciliation.amountOutstanding}</p></article></div>
      {trade.reconciliation.measurementDiscrepancies.map((row) => <p key={row.lineId}>Batch {row.batchId}: declared [{row.declaredQuantitiesGrams.join(', ') || 'none'}] g; measured [{row.measuredQuantitiesGrams.join(', ') || 'none'}] g; observation spread {row.observationSpreadGrams} g.</p>)}
      {trade.lines.flatMap((line) => line.custody ?? []).map((transfer) => <p key={transfer.id}>Custody offer {transfer.id} · {transfer.quantity_g} g · {readable(transfer.status)} · offered {displayDate(transfer.offered_at)}{transfer.last_decision ? ` · last decision ${readable(transfer.last_decision)}` : ''}</p>)}
      <p className="notice info">The reconciliation amount includes only backend-recorded trade and payment events. A recorded CONFIRMED event is the counterparty’s ledger entry, not independent proof that money moved.</p>
    </section>
  </>;
}

function TradeLineCard({ line, trade, decisions, userId, canWrite, open, online, busy, setBusy, setError, setMessage, write, refreshTrade }: {
  line: GoldTrade['lines'][number];
  trade: GoldTrade;
  decisions: GoldTrade['decisions'];
  userId: string;
  canWrite: boolean;
  open: boolean;
  online: boolean;
  busy: boolean;
  setBusy: (value: boolean) => void;
  setError: (value: string) => void;
  setMessage: (value: string) => void;
  write: <T>(path: string, body: unknown) => Promise<T>;
  refreshTrade: () => Promise<GoldTrade | null>;
}) {
  const [revising, setRevising] = useState(false);
  const priorDecisions = decisions.filter((decision) => decision.gold_trade_line_id === line.id);
  const alreadyAcceptedByBoth = priorDecisions.some((decision) => decision.decision === 'ACCEPT' && decision.actor_party_id === trade.seller_party_id)
    && priorDecisions.some((decision) => decision.decision === 'ACCEPT' && decision.actor_party_id === trade.buyer_party_id);

  const revise = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const correctionReason = String(data.get('correctionReason')).trim();
    if (!correctionReason) { setError('A proposal revision requires a reason.'); return; }
    setBusy(true);
    setError('');
    try {
      const result = await write<{ revisionNo: number }>(`/api/v1/gold-trades/${trade.id}/lines/${line.id}/revisions`, {
        quantityGrams: String(data.get('quantityGrams')).trim(),
        unitPrice: String(data.get('unitPrice')).trim(),
        correctionReason,
        occurredAt: new Date(String(data.get('occurredAt'))).toISOString(),
        ...(data.get('deductionAmount') ? { deductionAmount: String(data.get('deductionAmount')).trim(), deductionReason: String(data.get('deductionReason')).trim() } : {}),
        ...(data.get('evidenceRef') ? { evidenceRef: String(data.get('evidenceRef')).trim() } : {}),
      });
      setRevising(false);
      setMessage(`Revision ${result.revisionNo} was appended. The prior proposal remains visible and both parties must decide the new current line.`);
      await refreshTrade();
    } catch (error) { setError(apiError(error)); }
    finally { setBusy(false); }
  };

  return <article className="overview-card">
    <h4>{line.batch_code} · {readable(line.material_kind)} · revision {line.revision_no}{line.is_current ? ' (current)' : ' (superseded)'}</h4>
    <p>Batch {line.batch_id} · source event {line.source_event_id ?? 'not returned'} · quantity {line.transaction_quantity_g} g · proposed price {trade.currency_code} {line.unit_price}/g · amount {trade.currency_code} {line.line_amount}</p>
    {line.supersedes_line_id && <p>Revision of line {line.supersedes_line_id}: {line.correction_reason}</p>}
    {line.is_accepted && <p>Agreed quantity {line.accepted_trade_quantity_g} g · accepted by the bilateral decision chain.</p>}
    <p>Deduction: {line.deduction_amount} {trade.currency_code}{line.deduction_reason ? ` · ${line.deduction_reason}` : ''}</p>
    {canWrite && open && line.is_current && <button type="button" className="quiet" onClick={() => setRevising(!revising)}>{revising ? 'Cancel revision' : 'Propose a revision'}</button>}
    {revising && <form className="form-stack" aria-label={`Revise trade line ${line.id}`} onSubmit={(event) => void revise(event)}><div className="form-grid">
      <label>New quantity (g)<input name="quantityGrams" defaultValue={line.transaction_quantity_g} inputMode="decimal" pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?" required /></label>
      <label>New unit price<input name="unitPrice" defaultValue={line.unit_price} inputMode="decimal" pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]{1,8})?" required /></label>
      <label>Deduction amount<input name="deductionAmount" defaultValue={line.deduction_amount === '0.00000000' ? '' : line.deduction_amount} inputMode="decimal" /></label>
      <label>Deduction reason<input name="deductionReason" defaultValue={line.deduction_reason ?? ''} /></label>
      <label>Correction reason<input name="correctionReason" required maxLength={500} /></label>
      <label>Occurred at<input name="occurredAt" type="datetime-local" defaultValue={toDateTimeInput()} required /></label>
      <label>Evidence reference<input name="evidenceRef" maxLength={255} /></label>
    </div><div className="button-row"><button className="primary" type="submit" disabled={!online || busy}>Append revision</button><button className="quiet" type="button" onClick={() => setRevising(false)}>Cancel</button></div></form>}
    <p className="muted">Proposal by user {line.proposed_by_user_id}. Only current lines can be revised through the existing service.</p>
    {line.custody?.length ? line.custody.map((transfer) => <p key={transfer.id}>Custody {transfer.id}: {transfer.quantity_g} g · {readable(transfer.status)}</p>) : <p>Custody: no gold-trade-linked transfer returned.</p>}
    {alreadyAcceptedByBoth && <p className="notice success">Both parties recorded acceptance; the server reports the trade agreement state.</p>}
    <p>Proposal by user {line.proposed_by_user_id}{line.proposed_by_user_id === userId ? ' (this signed-in user)' : ''}.</p>
  </article>;
}

function TradeDecisionForm({ trade, line, partySide, actingParty, online, busy, setBusy, setError, setMessage, write, refreshTrade }: {
  trade: GoldTrade;
  line: GoldTrade['lines'][number];
  partySide: string;
  actingParty: string;
  online: boolean;
  busy: boolean;
  setBusy: (value: boolean) => void;
  setError: (value: string) => void;
  setMessage: (value: string) => void;
  write: <T>(path: string, body: unknown) => Promise<T>;
  refreshTrade: () => Promise<GoldTrade | null>;
}) {
  const [decision, setDecision] = useState<'ACCEPT' | 'DISPUTE' | 'REJECT'>('ACCEPT');
  const decide = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const reason = String(data.get('reason') ?? '').trim();
    if (decision !== 'ACCEPT' && !reason) { setError('A dispute or rejection requires a reason.'); return; }
    const body = {
      decision,
      occurredAt: new Date(String(data.get('occurredAt'))).toISOString(),
      ...(decision === 'ACCEPT' ? {
        quantityGrams: String(data.get('quantityGrams')).trim(),
        unitPrice: String(data.get('unitPrice')).trim(),
        ...(data.get('deductionAmount') ? { deductionAmount: String(data.get('deductionAmount')).trim(), deductionReason: String(data.get('deductionReason')).trim() } : {}),
      } : { reason }),
      ...(data.get('evidenceRef') ? { evidenceRef: String(data.get('evidenceRef')).trim() } : {}),
    };
    setBusy(true);
    setError('');
    try {
      const result = await write<{ status: string }>(`/api/v1/gold-trades/${trade.id}/lines/${line.id}/decisions`, body);
      setMessage(`${readable(partySide)} party decision recorded as ${readable(result.status)}. Matching acceptance from both parties is required for agreement.`);
      await refreshTrade();
    } catch (error) { setError(apiError(error)); }
    finally { setBusy(false); }
  };

  const existingForParty = trade.decisions.some((row) => row.gold_trade_line_id === line.id && row.actor_party_id === actingParty);
  return <form className="form-stack" aria-label={`Record ${partySide} party decision`} onSubmit={(event) => void decide(event)}>
    <h4>{readable(partySide)} party decision · {actingParty}</h4>
    {existingForParty && <p className="notice info">A decision from this party is already in history. A new entry is still submitted through the backend’s decision rules.</p>}
    <div className="form-grid">
      <label>Decision<select value={decision} onChange={(event) => setDecision(event.target.value as typeof decision)}><option value="ACCEPT">Accept proposed terms</option><option value="DISPUTE">Dispute terms</option><option value="REJECT">Reject proposal</option></select></label>
      {decision === 'ACCEPT' && <>
        <label>Accepted quantity (g)<input name="quantityGrams" defaultValue={line.transaction_quantity_g} inputMode="decimal" pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?" required /></label>
        <label>Accepted unit price<input name="unitPrice" defaultValue={line.unit_price} inputMode="decimal" pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]{1,8})?" required /></label>
        <label>Agreed deduction<input name="deductionAmount" inputMode="decimal" /></label><label>Deduction reason<input name="deductionReason" /></label>
      </>}
      {decision !== 'ACCEPT' && <label>Decision reason<input name="reason" required maxLength={500} /></label>}
      <label>Occurred at<input type="datetime-local" name="occurredAt" defaultValue={toDateTimeInput()} required /></label>
      <label>Evidence reference<input name="evidenceRef" maxLength={255} /></label>
    </div>
    <p className="muted">The request is made in the currently selected {partySide} context. A first acceptance remains pending; the API records the represented party and resolves the trade only if both parties accept identical terms.</p>
    <button className="secondary" type="submit" disabled={!online || busy}>{busy ? 'Recording…' : `Record ${partySide} decision`}</button>
  </form>;
}
