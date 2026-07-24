import { useState } from 'react';
import { Radio, Wifi, WifiOff, Loader2, Save, RefreshCw, Eye, EyeOff, PlugZap, CheckCircle, XCircle } from 'lucide-react';
import { useMqtt } from '../contexts/MqttContext';
import { mqttService } from '../services/mqttService';
import type { MqttConfig } from '../types/mqtt';
import { useI18n } from '../contexts/I18nContext';

/**
 * MQTT broker connection editor (browser/WebSocket link). Host + port + creds +
 * client id + SSL, edited together and applied with one "Save & Reconnect".
 * Config lives per-browser in localStorage (MqttContext); this is the only UI
 * for it. NOTE: the browser speaks MQTT-over-WebSocket, so the port must be the
 * broker's WS/WSS listener (not the raw 1883/8171 TCP port the worker uses).
 */
export default function MqttConnectionPanel() {
  const { t } = useI18n();
  const { config, setConfig, status, connect, disconnect, deviceSn, setDeviceSn } = useMqtt();
  const [draft, setDraft] = useState<MqttConfig>(config);
  const [sn, setSn] = useState(deviceSn);
  const [busy, setBusy] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const dirty = JSON.stringify(draft) !== JSON.stringify(config) || sn !== deviceSn;
  const set = <K extends keyof MqttConfig>(k: K, v: MqttConfig[K]) => {
    setDraft(d => ({ ...d, [k]: v }));
    setTestResult(null);   // settings changed — a previous test result is stale
  };

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      await mqttService.testConnect(draft);   // throwaway probe; won't touch the live link
      setTestResult({ ok: true, text: t('mqttcfg.test_ok') });
    } catch (e) {
      setTestResult({ ok: false, text: t('mqttcfg.test_fail', { msg: e instanceof Error ? e.message : String(e) }) });
    } finally {
      setTesting(false);
    }
  };

  const saveReconnect = async () => {
    setBusy(true);
    setMsg(null);
    try {
      setConfig(draft);          // persists to localStorage (MqttContext effect)
      setDeviceSn(sn.trim());
      disconnect();
      await connect();
      setMsg({ ok: true, text: t('mqttcfg.reconnected') });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : t('mqttcfg.failed') });
    } finally {
      setBusy(false);
      setTimeout(() => setMsg(null), 5000);
    }
  };

  const statusPill =
    status === 'connected' ? { cls: 'bg-success/15 text-success border-success/30', Icon: Wifi, label: t('common.connected') }
    : status === 'connecting' ? { cls: 'bg-warning/15 text-warning border-warning/30', Icon: Loader2, label: t('common.connecting') }
    : { cls: 'bg-danger/15 text-danger border-danger/30', Icon: WifiOff, label: t('common.disconnected') };

  return (
    <div className="bg-surface border border-border rounded-xl p-5 max-w-2xl">
      <div className="flex items-center gap-2 mb-1">
        <Radio className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-semibold text-text-primary">{t('mqttcfg.title')}</h3>
        <span className={`ml-auto inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border ${statusPill.cls}`}>
          <statusPill.Icon className={`w-3 h-3 ${status === 'connecting' ? 'animate-spin' : ''}`} />
          {statusPill.label}
        </span>
      </div>
      <p className="text-[11px] text-text-secondary mb-4">{t('mqttcfg.hint')}</p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="sm:col-span-2">
          <label className="block text-xs text-text-secondary mb-1">{t('mqttcfg.host')}</label>
          <input value={draft.brokerUrl} onChange={e => set('brokerUrl', e.target.value.trim())}
            placeholder="10.10.33.143" spellCheck={false}
            className="w-full px-3 py-2 bg-surface-dark border border-border rounded-md text-sm font-mono text-text-primary" />
        </div>
        <div>
          <label className="block text-xs text-text-secondary mb-1">{t('mqttcfg.port')}</label>
          <input type="number" value={draft.port} onChange={e => set('port', Number(e.target.value) || 0)}
            placeholder="8083"
            className="w-full px-3 py-2 bg-surface-dark border border-border rounded-md text-sm font-mono text-text-primary" />
        </div>

        <div>
          <label className="block text-xs text-text-secondary mb-1">{t('mqttcfg.username')}</label>
          <input value={draft.username} onChange={e => set('username', e.target.value)}
            placeholder="sigap" spellCheck={false}
            className="w-full px-3 py-2 bg-surface-dark border border-border rounded-md text-sm font-mono text-text-primary" />
        </div>
        <div>
          <label className="block text-xs text-text-secondary mb-1">{t('mqttcfg.password')}</label>
          <div className="relative">
            <input type={showPw ? 'text' : 'password'} value={draft.password} onChange={e => set('password', e.target.value)}
              autoComplete="new-password"
              className="w-full px-3 py-2 pr-9 bg-surface-dark border border-border rounded-md text-sm font-mono text-text-primary" />
            <button type="button" onClick={() => setShowPw(v => !v)}
              title={showPw ? t('mqttcfg.pw_hide') : t('mqttcfg.pw_show')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-secondary hover:text-text-primary">
              {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>
        <div>
          <label className="block text-xs text-text-secondary mb-1">{t('mqttcfg.client_id')}</label>
          <input value={draft.clientId} onChange={e => set('clientId', e.target.value.trim())}
            placeholder="anpr_dashboard" spellCheck={false}
            className="w-full px-3 py-2 bg-surface-dark border border-border rounded-md text-sm font-mono text-text-primary" />
        </div>

        <div className="sm:col-span-2">
          <label className="block text-xs text-text-secondary mb-1">{t('mqttcfg.device_sn')}</label>
          <input value={sn} onChange={e => setSn(e.target.value)}
            placeholder={t('mqttcfg.device_sn_ph')} spellCheck={false}
            className="w-full px-3 py-2 bg-surface-dark border border-border rounded-md text-sm font-mono text-text-primary" />
        </div>
        <label className="flex items-center gap-2 text-sm text-text-primary self-end pb-2">
          <input type="checkbox" checked={draft.useSSL} onChange={e => set('useSSL', e.target.checked)} />
          {t('mqttcfg.ssl')}
        </label>
      </div>

      <p className="mt-3 text-[10px] text-text-secondary">
        {t('mqttcfg.url_preview')}: <span className="font-mono text-text-primary">
          {draft.useSSL ? 'wss' : 'ws'}://{draft.brokerUrl || '?'}:{draft.port || '?'}/mqtt
        </span>
      </p>

      {(testResult || msg) && (
        <div className={`mt-3 px-3 py-2 rounded-lg text-xs flex items-center gap-1.5 ${
          (testResult ?? msg)!.ok ? 'bg-success/10 border border-success/30 text-success' : 'bg-danger/10 border border-danger/30 text-danger'
        }`}>
          {(testResult ?? msg)!.ok ? <CheckCircle className="w-3.5 h-3.5 shrink-0" /> : <XCircle className="w-3.5 h-3.5 shrink-0" />}
          {(testResult ?? msg)!.text}
        </div>
      )}

      <div className="flex items-center gap-2 mt-4">
        <button onClick={testConnection} disabled={testing || busy || !draft.brokerUrl || !draft.port}
          className="flex items-center gap-1.5 px-3 py-2 border border-primary/50 text-primary hover:bg-primary/10 text-sm rounded-lg disabled:opacity-50">
          {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlugZap className="w-4 h-4" />}
          {t('mqttcfg.test')}
        </button>
        <button onClick={saveReconnect} disabled={busy}
          className="flex items-center gap-1.5 px-4 py-2 bg-primary hover:bg-primary/90 text-white text-sm rounded-lg disabled:opacity-50">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {t('mqttcfg.save_reconnect')}
        </button>
        <button onClick={() => { disconnect(); connect(); }} disabled={busy}
          title={t('mqttcfg.reconnect')}
          className="flex items-center gap-1.5 px-3 py-2 border border-border text-text-secondary hover:text-text-primary text-sm rounded-lg disabled:opacity-50">
          <RefreshCw className="w-3.5 h-3.5" /> {t('mqttcfg.reconnect')}
        </button>
        {dirty && <span className="text-[11px] text-warning">{t('mqttcfg.unsaved')}</span>}
      </div>
    </div>
  );
}
