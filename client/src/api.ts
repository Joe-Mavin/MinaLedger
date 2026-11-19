const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001';

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

export async function getSites(token: string): Promise<SiteReference[]> {
  return apiRequest<SiteReference[]>('/api/v1/sites', token);
}

export async function getHoles(siteId: string, token: string): Promise<HoleReference[]> {
  return apiRequest<HoleReference[]>(`/api/v1/sites/${siteId}/holes`, token);
}

export async function getHoleParticipants(siteId: string, holeId: string, token: string): Promise<HoleParticipantReference[]> {
  return apiRequest<HoleParticipantReference[]>(`/api/v1/sites/${siteId}/holes/${holeId}/participants`, token);
}
