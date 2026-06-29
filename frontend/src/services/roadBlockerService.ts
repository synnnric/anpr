import type { RoadBlockerStatus, RoadBlockerActionResult, BlockerAction } from '../types/roadblocker';

const API_BASE = (import.meta as { env?: { VITE_API_BASE?: string } }).env?.VITE_API_BASE
  || 'http://127.0.0.1/anpr_backend';

interface ApiResponse<T> { code: number; message: string; data: T }

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(API_BASE + path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json: ApiResponse<T> = await res.json();
  if (!res.ok || json.code !== 200) throw new Error(json.message || `HTTP ${res.status}`);
  return json.data;
}

/** CORX relay config + last action (live up/down state is not reported by the device synchronously). */
export const getBlockerStatus = () => request<RoadBlockerStatus>('GET', '/api/road-blocker/status');

/** Pulse the relay: open (DOWN/clear lane), close (UP/block lane), or stop. */
export const sendBlockerAction = (action: BlockerAction) =>
  request<RoadBlockerActionResult>('POST', `/api/road-blocker/${action}`);

/** Enable/disable auto-open on a passed inspection (OFF by default — collision risk). */
export const setBlockerAutoOpen = (enabled: boolean) =>
  request<{ auto_open: boolean }>('POST', '/api/road-blocker/auto-open', { enabled });
