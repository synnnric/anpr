import { useState, useEffect, useCallback, useRef } from 'react';
import {
  ArrowUp, ArrowDown, RefreshCw, Wifi, WifiOff, Server, Hash,
  Loader2, Columns3, CircleDot, Layers, AlertCircle, Globe
} from 'lucide-react';
import type { RoadBlockerConfig, ColumnStatusMap } from '../types/roadblocker';
import { getDeviceStatus, sendOperation } from '../services/roadBlockerService';
import { useI18n } from '../contexts/I18nContext';
import type { TKey } from '../i18n/translations';

const DEFAULT_RB_CONFIG: RoadBlockerConfig = { ip: '127.0.0.1', port: 8088, deviceNo: 'DEV001' };

const COLUMN_STATUS: Record<number, { key: TKey; color: string; icon: string }> = {
  0: { key: 'rb.col.unknown',    color: 'text-text-secondary', icon: 'bg-gray-500' },
  1: { key: 'rb.col.descending', color: 'text-amber-400',      icon: 'bg-amber-400' },
  3: { key: 'rb.col.lowered',    color: 'text-green-400',      icon: 'bg-green-400' },
  5: { key: 'rb.col.rising',     color: 'text-blue-400',       icon: 'bg-blue-400' },
  7: { key: 'rb.col.raised',     color: 'text-red-400',        icon: 'bg-red-400' },
};

function getColStatus(code: number) {
  return COLUMN_STATUS[code] || COLUMN_STATUS[0];
}

export default function RoadBlockerPage() {
  const { t } = useI18n();
  const [config, setConfig] = useState<RoadBlockerConfig>(() => {
    const saved = localStorage.getItem('roadblocker_config');
    if (!saved) return DEFAULT_RB_CONFIG;
    try {
      const parsed = JSON.parse(saved) as RoadBlockerConfig;
      if (parsed.ip === '192.168.1.100') {
        return { ...parsed, ip: DEFAULT_RB_CONFIG.ip,
                 deviceNo: parsed.deviceNo || DEFAULT_RB_CONFIG.deviceNo };
      }
      return parsed;
    } catch {
      return DEFAULT_RB_CONFIG;
    }
  });
  const [online, setOnline] = useState<boolean | null>(null);
  const [columns, setColumns] = useState<ColumnStatusMap>({});
  const [loading, setLoading] = useState(false);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState('');
  const [opResult, setOpResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    localStorage.setItem('roadblocker_config', JSON.stringify(config));
  }, [config]);

  const fetchStatus = useCallback(async () => {
    if (!config.deviceNo || !config.ip) return;
    setLoading(true);
    setError('');
    try {
      const res = await getDeviceStatus(config);
      if (res.code === 200 && res.data) {
        setOnline(res.data.controlTheDeviceOnline);
        setColumns(res.data.liftingColumnsStatus || {});
      } else {
        setError(res.msg || t('rb.err.get_status'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('rb.err.connection'));
      setOnline(null);
    } finally {
      setLoading(false);
    }
  }, [config, t]);

  const togglePolling = useCallback(() => {
    if (polling) {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      setPolling(false);
    } else {
      fetchStatus();
      pollRef.current = setInterval(fetchStatus, 3000);
      setPolling(true);
    }
  }, [polling, fetchStatus]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const handleOperation = async (
    operationType: 'device_level' | 'ip_level' | 'liftingColumn_level',
    action: 'up' | 'down',
    boardId?: string,
    boardPaths?: number,
    columnNum?: number,
  ) => {
    if (!config.deviceNo) return;
    setOpResult(null);
    try {
      const ipCode: Record<string, number> = {};
      if (operationType === 'device_level') {
        Object.entries(columns).forEach(([bid, cols]) => {
          ipCode[bid] = Object.keys(cols).length;
        });
      } else if (boardId && boardPaths !== undefined) {
        ipCode[boardId] = boardPaths;
      }

      const req = {
        deviceNo: config.deviceNo,
        ipCode,
        operationType,
        action,
        ...(columnNum !== undefined ? { liftingColumnNum: columnNum } : {}),
      };

      const res = await sendOperation(config, req);
      setOpResult({ ok: res.code === 200, msg: res.msg });
      setTimeout(() => fetchStatus(), 500);
    } catch (err) {
      setOpResult({ ok: false, msg: err instanceof Error ? err.message : t('rb.err.operation') });
    }
    setTimeout(() => setOpResult(null), 4000);
  };

  const boardEntries = Object.entries(columns);

  return (
    <div className="h-full overflow-y-auto p-6">
      <h2 className="text-xl font-bold text-text-primary mb-1">{t('rb.title')}</h2>
      <p className="text-sm text-text-secondary mb-6">{t('rb.subtitle')}</p>

      {/* Connection Config */}
      <div className="bg-surface border border-border rounded-xl p-5 mb-4">
        <div className="flex items-center gap-2 mb-4">
          <Server className="w-4 h-4 text-primary-light" />
          <h3 className="text-sm font-semibold text-text-primary">{t('rb.conn.title')}</h3>
          <div className="ml-auto flex items-center gap-2">
            {online === true && <span className="flex items-center gap-1.5 text-xs text-success"><Wifi className="w-3.5 h-3.5" /> {t('rb.conn.online')}</span>}
            {online === false && <span className="flex items-center gap-1.5 text-xs text-danger"><WifiOff className="w-3.5 h-3.5" /> {t('rb.conn.offline')}</span>}
            {online === null && <span className="text-xs text-text-secondary">{t('rb.conn.not_checked')}</span>}
          </div>
        </div>

        <div className="grid grid-cols-4 gap-3 mb-3">
          <div className="col-span-1">
            <label className="text-[10px] text-text-secondary flex items-center gap-1"><Globe className="w-3 h-3" /> {t('rb.conn.controller_ip')}</label>
            <input type="text" value={config.ip} onChange={(e) => setConfig({ ...config, ip: e.target.value })}
              placeholder="192.168.1.100" className="input-sm w-full" />
          </div>
          <div>
            <label className="text-[10px] text-text-secondary flex items-center gap-1"><Hash className="w-3 h-3" /> {t('rb.conn.port')}</label>
            <input type="number" value={config.port} onChange={(e) => setConfig({ ...config, port: Number(e.target.value) || 8088 })}
              className="input-sm w-full" />
          </div>
          <div>
            <label className="text-[10px] text-text-secondary flex items-center gap-1"><Hash className="w-3 h-3" /> {t('rb.conn.device_no')}</label>
            <input type="text" value={config.deviceNo} onChange={(e) => setConfig({ ...config, deviceNo: e.target.value })}
              placeholder="DEVICE_001" className="input-sm w-full" />
          </div>
          <div className="flex items-end gap-2">
            <button onClick={fetchStatus} disabled={loading || !config.deviceNo || !config.ip}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm bg-primary hover:bg-primary-light text-white rounded-lg transition-colors disabled:opacity-50">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              {t('rb.conn.status_btn')}
            </button>
            <button onClick={togglePolling} disabled={!config.deviceNo || !config.ip}
              className={`flex items-center justify-center gap-1.5 px-3 py-2 text-sm rounded-lg transition-colors disabled:opacity-50 ${
                polling ? 'bg-success text-white' : 'bg-surface-light border border-border text-text-secondary hover:text-text-primary'
              }`}>
              <RefreshCw className={`w-4 h-4 ${polling ? 'animate-spin' : ''}`} />
              {polling ? t('rb.conn.stop_btn') : t('rb.conn.auto_btn')}
            </button>
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-2 bg-danger/10 border border-danger/30 rounded-lg p-2.5 text-xs text-danger">
            <AlertCircle className="w-4 h-4 shrink-0" /> {error}
          </div>
        )}
        {opResult && (
          <div className={`flex items-center gap-2 rounded-lg p-2.5 text-xs mt-2 ${
            opResult.ok ? 'bg-success/10 border border-success/30 text-success' : 'bg-danger/10 border border-danger/30 text-danger'
          }`}>
            {opResult.msg}
          </div>
        )}
      </div>

      {/* Device-Level Controls */}
      {online === true && boardEntries.length > 0 && (
        <div className="bg-surface border border-border rounded-xl p-5 mb-4">
          <div className="flex items-center gap-2 mb-4">
            <Layers className="w-4 h-4 text-accent" />
            <h3 className="text-sm font-semibold text-text-primary">{t('rb.device_level.title')}</h3>
            <span className="text-[10px] text-text-secondary ml-1">{t('rb.device_level.subtitle')}</span>
          </div>
          <div className="flex gap-3">
            <button onClick={() => handleOperation('device_level', 'up')}
              className="flex-1 flex items-center justify-center gap-2 py-3 bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-lg text-sm transition-colors">
              <ArrowUp className="w-5 h-5" /> {t('rb.device_level.raise_all')}
            </button>
            <button onClick={() => handleOperation('device_level', 'down')}
              className="flex-1 flex items-center justify-center gap-2 py-3 bg-green-600 hover:bg-green-500 text-white font-medium rounded-lg text-sm transition-colors">
              <ArrowDown className="w-5 h-5" /> {t('rb.device_level.lower_all')}
            </button>
          </div>
        </div>
      )}

      {/* Board & Column Cards */}
      {online === true && boardEntries.length > 0 && (
        <div className="space-y-4">
          {boardEntries.map(([boardId, cols]) => {
            const colEntries = Object.entries(cols);
            const totalPaths = colEntries.length;
            return (
              <div key={boardId} className="bg-surface border border-border rounded-xl p-5">
                <div className="flex items-center gap-2 mb-4">
                  <Columns3 className="w-4 h-4 text-primary-light" />
                  <h3 className="text-sm font-semibold text-text-primary">
                    {t('rb.board.title')} <span className="font-mono text-accent">{boardId}</span>
                  </h3>
                  <span className="text-[10px] text-text-secondary bg-surface-light px-2 py-0.5 rounded-full">
                    {t('rb.board.column_count', { n: totalPaths })}
                  </span>
                  <div className="ml-auto flex gap-2">
                    <button onClick={() => handleOperation('ip_level', 'up', boardId, totalPaths)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 border border-blue-600/30 rounded-lg transition-colors">
                      <ArrowUp className="w-3.5 h-3.5" /> {t('rb.board.raise')}
                    </button>
                    <button onClick={() => handleOperation('ip_level', 'down', boardId, totalPaths)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-green-600/20 text-green-400 hover:bg-green-600/30 border border-green-600/30 rounded-lg transition-colors">
                      <ArrowDown className="w-3.5 h-3.5" /> {t('rb.board.lower')}
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
                  {colEntries.map(([colId, statusCode]) => {
                    const st = getColStatus(statusCode);
                    return (
                      <div key={colId} className="bg-surface-dark rounded-lg p-3 border border-border hover:border-primary-light/30 transition-colors">
                        <div className="flex items-center gap-2 mb-2">
                          <CircleDot className={`w-3.5 h-3.5 ${st.color}`} />
                          <span className="text-xs font-mono text-text-primary">{t('rb.column.label', { id: colId })}</span>
                        </div>
                        <div className="flex items-center gap-1.5 mb-3">
                          <span className={`w-2 h-2 rounded-full ${st.icon} ${statusCode === 5 || statusCode === 1 ? 'animate-pulse' : ''}`} />
                          <span className={`text-[10px] font-medium ${st.color}`}>{t(st.key)}</span>
                        </div>
                        <div className="flex gap-1">
                          <button onClick={() => handleOperation('liftingColumn_level', 'up', boardId, totalPaths, Number(colId))}
                            title={t('rb.column.raise_one')}
                            className="flex-1 flex items-center justify-center py-1.5 bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 rounded text-xs transition-colors">
                            <ArrowUp className="w-3 h-3" />
                          </button>
                          <button onClick={() => handleOperation('liftingColumn_level', 'down', boardId, totalPaths, Number(colId))}
                            title={t('rb.column.lower_one')}
                            className="flex-1 flex items-center justify-center py-1.5 bg-green-600/20 text-green-400 hover:bg-green-600/30 rounded text-xs transition-colors">
                            <ArrowDown className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Empty state */}
      {(online === null || online === false || boardEntries.length === 0) && !error && (
        <div className="bg-surface border border-border rounded-xl p-12 text-center">
          <Columns3 className="w-16 h-16 text-surface-light mx-auto mb-4" />
          <p className="text-text-secondary text-sm">
            {online === false ? t('rb.empty.offline') : t('rb.empty.configure')}
          </p>
        </div>
      )}

      {/* API Reference */}
      <div className="mt-6 bg-surface rounded-xl border border-border p-5">
        <h3 className="text-sm font-semibold text-text-primary mb-3">{t('rb.api.title')}</h3>
        <div className="space-y-2 text-xs font-mono">
          <div className="flex gap-3">
            <span className="text-success min-w-[80px]">GET</span>
            <span className="text-text-secondary">http://&#123;ip&#125;:&#123;port&#125;/open/getStatus/&#123;deviceNo&#125;</span>
          </div>
          <div className="flex gap-3">
            <span className="text-primary-light min-w-[80px]">POST</span>
            <span className="text-text-secondary">http://&#123;ip&#125;:&#123;port&#125;/open/operation</span>
          </div>
        </div>
        <div className="mt-3 text-[10px] text-text-secondary">
          <p>{t('rb.api.col_states_label')} <span className="text-gray-400">{t('rb.api.col_state.0')}</span> <span className="text-blue-400">{t('rb.api.col_state.5')}</span> <span className="text-red-400">{t('rb.api.col_state.7')}</span> <span className="text-amber-400">{t('rb.api.col_state.1')}</span> <span className="text-green-400">{t('rb.api.col_state.3')}</span></p>
          <p className="mt-1">{t('rb.api.op_levels_label')} <span className="text-accent">{t('rb.api.op_level.device')}</span> | <span className="text-accent">{t('rb.api.op_level.ip')}</span> | <span className="text-accent">{t('rb.api.op_level.column')}</span></p>
        </div>
      </div>
    </div>
  );
}
