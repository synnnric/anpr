import { useCallback, useEffect, useState } from 'react';
import { Search, RefreshCw, Car, LogIn, LogOut, AlertTriangle, ShieldAlert } from 'lucide-react';
import { listVisits, visitSummary } from '../services/s300Service';
import type { Visit, VisitStatus, VisitSummary } from '../types/s300';
import { fmtPgTs, parsePgTs } from '../utils/helpers';
import { useI18n } from '../contexts/I18nContext';
import type { TKey } from '../i18n/translations';

const VISIT_STATUS_STYLE: Record<VisitStatus, { bg: string; text: string; key: TKey }> = {
  active:       { bg: 'bg-blue-500/20 border border-blue-500/50',       text: 'text-blue-300',  key: 'visits.status.active' },
  completed:    { bg: 'bg-green-500/20 border border-green-500/50',     text: 'text-green-300', key: 'visits.status.completed' },
  orphan_exit:  { bg: 'bg-red-500/20 border border-red-500/50',         text: 'text-red-400',   key: 'visits.status.orphan_exit' },
  denied_entry: { bg: 'bg-amber-500/20 border border-amber-500/50',     text: 'text-amber-400', key: 'visits.status.denied_entry' },
};

export default function VisitsPage() {
  const { t } = useI18n();
  const [visits, setVisits] = useState<Visit[]>([]);
  const [summary, setSummary] = useState<VisitSummary | null>(null);
  const [statusFilter, setStatusFilter] = useState<VisitStatus | 'all'>('all');
  const [plateFilter, setPlateFilter] = useState('');
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string | number> = { limit: 200 };
      if (statusFilter !== 'all') params.status = statusFilter;
      if (plateFilter.trim()) params.plate = plateFilter.trim();
      const [vRes, sRes] = await Promise.all([listVisits(params), visitSummary()]);
      setVisits(vRes.items);
      setSummary(sRes);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, plateFilter]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    const tm = setInterval(reload, 5000);
    return () => clearInterval(tm);
  }, [reload]);

  return (
    <div className="h-full flex flex-col bg-bg overflow-hidden">
      <header className="bg-surface border-b border-border px-6 py-4 shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-text-primary flex items-center gap-2">
              <Car className="w-5 h-5 text-primary" /> {t('visits.title')}
            </h1>
            <p className="text-xs text-text-secondary mt-0.5">
              {t('visits.subtitle')}
            </p>
          </div>
          <button onClick={reload} disabled={loading}
            className="flex items-center gap-1 px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary border border-border rounded-md">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> {t('common.refresh')}
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {summary && (
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
            <StatCard icon={Car} label={t('visits.stat.inside')} value={summary.active} color="text-blue-300" />
            <StatCard icon={LogIn} label={t('visits.stat.entered')} value={summary.entered_today} color="text-green-300" />
            <StatCard icon={LogOut} label={t('visits.stat.exited')} value={summary.completed_today} color="text-emerald-300" />
            <StatCard icon={Car} label={t('visits.stat.completed_total')} value={summary.completed_total} color="text-text-secondary" />
            <StatCard icon={AlertTriangle} label={t('visits.stat.orphan_today')} value={summary.orphan_exits_today} color="text-red-400" />
            <StatCard icon={ShieldAlert} label={t('visits.stat.denied_today')} value={summary.denied_entries_today} color="text-amber-400" />
          </div>
        )}

        <div className="bg-surface border border-border rounded-lg p-3 flex gap-2 items-center">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-secondary" />
            <input value={plateFilter} onChange={e => setPlateFilter(e.target.value)}
              placeholder={t('visits.search_placeholder')}
              className="w-full bg-surface-dark border border-border rounded-md pl-9 pr-3 py-1.5 text-sm text-text-primary" />
          </div>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as VisitStatus | 'all')}
            className="bg-surface-dark border border-border rounded-md px-3 py-1.5 text-sm text-text-primary">
            <option value="all">{t('visits.filter.all')}</option>
            <option value="active">{t('visits.filter.active')}</option>
            <option value="completed">{t('visits.filter.completed')}</option>
            <option value="orphan_exit">{t('visits.filter.orphan')}</option>
            <option value="denied_entry">{t('visits.filter.denied')}</option>
          </select>
        </div>

        <div className="bg-surface border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-surface-dark text-text-secondary text-xs uppercase">
              <tr>
                <th className="text-left px-4 py-2">{t('visits.col.id')}</th>
                <th className="text-left px-4 py-2">{t('visits.col.plate')}</th>
                <th className="text-left px-4 py-2">{t('visits.col.status')}</th>
                <th className="text-left px-4 py-2">{t('visits.col.entry')}</th>
                <th className="text-left px-4 py-2">{t('visits.col.exit')}</th>
                <th className="text-left px-4 py-2">{t('visits.col.dwell')}</th>
                <th className="text-left px-4 py-2">{t('visits.col.notes')}</th>
              </tr>
            </thead>
            <tbody>
              {visits.map(v => {
                const meta = VISIT_STATUS_STYLE[v.status];
                const dwell = computeDwell(v);
                return (
                  <tr key={v.id} className="border-t border-border">
                    <td className="px-4 py-2 text-text-secondary font-mono">#{v.id}</td>
                    <td className="px-4 py-2 font-mono text-text-primary">{v.license_plate}</td>
                    <td className="px-4 py-2">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${meta.bg} ${meta.text}`}>
                        {t(meta.key)}
                      </span>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-text-secondary">
                      {v.entry_at ? <span>{fmtPgTs(v.entry_at)}<br /><span className="text-[10px] text-text-secondary/70">{t('visits.via', { ch: v.entry_channel_no ?? '' })}</span></span> : '-'}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-text-secondary">
                      {v.exit_at ? <span>{fmtPgTs(v.exit_at)}<br /><span className="text-[10px] text-text-secondary/70">{t('visits.via', { ch: v.exit_channel_no ?? '' })}</span></span> : '-'}
                    </td>
                    <td className="px-4 py-2 text-xs text-text-secondary">{dwell}</td>
                    <td className="px-4 py-2 text-xs text-text-secondary italic max-w-xs truncate">{v.notes || ''}</td>
                  </tr>
                );
              })}
              {visits.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-text-secondary text-sm">{t('visits.empty')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, color }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="bg-surface border border-border rounded-lg p-3">
      <div className="flex items-center gap-2 text-[10px] text-text-secondary uppercase tracking-wide">
        <Icon className={`w-3.5 h-3.5 ${color}`} /> {label}
      </div>
      <div className={`text-2xl font-bold mt-1 ${color}`}>{value ?? 0}</div>
    </div>
  );
}

function computeDwell(v: Visit): string {
  const startD = parsePgTs(v.entry_at);
  if (!startD) return '-';
  const start = startD.getTime();
  const endD = parsePgTs(v.exit_at);
  const end = endD ? endD.getTime() : Date.now();
  const sec = Math.max(0, Math.floor((end - start) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}
