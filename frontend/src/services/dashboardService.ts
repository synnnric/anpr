const API_BASE = (import.meta as { env?: { VITE_API_BASE?: string } }).env?.VITE_API_BASE
  || 'http://127.0.0.1/anpr_backend';

interface ApiResponse<T> { code: number; message: string; data: T }

async function request<T>(method: string, path: string): Promise<T> {
  const res = await fetch(API_BASE + path, { method });
  const json: ApiResponse<T> = await res.json();
  if (!res.ok || json.code !== 200) throw new Error(json.message || `HTTP ${res.status}`);
  return json.data;
}

export type HealthLevel = 'ok' | 'stale' | 'unknown';

export interface ActiveInspection {
  id: number;
  license_plate: string;
  state: string;
  decision: string;
  current_operating_state: number | null;
  come_called_at: string | null;
  decision_at: string | null;
  decision_timeout_at: string | null;
}

export interface S300Status {
  reachable: boolean;
  host?: string;
  port?: number;
  reason?: string;
  elapsed_ms?: number;
}

export interface RoadBlockerStatus {
  online: boolean;
  reachable: boolean;
  controller_online?: boolean;
  columns?: { [boardId: string]: { [columnId: string]: number } };
  reason?: string;
  elapsed_ms?: number;
}

export interface DashboardChannel {
  channel_no: string;
  name: string | null;
  kind: 'entry' | 'exit';
  enabled: boolean;
  anpr_device_sn: string | null;
  s300_base_url: string;
  rb_ip: string | null;
  rb_port: number | null;
  rb_device_no: string | null;
  rb_board_id: string | null;
  rb_column_num: number | null;
  paired_channel_id: number | null;
  uvis_timeout_sec: number;
  anpr_last_heartbeat_at?: string | null;
  anpr_last_heartbeat_age?: number | null;
  anpr_msgs_today?: number;
  anpr_status: HealthLevel;
  last_plate?: string | null;
  last_plate_at?: string | null;
  active_inspection: ActiveInspection | null;
  s300: S300Status | null;
  road_blocker: RoadBlockerStatus | null;
}

export interface DashboardSnapshot {
  system: {
    now_utc: string;
    timezone: string;
    backend_version: string;
    db_version: string;
    db_latency_ms: number;
    last_inbound_at: string | null;
    last_inbound_age_sec: number | null;
    broker_reachable: boolean;
    broker_latency_ms: number;
    broker_error: string | null;
    worker_last_seen_at: string | null;
    worker_last_seen_age: number | null;
    backend_status: HealthLevel;
    db_status: HealthLevel;
    mqtt_status: HealthLevel;
    worker_status: HealthLevel;
  };
  channels: DashboardChannel[];
  today: {
    plates_detected: number;
    inspections: {
      total: number; pass: number; suspect: number; fail: number;
      vip_pass: number; in_progress: number;
    };
    visits: {
      active_now: number; entered: number; completed: number;
      orphan_exits: number; denied_entries: number;
    };
  };
  mqtt_queue: { pending: number; sent: number; failed: number; last_error: string | null };
  recent_plates: {
    id: number; device_sn: string; license_plate: string; received_at: string;
  }[];
  recent_decisions: {
    id: number; channel_no: string; license_plate: string; state: string;
    decision: string; decision_reason: string | null; blocker_opened: number;
    come_called_at: string | null; decision_at: string | null;
  }[];
}

export const getDashboard = () => request<DashboardSnapshot>('GET', '/api/dashboard');
