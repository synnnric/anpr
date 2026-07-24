import { useCallback, useEffect, useState } from 'react';
import { Crown, Plus, Trash2 } from 'lucide-react';
import {
  listChannels, listVipPlates, createVipPlate, deleteVipPlate, updateVipPlate,
} from '../services/s300Service';
import type { S300Channel, VipPlate } from '../types/s300';
import { LaneScopePicker, ScopeBadge } from '../components/LaneScope';
import DurationPicker, { computeExpiry, isExpired, type DurationChoice } from '../components/DurationPicker';
import { fmtPgTs } from '../utils/helpers';
import { useI18n } from '../contexts/I18nContext';

/** Standalone VIP whitelist page (sidebar), like the Whitelist page — extracted from
 *  the S300 Inspection page tabs. Self-contained: own channel list + toast. */
export default function VipPage() {
  const [channels, setChannels] = useState<S300Channel[]>([]);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  const showToast = useCallback((msg: string, ok: boolean) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3000);
  }, []);

  useEffect(() => {
    listChannels().then(setChannels).catch(() => undefined);
  }, []);

  return (
    <div className="h-full overflow-y-auto p-6">
      {toast && (
        <div className={`mb-3 max-w-3xl px-3 py-2 rounded-lg text-xs ${
          toast.ok ? 'bg-success/10 border border-success/30 text-success'
                   : 'bg-danger/10 border border-danger/30 text-danger'
        }`}>{toast.msg}</div>
      )}
      <VipTab showToast={showToast} channels={channels} />
    </div>
  );
}

function VipTab({ showToast, channels }: {
  showToast: (msg: string, ok: boolean) => void;
  channels: S300Channel[];
}) {
  const { t } = useI18n();
  const [vips, setVips] = useState<VipPlate[]>([]);
  const [newPlate, setNewPlate] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [allLanes, setAllLanes] = useState(true);
  const [selLanes, setSelLanes] = useState<string[]>([]);
  const [duration, setDuration] = useState<DurationChoice>('permanent');
  const [customExpiry, setCustomExpiry] = useState('');

  const reload = useCallback(async () => {
    try { setVips(await listVipPlates()); }
    catch (e) { showToast(t('s300.vip.toast.load_failed', { msg: (e as Error).message }), false); }
  }, [showToast, t]);

  useEffect(() => { reload(); }, [reload]);

  const add = async () => {
    const plate = newPlate.trim().toUpperCase();
    if (!plate || (!allLanes && selLanes.length === 0)) return;
    try {
      await createVipPlate({
        license_plate: plate,
        description: newDesc || undefined,
        channel_nos: allLanes ? undefined : selLanes,
        expires_at: computeExpiry(duration, customExpiry) || undefined,
      });
      setNewPlate(''); setNewDesc(''); setDuration('permanent'); setCustomExpiry('');
      showToast(t('s300.vip.toast.added', { n: plate }), true);
      await reload();
    } catch (e) { showToast(t('s300.vip.toast.add_failed', { msg: (e as Error).message }), false); }
  };

  const toggle = async (v: VipPlate) => {
    try {
      await updateVipPlate(v.id, { enabled: v.enabled ? 0 : 1 });
      await reload();
    } catch (e) { showToast(t('s300.vip.toast.toggle_failed', { msg: (e as Error).message }), false); }
  };

  const remove = async (v: VipPlate) => {
    if (!confirm(t('s300.vip.confirm_delete', { n: v.license_plate }))) return;
    try {
      await deleteVipPlate(v.id);
      showToast(t('s300.vip.toast.removed'), true);
      await reload();
    } catch (e) { showToast(t('s300.vip.toast.delete_failed', { msg: (e as Error).message }), false); }
  };

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="bg-surface border border-border rounded-lg p-4">
        <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2 mb-1">
          <Crown className="w-4 h-4 text-amber-400" /> {t('s300.vip.title')}
        </h3>
        <p className="text-xs text-text-secondary mb-4">
          {t('s300.vip.hint')} <code className="text-text-primary">vip_skipped</code>.
        </p>

        <div className="flex gap-2">
          <input value={newPlate} onChange={e => setNewPlate(e.target.value)}
            placeholder={t('s300.vip.placeholder.plate')}
            className="flex-1 px-3 py-2 bg-surface-dark border border-border rounded-md text-sm font-mono text-text-primary" />
          <input value={newDesc} onChange={e => setNewDesc(e.target.value)}
            placeholder={t('s300.vip.placeholder.desc')}
            className="flex-1 px-3 py-2 bg-surface-dark border border-border rounded-md text-sm text-text-primary" />
          <DurationPicker choice={duration} setChoice={setDuration} custom={customExpiry} setCustom={setCustomExpiry} />
          <button onClick={add} disabled={!newPlate.trim() || (!allLanes && selLanes.length === 0)}
            className="flex items-center gap-1 px-3 py-2 bg-primary text-white text-sm rounded-md hover:bg-primary/90 disabled:opacity-50">
            <Plus className="w-4 h-4" /> {t('s300.vip.add')}
          </button>
        </div>
        <LaneScopePicker channels={channels}
          allLanes={allLanes} setAllLanes={setAllLanes} sel={selLanes} setSel={setSelLanes} />
      </div>

      <div className="bg-surface border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface-dark text-text-secondary text-xs uppercase">
            <tr>
              <th className="text-left px-4 py-2">{t('s300.vip.col.plate')}</th>
              <th className="text-left px-4 py-2">{t('s300.vip.col.description')}</th>
              <th className="text-left px-4 py-2">{t('s300.scope.col')}</th>
              <th className="text-left px-4 py-2">{t('s300.vip.col.status')}</th>
              <th className="text-left px-4 py-2">{t('dur.col')}</th>
              <th className="text-left px-4 py-2">{t('s300.vip.col.added')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {vips.map(v => (
              <tr key={v.id} className="border-t border-border">
                <td className="px-4 py-2">
                  <span className="inline-flex items-center gap-1.5 font-mono font-medium text-text-primary">
                    <Crown className="w-3 h-3 text-amber-400" /> {v.license_plate}
                  </span>
                </td>
                <td className="px-4 py-2 text-text-secondary">{v.description || '-'}</td>
                <td className="px-4 py-2"><ScopeBadge channelNo={v.channel_no} /></td>
                <td className="px-4 py-2">
                  <button onClick={() => toggle(v)}
                    className={`text-xs px-2 py-0.5 rounded ${
                      v.enabled ? 'bg-green-500/20 text-green-500' : 'bg-surface-dark text-text-secondary'
                    }`}>
                    {v.enabled ? t('s300.vip.active') : t('s300.vip.disabled')}
                  </button>
                </td>
                <td className="px-4 py-2 text-xs">
                  {!v.expires_at ? <span className="text-text-secondary">{t('dur.permanent')}</span>
                    : isExpired(v.expires_at)
                      ? <span className="text-red-400">{t('dur.expired')} · <span className="font-mono">{fmtPgTs(v.expires_at)}</span></span>
                      : <span className="text-text-secondary">{t('dur.until')} <span className="font-mono">{fmtPgTs(v.expires_at)}</span></span>}
                </td>
                <td className="px-4 py-2 text-text-secondary text-xs font-mono">{fmtPgTs(v.created_at)}</td>
                <td className="px-4 py-2 text-right">
                  <button onClick={() => remove(v)} className="p-1 text-text-secondary hover:text-red-500">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </td>
              </tr>
            ))}
            {vips.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-text-secondary text-sm">{t('s300.vip.empty')}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
