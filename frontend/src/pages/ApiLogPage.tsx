import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Loader2, AlertCircle, Radio, ChevronDown, ChevronRight } from 'lucide-react';
import { getApiLog, type ApiLogEvent } from '../services/apiLogService';
import { useI18n } from '../contexts/I18nContext';

const ENDPOINT_COLORS: Record<string, string> = {
  'work-status': 'bg-blue-500/15 text-blue-400',
  'face-image': 'bg-purple-500/15 text-purple-400',
  'uvis': 'bg-amber-500/15 text-amber-400',
  'x-ray': 'bg-red-500/15 text-red-400',
  'video-real-time': 'bg-green-500/15 text-green-400',
  'video-record': 'bg-teal-500/15 text-teal-400',
  'reset-complete': 'bg-slate-500/15 text-slate-300',
};

const PAGE_SIZE = 50;

export default function ApiLogPage() {
  const { t } = useI18n();
  const [events, setEvents] = useState<ApiLogEvent[]>([]);
  const [endpoints, setEndpoints] = useState<string[]>([]);
  const [filter, setFilter] = useState('all');
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);

  const fetchLog = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const r = await getApiLog(filter, PAGE_SIZE, offset);
      setEvents(r.events);
      setEndpoints(r.endpoints);
      setTotal(r.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed');
    } finally {
      setLoading(false);
    }
  }, [filter, offset]);

  useEffect(() => { fetchLog(); }, [fetchLog]);

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + PAGE_SIZE, total);

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="flex items-center gap-2 mb-1">
        <Radio className="w-5 h-5 text-primary" />
        <h2 className="text-xl font-bold text-text-primary">{t('apilog.title')}</h2>
        <button onClick={fetchLog} disabled={loading}
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-xs bg-surface-light border border-border text-text-secondary hover:text-text-primary rounded-lg transition-colors disabled:opacity-50">
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          {t('common.refresh')}
        </button>
      </div>
      <p className="text-sm text-text-secondary mb-4">{t('apilog.subtitle')}</p>

      {error && (
        <div className="flex items-center gap-2 bg-danger/10 border border-danger/30 rounded-lg p-2.5 text-xs text-danger mb-4">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {/* Endpoint filter */}
      <div className="flex flex-wrap items-center gap-1.5 mb-4">
        {['all', ...endpoints].map(ep => (
          <button key={ep} onClick={() => { setFilter(ep); setOffset(0); }}
            className={`px-2.5 py-1 text-xs rounded-full transition-colors ${
              filter === ep ? 'bg-primary text-white' : 'bg-surface-light text-text-secondary hover:text-text-primary'
            }`}>
            {ep}
          </button>
        ))}
      </div>

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-surface-light text-text-secondary">
            <tr>
              <th className="text-left px-3 py-2 font-medium w-8"></th>
              <th className="text-left px-3 py-2 font-medium">{t('apilog.col.endpoint')}</th>
              <th className="text-left px-3 py-2 font-medium">{t('apilog.col.channel')}</th>
              <th className="text-left px-3 py-2 font-medium">cmd</th>
              <th className="text-left px-3 py-2 font-medium">{t('apilog.col.source')}</th>
              <th className="text-left px-3 py-2 font-medium">{t('apilog.col.size')}</th>
              <th className="text-left px-3 py-2 font-medium">{t('apilog.col.time')}</th>
            </tr>
          </thead>
          <tbody>
            {events.length === 0 && !loading && (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-text-secondary">{t('apilog.empty')}</td></tr>
            )}
            {events.map(e => (
              <>
                <tr key={e.id} onClick={() => setExpanded(expanded === e.id ? null : e.id)}
                  className="border-t border-border hover:bg-surface-light/50 cursor-pointer">
                  <td className="px-3 py-2 text-text-secondary">
                    {expanded === e.id ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`px-2 py-0.5 rounded-full ${ENDPOINT_COLORS[e.endpoint] || 'bg-surface-light text-text-secondary'}`}>
                      {e.endpoint}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-text-primary font-mono">{e.channel_no || '—'}</td>
                  <td className="px-3 py-2 text-text-secondary">{e.cmd_no ?? '—'}</td>
                  <td className="px-3 py-2 text-text-secondary font-mono">{e.source_ip || '—'}</td>
                  <td className="px-3 py-2 text-text-secondary">{e.body_len ? `${(e.body_len / 1024).toFixed(1)}kb` : '—'}</td>
                  <td className="px-3 py-2 text-text-secondary font-mono">{e.received_at?.slice(0, 23)}</td>
                </tr>
                {expanded === e.id && (
                  <tr key={`${e.id}-body`} className="border-t border-border bg-surface-dark">
                    <td colSpan={7} className="px-3 py-2">
                      <pre className="text-[10px] text-text-secondary font-mono whitespace-pre-wrap break-all max-h-64 overflow-y-auto">
                        {e.body_preview || '(empty body)'}
                        {e.body_len && e.body_preview && e.body_len > e.body_preview.length ? `\n… (${e.body_len - e.body_preview.length} more bytes)` : ''}
                      </pre>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between mt-3 text-xs text-text-secondary">
        <div>{t('apilog.pagination.summary', { start: pageStart, end: pageEnd, total })}</div>
        <div className="flex items-center gap-2">
          <button onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0 || loading}
            className="px-3 py-1 border border-border rounded disabled:opacity-40 hover:text-text-primary">
            {t('common.previous')}
          </button>
          <button onClick={() => setOffset(offset + PAGE_SIZE)} disabled={offset + PAGE_SIZE >= total || loading}
            className="px-3 py-1 border border-border rounded disabled:opacity-40 hover:text-text-primary">
            {t('common.next')}
          </button>
        </div>
      </div>
    </div>
  );
}
