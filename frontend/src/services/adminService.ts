const API_BASE = (import.meta as { env?: { VITE_API_BASE?: string } }).env?.VITE_API_BASE
  || 'http://127.0.0.1/anpr_backend';

interface ApiResponse<T> { code: number; message: string; data: T }

export interface ResetDataResult {
  cleared: Record<string, number>;
  total: number;
  preserved: string[];
}

function token(): string | null {
  return localStorage.getItem('anpr_auth_token');
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
