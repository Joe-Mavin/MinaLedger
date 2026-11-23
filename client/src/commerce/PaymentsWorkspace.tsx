import { useState, type FormEvent } from 'react';
import { actingPartyId, displayDate, readable, toDateTimeInput, type ActingRole, type GoldPayment, type GoldTrade } from './types';

const TRADE_ROLES = new Set([
  'FIELD_OFFICER', 'MINING_OPERATOR', 'MINER', 'DORA_OPERATOR', 'RECOVERY_FACILITY_OPERATOR', 'LOCAL_MERCHANT', 'LARGER_MERCHANT',
]);

interface Props {
  personPartyId: string;
  actingRole: ActingRole | null;
  roles: ActingRole[];
  online: boolean;
  trade: GoldTrade | null;
  write: <T>(path: string, body: unknown) => Promise<T>;
  refreshTrade: () => Promise<GoldTrade | null>;
  onError: (message: string) => void;
  onMessage: (message: string) => void;
}

function apiError(error: unknown): string {
  return error instanceof Error ? error.message : 'The server could not complete the request.';
}

export function PaymentsWorkspace({ personPartyId, actingRole, roles, online, trade, write, refreshTrade, onError, onMessage }: Props) {
  const [busy, setBusy] = useState(false);
  const activeParty = actingPartyId(personPartyId, actingRole);
  const canAct = Boolean(actingRole && TRADE_ROLES.has(actingRole.roleCode) && actingRole.roleCode !== 'AUDITOR'
    && trade && [trade.seller_party_id, trade.buyer_party_id].includes(activeParty));
  const ambiguousParty = Boolean(trade && partyMayBeRepresented(personPartyId, roles, trade.seller_party_id) && partyMayBeRepresented(personPartyId, roles, trade.buyer_party_id));
  const isBuyer = Boolean(trade && activeParty === trade.buyer_party_id && canAct);
  const isSeller = Boolean(trade && activeParty === trade.seller_party_id && canAct);

  const reportPayment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!trade) return;
    const data = new FormData(event.currentTarget);
    const form = event.currentTarget;
    const occurredAt = new Date(String(data.get('occurredAt')));
    if (Number.isNaN(occurredAt.getTime())) { onError('Enter a valid payment-report time.'); return; }
    setBusy(true);
    onError('');
    try {
      const created = await write<{ id: string; status: string; verifiedExternally: boolean }>(`/api/v1/gold-trades/${trade.id}/payments`, {
        amount: String(data.get('amount')).trim(),
        methodCode: String(data.get('methodCode')).trim(),
        ...(data.get('reference') ? { reference: String(data.get('reference')).trim() } : {}),
        ...(data.get('evidenceRef') ? { evidenceRef: String(data.get('evidenceRef')).trim() } : {}),
        occurredAt: occurredAt.toISOString(),
      });
      onMessage(`Payment report ${created.id} was recorded as ${readable(created.status)}. The report is not external proof that money moved.`);
      await refreshTrade();
      form.reset();
    } catch (error) { onError(apiError(error)); }
    finally { setBusy(false); }
  };

  return <>
    <section className="queue-section" aria-labelledby="payments-heading">
      <div className="section-heading"><div><p className="eyebrow">GOLD-TRADE PAYMENT SERVICE</p><h2 id="payments-heading">Payment reports and decisions</h2></div></div>
      {!trade && <div className="empty-state">Open a party-authorized gold trade above to inspect its payment reports. No residue-sale payment endpoint exists.</div>}
      {actingRole?.roleCode === 'AUDITOR' && <p className="notice info">Auditor controls are read-only. The current trade-detail endpoint requires seller or buyer party representation, so an Auditor grant alone cannot inspect these payments.</p>}
      {trade && <>
        <div className="overview-card"><span className="label">Trade and party obligations</span><strong>{trade.trade_code} · {readable(trade.status)}</strong><p>Seller {trade.seller_party_id} · buyer {trade.buyer_party_id}</p><p>Agreed terms: {trade.reconciliation.currencyCode} {trade.reconciliation.amountAgreed}</p></div>
        <div className="workspace-grid">
          <article className="overview-card"><span className="label">Payment reports</span><strong>{trade.reconciliation.currencyCode} {trade.reconciliation.amountReported}</strong><p>Reported amount from trade detail</p></article>
          <article className="overview-card"><span className="label">Recorded confirmations net of reversals</span><strong>{trade.reconciliation.currencyCode} {trade.reconciliation.amountSettled}</strong><p>This is a backend payment-event total, not independently verified money movement.</p></article>
          <article className="overview-card"><span className="label">Outstanding against agreed terms</span><strong>{trade.reconciliation.currencyCode} {trade.reconciliation.amountOutstanding}</strong><p>Unresolved report(s): {trade.reconciliation.unresolvedPaymentReports.length}</p></article>
        </div>
        <p className="notice warning">The API records a payment report and a counterparty decision. It does not connect to M-Pesa or a bank, verify an external transfer, or prove settlement. A CONFIRMED event is the other party’s recorded decision only.</p>
        {ambiguousParty && <p className="notice warning">Payment decisions are disabled because this account has active role assignments for both parties and the existing decision API does not accept an explicit acting-party field. A buyer-only report remains available when the selected context is the buyer.</p>}
        {trade.payments.length === 0 ? <div className="empty-state">No payment report is present on this trade.</div> : <div className="table-wrap"><table className="data-table"><thead><tr><th>Payment</th><th>Parties</th><th>Reported</th><th>Recorded confirmation</th><th>Latest status</th><th>Created</th></tr></thead><tbody>{trade.payments.map((payment) => <tr key={payment.id}>
          <td>{payment.id}</td><td>Payer {payment.payer_party_id}<small>Payee {payment.payee_party_id}</small></td><td>{payment.currency_code} {payment.reported_amount}</td><td>{payment.currency_code} {payment.settled_amount}</td><td>{readable(payment.current_status)}{payment.disputed && <small>Dispute recorded</small>}</td><td>{displayDate(payment.created_at)}</td>
        </tr>)}</tbody></table></div>}
        <p className="muted">The current read API returns payment totals, current status and payment creation time. It does not return each payment event’s actor, event timestamp, decision evidence or reference. The screen does not infer those fields.</p>
        {isBuyer && trade.status === 'AGREED' && <form className="form-stack" aria-label="Report payment" onSubmit={(event) => void reportPayment(event)}><h3>Report a payment · buyer party</h3><div className="form-grid">
          <label>Amount<input name="amount" inputMode="decimal" pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]{1,8})?" required /></label>
          <label>Recorded method code<input name="methodCode" placeholder="e.g. CASH_RECORDED" maxLength={40} required /></label>
          <label>Reference<input name="reference" maxLength={160} /></label>
          <label>Evidence reference<input name="evidenceRef" maxLength={255} /></label>
          <label>Occurred at<input name="occurredAt" type="datetime-local" defaultValue={toDateTimeInput()} required /></label>
        </div><p className="muted">The API permits the buyer party to report a payment only after trade agreement. The entry records a report; it does not verify external transfer.</p><button className="primary" type="submit" disabled={!online || busy}>{busy ? 'Recording…' : 'Report payment'}</button></form>}
        {trade.payments.map((payment) => <PaymentDecisionForm
          key={payment.id}
          payment={payment}
          trade={trade}
          isBuyer={Boolean(isBuyer)}
          isSeller={Boolean(isSeller)}
          ambiguousParty={ambiguousParty}
          online={online}
          busy={busy}
          setBusy={setBusy}
          onError={onError}
          onMessage={onMessage}
          write={write}
          refreshTrade={refreshTrade}
        />)}
        {!canAct && actingRole?.roleCode !== 'AUDITOR' && <p className="muted">Payment reports and decisions are read-only because the current acting party context does not match this trade’s seller or buyer.</p>}
      </>}
    </section>
    <section className="queue-section" aria-labelledby="payment-workflow-separation">
      <div className="section-heading"><div><p className="eyebrow">KEEP THE RECORDS DISTINCT</p><h2 id="payment-workflow-separation">Agreement, report and movement</h2></div></div>
      <ol className="history-list"><li><strong>Trade agreement:</strong> both parties accept identical terms through the gold-trade decision flow.</li><li><strong>Payment report:</strong> buyer records a reported amount, method, reference and evidence.</li><li><strong>Payment decision:</strong> an authorized party records confirmation, dispute, failure or reversal as supported by the API.</li><li><strong>Actual money movement:</strong> not integrated or independently verified by this application.</li></ol>
      <p className="notice info">Residue-sale settlement is unsupported. No residue payment controls are shown and gold-trade payment routes are never reused for residue sales.</p>
    </section>
  </>;
}

function partyMayBeRepresented(personPartyId: string, roles: ActingRole[], partyId: string): boolean {
  if (personPartyId === partyId) return true;
  return roles.some((role) => TRADE_ROLES.has(role.roleCode) && role.scopeKind === 'ORGANISATION' && role.scopeId === partyId);
}

function PaymentDecisionForm({ payment, trade, isBuyer, isSeller, ambiguousParty, online, busy, setBusy, onError, onMessage, write, refreshTrade }: {
  payment: GoldPayment;
  trade: GoldTrade;
  isBuyer: boolean;
  isSeller: boolean;
  ambiguousParty: boolean;
  online: boolean;
  busy: boolean;
  setBusy: (value: boolean) => void;
  onError: (message: string) => void;
  onMessage: (message: string) => void;
  write: <T>(path: string, body: unknown) => Promise<T>;
  refreshTrade: () => Promise<GoldTrade | null>;
}) {
  const [decision, setDecision] = useState<'CONFIRM' | 'DISPUTE' | 'FAIL' | 'REVERSE'>(isSeller ? 'CONFIRM' : 'DISPUTE');
  const canDecide = (isSeller || isBuyer) && !ambiguousParty;
  if (!canDecide) return null;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const reason = String(data.get('reason') ?? '').trim();
    if ((decision === 'DISPUTE' || decision === 'FAIL' || decision === 'REVERSE') && !reason) { onError('A dispute, failure or reversal requires a reason.'); return; }
    const occurredAt = new Date(String(data.get('occurredAt')));
    if (Number.isNaN(occurredAt.getTime())) { onError('Enter a valid decision time.'); return; }
    const body = {
      decision,
      occurredAt: occurredAt.toISOString(),
      ...(decision === 'REVERSE' ? { amount: String(data.get('amount')).trim(), reason } : {}),
      ...(decision === 'DISPUTE' || decision === 'FAIL' ? { reason } : {}),
      ...(data.get('methodCode') ? { methodCode: String(data.get('methodCode')).trim() } : {}),
      ...(data.get('reference') ? { reference: String(data.get('reference')).trim() } : {}),
      ...(data.get('evidenceRef') ? { evidenceRef: String(data.get('evidenceRef')).trim() } : {}),
    };
    setBusy(true);
    onError('');
    try {
      const result = await write<{ id: string; status: string }>(`/api/v1/gold-trades/${trade.id}/payments/${payment.id}/decisions`, body);
      onMessage(`${readable(result.status)} was recorded for payment ${payment.id}. This remains a ledger event, not external transfer verification.`);
      await refreshTrade();
    } catch (error) { onError(apiError(error)); }
    finally { setBusy(false); }
  };

  return <form className="form-stack" aria-label={`Decide payment ${payment.id}`} onSubmit={(event) => void submit(event)}><h3>Payment report decision · {payment.id}</h3><div className="form-grid">
    <label>Decision<select value={decision} onChange={(event) => setDecision(event.target.value as typeof decision)}>
      {isSeller && <><option value="CONFIRM">Confirm reported payment</option><option value="FAIL">Record payment failure</option></>}
      <option value="DISPUTE">Dispute report</option><option value="REVERSE">Reverse confirmed amount</option>
    </select></label>
    {decision === 'REVERSE' && <label>Reversal amount<input name="amount" inputMode="decimal" pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]{1,8})?" required /></label>}
    {(decision === 'DISPUTE' || decision === 'FAIL' || decision === 'REVERSE') && <label>Decision reason<input name="reason" maxLength={500} required /></label>}
    {(decision === 'CONFIRM' || decision === 'FAIL') && <label>Method code (optional)<input name="methodCode" maxLength={40} /></label>}
    <label>Reference (optional)<input name="reference" maxLength={160} /></label><label>Evidence reference<input name="evidenceRef" maxLength={255} /></label>
    <label>Occurred at<input name="occurredAt" type="datetime-local" defaultValue={toDateTimeInput()} required /></label>
  </div><p className="muted">This {isSeller ? 'seller' : 'buyer'} party can submit only the choices allowed by the current backend payment decision service. The request is recorded with an idempotency key.</p><button className="secondary" type="submit" disabled={!online || busy}>{busy ? 'Recording…' : 'Record payment decision'}</button></form>;
}
