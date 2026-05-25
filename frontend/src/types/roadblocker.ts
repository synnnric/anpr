export interface RoadBlockerConfig {
  ip: string;
  port: number;
  deviceNo: string;
}

export interface ColumnStatusMap {
  [boardId: string]: {
    [columnId: string]: number;
  };
}

export interface RoadBlockerStatusResponse {
  code: number;
  msg: string;
  data: {
    controlTheDeviceOnline: boolean;
    liftingColumnsStatus: ColumnStatusMap;
  } | null;
}

export interface RoadBlockerOperationRequest {
  deviceNo: string;
  ipCode: Record<string, number>;
  operationType: 'device_level' | 'ip_level' | 'liftingColumn_level';
  action: 'up' | 'down';
  liftingColumnNum?: number;
}

export interface RoadBlockerOperationResponse {
  code: number;
  msg: string;
  data: unknown;
}

export const COLUMN_STATUS: Record<number, { label: string; color: string; icon: string }> = {
  0:  { label: 'Unknown',    color: 'text-text-secondary', icon: 'bg-gray-500' },
  1:  { label: 'Descending', color: 'text-amber-400',      icon: 'bg-amber-400' },
  3:  { label: 'Lowered',    color: 'text-green-400',      icon: 'bg-green-400' },
  5:  { label: 'Rising',     color: 'text-blue-400',       icon: 'bg-blue-400' },
  7:  { label: 'Raised',     color: 'text-red-400',        icon: 'bg-red-400' },
};

export function getColumnStatus(code: number) {
  return COLUMN_STATUS[code] || COLUMN_STATUS[0];
}
