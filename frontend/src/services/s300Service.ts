import type { S300Channel, Inspection, InspectionDetail, VipPlate, ChannelStatus, AppSettings, Visit, VisitSummary } from '../types/s300';

const API_BASE = (import.meta as { env?: { VITE_API_BASE?: string } }).env?.VITE_API_BASE
  || 'http://127.0.0.1/anpr_backend';

interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  // Attach the bearer token (when signed in) so the backend can audit who acted,
  // e.g. who approved/rejected a suspect inspection.
  const headers: Record<string, string> = {};
  if (body) headers['Content-Type'] = 'application/json';
  const token = localStorage.getItem('anpr_auth_token');
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(API_BASE + path, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json: ApiResponse<T> = await res.json();
  if (!res.ok || json.code !== 200) {
    const err = new Error(json.message || `HTTP ${res.status}`) as Error & { code?: number; data?: unknown };
    err.code = json.code;
    err.data = json.data;
    throw err;
  }
  return json.data;
}

export const apiBase = API_BASE;

/**
 * Resolve a backend media path to an absolute URL. The backend returns
 * upload paths relative to its own root (e.g. "/anpr_backend/uploads/…"),
 * which break when the frontend is served from a different origin. Anchor
 * them to the API base's origin so they load regardless of where the SPA runs.
 */
export function mediaUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  try {
    return new URL(API_BASE).origin + (path.startsWith('/') ? path : '/' + path);
  } catch {
    return path;
  }
}

// ----- channels -----
export const listChannels = () => request<S300Channel[]>('GET', '/api/channels');
export const createChannel = (data: Partial<S300Channel>) => request<S300Channel>('POST', '/api/channels', data);
export const updateChannel = (id: number, data: Partial<S300Channel>) =>
  request<S300Channel>('PUT', `/api/channels/${id}`, data);
export const deleteChannel = (id: number) => request<null>('DELETE', `/api/channels/${id}`);

// ----- inspections -----
export const listInspections = (params: Record<string, string | number> = {}) => {
  const q = new URLSearchParams(params as Record<string, string>).toString();
  return request<{ items: Inspection[]; total: number }>('GET', `/api/inspections${q ? '?' + q : ''}`);
};
export const getInspection = (id: number) => request<InspectionDetail>('GET', `/api/inspections/${id}`);

// Manual review of a SUSPECT inspection — approve (let in) / reject (turn back).
export const approveInspection = (id: number, note?: string) =>
  request<Inspection>('POST', `/api/inspections/${id}/approve`, { note });
export const rejectInspection = (id: number, note?: string) =>
  request<Inspection>('POST', `/api/inspections/${id}/reject`, { note });

// ----- channel status -----
export const getChannelStatus = (channelNo: string) =>
  request<ChannelStatus>('GET', `/api/channels/by-no/${encodeURIComponent(channelNo)}/status`);

// ----- VIP plates -----
export const listVipPlates = () => request<VipPlate[]>('GET', '/api/vip');
export const createVipPlate = (data: { license_plate: string; description?: string; enabled?: number }) =>
  request<VipPlate>('POST', '/api/vip', data);
export const updateVipPlate = (id: number, data: { description?: string; enabled?: number }) =>
  request<VipPlate>('PUT', `/api/vip/${id}`, data);
export const deleteVipPlate = (id: number) => request<null>('DELETE', `/api/vip/${id}`);
export const checkVipPlate = (plate: string) =>
  request<{ plate: string; vip: boolean }>('GET', `/api/vip/check/${encodeURIComponent(plate)}`);

// ----- settings -----
export const getSettings = () => request<AppSettings>('GET', '/api/settings');
export const updateSettings = (data: Partial<AppSettings>) =>
  request<null>('PUT', '/api/settings', data);

// ----- S300 outbound calls (platform calls S300 via backend proxy) -----
export const s300Come = (channelNo: string, licensePlateNo: string, force = false) =>
  request<{ inspectionId: number; s300Response: unknown; elapsedMs: number; vip?: boolean }>(
    'POST', `/api/s300/come/${encodeURIComponent(channelNo)}`, { licensePlateNo, force }
  );
export const s300Capture = (channelNo: string) =>
  request<unknown>('GET', `/api/s300/capture/${encodeURIComponent(channelNo)}`);
export const s300Leave = (channelNo: string) =>
  request<unknown>('GET', `/api/s300/leave/${encodeURIComponent(channelNo)}`);
export const s300ReadWorkStatus = (channelNo: string) =>
  request<unknown>('POST', `/api/s300/read-work-status/${encodeURIComponent(channelNo)}`);
export const s300EmergencyStop = (channelNo: string) =>
  request<unknown>('POST', `/api/s300/emergency-stop/${encodeURIComponent(channelNo)}`);
export const s300ManualReset = (channelNo: string) =>
  request<unknown>('POST', `/api/s300/manual-reset/${encodeURIComponent(channelNo)}`);


export interface AudioPromptItem {
  index: number;
  language: number;
  url: string;
  desc?: string;
}
export const s300AudioPrompt = (channelNo: string, data: AudioPromptItem[]) =>
  request<unknown>('POST', '/api/s300/audio-prompt', { channelNo, data });

// ----- visits -----
export const listVisits = (params: Record<string, string | number> = {}) => {
  const q = new URLSearchParams(params as Record<string, string>).toString();
  return request<{ items: Visit[]; total: number }>('GET', `/api/visits${q ? '?' + q : ''}`);
};
export const visitSummary = () => request<VisitSummary>('GET', '/api/visits/summary');

// ----- cron tick (timeout sweep) -----
export const cronTick = () =>
  request<{ now: string; resolved: { inspectionId: number; plate: string; decision: string; reason: string }[] }>('POST', '/api/cron/tick');

// ----- SSE event stream -----
export type S300EventType =
  | 'work-status'
  | 'face-image'
  | 'video-record'
  | 'reset-complete'
  | 'uvis'
  | 'decision'
  | 'blocker-opened'
  | 'failure-audio-sent'
  | 'vip-bypass'
  | 'visit-completed'
  | 'orphan-exit'
  | 'reset-watchdog';

export interface S300Event<T = unknown> {
  type: S300EventType;
  payload: T;
}

export function connectS300Events(
  onEvent: (event: S300Event) => void,
  onError?: (e: Event) => void,
): () => void {
  const es = new EventSource(API_BASE + '/api/events/stream');
  const types: S300EventType[] = ['work-status', 'face-image', 'video-record', 'reset-complete', 'uvis', 'decision', 'blocker-opened', 'failure-audio-sent', 'vip-bypass', 'visit-completed', 'orphan-exit', 'reset-watchdog'];
  types.forEach((t) => {
    es.addEventListener(t, (e) => {
      try {
        const payload = JSON.parse((e as MessageEvent).data);
        onEvent({ type: t, payload });
      } catch { /* ignore */ }
    });
  });
  if (onError) es.onerror = onError;
  return () => es.close();
}
