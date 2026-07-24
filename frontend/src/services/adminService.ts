import { API_BASE } from './apiBase';

export { API_BASE };

interface ApiResponse<T> { code: number; message: string; data: T }

export interface ResetDataResult {
  cleared: Record<string, number>;
  total: number;
  preserved: string[];
}

function token(): string | null {
  return localStorage.getItem('anpr_auth_token');
}

/** Auth header map for ad-hoc fetch() calls outside the service wrappers. */
export function authHeaders(): Record<string, string> {
  const t = token();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/**
 * Wipes all transactional + MQTT log data (testing only).
 * Configuration (channels, VIP, settings, users, audio prompts) is preserved.
 */
export async function resetData(): Promise<ResetDataResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const t = token();
  if (t) headers['Authorization'] = `Bearer ${t}`;
  const res = await fetch(API_BASE + '/api/admin/reset-data', { method: 'POST', headers });
  const json: ApiResponse<ResetDataResult> = await res.json();
  if (!res.ok || json.code !== 200) {
    throw new Error(json.message || `HTTP ${res.status}`);
  }
  return json.data;
}
