import { useCallback, useEffect, useState } from 'react';
import {
  History, RefreshCw, Search, ChevronDown, ChevronRight,
  CheckCircle, XCircle, User, Filter, X,
} from 'lucide-react';
import {
  listAuditLog, getAuditLogFacets,
  type AuditLogEntry, type AuditLogFacets, type AuditLogQuery,
} from '../services/auditLogService';
import { useI18n } from '../contexts/I18nContext';

const PAGE_SIZE = 50;

export default function AuditLogPage() {
  const { t } = useI18n();
  const [rows, setRows] = useState<AuditLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState<AuditLogFacets | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Filters
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');
  const [status, setStatus] = useState<'' | 'success' | 'failed'>('');
  const [q, setQ] = useState('');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [offset, setOffset] = useState(0);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const query: AuditLogQuery = { limit: PAGE_SIZE, offset };
      if (actor) query.actor = actor;
      if (action) query.action = action;
      if (status) query.status = status;
      if (q) query.q = q;
      if (since) query.since = since;
      if (until) query.until = until;
      const data = await listAuditLog(query);
      setRows(data.items);
      setTotal(data.total);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [actor, action, status, q, since, until, offset]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    getAuditLogFacets().then(setFacets).catch(() => { /* facets are optional */ });
  }, []);

  const clearFilters = () => {
    setActor(''); setAction(''); setStatus(''); setQ('');
    setSince(''); setUntil(''); setOffset(0);
  };
  const hasFilters = actor || action || status || q || since || until;
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + PAGE_SIZE, total);

  const toggleRow = (id: number) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <div className="h-full flex flex-col bg-bg overflow-hidden">
      <header className="bg-surface border-b border-border px-6 py-4 shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-text-primary flex items-center gap-2">
              <History className="w-5 h-5 text-primary" /> {t('audit.title')}
            </h1>
            <p className="text-xs text-text-secondary mt-0.5">{t('audit.subtitle')}</p>
          </div>
          <button onClick={reload} disabled={loading}
            className="flex items-center gap-1 px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary border border-border rounded-md">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> {t('common.refresh')}
          </button>
        </div>
      </header>

      <div className="bg-surface border-b border-border px-6 py-3 shrink-0">
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2 items-end">
          <div>
            <label className="block text-[10px] text-text-secondary mb-1">{t('audit.filter.search')}</label>
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-text-secondary" />
              <input value={q} onChange={e => { setQ(e.target.value); setOffset(0); }}
                placeholder={t('audit.filter.search_ph')}
                className="w-full text-xs pl-7 pr-2 py-1.5 bg-surface-dark border border-border rounded text-text-primary" />
            </div>
          </div>
          <div>
            <label className="block text-[10px] text-text-secondary mb-1">{t('audit.filter.actor')}</label>
            <select value={actor} onChange={e => { setActor(e.target.value); setOffset(0); }}
              className="w-full text-xs px-2 py-1.5 bg-surface-dark border border-border rounded text-text-primary">
              <option value="">{t('common.all')}</option>
              {facets?.actors.map(a => (
                <option key={a.username} value={a.username}>{a.username} ({a.count})</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] text-text-secondary mb-1">{t('audit.filter.action')}</label>
            <select value={action} onChange={e => { setAction(e.target.value); setOffset(0); }}
              className="w-full text-xs px-2 py-1.5 bg-surface-dark border border-border rounded text-text-primary">
              <option value="">{t('common.all')}</option>
              {facets?.actions.map(a => (
                <option key={a.action} value={a.action}>{a.action} ({a.count})</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] text-text-secondary mb-1">{t('audit.filter.status')}</label>
            <select value={status} onChange={e => { setStatus(e.target.value as '' | 'success' | 'failed'); setOffset(0); }}
              className="w-full text-xs px-2 py-1.5 bg-surface-dark border border-border rounded text-text-primary">
              <option value="">{t('common.all')}</option>
              <option value="success">{t('audit.status.success')}</option>
              <option value="failed">{t('audit.status.failed')}</option>
            </select>
          </div>
          <div>
            <label className="block text-[10px] text-text-secondary mb-1">{t('audit.filter.since')}</label>
            <input type="datetime-local" value={since} onChange={e => { setSince(e.target.value); setOffset(0); }}
              className="w-full text-xs px-2 py-1.5 bg-surface-dark border border-border rounded text-text-primary" />
          </div>
          <div>
            <label className="block text-[10px] text-text-secondary mb-1">{t('audit.filter.until')}</label>
            <input type="datetime-local" value={until} onChange={e => { setUntil(e.target.value); setOffset(0); }}
              className="w-full text-xs px-2 py-1.5 bg-surface-dark border border-border rounded text-text-primary" />
          </div>
          <div>
            {hasFilters && (
              <button onClick={clearFilters}
                className="w-full flex items-center justify-center gap-1 px-2 py-1.5 text-xs text-text-secondary hover:text-text-primary border border-border rounded">
                <X className="w-3 h-3" /> {t('audit.filter.clear')}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {error && (
          <div className="bg-danger/10 border border-danger/30 rounded-lg p-3 text-sm text-danger mb-3">{error}</div>
        )}

        {rows.length === 0 && !loading && !error && (
          <div className="text-center py-12 text-text-secondary text-sm">
            <Filter className="w-8 h-8 mx-auto mb-2 opacity-50" />
            {hasFilters ? t('audit.empty.filtered') : t('audit.empty.none')}
          </div>
        )}

        {rows.length > 0 && (
          <div className="bg-surface border border-border rounded-lg overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-surface-dark text-text-secondary text-[10px] uppercase tracking-wider">
                <tr>
                  <th className="w-6"></th>
                  <th className="px-3 py-2 text-left">{t('audit.col.timestamp')}</th>
                  <th className="px-3 py-2 text-left">{t('audit.col.actor')}</th>
                  <th className="px-3 py-2 text-left">{t('audit.col.action')}</th>
                  <th className="px-3 py-2 text-left">{t('audit.col.channel')}</th>
                  <th className="px-3 py-2 text-left">{t('audit.col.status')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <Row key={r.id} row={r} expanded={expanded.has(r.id)} onToggle={() => toggleRow(r.id)} />
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex items-center justify-between mt-3 text-xs text-text-secondary">
          <div>{t('audit.pagination.summary', { start: pageStart, end: pageEnd, total })}</div>
          <div className="flex items-center gap-2">
            <button onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0}
              className="px-3 py-1 border border-border rounded disabled:opacity-40 hover:text-text-primary">
              {t('common.previous')}
            </button>
            <button onClick={() => setOffset(offset + PAGE_SIZE)} disabled={offset + PAGE_SIZE >= total}
              className="px-3 py-1 border border-border rounded disabled:opacity-40 hover:text-text-primary">
              {t('common.next')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ row, expanded, onToggle }: { row: AuditLogEntry; expanded: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  const ts = new Date(row.created_at);
  const hasPayload = row.request_payload || row.response_payload || row.error_message;
  return (
    <>
      <tr className={`border-t border-border ${expanded ? 'bg-surface-dark' : 'hover:bg-surface-dark/50'}`}>
        <td className="px-2">
          {hasPayload && (
            <button onClick={onToggle} className="text-text-secondary hover:text-text-primary">
              {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            </button>
          )}
        </td>
        <td className="px-3 py-2 font-mono text-text-secondary whitespace-nowrap">
          {ts.toLocaleString()}
        </td>
        <td className="px-3 py-2">
          {row.actor_username ? (
            <span className="inline-flex items-center gap-1 text-text-primary">
              <User className="w-3 h-3 text-text-secondary" /> {row.actor_username}
            </span>
          ) : (
            <span className="text-text-secondary italic">{t('audit.actor.system')}</span>
          )}
        </td>
        <td className="px-3 py-2 font-mono text-text-primary">{row.action}</td>
        <td className="px-3 py-2 text-text-secondary">
          {row.channel_no ?? <span className="opacity-40">—</span>}
          {row.inspection_id != null && (
            <span className="ml-1 text-[10px] opacity-60">#{row.inspection_id}</span>
          )}
        </td>
        <td className="px-3 py-2">
          {row.status === 'success' ? (
            <span className="inline-flex items-center gap-1 text-green-300">
              <CheckCircle className="w-3 h-3" /> {t('audit.status.success')}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-red-300">
              <XCircle className="w-3 h-3" /> {t('audit.status.failed')}
            </span>
          )}
        </td>
      </tr>
      {expanded && hasPayload && (
        <tr className="border-t border-border bg-surface-dark">
          <td></td>
          <td colSpan={5} className="px-3 py-2 space-y-1.5">
            {row.error_message && (
              <Detail label={t('audit.detail.error')}>
                <span className="text-danger font-mono">{row.error_message}</span>
              </Detail>
            )}
            {row.request_payload != null && (
              <Detail label={t('audit.detail.request')}>
                <pre className="font-mono text-[10px] text-text-primary bg-bg border border-border rounded p-2 overflow-x-auto max-h-48">
                  {JSON.stringify(row.request_payload, null, 2)}
                </pre>
              </Detail>
            )}
            {row.response_payload != null && (
              <Detail label={t('audit.detail.response')}>
                <pre className="font-mono text-[10px] text-text-primary bg-bg border border-border rounded p-2 overflow-x-auto max-h-48">
                  {JSON.stringify(row.response_payload, null, 2)}
                </pre>
              </Detail>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-text-secondary mb-0.5">{label}</div>
      {children}
    </div>
  );
}
