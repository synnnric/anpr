import { Fragment, useCallback, useEffect, useState } from 'react';
import {
  LayoutDashboard, RefreshCw, Server, Radio, Cpu, Database,
  Camera, ShieldCheck, Columns3, Car, LogIn, LogOut, AlertTriangle,
  ShieldAlert, Activity, Clock, CheckCircle, XCircle, Crown,
  ArrowDownToLine, ArrowUpFromLine, ListChecks, Cable,
} from 'lucide-react';
import { getDashboard, type DashboardSnapshot, type DashboardChannel, type HealthLevel } from '../services/dashboardService';
import { parsePgTs, fmtIdleTime } from '../utils/helpers';
import { useI18n } from '../contexts/I18nContext';
import type { TKey } from '../i18n/translations';

const COLUMN_STATE_KEY: Record<number, { key: TKey; color: string }> = {
  0: { key: 'dashboard.col.unknown',    color: 'text-text-secondary' },
  1: { key: 'dashboard.col.descending', color: 'text-amber-400' },
  3: { key: 'dashboard.col.lowered',    color: 'text-green-400' },
  5: { key: 'dashboard.col.rising',     color: 'text-blue-400' },
  7: { key: 'dashboard.col.raised',     color: 'text-red-400' },
};

const DECISION_META: Record<string, { key: TKey; bg: string; text: string }> = {
  pass:     { key: 'dashboard.decision.pass',     bg: 'bg-green-500/15',   text: 'text-green-300' },
  suspect:  { key: 'dashboard.decision.suspect',  bg: 'bg-amber-500/15',   text: 'text-amber-300' },
  fail:     { key: 'dashboard.decision.fail',     bg: 'bg-red-500/15',     text: 'text-red-300' },
  vip_pass: { key: 'dashboard.decision.vip_pass', bg: 'bg-purple-500/15',  text: 'text-purple-300' },
  pending:  { key: 'dashboard.decision.pending',  bg: 'bg-surface-dark',   text: 'text-text-secondary' },
};

export default function DashboardPage() {
  const { t } = useI18n();
  const [snap, setSnap] = useState<DashboardSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getDashboard();
      setSnap(data);
      setError('');
      setLastUpdated(new Date());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

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
              <LayoutDashboard className="w-5 h-5 text-primary" /> {t('dashboard.title')}
            </h1>
            <p className="text-xs text-text-secondary mt-0.5">
              {t('dashboard.subtitle')}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {lastUpdated && (
              <span className="text-[10px] text-text-secondary">
                {t('dashboard.updated_at')} {lastUpdated.toLocaleTimeString()}
              </span>
            )}
            <button onClick={reload} disabled={loading}
              className="flex items-center gap-1 px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary border border-border rounded-md">
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> {t('common.refresh')}
            </button>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {error && (
          <div className="bg-danger/10 border border-danger/30 rounded-lg p-3 text-sm text-danger">
            {error}
          </div>
        )}

        {!snap && !error && (
          <div className="text-center py-12 text-text-secondary text-sm">{t('common.loading')}</div>
        )}

        {snap && <>
          <SystemHealth snap={snap} />
          <TodayStats snap={snap} />

          <section>
            <h2 className="text-sm font-semibold text-text-primary mb-2 flex items-center gap-2">
              <Camera className="w-4 h-4 text-text-secondary" /> {t('dashboard.channels_devices')}
            </h2>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {snap.channels.map(ch => <ChannelCard key={ch.channel_no} ch={ch} />)}
            </div>
          </section>

          <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <RecentPlates rows={snap.recent_plates} />
            <RecentDecisions rows={snap.recent_decisions} />
          </section>
        </>}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────

function SystemHealth({ snap }: { snap: DashboardSnapshot }) {
  const { t } = useI18n();
  const sys = snap.system;
  const dev = countDevices(snap.channels);
  const devStatus: HealthLevel = dev.total === 0 ? 'unknown'
    : dev.offline === 0 ? 'ok' : 'stale';
  return (
    <section>
      <h2 className="text-sm font-semibold text-text-primary mb-2 flex items-center gap-2">
        <Activity className="w-4 h-4 text-text-secondary" /> {t('dashboard.system_health')}
      </h2>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <HealthCard icon={Server}   label={t('dashboard.health.backend')}  status={sys.backend_status}
          detail={`v${sys.backend_version}`} />
        <HealthCard icon={Database} label={t('dashboard.health.database')} status={sys.db_status}
          detail={`${sys.db_latency_ms}ms`} />
        <HealthCard icon={Radio}    label={t('dashboard.health.broker')}   status={sys.mqtt_status}
          detail={sys.broker_reachable
            ? `${t('dashboard.health.reachable')} · ${sys.broker_latency_ms}ms`
            : (sys.broker_error ?? t('dashboard.health.unreachable'))} />
        <HealthCard icon={Cpu}      label={t('dashboard.health.worker')}   status={sys.worker_status}
          detail={sys.worker_last_seen_age !== null
            ? t('dashboard.health.heartbeat_ago', { n: sys.worker_last_seen_age })
            : t('dashboard.health.no_heartbeat')} />
        <HealthCard icon={Cable}    label={t('dashboard.health.devices')}  status={devStatus}
          detail={dev.total === 0
            ? t('dashboard.health.no_devices')
            : `${t('dashboard.health.online_count', { online: dev.online, total: dev.total })}${dev.offline > 0 ? ` · ${t('dashboard.health.offline_count', { n: dev.offline })}` : ''}`} />
      </div>
      <DeviceList channels={snap.channels} />
      {snap.mqtt_queue.pending + snap.mqtt_queue.failed > 0 && (
        <div className="mt-2 text-[11px] text-amber-300 flex items-center gap-1">
          <AlertTriangle className="w-3 h-3" /> {t('dashboard.queue.title')}:
          <span>{snap.mqtt_queue.pending} {t('dashboard.queue.pending')}</span>
          {snap.mqtt_queue.failed > 0 && <span className="text-danger">{snap.mqtt_queue.failed} {t('dashboard.queue.failed')}</span>}
          {snap.mqtt_queue.last_error && <span className="text-text-secondary truncate">— {snap.mqtt_queue.last_error}</span>}
        </div>
      )}
    </section>
  );
}

// Flatten channels into a per-device list with type, label, and online flag.
function flattenDevices(channels: DashboardChannel[], labels: { anpr: string; s300: string; rb: string; unreachable: string }) {
  type Row = { key: string; channel: string; type: string;
               icon: typeof Activity; label: string; online: boolean | null; detail: string };
  const rows: Row[] = [];
  for (const c of channels) {
    if (c.anpr_device_sn) {
      rows.push({
        key: `${c.channel_no}-anpr`,
        channel: c.channel_no, type: labels.anpr, icon: Camera,
        label: `${c.channel_no} · ANPR (${c.kind})`,
        online: c.anpr_status === 'ok',
        detail: fmtIdleTime(c.anpr_last_heartbeat_at),
      });
    }
    if (c.kind === 'entry' && c.s300) {
      rows.push({
        key: `${c.channel_no}-s300`,
        channel: c.channel_no, type: labels.s300, icon: ShieldCheck,
        label: `${c.channel_no} · ${labels.s300}`,
        online: c.s300.reachable,
        detail: c.s300.reachable
          ? `${c.s300.elapsed_ms ?? '?'}ms`
          : (c.s300.reason ?? labels.unreachable),
      });
    }
    if (c.kind === 'entry' && c.rb_ip) {
      rows.push({
        key: `${c.channel_no}-rb`,
        channel: c.channel_no, type: labels.rb, icon: Columns3,
        label: `${c.channel_no} · ${labels.rb}`,
        online: c.road_blocker?.online ?? null,
        detail: c.road_blocker?.online
          ? `${c.road_blocker.elapsed_ms ?? '?'}ms`
          : (c.road_blocker?.reason ?? labels.unreachable),
      });
    }
  }
  return rows;
}

function DeviceList({ channels }: { channels: DashboardChannel[] }) {
  const { t } = useI18n();
  const devices = flattenDevices(channels, {
    anpr: t('dashboard.device.anpr'),
    s300: t('dashboard.device.s300'),
    rb: t('dashboard.device.rb'),
    unreachable: t('dashboard.health.unreachable'),
  });
  if (devices.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {devices.map(d => {
        const Icon = d.icon;
        const dot = d.online ? 'bg-green-400' : d.online === false ? 'bg-red-400' : 'bg-gray-500';
        const ring = d.online
          ? 'border-green-500/30 bg-green-500/5'
          : d.online === false
            ? 'border-red-500/30 bg-red-500/5'
            : 'border-border bg-surface-dark';
        return (
          <div key={d.key}
            className={`flex items-center gap-2 border rounded-md px-2 py-1 text-[11px] ${ring}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
            <Icon className="w-3 h-3 text-text-secondary" />
            <span className="font-mono text-text-primary">{d.label}</span>
            <span className="text-text-secondary">·</span>
            <span className="text-text-secondary">{d.detail}</span>
          </div>
        );
      })}
    </div>
  );
}

// Aggregate per-channel device probes into a single online/offline count.
function countDevices(channels: DashboardChannel[]): { total: number; online: number; offline: number } {
  let total = 0, online = 0;
  for (const c of channels) {
    if (c.anpr_device_sn) {
      total++;
      if (c.anpr_status === 'ok') online++;
    }
    if (c.kind === 'entry') {
      if (c.s300) {
        total++;
        if (c.s300.reachable) online++;
      }
      if (c.rb_ip) {
        total++;
        if (c.road_blocker?.online) online++;
      }
    }
  }
  return { total, online, offline: total - online };
}

function HealthCard({ icon: Icon, label, status, detail }: {
  icon: typeof Activity; label: string; status: HealthLevel; detail: string;
}) {
  const { t } = useI18n();
  const meta = status === 'ok'
    ? { ring: 'border-green-500/40 bg-green-500/5', dot: 'bg-green-400', text: t('dashboard.badge.ok') }
    : status === 'stale'
    ? { ring: 'border-amber-500/40 bg-amber-500/5', dot: 'bg-amber-400', text: t('dashboard.badge.stale') }
    : { ring: 'border-border bg-surface',           dot: 'bg-gray-500',  text: t('dashboard.badge.unknown') };
  return (
    <div className={`border rounded-lg p-3 ${meta.ring}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-text-secondary">
          <Icon className="w-4 h-4" />
          <span className="text-xs font-medium">{label}</span>
        </div>
        <span className="flex items-center gap-1.5 text-[10px] font-semibold text-text-primary">
          <span className={`w-2 h-2 rounded-full ${meta.dot}`} />
          {meta.text}
        </span>
      </div>
      <div className="text-[11px] text-text-secondary mt-1">{detail}</div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────

function TodayStats({ snap }: { snap: DashboardSnapshot }) {
  const { t } = useI18n();
  const td = snap.today;
  return (
    <section>
      <h2 className="text-sm font-semibold text-text-primary mb-2 flex items-center gap-2">
        <Clock className="w-4 h-4 text-text-secondary" /> {t('dashboard.today.title')}
      </h2>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Stat icon={Camera}        label={t('dashboard.today.plates')} value={td.plates_detected} />
        <Stat icon={ShieldCheck}   label={t('dashboard.today.inspections')} value={td.inspections.total}
          sub={td.inspections.in_progress > 0 ? t('dashboard.today.in_progress', { n: td.inspections.in_progress }) : null} />
        <Stat icon={CheckCircle}   label={t('dashboard.today.pass')}     value={td.inspections.pass}     color="text-green-300" />
        <Stat icon={AlertTriangle} label={t('dashboard.today.suspect')}  value={td.inspections.suspect}  color="text-amber-300" />
        <Stat icon={XCircle}       label={t('dashboard.today.fail')}     value={td.inspections.fail}    color="text-red-300" />
        <Stat icon={Crown}         label={t('dashboard.today.vip_pass')} value={td.inspections.vip_pass} color="text-purple-300" />
        <Stat icon={Car}           label={t('dashboard.today.inside')}   value={td.visits.active_now}    color="text-blue-300" />
        <Stat icon={LogIn}         label={t('dashboard.today.entered')}  value={td.visits.entered}       color="text-emerald-300" />
        <Stat icon={LogOut}        label={t('dashboard.today.completed')} value={td.visits.completed}    color="text-emerald-300" />
        <Stat icon={ShieldAlert}   label={t('dashboard.today.denied_entries')} value={td.visits.denied_entries} color="text-amber-400" />
      </div>
    </section>
  );
}

function Stat({ icon: Icon, label, value, color, sub }: {
  icon: typeof Activity; label: string; value: number; color?: string; sub?: string | null;
}) {
  return (
    <div className="bg-surface border border-border rounded-lg p-3">
      <div className="flex items-center gap-1.5 text-[10px] text-text-secondary uppercase tracking-wide">
        <Icon className="w-3 h-3" /> {label}
      </div>
      <div className={`text-2xl font-bold mt-1 ${color ?? 'text-text-primary'}`}>{value.toLocaleString()}</div>
      {sub && <div className="text-[10px] text-text-secondary mt-0.5">{sub}</div>}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────

function ChannelCard({ ch }: { ch: DashboardChannel }) {
  const { t } = useI18n();
  const idleLabel = fmtIdleTime(ch.anpr_last_heartbeat_at);

  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3 pb-3 border-b border-border">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold text-text-primary">{ch.channel_no}</span>
            <KindBadge kind={ch.kind} />
            {!ch.enabled && <span className="text-[10px] px-1.5 py-0.5 bg-surface-dark text-text-secondary border border-border rounded">{t('dashboard.kind.disabled')}</span>}
          </div>
          {ch.name && <div className="text-[11px] text-text-secondary mt-0.5">{ch.name}</div>}
        </div>
        <StatusDot status={ch.anpr_status} />
      </div>

      {/* ANPR camera */}
      <DeviceRow
        icon={Camera}
        title={t('dashboard.device.anpr')}
        statusBadge={<StatusBadge status={ch.anpr_status} />}
        rows={[
          [t('dashboard.row.sn'),         <span className="font-mono">{ch.anpr_device_sn || '—'}</span>],
          [t('dashboard.row.heartbeat'),  <span>{idleLabel}</span>],
          [t('dashboard.row.msgs_today'), <span>{(ch.anpr_msgs_today ?? 0).toLocaleString()}</span>],
          [t('dashboard.row.last_plate'), ch.last_plate
            ? <span><span className="font-mono">{ch.last_plate}</span> <span className="text-text-secondary/60">(<RelTime ts={ch.last_plate_at} />)</span></span>
            : <span className="text-text-secondary/60">{t('dashboard.row.no_traffic')}</span>],
        ]}
      />

      {/* Camera Robotic Arm + Inspection — only on entry channels */}
      {ch.kind === 'entry' && (
        <DeviceRow
          icon={ShieldCheck}
          title={t('dashboard.device.s300')}
          statusBadge={<S300Badge ch={ch} />}
          rows={<S300Rows ch={ch} />}
        />
      )}

      {/* Road blocker — only on entry channels */}
      {ch.kind === 'entry' && (
        <RoadBlockerSection ch={ch} />
      )}

      {/* Paired channel hint */}
      {ch.paired_channel_id && (
        <div className="mt-3 pt-2 border-t border-border text-[10px] text-text-secondary">
          {t('dashboard.paired_with', { n: ch.paired_channel_id })}
        </div>
      )}
    </div>
  );
}

function S300Badge({ ch }: { ch: DashboardChannel }) {
  const { t } = useI18n();
  if (ch.s300 && !ch.s300.reachable) {
    return <span className="text-[10px] px-1.5 py-0.5 bg-red-500/15 text-red-300 border border-red-500/30 rounded">{t('dashboard.badge.offline')}</span>;
  }
  if (ch.active_inspection) {
    return <span className="text-[10px] px-1.5 py-0.5 bg-amber-500/15 text-amber-300 border border-amber-500/30 rounded">{t('dashboard.badge.busy')}</span>;
  }
  return <span className="text-[10px] px-1.5 py-0.5 bg-green-500/15 text-green-300 border border-green-500/30 rounded">{t('dashboard.badge.ready')}</span>;
}

function S300Rows({ ch }: { ch: DashboardChannel }) {
  const { t } = useI18n();
  let rows: [string, React.ReactNode][];
  if (ch.s300 && !ch.s300.reachable) {
    rows = [
      [t('dashboard.row.base_url'), <span className="font-mono text-[11px]">{ch.s300_base_url}</span>],
      [t('dashboard.row.reason'),   <span className="text-danger text-[11px]">{ch.s300.reason ?? t('dashboard.health.unreachable')}</span>],
    ];
  } else if (ch.active_inspection) {
    rows = [
      [t('dashboard.row.inspection'), <span>#{ch.active_inspection.id} <span className="font-mono text-text-primary">{ch.active_inspection.license_plate}</span></span>],
      [t('dashboard.row.state'),      <span className="text-amber-300">{ch.active_inspection.state}</span>],
      [t('dashboard.row.op_state'),   <span>{ch.active_inspection.current_operating_state ?? '—'}</span>],
      [t('dashboard.row.decision'),   <DecisionPill d={ch.active_inspection.decision} />],
      [t('dashboard.row.come_at'),    <RelTime ts={ch.active_inspection.come_called_at} />],
    ];
  } else {
    rows = [
      [t('dashboard.row.base_url'),     <span className="font-mono text-[11px]">{ch.s300_base_url}</span>],
      [t('dashboard.row.uvis_timeout'), <span>{ch.uvis_timeout_sec}s</span>],
      [t('dashboard.row.latency'),      <span>{ch.s300?.elapsed_ms ?? '—'} ms</span>],
    ];
  }
  return <RowGrid rows={rows} />;
}

function RoadBlockerSection({ ch }: { ch: DashboardChannel }) {
  const { t } = useI18n();
  const rb = ch.road_blocker;
  if (!rb) return null;
  const cols = rb.columns ?? {};
  const rows: [string, React.ReactNode][] = rb.online ? [
    [t('dashboard.row.address'), <span className="font-mono text-[11px]">{ch.rb_ip}:{ch.rb_port}</span>],
    [t('dashboard.row.device'),  <span className="font-mono">{ch.rb_device_no} / {t('dashboard.row.board')} {ch.rb_board_id}</span>],
    [t('dashboard.row.columns'), <div className="flex flex-wrap gap-1.5">
      {Object.entries(cols).map(([bid, colMap]) => Object.entries(colMap).map(([cid, code]) => {
        const m = COLUMN_STATE_KEY[code] ?? COLUMN_STATE_KEY[0];
        return (
          <span key={`${bid}-${cid}`}
            className="text-[10px] px-1.5 py-0.5 bg-surface-dark border border-border rounded">
            {bid}/{cid} <span className={m.color}>{t(m.key)}</span>
          </span>
        );
      }))}
    </div>],
    [t('dashboard.row.latency'), <span>{rb.elapsed_ms ?? '—'} ms</span>],
  ] : [
    [t('dashboard.row.address'), <span className="font-mono text-[11px]">{ch.rb_ip ?? '—'}:{ch.rb_port ?? '—'}</span>],
    [t('dashboard.row.reason'),  <span className="text-danger text-[11px]">{rb.reason ?? t('dashboard.health.unreachable')}</span>],
  ];
  return (
    <DeviceRow
      icon={Columns3}
      title={t('dashboard.device.rb')}
      statusBadge={
        rb.online ? <span className="text-[10px] px-1.5 py-0.5 bg-green-500/15 text-green-300 border border-green-500/30 rounded">{t('dashboard.badge.online')}</span>
        : <span className="text-[10px] px-1.5 py-0.5 bg-red-500/15 text-red-300 border border-red-500/30 rounded">{t('dashboard.badge.offline')}</span>
      }
      rows={<RowGrid rows={rows} />}
    />
  );
}

function RowGrid({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <div className="grid grid-cols-[100px_1fr] gap-x-3 gap-y-1 text-[11px] pl-5">
      {rows.map(([k, v], i) => (
        <Fragment key={i}>
          <span className="text-text-secondary">{k}</span>
          <span className="text-text-primary truncate">{v}</span>
        </Fragment>
      ))}
    </div>
  );
}

function DeviceRow({ icon: Icon, title, statusBadge, rows }: {
  icon: typeof Activity; title: string; statusBadge?: React.ReactNode;
  rows: [string, React.ReactNode][] | React.ReactNode;
}) {
  return (
    <div className="mt-3 first:mt-0">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5 text-xs text-text-secondary">
          <Icon className="w-3.5 h-3.5" /> <span className="font-semibold">{title}</span>
        </div>
        {statusBadge}
      </div>
      {Array.isArray(rows) ? <RowGrid rows={rows} /> : rows}
    </div>
  );
}

function KindBadge({ kind }: { kind: 'entry' | 'exit' }) {
  const { t } = useI18n();
  const isEntry = kind === 'entry';
  return (
    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${
      isEntry ? 'bg-blue-500/15 text-blue-300 border-blue-500/30'
              : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
    }`}>
      {isEntry ? <><ArrowDownToLine className="inline w-3 h-3 -mt-0.5" /> {t('dashboard.kind.entry')}</>
               : <><ArrowUpFromLine className="inline w-3 h-3 -mt-0.5" /> {t('dashboard.kind.exit')}</>}
    </span>
  );
}

function StatusDot({ status }: { status: HealthLevel }) {
  const cls = status === 'ok' ? 'bg-green-400 shadow-green-500/40'
    : status === 'stale' ? 'bg-amber-400 shadow-amber-500/40'
    : 'bg-gray-500 shadow-gray-500/30';
  return <span className={`w-3 h-3 rounded-full shadow-md ${cls}`} />;
}

function StatusBadge({ status }: { status: HealthLevel }) {
  const { t } = useI18n();
  if (status === 'ok')
    return <span className="text-[10px] px-1.5 py-0.5 bg-green-500/15 text-green-300 border border-green-500/30 rounded">{t('dashboard.badge.online')}</span>;
  if (status === 'stale')
    return <span className="text-[10px] px-1.5 py-0.5 bg-amber-500/15 text-amber-300 border border-amber-500/30 rounded">{t('dashboard.badge.stale')}</span>;
  return <span className="text-[10px] px-1.5 py-0.5 bg-surface-dark text-text-secondary border border-border rounded">{t('dashboard.badge.unknown')}</span>;
}

function DecisionPill({ d }: { d: string }) {
  const { t } = useI18n();
  const m = DECISION_META[d] ?? DECISION_META.pending;
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${m.bg} ${m.text}`}>{t(m.key)}</span>;
}

function RelTime({ ts }: { ts: string | null | undefined }) {
  const { t } = useI18n();
  const d = parsePgTs(ts);
  if (!d) return <>—</>;
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 5) return <>{t('dashboard.rel.just_now')}</>;
  if (s < 60) return <>{t('dashboard.rel.s_ago', { n: s })}</>;
  if (s < 3600) return <>{t('dashboard.rel.m_ago', { n: Math.floor(s / 60) })}</>;
  if (s < 86400) return <>{t('dashboard.rel.h_ago', { n: Math.floor(s / 3600) })}</>;
  return <>{t('dashboard.rel.d_ago', { n: Math.floor(s / 86400) })}</>;
}

// ────────────────────────────────────────────────────────────────────

function RecentPlates({ rows }: { rows: DashboardSnapshot['recent_plates'] }) {
  const { t } = useI18n();
  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2 mb-3">
        <Camera className="w-4 h-4 text-text-secondary" /> {t('dashboard.recent_plates')}
      </h3>
      {rows.length === 0 ? (
        <p className="text-xs text-text-secondary">{t('dashboard.recent_plates.empty')}</p>
      ) : (
        <div className="space-y-1">
          {rows.map(r => (
            <div key={r.id} className="flex items-center gap-3 text-xs px-2 py-1.5 bg-surface-dark rounded">
              <span className="font-mono font-semibold text-text-primary flex-1 truncate">{r.license_plate}</span>
              <span className="font-mono text-[10px] text-text-secondary truncate max-w-[140px]" title={r.device_sn}>{r.device_sn}</span>
              <span className="text-[10px] text-text-secondary whitespace-nowrap"><RelTime ts={r.received_at} /></span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RecentDecisions({ rows }: { rows: DashboardSnapshot['recent_decisions'] }) {
  const { t } = useI18n();
  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2 mb-3">
        <ListChecks className="w-4 h-4 text-text-secondary" /> {t('dashboard.recent_decisions')}
      </h3>
      {rows.length === 0 ? (
        <p className="text-xs text-text-secondary">{t('dashboard.recent_decisions.empty')}</p>
      ) : (
        <div className="space-y-1">
          {rows.map(r => (
            <div key={r.id} className="flex items-center gap-3 text-xs px-2 py-1.5 bg-surface-dark rounded">
              <span className="text-text-secondary font-mono text-[10px]">#{r.id}</span>
              <span className="font-mono font-semibold text-text-primary flex-1 truncate">{r.license_plate}</span>
              <DecisionPill d={r.decision} />
              <span className="text-[10px] text-text-secondary whitespace-nowrap"><RelTime ts={r.come_called_at} /></span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
