import type { RoadBlockerStatus, RoadBlockerActionResult, BlockerAction, BlockerSensorState } from '../types/roadblocker';

import { API_BASE } from './apiBase';

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

/** Pulse the global relay: open (DOWN/clear lane), close (UP/block lane), or stop. */
export const sendBlockerAction = (action: BlockerAction) =>
  request<RoadBlockerActionResult>('POST', `/api/road-blocker/${action}`);

/** Pulse one lane's relay (multi-lane). */
export const sendLaneAction = (channelNo: string, action: BlockerAction) =>
  request<RoadBlockerActionResult>('POST', `/api/road-blocker/lane/${encodeURIComponent(channelNo)}/${action}`);

/** Fan an action out to every blocker-enabled lane (bulk). */
export const sendBulkAction = (action: BlockerAction) =>
  request<{ sent: number; total: number }>('POST', `/api/road-blocker/bulk/${action}`);

/** Per-lane auto-open toggle (independent of the global one). */
export const setLaneAutoOpen = (channelNo: string, enabled: boolean) =>
  request<{ channel_no: string; auto_open: boolean }>(
    'POST', `/api/road-blocker/lane/${encodeURIComponent(channelNo)}/auto-open`, { enabled });

/** Future vehicle-sensor hook: passing suppresses commands; clear/raised advance the cycle. */
export const setLaneSensor = (channelNo: string, state: BlockerSensorState) =>
  request<{ channel_no: string; sensor: string; cycle: string }>(
    'POST', `/api/road-blocker/lane/${encodeURIComponent(channelNo)}/sensor`, { state });

/** Enable/disable auto-open on a passed inspection (OFF by default — collision risk). */
export const setBlockerAutoOpen = (enabled: boolean) =>
  request<{ auto_open: boolean }>('POST', '/api/road-blocker/auto-open', { enabled });

export interface BlockerConfig {
  blocker_relay_enabled: string;
  blocker_relay_topic: string;
  blocker_relay_res: string;
  blocker_relay_value: string;
  blocker_relay_open_ch: string;
  blocker_relay_close_ch: string;
  blocker_relay_stop_ch: string;
}

/** Persist relay config to anprc_settings via the generic settings API. */
export const saveBlockerConfig = (cfg: BlockerConfig) =>
  request<null>('PUT', '/api/settings', cfg);
