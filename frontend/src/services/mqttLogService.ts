const API_BASE = (import.meta as { env?: { VITE_API_BASE?: string } }).env?.VITE_API_BASE
  || 'http://127.0.0.1/anpr_backend';

interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
}

async function request<T>(method: string, path: string): Promise<T> {
  const res = await fetch(API_BASE + path, { method });
  const json: ApiResponse<T> = await res.json();
  if (!res.ok || json.code !== 200) {
    throw new Error(json.message || `HTTP ${res.status}`);
  }
  return json.data;
}

export interface MqttDevice {
  device_sn: string;
  inbound_total: number;
  last_inbound_at: string | null;
  outbound_total: number;
  last_outbound_at: string | null;
  outbound_pending: number;
  outbound_sent: number;
  outbound_failed: number;
  inbound_breakdown: { message_name: string; c: number }[];
  channel: { channel_no: string; name: string | null; anpr_device_sn: string } | null;
}

export interface MqttInboundRow {
  id: number;
  device_sn: string;
  topic: string;
  message_name: string;
  license_plate: string | null;
  payload: unknown;
  received_at: string;
}

export interface MqttOutboundRow {
  id: number;
  device_sn: string;
  message_name: string;
  payload: unknown;
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
}

export interface MqttLogFilters {
  device_sn?: string;
  message_name?: string;
  status?: string;
  license_plate?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface MqttMessageNames {
  inbound: string[];
  outbound: string[];
  all: string[];
}

function qs(filters: MqttLogFilters): string {
  const p = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => {
    if (v !== undefined && v !== '' && v !== null) p.set(k, String(v));
  });
  const s = p.toString();
  return s ? '?' + s : '';
}

export const listMqttDevices = () => request<MqttDevice[]>('GET', '/api/mqtt-log/devices');

export const listMqttInbound = (filters: MqttLogFilters = {}) =>
  request<{ items: MqttInboundRow[]; total: number }>(
    'GET',
    '/api/mqtt-log/inbound' + qs(filters),
  );

export const listMqttOutbound = (filters: MqttLogFilters = {}) =>
  request<{ items: MqttOutboundRow[]; total: number }>(
    'GET',
    '/api/mqtt-log/outbound' + qs(filters),
  );

export const listMqttMessageNames = () =>
  request<MqttMessageNames>('GET', '/api/mqtt-log/message-names');
