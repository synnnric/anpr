import { useState } from 'react';
import { Shield, Plus, Trash2, Search, Edit, X, Save } from 'lucide-react';
import { useMqtt } from '../contexts/MqttContext';
import { generateMessageId } from '../utils/helpers';
import type { WhitelistEntry } from '../types/mqtt';
import { useI18n } from '../contexts/I18nContext';

export default function WhitelistPage() {
  const { t } = useI18n();
  const { publishMessage, deviceSn, status } = useMqtt();
  const isDisabled = status !== 'connected' || !deviceSn;
  const [entries, setEntries] = useState<WhitelistEntry[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [searchPlate, setSearchPlate] = useState('');
  const [editEntry, setEditEntry] = useState<WhitelistEntry | null>(null);

  const defaultEntry: WhitelistEntry = {
    plate: '',
    enable: 1,
    createTime: new Date().toISOString().slice(0, 19).replace('T', ' '),
    enableTime: '',
    overdueTime: '',
    timeSegEnable: 0,
    segTimeStart: '00:00:00',
    segTimeEnd: '00:00:00',
    needAlarm: 0,
    vehicleCode: '',
    vehicleComment: '',
    customerId: undefined,
  };

  const handleAddOrUpdate = (entry: WhitelistEntry) => {
    publishMessage('white_list_operator', {
      id: generateMessageId(),
      sn: deviceSn,
      name: 'white_list_operator',
      version: '1.0',
      timestamp: Math.floor(Date.now() / 1000),
      payload: {
        type: 'white_list_operator',
        body: {
          operator_type: 'update_or_add',
          dldb_rec: {
            plate: entry.plate,
            enable: entry.enable,
            create_time: entry.createTime,
            enable_time: entry.enableTime || undefined,
            overdue_time: entry.overdueTime || undefined,
            time_seg_enable: entry.timeSegEnable,
            seg_time_start: entry.segTimeStart,
            seg_time_end: entry.segTimeEnd,
            need_alarm: entry.needAlarm,
            vehicle_code: entry.vehicleCode || undefined,
            vehicle_comment: entry.vehicleComment || undefined,
            customer_id: entry.customerId || undefined,
          },
        },
      },
    });
    setEntries((prev) => {
      const idx = prev.findIndex((e) => e.plate === entry.plate);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = entry;
        return next;
      }
      return [entry, ...prev];
    });
    setShowForm(false);
    setEditEntry(null);
  };

  const handleDelete = (plate: string) => {
    publishMessage('white_list_operator', {
      id: generateMessageId(),
      sn: deviceSn,
      name: 'white_list_operator',
      version: '1.0',
      timestamp: Math.floor(Date.now() / 1000),
      payload: {
        type: 'white_list_operator',
        body: { operator_type: 'delete', plate },
      },
    });
    setEntries((prev) => prev.filter((e) => e.plate !== plate));
  };

  const handleQuery = () => {
    if (!searchPlate) return;
    publishMessage('white_list_operator', {
      id: generateMessageId(),
      sn: deviceSn,
      name: 'white_list_operator',
      version: '1.0',
      timestamp: Math.floor(Date.now() / 1000),
      payload: {
        type: 'white_list_operator',
        body: { operator_type: 'select', plate: searchPlate, sub_type: 'plate' },
      },
    });
  };

  const handleDeleteAll = () => {
    if (!confirm(t('whitelist.confirm_delete_all'))) return;
    publishMessage('white_list_operator', {
      id: generateMessageId(),
      sn: deviceSn,
      name: 'white_list_operator',
      version: '1.0',
      timestamp: Math.floor(Date.now() / 1000),
      payload: {
        type: 'white_list_operator',
        body: { operator_type: 'delete', plate: '' },
      },
    });
    setEntries([]);
  };

  return (
    <div className="p-6 h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-bold text-text-primary">{t('whitelist.title')}</h2>
          <p className="text-sm text-text-secondary">{t('whitelist.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <input
              type="text"
              value={searchPlate}
              onChange={(e) => setSearchPlate(e.target.value)}
              placeholder={t('whitelist.search_placeholder')}
              className="input-sm w-40"
            />
            <button onClick={handleQuery} disabled={isDisabled || !searchPlate}
              className="p-2 bg-surface-light border border-border rounded-lg hover:border-primary-light/50 transition-colors disabled:opacity-50">
              <Search className="w-4 h-4 text-text-secondary" />
            </button>
          </div>
          <button onClick={() => { setEditEntry(null); setShowForm(true); }} disabled={isDisabled}
            className="flex items-center gap-1.5 px-3 py-2 text-sm bg-primary hover:bg-primary-light text-white rounded-lg transition-colors disabled:opacity-50">
            <Plus className="w-4 h-4" /> {t('whitelist.add')}
          </button>
          <button onClick={handleDeleteAll} disabled={isDisabled}
            className="flex items-center gap-1.5 px-3 py-2 text-sm text-danger border border-border rounded-lg hover:border-danger/50 transition-colors disabled:opacity-50">
            <Trash2 className="w-4 h-4" /> {t('whitelist.clear_all')}
          </button>
        </div>
      </div>

      {showForm && (
        <WhitelistForm
          initial={editEntry || defaultEntry}
          onSave={handleAddOrUpdate}
          onCancel={() => { setShowForm(false); setEditEntry(null); }}
        />
      )}

      {entries.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <Shield className="w-16 h-16 text-surface-light mx-auto mb-4" />
            <p className="text-text-secondary text-sm">{t('whitelist.empty.title')}</p>
            <p className="text-text-secondary text-xs mt-1">{t('whitelist.empty.desc')}</p>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] text-text-secondary uppercase tracking-wider border-b border-border">
                <th className="pb-2 px-3">{t('whitelist.col.plate')}</th>
                <th className="pb-2 px-3">{t('whitelist.col.type')}</th>
                <th className="pb-2 px-3">{t('whitelist.col.status')}</th>
                <th className="pb-2 px-3">{t('whitelist.col.expiration')}</th>
                <th className="pb-2 px-3">{t('whitelist.col.timeseg')}</th>
                <th className="pb-2 px-3">{t('whitelist.col.comment')}</th>
                <th className="pb-2 px-3">{t('whitelist.col.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.plate} className="border-b border-border/50 hover:bg-surface-light/50">
                  <td className="py-2.5 px-3 font-mono font-semibold text-text-primary">{entry.plate}</td>
                  <td className="py-2.5 px-3">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                      entry.needAlarm === 0 ? 'bg-success/20 text-success' : 'bg-danger/20 text-danger'
                    }`}>
                      {entry.needAlarm === 0 ? t('whitelist.type.white') : t('whitelist.type.black')}
                    </span>
                  </td>
                  <td className="py-2.5 px-3">
                    <span className={`text-xs ${entry.enable ? 'text-success' : 'text-text-secondary'}`}>
                      {entry.enable ? t('whitelist.enabled') : t('whitelist.disabled')}
                    </span>
                  </td>
                  <td className="py-2.5 px-3 text-xs text-text-secondary">{entry.overdueTime || t('whitelist.permanent')}</td>
                  <td className="py-2.5 px-3 text-xs text-text-secondary">
                    {entry.timeSegEnable ? `${entry.segTimeStart} - ${entry.segTimeEnd}` : t('whitelist.timeseg.off')}
                  </td>
                  <td className="py-2.5 px-3 text-xs text-text-secondary truncate max-w-[120px]">{entry.vehicleComment || '-'}</td>
                  <td className="py-2.5 px-3">
                    <div className="flex items-center gap-1">
                      <button onClick={() => { setEditEntry(entry); setShowForm(true); }}
                        className="p-1 hover:bg-surface-light rounded transition-colors" title={t('whitelist.action.edit')}>
                        <Edit className="w-3.5 h-3.5 text-text-secondary" />
                      </button>
                      <button onClick={() => handleDelete(entry.plate)}
                        className="p-1 hover:bg-danger/20 rounded transition-colors" title={t('whitelist.action.delete')}>
                        <Trash2 className="w-3.5 h-3.5 text-danger" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function WhitelistForm({ initial, onSave, onCancel }: {
  initial: WhitelistEntry;
  onSave: (entry: WhitelistEntry) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [entry, setEntry] = useState<WhitelistEntry>(initial);
  const update = (patch: Partial<WhitelistEntry>) => setEntry((prev) => ({ ...prev, ...patch }));

  return (
    <div className="bg-surface border border-primary-light/30 rounded-xl p-5 mb-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-text-primary">
          {initial.plate ? t('whitelist.form.edit_title') : t('whitelist.form.add_title')}
        </h3>
        <button onClick={onCancel} className="p-1 hover:bg-surface-light rounded transition-colors">
          <X className="w-4 h-4 text-text-secondary" />
        </button>
      </div>
      <div className="grid grid-cols-3 gap-4 mb-4">
        <div>
          <label className="text-[10px] text-text-secondary">{t('whitelist.form.plate')}</label>
          <input type="text" value={entry.plate} onChange={(e) => update({ plate: e.target.value })}
            placeholder={t('whitelist.form.plate_placeholder')} className="input-sm w-full" />
        </div>
        <div>
          <label className="text-[10px] text-text-secondary">{t('whitelist.form.type')}</label>
          <select value={entry.needAlarm} onChange={(e) => update({ needAlarm: Number(e.target.value) })} className="input-sm w-full">
            <option value={0}>{t('whitelist.type.white')}</option>
            <option value={1}>{t('whitelist.type.black')}</option>
          </select>
        </div>
        <div>
          <label className="text-[10px] text-text-secondary">{t('whitelist.form.enabled')}</label>
          <select value={entry.enable} onChange={(e) => update({ enable: Number(e.target.value) })} className="input-sm w-full">
            <option value={1}>{t('common.yes')}</option>
            <option value={0}>{t('common.no')}</option>
          </select>
        </div>
        <div>
          <label className="text-[10px] text-text-secondary">{t('whitelist.form.enable_time')}</label>
          <input type="text" value={entry.enableTime} onChange={(e) => update({ enableTime: e.target.value })}
            placeholder="2024-12-31 23:59:59" className="input-sm w-full" />
        </div>
        <div>
          <label className="text-[10px] text-text-secondary">{t('whitelist.form.expiration')}</label>
          <input type="text" value={entry.overdueTime} onChange={(e) => update({ overdueTime: e.target.value })}
            placeholder={t('whitelist.form.expiration_placeholder')} className="input-sm w-full" />
        </div>
        <div>
          <label className="text-[10px] text-text-secondary">{t('whitelist.form.timeseg')}</label>
          <select value={entry.timeSegEnable} onChange={(e) => update({ timeSegEnable: Number(e.target.value) })} className="input-sm w-full">
            <option value={0}>{t('whitelist.disabled')}</option>
            <option value={1}>{t('whitelist.enabled')}</option>
          </select>
        </div>
        {entry.timeSegEnable === 1 && (
          <>
            <div>
              <label className="text-[10px] text-text-secondary">{t('whitelist.form.seg_start')}</label>
              <input type="text" value={entry.segTimeStart} onChange={(e) => update({ segTimeStart: e.target.value })}
                placeholder="HH:MM:SS" className="input-sm w-full" />
            </div>
            <div>
              <label className="text-[10px] text-text-secondary">{t('whitelist.form.seg_end')}</label>
              <input type="text" value={entry.segTimeEnd} onChange={(e) => update({ segTimeEnd: e.target.value })}
                placeholder="HH:MM:SS" className="input-sm w-full" />
            </div>
          </>
        )}
        <div>
          <label className="text-[10px] text-text-secondary">{t('whitelist.form.comment')}</label>
          <input type="text" value={entry.vehicleComment} onChange={(e) => update({ vehicleComment: e.target.value })}
            placeholder={t('whitelist.form.comment_placeholder')} className="input-sm w-full" maxLength={16} />
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <button onClick={onCancel}
          className="px-4 py-2 text-sm text-text-secondary border border-border rounded-lg hover:bg-surface-light transition-colors">
          {t('common.cancel')}
        </button>
        <button onClick={() => entry.plate && onSave(entry)} disabled={!entry.plate}
          className="flex items-center gap-1.5 px-4 py-2 text-sm bg-primary hover:bg-primary-light text-white rounded-lg transition-colors disabled:opacity-50">
          <Save className="w-4 h-4" /> {t('common.save')}
        </button>
      </div>
    </div>
  );
}
