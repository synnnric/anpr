import { useState } from 'react';
import { Camera, Trash2, Search, AlertTriangle, CheckCircle2, ChevronDown, ChevronUp } from 'lucide-react';
import { useMqtt } from '../contexts/MqttContext';
import {
  PLATE_TYPES, PLATE_COLORS, CAR_COLORS, TRIGGER_TYPES, DIRECTION_TYPES,
} from '../types/mqtt';
import type { RecognitionResult } from '../types/mqtt';
import { formatTimestamp } from '../utils/helpers';
import { useI18n } from '../contexts/I18nContext';

export default function RecognitionPage() {
  const { t } = useI18n();
  const { recognitions, clearRecognitions, status } = useMqtt();
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const filtered = recognitions.filter((r) => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      r.licensePlain.toLowerCase().includes(s) ||
      r.serialno.toLowerCase().includes(s) ||
      r.ipaddr.includes(s)
    );
  });

  return (
    <div className="p-6 h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-bold text-text-primary">{t('recognition.title')}</h2>
          <p className="text-sm text-text-secondary">
            {t('recognition.subtitle')}
            {status !== 'connected' && <span className="text-danger ml-2">{t('recognition.disconnected')}</span>}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-secondary" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('recognition.search_placeholder')}
              className="bg-surface border border-border rounded-lg pl-9 pr-3 py-2 text-sm text-text-primary placeholder-text-secondary/50 focus:outline-none focus:border-primary-light w-56"
            />
          </div>
          <button
            onClick={clearRecognitions}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-text-secondary hover:text-danger border border-border rounded-lg hover:border-danger/50 transition-colors"
          >
            <Trash2 className="w-4 h-4" />
            {t('recognition.clear')}
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <Camera className="w-16 h-16 text-surface-light mx-auto mb-4" />
            <p className="text-text-secondary text-sm">{t('recognition.empty.title')}</p>
            <p className="text-text-secondary text-xs mt-1">
              {t('recognition.empty.desc')}
            </p>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto space-y-2">
          {filtered.map((rec) => (
            <RecognitionCard
              key={rec.id + rec.timestamp}
              rec={rec}
              expanded={expandedId === rec.id}
              onToggle={() => setExpandedId(expandedId === rec.id ? null : rec.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RecognitionCard({ rec, expanded, onToggle }: { rec: RecognitionResult; expanded: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  const plateColor = getPlateColorClass(rec.plateColor);

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden hover:border-primary-light/30 transition-colors">
      <div className="flex items-center gap-4 p-4 cursor-pointer" onClick={onToggle}>
        <div className={`px-4 py-2 rounded-lg font-mono font-bold text-lg min-w-[160px] text-center ${plateColor}`}>
          {rec.licensePlain || '---'}
        </div>

        <div className="flex-1 grid grid-cols-4 gap-4 text-sm">
          <div>
            <p className="text-[10px] text-text-secondary uppercase tracking-wider">{t('recognition.col.confidence')}</p>
            <div className="flex items-center gap-1.5">
              {rec.confidence >= 80 ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-success" />
              ) : (
                <AlertTriangle className="w-3.5 h-3.5 text-warning" />
              )}
              <span className={`font-semibold ${rec.confidence >= 80 ? 'text-success' : 'text-warning'}`}>
                {rec.confidence}%
              </span>
            </div>
          </div>
          <div>
            <p className="text-[10px] text-text-secondary uppercase tracking-wider">{t('recognition.col.vehicle_color')}</p>
            <p className="text-text-primary font-medium">{CAR_COLORS[rec.carColor] ?? t('recognition.detail.unknown')}</p>
          </div>
          <div>
            <p className="text-[10px] text-text-secondary uppercase tracking-wider">{t('recognition.col.trigger')}</p>
            <p className="text-text-primary font-medium">{TRIGGER_TYPES[rec.triggerType] ?? t('recognition.detail.type_n', { n: rec.triggerType })}</p>
          </div>
          <div>
            <p className="text-[10px] text-text-secondary uppercase tracking-wider">{t('recognition.col.time')}</p>
            <p className="text-text-primary font-medium text-xs">{formatTimestamp(rec.timestamp)}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {rec.isFakePlate === 1 && (
            <span className="px-2 py-0.5 bg-danger/20 text-danger text-[10px] font-bold rounded-full">{t('recognition.badge.fake')}</span>
          )}
          {rec.isEncrypted !== 0 && (
            <span className="px-2 py-0.5 bg-warning/20 text-warning text-[10px] font-bold rounded-full">{t('recognition.badge.enc')}</span>
          )}
          {expanded ? <ChevronUp className="w-4 h-4 text-text-secondary" /> : <ChevronDown className="w-4 h-4 text-text-secondary" />}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border p-4 bg-surface-dark">
          <div className="grid grid-cols-3 gap-4 text-sm">
            <Detail label={t('recognition.detail.plate_type')} value={PLATE_TYPES[rec.plateType] ?? t('recognition.detail.type_n', { n: rec.plateType })} />
            <Detail label={t('recognition.detail.plate_color')} value={PLATE_COLORS[rec.plateColor] ?? t('recognition.detail.color_n', { n: rec.plateColor })} />
            <Detail label={t('recognition.detail.direction')} value={DIRECTION_TYPES[rec.direction] ?? t('recognition.detail.unknown')} />
            <Detail label={t('recognition.detail.channel')} value={String(rec.channel)} />
            <Detail label={t('recognition.detail.device_ip')} value={rec.ipaddr} />
            <Detail label={t('recognition.detail.serial')} value={rec.serialno} />
            <Detail label={t('recognition.detail.device_name')} value={rec.deviceName} />
            <Detail label={t('recognition.detail.begin_time')} value={formatTimestamp(rec.beginTime)} />
            <Detail label={t('recognition.detail.end_time')} value={formatTimestamp(rec.endTime)} />
            <Detail label={t('recognition.detail.unique_id')} value={rec.uniqueId || 'N/A'} />
            <Detail label={t('recognition.detail.encrypted')} value={rec.isEncrypted === 0 ? t('common.no') : t('recognition.detail.yes_type', { n: rec.isEncrypted })} />
            <Detail label={t('recognition.detail.fake_plate')} value={rec.isFakePlate === 0 ? t('common.no') : t('common.yes')} />
          </div>
        </div>
      )}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] text-text-secondary uppercase tracking-wider">{label}</p>
      <p className="text-text-primary font-mono text-xs truncate" title={value}>{value}</p>
    </div>
  );
}

function getPlateColorClass(colorType: number): string {
  switch (colorType) {
    case 1: return 'bg-blue-600 text-white';
    case 2: return 'bg-yellow-500 text-black';
    case 3: return 'bg-white text-black border border-gray-300';
    case 4: return 'bg-black text-white';
    case 5: return 'bg-green-600 text-white';
    default: return 'bg-surface-light text-text-primary';
  }
}
