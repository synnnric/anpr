export type ChannelKind = 'entry' | 'exit' | 'xray';

export interface SiteLocation {
  id: number;
  name: string;
  created_at: string;
}

export interface S300Channel {
  id: number;
  channel_no: string;
  anpr_device_sn: string | null;
  s300_base_url: string;
  name: string | null;
  location: string | null;   // site zone, e.g. "Gerbang Pancasila" / "Gerbang 46"
  enabled: number;
  kind: ChannelKind;
  paired_channel_id: number | null;
  uvis_timeout_sec: number;
  failure_audio_index: number | null;
  // Per-lane road-blocker relay (multi-lane); NULL => fall back to global settings.
  blocker_relay_enabled?: number;
  blocker_relay_topic?: string | null;
  blocker_relay_pub_topic?: string | null;
  blocker_relay_res?: string | null;
  blocker_relay_open_ch?: string | null;
  blocker_relay_close_ch?: string | null;
  blocker_relay_stop_ch?: string | null;
  blocker_sensor?: string;
  blocker_cycle?: string;
  // Per-lane behaviour switches (1 = stage active in the flow, default 1).
  // behavior_uvis_s300=0 auto-passes inspections with note 'UVIS+S300 disabled'.
  // behavior_vip / behavior_blacklist decide which plate lists this lane enforces.
  // ANPR has no switch — recognition + barrier-open IS the entry lane.
  behavior_uvis_s300?: number;  // kept in sync with s300_inspection_mode (none→0, else→1)
  // S300 inspection mode: 'none' (auto-pass) | 'skip' (complete on UVIS) |
  // 'timed' (fixed countdown after the verdict) | 'full' (face-driven, default).
  s300_inspection_mode?: string;
  s300_timed_seconds?: number;  // 'timed' countdown, seconds from the UVIS verdict (default 15)
  behavior_vip?: number;
  behavior_blacklist?: number;
  behavior_whitelist_only?: number;  // 1 = only whitelisted plates admitted (default 0)
  // Security mode (x-ray routing policy): red = all vehicles to x-ray;
  // orange = security_random_pct % of clean vehicles randomly routed;
  // green = by inspection result only (default).
  security_mode?: 'red' | 'orange' | 'green';
  security_random_pct?: number;
  created_at: string;
  updated_at: string;
}

export type VisitStatus = 'active' | 'completed' | 'orphan_exit' | 'denied_entry';

export interface Visit {
  id: number;
  license_plate: string;
  entry_channel_no: string | null;
  exit_channel_no: string | null;
  entry_inspection_id: number | null;
  entry_at: string | null;
  exit_at: string | null;
  status: VisitStatus;
  notes: string | null;
  // Orphan-exit manual confirmation (null on non-orphan / legacy rows).
  orphan_review?: 'pending' | 'allowed' | 'denied' | null;
  orphan_reviewed_by?: string | null;
  orphan_reviewed_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface VisitSummary {
  active: number;
  completed_total: number;
  completed_today: number;
  entered_today: number;
  orphan_exits_today: number;
  denied_entries_today: number;
}

export const VISIT_STATUS_META: Record<VisitStatus, { label: string; bg: string; text: string }> = {
  active:       { label: 'Inside',          bg: 'bg-blue-500/20 border border-blue-500/50',       text: 'text-blue-300' },
  completed:    { label: 'Completed',       bg: 'bg-green-500/20 border border-green-500/50',     text: 'text-green-300' },
  orphan_exit:  { label: 'Orphan Exit',     bg: 'bg-red-500/20 border border-red-500/50',         text: 'text-red-400' },
  denied_entry: { label: 'Denied Entry',    bg: 'bg-amber-500/20 border border-amber-500/50',     text: 'text-amber-400' },
};

export type Decision = 'pending' | 'pass' | 'suspect' | 'fail' | 'vip_pass';

export const DECISION_META: Record<Decision, { label: string; bg: string; text: string; icon: string }> = {
  pending:  { label: 'Pending',      bg: 'bg-surface-dark border border-border',     text: 'text-text-secondary', icon: '⋯' },
  pass:     { label: 'PASS',         bg: 'bg-green-500/20 border border-green-500/50',  text: 'text-green-400',  icon: '✓' },
  suspect:  { label: 'SUSPECT → X-RAY', bg: 'bg-amber-500/20 border border-amber-500/50', text: 'text-amber-400', icon: '!' },
  fail:     { label: 'FAIL (back out)', bg: 'bg-red-500/20 border border-red-500/50',    text: 'text-red-400',   icon: '✗' },
  vip_pass: { label: 'VIP',          bg: 'bg-violet-500/20 border border-violet-500/50', text: 'text-violet-300', icon: '★' },
};

export type InspectionState =
  | 'pending'
  | 'started'
  | 'inspecting'
  | 'resetting'
  | 'completed'
  | 'emergency_stop'
  | 'failed'
  | 'vip_skipped';

export interface Inspection {
  id: number;
  channel_no: string;
  vehicle_id: number | null;
  license_plate: string;
  state: InspectionState;
  decision: Decision;
  decision_reason: string | null;
  decision_at: string | null;
  decision_timeout_at: string | null;
  // Why the vehicle was routed to the x-ray (null = not routed):
  // inspection | security_red | security_random | manual | blacklist
  xray_route: string | null;
  review_status: 'pending' | 'approved' | 'rejected' | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  blocker_opened: number;
  blocker_opened_at: string | null;
  blocker_closed_at: string | null;
  auto_leave_called: number;
  current_operating_state: number | null;
  come_called_at: string | null;
  inspection_started_at: string | null;
  inspection_ended_at: string | null;
  leave_called_at: string | null;
  reset_completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OperationEntry {
  id: number;
  action: string;
  status: 'success' | 'failed';
  error_message: string | null;
  actor_username?: string | null;
  request_payload: unknown;
  response_payload: unknown;
  created_at: string;
}

export interface InspectionStatusLog {
  id: number;
  operating_state: number;
  cmd_no: number;
  received_at: string;
}

export interface FaceImage {
  id: number;
  image_url: string;
  received_at: string;
}

export interface VideoStream {
  id: number;
  camera_code: string;
  stream_url: string;
  stream_kind?: string;   // 'record' | 'realtime'
  received_at: string;
}
export interface XrayAlarm {
  Confidence?: number;
  Region?: { x: number; y: number; Width: number; Height: number };
  Comments?: string;
}
export type XrayReviewStatus = 'pending' | 'auto' | 'passed' | 'denied';
export interface Xray {
  id: number;
  inspection_id?: number | null;
  sn: string | null;
  vehicle_number: string | null;
  scan_started_at: string | null;
  scan_ended_at: string | null;
  is_anomaly: number;
  anomaly_comments: string | null;
  scanner_operator: string | null;
  scanned_image_url: string | null;
  plate_image_url: string | null;
  alarm_info: XrayAlarm[] | null;
  received_at: string;
  // Review + vendor receipt (§2.2.4)
  review_status: XrayReviewStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  receipt_result: number | null;   // 1 = Result:true (barrier opens), 0 = false
  receipt_status: 'sent' | 'failed' | null;
  receipt_error: string | null;
  receipt_sent_at: string | null;
}

export interface UvisCoord {
  confidence: number | string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Uvis {
  id: number;
  s300_inspection_id: number | null;
  image_type: number;
  image_path: string | null;
  image_url: string | null;
  object_count: number;
  received_at: string;
  coords: UvisCoord[];
}

export interface InspectionDetail extends Inspection {
  status_logs: InspectionStatusLog[];
  face_images: FaceImage[];
  video_streams: VideoStream[];
  uvis: Uvis[];
  xray: Xray[];
  operations: OperationEntry[];
  vehicle_full_image_url: string | null;
  vehicle_small_image_url: string | null;
}

export const OPERATING_STATE_LABELS: Record<number, string> = {
  0: 'Ready',
  1: 'Inspecting',
  2: 'Resetting',
  3: 'Reset Complete',
  4: 'Emergency Stop',
  5: 'Equipment Failure',
  6: 'Self-Testing',
};

export const OPERATING_STATE_COLORS: Record<number, string> = {
  0: 'bg-green-500',
  1: 'bg-blue-500',
  2: 'bg-yellow-500',
  3: 'bg-emerald-500',
  4: 'bg-red-600',
  5: 'bg-red-700',
  6: 'bg-purple-500',
};

export const AUDIO_PROMPT_INDEX_LABELS: Record<number, string> = {
  1: 'Welcome',
  2: 'Please move forward',
  3: 'Align with parking marker',
  4: 'Inspection in progress',
  5: 'Inspection completed',
  6: 'Please proceed',
  7: 'Please reverse',
  8: 'Please move forward (back too far)',
  9: 'Move slightly left',
  10: 'Move slightly right',
  11: 'Lower window',
  12: 'Face the screen',
  13: 'Vehicle movement detected',
  14: 'Door opened — close to restart',
};

export const AUDIO_LANGUAGES: Record<number, string> = {
  1: 'Mandarin',
  3: 'English',
  4: 'Arabic',
};

export interface VipPlate {
  id: number;
  license_plate: string;
  description: string | null;
  enabled: number;
  channel_no: string | null;   // lane scope; null = all lanes
  expires_at: string | null;   // null = permanent; past = expired (no longer matches)
  created_at: string;
}

export interface BlacklistPlate {
  id: number;
  license_plate: string;
  description: string | null;
  enabled: number;
  channel_no: string | null;   // lane scope; null = all lanes
  expires_at: string | null;   // null = permanent; past = expired (no longer matches)
  created_at: string;
}

export interface ChannelStatus {
  busy: boolean;
  reason: 'no_active_inspection' | 'ready' | 'in_progress';
  operating_state?: number;
  active: Inspection | null;
  channel: S300Channel;
}

export interface AppSettings {
  auto_start_s300?: string;
  auto_start_channel?: string;
  [key: string]: string | undefined;
}
