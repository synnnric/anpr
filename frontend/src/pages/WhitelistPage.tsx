import { useState } from 'react';
import { Shield, Plus, Trash2, Search } from 'lucide-react';
import { useMqtt } from '../contexts/MqttContext';
import DurationPicker, { computeExpiry, type DurationChoice } from '../components/DurationPicker';
import { generateMessageId } from '../utils/helpers';
import type { WhitelistEntry } from '../types/mqtt';
import { useI18n } from '../contexts/I18nContext';

/** Camera-side whitelist — published straight to the device over MQTT
 *  (white_list_operator), unlike VIP/Blacklist which live in our DB.
 *  Laid out to match those pages: card with an inline add row + table. */
export default function WhitelistPage() {
  const { t } = useI18n();
  const { publishMessage, deviceSn, status } = useMqtt();
  const isDisabled = status !== 'connected' || !deviceSn;
  const [entries, setEntries] = useState<WhitelistEntry[]>([]);
  const [newPlate, setNewPlate] = useState('');
  const [newComment, setNewComment] = useState('');
  const [duration, setDuration] = useState<DurationChoice>('permanent');
  const [customExpiry, setCustomExpiry] = useState('');
  const [searchPlate, setSearchPlate] = useState('');

  const publish = (body: Record<string, unknown>) => {
    publishMessage('white_list_operator', {
      id: generateMessageId(),
      sn: deviceSn,
      name: 'white_list_operator',
      version: '1.0',
      timestamp: Math.floor(Date.now() / 1000),
      payload: { type: 'white_list_operator', body },
    });
  };

  const add = () => {
    const plate = newPlate.trim().toUpperCase();
    if (!plate) return;
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const overdue = computeExpiry(duration, customExpiry);
    publish({
      operator_type: 'update_or_add',
      dldb_rec: {
        plate,
        enable: 1,
        need_alarm: 0,
        enable_time: now,
        overdue_time: overdue || undefined,
        vehicle_comment: newComment || undefined,
      },
    });
    const entry: WhitelistEntry = {
      plate, enable: 1, createTime: now, enableTime: now, overdueTime: overdue,
      timeSegEnable: 0, segTimeStart: '00:00:00', segTimeEnd: '00:00:00',
      needAlarm: 0, vehicleCode: '', vehicleComment: newComment, customerId: undefined,
    };
    setEntries(prev => {
      const idx = prev.findIndex(e => e.plate === plate);
      if (idx >= 0) { const next = [...prev]; next[idx] = entry; return next; }
      return [entry, ...prev];
    });
    setNewPlate(''); setNewComment(''); setDuration('permanent'); setCustomExpiry('');
  };

  const remove = (plate: string) => {
    publish({ operator_type: 'delete', plate });
    setEntries(prev => prev.filter(e => e.plate !== plate));
  };

  const query = () => {
    const p = searchPlate.trim();
    if (p) publish({ operator_type: 'select', plate: p, sub_type: 'plate' });
  };

  const clearAll = () => {
    if (!confirm(t('whitelist.confirm_delete_all'))) return;
    publish({ operator_type: 'delete', plate: '' });
    setEntries([]);
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="space-y-4 max-w-3xl">
        <div className="bg-surface border border-border rounded-lg p-4">
          <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2 mb-1">
            <Shield className="w-4 h-4 text-green-500" /> {t('whitelist.title')}
          </h3>
          <p className="text-xs text-text-secondary mb-4">{t('whitelist.subtitle')}</p>

          <div className="flex gap-2">
            <input value={newPlate} onChange={e => setNewPlate(e.target.value)}
              placeholder={t('whitelist.form.plate_placeholder')}
              className="flex-1 px-3 py-2 bg-surface-dark border border-border rounded-md text-sm font-mono text-text-primary" />
            <input value={newComment} onChange={e => setNewComment(e.target.value)} maxLength={16}
              placeholder={t('whitelist.form.comment_placeholder')}
              className="flex-1 px-3 py-2 bg-surface-dark border border-border rounded-md text-sm text-text-primary" />
            <DurationPicker choice={duration} setChoice={setDuration} custom={customExpiry} setCustom={setCustomExpiry} />
            <button onClick={add} disabled={isDisabled || !newPlate.trim()}
              className="flex items-center gap-1 px-3 py-2 bg-primary text-white text-sm rounded-md hover:bg-primary/90 disabled:opacity-50">
              <Plus className="w-4 h-4" /> {t('whitelist.add')}
            </button>
          </div>

          <div className="flex items-center gap-2 mt-3 pt-3 border-t border-border">
            <input value={searchPlate} onChange={e => setSearchPlate(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') query(); }}
              placeholder={t('whitelist.search_placeholder')}
              className="w-48 px-3 py-1.5 bg-surface-dark border border-border rounded-md text-xs font-mono text-text-primary" />
            <button onClick={query} disabled={isDisabled || !searchPlate.trim()}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-text-secondary hover:text-text-primary border border-border rounded-md disabled:opacity-50">
              <Search className="w-3.5 h-3.5" /> {t('whitelist.query')}
            </button>
            <button onClick={clearAll} disabled={isDisabled}
              className="ml-auto flex items-center gap-1 px-2.5 py-1.5 text-xs text-danger border border-danger/40 rounded-md hover:bg-danger/10 disabled:opacity-50">
              <Trash2 className="w-3.5 h-3.5" /> {t('whitelist.clear_all')}
            </button>
          </div>
        </div>

        <div className="bg-surface border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-surface-dark text-text-secondary text-xs uppercase">
              <tr>
                <th className="text-left px-4 py-2">{t('whitelist.col.plate')}</th>
                <th className="text-left px-4 py-2">{t('whitelist.col.comment')}</th>
                <th className="text-left px-4 py-2">{t('whitelist.col.expiration')}</th>
                <th className="text-left px-4 py-2">{t('whitelist.col.status')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {entries.map(entry => (
                <tr key={entry.plate} className="border-t border-border">
                  <td className="px-4 py-2">
                    <span className="inline-flex items-center gap-1.5 font-mono font-medium text-text-primary">
                      <Shield className="w-3 h-3 text-green-500" /> {entry.plate}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-text-secondary">{entry.vehicleComment || '-'}</td>
                  <td className="px-4 py-2 text-text-secondary text-xs font-mono">
                    {entry.overdueTime || t('whitelist.permanent')}
                  </td>
                  <td className="px-4 py-2">
                    <span className="text-xs px-2 py-0.5 rounded bg-green-500/20 text-green-500">
                      {t('whitelist.enabled')}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button onClick={() => remove(entry.plate)} className="p-1 text-text-secondary hover:text-red-500">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
              {entries.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-text-secondary text-sm">
                    {t('whitelist.empty.title')}
                    <div className="text-xs mt-1 opacity-70">{t('whitelist.empty.desc')}</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
