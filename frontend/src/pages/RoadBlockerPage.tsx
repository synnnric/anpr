import { useState, useEffect, useCallback } from 'react';
import {
  ArrowDown, ArrowUp, Square, RefreshCw, Loader2, ShieldCheck,
  AlertCircle, Radio, Hash,
} from 'lucide-react';
import type { RoadBlockerStatus, BlockerAction } from '../types/roadblocker';
import { getBlockerStatus, sendBlockerAction, setBlockerAutoOpen } from '../services/roadBlockerService';
import { useI18n } from '../contexts/I18nContext';

export default function RoadBlockerPage() {
  const { t } = useI18n();
  const [status, setStatus] = useState<RoadBlockerStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<BlockerAction | null>(null);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setStatus(await getBlockerStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : t('rb.err.status'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const handleAction = async (action: BlockerAction) => {
    setResult(null);
    setBusy(action);
    try {
      await sendBlockerAction(action);
      setResult({ ok: true, msg: t('rb.action.queued', { action: t(`rb.btn.${action}`) }) });
      setTimeout(() => fetchStatus(), 600);
    } catch (err) {
      setResult({ ok: false, msg: err instanceof Error ? err.message : t('rb.action.failed') });
    } finally {
      setBusy(null);
      setTimeout(() => setResult(null), 5000);
    }
  };

  const toggleAutoOpen = async () => {
    if (!status) return;
    const next = !status.auto_open;
    setStatus({ ...status, auto_open: next });
    try {
      await setBlockerAutoOpen(next);
    } catch (err) {
      setStatus({ ...status, auto_open: !next });
      setError(err instanceof Error ? err.message : t('rb.action.failed'));
    }
  };

  const disabled = status?.enabled === false;

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="flex items-center gap-2 mb-1">
        <h2 className="text-xl font-bold text-text-primary">{t('rb.title')}</h2>
        <button onClick={fetchStatus} disabled={loading}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-xs bg-surface-light border border-border text-text-secondary hover:text-text-primary rounded-lg transition-colors disabled:opacity-50">
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          {t('rb.refresh')}
        </button>
      </div>
      <p className="text-sm text-text-secondary mb-6">{t('rb.subtitle')}</p>

      {error && (
        <div className="flex items-center gap-2 bg-danger/10 border border-danger/30 rounded-lg p-2.5 text-xs text-danger mb-4">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {disabled && (
        <div className="flex items-center gap-2 bg-amber-500/10 border border-amber-500/30 rounded-lg p-2.5 text-xs text-amber-400 mb-4">
          <AlertCircle className="w-4 h-4 shrink-0" /> {t('rb.warn.disabled')}
        </div>
      )}

      {/* Manual control */}
      <div className="bg-surface border border-border rounded-xl p-5 mb-4">
        <div className="flex items-center gap-2 mb-1">
          <ShieldCheck className="w-4 h-4 text-primary-light" />
          <h3 className="text-sm font-semibold text-text-primary">{t('rb.control.title')}</h3>
        </div>
        <p className="text-[11px] text-text-secondary mb-4">{t('rb.control.subtitle')}</p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <button onClick={() => handleAction('open')} disabled={disabled || busy !== null}
            className="flex flex-col items-center justify-center gap-1.5 py-5 bg-green-600 hover:bg-green-500 text-white font-medium rounded-lg transition-colors disabled:opacity-50">
            {busy === 'open' ? <Loader2 className="w-6 h-6 animate-spin" /> : <ArrowDown className="w-6 h-6" />}
            <span className="text-sm">{t('rb.btn.open')}</span>
            <span className="text-[10px] opacity-80">{t('rb.btn.open_desc')}</span>
          </button>

          <button onClick={() => handleAction('close')} disabled={disabled || busy !== null}
            className="flex flex-col items-center justify-center gap-1.5 py-5 bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-lg transition-colors disabled:opacity-50">
            {busy === 'close' ? <Loader2 className="w-6 h-6 animate-spin" /> : <ArrowUp className="w-6 h-6" />}
            <span className="text-sm">{t('rb.btn.close')}</span>
            <span className="text-[10px] opacity-80">{t('rb.btn.close_desc')}</span>
          </button>

          <button onClick={() => handleAction('stop')} disabled={disabled || busy !== null}
            className="flex flex-col items-center justify-center gap-1.5 py-5 bg-red-600 hover:bg-red-500 text-white font-medium rounded-lg transition-colors disabled:opacity-50">
            {busy === 'stop' ? <Loader2 className="w-6 h-6 animate-spin" /> : <Square className="w-6 h-6" />}
            <span className="text-sm">{t('rb.btn.stop')}</span>
            <span className="text-[10px] opacity-80">{t('rb.btn.stop_desc')}</span>
          </button>
        </div>

        {result && (
          <div className={`flex items-center gap-2 rounded-lg p-2.5 text-xs mt-4 ${
            result.ok ? 'bg-success/10 border border-success/30 text-success' : 'bg-danger/10 border border-danger/30 text-danger'
          }`}>
            {result.msg}
          </div>
        )}
      </div>

      {/* Automatic control toggle */}
      <div className="bg-surface border border-border rounded-xl p-5 mb-4">
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-text-primary">{t('rb.auto.title')}</h3>
            <p className="text-[11px] text-text-secondary mt-0.5">{t('rb.auto.subtitle')}</p>
          </div>
          <button
            onClick={toggleAutoOpen}
            disabled={!status}
            role="switch"
            aria-checked={!!status?.auto_open}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
              status?.auto_open ? 'bg-amber-500' : 'bg-surface-light'
            }`}>
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              status?.auto_open ? 'translate-x-6' : 'translate-x-1'
            }`} />
          </button>
        </div>
        {status?.auto_open && (
          <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/30 rounded-lg p-2.5 text-[11px] text-amber-400 mt-3">
            <AlertCircle className="w-4 h-4 shrink-0 mt-px" /> {t('rb.auto.warn')}
          </div>
        )}
      </div>

      {/* Relay config / status */}
      <div className="bg-surface border border-border rounded-xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <Radio className="w-4 h-4 text-accent" />
          <h3 className="text-sm font-semibold text-text-primary">{t('rb.status.title')}</h3>
          {status && (
            <span className={`ml-auto text-xs px-2 py-0.5 rounded-full ${
              status.enabled ? 'bg-success/15 text-success' : 'bg-surface-light text-text-secondary'
            }`}>
              {status.enabled ? t('rb.status.enabled') : t('rb.status.disabled')}
            </span>
          )}
        </div>

        {status ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <Info label={t('rb.status.topic')} value={status.topic} mono />
            <Info label={t('rb.status.pulse_value')} value={String(status.value)} mono />
            <Info label="Open / Close / Stop" value={`${status.channels.open} / ${status.channels.close} / ${status.channels.stop}`} mono />
            <Info label={t('rb.status.res')} value={status.res} mono />
            <div className="col-span-2 sm:col-span-4">
              <div className="text-[10px] text-text-secondary flex items-center gap-1 mb-0.5"><Hash className="w-3 h-3" /> {t('rb.status.last_action')}</div>
              <div className="text-text-primary">
                {status.last_action
                  ? `${status.last_action.action} · ${status.last_action.status} · ${status.last_action.created_at}`
                  : t('rb.status.none')}
              </div>
            </div>
          </div>
        ) : (
          <p className="text-xs text-text-secondary">{loading ? t('rb.status.loading') : t('rb.status.none')}</p>
        )}

        <p className="mt-4 text-[10px] text-text-secondary leading-relaxed">{t('rb.note')}</p>
      </div>
    </div>
  );
}

function Info({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[10px] text-text-secondary mb-0.5">{label}</div>
      <div className={`text-text-primary ${mono ? 'font-mono' : ''}`}>{value}</div>
    </div>
  );
}
