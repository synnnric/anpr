export type BlockerAction = 'open' | 'close' | 'stop';

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
