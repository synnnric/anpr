import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Radio, RefreshCw, ArrowDownToLine, ArrowUpFromLine, ChevronRight,
  ChevronDown, Cpu, Activity, AlertTriangle, CheckCircle, Clock, Car, X,
  Trash2, Loader2,
} from 'lucide-react';
import {
  listMqttDevices, listMqttInbound, listMqttOutbound, listMqttMessageNames,
  type MqttDevice, type MqttInboundRow, type MqttOutboundRow, type MqttLogFilters,
  type MqttMessageNames,
} from '../services/mqttLogService';
import { resetData } from '../services/adminService';
import { parsePgTs, fmtPgTs } from '../utils/helpers';
import { useI18n } from '../contexts/I18nContext';

type DirectionTab = 'inbound' | 'outbound';

export default function MqttLogsPage() {
  const { t } = useI18n();
  const [devices, setDevices] = useState<MqttDevice[]>([]);
  const [tab, setTab] = useState<DirectionTab>('inbound');

  const [deviceFilter, setDeviceFilter] = useState<string>('');
  const [nameFilter, setNameFilter] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [plateFilter, setPlateFilter] = useState<string>('');
  const [plateInput, setPlateInput] = useState<string>('');
  const [autoRefresh, setAutoRefresh] = useState(true);

  const [inboundRows, setInboundRows] = useState<MqttInboundRow[]>([]);
  const [inboundTotal, setInboundTotal] = useState(0);
  const [outboundRows, setOutboundRows] = useState<MqttOutboundRow[]>([]);
  const [outboundTotal, setOutboundTotal] = useState(0);
  const [messageNames, setMessageNames] = useState<MqttMessageNames>({ inbound: [], outbound: [], all: [] });
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetMsg, setResetMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const filters: MqttLogFilters = useMemo(() => ({
    device_sn:     deviceFilter || undefined,
    message_name:  nameFilter || undefined,
    status:        tab === 'outbound' && statusFilter ? statusFilter : undefined,
    license_plate: plateFilter || undefined,
    limit:         200,
  }), [deviceFilter, nameFilter, statusFilter, plateFilter, tab]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [devs, inb, out] = await Promise.all([
        listMqttDevices(),
        listMqttInbound(filters),
        listMqttOutbound(filters),
      ]);
      setDevices(devs);
      setInboundRows(inb.items);
      setInboundTotal(inb.total);
      setOutboundRows(out.items);
      setOutboundTotal(out.total);
    } catch {
      // swallow
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    if (!autoRefresh) return;
    const tm = setInterval(reload, 5000);
    return () => clearInterval(tm);
  }, [reload, autoRefresh]);

  useEffect(() => {
    listMqttMessageNames().then(setMessageNames).catch(() => undefined);
    const tm = setInterval(() => {
      listMqttMessageNames().then(setMessageNames).catch(() => undefined);
    }, 60_000);
    return () => clearInterval(tm);
  }, []);

  const dropdownNames = tab === 'inbound' ? messageNames.inbound : messageNames.outbound;

  const handleReset = async () => {
    setResetting(true);
    setResetMsg(null);
    try {
      const r = await resetData();
      setResetMsg({ ok: true, text: t('mqtt_logs.reset.success', { n: r.total }) });
      setResetOpen(false);
      reload();
    } catch (err) {
      setResetMsg({ ok: false, text: t('mqtt_logs.reset.failed', { e: err instanceof Error ? err.message : String(err) }) });
    } finally {
      setResetting(false);
    }
  };

  const toggle = (key: string) => setExpanded(e => ({ ...e, [key]: !e[key] }));
  const applyPlate = () => setPlateFilter(plateInput.trim());
  const clearPlate = () => { setPlateInput(''); setPlateFilter(''); };
  const filterToPlate = (p: string) => { setPlateInput(p); setPlateFilter(p); };

  return (
    <div className="h-full flex flex-col bg-bg overflow-hidden">
      <header className="bg-surface border-b border-border px-6 py-4 shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-text-primary flex items-center gap-2">
              <Radio className="w-5 h-5 text-primary" /> {t('mqtt_logs.title')}
            </h1>
            <p className="text-xs text-text-secondary mt-0.5">
              {t('mqtt_logs.subtitle')}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-text-secondary cursor-pointer select-none">
              <input type="checkbox" checked={autoRefresh}
                onChange={e => setAutoRefresh(e.target.checked)}
                className="w-3.5 h-3.5" />
              {t('mqtt_logs.auto_refresh')}
            </label>
            <button onClick={reload} disabled={loading}
              className="flex items-center gap-1 px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary border border-border rounded-md">
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> {t('common.refresh')}
            </button>
            <button onClick={() => { setResetMsg(null); setResetOpen(true); }}
              title={t('mqtt_logs.reset.testing_only')}
              className="flex items-center gap-1 px-3 py-1.5 text-xs text-danger hover:bg-danger/10 border border-danger/40 rounded-md">
              <Trash2 className="w-3.5 h-3.5" /> {t('mqtt_logs.reset.btn')}
            </button>
          </div>
        </div>
      </header>

      {resetMsg && (
        <div className={`px-6 py-2 text-xs border-b ${
          resetMsg.ok ? 'bg-success/10 text-success border-success/30' : 'bg-danger/10 text-danger border-danger/30'
        }`}>
          {resetMsg.text}
        </div>
      )}

      {resetOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => !resetting && setResetOpen(false)}>
          <div className="bg-surface border border-border rounded-xl max-w-md w-full p-5 shadow-xl"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-start gap-3 mb-3">
              <div className="w-9 h-9 rounded-full bg-danger/15 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5 text-danger" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-text-primary">{t('mqtt_logs.reset.confirm_title')}</h3>
                <span className="inline-block mt-1 text-[10px] uppercase tracking-wide font-semibold text-warning bg-warning/10 border border-warning/30 rounded px-1.5 py-0.5">
                  {t('mqtt_logs.reset.testing_only')}
                </span>
              </div>
            </div>
            <p className="text-xs text-text-secondary leading-relaxed mb-4">{t('mqtt_logs.reset.confirm_body')}</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setResetOpen(false)} disabled={resetting}
                className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary border border-border rounded-md disabled:opacity-50">
                {t('mqtt_logs.reset.cancel')}
              </button>
              <button onClick={handleReset} disabled={resetting}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-white bg-danger hover:bg-danger/80 rounded-md disabled:opacity-50">
                {resetting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                {t('mqtt_logs.reset.confirm_yes')}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Cpu className="w-4 h-4 text-text-secondary" />
            <h2 className="text-sm font-semibold text-text-primary">{t('mqtt_logs.section.devices')}</h2>
            <span className="text-xs text-text-secondary">({devices.length})</span>
          </div>
          {devices.length === 0 ? (
            <div className="bg-surface border border-border rounded-lg p-6 text-center text-sm text-text-secondary">
              {t('mqtt_logs.no_activity')}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {devices.map(d => (
                <DeviceCard
                  key={d.device_sn}
                  device={d}
                  selected={deviceFilter === d.device_sn}
                  onSelect={() => setDeviceFilter(prev => prev === d.device_sn ? '' : d.device_sn)}
                />
              ))}
            </div>
          )}
        </div>

        <div className="bg-surface border border-border rounded-lg p-3">
          <div className="flex flex-wrap gap-2 items-center">
            <div className="flex bg-surface-dark rounded-md p-0.5">
              <TabBtn icon={ArrowDownToLine} label={t('mqtt_logs.tab.inbound', { n: inboundTotal })}
                active={tab === 'inbound'} onClick={() => setTab('inbound')} />
              <TabBtn icon={ArrowUpFromLine} label={t('mqtt_logs.tab.outbound', { n: outboundTotal })}
                active={tab === 'outbound'} onClick={() => setTab('outbound')} />
            </div>
            <div className="h-6 w-px bg-border mx-1" />
            <select value={deviceFilter} onChange={e => setDeviceFilter(e.target.value)}
              className="bg-surface-dark border border-border rounded-md px-2 py-1.5 text-xs text-text-primary">
              <option value="">{t('mqtt_logs.filter.all_devices')}</option>
              {devices.map(d => (
                <option key={d.device_sn} value={d.device_sn}>
                  {d.channel?.channel_no ? `${d.channel.channel_no} — ` : ''}{d.device_sn}
                </option>
              ))}
            </select>
            <select value={nameFilter} onChange={e => setNameFilter(e.target.value)}
              className="bg-surface-dark border border-border rounded-md px-2 py-1.5 text-xs text-text-primary">
              <option value="">{t('mqtt_logs.filter.all_messages')}</option>
              {dropdownNames.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
            {tab === 'outbound' && (
              <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
                className="bg-surface-dark border border-border rounded-md px-2 py-1.5 text-xs text-text-primary">
                <option value="">{t('mqtt_logs.filter.all_statuses')}</option>
                <option value="pending">{t('mqtt_logs.filter.pending')}</option>
                <option value="sent">{t('mqtt_logs.filter.sent')}</option>
                <option value="failed">{t('mqtt_logs.filter.failed')}</option>
              </select>
            )}
            <div className="flex items-center gap-1 bg-surface-dark border border-border rounded-md px-2 py-0.5">
              <Car className="w-3.5 h-3.5 text-text-secondary" />
              <input value={plateInput}
                onChange={e => setPlateInput(e.target.value.toUpperCase())}
                onKeyDown={e => { if (e.key === 'Enter') applyPlate(); }}
                onBlur={applyPlate}
                placeholder={t('mqtt_logs.filter.plate_ph')}
                className="bg-transparent w-36 text-xs text-text-primary focus:outline-none placeholder:text-text-secondary/60" />
              {plateFilter && (
                <button onClick={clearPlate} className="text-text-secondary hover:text-text-primary">
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
            {(deviceFilter || nameFilter || statusFilter || plateFilter) && (
              <button onClick={() => { setDeviceFilter(''); setNameFilter(''); setStatusFilter(''); clearPlate(); }}
                className="text-xs text-text-secondary hover:text-text-primary px-2 py-1">
                {t('mqtt_logs.filter.clear')}
              </button>
            )}
          </div>
          {plateFilter && (
            <div className="mt-2 text-[11px] text-primary flex items-center gap-1.5">
              <Car className="w-3 h-3" /> {t('mqtt_logs.filter.plate_active')} <span className="font-mono font-semibold">{plateFilter}</span>
              <span className="text-text-secondary">{t('mqtt_logs.filter.plate_active_covers')}</span>
            </div>
          )}
        </div>

        <div className="bg-surface border border-border rounded-lg overflow-hidden">
          {tab === 'inbound' ? (
            <InboundTable rows={inboundRows} expanded={expanded} onToggle={toggle} onPlateClick={filterToPlate} />
          ) : (
            <OutboundTable rows={outboundRows} expanded={expanded} onToggle={toggle} onPlateClick={filterToPlate} />
          )}
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────

function DeviceCard({ device, selected, onSelect }: {
  device: MqttDevice; selected: boolean; onSelect: () => void;
}) {
  const { t } = useI18n();
  const lastIn = parsePgTs(device.last_inbound_at);
  const lastOut = parsePgTs(device.last_outbound_at);
  const latest = [lastIn, lastOut].filter(Boolean).sort((a, b) => b!.getTime() - a!.getTime())[0];
  const idleMs = latest ? Date.now() - latest.getTime() : null;
  const idleLabel = idleMs === null ? '—'
    : idleMs < 60_000 ? t('mqtt_logs.ago.s', { n: Math.floor(idleMs / 1000) })
    : idleMs < 3_600_000 ? t('mqtt_logs.ago.m', { n: Math.floor(idleMs / 60_000) })
    : idleMs < 86_400_000 ? t('mqtt_logs.ago.h', { n: Math.floor(idleMs / 3_600_000) })
    : t('mqtt_logs.ago.d', { n: Math.floor(idleMs / 86_400_000) });
  const isHealthy = idleMs !== null && idleMs < 30_000;

  return (
    <button onClick={onSelect}
      className={`text-left bg-surface border rounded-lg p-3 transition-all ${
        selected ? 'border-primary ring-1 ring-primary/40' : 'border-border hover:border-border-light'
      }`}>
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {isHealthy
              ? <CheckCircle className="w-3.5 h-3.5 text-success shrink-0" />
              : <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0" />}
            <span className="text-xs font-mono font-semibold text-text-primary truncate" title={device.device_sn}>
              {device.device_sn}
            </span>
          </div>
          {device.channel && (
            <div className="text-[10px] text-text-secondary mt-0.5 truncate">
              {device.channel.channel_no}{device.channel.name ? ` · ${device.channel.name}` : ''}
            </div>
          )}
        </div>
        <span className="text-[10px] text-text-secondary flex items-center gap-0.5 shrink-0">
          <Clock className="w-3 h-3" /> {idleLabel}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 mb-2">
        <Stat icon={ArrowDownToLine} label={t('mqtt_logs.device.inbound')} value={device.inbound_total} color="text-blue-300" />
        <Stat icon={ArrowUpFromLine} label={t('mqtt_logs.device.outbound')} value={device.outbound_total} color="text-emerald-300" />
      </div>
      {(device.outbound_pending > 0 || device.outbound_failed > 0) && (
        <div className="text-[10px] text-text-secondary mb-2">
          {device.outbound_pending > 0 && <span className="text-amber-300 mr-2">{t('mqtt_logs.device.pending')} {device.outbound_pending}</span>}
          {device.outbound_failed > 0 && <span className="text-danger">{t('mqtt_logs.device.failed')} {device.outbound_failed}</span>}
        </div>
      )}
      {device.inbound_breakdown.length > 0 && (
        <div className="flex flex-wrap gap-1 pt-2 border-t border-border">
          {device.inbound_breakdown.map(b => (
            <span key={b.message_name}
              className="text-[10px] bg-surface-dark border border-border rounded px-1.5 py-0.5 text-text-secondary">
              {b.message_name} <span className="text-text-primary">{b.c}</span>
            </span>
          ))}
        </div>
      )}
    </button>
  );
}

function Stat({ icon: Icon, label, value, color }: {
  icon: typeof Activity; label: string; value: number; color: string;
}) {
  return (
    <div className="bg-surface-dark border border-border rounded px-2 py-1.5">
      <div className="flex items-center gap-1 text-[10px] text-text-secondary">
        <Icon className="w-3 h-3" /> {label}
      </div>
      <div className={`text-sm font-semibold ${color}`}>{value.toLocaleString()}</div>
    </div>
  );
}

function TabBtn({ icon: Icon, label, active, onClick }: {
  icon: typeof Activity; label: string; active: boolean; onClick: () => void;
}) {
  return (
    <button onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
        active ? 'bg-primary text-white' : 'text-text-secondary hover:text-text-primary'
      }`}>
      <Icon className="w-3.5 h-3.5" /> {label}
    </button>
  );
}

const fmtTime = fmtPgTs;

function InboundTable({ rows, expanded, onToggle, onPlateClick }: {
  rows: MqttInboundRow[]; expanded: Record<string, boolean>;
  onToggle: (k: string) => void; onPlateClick: (p: string) => void;
}) {
  const { t } = useI18n();
  if (rows.length === 0) {
    return <div className="p-6 text-center text-sm text-text-secondary">{t('mqtt_logs.empty.inbound')}</div>;
  }
  return (
    <table className="w-full text-xs">
      <thead className="bg-surface-dark border-b border-border">
        <tr>
          <th className="text-left p-2 w-8"></th>
          <th className="text-left p-2 text-text-secondary font-medium">{t('mqtt_logs.col.time')}</th>
          <th className="text-left p-2 text-text-secondary font-medium">{t('mqtt_logs.col.device_sn')}</th>
          <th className="text-left p-2 text-text-secondary font-medium">{t('mqtt_logs.col.message')}</th>
          <th className="text-left p-2 text-text-secondary font-medium">{t('mqtt_logs.col.plate')}</th>
          <th className="text-left p-2 text-text-secondary font-medium">{t('mqtt_logs.col.topic')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(r => {
          const key = `in-${r.id}`;
          const open = !!expanded[key];
          return (
            <Fragment key={key}>
              <tr className="border-b border-border hover:bg-surface-dark cursor-pointer"
                onClick={() => onToggle(key)}>
                <td className="p-2 text-text-secondary">
                  {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                </td>
                <td className="p-2 text-text-secondary font-mono whitespace-nowrap">{fmtTime(r.received_at)}</td>
                <td className="p-2 text-text-primary font-mono truncate max-w-[180px]" title={r.device_sn}>{r.device_sn}</td>
                <td className="p-2"><MsgPill name={r.message_name} /></td>
                <td className="p-2">
                  {r.license_plate ? <PlateChip plate={r.license_plate} onClick={onPlateClick} /> : <span className="text-text-secondary/40">—</span>}
                </td>
                <td className="p-2 text-text-secondary font-mono truncate max-w-[300px]" title={r.topic}>{r.topic}</td>
              </tr>
              {open && (
                <tr className="border-b border-border bg-bg">
                  <td colSpan={6} className="p-3">
                    <pre className="text-[10px] text-text-secondary whitespace-pre-wrap break-all max-h-72 overflow-y-auto bg-surface-dark p-2 rounded border border-border">
                      {JSON.stringify(r.payload, null, 2)}
                    </pre>
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function extractOutboundPlate(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.plate === 'string') return p.plate;
  const recs = p.dldb_rec;
  if (Array.isArray(recs)) {
    const plates = recs
      .map(r => (r && typeof r === 'object' && typeof (r as Record<string, unknown>).plate === 'string'
        ? (r as Record<string, string>).plate : null))
      .filter((x): x is string => !!x);
    if (plates.length === 1) return plates[0];
    if (plates.length > 1) return plates.join(', ');
  }
  return null;
}

function OutboundTable({ rows, expanded, onToggle, onPlateClick }: {
  rows: MqttOutboundRow[]; expanded: Record<string, boolean>;
  onToggle: (k: string) => void; onPlateClick: (p: string) => void;
}) {
  const { t } = useI18n();
  if (rows.length === 0) {
    return <div className="p-6 text-center text-sm text-text-secondary">{t('mqtt_logs.empty.outbound')}</div>;
  }
  return (
    <table className="w-full text-xs">
      <thead className="bg-surface-dark border-b border-border">
        <tr>
          <th className="text-left p-2 w-8"></th>
          <th className="text-left p-2 text-text-secondary font-medium">{t('mqtt_logs.col.created')}</th>
          <th className="text-left p-2 text-text-secondary font-medium">{t('mqtt_logs.col.sent')}</th>
          <th className="text-left p-2 text-text-secondary font-medium">{t('mqtt_logs.col.device_sn')}</th>
          <th className="text-left p-2 text-text-secondary font-medium">{t('mqtt_logs.col.command')}</th>
          <th className="text-left p-2 text-text-secondary font-medium">{t('mqtt_logs.col.plate')}</th>
          <th className="text-left p-2 text-text-secondary font-medium">{t('mqtt_logs.col.status')}</th>
          <th className="text-left p-2 text-text-secondary font-medium">{t('mqtt_logs.col.attempts')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(r => {
          const key = `out-${r.id}`;
          const open = !!expanded[key];
          const plate = extractOutboundPlate(r.payload);
          return (
            <Fragment key={key}>
              <tr className="border-b border-border hover:bg-surface-dark cursor-pointer"
                onClick={() => onToggle(key)}>
                <td className="p-2 text-text-secondary">
                  {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                </td>
                <td className="p-2 text-text-secondary font-mono whitespace-nowrap">{fmtTime(r.created_at)}</td>
                <td className="p-2 text-text-secondary font-mono whitespace-nowrap">{fmtTime(r.sent_at)}</td>
                <td className="p-2 text-text-primary font-mono truncate max-w-[180px]" title={r.device_sn}>{r.device_sn}</td>
                <td className="p-2"><MsgPill name={r.message_name} /></td>
                <td className="p-2">
                  {plate ? <PlateChip plate={plate} onClick={onPlateClick} /> : <span className="text-text-secondary/40">—</span>}
                </td>
                <td className="p-2"><StatusPill status={r.status} /></td>
                <td className="p-2 text-text-primary">{r.attempts}</td>
              </tr>
              {open && (
                <tr className="border-b border-border bg-bg">
                  <td colSpan={8} className="p-3">
                    {r.last_error && (
                      <div className="mb-2 text-[11px] text-danger bg-danger/10 border border-danger/30 rounded p-2">
                        <span className="font-semibold">{t('mqtt_logs.last_error')}</span> {r.last_error}
                      </div>
                    )}
                    <pre className="text-[10px] text-text-secondary whitespace-pre-wrap break-all max-h-72 overflow-y-auto bg-surface-dark p-2 rounded border border-border">
                      {JSON.stringify(r.payload, null, 2)}
                    </pre>
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function PlateChip({ plate, onClick }: { plate: string; onClick: (p: string) => void }) {
  const { t } = useI18n();
  const first = plate.split(',')[0].trim();
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(first); }}
      title={t('mqtt_logs.plate_filter_title', { p: first })}
      className="inline-block text-[11px] font-mono px-1.5 py-0.5 rounded border bg-primary/10 text-primary border-primary/40 hover:bg-primary/20">
      {plate}
    </button>
  );
}

function MsgPill({ name }: { name: string }) {
  const cls = name === 'ivs_result' ? 'bg-blue-500/15 text-blue-300 border-blue-500/30'
    : name === 'keep_alive' ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
    : name === 'white_list_operator' ? 'bg-purple-500/15 text-purple-300 border-purple-500/30'
    : name === 'gpio_in' ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
    : 'bg-surface-dark text-text-primary border-border';
  return (
    <span className={`inline-block text-[10px] font-mono px-1.5 py-0.5 rounded border ${cls}`}>
      {name}
    </span>
  );
}

function StatusPill({ status }: { status: 'pending' | 'sent' | 'failed' }) {
  const cls = status === 'sent' ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
    : status === 'pending' ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
    : 'bg-danger/15 text-danger border-danger/30';
  return (
    <span className={`inline-block text-[10px] font-mono px-1.5 py-0.5 rounded border ${cls}`}>
      {status}
    </span>
  );
}
