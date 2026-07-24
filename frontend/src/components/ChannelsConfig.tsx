import { useCallback, useEffect, useState } from 'react';
import { Plus, Trash2, Edit2, X, Check, MapPin } from 'lucide-react';
import {
  listChannels, createChannel, updateChannel, deleteChannel,
  listLocations, createLocation, deleteLocation,
} from '../services/s300Service';
import type { S300Channel, SiteLocation } from '../types/s300';
import { useI18n } from '../contexts/I18nContext';
import type { TKey } from '../i18n/translations';
import ConfirmDialog, { type ConfirmSpec } from './ConfirmDialog';

/**
 * Channel (per-lane) configuration — table + edit modal. Lives on the Settings
 * page (System > Settings > Channels). Self-contained: loads its own channel
 * list and shows its own toast, so any page can embed it.
 */
export default function ChannelsConfig() {
  const { t } = useI18n();
  const [channels, setChannels] = useState<S300Channel[]>([]);
  const [locations, setLocations] = useState<SiteLocation[]>([]);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  const showToast = useCallback((msg: string, ok: boolean) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const reload = useCallback(async () => {
    try {
      setChannels(await listChannels());
    } catch (e) {
      showToast(t('s300.toast.channels_load_failed', { msg: (e as Error).message }), false);
    }
    try { setLocations(await listLocations()); } catch { /* picklist is non-critical */ }
  }, [showToast, t]);

  useEffect(() => { reload(); }, [reload]);

  return (
    <div>
      {toast && (
        <div className={`mb-3 px-3 py-2 rounded-lg text-xs ${
          toast.ok ? 'bg-success/10 border border-success/30 text-success'
                   : 'bg-danger/10 border border-danger/30 text-danger'
        }`}>{toast.msg}</div>
      )}
      <LocationsMaster locations={locations} reload={reload} showToast={showToast} />
      <ChannelsTable channels={channels} locations={locations} reload={reload} showToast={showToast} />
    </div>
  );
}

/** Master list of site zones — the channel form's location dropdown source. */
function LocationsMaster({ locations, reload, showToast }: {
  locations: SiteLocation[];
  reload: () => Promise<void>;
  showToast: (msg: string, ok: boolean) => void;
}) {
  const { t } = useI18n();
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  const add = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      await createLocation(name);
      setNewName('');
      showToast(t('s300.loc.toast.added', { n: name }), true);
      await reload();
    } catch (e) { showToast((e as Error).message, false); }
    finally { setBusy(false); }
  };

  const remove = async (l: SiteLocation) => {
    if (!confirm(t('s300.loc.confirm_delete', { n: l.name }))) return;
    setBusy(true);
    try {
      await deleteLocation(l.id);
      showToast(t('s300.loc.toast.removed'), true);
      await reload();
    } catch (e) { showToast((e as Error).message, false); }
    finally { setBusy(false); }
  };

  return (
    <div className="bg-surface border border-border rounded-lg p-4 mb-4">
      <h4 className="text-xs font-semibold text-text-secondary uppercase tracking-wide flex items-center gap-1.5 mb-1">
        <MapPin className="w-3.5 h-3.5" /> {t('s300.loc.title')}
      </h4>
      <p className="text-[11px] text-text-secondary mb-3">{t('s300.loc.hint')}</p>
      <div className="flex flex-wrap items-center gap-2">
        {locations.map(l => (
          <span key={l.id}
            className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-md bg-primary/10 text-primary-light border border-primary/30">
            {l.name}
            <button onClick={() => remove(l)} disabled={busy}
              className="text-primary-light/70 hover:text-danger disabled:opacity-50" title={t('s300.loc.delete')}>
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
        <div className="flex items-center gap-1">
          <input value={newName} onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') add(); }}
            placeholder={t('s300.loc.add_ph')} maxLength={64}
            className="px-2.5 py-1.5 bg-surface-dark border border-border rounded-md text-xs text-text-primary w-44" />
          <button onClick={add} disabled={busy || !newName.trim()}
            className="flex items-center gap-1 px-2.5 py-1.5 bg-primary text-white text-xs rounded-md hover:bg-primary/90 disabled:opacity-50">
            <Plus className="w-3.5 h-3.5" /> {t('s300.loc.add')}
          </button>
        </div>
      </div>
    </div>
  );
}

function ChannelsTable({ channels, locations, reload, showToast }: {
  channels: S300Channel[];
  locations: SiteLocation[];
  reload: () => Promise<void>;
  showToast: (msg: string, ok: boolean) => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState<S300Channel | null>(null);
  const [creating, setCreating] = useState(false);

  const save = async (data: Partial<S300Channel>) => {
    try {
      if (editing) await updateChannel(editing.id, data);
      else await createChannel(data);
      showToast(editing ? t('s300.ch.toast.updated') : t('s300.ch.toast.created'), true);
      setEditing(null); setCreating(false);
      await reload();
    } catch (e) {
      showToast(t('s300.ch.toast.save_failed', { msg: (e as Error).message }), false);
    }
  };

  const remove = async (c: S300Channel) => {
    if (!confirm(t('s300.ch.confirm_delete', { n: c.channel_no }))) return;
    try {
      await deleteChannel(c.id);
      showToast(t('s300.ch.toast.deleted'), true);
      await reload();
    } catch (e) {
      showToast(t('s300.ch.toast.delete_failed', { msg: (e as Error).message }), false);
    }
  };

  // One section per lane kind — only entry lanes have robotic inspection, so
  // the other tables drop the Behavior column entirely.
  const groups: { titleKey: 's300.ch.group.entry' | 's300.ch.group.exit' | 's300.ch.group.xray'; items: S300Channel[]; isEntry: boolean }[] = [
    { titleKey: 's300.ch.group.entry', items: channels.filter(c => c.kind === 'entry'), isEntry: true },
    { titleKey: 's300.ch.group.exit',  items: channels.filter(c => c.kind === 'exit'),  isEntry: false },
    { titleKey: 's300.ch.group.xray',  items: channels.filter(c => c.kind === 'xray'),  isEntry: false },
  ];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button onClick={() => setCreating(true)}
          className="flex items-center gap-2 px-3 py-1.5 bg-primary text-white text-sm rounded-md hover:bg-primary/90">
          <Plus className="w-4 h-4" /> {t('s300.ch.new')}
        </button>
      </div>

      {groups.map(g => (
        <div key={g.titleKey}>
          <h4 className={`text-xs font-semibold uppercase tracking-wide mb-2 ${
            g.titleKey === 's300.ch.group.entry' ? 'text-blue-300'
            : g.titleKey === 's300.ch.group.exit' ? 'text-purple-300'
            : 'text-red-300'
          }`}>
            {t(g.titleKey)} <span className="text-text-secondary font-normal">({g.items.length})</span>
          </h4>
          <div className="bg-surface border border-border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-surface-dark text-text-secondary text-xs uppercase">
                <tr>
                  <th className="text-left px-4 py-2">{t('s300.ch.col.channel_no')}</th>
                  <th className="text-left px-4 py-2">{t('s300.ch.col.name')}</th>
                  <th className="text-left px-4 py-2">{t('s300.ch.col.location')}</th>
                  <th className="text-left px-4 py-2">{t('s300.ch.col.anpr_sn')}</th>
                  {g.isEntry && <th className="text-left px-4 py-2">{t('s300.ch.col.behavior')}</th>}
                  <th className="text-left px-4 py-2">{t('s300.ch.col.enabled')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {g.items.map(c => (
                  <tr key={c.id} className="border-t border-border">
                    <td className="px-4 py-2 font-mono">{c.channel_no}</td>
                    <td className="px-4 py-2 text-text-secondary">{c.name || '-'}</td>
                    <td className="px-4 py-2">
                      {c.location
                        ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary-light border border-primary/30">{c.location}</span>
                        : <span className="text-text-secondary text-xs">-</span>}
                    </td>
                    <td className="px-4 py-2 text-text-secondary font-mono text-xs">{c.anpr_device_sn || '-'}</td>
                    {g.isEntry && (
                      <td className="px-4 py-2">
                        <div className="flex gap-1">
                          <span title={t('s300.ch.sec.label')}
                            className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                              c.security_mode === 'red' ? 'bg-red-500/20 text-red-400'
                              : c.security_mode === 'orange' ? 'bg-amber-500/20 text-amber-400'
                              : 'bg-green-500/20 text-green-400'
                            }`}>
                            {c.security_mode === 'orange'
                              ? `RND ${c.security_random_pct ?? 20}%`
                              : (c.security_mode ?? 'green').toUpperCase()}
                          </span>
                          <span title={t('s300.ch.behavior.vip')}
                            className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                              (c.behavior_vip ?? 1) === 1 ? 'bg-green-500/20 text-green-400' : 'bg-surface-dark text-text-secondary line-through'
                            }`}>VIP</span>
                          <span title={t('s300.ch.behavior.blacklist')}
                            className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                              (c.behavior_blacklist ?? 1) === 1 ? 'bg-green-500/20 text-green-400' : 'bg-surface-dark text-text-secondary line-through'
                            }`}>BL</span>
                          <span title={t('s300.ch.mode.label')}
                            className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                              (c.s300_inspection_mode ?? 'full') === 'none' ? 'bg-surface-dark text-text-secondary line-through' : 'bg-green-500/20 text-green-400'
                            }`}>{t(`s300.ch.mode.badge.${c.s300_inspection_mode ?? 'full'}` as TKey)}</span>
                          {(c.behavior_whitelist_only ?? 0) === 1 && (
                            <span title={t('s300.ch.behavior.wl_only')}
                              className="text-[10px] px-1.5 py-0.5 rounded font-bold bg-amber-500/20 text-amber-400">WL-ONLY</span>
                          )}
                        </div>
                      </td>
                    )}
                    <td className="px-4 py-2">
                      <span className={`text-xs ${c.enabled ? 'text-green-500' : 'text-text-secondary'}`}>
                        {c.enabled ? t('common.yes').toUpperCase() : t('common.no').toUpperCase()}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex gap-1 justify-end">
                        <button onClick={() => setEditing(c)} className="p-1 text-text-secondary hover:text-text-primary">
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => remove(c)} className="p-1 text-text-secondary hover:text-red-500">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {g.items.length === 0 && (
                  <tr><td colSpan={g.isEntry ? 7 : 6} className="px-4 py-6 text-center text-text-secondary text-sm">{t('s300.ch.empty')}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {(editing || creating) && (
        <ChannelEditModal
          initial={editing || undefined}
          locations={locations}
          onSave={save}
          onCancel={() => { setEditing(null); setCreating(false); }}
        />
      )}
    </div>
  );
}

function ChannelEditModal({ initial, locations, onSave, onCancel }: {
  initial?: S300Channel;
  locations: SiteLocation[];
  onSave: (data: Partial<S300Channel>) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [data, setData] = useState({
    channel_no: initial?.channel_no || '',
    name: initial?.name || '',
    location: initial?.location || '',
    kind: (initial?.kind || 'entry') as 'entry' | 'exit' | 'xray',
    s300_base_url: initial?.s300_base_url || 'http://127.0.0.1:8086',
    anpr_device_sn: initial?.anpr_device_sn || '',
    enabled: initial?.enabled ?? 1,
    uvis_timeout_sec: initial?.uvis_timeout_sec ?? 30,
    failure_audio_index: initial?.failure_audio_index ?? 7,
    blocker_relay_enabled: initial?.blocker_relay_enabled ?? 0,
    blocker_relay_topic: initial?.blocker_relay_topic || '',
    blocker_relay_pub_topic: initial?.blocker_relay_pub_topic || '',
    blocker_relay_res: initial?.blocker_relay_res || '',
    blocker_relay_open_ch: initial?.blocker_relay_open_ch || 'A01',
    blocker_relay_close_ch: initial?.blocker_relay_close_ch || 'A02',
    blocker_relay_stop_ch: initial?.blocker_relay_stop_ch || 'A03',
    behavior_uvis_s300: initial?.behavior_uvis_s300 ?? 1,
    s300_inspection_mode: initial?.s300_inspection_mode ?? 'full',
    s300_timed_seconds: initial?.s300_timed_seconds ?? 15,
    behavior_vip: initial?.behavior_vip ?? 1,
    behavior_blacklist: initial?.behavior_blacklist ?? 1,
    behavior_whitelist_only: initial?.behavior_whitelist_only ?? 0,
    security_mode: (initial?.security_mode ?? 'green') as 'red' | 'orange' | 'green',
    security_random_pct: initial?.security_random_pct ?? 20,
  });
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);

  // Changing the S300 inspection mode changes how/when the lane completes an
  // inspection — confirm before switching (revert-safe: cancel keeps the old mode).
  const changeMode = (nv: string) => {
    if (nv === data.s300_inspection_mode) return;
    setConfirm({
      title: t('confirm.mode.title'),
      message: t('confirm.mode.msg', { mode: t(`s300.ch.mode.${nv}` as TKey) }),
      confirmLabel: t('confirm.mode.ok'),
      tone: 'warning',
      onConfirm: () => { setConfirm(null); setData(d => ({ ...d, s300_inspection_mode: nv })); },
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-surface border border-border rounded-lg w-full max-w-lg p-5 my-8">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-text-primary font-semibold">{initial ? t('s300.ch.modal.edit') : t('s300.ch.modal.new')}</h3>
          <button onClick={onCancel}><X className="w-4 h-4 text-text-secondary" /></button>
        </div>

        <div className="space-y-3">
          <Field label={t('s300.ch.field.channel_no')} value={data.channel_no} disabled={!!initial}
            onChange={v => setData({...data, channel_no: v})} placeholder={t('s300.ch.field.channel_no_ph')} />
          <Field label={t('s300.ch.field.friendly_name')} value={data.name}
            onChange={v => setData({...data, name: v})} placeholder={t('s300.ch.field.friendly_name_ph')} />

          {/* Site zone — dropdown fed by the master location list. A legacy
              value not in the master list stays selectable so editing an old
              channel never silently clears it. */}
          <div>
            <label className="block text-xs text-text-secondary mb-1">{t('s300.ch.field.location')}</label>
            <select value={data.location}
              onChange={e => setData({...data, location: e.target.value})}
              className="w-full px-3 py-2 bg-surface-dark border border-border rounded-md text-sm text-text-primary">
              <option value="">{t('s300.ch.field.location_none')}</option>
              {locations.map(l => <option key={l.id} value={l.name}>{l.name}</option>)}
              {data.location && !locations.some(l => l.name === data.location) && (
                <option value={data.location}>{data.location}</option>
              )}
            </select>
          </div>

          {/* No entry/exit pairing: vehicles may enter from any lane and exit
              from any lane; whitelist ops fan out to all exit cameras. */}
          <div>
            <label className="block text-xs text-text-secondary mb-1">{t('s300.ch.field.kind')}</label>
            <select value={data.kind}
              onChange={e => setData({...data, kind: e.target.value as 'entry'|'exit'|'xray'})}
              className="w-full px-3 py-2 bg-surface-dark border border-border rounded-md text-sm text-text-primary">
              <option value="entry">{t('s300.ch.field.kind_entry')}</option>
              <option value="exit">{t('s300.ch.field.kind_exit')}</option>
              <option value="xray">{t('s300.ch.field.kind_xray')}</option>
            </select>
          </div>

          <Field label={t('s300.ch.field.anpr_sn')} value={data.anpr_device_sn || ''}
            onChange={v => setData({...data, anpr_device_sn: v})} placeholder={t('s300.ch.field.anpr_sn_ph')} />

          {/* Exit gates have no robotic inspection arm — S300 URL is entry-only */}
          {data.kind === 'entry' && (
            <Field label={t('s300.ch.field.s300_url')} value={data.s300_base_url}
              onChange={v => setData({...data, s300_base_url: v})} placeholder={t('s300.ch.field.s300_url_ph')} />
          )}

          <label className="flex items-center gap-2 text-sm text-text-primary">
            <input type="checkbox" checked={!!data.enabled}
              onChange={e => setData({...data, enabled: e.target.checked ? 1 : 0})} />
            {t('s300.ch.field.enabled')}
          </label>

          {data.kind === 'entry' && <>
          {/* Per-lane behaviour: which flow stages this lane runs */}
          <div className="pt-3 border-t border-border">
            <h4 className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-2">{t('s300.ch.section.behavior')}</h4>
            <div className="space-y-1.5">
              <label className="flex items-center gap-2 text-sm text-text-primary">
                <input type="checkbox" checked={data.behavior_vip === 1}
                  onChange={e => setData({...data, behavior_vip: e.target.checked ? 1 : 0})} />
                {t('s300.ch.behavior.vip')}
              </label>
              <label className="flex items-center gap-2 text-sm text-text-primary">
                <input type="checkbox" checked={data.behavior_blacklist === 1}
                  onChange={e => setData({...data, behavior_blacklist: e.target.checked ? 1 : 0})} />
                {t('s300.ch.behavior.blacklist')}
              </label>
              <label className="flex items-center gap-2 text-sm text-text-primary">
                <input type="checkbox" checked={data.behavior_whitelist_only === 1}
                  onChange={e => setData({...data, behavior_whitelist_only: e.target.checked ? 1 : 0})} />
                {t('s300.ch.behavior.wl_only')}
              </label>
            </div>
            {data.behavior_whitelist_only === 1 && (
              <p className="text-[10px] text-warning mt-1.5">{t('s300.ch.behavior.wl_only_warn')}</p>
            )}

            {/* S300 inspection mode: how far the S300 inspection goes on this lane */}
            <div className="mt-3">
              <label className="block text-xs text-text-secondary mb-1">{t('s300.ch.mode.label')}</label>
              <select value={data.s300_inspection_mode}
                onChange={e => changeMode(e.target.value)}
                className="w-full px-3 py-2 bg-surface-dark border border-border rounded-md text-sm text-text-primary">
                <option value="none">{t('s300.ch.mode.none')}</option>
                <option value="skip">{t('s300.ch.mode.skip')}</option>
                <option value="timed">{t('s300.ch.mode.timed')}</option>
                <option value="full">{t('s300.ch.mode.full')}</option>
              </select>
              {data.s300_inspection_mode === 'timed' && (
                <div className="mt-2">
                  <Field label={t('s300.ch.mode.timed_seconds')} value={String(data.s300_timed_seconds)}
                    onChange={v => setData({...data, s300_timed_seconds: parseInt(v) || 15})} placeholder="15" />
                </div>
              )}
              <p className="text-[10px] text-text-secondary mt-1">{t(`s300.ch.mode.hint.${data.s300_inspection_mode}` as TKey)}</p>
            </div>

            {/* Security mode: x-ray routing policy for this lane */}
            <div className="mt-3">
              <label className="block text-xs text-text-secondary mb-1">{t('s300.ch.sec.label')}</label>
              <select value={data.security_mode}
                onChange={e => setData({...data, security_mode: e.target.value as 'red'|'orange'|'green'})}
                className="w-full px-3 py-2 bg-surface-dark border border-border rounded-md text-sm text-text-primary">
                <option value="green">{t('s300.ch.sec.green')}</option>
                <option value="orange">{t('s300.ch.sec.orange')}</option>
                <option value="red">{t('s300.ch.sec.red')}</option>
              </select>
              {data.security_mode === 'orange' && (
                <div className="mt-2">
                  <Field label={t('s300.ch.sec.pct')} value={String(data.security_random_pct)}
                    onChange={v => setData({...data, security_random_pct: Math.max(0, Math.min(100, parseInt(v) || 0))})}
                    placeholder="20" />
                </div>
              )}
              <p className="text-[10px] text-text-secondary mt-1">{t('s300.ch.sec.hint')}</p>
            </div>

            <p className="text-[10px] text-text-secondary mt-2">{t('s300.ch.behavior.hint')}</p>
          </div>

          <div className="pt-3 border-t border-border">
            <h4 className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-2">{t('s300.ch.section.decision')}</h4>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('s300.ch.field.uvis_timeout')} value={String(data.uvis_timeout_sec)}
                onChange={v => setData({...data, uvis_timeout_sec: parseInt(v) || 30})} placeholder="30" />
              <Field label={t('s300.ch.field.audio_index')} value={String(data.failure_audio_index)}
                onChange={v => setData({...data, failure_audio_index: parseInt(v) || 7})} placeholder="7" />
            </div>
            <p className="text-[10px] text-text-secondary mt-1">
              {t('s300.ch.audio_hint')}
            </p>
          </div>

          {/* Per-lane road blocker (multi-lane) */}
          <div className="pt-3 border-t border-border">
            <label className="flex items-center gap-2 text-xs font-semibold text-text-secondary uppercase tracking-wide mb-2 cursor-pointer">
              <input type="checkbox" checked={data.blocker_relay_enabled === 1}
                onChange={e => setData({...data, blocker_relay_enabled: e.target.checked ? 1 : 0})} />
              {t('s300.ch.section.blocker')}
            </label>
            {data.blocker_relay_enabled === 1 && <>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t('s300.ch.field.blocker_topic')} value={data.blocker_relay_topic}
                  onChange={v => setData({...data, blocker_relay_topic: v})} placeholder="testsubscribe" />
                <Field label={t('s300.ch.field.blocker_pub_topic')} value={data.blocker_relay_pub_topic}
                  onChange={v => setData({...data, blocker_relay_pub_topic: v})} placeholder="testpublish" />
                <Field label={t('s300.ch.field.blocker_res')} value={data.blocker_relay_res}
                  onChange={v => setData({...data, blocker_relay_res: v})} placeholder="LANE1" />
                <div className="grid grid-cols-3 gap-1.5">
                  <Field label={t('rb.btn.open')} value={data.blocker_relay_open_ch}
                    onChange={v => setData({...data, blocker_relay_open_ch: v})} placeholder="A01" />
                  <Field label={t('rb.btn.close')} value={data.blocker_relay_close_ch}
                    onChange={v => setData({...data, blocker_relay_close_ch: v})} placeholder="A02" />
                  <Field label={t('rb.btn.stop')} value={data.blocker_relay_stop_ch}
                    onChange={v => setData({...data, blocker_relay_stop_ch: v})} placeholder="A03" />
                </div>
              </div>
              <p className="text-[10px] text-text-secondary mt-1">{t('s300.ch.blocker_hint')}</p>
              <p className="text-[10px] text-text-secondary mt-1">{t('s300.ch.blocker_autoopen_note')}</p>
            </>}
          </div>
          </>}
        </div>

        <div className="flex gap-2 mt-5 justify-end">
          <button onClick={onCancel}
            className="px-3 py-1.5 text-sm border border-border rounded-md text-text-secondary hover:text-text-primary">
            {t('common.cancel')}
          </button>
          <button onClick={() => onSave({
            channel_no: data.channel_no,
            name: data.name || null,
            location: data.location || null,
            kind: data.kind,
            s300_base_url: data.s300_base_url,
            anpr_device_sn: data.anpr_device_sn || null,
            enabled: data.enabled,
            uvis_timeout_sec: data.uvis_timeout_sec,
            failure_audio_index: data.failure_audio_index,
            blocker_relay_enabled: data.blocker_relay_enabled,
            blocker_relay_topic: data.blocker_relay_topic || null,
            blocker_relay_pub_topic: data.blocker_relay_pub_topic || null,
            blocker_relay_res: data.blocker_relay_res || null,
            blocker_relay_open_ch: data.blocker_relay_open_ch || null,
            blocker_relay_close_ch: data.blocker_relay_close_ch || null,
            blocker_relay_stop_ch: data.blocker_relay_stop_ch || null,
            s300_inspection_mode: data.s300_inspection_mode,
            s300_timed_seconds: data.s300_timed_seconds,
            behavior_vip: data.behavior_vip,
            behavior_blacklist: data.behavior_blacklist,
            behavior_whitelist_only: data.behavior_whitelist_only,
            security_mode: data.security_mode,
            security_random_pct: data.security_random_pct,
          })}
            className="flex items-center gap-1 px-3 py-1.5 bg-primary text-white text-sm rounded-md hover:bg-primary/90">
            <Check className="w-3.5 h-3.5" /> {t('common.save')}
          </button>
        </div>
      </div>
      {confirm && <ConfirmDialog spec={confirm} onCancel={() => setConfirm(null)} />}
    </div>
  );
}

function Field({ label, value, onChange, placeholder, disabled }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <div>
      <label className="block text-xs text-text-secondary mb-1">{label}</label>
      <input value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder} disabled={disabled}
        className="w-full px-3 py-2 bg-surface-dark border border-border rounded-md text-sm text-text-primary disabled:opacity-50" />
    </div>
  );
}
