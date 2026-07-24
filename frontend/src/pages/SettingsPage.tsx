import { useState, useEffect, useCallback } from 'react';
import {
  SlidersHorizontal, RefreshCw, Loader2, Check, AlertCircle,
  Globe, Camera, ShieldOff, ShieldCheck, Layers, Columns3, Radio, type LucideIcon,
} from 'lucide-react';
import { getSettings, updateSettings } from '../services/s300Service';
import ChannelsConfig from '../components/ChannelsConfig';
import MqttConnectionPanel from '../components/MqttConnectionPanel';
import { useI18n } from '../contexts/I18nContext';
import type { TKey } from '../i18n/translations';

type FieldType = 'text' | 'number' | 'toggle' | 'select';

interface Field {
  key: string;          // anprc_settings.key_name
  type: FieldType;
  def: string;          // effective default when the key is absent from the DB
  mono?: boolean;       // render value in monospace (URLs, topics, ids)
  hint?: boolean;       // has a set.f.<key>_hint translation
  options?: string[];   // for type 'select' — translated as set.opt.<key>.<option>
}

interface Group {
  titleKey: TKey;
  icon: LucideIcon;
  fields: Field[];
}

const GROUPS: Group[] = [
  {
    titleKey: 'set.group.general',
    icon: Globe,
    fields: [
      { key: 'platform_name', type: 'text', def: 'ANPR + S300 Integrated Platform' },
      { key: 'default_s300_base_url', type: 'text', def: '', mono: true, hint: true },
      { key: 'mqtt_broker_url', type: 'text', def: 'ws://localhost:8083/mqtt', mono: true, hint: true },
    ],
  },
  {
    titleKey: 'set.group.entry',
    icon: Camera,
    fields: [
      { key: 'auto_start_s300', type: 'toggle', def: '0', hint: true },
      { key: 'auto_start_channel', type: 'text', def: 'RJ001', mono: true, hint: true },
      { key: 'dedupe_window_s', type: 'number', def: '10', hint: true },
      { key: 'entry_gate_open', type: 'toggle', def: '0', hint: true },
      { key: 'entry_gate_io', type: 'number', def: '0' },
      { key: 'entry_gate_value', type: 'number', def: '2', hint: true },
      { key: 'entry_gate_pulse_ms', type: 'number', def: '1000' },
      { key: 'entry_green_light_enabled', type: 'toggle', def: '1' },
      { key: 'entry_green_light_ch', type: 'number', def: '1' },
      { key: 'entry_green_light_sec', type: 'number', def: '10' },
      { key: 'entry_voice_enabled', type: 'toggle', def: '1' },
      { key: 'entry_voice_text', type: 'text', def: 'Welcome' },
      { key: 'entry_led_enabled', type: 'toggle', def: '1' },
      { key: 'entry_led_text', type: 'text', def: '', hint: true },
      { key: 'control_card_type', type: 'select', def: '2', options: ['1', '2'], hint: true },
    ],
  },
  {
    titleKey: 'set.group.blacklist',
    icon: ShieldOff,
    fields: [
      { key: 'blacklist_voice_enabled', type: 'toggle', def: '1' },
      { key: 'blacklist_voice_text', type: 'text', def: 'Blacklisted Vehicle. Go To X-RAY', hint: true },
      { key: 'blacklist_led_enabled', type: 'toggle', def: '1' },
      { key: 'blacklist_led_text', type: 'text', def: 'BLACKLIST', hint: true },
    ],
  },
  {
    titleKey: 'set.group.inspection',
    icon: ShieldCheck,
    fields: [
      { key: 's300_auto_leave_enabled', type: 'toggle', def: '1', hint: true },
      { key: 'face_leave_delay_s', type: 'number', def: '3', hint: true },
      { key: 'blocker_open_delay_s', type: 'number', def: '60', hint: true },
      { key: 'blocker_reset_interval_s', type: 'number', def: '7', hint: true },
      { key: 's300_audio_failure_url', type: 'text', def: '', mono: true, hint: true },
      { key: 'videotron_xray_text', type: 'text', def: 'GO TO X-RAY', hint: true },
      { key: 'xray_channel_no', type: 'text', def: 'XRAY01', mono: true, hint: true },
      { key: 'xray_base_url', type: 'text', def: '', mono: true, hint: true },
      { key: 'xray_auto_receipt', type: 'toggle', def: '1', hint: true },
      { key: 'xray_clearance_window_s', type: 'number', def: '3600', hint: true },
    ],
  },
  {
    // Global fallback relay config — lanes without per-channel relay config
    // (Channels section) fall back to these. Moved here from the Road Blocker
    // page so that page is control-only.
    titleKey: 'set.group.blocker',
    icon: Columns3,
    fields: [
      { key: 'blocker_relay_enabled', type: 'toggle', def: '0', hint: true },
      { key: 'blocker_relay_topic', type: 'text', def: 'testsubscribe', mono: true },
      { key: 'blocker_relay_res', type: 'text', def: '', mono: true, hint: true },
      { key: 'blocker_relay_value', type: 'text', def: '210001', mono: true, hint: true },
      { key: 'blocker_relay_open_ch', type: 'text', def: 'A01', mono: true },
      { key: 'blocker_relay_close_ch', type: 'text', def: 'A02', mono: true },
      { key: 'blocker_relay_stop_ch', type: 'text', def: 'A03', mono: true },
    ],
  },
];

const isOn = (v: string) => v === '1' || v === 'true' || v === 'True';

export default function SettingsPage() {
  const { t } = useI18n();
  const [loaded, setLoaded] = useState<Record<string, string>>({});   // as read from the API
  const [values, setValues] = useState<Record<string, string>>({});   // edited form state
  const [section, setSection] = useState('channels');                 // active section tab (Channels first)
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const s = await getSettings();
      const init: Record<string, string> = {};
      for (const g of GROUPS) for (const f of g.fields) init[f.key] = s[f.key] ?? f.def;
      setLoaded(init);
      setValues(init);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const set = (key: string, v: string) => setValues(prev => ({ ...prev, [key]: v }));
  const dirtyKeys = Object.keys(values).filter(k => values[k] !== loaded[k]);

  const save = async () => {
    if (!dirtyKeys.length) return;
    setSaving(true);
    try {
      const patch: Record<string, string> = {};
      for (const k of dirtyKeys) patch[k] = values[k].trim();
      await updateSettings(patch);
      setLoaded(prev => ({ ...prev, ...patch }));
      setValues(prev => ({ ...prev, ...patch }));
      setToast({ msg: t('set.toast.saved', { n: String(dirtyKeys.length) }), ok: true });
    } catch (e) {
      setToast({ msg: t('set.toast.failed', { msg: (e as Error).message }), ok: false });
    } finally {
      setSaving(false);
      setTimeout(() => setToast(null), 4000);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="flex items-center gap-2 mb-1">
        <SlidersHorizontal className="w-5 h-5 text-primary" />
        <h2 className="text-xl font-bold text-text-primary">{t('set.title')}</h2>
        <button onClick={fetchAll} disabled={loading}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-xs bg-surface-light border border-border text-text-secondary hover:text-text-primary rounded-lg transition-colors disabled:opacity-50">
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          {t('common.refresh')}
        </button>
      </div>
      <p className="text-sm text-text-secondary mb-4">{t('set.subtitle')}</p>

      {error && (
        <div className="flex items-center gap-2 bg-danger/10 border border-danger/30 rounded-lg p-2.5 text-xs text-danger mb-4">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {/* Section tabs — one section shown at a time. Channels first: per-lane
          config is the primary thing reconfigured, everything else follows. */}
      <div className="flex flex-wrap gap-1 bg-surface-dark p-1 rounded-lg mb-4 max-w-3xl">
        <button onClick={() => setSection('channels')}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition ${
            section === 'channels' ? 'bg-primary text-white' : 'text-text-secondary hover:text-text-primary'
          }`}>
          <Layers className="w-3.5 h-3.5" />
          {t('set.group.channels')}
        </button>
        <button onClick={() => setSection('mqtt')}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition ${
            section === 'mqtt' ? 'bg-primary text-white' : 'text-text-secondary hover:text-text-primary'
          }`}>
          <Radio className="w-3.5 h-3.5" />
          {t('mqttcfg.title')}
        </button>
        {GROUPS.map(g => {
          const Icon = g.icon;
          const groupDirty = g.fields.some(f => (values[f.key] ?? f.def) !== (loaded[f.key] ?? f.def));
          return (
            <button key={g.titleKey} onClick={() => setSection(g.titleKey)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition ${
                section === g.titleKey ? 'bg-primary text-white' : 'text-text-secondary hover:text-text-primary'
              }`}>
              <Icon className="w-3.5 h-3.5" />
              {t(g.titleKey)}
              {groupDirty && <span className={`w-1.5 h-1.5 rounded-full ${section === g.titleKey ? 'bg-white' : 'bg-primary'}`} />}
            </button>
          );
        })}
      </div>

      {section === 'channels' && (
        <div className="max-w-4xl">
          <ChannelsConfig />
        </div>
      )}

      {section === 'mqtt' && <MqttConnectionPanel />}

      <div className="max-w-2xl">
        {GROUPS.filter(g => g.titleKey === section).map(g => {
          const Icon = g.icon;
          return (
            <div key={g.titleKey} className="bg-surface border border-border rounded-xl p-5">
              <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2 mb-4">
                <Icon className="w-4 h-4 text-primary" /> {t(g.titleKey)}
              </h3>
              <div className="space-y-3.5">
                {g.fields.map(f => {
                  const v = values[f.key] ?? f.def;
                  const dirty = v !== (loaded[f.key] ?? f.def);
                  return (
                    <div key={f.key}>
                      {f.type === 'toggle' ? (
                        <label className="flex items-center gap-3 cursor-pointer">
                          <input type="checkbox" checked={isOn(v)}
                            onChange={e => set(f.key, e.target.checked ? '1' : '0')}
                            className="w-4 h-4" />
                          <span className={`text-sm ${dirty ? 'text-primary' : 'text-text-primary'}`}>
                            {t(`set.f.${f.key}` as TKey)}
                          </span>
                          {dirty && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-primary" title="unsaved" />}
                        </label>
                      ) : (
                        <>
                          <div className="flex items-baseline gap-1.5 mb-1">
                            <label className={`text-xs ${dirty ? 'text-primary' : 'text-text-secondary'}`}>
                              {t(`set.f.${f.key}` as TKey)}
                            </label>
                            {dirty && <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" title="unsaved" />}
                          </div>
                          {f.type === 'select' ? (
                            <select value={v} onChange={e => set(f.key, e.target.value)}
                              className="w-full px-3 py-2 bg-surface-dark border border-border rounded-md text-sm text-text-primary">
                              {(f.options || []).map(o => (
                                <option key={o} value={o}>{t(`set.opt.${f.key}.${o}` as TKey)}</option>
                              ))}
                            </select>
                          ) : (
                            <input
                              type={f.type === 'number' ? 'number' : 'text'}
                              value={v}
                              onChange={e => set(f.key, e.target.value)}
                              className={`w-full px-3 py-2 bg-surface-dark border rounded-md text-sm text-text-primary ${
                                f.mono ? 'font-mono' : ''
                              } ${dirty ? 'border-primary/60' : 'border-border'}`}
                            />
                          )}
                        </>
                      )}
                      {f.hint && (
                        <p className="text-[10px] text-text-secondary mt-1">{t(`set.f.${f.key}_hint` as TKey)}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Sticky save bar — saves dirty fields across ALL sections. Hidden on the
          Channels section, which saves independently via its own modal. */}
      {section !== 'channels' && (
        <div className="sticky bottom-0 mt-4 max-w-2xl">
          <div className="flex items-center gap-3 bg-surface border border-border rounded-xl px-4 py-3 shadow-lg">
            <span className="text-xs text-text-secondary">
              {dirtyKeys.length
                ? t('set.dirty', { n: String(dirtyKeys.length) })
                : t('set.clean')}
            </span>
            {toast && (
              <span className={`text-xs ${toast.ok ? 'text-success' : 'text-danger'}`}>{toast.msg}</span>
            )}
            <button onClick={save} disabled={saving || !dirtyKeys.length}
              className="ml-auto flex items-center gap-2 px-4 py-2 bg-primary text-white text-sm rounded-md hover:bg-primary/90 disabled:opacity-50">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              {t('set.save')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
