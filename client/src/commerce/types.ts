import type { SiteReference } from '../api';

export type CommerceSection = 'measurements' | 'gold-trades' | 'payments';

export interface ActingRole {
  roleCode: string;
  scopeKind: string;
  scopeId: string;
}

export interface ProductionMeasurement {
  id: string;
  measurement_set_id: string;
  measurement_kind: 'DECLARED' | 'MEASURED' | 'VERIFIED';
  quantity_g: string;
  source_value: string;
  source_unit_code: string;
  conversion_version: string;
  source_role: string;
  source_party_id: string | null;
  entered_by_user_id?: string | null;
  occurred_at_claimed: string;
  entered_at?: string;
  method_code: string | null;
  instrument_ref: string | null;
  evidence_ref?: string | null;
  supersedes_measurement_id: string | null;
}

export interface ProductionOutput {
  id: string;
  batch_id: string;
  batch_code: string;
  material_kind: string;
  measurement_set_id: string;
  measurements: ProductionMeasurement[];
}

export interface ProductionEvent {
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
  outputs?: ProductionOutput[];
  participants?: Array<{ party_id: string; role_code: string; relationship_id: string; relationship_kind: string }>;
}

export type ProcessingMeasurement = ProductionMeasurement;

export interface ProcessingItem {
  id: string;
  batch_id: string;
  batch_code: string;
  material_kind: string;
  measurement_set_id: string;
  measurements: ProcessingMeasurement[];
  source_production_output_id?: string;
  source_event_id?: string;
  output_role?: string;
}

export interface ProcessingEvent {
  id: string;
  event_code: string;
  occurred_at_claimed: string;
  recorded_at: string;
  current_status: string;
  processing_facility_id: string;
  processing_facility_name: string;
  operator_party_id?: string;
  input_count: number;
  output_count: number;
  sourceSiteIds?: string[];
  sourceHoleIds?: string[];
  inputs?: ProcessingItem[];
  outputs?: ProcessingItem[];
}

export interface GoldTradeMeasurement {
  id: string;
  line_id: string;
  measurement_set_id: string;
  measurement_kind: 'DECLARED' | 'MEASURED' | 'VERIFIED';
  quantity_g: string;
  source_value: string;
  source_unit_code: string;
  conversion_version: string;
  source_role: string;
  source_party_id: string | null;
  entered_by_user_id: string;
  occurred_at_claimed: string;
  entered_at: string;
  method_code: string | null;
  instrument_ref: string | null;
  evidence_ref: string | null;
  supersedes_measurement_id: string | null;
}

export interface GoldTradeLine {
  id: string;
  trade_id: string;
  batch_id: string;
  batch_code: string;
  material_kind: string;
  source_event_id?: string | null;
  source_event_kind?: string | null;
  source_event_status?: string | null;
  revision_no: number;
  revision_kind: string;
  transaction_quantity_g: string;
  accepted_trade_quantity_g: string | null;
  unit_price: string;
  line_amount: string;
  deduction_amount: string;
  deduction_reason: string | null;
  assay_record_id: string | null;
  supersedes_line_id: string | null;
  correction_reason: string | null;
  proposed_by_user_id: string;
  is_accepted: boolean;
  is_current: boolean;
  measurements: GoldTradeMeasurement[];
  custody: GoldCustodyTransfer[];
  custodyTotals?: {
    transferred_quantity_g: string;
    offered_quantity_g: string;
    disputed_quantity_g: string;
  };
}

export interface GoldAssay {
  id: string;
  batch_id: string;
  gold_trade_line_id: string | null;
  assayer_party_id: string;
  sample_ref: string | null;
  method_ref: string | null;
  result_value: string;
  result_unit: string;
  observed_at: string;
  evidence_ref: string | null;
  correction_of_id: string | null;
  correction_reason: string | null;
  recorded_by_user_id: string;
}

export interface GoldDecision {
  id: string;
  gold_trade_line_id: string;
  actor_user_id: string;
  actor_party_id: string;
  decision: 'ACCEPT' | 'DISPUTE' | 'REJECT';
  occurred_at: string;
  reason: string | null;
  evidence_ref: string | null;
  accepted_quantity_g: string | null;
  accepted_unit_price: string | null;
  accepted_line_amount: string | null;
  accepted_deduction_amount: string | null;
}

export interface GoldTradeStatusEvent {
  actor_party_id: string;
  actor_user_id: string;
  next_status: string;
  previous_status: string | null;
  occurred_at: string;
  reason: string | null;
  evidence_ref: string | null;
}

export interface GoldCustodyTransfer {
  id: string;
  gold_trade_line_id: string;
  from_party_id: string;
  to_party_id: string;
  status: string;
  quantity_g: string;
  offered_at: string;
  last_decision?: string | null;
}

export interface GoldPayment {
  id: string;
  currency_code: string;
  payer_party_id: string;
  payee_party_id: string;
  created_at: string;
  reported_amount: string;
  settled_amount: string;
  current_status: string;
  disputed: boolean;
}

export interface GoldTrade {
  id: string;
  trade_code: string;
  trade_kind: 'PURCHASE' | 'RESALE';
  seller_party_id: string;
  buyer_party_id: string;
  status: string;
  trade_date: string;
  currency_code: string;
  terms_ref: string | null;
  lines: GoldTradeLine[];
  decisions: GoldDecision[];
  statusHistory: GoldTradeStatusEvent[];
  evidence: Array<{ id: string; evidence_kind: string; evidence_ref: string; occurred_at: string; actor_party_id: string }>;
  assays: GoldAssay[];
  payments: GoldPayment[];
  reconciliation: {
    amountAgreed: string;
    amountSettled: string;
    amountOutstanding: string;
    amountReported: string;
    amountDisputed: string;
    currencyCode: string;
    unresolvedPaymentReports: string[];
    measurementDiscrepancies: Array<{ lineId: string; batchId: string; declaredQuantitiesGrams: string[]; measuredQuantitiesGrams: string[]; observationSpreadGrams: string }>;
    unresolvedLines: string[];
    unresolvedDecisions: GoldDecision[];
  };
}

export interface CommerceWorkspaceProps {
  section: CommerceSection;
  token: string;
  personPartyId: string;
  userId: string;
  actingRole: ActingRole | null;
  roles: ActingRole[];
  sites: SiteReference[];
  online: boolean;
}

export function actingPartyId(personPartyId: string, role: ActingRole | null): string {
  return role?.scopeKind === 'ORGANISATION' ? role.scopeId : personPartyId;
}

export function displayDate(value?: string | null): string {
  if (!value) return 'Not returned by this API';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function readable(value?: string | null): string {
  return (value ?? 'Not recorded').replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function gramsFromSource(value: string, unit: string): string | null {
  const match = /^(0|[1-9][0-9]*)(?:\.(\d{1,12}))?$/.exec(value);
  if (!match) return null;
  const scaled = BigInt(match[1]) * 1_000_000_000_000n + BigInt((match[2] ?? '').padEnd(12, '0'));
  const divisor = unit === 'kg' ? 1_000n : unit === 'mg' ? 1_000_000_000n : unit === 'g' ? 1_000_000n : null;
  if (divisor === null || scaled % divisor !== 0n) return null;
  const micros = scaled / divisor;
  return `${micros / 1_000_000n}.${String(micros % 1_000_000n).padStart(6, '0')}`;
}

export function toDateTimeInput(value = new Date()): string {
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function activeMeasurementStatus(measurement: ProductionMeasurement, all: ProductionMeasurement[]): string {
  return all.some((candidate) => candidate.supersedes_measurement_id === measurement.id)
    ? 'Superseded by a later correction'
    : 'Current record';
}
