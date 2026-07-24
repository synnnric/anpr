import { useState } from 'react';
import { MessageSquare, Trash2, ArrowUpCircle, ArrowDownCircle, Filter, Copy, Check } from 'lucide-react';
import { useMqtt } from '../contexts/MqttContext';
import { useI18n } from '../contexts/I18nContext';

export default function MessageLogPage() {
  const { t } = useI18n();
  const { messageLog, clearMessageLog } = useMqtt();
  const [filter, setFilter] = useState<'all' | 'sent' | 'received'>('all');
  const [nameFilter, setNameFilter] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const filtered = messageLog.filter((m) => {
    if (filter !== 'all' && m.direction !== filter) return false;
    if (nameFilter && !m.name.toLowerCase().includes(nameFilter.toLowerCase())) return false;
    return true;
  });

  const handleCopy = (id: string, payload: string) => {
    navigator.clipboard.writeText(payload);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const formatJson = (str: string): string => {
    try {
      return JSON.stringify(JSON.parse(str), null, 2);
    } catch {
      return str;
    }
  };

  const filterLabel = (f: 'all' | 'sent' | 'received') =>
    f === 'all' ? t('messages.filter.all') : f === 'sent' ? t('messages.filter.sent') : t('messages.filter.received');

  return (
    <div className="p-6 h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-bold text-text-primary">{t('messages.title')}</h2>
          <p className="text-sm text-text-secondary">{t('messages.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 bg-surface border border-border rounded-lg p-0.5">
            {(['all', 'sent', 'received'] as const).map((f) => (
              <button key={f} onClick={() => setFilter(f)}
                className={`px-3 py-1.5 text-xs rounded-md transition-colors capitalize ${
                  filter === f ? 'bg-primary text-white' : 'text-text-secondary hover:text-text-primary'
                }`}>
                {filterLabel(f)}
              </button>
            ))}
          </div>
          <div className="relative">
            <Filter className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-secondary" />
            <input
              type="text"
              value={nameFilter}
              onChange={(e) => setNameFilter(e.target.value)}
              placeholder={t('messages.filter_placeholder')}
              className="bg-surface border border-border rounded-lg pl-8 pr-3 py-2 text-xs text-text-primary placeholder-text-secondary/50 focus:outline-none focus:border-primary-light w-40"
            />
          </div>
          <button onClick={clearMessageLog}
            className="flex items-center gap-1.5 px-3 py-2 text-xs text-text-secondary hover:text-danger border border-border rounded-lg hover:border-danger/50 transition-colors">
            <Trash2 className="w-3.5 h-3.5" /> {t('messages.clear')}
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <MessageSquare className="w-16 h-16 text-surface-light mx-auto mb-4" />
            <p className="text-text-secondary text-sm">{t('messages.empty')}</p>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto space-y-1">
          {filtered.map((msg) => (
            <div key={msg.id} className="bg-surface border border-border rounded-lg overflow-hidden">
              <div
                className="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-surface-light/30 transition-colors"
                onClick={() => setExpandedId(expandedId === msg.id ? null : msg.id)}
              >
                {msg.direction === 'sent' ? (
                  <ArrowUpCircle className="w-4 h-4 text-primary-light shrink-0" />
                ) : (
                  <ArrowDownCircle className="w-4 h-4 text-success shrink-0" />
                )}
                <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${
                  msg.direction === 'sent' ? 'bg-primary/20 text-primary-light' : 'bg-success/20 text-success'
                }`}>
                  {msg.direction === 'sent' ? t('messages.tag.pub') : t('messages.tag.sub')}
                </span>
                <span className="text-xs font-mono text-accent truncate flex-1">{msg.name}</span>
                <span className="text-[10px] text-text-secondary font-mono truncate max-w-[300px]" title={msg.topic}>
                  {msg.topic}
                </span>
                <span className="text-[10px] text-text-secondary shrink-0">
                  {msg.timestamp.toLocaleTimeString()}
                </span>
              </div>

              {expandedId === msg.id && (
                <div className="border-t border-border bg-surface-dark p-4">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[10px] text-text-secondary font-mono">{msg.topic}</p>
                    <button onClick={() => handleCopy(msg.id, msg.payload)}
                      className="flex items-center gap-1 px-2 py-1 text-[10px] text-text-secondary hover:text-text-primary border border-border rounded transition-colors">
                      {copiedId === msg.id ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
                      {copiedId === msg.id ? t('messages.copied') : t('messages.copy')}
                    </button>
                  </div>
                  <pre className="text-xs font-mono text-text-primary bg-surface-dark p-3 rounded-lg overflow-x-auto max-h-[400px] overflow-y-auto whitespace-pre-wrap break-all">
                    {formatJson(msg.payload)}
                  </pre>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
