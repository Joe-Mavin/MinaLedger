import { API_BASE_URL } from './apiBase';

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function apiRequest<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    cache: 'no-store',
    credentials: 'omit',
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });
  const body = await response.json().catch(() => ({})) as { error?: { message?: string; code?: string } } & T;
  if (!response.ok) throw new ApiError(response.status, body.error?.message ?? `Request failed with HTTP ${response.status}.`, body.error?.code);
  return body as T;
}

export interface SiteReference {
  id: string;
  siteCode: string;
  name: string;
  countyCode?: string | null;
  locality?: string | null;
  status?: string;
}

export interface HoleReference {
  id: string;
  siteId: string;
  holeCode: string;
  name?: string;
  auditSequence?: number;
}

export interface HoleParticipantReference {
  party_id: string;
  display_name: string;
  relationship_id: string;
  role_code: string;
}

export interface ProductionEventReference {
  id: string;
  siteId: string;
  hole_id: string;
  auditSequence: number;
  participants: Array<{ party_id: string; role_code: string; relationship_id: string; relationship_kind: string }>;
  captureProvenance: {
    id: string;
    actual_participant_party_id: string | null;
    participant_identity_state: 'IDENTIFIED' | 'UNRESOLVED' | 'UNKNOWN';
    source_kind: string;
    occurred_at_claimed: string;
    entered_at: string;
    source_reference: string | null;
    evidence_ref: string | null;
  } | null;
  outputs: Array<{ id: string; batch_id: string; batch_code: string; material_kind: string; measurement_set_id: string }>;
}

export async function getSites(token: string): Promise<SiteReference[]> {
  return apiRequest<SiteReference[]>('/api/v1/sites', token);
}

export async function getHoles(siteId: string, token: string): Promise<HoleReference[]> {
  return apiRequest<HoleReference[]>(`/api/v1/sites/${siteId}/holes`, token);
}

export async function getHoleParticipants(siteId: string, holeId: string, token: string): Promise<HoleParticipantReference[]> {
  return apiRequest<HoleParticipantReference[]>(`/api/v1/sites/${siteId}/holes/${holeId}/participants`, token);
}

export async function getProductionEvent(siteId: string, eventId: string, token: string): Promise<ProductionEventReference> {
  return apiRequest<ProductionEventReference>(`/api/v1/sites/${siteId}/production-events/${eventId}`, token);
}
