import type { S300Channel, Inspection, InspectionDetail, VipPlate, BlacklistPlate, ChannelStatus, AppSettings, Visit, VisitSummary, Xray, SiteLocation } from '../types/s300';

import { API_BASE } from './apiBase';

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

// ----- location master (channel zone picklist) -----
export const listLocations = () => request<SiteLocation[]>('GET', '/api/locations');
export const createLocation = (name: string) => request<SiteLocation>('POST', '/api/locations', { name });
export const deleteLocation = (id: number) => request<null>('DELETE', `/api/locations/${id}`);

// ----- x-ray review (scans pushed by the x-ray station; receipt opens the exit barrier) -----
export const listXray = (params: Record<string, string | number> = {}) => {
  const q = new URLSearchParams(params as Record<string, string>).toString();
  return request<{ items: Xray[]; total: number; pending: number }>('GET', `/api/xray${q ? '?' + q : ''}`);
};
export const reviewXray = (id: number, result: boolean, note?: string) =>
  request<Xray>('POST', `/api/xray/${id}/review`, { result, note });
export const resendXrayReceipt = (id: number) =>
  request<Xray>('POST', `/api/xray/${id}/resend`);
// Operator manually sends a vehicle to the x-ray (videotron + routing record).
export const routeInspectionXray = (id: number) =>
  request<Inspection>('POST', `/api/inspections/${id}/route-xray`);

// ----- channel status -----
export const getChannelStatus = (channelNo: string) =>
  request<ChannelStatus>('GET', `/api/channels/by-no/${encodeURIComponent(channelNo)}/status`);

// ----- VIP plates -----
export const listVipPlates = () => request<VipPlate[]>('GET', '/api/vip');
// channel_nos: lane scopes — one row per lane; empty/absent = all lanes (one NULL-scope row)
export const createVipPlate = (data: { license_plate: string; description?: string; enabled?: number; channel_nos?: string[]; expires_at?: string }) =>
  request<{ created: VipPlate[]; skipped_scopes: string[] }>('POST', '/api/vip', data);
export const updateVipPlate = (id: number, data: { description?: string; enabled?: number }) =>
  request<VipPlate>('PUT', `/api/vip/${id}`, data);
export const deleteVipPlate = (id: number) => request<null>('DELETE', `/api/vip/${id}`);
export const checkVipPlate = (plate: string) =>
  request<{ plate: string; vip: boolean }>('GET', `/api/vip/check/${encodeURIComponent(plate)}`);

// ----- Blacklist plates (ANPR-stage deny list) -----
export const listBlacklistPlates = () => request<BlacklistPlate[]>('GET', '/api/blacklist');
export const createBlacklistPlate = (data: { license_plate: string; description?: string; enabled?: number; channel_nos?: string[]; expires_at?: string }) =>
  request<{ created: BlacklistPlate[]; skipped_scopes: string[] }>('POST', '/api/blacklist', data);
export const updateBlacklistPlate = (id: number, data: { description?: string; enabled?: number }) =>
  request<BlacklistPlate>('PUT', `/api/blacklist/${id}`, data);
export const deleteBlacklistPlate = (id: number) => request<null>('DELETE', `/api/blacklist/${id}`);
export const checkBlacklistPlate = (plate: string) =>
  request<{ plate: string; blacklisted: boolean }>('GET', `/api/blacklist/check/${encodeURIComponent(plate)}`);

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
// Orphan-exit confirmation: allow opens the exit barrier, deny keeps it shut.
export const allowOrphanExit = (id: number) => request<Visit>('POST', `/api/visits/${id}/orphan-allow`);
export const denyOrphanExit = (id: number) => request<Visit>('POST', `/api/visits/${id}/orphan-deny`);
// Misread pairing: similar active-visit candidates + pair (closes that visit,
// opens the barrier, drops the orphan row so totals tally).
export interface OrphanCandidate {
  id: number; license_plate: string; entry_channel_no: string | null;
  entry_at: string | null; distance: number;
}
export const orphanCandidates = (id: number) =>
  request<OrphanCandidate[]>('GET', `/api/visits/${id}/orphan-candidates`);
export const pairOrphanExit = (id: number, pairVisitId: number) =>
  request<Visit>('POST', `/api/visits/${id}/orphan-pair`, { pair_visit_id: pairVisitId });

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
  | 'blacklist-denied'
  | 'visit-completed'
  | 'orphan-exit'
  | 'orphan-review'
  | 'reset-watchdog'
  | 'x-ray'
  | 'x-ray-receipt'
  | 'route-to-xray'
  | 'blacklist-xray'
  | 'xray-cleared'
  | 'xray-flagged'
  | 'xray-room-come'
  | 'whitelist-xray';

export interface S300Event<T = unknown> {
  type: S300EventType;
  payload: T;
}

export function connectS300Events(
  onEvent: (event: S300Event) => void,
  onError?: (e: Event) => void,
): () => void {
  const es = new EventSource(API_BASE + '/api/events/stream');
  const types: S300EventType[] = ['work-status', 'face-image', 'video-record', 'reset-complete', 'uvis', 'decision', 'blocker-opened', 'failure-audio-sent', 'vip-bypass', 'blacklist-denied', 'visit-completed', 'orphan-exit', 'orphan-review', 'reset-watchdog', 'x-ray', 'x-ray-receipt', 'route-to-xray', 'blacklist-xray', 'xray-cleared', 'xray-flagged', 'xray-room-come', 'whitelist-xray'];
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
