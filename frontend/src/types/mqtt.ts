export interface MqttConfig {
  brokerUrl: string;
  port: number;
  username: string;
  password: string;
  clientId: string;
  useSSL: boolean;
}

export interface MqttMessage {
  id: string;
  bv?: number;
  sn: string;
  name: string;
  version: string;
  timestamp: number;
  code?: number;
  payload: unknown;
}

export interface RecognitionResult {
  id: string;
  sn: string;
  timestamp: number;
  channel: number;
  deviceName: string;
  ipaddr: string;
  serialno: string;
  license: string;
  licensePlain: string;
  plateType: number;
  plateColor: number;
  confidence: number;
  carColor: number;
  direction: number;
  triggerType: number;
  imagePath: string;
  imageFragmentPath: string;
  beginTime: number;
  endTime: number;
  uniqueId: string;
  isFakePlate: number;
  isEncrypted: number;
}

export interface HeartbeatData {
  sn: string;
  timestamp: number;
  lastSeen: Date;
}

export interface IoInputEvent {
  sn: string;
  deviceName: string;
  ipaddr: string;
  source: number;
  value: number;
  timestamp: number;
}

export interface BarrierGateStatus {
  sn: string;
  gateCtrlId: number;
  gateStatus: number; // 0=Closed, 1=Opened, 2=Intermediate
  connectStatus: number; // 0=Not Connected, 1=Connected
  enable: number; // 0=Disabled, 1=Enabled
  timestamp: number;
}

export interface SerialData {
  sn: string;
  data: string;
  dataLen: number;
  serialChannel: number;
  timestamp: number;
}

export interface WhitelistEntry {
  plate: string;
  enable: number;
  createTime: string;
  enableTime?: string;
  overdueTime?: string;
  timeSegEnable: number;
  segTimeStart: string;
  segTimeEnd: string;
  needAlarm: number;
  vehicleCode?: string;
  vehicleComment?: string;
  customerId?: number;
}

export interface MessageLogEntry {
  id: string;
  direction: 'sent' | 'received';
  topic: string;
  payload: string;
  timestamp: Date;
  name: string;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export const PLATE_TYPES: Record<number, string> = {
  0: 'Unknown',
  1: 'Blue (Passenger)',
  2: 'Black (Passenger)',
  3: 'Single Yellow',
  4: 'Double Yellow',
  5: 'Police',
  6: 'Armed Police',
  7: 'Personalized',
  8: 'Single Military',
  9: 'Double Military',
  10: 'Embassy',
  11: 'HK Entry/Exit',
  12: 'Agricultural',
  13: 'Teaching Vehicle',
  14: 'Macau Entry/Exit',
  15: 'Double Police',
  19: 'New Energy Green',
  20: 'New Energy Yellow',
  21: 'Emergency',
  22: 'Consulate',
  23: 'New Std Fuel',
  24: 'New Std New Energy',
  25: 'Airport',
  26: 'Overseas',
  27: 'Custom',
  29: 'Fake Plate',
  31: 'Unlicensed',
  32: 'HK Single-row',
  33: 'HK Double-row',
  34: 'Macau Single-row',
  35: 'Macau Double-row',
};

export const PLATE_COLORS: Record<number, string> = {
  0: 'Unknown',
  1: 'Blue',
  2: 'Yellow',
  3: 'White',
  4: 'Black',
  5: 'Green',
};

export const CAR_COLORS: Record<number, string> = {
  0: 'White',
  1: 'Silver',
  2: 'Yellow',
  3: 'Pink',
  4: 'Red',
  5: 'Green',
  6: 'Blue',
  7: 'Brown',
  8: 'Black',
  9: 'Gray',
  10: 'Cyan',
  11: 'Orange',
  12: 'Purple',
  255: 'Unknown',
};

export const TRIGGER_TYPES: Record<number, string> = {
  1: 'Automatic',
  2: 'External Input',
  4: 'Software',
  8: 'Virtual Loop',
  64: 'Vehicle Retention',
  65: 'Retention Recovery',
  66: 'U-turn',
  67: 'Vehicle Passage',
  68: 'Tailgating',
  69: 'Vehicle Congestion',
  70: 'Congestion Cleared',
  71: 'Pedestrian Congestion',
  72: 'Ped. Congestion Cleared',
  73: 'Pedestrian Gathering',
  74: 'Ped. Gathering Cleared',
  75: 'Non-motor Retention',
  76: 'Non-motor Ret. Cleared',
  77: 'Gate Normal',
  78: 'Gate Abnormal',
  79: 'Gate Falling',
  80: 'Gate Rising',
  85: 'Plate/Head Mismatch',
  86: 'Plate Recognition',
  89: 'Fence Intrusion',
  90: 'Fence Intrusion (HS)',
};

export const DIRECTION_TYPES: Record<number, string> = {
  0: 'Unknown',
  1: 'Left',
  2: 'Right',
  3: 'Up',
  4: 'Down',
};
