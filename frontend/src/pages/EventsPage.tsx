import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera, ScanLine, ShieldCheck, Columns3, DoorOpen, Volume2,
  AlertOctagon, RotateCcw, LogOut, Loader2, X, ArrowDown, ArrowUp, Square, Car,
  Maximize2, Minimize2,
} from 'lucide-react';
import { getDashboard, type DashboardChannel } from '../services/dashboardService';
import { listChannels, s300EmergencyStop, s300ManualReset, s300Leave } from '../services/s300Service';
import type { S300Channel } from '../types/s300';
import { sendLaneAction } from '../services/roadBlockerService';
import { API_BASE, authHeaders } from '../services/adminService';
import { fmtIdleTime } from '../utils/helpers';
import { useI18n } from '../contexts/I18nContext';
import ConfirmDialog, { type ConfirmSpec } from '../components/ConfirmDialog';

/**
 * Events & Monitoring — live lane illustration. Each ENTRY channel is drawn as
 * a lane with its device stations in driving order: ANPR → UVIS → S300 → ROAD
 * BLOCKER. Every station is clickable and opens an action panel with the
 * commands that device supports. Status colours come from the dashboard
 * snapshot (heartbeats / probes), refreshed every 5s.
 */

type DeviceKey = 'anpr' | 'uvis' | 's300' | 'rb';
type Sel = { channelNo: string; device: DeviceKey } | null;

export default function EventsPage() {
  const { t } = useI18n();
  const [dash, setDash] = useState<DashboardChannel[]>([]);
  const [cfg, setCfg] = useState<S300Channel[]>([]);
  const [sel, setSel] = useState<Sel>(null);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  // Lane focus: 'all' or one channel_no — lets the operator watch a single
  // lane's flow instead of scanning the whole stack. Persisted per browser.
  const [lane, setLane] = useState<string>(() => localStorage.getItem('events_lane') || 'all');
  useEffect(() => { localStorage.setItem('events_lane', lane); }, [lane]);

  // Fullscreen (operator tablet): the PAGE element goes fullscreen, so the
  // sidebar and browser chrome disappear. Esc / the button exits.
  const pageRef = useRef<HTMLDivElement>(null);
  const [isFs, setIsFs] = useState(false);
  useEffect(() => {
    const doc = document as Document & { webkitFullscreenElement?: Element | null };
    const onChange = () => setIsFs(!!(document.fullscreenElement ?? doc.webkitFullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, []);
  const toggleFs = () => {
    const el = pageRef.current as (HTMLDivElement & { webkitRequestFullscreen?: () => void }) | null;
    const doc = document as Document & { webkitExitFullscreen?: () => void; webkitFullscreenElement?: Element | null };
    if (document.fullscreenElement ?? doc.webkitFullscreenElement) {
      if (document.exitFullscreen) document.exitFullscreen().catch(() => undefined);
      else doc.webkitExitFullscreen?.();
    } else if (el) {
      if (el.requestFullscreen) el.requestFullscreen().catch(() => undefined);
      else el.webkitRequestFullscreen?.();
    }
  };

  const showToast = useCallback((msg: string, ok: boolean) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const refresh = useCallback(async (first = false) => {
    try {
      const [snap, channels] = await Promise.all([getDashboard(), listChannels()]);
      setDash(snap.channels.filter(c => c.kind === 'entry' && c.enabled));
      setCfg(channels);
    } catch (e) {
      if (first) showToast((e as Error).message, false);
    }
  }, [showToast]);

  useEffect(() => {
    refresh(true);
    const tm = setInterval(() => refresh(), 5000);
    return () => clearInterval(tm);
  }, [refresh]);

  const cfgFor = (channelNo: string) => cfg.find(c => c.channel_no === channelNo);

  return (
    <div ref={pageRef} className="h-full overflow-y-auto p-6 bg-bg">
      <div className={`flex items-start justify-between gap-3 mb-4 ${isFs ? '' : 'max-w-5xl'}`}>
        <div>
          <h2 className="text-xl font-bold text-text-primary mb-1">{t('events.title')}</h2>
          <p className="text-sm text-text-secondary">{t('events.subtitle')}</p>
        </div>
        <button onClick={toggleFs}
          title={isFs ? t('events.fullscreen_exit') : t('events.fullscreen')}
          className="flex items-center gap-1.5 px-3 py-2 text-xs bg-surface-light border border-border text-text-secondary hover:text-text-primary rounded-lg transition-colors shrink-0">
          {isFs ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          {isFs ? t('events.fullscreen_exit') : t('events.fullscreen')}
        </button>
      </div>

      {toast && (
        <div className={`mb-4 max-w-4xl px-3 py-2 rounded-lg text-xs ${
          toast.ok ? 'bg-success/10 border border-success/30 text-success'
                   : 'bg-danger/10 border border-danger/30 text-danger'
        }`}>{toast.msg}</div>
      )}

      {/* Lane chooser — focus a single lane's flow or watch all of them */}
      {dash.length > 0 && (
        <div className={`flex flex-wrap items-center gap-1.5 mb-4 ${isFs ? '' : 'max-w-5xl'}`}>
          <button onClick={() => setLane('all')}
            className={`px-3 py-1.5 text-xs font-medium rounded-full transition ${
              lane === 'all' ? 'bg-primary text-white' : 'bg-surface-light text-text-secondary hover:text-text-primary'
            }`}>
            {t('events.lane_picker.all')}
          </button>
          {dash.map(ch => (
            <button key={ch.channel_no} onClick={() => setLane(ch.channel_no)}
              className={`px-3 py-1.5 text-xs font-mono font-medium rounded-full transition ${
                lane === ch.channel_no ? 'bg-primary text-white' : 'bg-surface-light text-text-secondary hover:text-text-primary'
              }`}>
              {ch.channel_no}{cfgFor(ch.channel_no)?.name ? ` · ${cfgFor(ch.channel_no)!.name}` : ''}
            </button>
          ))}
        </div>
      )}

      <div className={`${isFs ? 'space-y-6' : 'space-y-4 max-w-5xl'}`}>
        {(lane === 'all' ? dash : dash.filter(c => c.channel_no === lane)).map(ch => (
          <Lane key={ch.channel_no} ch={ch} cfg={cfgFor(ch.channel_no)}
            sel={sel} onSelect={setSel} showToast={showToast} />
        ))}
        {dash.length === 0 && (
          <p className="text-sm text-text-secondary py-8 text-center">{t('events.lanes.empty')}</p>
        )}
        {dash.length > 0 && lane !== 'all' && !dash.some(c => c.channel_no === lane) && (
          <p className="text-sm text-text-secondary py-8 text-center">{t('events.lane_picker.gone')}</p>
        )}
      </div>
    </div>
  );
}

// ---------- one lane ----------

function Lane({ ch, cfg, sel, onSelect, showToast }: {
  ch: DashboardChannel;
  cfg?: S300Channel;
  sel: Sel;
  onSelect: (s: Sel) => void;
  showToast: (msg: string, ok: boolean) => void;
}) {
  const { t } = useI18n();
  const uvisS300On = (cfg?.behavior_uvis_s300 ?? 1) === 1;
  const rbOn = (cfg?.blocker_relay_enabled ?? 0) === 1;   // lane has a blocker relay

  // online: true=green, false=red, null=grey (disabled / not applicable)
  const stations: { key: DeviceKey; icon: typeof Camera; label: string; online: boolean | null; detail: string }[] = [
    {
      key: 'anpr', icon: Camera, label: 'ANPR',
      online: ch.anpr_device_sn ? ch.anpr_status === 'ok' : null,
      detail: ch.anpr_device_sn
        ? `${ch.anpr_device_sn} · ${fmtIdleTime(ch.anpr_last_heartbeat_at ?? null)}`
        : t('events.lanes.no_sn'),
    },
    {
      key: 'uvis', icon: ScanLine, label: 'UVIS',
      online: uvisS300On ? (ch.s300?.reachable ?? false) : null,
      detail: uvisS300On ? t('events.lanes.uvis_via_s300') : t('events.lanes.stage_off'),
    },
    {
      key: 's300', icon: ShieldCheck, label: 'S300',
      online: uvisS300On ? (ch.s300?.reachable ?? false) : null,
      detail: uvisS300On
        ? (ch.s300?.reachable ? `${ch.s300.elapsed_ms ?? '?'}ms` : (ch.s300?.reason ?? 'unreachable'))
        : t('events.lanes.stage_off'),
    },
    {
      key: 'rb', icon: Columns3, label: t('events.lanes.rb'),
      online: rbOn ? (ch.road_blocker?.online ?? false) : null,
      detail: rbOn
        ? (() => {
            const pos = ch.road_blocker?.position;
            const posTxt = pos === 'up' ? t('rb.pos.up') : pos === 'down' ? t('rb.pos.down') : '';
            const live = ch.road_blocker?.online ? `${ch.road_blocker.age_sec ?? 0}s` : t('dashboard.rb.no_heartbeat');
            return posTxt ? `${posTxt} · ${live}` : live;
          })()
        : t('events.lanes.stage_off'),
    },
  ];

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      {/* Lane header */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border">
        <Car className="w-4 h-4 text-primary" />
        <span className="font-mono text-sm text-text-primary">{ch.channel_no}</span>
        {ch.name && <span className="text-xs text-text-secondary">— {ch.name}</span>}
        {ch.active_inspection && (
          <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400">
            {t('events.lanes.busy', { plate: ch.active_inspection.license_plate })}
          </span>
        )}
        {ch.last_plate && !ch.active_inspection && (
          <span className="ml-auto text-[10px] text-text-secondary font-mono">
            {t('events.lanes.last_plate')}: {ch.last_plate}
          </span>
        )}
      </div>

      {/* The road: hazard-striped edges, dashed centre line, stations on top */}
      <div className="relative px-6 py-5"
        style={{ background: 'repeating-linear-gradient(45deg,#facc15 0 10px,#1c1c1c 10px 20px) top/100% 6px no-repeat, repeating-linear-gradient(45deg,#facc15 0 10px,#1c1c1c 10px 20px) bottom/100% 6px no-repeat, #26282e' }}>
        <div className="absolute left-0 right-0 top-1/2 border-t-2 border-dashed border-gray-500/60" />
        <div className="relative flex items-center justify-between gap-2">
          {/* driving direction marker */}
          <div className="hidden sm:flex flex-col items-center text-text-secondary shrink-0">
            <Car className="w-6 h-6" />
            <span className="text-[9px] mt-0.5">{t('events.lanes.in')}</span>
          </div>
          {stations.map(s => {
            const Icon = s.icon;
            const active = sel?.channelNo === ch.channel_no && sel?.device === s.key;
            const dot = s.online ? 'bg-green-400' : s.online === false ? 'bg-red-400' : 'bg-gray-500';
            const ring = active ? 'border-primary bg-primary/10'
              : s.online ? 'border-green-500/40 bg-surface'
              : s.online === false ? 'border-red-500/40 bg-surface'
              : 'border-border bg-surface-dark opacity-60';
            return (
              <button key={s.key}
                onClick={() => onSelect(active ? null : { channelNo: ch.channel_no, device: s.key })}
                className={`relative z-10 flex flex-col items-center gap-1 border-2 rounded-xl px-4 py-3 min-w-[110px] transition hover:border-primary/70 cursor-pointer ${ring}`}>
                <span className={`absolute -top-1.5 -right-1.5 w-3 h-3 rounded-full border-2 border-surface ${dot}`} />
                <Icon className="w-6 h-6 text-text-primary" />
                <span className="text-xs font-semibold text-text-primary">{s.label}</span>
                <span className="text-[9px] text-text-secondary max-w-[130px] truncate">{s.detail}</span>
              </button>
            );
          })}
          <div className="hidden sm:flex flex-col items-center text-text-secondary shrink-0">
            <LogOut className="w-5 h-5" />
            <span className="text-[9px] mt-0.5">{t('events.lanes.out')}</span>
          </div>
        </div>
      </div>

      {/* Action panel for the selected station of THIS lane */}
      {sel?.channelNo === ch.channel_no && (
        <ActionPanel device={sel.device} ch={ch} cfg={cfg}
          onClose={() => onSelect(null)} showToast={showToast} />
      )}
    </div>
  );
}

// ---------- per-device actions ----------

function ActionPanel({ device, ch, cfg, onClose, showToast }: {
  device: DeviceKey;
  ch: DashboardChannel;
  cfg?: S300Channel;
  onClose: () => void;
  showToast: (msg: string, ok: boolean) => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<string | null>(null);
  const [speakText, setSpeakText] = useState('');
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await fn();
      showToast(t('controls.toast.sent'), true);
    } catch (e) {
      showToast(t('controls.toast.failed', { msg: (e as Error).message }), false);
    } finally { setBusy(null); }
  };

  // RAISE (close/up) drives the bollard up — crush hazard — so confirm first.
  const confirmRaise = (fn: () => void) => setConfirm({
    title: t('confirm.raise.title'),
    message: t('confirm.raise.msg_lane', { ch: ch.channel_no }),
    confirmLabel: t('confirm.raise.ok'),
    tone: 'danger',
    onConfirm: () => { setConfirm(null); fn(); },
  });

  const post = async (path: string, body: Record<string, unknown>) => {
    const res = await fetch(API_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok || data.code !== 200) throw new Error(data.message || `HTTP ${res.status}`);
  };

  const Btn = ({ label, icon: Icon, danger, onClick, disabled }: {
    label: string; icon: typeof Camera; danger?: boolean; onClick: () => void; disabled?: boolean;
  }) => (
    <button onClick={onClick} disabled={busy !== null || disabled}
      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border transition disabled:opacity-50 ${
        danger ? 'border-danger/40 text-danger hover:bg-danger/10'
               : 'border-border text-text-primary hover:bg-surface-light'
      }`}>
      {busy === label ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Icon className="w-3.5 h-3.5" />}
      {label}
    </button>
  );

  const titles: Record<DeviceKey, string> = {
    anpr: `ANPR — ${cfg?.anpr_device_sn ?? t('events.lanes.no_sn')}`,
    uvis: 'UVIS',
    s300: `S300 — ${ch.s300_base_url}`,
    rb: t('events.lanes.rb'),
  };

  return (
    <div className="border-t border-border px-4 py-3 bg-surface-dark/60">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-xs font-semibold text-text-primary">{titles[device]}</span>
        <span className="text-[10px] text-text-secondary font-mono">{ch.channel_no}</span>
        <button onClick={onClose} className="ml-auto p-1 text-text-secondary hover:text-text-primary">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {device === 'anpr' && (
        <div className="flex flex-wrap items-center gap-2">
          <Btn label={t('controls.gate.btn')} icon={DoorOpen} disabled={!cfg?.anpr_device_sn}
            onClick={() => run(t('controls.gate.btn'), () => post('/api/anpr/gate-open', { channel_no: ch.channel_no }))} />
          <input value={speakText} onChange={e => setSpeakText(e.target.value)}
            placeholder={t('controls.tts.placeholder')}
            className="px-2.5 py-1.5 bg-surface-dark border border-border rounded-md text-xs text-text-primary w-56" />
          <Btn label={t('controls.tts.btn')} icon={Volume2} disabled={!speakText.trim() || !cfg?.anpr_device_sn}
            onClick={() => run(t('controls.tts.btn'), () => post('/api/anpr/speak', { channel_no: ch.channel_no, text: speakText.trim() }))} />
        </div>
      )}

      {device === 'uvis' && (
        <p className="text-xs text-text-secondary">
          {t('events.lanes.uvis_info', { n: String(ch.uvis_timeout_sec) })}
        </p>
      )}

      {device === 's300' && (
        <div className="flex flex-wrap gap-2">
          <Btn label={t('events.lanes.s300_reset')} icon={RotateCcw}
            onClick={() => run(t('events.lanes.s300_reset'), () => s300ManualReset(ch.channel_no))} />
          <Btn label={t('events.lanes.s300_leave')} icon={LogOut}
            onClick={() => run(t('events.lanes.s300_leave'), () => s300Leave(ch.channel_no))} />
          <Btn label={t('events.lanes.s300_estop')} icon={AlertOctagon} danger
            onClick={() => run(t('events.lanes.s300_estop'), () => s300EmergencyStop(ch.channel_no))} />
        </div>
      )}

      {device === 'rb' && (
        <div className="flex flex-wrap gap-2">
          <Btn label={t('rb.btn.open')} icon={ArrowDown}
            onClick={() => run(t('rb.btn.open'), () => sendLaneAction(ch.channel_no, 'open'))} />
          <Btn label={t('rb.btn.close')} icon={ArrowUp}
            onClick={() => confirmRaise(() => run(t('rb.btn.close'), () => sendLaneAction(ch.channel_no, 'close')))} />
          <Btn label={t('rb.btn.stop')} icon={Square} danger
            onClick={() => run(t('rb.btn.stop'), () => sendLaneAction(ch.channel_no, 'stop'))} />
        </div>
      )}
      {confirm && <ConfirmDialog spec={confirm} onCancel={() => setConfirm(null)} />}
    </div>
  );
}
