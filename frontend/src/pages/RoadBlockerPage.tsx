import { useState, useEffect, useCallback } from 'react';
import {
  ArrowDown, ArrowUp, Square, RefreshCw, Loader2, ShieldCheck,
  AlertCircle, Radio, Hash,
} from 'lucide-react';
import type { RoadBlockerStatus, BlockerAction } from '../types/roadblocker';
import { getBlockerStatus, sendBlockerAction, setBlockerAutoOpen,
  sendLaneAction, sendBulkAction, setLaneAutoOpen } from '../services/roadBlockerService';
import { useI18n } from '../contexts/I18nContext';
import ConfirmDialog, { type ConfirmSpec } from '../components/ConfirmDialog';

export default function RoadBlockerPage() {
  const { t } = useI18n();
  const [status, setStatus] = useState<RoadBlockerStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<BlockerAction | null>(null);
  const [laneBusy, setLaneBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);

  // RAISE (close/up) is a crush hazard — always confirm before driving the
  // bollard up, whether single lane, one lane, or bulk. `ch` names the target.
  const confirmRaise = (run: () => void, ch?: string) => setConfirm({
    title: t('confirm.raise.title'),
    message: ch ? t('confirm.raise.msg_lane', { ch }) : t('confirm.raise.msg'),
    confirmLabel: t('confirm.raise.ok'),
    tone: 'danger',
    onConfirm: () => { setConfirm(null); run(); },
  });

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

  const handleLaneAction = async (channelNo: string, action: BlockerAction) => {
    setResult(null);
    setLaneBusy(`${channelNo}:${action}`);
    try {
      await sendLaneAction(channelNo, action);
      setResult({ ok: true, msg: t('rb.lane.queued', { ch: channelNo, action: t(`rb.btn.${action}`) }) });
      setTimeout(() => fetchStatus(), 600);
    } catch (err) {
      setResult({ ok: false, msg: err instanceof Error ? err.message : t('rb.action.failed') });
    } finally {
      setLaneBusy(null);
      setTimeout(() => setResult(null), 5000);
    }
  };

  const handleBulk = async (action: BlockerAction) => {
    setResult(null);
    setLaneBusy(`bulk:${action}`);
    try {
      const r = await sendBulkAction(action);
      setResult({ ok: true, msg: t('rb.bulk.queued', { sent: String(r.sent), total: String(r.total), action: t(`rb.btn.${action}`) }) });
      setTimeout(() => fetchStatus(), 600);
    } catch (err) {
      setResult({ ok: false, msg: err instanceof Error ? err.message : t('rb.action.failed') });
    } finally {
      setLaneBusy(null);
      setTimeout(() => setResult(null), 5000);
    }
  };

  const toggleLaneAutoOpen = async (channelNo: string, current: boolean, confirmed = false) => {
    if (!status) return;
    const next = !current;
    // Turning auto-open ON makes the barrier auto-lower on a pass — confirm first.
    if (next && !confirmed) {
      setConfirm({
        title: t('confirm.autoopen.title'),
        message: t('confirm.autoopen.msg_lane', { ch: channelNo }),
        confirmLabel: t('confirm.autoopen.ok'),
        tone: 'warning',
        onConfirm: () => { setConfirm(null); toggleLaneAutoOpen(channelNo, current, true); },
      });
      return;
    }
    setStatus({ ...status, lanes: status.lanes.map(l => l.channel_no === channelNo ? { ...l, auto_open: next } : l) });
    try {
      await setLaneAutoOpen(channelNo, next);
    } catch (err) {
      setStatus({ ...status, lanes: status.lanes.map(l => l.channel_no === channelNo ? { ...l, auto_open: current } : l) });
      setError(err instanceof Error ? err.message : t('rb.action.failed'));
    }
  };

  const toggleAutoOpen = async (confirmed = false) => {
    if (!status) return;
    const next = !status.auto_open;
    if (next && !confirmed) {
      setConfirm({
        title: t('confirm.autoopen.title'),
        message: t('confirm.autoopen.msg'),
        confirmLabel: t('confirm.autoopen.ok'),
        tone: 'warning',
        onConfirm: () => { setConfirm(null); toggleAutoOpen(true); },
      });
      return;
    }
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

          <button onClick={() => confirmRaise(() => handleAction('close'))} disabled={disabled || busy !== null}
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

      {/* Multi-lane control (per-channel + bulk) */}
      {status && status.lanes.length > 0 && (
        <div className="bg-surface border border-border rounded-xl p-5 mb-4">
          <div className="flex items-center gap-2 mb-1">
            <Radio className="w-4 h-4 text-primary-light" />
            <h3 className="text-sm font-semibold text-text-primary">{t('rb.lanes.title')}</h3>
            <span className="ml-auto text-[11px] text-text-secondary">{status.lanes.length} {t('rb.lanes.count')}</span>
          </div>
          <p className="text-[11px] text-text-secondary mb-4">{t('rb.lanes.subtitle')}</p>

          {/* Bulk row */}
          <div className="flex items-center gap-2 mb-4 pb-4 border-b border-border">
            <span className="text-xs font-medium text-text-primary mr-1">{t('rb.bulk.label')}</span>
            {(['open', 'close', 'stop'] as BlockerAction[]).map(a => (
              <button key={a} onClick={() => a === 'close' ? confirmRaise(() => handleBulk('close')) : handleBulk(a)} disabled={laneBusy !== null}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-surface-light border border-border text-text-primary hover:border-primary rounded-lg transition-colors disabled:opacity-50">
                {laneBusy === `bulk:${a}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> :
                  a === 'open' ? <ArrowDown className="w-3.5 h-3.5" /> : a === 'close' ? <ArrowUp className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}
                {t(`rb.btn.${a}`)}
              </button>
            ))}
          </div>

          {/* Per-lane rows */}
          <div className="space-y-2">
            {status.lanes.map(lane => (
              <div key={lane.channel_no} className="flex items-center gap-3 bg-surface-dark border border-border rounded-lg px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text-primary">{lane.channel_no}</span>
                    {lane.name && <span className="text-[11px] text-text-secondary truncate">{lane.name}</span>}
                    {/* Physical position, confirmed by the relay ACK */}
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${
                      lane.position === 'up' ? 'bg-red-500/15 text-red-400'
                      : lane.position === 'down' ? 'bg-green-500/15 text-green-400'
                      : 'bg-surface-light text-text-secondary'
                    }`}>
                      {lane.position === 'up' ? t('rb.pos.up')
                        : lane.position === 'down' ? t('rb.pos.down')
                        : t('rb.pos.unknown')}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] text-text-secondary font-mono">{lane.topic || '—'} · {lane.res || '—'}</span>
                    {lane.sensor === 'passing' && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400">{t('rb.sensor.passing')}</span>
                    )}
                    {lane.cycle !== 'idle' && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary-light">{lane.cycle}</span>
                    )}
                  </div>
                </div>
                {/* Per-lane auto-open toggle */}
                <button onClick={() => toggleLaneAutoOpen(lane.channel_no, lane.auto_open)}
                  title={t('rb.lane.auto_open')}
                  className="flex items-center gap-1.5 shrink-0 text-[10px] text-text-secondary">
                  <span className="hidden sm:inline">{t('rb.lane.auto_open')}</span>
                  <span role="switch" aria-checked={lane.auto_open}
                    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${lane.auto_open ? 'bg-amber-500' : 'bg-surface-light'}`}>
                    <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${lane.auto_open ? 'translate-x-5' : 'translate-x-1'}`} />
                  </span>
                </button>
                <div className="flex items-center gap-1.5 shrink-0">
                  {(['open', 'close', 'stop'] as BlockerAction[]).map(a => (
                    <button key={a} onClick={() => a === 'close' ? confirmRaise(() => handleLaneAction(lane.channel_no, 'close'), lane.channel_no) : handleLaneAction(lane.channel_no, a)} disabled={laneBusy !== null || !lane.enabled}
                      title={t(`rb.btn.${a}`)}
                      className={`flex items-center justify-center w-9 h-9 rounded-lg text-white transition-colors disabled:opacity-40 ${
                        a === 'open' ? 'bg-green-600 hover:bg-green-500' : a === 'close' ? 'bg-blue-600 hover:bg-blue-500' : 'bg-red-600 hover:bg-red-500'
                      }`}>
                      {laneBusy === `${lane.channel_no}:${a}` ? <Loader2 className="w-4 h-4 animate-spin" /> :
                        a === 'open' ? <ArrowDown className="w-4 h-4" /> : a === 'close' ? <ArrowUp className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Automatic control toggle */}
      <div className="bg-surface border border-border rounded-xl p-5 mb-4">
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-text-primary">{t('rb.auto.title')}</h3>
            <p className="text-[11px] text-text-secondary mt-0.5">{t('rb.auto.subtitle')}</p>
          </div>
          <button
            onClick={() => toggleAutoOpen()}
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

      {/* Footer: last action + operating note. Relay config lives in
          System Settings (global fallback) and the Channel form (per-lane). */}
      <div className="text-[10px] text-text-secondary leading-relaxed space-y-1">
        {status?.last_action && (
          <p className="flex items-center gap-1">
            <Hash className="w-3 h-3" /> {t('rb.status.last_action')}: {status.last_action.action} · {status.last_action.created_at}
          </p>
        )}
        <p>{t('rb.note')}</p>
        <p>{t('rb.cfg.moved')}</p>
      </div>

      {confirm && <ConfirmDialog spec={confirm} onCancel={() => setConfirm(null)} />}
    </div>
  );
}
