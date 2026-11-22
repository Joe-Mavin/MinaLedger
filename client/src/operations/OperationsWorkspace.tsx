import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { apiRequest, type SiteReference } from '../api';
import { WorkspaceHeading } from '../AppShell';

type RoleGrant = { roleCode: string; scopeKind: string; scopeId: string };
type Pane = 'processing' | 'residue' | 'sales' | 'consignments' | 'recovery';
type MeasurementKind = 'DECLARED' | 'MEASURED' | 'VERIFIED';
type Measurement = {
  id?: string; measurement_kind?: MeasurementKind; kind?: MeasurementKind; quantity_g?: string; quantityGrams?: string;
  source_value?: string; sourceValue?: string; source_unit_code?: string; sourceUnit?: string; conversion_version?: string;
  conversionVersion?: string; source_role?: string; sourceRole?: string; source_party_id?: string | null; method_code?: string | null;
  instrument_ref?: string | null; evidence_ref?: string | null; occurred_at_claimed?: string;
};
type Dora = { id: string; name: string; status: string; site_ids?: string[]; siteId?: string };
type ProcessingEvent = { id: string; event_code: string; occurred_at_claimed: string; recorded_at: string; current_status: string; processing_facility_id: string; processing_facility_name: string; input_count: number; output_count: number; sourceSiteIds?: string[]; sourceHoleIds?: string[] };
type ProcessingDetail = ProcessingEvent & { inputs: Array<{ id: string; batch_id: string; batch_code: string; material_kind: string; source_production_output_id: string; source_event_id: string; measurements: Measurement[] }>; outputs: Array<{ id: string; batch_id: string; batch_code: string; material_kind: string; output_role: string; measurements: Measurement[] }> };
type StockpileRow = { id: string; stockpile_code: string; location_code: string; processing_facility_id: string; location_ref: string | null; batch_id: string | null; batch_code: string | null; material_kind: string | null; origin_processing_event_id: string | null; origin_output_id: string | null; quantity_g: string | null };
type ResidueOutput = { output_id: string; processing_event_id: string; event_code: string; occurred_at_claimed: string; batch_id: string; batch_code: string; material_kind: string; output_role: string; measurement_id: string; measurement_kind: MeasurementKind; quantity_g: string; source_value: string; source_unit_code: string; conversion_version: string; source_role: string; method_code: string | null; evidence_ref: string | null };
type Balance = { batch_id: string; batch_code: string; material_kind: string; quantity_g: string };
type InventoryMovement = { movement_id: string; movement_line_id: string; movement_kind: string; occurred_at_claimed: string; current_status: string; direction: string; posted_quantity_g: string; batch_code: string; material_kind: string; source_material_event_output_id: string | null; consignment_receipt_item_id: string | null; measurement_kind: string | null; source_value: string | null; source_unit_code: string | null; source_role: string | null; method_code: string | null; evidence_ref: string | null };
type RecoveryFacility = { id: string; name: string; status: string; party_id: string | null; locations?: RecoveryLocation[] };
type RecoveryDestination = { id: string; name: string; status: string; locations: Array<{ id: string; locationCode: string }> };
type RecoveryLocation = { id: string; location_code: string; physical_place_ref: string | null; location_ref: string | null };
type EligibleRecoveryInput = { receipt_item_id: string; consignment_id: string; batch_id: string; batch_code: string; material_kind: string; consignment_code: string; quantity_g: string; available_quantity_g: string; evidence_ref: string | null };
type RecoveryEvent = { id: string; event_code: string; occurred_at_claimed: string; recorded_at: string; current_status: string; method_ref: string | null; input_count: number; output_count: number };
type Consignment = { id: string; consignment_code: string; status: string; destination_recovery_facility_id: string; created_at: string; dispatched_at: string | null; received_at: string | null; sourceFacilityIds?: string[] };
type ConsignmentDetail = Consignment & {
  transit_location_id: string;
  items: Array<{ id: string; batch_id: string; batch_code: string; source_location_id: string; line_no: number; dispatch_measurement_id: string | null; dispatched_quantity_g: string; accepted_receipt_quantity_g: string; disputed_receipt_quantity_g: string; rejected_receipt_quantity_g: string }>;
  transportLegs: Array<Record<string, string | null>>;
  receipts: Array<Record<string, string | null>>;
  receiptItems: Array<{ id: string; consignment_item_id: string; batch_id: string; quantity_g: string; outcome: string; reason: string | null; evidence_ref: string | null; supersedes_receipt_item_id: string | null }>;
  custodyTransfers: Array<{ id: string; status: string; destination_location_id: string; offered_at: string; decisions: Array<{ id: string; decision: string; occurredAt: string; reason: string | null }> }>;
};
type ResidueSale = { id: string; sale_code: string; seller_party_id: string; buyer_party_id: string; agreed_at: string; currency_code: string; terms_ref: string | null; created_at: string };
type ResidueSaleDetail = ResidueSale & { lines: Array<{ id: string; batch_id: string; batch_code: string; processing_facility_id: string; transaction_quantity_g: string; accepted_trade_quantity_g: string | null; unit_price: string | null; line_amount: string | null; revision_no: number; is_accepted: boolean }>; decisions: Array<{ residue_sale_line_id: string; decision: string; actor_party_id: string; accepted_quantity_g: string | null; reason: string | null }> };
type RecoveryDetail = { id: string; event_code: string; occurred_at_claimed: string; method_ref: string | null; inputs: Array<{ id: string; batch_id: string; batch_code: string; quantity_g: string; measurement_id: string; measurement_kind: string; source_value: string; source_unit_code: string; source_role: string; method_code: string | null; evidence_ref: string | null; sources: Array<{ receipt_item_id: string; consignment_item_id: string; consignment_id: string; consignment_code: string; quantity_g: string }> }>; outputs: Array<{ id: string; batch_id: string; batch_code: string; material_kind: string; output_role: string; quantity_g: string; measurement_id: string; measurement_kind: string; source_value: string; source_unit_code: string; source_role: string; method_code: string | null; evidence_ref: string | null; contributing_batch_ids: string[] }>; stages: Array<{ stage_code: string; occurred_at_claimed: string; evidence_ref: string | null; note: string | null }>; variances: Array<{ variance_kind: string; expected_quantity_g: string | null; observed_quantity_g: string | null; variance_quantity_g: string | null; reason: string; evidence_ref: string | null }> };

const panes: Array<{ id: Pane; label: string }> = [
  { id: 'processing', label: 'Dora & processing' }, { id: 'residue', label: 'Residue inventory' },
  { id: 'sales', label: 'Residue sales' }, { id: 'consignments', label: 'Consignments & custody' }, { id: 'recovery', label: 'Recovery' },
];
const nowIso = () => new Date().toISOString();
const key = () => crypto.randomUUID();
const textValue = (value: unknown) => value === null || value === undefined || value === '' ? '—' : String(value);
const quantity = (value: unknown) => `${textValue(value)} g`;
const dateValue = (value?: string | null) => value ? new Date(value).toLocaleString() : '—';
const measurementKind = (value?: string | null) => value?.replaceAll('_', ' ') ?? 'Unspecified';
const classes = 'form-grid';

interface Props {
  token: string;
  selectedRole: RoleGrant | null;
  sites: SiteReference[];
  online: boolean;
}

export function OperationsWorkspace({ token, selectedRole, sites, online }: Props) {
  const [pane, setPane] = useState<Pane>('processing');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [doras, setDoras] = useState<Dora[]>([]);
  const [processingEvents, setProcessingEvents] = useState<ProcessingEvent[]>([]);
  const [selectedDoraId, setSelectedDoraId] = useState('');
  const [selectedEventId, setSelectedEventId] = useState('');
  const [processingDetail, setProcessingDetail] = useState<ProcessingDetail | null>(null);
  const [sourceEvents, setSourceEvents] = useState<Array<{ id: string; event_code: string; hole_id: string; outputs: Array<{ id: string; batch_id: string; batch_code: string; material_kind: string; measurements: Measurement[] }> }>>([]);
  const [sourceEventId, setSourceEventId] = useState('');
  const [sourceOutputId, setSourceOutputId] = useState('');
  const [stockpiles, setStockpiles] = useState<StockpileRow[]>([]);
  const [eligibleOutputs, setEligibleOutputs] = useState<ResidueOutput[]>([]);
  const [selectedStockpileId, setSelectedStockpileId] = useState('');
  const [balances, setBalances] = useState<Balance[]>([]);
  const [movements, setMovements] = useState<InventoryMovement[]>([]);
  const [consignments, setConsignments] = useState<Consignment[]>([]);
  const [selectedConsignmentId, setSelectedConsignmentId] = useState('');
  const [consignmentDetail, setConsignmentDetail] = useState<ConsignmentDetail | null>(null);
  const [sales, setSales] = useState<ResidueSale[]>([]);
  const [selectedSaleId, setSelectedSaleId] = useState('');
  const [saleDetail, setSaleDetail] = useState<ResidueSaleDetail | null>(null);
  const [recoveryFacilities, setRecoveryFacilities] = useState<RecoveryFacility[]>([]);
  const [selectedRecoveryId, setSelectedRecoveryId] = useState('');
  const [recoveryInputs, setRecoveryInputs] = useState<EligibleRecoveryInput[]>([]);
  const [recoveryEvents, setRecoveryEvents] = useState<RecoveryEvent[]>([]);
  const [selectedRecoveryEventId, setSelectedRecoveryEventId] = useState('');
  const [recoveryDetail, setRecoveryDetail] = useState<RecoveryDetail | null>(null);
  const [recoveryDestinations, setRecoveryDestinations] = useState<RecoveryDestination[]>([]);
  const [newOutputRows, setNewOutputRows] = useState([{ materialKind: 'RESIDUE', outputRole: 'DORA_RETAINED_RESIDUE', quantityGrams: '', sourceValue: '', sourceUnit: 'g', sourceRole: 'RECORDER', sourcePartyId: '', methodCode: '', evidenceRef: '' }]);
  const [recoveryOutputKind, setRecoveryOutputKind] = useState<'RECOVERED_GOLD' | 'PROCESS_OUTPUT'>('RECOVERED_GOLD');

  const activeRole = selectedRole;
  const isAuditor = activeRole?.roleCode === 'AUDITOR';
  const canWriteDora = Boolean(selectedDoraId && activeRole?.roleCode === 'DORA_OPERATOR' && activeRole.scopeKind === 'FACILITY' && activeRole.scopeId === selectedDoraId);
  const canWriteRecovery = Boolean(selectedRecoveryId && activeRole?.roleCode === 'RECOVERY_FACILITY_OPERATOR' && activeRole.scopeKind === 'FACILITY' && activeRole.scopeId === selectedRecoveryId);
  const selectedSourceEvent = sourceEvents.find((event) => event.id === sourceEventId);
  const selectedSourceOutput = selectedSourceEvent?.outputs.find((output) => output.id === sourceOutputId);
  const selectedRecovery = recoveryFacilities.find((facility) => facility.id === selectedRecoveryId);
  const stockpileChoices = useMemo(() => {
    const seen = new Map<string, { id: string; label: string; processing_facility_id: string }>();
    stockpiles.forEach((row) => seen.set(row.id, { id: row.id, label: `${row.stockpile_code} (${row.location_code})`, processing_facility_id: row.processing_facility_id }));
    return [...seen.values()];
  }, [stockpiles]);

  const refreshBase = useCallback(async () => {
    const [doraRows, processingRows, recoveryRows, consignmentRows, saleRows] = await Promise.all([
      apiRequest<Dora[]>('/api/v1/doras', token), apiRequest<ProcessingEvent[]>('/api/v1/processing-events', token),
      apiRequest<RecoveryFacility[]>('/api/v1/recovery-facilities', token), apiRequest<Consignment[]>('/api/v1/consignments', token),
      apiRequest<ResidueSale[]>('/api/v1/residue-sales', token),
    ]);
    const siteDoras = await Promise.all(sites.map(async (site) => {
      try { return await apiRequest<Dora[]>(`/api/v1/sites/${site.id}/doras`, token); } catch { return []; }
    }));
    const combinedDoras = new Map<string, Dora>();
    [...doraRows, ...siteDoras.flat()].forEach((row) => combinedDoras.set(row.id, row));
    setDoras([...combinedDoras.values()]); setProcessingEvents(processingRows); setRecoveryFacilities(recoveryRows);
    setConsignments(consignmentRows); setSales(saleRows);
    setSelectedDoraId((current) => current && combinedDoras.has(current) ? current : [...combinedDoras.keys()][0] ?? '');
    setSelectedRecoveryId((current) => current && recoveryRows.some((row) => row.id === current) ? current : recoveryRows[0]?.id ?? '');
    setSelectedConsignmentId((current) => current && consignmentRows.some((row) => row.id === current) ? current : consignmentRows[0]?.id ?? '');
    setSelectedSaleId((current) => current && saleRows.some((row) => row.id === current) ? current : saleRows[0]?.id ?? '');
    setSelectedEventId((current) => current && processingRows.some((row) => row.id === current) ? current : processingRows[0]?.id ?? '');
  }, [sites, token]);

  const loadStockpiles = useCallback(async (facilityId: string) => {
    if (!facilityId) { setStockpiles([]); setEligibleOutputs([]); return; }
    const [rows, outputRows] = await Promise.all([
      apiRequest<StockpileRow[]>(`/api/v1/doras/${facilityId}/stockpiles`, token),
      apiRequest<ResidueOutput[]>(`/api/v1/doras/${facilityId}/residue-outputs`, token),
    ]);
    setStockpiles(rows); setEligibleOutputs(outputRows);
    setSelectedStockpileId((current) => current && rows.some((row) => row.id === current) ? current : rows[0]?.id ?? '');
  }, [token]);

  const loadConsignment = useCallback(async (consignmentId: string) => {
    if (!consignmentId) { setConsignmentDetail(null); return; }
    setConsignmentDetail(await apiRequest<ConsignmentDetail>(`/api/v1/consignments/${consignmentId}`, token));
  }, [token]);

  const loadSale = useCallback(async (saleId: string) => {
    if (!saleId) { setSaleDetail(null); return; }
    setSaleDetail(await apiRequest<ResidueSaleDetail>(`/api/v1/residue-sales/${saleId}`, token));
  }, [token]);

  const loadRecovery = useCallback(async (facilityId: string) => {
    if (!facilityId) { setRecoveryInputs([]); setRecoveryEvents([]); return; }
    const [facility, inputs, events] = await Promise.all([
      apiRequest<RecoveryFacility>(`/api/v1/recovery-facilities/${facilityId}`, token),
      apiRequest<EligibleRecoveryInput[]>(`/api/v1/recovery-facilities/${facilityId}/eligible-inputs`, token),
      apiRequest<RecoveryEvent[]>(`/api/v1/recovery-facilities/${facilityId}/recovery-events`, token),
    ]);
    setRecoveryFacilities((current) => current.map((row) => row.id === facility.id ? facility : row));
    setRecoveryInputs(inputs); setRecoveryEvents(events);
    setSelectedRecoveryEventId((current) => current && events.some((row) => row.id === current) ? current : events[0]?.id ?? '');
  }, [token]);

  const refreshAll = useCallback(async () => {
    if (!online) return;
    setBusy(true); setError('');
    try { await refreshBase(); }
    catch (loadError) { setError(loadError instanceof Error ? loadError.message : 'Operations data could not be loaded.'); }
    finally { setBusy(false); }
  }, [online, refreshBase]);

  useEffect(() => { void refreshAll(); }, [refreshAll]);
  useEffect(() => {
    if (online && selectedDoraId) void loadStockpiles(selectedDoraId).catch((loadError) => setError(loadError instanceof Error ? loadError.message : 'Dora stockpiles could not be loaded.'));
  }, [online, selectedDoraId, loadStockpiles]);
  useEffect(() => {
    if (online && canWriteDora && selectedDoraId) {
      void apiRequest<RecoveryDestination[]>(`/api/v1/doras/${selectedDoraId}/recovery-destinations`, token).then(setRecoveryDestinations).catch((loadError) => setError(loadError instanceof Error ? loadError.message : 'Recovery destinations could not be loaded.'));
    } else setRecoveryDestinations([]);
  }, [online, canWriteDora, selectedDoraId, token]);
  useEffect(() => {
    if (online && selectedStockpileId) {
      void Promise.all([
        apiRequest<Balance[]>(`/api/v1/inventory/locations/${selectedStockpileId}/balances`, token).then(setBalances),
        apiRequest<InventoryMovement[]>(`/api/v1/inventory/locations/${selectedStockpileId}/movements`, token).then(setMovements),
      ]).catch((loadError) => setError(loadError instanceof Error ? loadError.message : 'Inventory details could not be loaded.'));
    } else { setBalances([]); setMovements([]); }
  }, [online, selectedStockpileId, token]);
  useEffect(() => {
    if (online && selectedConsignmentId) void loadConsignment(selectedConsignmentId).catch((loadError) => setError(loadError instanceof Error ? loadError.message : 'Consignment details could not be loaded.'));
  }, [online, selectedConsignmentId, loadConsignment]);
  useEffect(() => {
    if (online && selectedSaleId) void loadSale(selectedSaleId).catch((loadError) => setError(loadError instanceof Error ? loadError.message : 'Residue sale details could not be loaded.'));
  }, [online, selectedSaleId, loadSale]);
  useEffect(() => {
    if (online && selectedRecoveryId) void loadRecovery(selectedRecoveryId).catch((loadError) => setError(loadError instanceof Error ? loadError.message : 'Recovery facility data could not be loaded.'));
  }, [online, selectedRecoveryId, loadRecovery]);
  useEffect(() => {
    if (online && selectedEventId) void apiRequest<ProcessingDetail>(`/api/v1/processing-events/${selectedEventId}`, token).then(setProcessingDetail).catch((loadError) => setError(loadError instanceof Error ? loadError.message : 'Processing event details could not be loaded.'));
    else setProcessingDetail(null);
  }, [online, selectedEventId, token]);
  useEffect(() => {
    if (online && selectedRecoveryEventId) void apiRequest<RecoveryDetail>(`/api/v1/recovery-events/${selectedRecoveryEventId}`, token).then(setRecoveryDetail).catch((loadError) => setError(loadError instanceof Error ? loadError.message : 'Recovery event details could not be loaded.'));
    else setRecoveryDetail(null);
  }, [online, selectedRecoveryEventId, token]);

  async function mutate(path: string, body: unknown, method = 'POST') {
    if (!online) throw new Error('This operation needs a live server connection. Reconnect before submitting.');
    const mutationId = key();
    const result = await apiRequest<Record<string, unknown>>(path, token, { method, headers: { 'Idempotency-Key': mutationId }, body: JSON.stringify(body) });
    setMessage('The server recorded the operation. Refreshing current records.');
    setError('');
    await refreshBase();
    if (selectedDoraId) await loadStockpiles(selectedDoraId).catch(() => undefined);
    if (selectedRecoveryId) await loadRecovery(selectedRecoveryId).catch(() => undefined);
    if (selectedConsignmentId) await loadConsignment(selectedConsignmentId).catch(() => undefined);
    if (selectedSaleId) await loadSale(selectedSaleId).catch(() => undefined);
    return result;
  }

  async function onForm(event: FormEvent<HTMLFormElement>, action: () => Promise<unknown>) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    try { await action(); } catch (formError) { setError(formError instanceof Error ? formError.message : 'The operation could not be completed.'); }
    finally { setBusy(false); }
  }

  async function loadProductionSources(siteId: string) {
    if (!siteId) { setSourceEvents([]); return; }
    const rows = await apiRequest<Array<{ id: string; event_code: string; hole_id: string }>>(`/api/v1/sites/${siteId}/production-events`, token);
    const details = await Promise.all(rows.map(async (row) => {
      const detail = await apiRequest<{ id: string; outputs: Array<{ id: string; batch_id: string; batch_code: string; material_kind: string; measurements: Measurement[] }> }>(`/api/v1/sites/${siteId}/production-events/${row.id}`, token);
      return { id: row.id, event_code: row.event_code, hole_id: row.hole_id, outputs: detail.outputs };
    }));
    setSourceEvents(details); setSourceEventId(details[0]?.id ?? ''); setSourceOutputId(details[0]?.outputs[0]?.id ?? '');
  }

  async function recordProcessing(event: FormEvent<HTMLFormElement>) {
    const siteId = (new FormData(event.currentTarget).get('siteId') ?? '').toString();
    const selectedOutput = selectedSourceEvent?.outputs.find((row) => row.id === sourceOutputId);
    if (!selectedOutput || !selectedDoraId) throw new Error('Choose an accessible production output and Dora.');
    const fields = new FormData(event.currentTarget);
    const inputs = [{ sourceProductionOutputId: selectedOutput.id, measurements: [makeMeasurement(fields, 'input')] }];
    const outputs = newOutputRows.map((row) => ({
      materialKind: row.materialKind,
      outputRole: row.outputRole,
      measurements: [{ kind: 'MEASURED', quantityGrams: row.quantityGrams, sourceValue: row.sourceValue || row.quantityGrams, sourceUnit: row.sourceUnit, conversionVersion: 'manual-v1', sourceRole: row.sourceRole, ...(row.sourcePartyId ? { sourcePartyId: row.sourcePartyId } : {}), ...(row.methodCode ? { methodCode: row.methodCode } : {}), ...(row.evidenceRef ? { evidenceRef: row.evidenceRef } : {}), occurredAt: nowIso() }],
    }));
    const arrangement = fields.get('arrangement')?.toString().trim() ?? '';
    const terms = fields.get('terms')?.toString().trim() ?? '';
    await mutate(`/api/v1/sites/${siteId}/processing-events`, {
      processingFacilityId: selectedDoraId, occurredAt: nowIso(),
      ...(arrangement && terms ? { compensationArrangementCode: arrangement, serviceTermsRef: terms } : {}),
      inputs, outputs,
    });
  }

  function makeMeasurement(fields: FormData, prefix: string) {
    const quantityGrams = fields.get(`${prefix}Quantity`)?.toString().trim() ?? '';
    const sourceValue = fields.get(`${prefix}SourceValue`)?.toString().trim() || quantityGrams;
    return {
      kind: (fields.get(`${prefix}Kind`)?.toString() || 'MEASURED') as MeasurementKind,
      quantityGrams, sourceValue, sourceUnit: fields.get(`${prefix}Unit`)?.toString() || 'g',
      conversionVersion: 'manual-v1', sourceRole: fields.get(`${prefix}Role`)?.toString() || 'RECORDER',
      ...(fields.get(`${prefix}PartyId`)?.toString() ? { sourcePartyId: fields.get(`${prefix}PartyId`)?.toString() } : {}),
      ...(fields.get(`${prefix}Method`)?.toString() ? { methodCode: fields.get(`${prefix}Method`)?.toString() } : {}),
      ...(fields.get(`${prefix}Evidence`)?.toString() ? { evidenceRef: fields.get(`${prefix}Evidence`)?.toString() } : {}),
      occurredAt: nowIso(),
    };
  }

  const facilitySiteIds = (doraId: string) => doras.find((dora) => dora.id === doraId)?.site_ids ?? [];
  const selectedDora = doras.find((dora) => dora.id === selectedDoraId);

  return <>
    <WorkspaceHeading eyebrow="DORA · RESIDUE · RECOVERY" title="Material operations" description="Follow recorded material through processing, residue custody, consignments and recovery. Quantities and source records remain attributed to the server ledger." action={<button className="secondary" onClick={() => void refreshAll()} disabled={busy || !online}>{busy ? 'Refreshing…' : 'Refresh records'}</button>} />
    {error && <div className="notice error" role="alert">{error}</div>}
    {message && <div className="notice success" role="status">{message}</div>}
    {!online && <div className="notice warning">These operations require a connection. This workspace does not queue them offline; existing supported commands remain available from Field capture.</div>}
    <nav className="workspace-tabs" aria-label="Material operations" role="tablist">
      {panes.map((item) => <button key={item.id} role="tab" aria-selected={pane === item.id} onClick={() => setPane(item.id)}>{item.label}</button>)}
    </nav>

    {pane === 'processing' && <>
      <section className="queue-section">
        <div className="section-heading"><div><p className="eyebrow">AUTHORIZED FACILITIES</p><h2>Dora register</h2></div></div>
        <div className="form-grid">
          <label>Selected Dora<select aria-label="Selected Dora" value={selectedDoraId} onChange={(event) => setSelectedDoraId(event.target.value)}><option value="">Choose an accessible Dora</option>{doras.map((row) => <option key={row.id} value={row.id}>{row.name} · {row.status}</option>)}</select></label>
          {selectedDora && <div className="field-value"><span className="label">Facility ID</span><code>{selectedDora.id}</code><small>Sites: {(selectedDora.site_ids ?? []).map((id) => sites.find((site) => site.id === id)?.name ?? id).join(', ') || 'No linked site references'}</small></div>}
        </div>
        {doras.length === 0 && <div className="empty-state">No Dora facilities are currently available to the active server-authorized role.</div>}
        {canWriteDora && !isAuditor && <form className="form-stack" onSubmit={(event) => void onForm(event, async () => {
          const data = new FormData(event.currentTarget); await mutate(`/api/v1/doras/${selectedDoraId}`, { name: data.get('name')?.toString(), status: data.get('status')?.toString() }, 'PATCH');
        })}>
          <h3>Update this Dora</h3><div className={classes}><label>Name<input name="name" defaultValue={selectedDora?.name} required maxLength={160} /></label><label>Status<select name="status" defaultValue={selectedDora?.status}><option>ACTIVE</option><option>INACTIVE</option></select></label></div><button className="secondary" disabled={busy || !online}>Save facility details</button>
        </form>}
        {sites.length > 0 && ['FIELD_OFFICER', 'MINING_OPERATOR'].includes(activeRole?.roleCode ?? '') && !isAuditor && <form className="form-stack" onSubmit={(event) => void onForm(event, async () => {
          const data = new FormData(event.currentTarget); const siteId = String(data.get('siteId')); await mutate(`/api/v1/sites/${siteId}/doras`, { name: data.get('name')?.toString() });
        })}>
          <h3>Register Dora at an authorized site</h3><div className={classes}><label>Site<select name="siteId" required>{sites.map((site) => <option key={site.id} value={site.id}>{site.name} · {site.siteCode}</option>)}</select></label><label>Dora name<input name="name" required maxLength={160} /></label></div><button className="primary" disabled={busy || !online}>Register Dora</button>
        </form>}
      </section>
      <section className="queue-section">
        <div className="section-heading"><div><p className="eyebrow">SOURCE-LINKED EVENTS</p><h2>Processing event register</h2></div></div>
        {processingEvents.length === 0 ? <div className="empty-state">No processing events are currently readable under this role. Event details require both facility access and access to every source production hole.</div> : <div className="table-wrap"><table className="data-table"><thead><tr><th>Event</th><th>Dora</th><th>Recorded</th><th>Sources</th><th>Inputs / outputs</th><th>Status</th></tr></thead><tbody>{processingEvents.map((row) => <tr key={row.id} onClick={() => setSelectedEventId(row.id)} tabIndex={0} role="button"><td><strong>{row.event_code}</strong><small>{row.id}</small></td><td>{row.processing_facility_name}</td><td>{dateValue(row.occurred_at_claimed)}</td><td>{row.sourceHoleIds?.length ?? '—'} holes</td><td>{row.input_count} / {row.output_count}</td><td>{row.current_status}</td></tr>)}</tbody></table></div>}
        {processingDetail && <article className="overview-card"><h3>{processingDetail.event_code} · {processingDetail.processing_facility_name}</h3><p>Occurred {dateValue(processingDetail.occurred_at_claimed)} · recorded {dateValue(processingDetail.recorded_at)} · {processingDetail.current_status}</p><h4>Inputs and source production</h4><ul>{processingDetail.inputs.map((input) => <li key={input.id}>{input.batch_code} ({input.material_kind}) · source event {input.source_event_id} · source output {input.source_production_output_id}{input.measurements.map((measurement) => <small key={measurement.id}>{measurementKind(measurement.measurement_kind)} {quantity(measurement.quantity_g)}; {measurement.source_role}; {measurement.method_code ?? 'method not recorded'}; evidence {textValue(measurement.evidence_ref)}</small>)}</li>)}</ul><h4>Recorded outputs</h4><ul>{processingDetail.outputs.map((output) => <li key={output.id}>{output.material_kind} · {output.output_role} · batch {output.batch_code} · output {output.id}{output.measurements.map((measurement) => <small key={measurement.id}>{measurementKind(measurement.measurement_kind)} {quantity(measurement.quantity_g)}; source {measurement.source_value} {measurement.source_unit_code}; {measurement.source_role}; {measurement.method_code ?? 'method not recorded'}; evidence {textValue(measurement.evidence_ref)}</small>)}</li>)}</ul><p className="muted">Declared, measured and verified observations are shown as recorded. No output type or value is inferred.</p></article>}
      </section>
      {canWriteDora && !isAuditor && <section className="queue-section">
        <div className="section-heading"><div><p className="eyebrow">NEW PROCESSING EVENT</p><h2>Record actual source material and outputs</h2></div><span className="local-badge">Online only</span></div>
        <form className="form-stack" onSubmit={(event) => void onForm(event, () => recordProcessing(event))}>
          <div className={classes}><label>Authorized source site<select name="siteId" required onChange={(event) => { void loadProductionSources(event.target.value).catch((loadError) => setError(loadError instanceof Error ? loadError.message : 'Production events could not be loaded.')); }}><option value="">Choose a source site</option>{facilitySiteIds(selectedDoraId).map((siteId) => { const site = sites.find((row) => row.id === siteId); return <option key={siteId} value={siteId}>{site?.name ?? `Site ${siteId.slice(0, 8)}`} {site?.siteCode ? `· ${site.siteCode}` : ''}</option>; })}</select></label><label>Production event<select value={sourceEventId} onChange={(event) => { setSourceEventId(event.target.value); setSourceOutputId(sourceEvents.find((row) => row.id === event.target.value)?.outputs[0]?.id ?? ''); }}><option value="">Choose an event</option>{sourceEvents.map((row) => <option key={row.id} value={row.id}>{row.event_code} · hole {row.hole_id}</option>)}</select></label><label>Source production output<select value={sourceOutputId} onChange={(event) => setSourceOutputId(event.target.value)}><option value="">Choose an output</option>{selectedSourceEvent?.outputs.map((output) => <option key={output.id} value={output.id}>{output.batch_code} · {output.material_kind}</option>)}</select></label></div>
          {!selectedSourceOutput && <p className="muted">Select a site and event with at least one accessible output. The server revalidates all source relationships.</p>}
          <h3>Input measurement</h3><div className={classes}><label>Quantity (g)<input name="inputQuantity" inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,6})?" required /></label><label>Kind<select name="inputKind" defaultValue="MEASURED"><option>DECLARED</option><option>MEASURED</option><option>VERIFIED</option></select></label><label>Source value<input name="inputSourceValue" inputMode="decimal" /></label><label>Unit<input name="inputUnit" defaultValue="g" required /></label><label>Recorded by role<select name="inputRole" defaultValue="RECORDER"><option>RECORDER</option><option>WEIGHER</option><option>WITNESS</option><option>SELLER</option><option>BUYER</option><option>OTHER</option></select></label><label>Source party ID (required for non-recorder roles)<input name="inputPartyId" /></label><label>Method<input name="inputMethod" /></label><label>Evidence reference<input name="inputEvidence" /></label></div>
          <label>Compensation arrangement code (optional)<input name="arrangement" /></label><label>Source reference for arrangement (both are required together)<input name="terms" /></label>
          <h3>Outputs</h3>{newOutputRows.map((row, index) => <div className="overview-card" key={index}><div className={classes}><label>Material kind<select value={row.materialKind} onChange={(event) => setNewOutputRows((current) => current.map((item, i) => i === index ? { ...item, materialKind: event.target.value } : item))}><option>GOLD_BEARING_FEED</option><option>RESIDUE</option><option>GOLD_DORE</option><option>RECOVERED_GOLD</option><option>PROCESS_OUTPUT</option></select></label><label>Output role<select value={row.outputRole} onChange={(event) => setNewOutputRows((current) => current.map((item, i) => i === index ? { ...item, outputRole: event.target.value } : item))}><option>MINER_RETAINED_GOLD</option><option>DORA_RETAINED_RESIDUE</option><option>OTHER_OUTPUT</option></select></label><label>Quantity (g)<input required inputMode="decimal" value={row.quantityGrams} onChange={(event) => setNewOutputRows((current) => current.map((item, i) => i === index ? { ...item, quantityGrams: event.target.value } : item))} /></label><label>Source value<input value={row.sourceValue} onChange={(event) => setNewOutputRows((current) => current.map((item, i) => i === index ? { ...item, sourceValue: event.target.value } : item))} /></label><label>Recorded by role<select value={row.sourceRole} onChange={(event) => setNewOutputRows((current) => current.map((item, i) => i === index ? { ...item, sourceRole: event.target.value } : item))}><option>RECORDER</option><option>WEIGHER</option><option>WITNESS</option><option>OTHER</option></select></label><label>Source party ID<input value={row.sourcePartyId} onChange={(event) => setNewOutputRows((current) => current.map((item, i) => i === index ? { ...item, sourcePartyId: event.target.value } : item))} /></label><label>Measurement method<input value={row.methodCode} onChange={(event) => setNewOutputRows((current) => current.map((item, i) => i === index ? { ...item, methodCode: event.target.value } : item))} /></label><label>Evidence reference<input value={row.evidenceRef} onChange={(event) => setNewOutputRows((current) => current.map((item, i) => i === index ? { ...item, evidenceRef: event.target.value } : item))} /></label></div>{newOutputRows.length > 1 && <button type="button" className="text-button" onClick={() => setNewOutputRows((current) => current.filter((_, i) => i !== index))}>Remove output row</button>}</div>)}<button type="button" className="secondary" onClick={() => setNewOutputRows((current) => [...current, { materialKind: 'PROCESS_OUTPUT', outputRole: 'OTHER_OUTPUT', quantityGrams: '', sourceValue: '', sourceUnit: 'g', sourceRole: 'RECORDER', sourcePartyId: '', methodCode: '', evidenceRef: '' }])}>Add output row</button>
          <button className="primary" disabled={busy || !online || !sourceOutputId}>Record processing event</button>
        </form>
      </section>}
    </>}

    {pane === 'residue' && <>
      <section className="queue-section"><div className="section-heading"><div><p className="eyebrow">DORA RETAINED MATERIAL</p><h2>Stockpile register and genealogy</h2></div></div>
        <label>Authorized Dora<select aria-label="Residue Dora" value={selectedDoraId} onChange={(event) => setSelectedDoraId(event.target.value)}><option value="">Choose Dora</option>{doras.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
        {stockpileChoices.length === 0 ? <div className="empty-state">No stockpiles have been recorded at this Dora.</div> : <label>Stockpile<select value={selectedStockpileId} onChange={(event) => setSelectedStockpileId(event.target.value)}>{stockpileChoices.map((row) => <option value={row.id} key={row.id}>{row.label}</option>)}</select></label>}
        {selectedStockpileId && <><h3>Current balances</h3>{balances.length === 0 ? <p className="muted">No accepted inventory balance is recorded.</p> : <ul>{balances.map((row) => <li key={row.batch_id}>{row.batch_code} · {row.material_kind} · {quantity(row.quantity_g)}</li>)}</ul>}<h3>Movement and source history</h3>{movements.length === 0 ? <p className="muted">No accepted movement history.</p> : <div className="table-wrap"><table className="data-table"><thead><tr><th>Time / movement</th><th>Material</th><th>Direction</th><th>Quantity</th><th>Source</th><th>Measurement</th></tr></thead><tbody>{movements.map((movement) => <tr key={movement.movement_line_id}><td>{dateValue(movement.occurred_at_claimed)}<small>{movement.movement_kind} · {movement.current_status}</small></td><td>{movement.batch_code} · {movement.material_kind}</td><td>{movement.direction}</td><td>{quantity(movement.posted_quantity_g)}</td><td>{movement.source_material_event_output_id ?? movement.consignment_receipt_item_id ?? 'Inventory adjustment or transfer'}</td><td>{measurementKind(movement.measurement_kind)} · {movement.source_value ?? '—'} {movement.source_unit_code ?? ''} · {movement.source_role ?? '—'} · {movement.method_code ?? '—'} · {movement.evidence_ref ?? 'no evidence ref'}</td></tr>)}</tbody></table></div>}</>}
        {stockpileChoices.length > 0 && <div className="overview-card"><h3>Recorded source outputs held here</h3>{stockpiles.filter((row) => row.id === selectedStockpileId && row.batch_id).length === 0 ? <p>No material has been received to this stockpile.</p> : <ul>{stockpiles.filter((row) => row.id === selectedStockpileId && row.batch_id).map((row) => <li key={`${row.id}:${row.batch_id}`}>{row.batch_code} · {row.material_kind} · {quantity(row.quantity_g)} · processing event {row.origin_processing_event_id} · output {row.origin_output_id}</li>)}</ul>}<p>Separate batch sources remain separate rows during pooling and transfer.</p></div>}
      </section>
      {canWriteDora && !isAuditor && <>
        <section className="queue-section"><h2>Create stockpile location</h2><form className="form-stack" onSubmit={(event) => void onForm(event, async () => { const data = new FormData(event.currentTarget); await mutate(`/api/v1/doras/${selectedDoraId}/stockpiles`, { stockpileCode: data.get('stockpileCode')?.toString(), locationCode: data.get('locationCode')?.toString(), physicalPlaceRef: data.get('place')?.toString() || undefined }); })}><div className={classes}><label>Stockpile code<input name="stockpileCode" required /></label><label>Inventory location code<input name="locationCode" required /></label><label>Physical location reference<input name="place" /></label></div><button className="primary" disabled={busy || !online}>Create stockpile</button></form></section>
        <section className="queue-section"><h2>Receive measured Dora residue</h2><form className="form-stack" onSubmit={(event) => void onForm(event, async () => { const data = new FormData(event.currentTarget); const output = eligibleOutputs.find((row) => row.output_id === data.get('outputId')); const target = stockpileChoices.find((row) => row.id === data.get('stockpileId')); if (!output || !target) throw new Error('Choose an eligible measured residue output and a destination stockpile.'); await mutate(`/api/v1/stockpiles/${target.id}/intake`, { occurredAt: nowIso(), evidenceRef: data.get('evidence')?.toString() || undefined, outputs: [{ outputId: output.output_id, measurementId: output.measurement_id }] }); })}><div className={classes}><label>Source output<select name="outputId" required><option value="">Choose measured Dora retained residue</option>{eligibleOutputs.map((row) => <option value={row.output_id} key={row.output_id}>{row.event_code} · {row.batch_code} · {quantity(row.quantity_g)} · {row.measurement_kind}</option>)}</select></label><label>Destination stockpile<select name="stockpileId" required>{stockpileChoices.map((row) => <option key={row.id} value={row.id}>{row.label}</option>)}</select></label><label>Evidence reference<input name="evidence" /></label></div><button className="primary" disabled={busy || !online || !eligibleOutputs.length || !stockpileChoices.length}>Receive residue</button></form><p className="muted">The API accepts only measured or verified Dora-retained residue and prevents a second intake of an already received output.</p></section>
        <section className="queue-section"><h2>Transfer or aggregate stockpile material</h2><form className="form-stack" onSubmit={(event) => void onForm(event, async () => { const data = new FormData(event.currentTarget); const item = balances.find((row) => row.batch_id === data.get('batchId')); const destination = stockpileChoices.find((row) => row.id === data.get('destination')); if (!item || !destination || !selectedStockpileId) throw new Error('Choose a current batch, source and destination stockpile.'); await mutate(`/api/v1/stockpiles/${selectedStockpileId}/transfers`, { destinationStockpileId: destination.id, occurredAt: nowIso(), evidenceRef: String(data.get('evidence') ?? '').trim(), items: [{ batchId: item.batch_id, quantityGrams: String(data.get('quantity') ?? ''), measurement: { kind: 'MEASURED', sourceValue: String(data.get('quantity') ?? ''), sourceUnit: 'g', conversionVersion: 'manual-v1', sourceRole: 'WEIGHER', ...(String(data.get('evidence') ?? '').trim() ? { evidenceRef: String(data.get('evidence')) } : {}) } }] }); })}><div className={classes}><label>Source stockpile<select value={selectedStockpileId} onChange={(event) => setSelectedStockpileId(event.target.value)}>{stockpileChoices.map((row) => <option key={row.id} value={row.id}>{row.label}</option>)}</select></label><label>Batch<select name="batchId" required>{balances.map((row) => <option key={row.batch_id} value={row.batch_id}>{row.batch_code} · {quantity(row.quantity_g)}</option>)}</select></label><label>Quantity to move (g)<input name="quantity" inputMode="decimal" required pattern="[0-9]+(\.[0-9]{1,6})?" /></label><label>Destination stockpile<select name="destination" required>{stockpileChoices.filter((row) => row.id !== selectedStockpileId).map((row) => <option key={row.id} value={row.id}>{row.label}</option>)}</select></label><label>Movement evidence reference<input name="evidence" required /></label></div><button className="primary" disabled={busy || !online || !balances.length || stockpileChoices.length < 2}>Transfer material</button></form><p className="muted">Pooling preserves each batch's own origin and creates an append-only inventory movement. No last-write-wins balance is used.</p></section>
      </>}
    </>}

    {pane === 'sales' && <>
      <section className="queue-section"><div className="section-heading"><div><p className="eyebrow">COMMERCIAL AGREEMENT</p><h2>Residue sales</h2></div></div>
        {sales.length === 0 ? <div className="empty-state">No residue sale records are visible to this role.</div> : <div className="table-wrap"><table className="data-table"><thead><tr><th>Sale</th><th>Agreed</th><th>Currency</th><th>Parties</th><th>Terms reference</th></tr></thead><tbody>{sales.map((row) => <tr key={row.id} onClick={() => setSelectedSaleId(row.id)} tabIndex={0} role="button"><td>{row.sale_code}<small>{row.id}</small></td><td>{dateValue(row.agreed_at)}</td><td>{row.currency_code}</td><td><small>Seller {row.seller_party_id}</small><small>Buyer {row.buyer_party_id}</small></td><td>{textValue(row.terms_ref)}</td></tr>)}</tbody></table></div>}
        {saleDetail && <article className="overview-card"><h3>{saleDetail.sale_code} · {saleDetail.currency_code}</h3><p>Agreement recorded {dateValue(saleDetail.agreed_at)} · terms {textValue(saleDetail.terms_ref)}</p><div className="table-wrap"><table className="data-table"><thead><tr><th>Residue batch</th><th>Revision</th><th>Proposed quantity</th><th>Accepted quantity</th><th>Decision history</th></tr></thead><tbody>{saleDetail.lines.map((line) => <tr key={line.id}><td>{line.batch_code}<small>{line.batch_id}</small></td><td>{line.revision_no} · {line.is_accepted ? 'accepted line' : 'proposal'}</td><td>{quantity(line.transaction_quantity_g)}</td><td>{line.accepted_trade_quantity_g ? quantity(line.accepted_trade_quantity_g) : 'Not accepted'}</td><td>{saleDetail.decisions.filter((decision) => decision.residue_sale_line_id === line.id).map((decision) => `${decision.decision} by ${decision.actor_party_id}`).join('; ') || 'No counterparty decision'}</td></tr>)}</tbody></table></div><p className="notice warning">Payment is not supported for residue sales. An agreed sale, dispatched consignment, custody transfer and receipt do not prove payment.</p></article>}
      </section>
      {canWriteDora && !isAuditor && <section className="queue-section"><h2>Propose residue sale</h2><form className="form-stack" onSubmit={(event) => void onForm(event, async () => { const data = new FormData(event.currentTarget); const batch = balances.find((row) => row.batch_id === data.get('batchId')); const recoveryFacilityId = String(data.get('recoveryFacilityId') ?? ''); if (!batch || !selectedDoraId || !recoveryFacilityId) throw new Error('Choose a Dora residue batch and receiving facility.'); await mutate('/api/v1/residue-sales', { processingFacilityId: selectedDoraId, recoveryFacilityId, agreedAt: nowIso(), currencyCode: String(data.get('currencyCode') ?? 'KES'), termsRef: String(data.get('termsRef') ?? '') || undefined, lines: [{ batchId: batch.batch_id, quantityGrams: String(data.get('quantity') ?? ''), ...(data.get('unitPrice') ? { unitPrice: String(data.get('unitPrice')) } : {}) }] }); })}><div className={classes}><label>Residue batch<select name="batchId" required>{balances.filter((row) => row.material_kind === 'RESIDUE').map((row) => <option key={row.batch_id} value={row.batch_id}>{row.batch_code} · {quantity(row.quantity_g)}</option>)}</select></label><label>Proposed quantity (g)<input name="quantity" inputMode="decimal" required /></label><label>Receiving recovery facility<select name="recoveryFacilityId" required>{recoveryDestinations.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label><label>Currency code<input name="currencyCode" defaultValue="KES" pattern="[A-Z]{3}" required /></label><label>Unit price (optional)<input name="unitPrice" inputMode="decimal" /></label><label>Terms reference<input name="termsRef" /></label></div><button className="primary" disabled={busy || !online || !balances.some((row) => row.material_kind === 'RESIDUE') || !recoveryDestinations.length}>Record sale proposal</button></form><p className="muted">A proposal becomes accepted only through the existing counterparty decision workflow. Payment has no API.</p></section>}
      {saleDetail && saleDetail.lines.filter((line) => !line.is_accepted).map((line) => {
        const sellerDecision = saleDetail.decisions.find((decision) => decision.residue_sale_line_id === line.id && decision.actor_party_id === saleDetail.seller_party_id && decision.decision === 'ACCEPT');
        const buyerDecision = saleDetail.decisions.find((decision) => decision.residue_sale_line_id === line.id && decision.actor_party_id === saleDetail.buyer_party_id && decision.decision === 'ACCEPT');
        const decisionPartyId = activeRole?.roleCode === 'DORA_OPERATOR' ? saleDetail.seller_party_id : activeRole?.roleCode === 'RECOVERY_FACILITY_OPERATOR' ? saleDetail.buyer_party_id : '';
        const hasDecision = saleDetail.decisions.some((decision) => decision.residue_sale_line_id === line.id && decision.actor_party_id === decisionPartyId);
        const canDecideSale = (canWriteDora && saleDetail.lines.some((saleLine) => saleLine.processing_facility_id === selectedDoraId)) || (activeRole?.roleCode === 'RECOVERY_FACILITY_OPERATOR' && recoveryFacilities.some((facility) => facility.id === activeRole.scopeId && facility.party_id === saleDetail.buyer_party_id));
        const quantityMismatch = Boolean(sellerDecision && buyerDecision && sellerDecision.accepted_quantity_g !== buyerDecision.accepted_quantity_g);
        return <section className="queue-section" key={line.id}><h3>Decision for {saleDetail.sale_code} line {line.revision_no}</h3><p>Counterparty decisions remain separate and immutable.</p><form className="form-stack" onSubmit={(event) => void onForm(event, async () => { const data = new FormData(event.currentTarget); const decision = String(data.get('decision')); await mutate(`/api/v1/residue-sales/${saleDetail.id}/lines/${line.id}/decisions`, { decision, ...(decision === 'ACCEPT' ? { acceptedQuantityGrams: String(data.get('acceptedQuantityGrams')) } : { reason: String(data.get('reason')) }), occurredAt: nowIso() }); await loadSale(saleDetail.id); })}><div className={classes}><label>Decision<select name="decision"><option>ACCEPT</option><option>DISPUTE</option><option>REJECT</option></select></label><label>Accepted quantity (g), required for acceptance<input name="acceptedQuantityGrams" /></label><label>Reason, required for dispute/rejection<input name="reason" /></label></div><button className="secondary" disabled={busy || !online || isAuditor || !canDecideSale || hasDecision}>Record counterparty decision</button></form>
          {quantityMismatch && canDecideSale && <form className="form-stack" onSubmit={(event) => void onForm(event, async () => { const data = new FormData(event.currentTarget); await mutate(`/api/v1/residue-sales/${saleDetail.id}/lines/${line.id}/revisions`, { quantityGrams: String(data.get('quantity')), correctionReason: String(data.get('correctionReason')), occurredAt: nowIso() }); await loadSale(saleDetail.id); })}><h4>Propose a linked revision after the quantity mismatch</h4><div className={classes}><label>Revised proposal quantity (g)<input name="quantity" defaultValue={line.transaction_quantity_g} required /></label><label>Correction reason<input name="correctionReason" required /></label></div><button className="secondary" disabled={busy || !online || isAuditor}>Propose successor line</button></form>}
        </section>;
      })}
    </>}

    {pane === 'consignments' && <>
      <section className="queue-section"><div className="section-heading"><div><p className="eyebrow">MOVEMENT IS DISTINCT FROM SALE AND PAYMENT</p><h2>Consignment register</h2></div></div>
        {consignments.length === 0 ? <div className="empty-state">No consignments are visible to this role.</div> : <div className="table-wrap"><table className="data-table"><thead><tr><th>Consignment</th><th>Status</th><th>Destination</th><th>Created / dispatched / received</th></tr></thead><tbody>{consignments.map((row) => <tr key={row.id} onClick={() => setSelectedConsignmentId(row.id)} tabIndex={0} role="button"><td>{row.consignment_code}<small>{row.id}</small></td><td>{row.status}</td><td>{recoveryFacilities.find((facility) => facility.id === row.destination_recovery_facility_id)?.name ?? row.destination_recovery_facility_id}</td><td>{dateValue(row.created_at)}<small>Dispatch {dateValue(row.dispatched_at)} · receipt {dateValue(row.received_at)}</small></td></tr>)}</tbody></table></div>}
        {consignmentDetail && <article className="overview-card"><h3>{consignmentDetail.consignment_code} · {consignmentDetail.status}</h3><p>Transit location {consignmentDetail.transit_location_id} · destination facility {consignmentDetail.destination_recovery_facility_id}</p><h4>Items and movement states</h4><ul>{consignmentDetail.items.map((item) => <li key={item.id}>{item.batch_code} ({item.batch_id}) · source stockpile {item.source_location_id} · dispatched {quantity(item.dispatched_quantity_g)} · accepted {quantity(item.accepted_receipt_quantity_g)} · disputed {quantity(item.disputed_receipt_quantity_g)} · rejected {quantity(item.rejected_receipt_quantity_g)}</li>)}</ul><h4>Transport legs</h4>{consignmentDetail.transportLegs.length ? <ul>{consignmentDetail.transportLegs.map((leg, index) => <li key={String(leg.id ?? index)}>Vehicle {textValue(leg.vehicle_ref)} · carrier {textValue(leg.carrier_party_id)} · departed {dateValue(leg.departure_at as string | null)} · arrived {dateValue(leg.arrival_at as string | null)} · evidence {textValue(leg.evidence_ref)}</li>)}</ul> : <p>No transport leg recorded.</p>}<h4>Receipts and corrections</h4>{consignmentDetail.receiptItems.length ? <ul>{consignmentDetail.receiptItems.map((item) => <li key={item.id}>{item.outcome} · {quantity(item.quantity_g)} · reason {textValue(item.reason)} · evidence {textValue(item.evidence_ref)}{item.supersedes_receipt_item_id ? ` · corrects ${item.supersedes_receipt_item_id}` : ''}</li>)}</ul> : <p>No receipt recorded. Dispatch is not receipt.</p>}<h4>Custody handovers</h4>{consignmentDetail.custodyTransfers.length ? <ul>{consignmentDetail.custodyTransfers.map((transfer) => <li key={transfer.id}>{transfer.status} · offered {dateValue(transfer.offered_at)} · destination location {transfer.destination_location_id}{transfer.decisions.map((decision) => <small key={decision.id}>{decision.decision} · {dateValue(decision.occurredAt)} · {textValue(decision.reason)}</small>)}</li>)}</ul> : <p>No custody transfer recorded.</p>}<p className="muted">The consignment can record a commercial sale mapping, but dispatch, transport, custody, receipt and payment remain separate records.</p></article>}
      </section>
      {canWriteDora && !isAuditor && <section className="queue-section"><h2>Create residue consignment</h2><form className="form-stack" onSubmit={(event) => void onForm(event, async () => { const data = new FormData(event.currentTarget); const batch = balances.find((row) => row.batch_id === data.get('batchId')); if (!batch || !selectedStockpileId) throw new Error('Choose residue from an authorized Dora stockpile.'); await mutate('/api/v1/consignments', { recoveryFacilityId: String(data.get('recoveryFacilityId')), occurredAt: nowIso(), ...(data.get('transporter') ? { transporterPartyId: String(data.get('transporter')) } : {}), items: [{ sourceStockpileId: selectedStockpileId, batchId: batch.batch_id, quantityGrams: String(data.get('quantity')), measurement: { kind: 'MEASURED', sourceValue: String(data.get('quantity')), sourceUnit: 'g', conversionVersion: 'manual-v1', sourceRole: 'WEIGHER' } }] }); })}><div className={classes}><label>Source Dora stockpile<select name="stockpileId" value={selectedStockpileId} onChange={(event) => setSelectedStockpileId(event.target.value)}>{stockpileChoices.map((row) => <option value={row.id} key={row.id}>{row.label}</option>)}</select></label><label>Residue batch<select name="batchId" required>{balances.filter((row) => row.material_kind === 'RESIDUE').map((row) => <option value={row.batch_id} key={row.batch_id}>{row.batch_code} · {quantity(row.quantity_g)}</option>)}</select></label><label>Manifest quantity (g)<input name="quantity" required inputMode="decimal" /></label><label>Destination recovery facility<select name="recoveryFacilityId" required>{recoveryFacilities.map((row) => <option value={row.id} key={row.id}>{row.name}</option>)}</select></label><label>Transporter party ID (optional)<input name="transporter" /></label></div><button className="primary" disabled={busy || !online || !recoveryDestinations.length || !balances.some((row) => row.material_kind === 'RESIDUE')}>Create consignment</button></form></section>}
      {consignmentDetail && <div className="workspace-grid">
        {canWriteDora && !isAuditor && consignmentDetail.status === 'DRAFT' && <section className="queue-section"><h3>Dispatch</h3><p>Dispatch uses the recorded manifest measurements; dispatch does not prove delivery or receipt.</p><button className="primary" disabled={busy || !online || !consignmentDetail.items.every((item) => item.dispatch_measurement_id)} onClick={() => void onForm({ preventDefault() {} } as FormEvent<HTMLFormElement>, async () => { await mutate(`/api/v1/consignments/${consignmentDetail.id}/dispatch`, { occurredAt: nowIso(), items: consignmentDetail.items.map((item) => ({ consignmentItemId: item.id, measurementId: item.dispatch_measurement_id })) }); })}>Record dispatch</button></section>}
        {(canWriteDora || canWriteRecovery) && !isAuditor && consignmentDetail.status !== 'DRAFT' && <section className="queue-section"><h3>Record transport leg</h3><form className="form-stack" onSubmit={(event) => void onForm(event, async () => { const data = new FormData(event.currentTarget); const body = { ...(data.get('vehicle') ? { vehicleRef: String(data.get('vehicle')) } : {}), ...(data.get('carrier') ? { carrierPartyId: String(data.get('carrier')) } : {}), ...(data.get('departure') ? { departureAt: new Date(String(data.get('departure'))).toISOString() } : {}), ...(data.get('arrival') ? { arrivalAt: new Date(String(data.get('arrival'))).toISOString() } : {}), ...(data.get('evidence') ? { evidenceRef: String(data.get('evidence')) } : {}) }; await mutate(`/api/v1/consignments/${consignmentDetail.id}/transport-legs`, body); })}><div className={classes}><label>Vehicle reference<input name="vehicle" /></label><label>Carrier party ID<input name="carrier" /></label><label>Departure time<input type="datetime-local" name="departure" /></label><label>Arrival time<input type="datetime-local" name="arrival" /></label><label>Evidence reference<input name="evidence" /></label></div><button className="secondary" disabled={busy || !online}>Add transport leg</button></form></section>}
        {canWriteDora && !isAuditor && consignmentDetail.status !== 'DRAFT' && <section className="queue-section"><h3>Offer custody</h3><form className="form-stack" onSubmit={(event) => void onForm(event, async () => { const data = new FormData(event.currentTarget); await mutate(`/api/v1/consignments/${consignmentDetail.id}/custody-offers`, { destinationLocationId: String(data.get('locationId')), occurredAt: nowIso(), evidenceRef: String(data.get('evidence')) || undefined }); })}><label>Destination recovery inventory location<select name="locationId" required>{recoveryDestinations.find((facility) => facility.id === consignmentDetail.destination_recovery_facility_id)?.locations.map((location) => <option key={location.id} value={location.id}>{location.locationCode} · {location.id}</option>)}</select></label><label>Offer evidence reference<input name="evidence" /></label><button className="secondary" disabled={busy || !online || !recoveryDestinations.find((facility) => facility.id === consignmentDetail.destination_recovery_facility_id)?.locations.length}>Offer custody</button></form></section>}
        {canWriteRecovery && !isAuditor && ['DISPATCHED', 'PART_RECEIVED', 'DISPUTED'].includes(consignmentDetail.status) && selectedRecovery?.id === consignmentDetail.destination_recovery_facility_id && <section className="queue-section"><h3>Record receipt</h3><form className="form-stack" onSubmit={(event) => void onForm(event, async () => { const data = new FormData(event.currentTarget); const items = consignmentDetail.items.map((item) => { const outcome = String(data.get(`outcome:${item.id}`)); return { consignmentItemId: item.id, quantityGrams: String(data.get(`receiptQuantity:${item.id}`)), outcome, ...(outcome !== 'ACCEPTED' ? { reason: String(data.get(`reason:${item.id}`)) } : {}), ...(data.get(`receiptEvidence:${item.id}`) ? { evidenceRef: String(data.get(`receiptEvidence:${item.id}`)) } : {}) }; }); await mutate(`/api/v1/consignments/${consignmentDetail.id}/receipts`, { recoveryInventoryLocationId: String(data.get('locationId')), occurredAt: nowIso(), items }); })}><label>Destination recovery location<select name="locationId" required>{selectedRecovery.locations?.map((location) => <option key={location.id} value={location.id}>{location.location_code}</option>)}</select></label>{consignmentDetail.items.map((item) => <div className="overview-card" key={item.id}><h4>{item.batch_code}</h4><div className={classes}><label>Quantity received (g)<input name={`receiptQuantity:${item.id}`} defaultValue={item.dispatched_quantity_g} required /></label><label>Outcome<select name={`outcome:${item.id}`}><option>ACCEPTED</option><option>DISPUTED</option><option>REJECTED</option></select></label><label>Reason for dispute/rejection<input name={`reason:${item.id}`} /></label><label>Evidence reference<input name={`receiptEvidence:${item.id}`} /></label></div></div>)}<button className="primary" disabled={busy || !online || !selectedRecovery?.locations?.length}>Record receipt</button></form></section>}
        {canWriteRecovery && !isAuditor && consignmentDetail.receiptItems.filter((item) => !consignmentDetail.receiptItems.some((next) => next.supersedes_receipt_item_id === item.id)).map((item) => <section className="queue-section" key={item.id}><h3>Correct receipt item</h3><p>{item.outcome} · {quantity(item.quantity_g)} · original record remains in history</p><form className="form-stack" onSubmit={(event) => void onForm(event, async () => { const data = new FormData(event.currentTarget); const outcome = String(data.get('outcome')); await mutate(`/api/v1/consignments/${consignmentDetail.id}/receipt-items/${item.id}/corrections`, { recoveryInventoryLocationId: String(data.get('locationId')), quantityGrams: String(data.get('quantity')), outcome, correctionReason: String(data.get('correctionReason')), ...(outcome !== 'ACCEPTED' ? { reason: String(data.get('reason')) } : {}), occurredAt: nowIso() }); })}><div className={classes}><label>Recovery location<select name="locationId">{selectedRecovery?.locations?.map((location) => <option key={location.id} value={location.id}>{location.location_code}</option>)}</select></label><label>Correct quantity (g)<input name="quantity" defaultValue={item.quantity_g} required /></label><label>Outcome<select name="outcome"><option>ACCEPTED</option><option>DISPUTED</option><option>REJECTED</option></select></label><label>Correction reason<input name="correctionReason" required /></label><label>Dispute/rejection reason<input name="reason" /></label></div><button className="secondary" disabled={busy || !online}>Append receipt correction</button></form></section>)}
        {canWriteRecovery && !isAuditor && consignmentDetail.custodyTransfers.filter((transfer) => transfer.status === 'OFFERED' && consignmentDetail.destination_recovery_facility_id === selectedRecovery?.id).map((transfer) => <section className="queue-section" key={transfer.id}><h3>Decide custody offer</h3><p>Offered to location {transfer.destination_location_id}. Acceptance is a separate recorded event.</p><div className="button-row">{(['ACCEPT', 'DISPUTE', 'REJECT'] as const).map((decision) => <button key={decision} className={decision === 'ACCEPT' ? 'primary' : 'secondary'} disabled={busy || !online} onClick={() => void mutate(`/api/v1/custody-transfers/${transfer.id}/decisions`, { decision, occurredAt: nowIso(), ...(decision !== 'ACCEPT' ? { reason: window.prompt(`Reason for ${decision.toLowerCase()}?`) || 'Decision reason entered in workspace' } : {}) })}>{decision} custody</button>)}</div></section>)}
      </div>}
    </>}

    {pane === 'recovery' && <>
      <section className="queue-section"><div className="section-heading"><div><p className="eyebrow">AUTHORIZED RECEIVING FACILITIES</p><h2>Recovery facility register</h2></div></div>
        <label>Selected recovery facility<select aria-label="Selected recovery facility" value={selectedRecoveryId} onChange={(event) => setSelectedRecoveryId(event.target.value)}><option value="">Choose an accessible facility</option>{recoveryFacilities.map((row) => <option value={row.id} key={row.id}>{row.name} · {row.status}</option>)}</select></label>
        {recoveryFacilities.length === 0 && <div className="empty-state">No recovery facility is assigned or related to this account. Facility creation is not supported by the backend.</div>}
        {selectedRecovery && <><h3>Inventory locations</h3>{selectedRecovery.locations?.length ? selectedRecovery.locations.map((location) => <div className="overview-card" key={location.id}><strong>{location.location_code}</strong><small>{location.id} · {location.location_ref ?? location.physical_place_ref ?? 'No place reference'}</small><RecoveryBalances token={token} locationId={location.id} online={online} /></div>) : <div className="empty-state">No recovery inventory location exists at this facility.</div>}</>}
      </section>
      {canWriteRecovery && !isAuditor && selectedRecovery && <section className="queue-section"><h2>Create inventory location</h2><form className="form-stack" onSubmit={(event) => void onForm(event, async () => { const data = new FormData(event.currentTarget); await mutate(`/api/v1/recovery-facilities/${selectedRecoveryId}/inventory-locations`, { locationCode: String(data.get('locationCode')), physicalPlaceRef: String(data.get('place')) || undefined }); })}><div className={classes}><label>Location code<input name="locationCode" required /></label><label>Physical place reference<input name="place" /></label></div><button className="primary" disabled={busy || !online}>Create recovery location</button></form></section>}
      <section className="queue-section"><h2>Recovery event register</h2>{recoveryEvents.length === 0 ? <div className="empty-state">No recovery events recorded for this facility.</div> : <div className="table-wrap"><table className="data-table"><thead><tr><th>Event</th><th>Occurred</th><th>Method</th><th>Inputs / outputs</th></tr></thead><tbody>{recoveryEvents.map((row) => <tr key={row.id} onClick={() => setSelectedRecoveryEventId(row.id)} role="button" tabIndex={0}><td>{row.event_code}<small>{row.id}</small></td><td>{dateValue(row.occurred_at_claimed)}</td><td>{textValue(row.method_ref)}</td><td>{row.input_count} / {row.output_count}</td></tr>)}</tbody></table></div>}
        {recoveryDetail && <article className="overview-card"><h3>{recoveryDetail.event_code}</h3><p>Occurred {dateValue(recoveryDetail.occurred_at_claimed)} · method {textValue(recoveryDetail.method_ref)}</p><h4>Residue inputs and receipt provenance</h4><ul>{recoveryDetail.inputs.map((input) => <li key={input.id}>{input.batch_code} · {quantity(input.quantity_g)} · {measurementKind(input.measurement_kind)} · {input.source_role} · {input.method_code ?? 'method not recorded'} · evidence {textValue(input.evidence_ref)}<small>Contributing accepted receipt items: {input.sources.map((source) => `${source.consignment_code} (${source.consignment_id}) · item ${source.consignment_item_id} · receipt ${source.receipt_item_id} (${quantity(source.quantity_g)})`).join('; ')}</small></li>)}</ul><h4>Output batches and genealogy</h4><ul>{recoveryDetail.outputs.map((output) => <li key={output.id}>{output.material_kind} · {output.output_role} · {output.batch_code} · {quantity(output.quantity_g)} · input batches {output.contributing_batch_ids.join(', ')}<small>{measurementKind(output.measurement_kind)} · {output.source_value} {output.source_unit_code} · {output.source_role} · {output.method_code ?? 'method not recorded'} · evidence {textValue(output.evidence_ref)}</small></li>)}</ul>{recoveryDetail.stages.length > 0 && <><h4>Recorded stages</h4><ul>{recoveryDetail.stages.map((stage, index) => <li key={`${stage.stage_code}:${index}`}>{stage.stage_code} · {dateValue(stage.occurred_at_claimed)} · {textValue(stage.note)} · evidence {textValue(stage.evidence_ref)}</li>)}</ul></>}{recoveryDetail.variances.length > 0 && <><h4>Recorded variances</h4><ul>{recoveryDetail.variances.map((variance, index) => <li key={`${variance.variance_kind}:${index}`}>{variance.variance_kind} · {textValue(variance.expected_quantity_g)} expected · {textValue(variance.observed_quantity_g)} observed · {variance.reason} · evidence {textValue(variance.evidence_ref)}</li>)}</ul></>}</article>}
      </section>
      {canWriteRecovery && !isAuditor && <section className="queue-section"><h2>Record recovery event</h2><form className="form-stack" onSubmit={(event) => void onForm(event, async () => { const data = new FormData(event.currentTarget); const source = recoveryInputs.find((row) => row.receipt_item_id === data.get('receiptItemId')); if (!source || Number(data.get('inputQuantity')) > Number(source.available_quantity_g)) throw new Error('Choose an unconsumed accepted receipt and stay within its available quantity.'); const inputQuantity = String(data.get('inputQuantity')); const outputQuantity = String(data.get('outputQuantity')); const methodRef = String(data.get('methodRef') ?? ''); const evidence = String(data.get('evidence') ?? ''); await mutate(`/api/v1/recovery-facilities/${selectedRecoveryId}/recovery-events`, { recoveryInventoryLocationId: String(data.get('locationId')), occurredAt: nowIso(), ...(methodRef ? { methodRef } : {}), inputs: [{ batchId: source.batch_id, quantityGrams: inputQuantity, measurement: { kind: 'MEASURED', sourceValue: inputQuantity, sourceUnit: 'g', conversionVersion: 'manual-v1', sourceRole: 'WEIGHER', ...(evidence ? { evidenceRef: evidence } : {}) }, sources: [{ receiptItemId: source.receipt_item_id, quantityGrams: inputQuantity }] }], outputs: [{ materialKind: recoveryOutputKind, outputRole: recoveryOutputKind === 'RECOVERED_GOLD' ? 'RECOVERED_GOLD' : 'OTHER_OUTPUT', quantityGrams: outputQuantity, measurement: { kind: 'MEASURED', sourceValue: outputQuantity, sourceUnit: 'g', conversionVersion: 'manual-v1', sourceRole: 'WEIGHER', ...(evidence ? { evidenceRef: evidence } : {}) } }] }); })}><div className={classes}><label>Recovery inventory location<select name="locationId" required>{selectedRecovery?.locations?.map((location) => <option key={location.id} value={location.id}>{location.location_code}</option>)}</select></label><label>Accepted residue receipt<select name="receiptItemId" required>{recoveryInputs.map((row) => <option key={row.receipt_item_id} value={row.receipt_item_id}>{row.consignment_code} · {row.batch_code} · available {quantity(row.available_quantity_g)}</option>)}</select></label><label>Consumed quantity (g)<input name="inputQuantity" required inputMode="decimal" /></label><label>Output material kind<select value={recoveryOutputKind} onChange={(event) => setRecoveryOutputKind(event.target.value as 'RECOVERED_GOLD' | 'PROCESS_OUTPUT')}><option value="RECOVERED_GOLD">RECOVERED_GOLD</option><option value="PROCESS_OUTPUT">PROCESS_OUTPUT</option></select></label><label>Recorded output quantity (g)<input name="outputQuantity" required inputMode="decimal" /></label><label>Method reference<input name="methodRef" /></label><label>Measurement evidence reference<input name="evidence" /></label></div><button className="primary" disabled={busy || !online || !selectedRecovery?.locations?.length || !recoveryInputs.length}>Record recovery event</button></form><p className="muted">Inputs are limited to current accepted receipt quantities for this facility. The output quantity is recorded as supplied and is not inferred from the input.</p></section>}
    </>}
  </>;
}

function RecoveryBalances({ token, locationId, online }: { token: string; locationId: string; online: boolean }) {
  const [rows, setRows] = useState<Balance[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!online) return;
    let active = true;
    apiRequest<Balance[]>(`/api/v1/inventory/locations/${locationId}/balances`, token).then((result) => { if (active) setRows(result); }).catch((loadError) => { if (active) setError(loadError instanceof Error ? loadError.message : 'Balances could not be loaded.'); });
    return () => { active = false; };
  }, [locationId, online, token]);
  return <div><span className="label">Current inventory</span>{error ? <small>{error}</small> : rows.length ? rows.map((row) => <small key={row.batch_id}>{row.batch_code} · {row.material_kind} · {quantity(row.quantity_g)}</small>) : <small>No accepted balance</small>}</div>;
}
