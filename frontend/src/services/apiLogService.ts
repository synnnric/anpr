import { API_BASE } from './apiBase';

interface ApiResponse<T> { code: number; message: string; data: T }

export interface ApiLogEvent {
  id: number;
  endpoint: string;
  cmd_no: number | null;
  channel_no: string | null;
  source_ip: string | null;
  body_preview: string | null;
  body_len: number | null;
  received_at: string;
}

export interface ApiLogResult {
  events: ApiLogEvent[];
  endpoints: string[];
  total: number;
}

/** Inbound device→platform API calls (S300 /overseas/* callbacks). */
export async function getApiLog(endpoint = 'all', limit = 100, offset = 0): Promise<ApiLogResult> {
  const q = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (endpoint && endpoint !== 'all') q.set('endpoint', endpoint);
  const res = await fetch(`${API_BASE}/api/api-log?${q}`);
  const json: ApiResponse<ApiLogResult> = await res.json();
  if (!res.ok || json.code !== 200) throw new Error(json.message || `HTTP ${res.status}`);
  return json.data;
}
