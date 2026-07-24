import { createContext, useContext, useState, useCallback, useRef, useEffect, type ReactNode } from 'react';
import { mqttService } from '../services/mqttService';
import type {
  MqttConfig,
  ConnectionStatus,
  RecognitionResult,
  HeartbeatData,
  IoInputEvent,
  BarrierGateStatus,
  SerialData,
  MessageLogEntry,
} from '../types/mqtt';
import { generateMessageId, decodeBase64Utf8 } from '../utils/helpers';

interface MqttContextType {
  config: MqttConfig;
  setConfig: (config: MqttConfig) => void;
  status: ConnectionStatus;
  connect: () => Promise<void>;
  disconnect: () => void;
  deviceSn: string;
  setDeviceSn: (sn: string) => void;
  recognitions: RecognitionResult[];
  heartbeats: Map<string, HeartbeatData>;
  ioEvents: IoInputEvent[];
  gateStatus: BarrierGateStatus | null;
  serialDataLog: SerialData[];
  messageLog: MessageLogEntry[];
  publishMessage: (name: string, payload: unknown) => void;
  clearRecognitions: () => void;
  clearMessageLog: () => void;
}

const MqttContext = createContext<MqttContextType | null>(null);

const DEFAULT_CONFIG: MqttConfig = {
  brokerUrl: '127.0.0.1',
  port: 8083,
  // Broker now runs with allow_anonymous false, so default to the configured creds.
  username: 'admin',
  password: 'admin123',
  clientId: `anpr_dashboard_${Date.now()}`,
  useSSL: false,
};

export function MqttProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<MqttConfig>(() => {
    const saved = localStorage.getItem('mqtt_config');
    if (!saved) return DEFAULT_CONFIG;
    try {
      const parsed = JSON.parse(saved) as MqttConfig;
      // One-time migration: replace the legacy factory default that no real broker uses.
      if (parsed.brokerUrl === '192.168.1.100') {
        return { ...parsed, brokerUrl: DEFAULT_CONFIG.brokerUrl, username: DEFAULT_CONFIG.username };
      }
      return parsed;
    } catch {
      return DEFAULT_CONFIG;
    }
  });
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [deviceSn, setDeviceSn] = useState<string>(() => {
    return localStorage.getItem('device_sn') || '';
  });
  const [recognitions, setRecognitions] = useState<RecognitionResult[]>([]);
  const [heartbeats, setHeartbeats] = useState<Map<string, HeartbeatData>>(new Map());
  const [ioEvents, setIoEvents] = useState<IoInputEvent[]>([]);
  const [gateStatus, setGateStatus] = useState<BarrierGateStatus | null>(null);
  const [serialDataLog, setSerialDataLog] = useState<SerialData[]>([]);
  const [messageLog, setMessageLog] = useState<MessageLogEntry[]>([]);
  const unsubscribers = useRef<(() => void)[]>([]);

  useEffect(() => {
    localStorage.setItem('mqtt_config', JSON.stringify(config));
  }, [config]);

  useEffect(() => {
    localStorage.setItem('device_sn', deviceSn);
  }, [deviceSn]);

  useEffect(() => {
    const unsub = mqttService.onStatusChange((s) => {
      setStatus(s as ConnectionStatus);
      if (s === 'connected') {
        mqttService.resubscribeAll();
      }
    });
    return unsub;
  }, []);

  const addLogEntry = useCallback((direction: 'sent' | 'received', topic: string, payload: string, name: string) => {
    setMessageLog((prev) => {
      const entry: MessageLogEntry = {
        id: generateMessageId(),
        direction,
        topic,
        payload,
        timestamp: new Date(),
        name,
      };
      const next = [entry, ...prev];
      return next.slice(0, 500);
    });
  }, []);

  const setupSubscriptions = useCallback(() => {
    unsubscribers.current.forEach((u) => u());
    unsubscribers.current = [];

    // Subscribe with a `+` wildcard in the SN segment so the live feed works for
    // ANY camera without first configuring its serial — mirroring the worker
    // (which subscribes `device/+/...` and `+/device/...`). Previously these
    // were pinned to a specific deviceSn, so when no SN was configured nothing
    // was ever subscribed and the page stayed empty forever (the SN auto-detect
    // below could never fire because its handler wasn't subscribed). Both topic
    // layouts are covered. The device SN is captured from the first ivs_result
    // (used only for publishing down-commands).
    const up = (name: string, handler: (topic: string, msg: string) => void) => [
      mqttService.subscribe(`device/+/message/up/${name}`, handler),
      mqttService.subscribe(`+/device/message/up/${name}`, handler),
    ];
    const downReply = (name: string, handler: (topic: string, msg: string) => void) => [
      mqttService.subscribe(`device/+/message/down/${name}/reply`, handler),
      mqttService.subscribe(`+/device/message/down/${name}/reply`, handler),
    ];

    // Recognition results
    const uIvs = up('ivs_result', (topic, msg) => {
      addLogEntry('received', topic, msg, 'ivs_result');
      try {
        const data = JSON.parse(msg);
        const plate = data.payload?.AlarmInfoPlate;
        if (!plate) return;
        const result = plate.result?.PlateResult;
        if (!result) return;

        const rec: RecognitionResult = {
          id: data.id || generateMessageId(),
          sn: data.sn,
          timestamp: data.timestamp,
          channel: plate.channel,
          deviceName: decodeBase64Utf8(plate.deviceName || ''),
          ipaddr: plate.ipaddr,
          serialno: plate.serialno,
          license: result.license || '',
          licensePlain: decodeBase64Utf8(result.license || ''),
          plateType: result.type,
          plateColor: result.colorType,
          confidence: result.confidence,
          carColor: result.carColor,
          direction: result.direction,
          triggerType: result.triggerType,
          imagePath: result.imagePath || '',
          imageFragmentPath: result.imageFragmentPath || '',
          beginTime: result.begin_time,
          endTime: result.end_time,
          uniqueId: result.unique_id || '',
          isFakePlate: result.is_fake_plate,
          isEncrypted: result.is_encrypted,
        };
        setRecognitions((prev) => [rec, ...prev].slice(0, 200));
        // Capture the device SN from the first recognition (used for publishing
        // down-commands). Set once so we don't churn state on every message.
        if (data.sn) setDeviceSn((cur) => cur || data.sn);
      } catch { /* ignore parse errors */ }
    });

    // Quick recognition results
    const uQuick = up('quick_ivs_result', (topic, msg) => {
      addLogEntry('received', topic, msg, 'quick_ivs_result');
    });

    // Heartbeat (subscribe $/device/..., device/..., and SN-first formats)
    const heartbeatHandler = (topic: string, msg: string) => {
      addLogEntry('received', topic, msg, 'keep_alive');
      try {
        const data = JSON.parse(msg);
        setHeartbeats((prev) => {
          const next = new Map(prev);
          next.set(data.sn, {
            sn: data.sn,
            timestamp: data.payload?.body?.timestamp || data.timestamp,
            lastSeen: new Date(),
          });
          return next;
        });
      } catch { /* ignore */ }
    };
    const uHb = [
      mqttService.subscribe(`$/device/+/message/up/keep_alive`, heartbeatHandler),
      ...up('keep_alive', heartbeatHandler),
    ];

    // IO Input
    const uIo = up('gpio_in', (topic, msg) => {
      addLogEntry('received', topic, msg, 'gpio_in');
      try {
        const data = JSON.parse(msg);
        const evt = data.payload?.body?.AlarmGioIn;
        if (!evt) return;
        setIoEvents((prev) => [{
          sn: data.sn,
          deviceName: evt.deviceName,
          ipaddr: evt.ipaddr,
          source: evt.result?.TriggerResult?.source ?? 0,
          value: evt.result?.TriggerResult?.value ?? 0,
          timestamp: data.timestamp,
        }, ...prev].slice(0, 100));
      } catch { /* ignore */ }
    });

    // Barrier Gate Status
    const uGate = up('barr_gate_status', (topic, msg) => {
      addLogEntry('received', topic, msg, 'barr_gate_status');
      try {
        const data = JSON.parse(msg);
        const body = data.payload?.body;
        if (!body) return;
        setGateStatus({
          sn: data.sn,
          gateCtrlId: body.gate_ctrl_id,
          gateStatus: body.gate_status,
          connectStatus: body.connect_status,
          enable: body.enable,
          timestamp: data.timestamp,
        });
      } catch { /* ignore */ }
    });

    // Serial Data
    const uSerial = up('serial_data', (topic, msg) => {
      addLogEntry('received', topic, msg, 'serial_data');
      try {
        const data = JSON.parse(msg);
        const sd = data.payload?.body?.SerialData;
        if (!sd) return;
        setSerialDataLog((prev) => [{
          sn: data.sn,
          data: sd.data,
          dataLen: sd.dataLen,
          serialChannel: sd.serialChannel,
          timestamp: data.timestamp,
        }, ...prev].slice(0, 100));
      } catch { /* ignore */ }
    });

    // Snapshot
    const uSnap = up('snapshot', (topic, msg) => {
      addLogEntry('received', topic, msg, 'snapshot');
    });

    // Offline records
    const uOffline = up('offline_record', (topic, msg) => {
      addLogEntry('received', topic, msg, 'offline_record');
    });

    // Reply topics for commands
    const replyTopics = [
      'ivs_trigger', 'gpio_out', 'serial_data', 'snapshot', 'set_time',
      'get_device_timestamp', 'white_list_operator', 'set_cloud_ctrl',
      'io_lock', 'get_io_lock_status', 'get_io_status', 'lcd_cfg',
      'tts_voice', 'set_oss_cfg', 'reboot_dev', 'device_set',
      'check_offline_record', 'set_plate_encryption_cfg',
    ];
    const replyUnsubs = replyTopics.flatMap((name) =>
      downReply(name, (topic, msg) => {
        addLogEntry('received', topic, msg, `${name}/reply`);
      })
    );

    unsubscribers.current = [
      ...uIvs, ...uQuick, ...uHb, ...uIo, ...uGate,
      ...uSerial, ...uSnap, ...uOffline, ...replyUnsubs,
    ];
  }, [addLogEntry]);

  const connect = useCallback(async () => {
    await mqttService.connect(config);
    setupSubscriptions();
  }, [config, setupSubscriptions]);

  const disconnect = useCallback(() => {
    unsubscribers.current.forEach((u) => u());
    unsubscribers.current = [];
    mqttService.disconnect();
  }, []);

  // Auto-connect to the broker on first mount. mqtt.js handles auto-reconnect
  // (reconnectPeriod 5s) for subsequent drops, so we only need to fire once.
  // User can still hit Disconnect on the Connection page if they want manual control.
  const autoConnectedRef = useRef(false);
  useEffect(() => {
    if (autoConnectedRef.current) return;
    autoConnectedRef.current = true;
    mqttService.connect(config).then(() => {
      setupSubscriptions();
    }).catch(() => {
      // Failure leaves status='error'; mqtt.js will keep retrying.
    });
    // Intentionally empty deps — auto-connect runs exactly once per page load.
    // Subsequent config edits use the manual Connect button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ensure subscriptions exist once connected (covers the case where the
  // socket connected before/independently of the auto-connect effect, or was
  // re-established). Subscriptions are SN-agnostic wildcards, so this does not
  // need to re-run when deviceSn changes.
  useEffect(() => {
    if (status === 'connected' && unsubscribers.current.length === 0) {
      setupSubscriptions();
    }
  }, [status, setupSubscriptions]);

  const publishMessage = useCallback((name: string, payload: unknown) => {
    if (!deviceSn) return;
    const msg = JSON.stringify(payload);
    // Publish to both topic layouts; the camera ignores the one it doesn't use.
    const stdTopic = `device/${deviceSn}/message/down/${name}`;
    const snFirstTopic = `${deviceSn}/device/message/down/${name}`;
    mqttService.publish(stdTopic, msg);
    mqttService.publish(snFirstTopic, msg);
    addLogEntry('sent', stdTopic, msg, name);
  }, [deviceSn, addLogEntry]);

  const clearRecognitions = useCallback(() => setRecognitions([]), []);
  const clearMessageLog = useCallback(() => setMessageLog([]), []);

  return (
    <MqttContext.Provider value={{
      config, setConfig,
      status, connect, disconnect,
      deviceSn, setDeviceSn,
      recognitions, heartbeats,
      ioEvents, gateStatus, serialDataLog,
      messageLog, publishMessage,
      clearRecognitions, clearMessageLog,
    }}>
      {children}
    </MqttContext.Provider>
  );
}

export function useMqtt() {
  const ctx = useContext(MqttContext);
  if (!ctx) throw new Error('useMqtt must be used within MqttProvider');
  return ctx;
}
