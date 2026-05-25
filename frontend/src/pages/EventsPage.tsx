import { Radio, Zap, HardDrive, DoorOpen, Clock } from 'lucide-react';
import { useMqtt } from '../contexts/MqttContext';
import { formatTimestamp, timeAgo } from '../utils/helpers';
import { decodeBase64Utf8 } from '../utils/helpers';
import { useEffect, useState } from 'react';
import { useI18n } from '../contexts/I18nContext';

export default function EventsPage() {
  const { t } = useI18n();
  const { heartbeats, ioEvents, gateStatus, serialDataLog, status } = useMqtt();
  const [, setTick] = useState(0);

  // Force re-render every 5 seconds for "time ago" updates
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="p-6 overflow-y-auto">
      <h2 className="text-xl font-bold text-text-primary mb-1">{t('events.title')}</h2>
      <p className="text-sm text-text-secondary mb-6">
        {t('events.subtitle')}
        {status !== 'connected' && <span className="text-danger ml-2">{t('events.disconnected')}</span>}
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Heartbeat Monitor */}
        <div className="bg-surface border border-border rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <Radio className="w-4 h-4 text-success" />
            <h3 className="text-sm font-semibold text-text-primary">{t('events.heartbeats.title')}</h3>
            <span className="ml-auto text-[10px] text-text-secondary bg-surface-light px-2 py-0.5 rounded-full">
              {t('events.heartbeats.count', { n: heartbeats.size })}
            </span>
          </div>
          {heartbeats.size === 0 ? (
            <p className="text-xs text-text-secondary text-center py-6">{t('events.heartbeats.empty')}</p>
          ) : (
            <div className="space-y-2">
              {Array.from(heartbeats.values()).map((hb) => {
                const isRecent = (Date.now() - hb.lastSeen.getTime()) < 60000;
                return (
                  <div key={hb.sn} className="flex items-center gap-3 p-3 bg-surface-dark rounded-lg">
                    <div className={`w-2.5 h-2.5 rounded-full ${isRecent ? 'bg-success animate-pulse' : 'bg-warning'}`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-mono text-text-primary truncate">{hb.sn}</p>
                      <p className="text-[10px] text-text-secondary">{timeAgo(hb.lastSeen)}</p>
                    </div>
                    <Clock className="w-3.5 h-3.5 text-text-secondary shrink-0" />
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Barrier Gate Status */}
        <div className="bg-surface border border-border rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <DoorOpen className="w-4 h-4 text-primary-light" />
            <h3 className="text-sm font-semibold text-text-primary">{t('events.gate.title')}</h3>
          </div>
          {!gateStatus ? (
            <p className="text-xs text-text-secondary text-center py-6">{t('events.gate.empty')}</p>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <StatusItem label={t('events.gate.status')} value={
                  gateStatus.gateStatus === 0 ? t('events.gate.closed') :
                  gateStatus.gateStatus === 1 ? t('events.gate.opened') : t('events.gate.intermediate')
                } color={gateStatus.gateStatus === 1 ? 'text-success' : gateStatus.gateStatus === 0 ? 'text-text-primary' : 'text-warning'} />
                <StatusItem label={t('events.gate.connection')} value={
                  gateStatus.connectStatus === 1 ? t('common.connected') : t('common.disconnected')
                } color={gateStatus.connectStatus === 1 ? 'text-success' : 'text-danger'} />
                <StatusItem label={t('events.gate.function')} value={
                  gateStatus.enable === 1 ? t('whitelist.enabled') : t('whitelist.disabled')
                } color={gateStatus.enable === 1 ? 'text-success' : 'text-text-secondary'} />
                <StatusItem label={t('events.gate.controller_id')} value={String(gateStatus.gateCtrlId)} color="text-text-primary" />
              </div>
              <p className="text-[10px] text-text-secondary">
                {t('events.gate.last_updated', { ts: formatTimestamp(gateStatus.timestamp) })}
              </p>
            </div>
          )}
        </div>

        {/* IO Input Events */}
        <div className="bg-surface border border-border rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <Zap className="w-4 h-4 text-accent" />
            <h3 className="text-sm font-semibold text-text-primary">{t('events.io.title')}</h3>
            <span className="ml-auto text-[10px] text-text-secondary bg-surface-light px-2 py-0.5 rounded-full">
              {t('events.io.count', { n: ioEvents.length })}
            </span>
          </div>
          {ioEvents.length === 0 ? (
            <p className="text-xs text-text-secondary text-center py-6">{t('events.io.empty')}</p>
          ) : (
            <div className="space-y-1.5 max-h-[300px] overflow-y-auto">
              {ioEvents.slice(0, 20).map((evt, idx) => (
                <div key={idx} className="flex items-center gap-3 p-2.5 bg-surface-dark rounded-lg text-xs">
                  <div className={`w-2 h-2 rounded-full ${
                    evt.value === 1 ? 'bg-success' : evt.value === 0 ? 'bg-text-secondary' : 'bg-accent'
                  }`} />
                  <span className="text-text-primary font-mono">IO{evt.source}</span>
                  <span className={`font-medium ${
                    evt.value === 1 ? 'text-success' : evt.value === 0 ? 'text-text-secondary' : 'text-accent'
                  }`}>
                    {evt.value === 0 ? t('events.io.off') : evt.value === 1 ? t('events.io.on') : t('events.io.pulse')}
                  </span>
                  <span className="ml-auto text-text-secondary text-[10px]">{formatTimestamp(evt.timestamp)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Serial Data */}
        <div className="bg-surface border border-border rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <HardDrive className="w-4 h-4 text-primary-light" />
            <h3 className="text-sm font-semibold text-text-primary">{t('events.serial.title')}</h3>
            <span className="ml-auto text-[10px] text-text-secondary bg-surface-light px-2 py-0.5 rounded-full">
              {t('events.serial.count', { n: serialDataLog.length })}
            </span>
          </div>
          {serialDataLog.length === 0 ? (
            <p className="text-xs text-text-secondary text-center py-6">{t('events.serial.empty')}</p>
          ) : (
            <div className="space-y-1.5 max-h-[300px] overflow-y-auto">
              {serialDataLog.slice(0, 20).map((sd, idx) => (
                <div key={idx} className="p-2.5 bg-surface-dark rounded-lg text-xs">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-primary-light font-medium">CH{sd.serialChannel}</span>
                    <span className="text-text-secondary">{t('events.serial.bytes', { n: sd.dataLen })}</span>
                    <span className="ml-auto text-text-secondary text-[10px]">{formatTimestamp(sd.timestamp)}</span>
                  </div>
                  <p className="font-mono text-text-primary text-[11px] break-all">
                    {decodeBase64Utf8(sd.data)}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusItem({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="p-3 bg-surface-dark rounded-lg">
      <p className="text-[10px] text-text-secondary uppercase tracking-wider mb-1">{label}</p>
      <p className={`text-sm font-semibold ${color}`}>{value}</p>
    </div>
  );
}
