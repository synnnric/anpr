const API_BASE = (import.meta as { env?: { VITE_API_BASE?: string } }).env?.VITE_API_BASE
  || 'http://127.0.0.1/anpr_backend';

interface ApiResponse<T> { code: number; message: string; data: T }

export interface AuditLogEntry {
  id: number;
  actor_username: string | null;
  channel_no: string | null;
  inspection_id: number | null;
  action: string;
  request_payload: unknown;
  response_payload: unknown;
  status: 'success' | 'failed';
  error_message: string | null;
  created_at: string;
}

export interface AuditLogFacets {
  actors: { username: string; count: number }[];
  actions: { action: string; count: number }[];
}

export interface AuditLogQuery {
  limit?: number;
  offset?: number;
  action?: string;
  channelNo?: string;
  actor?: string;
  status?: 'success' | 'failed';
  since?: string;
  until?: string;
  q?: string;
}

function token(): string | null {
  return localStorage.getItem('anpr_auth_token');
}

async function getJson<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {};
  const t = token();
  if (t) headers['Authorization'] = `Bearer ${t}`;
  const res = await fetch(API_BASE + path, { headers });
  const json: ApiResponse<T> = await res.json();
  if (!res.ok || json.code !== 200) {
    throw new Error(json.message || `HTTP ${res.status}`);
  }
  return json.data;
}

export function listAuditLog(query: AuditLogQuery = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }
  const q = params.toString();
  return getJson<{ items: AuditLogEntry[]; total: number }>(`/api/operation-log${q ? '?' + q : ''}`);
}

export function getAuditLogFacets() {
  return getJson<AuditLogFacets>('/api/operation-log/facets');
}
