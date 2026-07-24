import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, DoorOpen, Ban, Loader2, Link2 } from 'lucide-react';
import {
  listVisits, allowOrphanExit, denyOrphanExit, connectS300Events,
  orphanCandidates, pairOrphanExit, type OrphanCandidate,
} from '../services/s300Service';
import { fmtPgTs } from '../utils/helpers';
import { useI18n } from '../contexts/I18nContext';

interface PendingOrphan {
  id: number;
  plate: string;
  channel: string;
  at: string | null;
}

/**
 * Global orphan-exit confirmation popup (mounted in App, shows on every page).
 * An exit-camera recognition with no active visit is NOT an automatic pass —
 * the barrier stays shut until an operator allows (opens it) or denies here.
 * Seeds from the API on mount (missed events), then stays live via SSE.
 */
export default function OrphanExitAlert() {
  const { t } = useI18n();
  const [queue, setQueue] = useState<PendingOrphan[]>([]);
  const [busy, setBusy] = useState<'allow' | 'deny' | number | null>(null);
  const [error, setError] = useState('');
  const [candidates, setCandidates] = useState<OrphanCandidate[] | null>(null);

  const remove = useCallback((id: number) => {
    setQueue(q => q.filter(o => o.id !== id));
  }, []);

  useEffect(() => {
    listVisits({ status: 'orphan_exit', orphan_review: 'pending', limit: 20 })
      .then(r => setQueue(r.items.map(v => ({
        id: v.id, plate: v.license_plate, channel: v.exit_channel_no ?? '?', at: v.exit_at,
      })).reverse()))
      .catch(() => undefined);

    const close = connectS300Events(ev => {
      if (ev.type === 'orphan-exit') {
        const p = ev.payload as { visitId: number; licensePlate: string; exitChannelNo: string };
        setQueue(q => q.some(o => o.id === p.visitId) ? q
          : [...q, { id: p.visitId, plate: p.licensePlate, channel: p.exitChannelNo, at: null }]);
      } else if (ev.type === 'orphan-review') {
        // Another operator (or tab) already decided — drop it from our queue.
        const p = ev.payload as { visitId: number };
        remove(p.visitId);
      }
    });
    return close;
  }, [remove]);

  const current = queue[0];
  const currentId = current?.id;

  // Misread pairing: fetch similar inside-vehicles for the current orphan.
  useEffect(() => {
    setCandidates(null);
    if (!currentId) return;
    orphanCandidates(currentId).then(setCandidates).catch(() => setCandidates([]));
  }, [currentId]);

  if (!current) return null;

  const pair = async (c: OrphanCandidate) => {
    setBusy(c.id);
    setError('');
    try {
      await pairOrphanExit(current.id, c.id);
      remove(current.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'failed';
      if (/awaiting|409/i.test(msg)) remove(current.id);
      else setError(msg);
    } finally {
      setBusy(null);
    }
  };

  const decide = async (allow: boolean) => {
    setBusy(allow ? 'allow' : 'deny');
    setError('');
    try {
      if (allow) await allowOrphanExit(current.id);
      else await denyOrphanExit(current.id);
      remove(current.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'failed';
      // 409 = already handled elsewhere; just drop it silently.
      if (/awaiting|409/i.test(msg)) remove(current.id);
      else setError(msg);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] bg-black/60 flex items-center justify-center p-4">
      <div className="bg-surface border border-danger/40 rounded-xl max-w-md w-full p-5 shadow-2xl">
        <div className="flex items-start gap-3 mb-3">
          <div className="w-10 h-10 rounded-full bg-danger/15 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-5 h-5 text-danger" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text-primary">{t('orphan.alert.title')}</h3>
            <p className="text-xs text-text-secondary mt-0.5">{t('orphan.alert.body')}</p>
          </div>
        </div>

        <div className="bg-surface-dark border border-border rounded-lg p-3 mb-4 space-y-1">
          <div className="font-mono text-2xl text-text-primary text-center">{current.plate}</div>
          <div className="text-center text-[11px] text-text-secondary">
            {t('orphan.alert.lane')}: <span className="font-mono text-text-primary">{current.channel}</span>
            {current.at && <> · {fmtPgTs(current.at)}</>}
          </div>
        </div>

        {error && (
          <div className="mb-3 px-3 py-2 rounded-lg text-xs bg-danger/10 border border-danger/30 text-danger">{error}</div>
        )}

        {/* Misread pairing: likely the exit camera misread a vehicle that is
            inside — pairing closes ITS visit so in/out/inside stays tallied. */}
        <div className="mb-4">
          <p className="text-[11px] font-semibold text-text-secondary uppercase tracking-wide mb-1.5 flex items-center gap-1">
            <Link2 className="w-3 h-3" /> {t('orphan.pair.title')}
          </p>
          {candidates === null ? (
            <p className="text-[11px] text-text-secondary">{t('common.loading')}</p>
          ) : candidates.length === 0 ? (
            <p className="text-[11px] text-text-secondary">{t('orphan.pair.none')}</p>
          ) : (
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {candidates.map(c => (
                <button key={c.id} onClick={() => pair(c)} disabled={busy !== null}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 bg-surface-dark border border-border rounded-md hover:border-primary/60 text-left disabled:opacity-50">
                  {busy === c.id ? <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" /> : <Link2 className="w-3.5 h-3.5 text-primary shrink-0" />}
                  <span className="font-mono text-sm text-text-primary">{c.license_plate}</span>
                  {c.distance <= 2 && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400">{t('orphan.pair.similar')}</span>
                  )}
                  <span className="ml-auto text-[10px] text-text-secondary">
                    {c.entry_channel_no ?? '?'}{c.entry_at ? ` · ${fmtPgTs(c.entry_at)}` : ''}
                  </span>
                </button>
              ))}
            </div>
          )}
          <p className="mt-1 text-[10px] text-text-secondary">{t('orphan.pair.hint')}</p>
        </div>

        <div className="flex gap-2">
          <button onClick={() => decide(false)} disabled={busy !== null}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-sm border border-border rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-light disabled:opacity-50">
            {busy === 'deny' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Ban className="w-4 h-4" />}
            {t('orphan.alert.deny')}
          </button>
          <button onClick={() => decide(true)} disabled={busy !== null}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-sm bg-green-600 hover:bg-green-500 text-white rounded-lg disabled:opacity-50">
            {busy === 'allow' ? <Loader2 className="w-4 h-4 animate-spin" /> : <DoorOpen className="w-4 h-4" />}
            {t('orphan.alert.allow')}
          </button>
        </div>

        {queue.length > 1 && (
          <p className="mt-3 text-center text-[11px] text-amber-400">
            {t('orphan.alert.more', { n: queue.length - 1 })}
          </p>
        )}
      </div>
    </div>
  );
}
