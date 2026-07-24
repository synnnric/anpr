export type BlockerAction = 'open' | 'close' | 'stop';
export type BlockerSensorState = 'passing' | 'clear' | 'raised';

export interface BlockerLane {
  channel_no: string;
  name: string | null;
  enabled: boolean;
  auto_open: boolean;
  topic: string | null;
  pub_topic: string | null;
  res: string | null;
  open_ch: string | null;
  close_ch: string | null;
  stop_ch: string | null;
  sensor: string;   // clear | passing
  cycle: string;    // idle | lowered | passed | raised
  position: string; // down | up | unknown (ACK-confirmed physical state)
}

export interface RoadBlockerStatus {
  enabled: boolean;
  auto_open: boolean;
  topic: string;
  value: number;
  res: string;
  channels: {
    open: string;
    close: string;
    stop: string;
  };
  lanes: BlockerLane[];
  last_action: {
    action: string;
    status: string;
    created_at: string;
  } | null;
}

export interface RoadBlockerActionResult {
  action: BlockerAction;
  queued: number;
  topic: string;
  body: Record<string, unknown>;
}
