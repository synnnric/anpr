import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Play, RotateCcw, AlertOctagon, Camera, LogOut,
  Loader2, ShieldCheck, Activity, Crown,
  Plus, Trash2, Edit2, X, Check, ChevronRight, AlertTriangle, Zap,
  ChevronDown, Wrench,
} from 'lucide-react';
import {
  listChannels, createChannel, updateChannel, deleteChannel,
  listInspections, getInspection, getChannelStatus,
  approveInspection, rejectInspection,
  s300Come, s300Capture, s300Leave, s300ReadWorkStatus,
  s300EmergencyStop, s300ManualReset,
  connectS300Events,
  listVipPlates, createVipPlate, deleteVipPlate, updateVipPlate,
  getSettings, updateSettings,
  type S300Event,
} from '../services/s300Service';
import type {
  S300Channel, Inspection, InspectionDetail,
  VipPlate, ChannelStatus, OperationEntry, Decision, UvisCoord,
} from '../types/s300';
import { OPERATING_STATE_COLORS } from '../types/s300';
import { useMqtt } from '../contexts/MqttContext';
import { useAuth } from '../contexts/AuthContext';
import ImageWithFallback from '../components/ImageWithFallback';
import facePlaceholder from '../assets/face-placeholder.svg';
import uvisPlaceholder from '../assets/uvis-placeholder.svg';
import cameraPlaceholder from '../assets/camera-placeholder.svg';
import { fmtPgTs, fmtPgTime } from '../utils/helpers';
import { useI18n } from '../contexts/I18nContext';
import type { TKey } from '../i18n/translations';

type TabKey = 'live' | 'history' | 'channels' | 'vip' | 'settings';

const DECISION_STYLE: Record<Decision, { bg: string; text: string; icon: string; key: TKey }> = {
  pending:  { bg: 'bg-surface-dark border border-border',           text: 'text-text-secondary', icon: '⋯', key: 's300.decision.pending' },
  pass:     { bg: 'bg-green-500/20 border border-green-500/50',     text: 'text-green-400',      icon: '✓', key: 's300.decision.pass' },
  suspect:  { bg: 'bg-amber-500/20 border border-amber-500/50',     text: 'text-amber-400',      icon: '!', key: 's300.decision.suspect' },
  fail:     { bg: 'bg-red-500/20 border border-red-500/50',         text: 'text-red-400',        icon: '✗', key: 's300.decision.fail' },
  vip_pass: { bg: 'bg-violet-500/20 border border-violet-500/50',   text: 'text-violet-300',     icon: '★', key: 's300.decision.vip_pass' },
};

const OP_STATE_KEYS: Record<number, TKey> = {
  0: 's300.op_state.ready',
  1: 's300.op_state.inspecting',
  2: 's300.op_state.resetting',
  3: 's300.op_state.reset_complete',
  4: 's300.op_state.emergency_stop',
  5: 's300.op_state.equipment_failure',
  6: 's300.op_state.self_testing',
};

export default function S300InspectionPage() {
  const { t } = useI18n();
  const { user } = useAuth();
  const [tab, setTab] = useState<TabKey>('live');
  const [channels, setChannels] = useState<S300Channel[]>([]);
  const [activeChannel, setActiveChannel] = useState<string>('');
  const [selectedInspection, setSelectedInspection] = useState<InspectionDetail | null>(null);
  const [inspections, setInspections] = useState<Inspection[]>([]);
  const [latestPlate, setLatestPlate] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [reviewModalOpen, setReviewModalOpen] = useState(false);
  const [dismissedReviews, setDismissedReviews] = useState<Set<number>>(() => new Set());
  const lastEventRef = useRef<number>(0);
  const { recognitions } = useMqtt();

  const showToast = useCallback((msg: string, ok: boolean) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const refreshChannels = useCallback(async () => {
    try {
      const list = await listChannels();
      setChannels(list);
      if (!activeChannel && list.length) setActiveChannel(list[0].channel_no);
    } catch (e) {
      showToast(t('s300.toast.channels_load_failed', { msg: (e as Error).message }), false);
    }
  }, [activeChannel, showToast, t]);

  const refreshInspections = useCallback(async (silent = false) => {
    try {
      const data = await listInspections({ limit: 30 });
      setInspections(data.items);
    } catch (e) {
      if (!silent) showToast(t('s300.toast.inspections_load_failed', { msg: (e as Error).message }), false);
    }
  }, [showToast, t]);

  useEffect(() => {
    refreshChannels();
    refreshInspections();
  }, [refreshChannels, refreshInspections]);

  useEffect(() => {
    const tm = setInterval(() => {
      refreshInspections(true);
      if (selectedInspection) {
        getInspection(selectedInspection.id)
          .then(setSelectedInspection)
          .catch(() => undefined);
      }
    }, 3000);
    return () => clearInterval(tm);
  }, [refreshInspections, selectedInspection]);

  useEffect(() => {
    if (recognitions[0]) {
      setLatestPlate(recognitions[0].licensePlain || recognitions[0].license);
    }
  }, [recognitions]);

  useEffect(() => {
    const cleanup = connectS300Events((e: S300Event) => {
      lastEventRef.current = Date.now();
      refreshInspections();
      const payload = e.payload as { inspectionId?: number; channelNo?: string };
      if (selectedInspection && payload?.inspectionId === selectedInspection.id) {
        getInspection(selectedInspection.id).then(setSelectedInspection).catch(() => undefined);
      }
    });
    return cleanup;
  }, [refreshInspections, selectedInspection]);

  const act = useCallback(async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await fn();
      showToast(t('s300.toast.action_ok', { label }), true);
      refreshInspections();
    } catch (e) {
      showToast(t('s300.toast.action_fail', { label, msg: (e as Error).message }), false);
    } finally {
      setBusy(null);
    }
  }, [showToast, refreshInspections, t]);

  // Suspect vehicles waiting for a human decision — surfaced as a popup so the
  // operator can act without opening the detail row.
  const pendingReviews = useMemo(
    () => inspections.filter(i => i.decision === 'suspect' && i.review_status === 'pending'),
    [inspections],
  );

  // Auto-open when a NEW (not-yet-dismissed) review arrives; auto-close when the
  // queue is empty.
  useEffect(() => {
    if (pendingReviews.some(i => !dismissedReviews.has(i.id))) setReviewModalOpen(true);
    else if (pendingReviews.length === 0) setReviewModalOpen(false);
  }, [pendingReviews, dismissedReviews]);

  const closeReviewModal = useCallback(() => {
    setDismissedReviews(prev => {
      const next = new Set(prev);
      pendingReviews.forEach(i => next.add(i.id));
      return next;
    });
    setReviewModalOpen(false);
  }, [pendingReviews]);

  const tabLabel = (k: TabKey) => t(`s300.tab.${k}` as 's300.tab.live');

  return (
    <div className="h-full flex flex-col bg-bg overflow-hidden">
      <header className="bg-surface border-b border-border px-6 py-4 shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-text-primary flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-primary" /> {t('s300.title')}
            </h1>
            <p className="text-xs text-text-secondary mt-0.5">
              {t('s300.subtitle')}
            </p>
          </div>
          <div className="flex gap-1 bg-surface-dark p-1 rounded-lg">
            {(['live','history','channels','vip','settings'] as TabKey[]).map(k => (
              <button key={k} onClick={() => setTab(k)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md capitalize transition ${
                  tab === k ? 'bg-primary text-white' : 'text-text-secondary hover:text-text-primary'
                }`}>{tabLabel(k)}</button>
            ))}
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        {tab === 'live' && (
          <LiveTab
            channels={channels}
            activeChannel={activeChannel}
            onChangeChannel={setActiveChannel}
            latestPlate={latestPlate}
            onPlateChange={setLatestPlate}
            inspections={inspections}
            selected={selectedInspection}
            onSelect={async (i) => {
              try { setSelectedInspection(await getInspection(i.id)); }
              catch (e) { showToast(t('s300.toast.load_failed', { msg: (e as Error).message }), false); }
            }}
            busy={busy}
            onAction={act}
            actions={{
              come: () => s300Come(activeChannel, latestPlate),
              capture: () => s300Capture(activeChannel),
              leave: () => s300Leave(activeChannel),
              readStatus: () => s300ReadWorkStatus(activeChannel),
              emergencyStop: () => s300EmergencyStop(activeChannel),
              manualReset: () => s300ManualReset(activeChannel),
            }}
          />
        )}
        {tab === 'history' && (
          <HistoryTab
            inspections={inspections}
            onSelect={async (i) => {
              try {
                const detail = await getInspection(i.id);
                setSelectedInspection(detail);
                setTab('live');
              } catch (e) { showToast(t('s300.toast.load_failed', { msg: (e as Error).message }), false); }
            }}
          />
        )}
        {tab === 'channels' && (
          <ChannelsTab channels={channels} reload={refreshChannels} showToast={showToast} />
        )}
        {tab === 'vip' && <VipTab showToast={showToast} />}
        {tab === 'settings' && <SettingsTab channels={channels} showToast={showToast} />}
      </div>

      {toast && (
        <div className={`fixed bottom-6 right-6 px-4 py-3 rounded-lg shadow-lg text-sm font-medium z-50 ${
          toast.ok ? 'bg-green-600 text-white' : 'bg-red-600 text-white'
        }`}>{toast.msg}</div>
      )}

      {reviewModalOpen && pendingReviews.length > 0 && (
        <ReviewQueueModal
          items={pendingReviews}
          busy={busy}
          onAction={act}
          onClose={closeReviewModal}
          canReview={user?.role !== 'viewer'}
        />
      )}
    </div>
  );
}

// ============================ LIVE TAB ============================
interface LiveActions {
  come: () => Promise<unknown>;
  capture: () => Promise<unknown>;
  leave: () => Promise<unknown>;
  readStatus: () => Promise<unknown>;
  emergencyStop: () => Promise<unknown>;
  manualReset: () => Promise<unknown>;
}

function LiveTab(props: {
  channels: S300Channel[];
  activeChannel: string;
  onChangeChannel: (c: string) => void;
  latestPlate: string;
  onPlateChange: (p: string) => void;
  inspections: Inspection[];
  selected: InspectionDetail | null;
  onSelect: (i: Inspection) => void;
  busy: string | null;
  onAction: (label: string, fn: () => Promise<unknown>) => Promise<void>;
  actions: LiveActions;
}) {
  const { t } = useI18n();
  const { channels, activeChannel, onChangeChannel, latestPlate, onPlateChange,
    inspections, selected, onSelect, busy, onAction, actions } = props;

  const [channelStatus, setChannelStatus] = useState<ChannelStatus | null>(null);
  useEffect(() => {
    if (!activeChannel) { setChannelStatus(null); return; }
    let alive = true;
    const poll = async () => {
      try {
        const s = await getChannelStatus(activeChannel);
        if (alive) setChannelStatus(s);
      } catch { /* ignore */ }
    };
    poll();
    const tm = setInterval(poll, 2500);
    return () => { alive = false; clearInterval(tm); };
  }, [activeChannel, inspections]);

  const channelBusy = !!channelStatus?.busy;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
      {channelBusy && (
        <div className="xl:col-span-12 bg-amber-500/15 border border-amber-500/40 rounded-lg p-3 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0" />
          <div className="flex-1 text-sm">
            <span className="text-amber-500 font-semibold">{t('s300.busy.label')}</span>
            <span className="text-text-secondary"> — </span>
            <span className="font-mono text-text-primary">{channelStatus?.active?.license_plate}</span>
            <span className="text-text-secondary"> {t('s300.busy.detail', { state: channelStatus?.active?.state ?? '', op: channelStatus?.operating_state ?? '' })}</span>
          </div>
        </div>
      )}
      {/* Left column: control panel */}
      <div className="xl:col-span-4 space-y-4">
        <Panel title={t('s300.panel.channel_vehicle')}>
          <label className="block text-xs text-text-secondary mb-1">{t('s300.label.channel')}</label>
          <select value={activeChannel} onChange={e => onChangeChannel(e.target.value)}
            className="w-full px-3 py-2 bg-surface-dark border border-border rounded-md text-sm text-text-primary mb-3">
            {channels.length === 0 && <option value="">{t('s300.label.no_channels')}</option>}
            {channels.map(c => (
              <option key={c.id} value={c.channel_no}>
                {c.channel_no} {c.name ? `— ${c.name}` : ''}
              </option>
            ))}
          </select>

          <label className="block text-xs text-text-secondary mb-1">{t('s300.label.plate')}</label>
          <input value={latestPlate} onChange={e => onPlateChange(e.target.value)}
            placeholder={t('s300.label.plate_placeholder')}
            className="w-full px-3 py-2 bg-surface-dark border border-border rounded-md text-sm text-text-primary font-mono" />
          <p className="text-[10px] text-text-secondary mt-1">
            {t('s300.label.plate_hint')}
          </p>
        </Panel>

        <div className="bg-red-500/10 border border-red-500/40 rounded-lg p-4">
          <h3 className="text-xs font-semibold text-red-400 uppercase tracking-wide mb-2">{t('s300.emergency.title')}</h3>
          <button onClick={() => {
            if (confirm(t('s300.emergency.confirm'))) {
              onAction('emergencyStop', actions.emergencyStop);
            }
          }} disabled={!activeChannel || busy === 'emergencyStop'}
            className="w-full flex items-center justify-center gap-2 px-3 py-3 rounded-md text-sm font-bold transition bg-red-600 hover:bg-red-700 text-white disabled:opacity-50">
            {busy === 'emergencyStop' ? <Loader2 className="w-5 h-5 animate-spin" /> : <AlertOctagon className="w-5 h-5" />}
            {t('s300.emergency.btn')}
          </button>
        </div>

        <ManualOverridePanel
          activeChannel={activeChannel}
          latestPlate={latestPlate}
          channelBusy={channelBusy}
          busy={busy}
          onAction={onAction}
          actions={actions}
        />

        <Panel title={t('s300.panel.recent')}>
          {inspections.slice(0, 8).map(i => {
            const meta = DECISION_STYLE[i.decision];
            return (
              <button key={i.id} onClick={() => onSelect(i)}
                className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-md text-left transition mb-1 ${
                  selected?.id === i.id ? 'bg-primary/20 border border-primary' : 'bg-surface-dark hover:bg-surface-light border border-transparent'
                }`}>
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-sm text-text-primary truncate">{i.license_plate}</div>
                  <div className="text-[10px] text-text-secondary">
                    {i.channel_no} · {i.state}
                    {i.current_operating_state !== null && ` · op=${i.current_operating_state}`}
                  </div>
                </div>
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold shrink-0 ${meta.bg} ${meta.text}`}>
                  {meta.icon} {t(meta.key).split(' ')[0]}
                </span>
                <ChevronRight className="w-3 h-3 text-text-secondary shrink-0" />
              </button>
            );
          })}
          {inspections.length === 0 && (
            <p className="text-xs text-text-secondary italic text-center py-3">{t('s300.recent.empty')}</p>
          )}
        </Panel>
      </div>

      {/* Right column: inspection detail */}
      <div className="xl:col-span-8">
        {selected ? (
          <InspectionDetailView insp={selected} onAction={onAction} busy={busy} />
        ) : (
          <div className="bg-surface rounded-lg border border-border p-8 text-center">
            <ShieldCheck className="w-12 h-12 text-text-secondary mx-auto mb-3" />
            <p className="text-text-secondary text-sm">
              {t('s300.empty.title')}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function ManualOverridePanel({ activeChannel, latestPlate, channelBusy, busy, onAction, actions }: {
  activeChannel: string;
  latestPlate: string;
  channelBusy: boolean;
  busy: string | null;
  onAction: (label: string, fn: () => Promise<unknown>) => Promise<void>;
  actions: LiveActions;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const wrap = (label: string, fn: () => Promise<unknown>) => {
    if (!confirm(t('s300.manual.confirm', { label }))) return;
    onAction(label, fn);
  };
  return (
    <div className="bg-surface border border-border rounded-lg">
      <button onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3">
        <span className="text-xs font-semibold text-text-secondary uppercase tracking-wide flex items-center gap-2">
          <Wrench className="w-3.5 h-3.5" />
          {t('s300.manual.title')}
        </span>
        <ChevronDown className={`w-4 h-4 text-text-secondary transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="p-4 pt-1 border-t border-border space-y-2">
          <p className="text-[10px] text-text-secondary italic mb-2">
            {t('s300.manual.hint')}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <ActionButton label={t('s300.action.come')} icon={Play} color="primary"
              disabled={!activeChannel || !latestPlate || channelBusy}
              busy={busy === 'come'}
              onClick={() => wrap('come', actions.come)} />
            <ActionButton label={t('s300.action.capture')} icon={Camera} color="default"
              disabled={!activeChannel}
              busy={busy === 'capture'}
              onClick={() => wrap('capture', actions.capture)} />
            <ActionButton label={t('s300.action.leave')} icon={LogOut} color="warning"
              disabled={!activeChannel}
              busy={busy === 'leave'}
              onClick={() => wrap('leave', actions.leave)} />
            <ActionButton label={t('s300.action.read_status')} icon={Activity} color="default"
              disabled={!activeChannel}
              busy={busy === 'readStatus'}
              onClick={() => wrap('readStatus', actions.readStatus)} />
            <ActionButton label={t('s300.action.manual_reset')} icon={RotateCcw} color="default"
              disabled={!activeChannel}
              busy={busy === 'manualReset'}
              onClick={() => wrap('manualReset', actions.manualReset)} />
          </div>
        </div>
      )}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface border border-border rounded-lg p-4">
      <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-3">{title}</h3>
      {children}
    </div>
  );
}

/**
 * UVIS scan image + foreign-object coordinate overlay.
 *
 * Coords come from the device in the scan's NATIVE pixel space, but the image
 * is displayed scaled (max-w-full) — so we scale the boxes by displayed/natural
 * size on load, clip them with overflow-hidden, and only draw them on the real
 * image (never on the dummy placeholder, where they'd be meaningless and used
 * to bleed into the panels below).
 */
function UvisImage({ src, coords }: { src: string | null; coords: UvisCoord[] }) {
  const [usingDummy, setUsingDummy] = useState(false);
  const [scale, setScale] = useState({ x: 1, y: 1 });
  const showOverlay = !usingDummy && !!src && coords.length > 0;

  return (
    <div className="relative inline-block max-w-full overflow-hidden rounded border border-border">
      <ImageWithFallback
        src={src}
        alt="UVIS"
        fallback={uvisPlaceholder}
        onFallbackChange={setUsingDummy}
        className="block max-w-full w-auto"
        onLoad={(e) => {
          const img = e.currentTarget;
          if (img.naturalWidth > 0) {
            setScale({ x: img.clientWidth / img.naturalWidth, y: img.clientHeight / img.naturalHeight });
          }
        }}
      />
      {showOverlay && coords.map((c, idx) => (
        <div key={idx}
          className="absolute border-2 border-red-500 bg-red-500/20"
          style={{
            left: c.x1 * scale.x, top: c.y1 * scale.y,
            width: (c.x2 - c.x1) * scale.x, height: (c.y2 - c.y1) * scale.y,
          }}>
          <span className="absolute -top-5 left-0 text-[10px] bg-red-500 text-white px-1 rounded whitespace-nowrap">
            {(Number(c.confidence) * 100).toFixed(0)}%
          </span>
        </div>
      ))}
    </div>
  );
}

function ActionButton({ label, icon: Icon, color, disabled, busy, onClick }: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  color: 'primary'|'danger'|'warning'|'default';
  disabled?: boolean;
  busy?: boolean;
  onClick: () => void;
}) {
  const colorClass = {
    primary: 'bg-primary hover:bg-primary/90 text-white',
    danger: 'bg-red-600 hover:bg-red-700 text-white',
    warning: 'bg-amber-600 hover:bg-amber-700 text-white',
    default: 'bg-surface-dark hover:bg-surface-light text-text-primary border border-border',
  }[color];
  return (
    <button onClick={onClick} disabled={disabled || busy}
      className={`flex items-center gap-2 px-3 py-2 rounded-md text-xs font-medium transition disabled:opacity-50 disabled:cursor-not-allowed ${colorClass}`}>
      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Icon className="w-4 h-4" />}
      {label}
    </button>
  );
}

// ============================ INSPECTION DETAIL ============================
function InspectionDetailView({ insp, onAction, busy }: {
  insp: InspectionDetail;
  onAction: (label: string, fn: () => Promise<unknown>) => Promise<void>;
  busy: string | null;
}) {
  const { t } = useI18n();
  const lastState = insp.current_operating_state ?? 0;
  return (
    <div className="space-y-4">
      <DecisionBanner insp={insp} />
      <ReviewPanel insp={insp} onAction={onAction} busy={busy} />
      <div className="bg-surface border border-border rounded-lg p-4">
        <div className="flex items-start justify-between mb-3">
          <div>
            <div className="text-[10px] text-text-secondary uppercase tracking-wide">{t('s300.detail.inspection_id', { id: insp.id })}</div>
            <div className="font-mono text-2xl text-text-primary mt-0.5">{insp.license_plate}</div>
            <div className="text-xs text-text-secondary mt-1">{t('s300.detail.channel_state', { ch: insp.channel_no, state: insp.state })}</div>
          </div>
          <StateBadge state={lastState} />
        </div>
        <Timeline insp={insp} />
      </div>

      {insp.video_streams.length > 0 && (
        <Panel title={t('s300.video.title', { n: insp.video_streams.length })}>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {insp.video_streams.map(s => (
              <div key={s.id} className="bg-black aspect-video rounded relative overflow-hidden">
                <ImageWithFallback src={null} alt={s.camera_code} fallback={cameraPlaceholder}
                  className="w-full h-full object-cover" />
                <div className="absolute top-1 left-1 text-[10px] font-mono text-white/80 bg-black/60 px-1.5 py-0.5 rounded">{s.camera_code}</div>
                <div className="absolute bottom-1 inset-x-1 text-[9px] text-white/40 font-mono text-center break-all">{s.stream_url}</div>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-text-secondary mt-2 italic">
            {t('s300.video.hint')}
          </p>
        </Panel>
      )}

      {insp.face_images.length > 0 && (
        <Panel title={t('s300.face.title', { n: insp.face_images.length })}>
          <div className="grid grid-cols-3 md:grid-cols-4 gap-2">
            {insp.face_images.map(f => (
              <div key={f.id} className="aspect-square bg-surface-dark border border-border rounded overflow-hidden">
                <ImageWithFallback src={f.image_url} alt="face" fallback={facePlaceholder} className="w-full h-full object-cover" />
              </div>
            ))}
          </div>
        </Panel>
      )}

      {insp.uvis.length > 0 && (
        <Panel title={t('s300.uvis.title', { n: insp.uvis.length })}>
          <div className="space-y-3">
            {insp.uvis.map(u => (
              <div key={u.id} className="border border-border rounded p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-xs">
                    <span className="text-text-secondary">{t('s300.uvis.type')}</span>
                    <span className={`ml-1 font-medium ${u.image_type === 1 ? 'text-red-500' : 'text-green-500'}`}>
                      {u.image_type === 1 ? t('s300.uvis.foreign_object') : t('s300.uvis.clean')}
                    </span>
                  </div>
                  <div className="text-[10px] text-text-secondary">{t('s300.uvis.objects', { n: u.object_count })}</div>
                </div>
                <UvisImage src={u.image_url} coords={u.coords} />
              </div>
            ))}
          </div>
        </Panel>
      )}

      {insp.operations.length > 0 && (
        <Panel title={t('s300.op_log.title', { n: insp.operations.length })}>
          <div className="space-y-1 max-h-72 overflow-y-auto">
            {insp.operations.map(op => <OpLogRow key={op.id} op={op} />)}
          </div>
        </Panel>
      )}

      {insp.status_logs.length > 0 && (
        <Panel title={t('s300.status_log.title', { n: insp.status_logs.length })}>
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {insp.status_logs.slice().reverse().map(l => (
              <div key={l.id} className="flex items-center gap-2 text-xs px-2 py-1 bg-surface-dark rounded">
                <StateBadge state={l.operating_state} small />
                <span className="text-text-secondary font-mono text-[10px] ml-auto">{fmtPgTs(l.received_at)}</span>
              </div>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}

function DecisionBanner({ insp }: { insp: InspectionDetail }) {
  const { t } = useI18n();
  const meta = DECISION_STYLE[insp.decision];
  const isAction = ['pass', 'suspect', 'vip_pass'].includes(insp.decision);
  return (
    <div className={`rounded-lg p-4 ${meta.bg}`}>
      <div className="flex items-center gap-3">
        <div className={`text-3xl font-bold ${meta.text}`}>{meta.icon}</div>
        <div className="flex-1">
          <div className={`text-lg font-bold ${meta.text}`}>{t(meta.key)}</div>
          {insp.decision_reason && <div className="text-xs text-text-secondary mt-0.5">{insp.decision_reason}</div>}
          <div className="text-[10px] text-text-secondary mt-1 font-mono space-x-3">
            {insp.decision_at && <span>{t('s300.decision.banner.decided', { ts: fmtPgTime(insp.decision_at) })}</span>}
            {insp.blocker_opened ? <span className="text-green-400">{t('s300.decision.banner.blocker_opened', { ts: fmtPgTime(insp.blocker_opened_at) })}</span> : insp.decision === 'fail' ? <span className="text-red-400">{t('s300.decision.banner.blocker_stayed')}</span> : null}
            {insp.auto_leave_called ? <span className="text-text-secondary">{t('s300.decision.banner.auto_leave')}</span> : null}
          </div>
        </div>
        {isAction && insp.blocker_opened === 0 && (
          <div className="text-xs text-amber-400">{t('s300.decision.banner.awaiting')}</div>
        )}
      </div>
    </div>
  );
}

/**
 * Manual-review gate for a SUSPECT inspection. Shows Approve / Reject buttons
 * while review_status is 'pending', and a resolved line (with the username) once
 * an operator has decided. Viewers can't act.
 */
function ReviewPanel({ insp, onAction, busy }: {
  insp: InspectionDetail;
  onAction: (label: string, fn: () => Promise<unknown>) => Promise<void>;
  busy: string | null;
}) {
  const { t } = useI18n();
  const { user } = useAuth();
  if (insp.decision !== 'suspect') return null;

  // Already decided → show who and when.
  if (insp.review_status === 'approved' || insp.review_status === 'rejected') {
    const approved = insp.review_status === 'approved';
    return (
      <div className={`rounded-lg p-3 text-sm border ${approved ? 'bg-green-500/10 border-green-500/40 text-green-300' : 'bg-red-500/10 border-red-500/40 text-red-300'}`}>
        {t(approved ? 's300.review.approved_by' : 's300.review.rejected_by', {
          by: insp.reviewed_by || '—',
          ts: fmtPgTime(insp.reviewed_at),
        })}
      </div>
    );
  }

  // Awaiting a human decision.
  if (insp.review_status !== 'pending') return null;
  const canReview = user?.role !== 'viewer';

  return (
    <div className="rounded-lg p-4 bg-amber-500/10 border border-amber-500/40">
      <div className="flex items-center gap-2 text-amber-300 font-semibold mb-1">
        <AlertTriangle className="w-4 h-4" /> {t('s300.review.title')}
      </div>
      <p className="text-xs text-text-secondary mb-3">
        {insp.decision_reason || t('s300.review.desc')}
      </p>
      {canReview ? (
        <div className="flex gap-2">
          <button
            disabled={!!busy}
            onClick={() => onAction(t('s300.review.approve'), () => approveInspection(insp.id))}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-sm font-semibold bg-green-600 hover:bg-green-500 text-white disabled:opacity-50">
            <Check className="w-4 h-4" /> {t('s300.review.approve')}
          </button>
          <button
            disabled={!!busy}
            onClick={() => onAction(t('s300.review.reject'), () => rejectInspection(insp.id))}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-sm font-semibold bg-red-600 hover:bg-red-500 text-white disabled:opacity-50">
            <X className="w-4 h-4" /> {t('s300.review.reject')}
          </button>
        </div>
      ) : (
        <p className="text-xs text-amber-300/80 italic">{t('s300.review.viewer_blocked')}</p>
      )}
    </div>
  );
}

/**
 * Auto-popup that lists every SUSPECT inspection awaiting manual review, with
 * Approve / Reject right in the dialog — so the operator never has to open a
 * detail row to act. Shown over the whole inspection page.
 */
function ReviewQueueModal({ items, busy, onAction, onClose, canReview }: {
  items: Inspection[];
  busy: string | null;
  onAction: (label: string, fn: () => Promise<unknown>) => Promise<void>;
  onClose: () => void;
  canReview: boolean;
}) {
  const { t } = useI18n();
  if (!items.length) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-surface border border-amber-500/50 rounded-lg w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div className="flex items-center gap-2 text-amber-400 font-semibold">
            <AlertTriangle className="w-5 h-5" /> {t('s300.review.modal_title', { n: items.length })}
          </div>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary" aria-label="close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 space-y-3 max-h-[60vh] overflow-y-auto">
          {items.map(i => (
            <div key={i.id} className="bg-surface-dark border border-border rounded-md p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="font-mono text-lg text-text-primary">{i.license_plate}</span>
                <span className="text-[10px] text-text-secondary">{t('s300.detail.inspection_id', { id: i.id })} · {i.channel_no}</span>
              </div>
              {i.decision_reason && <p className="text-xs text-text-secondary mb-2">{i.decision_reason}</p>}
              {canReview ? (
                <div className="flex gap-2">
                  <button disabled={!!busy}
                    onClick={() => onAction(t('s300.review.approve'), () => approveInspection(i.id))}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-sm font-semibold bg-green-600 hover:bg-green-500 text-white disabled:opacity-50">
                    <Check className="w-4 h-4" /> {t('s300.review.approve')}
                  </button>
                  <button disabled={!!busy}
                    onClick={() => onAction(t('s300.review.reject'), () => rejectInspection(i.id))}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-sm font-semibold bg-red-600 hover:bg-red-500 text-white disabled:opacity-50">
                    <X className="w-4 h-4" /> {t('s300.review.reject')}
                  </button>
                </div>
              ) : (
                <p className="text-xs text-amber-300/80 italic">{t('s300.review.viewer_blocked')}</p>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function OpLogRow({ op }: { op: OperationEntry }) {
  const { t } = useI18n();
  const colors: Record<string, string> = {
    come: 'text-blue-400',
    auto_decision: 'text-violet-400',
    open_blocker: 'text-green-400',
    open_blocker_skipped: 'text-amber-400',
    send_backup_audio: 'text-red-400',
    auto_leave: 'text-text-secondary',
    capture: 'text-cyan-400',
    emergency_stop: 'text-red-500',
    manual_reset: 'text-amber-400',
    read_work_status: 'text-text-secondary',
    come_vip_bypass: 'text-violet-400',
    review_required: 'text-amber-400',
    review_approve: 'text-green-400',
    review_reject: 'text-red-400',
  };
  const color = colors[op.action] || 'text-text-primary';
  const statusColor = op.status === 'success' ? 'text-green-400' : 'text-red-400';
  const isManual = ['capture', 'leave', 'manual_reset', 'emergency_stop', 'read_work_status'].includes(op.action);
  return (
    <div className="text-[11px] flex items-start gap-2 px-2 py-1 bg-surface-dark rounded font-mono">
      <span className="text-text-secondary shrink-0">{fmtPgTime(op.created_at)}</span>
      <span className={`shrink-0 font-semibold ${color}`}>{op.action}</span>
      {isManual && <span className="text-amber-300 shrink-0">{t('s300.op.manual_tag')}</span>}
      <span className={`shrink-0 ${statusColor}`}>{op.status}</span>
      {op.actor_username && <span className="text-sky-300 shrink-0">{t('s300.op.by', { user: op.actor_username })}</span>}
      {op.error_message && <span className="text-red-400 italic">{op.error_message}</span>}
    </div>
  );
}

function StateBadge({ state, small }: { state: number; small?: boolean }) {
  const { t } = useI18n();
  const key = OP_STATE_KEYS[state];
  const label = key ? t(key) : t('s300.state.fmt', { n: state });
  const dot = OPERATING_STATE_COLORS[state] ?? 'bg-gray-500';
  return (
    <span className={`inline-flex items-center gap-1.5 ${small ? 'text-[10px]' : 'text-xs'} text-text-primary`}>
      <span className={`${dot} ${small ? 'w-1.5 h-1.5' : 'w-2 h-2'} rounded-full`} />
      {label}
    </span>
  );
}

function Timeline({ insp }: { insp: InspectionDetail }) {
  const { t } = useI18n();
  const steps = useMemo(() => [
    { label: t('s300.timeline.come'), at: insp.come_called_at },
    { label: t('s300.timeline.inspecting'), at: insp.inspection_started_at },
    { label: t('s300.timeline.reset'), at: insp.inspection_ended_at },
    { label: t('s300.timeline.leave'), at: insp.leave_called_at },
    { label: t('s300.timeline.complete'), at: insp.reset_completed_at },
  ], [insp, t]);
  return (
    <div className="flex items-center gap-1 mt-2">
      {steps.map((s, i) => (
        <div key={i} className="flex-1 flex flex-col items-center">
          <div className={`w-3 h-3 rounded-full ${s.at ? 'bg-primary' : 'bg-surface-dark border border-border'}`} />
          <div className="text-[10px] text-text-secondary mt-1">{s.label}</div>
          {s.at && <div className="text-[9px] text-text-secondary/70 font-mono">{fmtPgTime(s.at)}</div>}
        </div>
      ))}
    </div>
  );
}

// ============================ HISTORY TAB ============================
function HistoryTab({ inspections, onSelect }: {
  inspections: Inspection[];
  onSelect: (i: Inspection) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="bg-surface border border-border rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-surface-dark text-text-secondary text-xs uppercase">
          <tr>
            <th className="text-left px-4 py-2">{t('s300.hist.col.id')}</th>
            <th className="text-left px-4 py-2">{t('s300.hist.col.plate')}</th>
            <th className="text-left px-4 py-2">{t('s300.hist.col.decision')}</th>
            <th className="text-left px-4 py-2">{t('s300.hist.col.reason')}</th>
            <th className="text-left px-4 py-2">{t('s300.hist.col.blocker')}</th>
            <th className="text-left px-4 py-2">{t('s300.hist.col.time')}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {inspections.map(i => {
            const meta = DECISION_STYLE[i.decision];
            return (
              <tr key={i.id} className="border-t border-border hover:bg-surface-dark cursor-pointer"
                onClick={() => onSelect(i)}>
                <td className="px-4 py-2 text-text-secondary font-mono">#{i.id}</td>
                <td className="px-4 py-2 font-mono text-text-primary">{i.license_plate}</td>
                <td className="px-4 py-2">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${meta.bg} ${meta.text}`}>
                    {meta.icon} {t(meta.key)}
                  </span>
                </td>
                <td className="px-4 py-2 text-text-secondary text-xs">{i.decision_reason ?? '-'}</td>
                <td className="px-4 py-2 text-xs">
                  {i.blocker_opened ? <span className="text-green-400">{t('s300.hist.blocker_opened')}</span>
                    : i.decision === 'fail' ? <span className="text-red-400">{t('s300.hist.blocker_closed')}</span>
                    : <span className="text-text-secondary">-</span>}
                </td>
                <td className="px-4 py-2 text-text-secondary font-mono text-xs">{i.come_called_at ? fmtPgTime(i.come_called_at) : '-'}</td>
                <td className="px-4 py-2"><ChevronRight className="w-4 h-4 text-text-secondary" /></td>
              </tr>
            );
          })}
          {inspections.length === 0 && (
            <tr><td colSpan={7} className="px-4 py-8 text-center text-text-secondary text-sm">{t('s300.hist.empty')}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ============================ CHANNELS TAB ============================
function ChannelsTab({ channels, reload, showToast }: {
  channels: S300Channel[];
  reload: () => Promise<void>;
  showToast: (msg: string, ok: boolean) => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState<S300Channel | null>(null);
  const [creating, setCreating] = useState(false);

  const save = async (data: Partial<S300Channel>) => {
    try {
      if (editing) await updateChannel(editing.id, data);
      else await createChannel(data);
      showToast(editing ? t('s300.ch.toast.updated') : t('s300.ch.toast.created'), true);
      setEditing(null); setCreating(false);
      await reload();
    } catch (e) {
      showToast(t('s300.ch.toast.save_failed', { msg: (e as Error).message }), false);
    }
  };

  const remove = async (c: S300Channel) => {
    if (!confirm(t('s300.ch.confirm_delete', { n: c.channel_no }))) return;
    try {
      await deleteChannel(c.id);
      showToast(t('s300.ch.toast.deleted'), true);
      await reload();
    } catch (e) {
      showToast(t('s300.ch.toast.delete_failed', { msg: (e as Error).message }), false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button onClick={() => setCreating(true)}
          className="flex items-center gap-2 px-3 py-1.5 bg-primary text-white text-sm rounded-md hover:bg-primary/90">
          <Plus className="w-4 h-4" /> {t('s300.ch.new')}
        </button>
      </div>

      <div className="bg-surface border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface-dark text-text-secondary text-xs uppercase">
            <tr>
              <th className="text-left px-4 py-2">{t('s300.ch.col.channel_no')}</th>
              <th className="text-left px-4 py-2">{t('s300.ch.col.kind')}</th>
              <th className="text-left px-4 py-2">{t('s300.ch.col.name')}</th>
              <th className="text-left px-4 py-2">{t('s300.ch.col.anpr_sn')}</th>
              <th className="text-left px-4 py-2">{t('s300.ch.col.paired')}</th>
              <th className="text-left px-4 py-2">{t('s300.ch.col.enabled')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {channels.map(c => (
              <tr key={c.id} className="border-t border-border">
                <td className="px-4 py-2 font-mono">{c.channel_no}</td>
                <td className="px-4 py-2">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                    c.kind === 'entry' ? 'bg-blue-500/20 text-blue-300' : 'bg-purple-500/20 text-purple-300'
                  }`}>{c.kind.toUpperCase()}</span>
                </td>
                <td className="px-4 py-2 text-text-secondary">{c.name || '-'}</td>
                <td className="px-4 py-2 text-text-secondary font-mono text-xs">{c.anpr_device_sn || '-'}</td>
                <td className="px-4 py-2 text-text-secondary font-mono text-xs">
                  {c.paired_channel_id ? (channels.find(x => x.id === c.paired_channel_id)?.channel_no || `#${c.paired_channel_id}`) : '-'}
                </td>
                <td className="px-4 py-2">
                  <span className={`text-xs ${c.enabled ? 'text-green-500' : 'text-text-secondary'}`}>
                    {c.enabled ? t('common.yes').toUpperCase() : t('common.no').toUpperCase()}
                  </span>
                </td>
                <td className="px-4 py-2">
                  <div className="flex gap-1 justify-end">
                    <button onClick={() => setEditing(c)} className="p-1 text-text-secondary hover:text-text-primary">
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => remove(c)} className="p-1 text-text-secondary hover:text-red-500">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {channels.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-text-secondary text-sm">{t('s300.ch.empty')}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {(editing || creating) && (
        <ChannelEditModal
          initial={editing || undefined}
          allChannels={channels}
          onSave={save}
          onCancel={() => { setEditing(null); setCreating(false); }}
        />
      )}
    </div>
  );
}

function ChannelEditModal({ initial, allChannels, onSave, onCancel }: {
  initial?: S300Channel;
  allChannels: S300Channel[];
  onSave: (data: Partial<S300Channel>) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [data, setData] = useState({
    channel_no: initial?.channel_no || '',
    name: initial?.name || '',
    kind: (initial?.kind || 'entry') as 'entry' | 'exit',
    paired_channel_id: initial?.paired_channel_id ?? null as number | null,
    s300_base_url: initial?.s300_base_url || 'http://127.0.0.1:8086',
    anpr_device_sn: initial?.anpr_device_sn || '',
    enabled: initial?.enabled ?? 1,
    rb_ip: initial?.rb_ip || '',
    rb_port: initial?.rb_port ?? 8080,
    rb_device_no: initial?.rb_device_no || '',
    rb_board_id: initial?.rb_board_id || '',
    rb_column_num: initial?.rb_column_num ?? 1,
    uvis_timeout_sec: initial?.uvis_timeout_sec ?? 30,
    failure_audio_index: initial?.failure_audio_index ?? 7,
  });
  const pairableChannels = allChannels.filter(c =>
    c.id !== initial?.id && c.kind !== data.kind
  );
  const pairedKindLabel = data.kind === 'entry' ? t('s300.ch.field.paired_exit') : t('s300.ch.field.paired_entry');

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-surface border border-border rounded-lg w-full max-w-lg p-5 my-8">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-text-primary font-semibold">{initial ? t('s300.ch.modal.edit') : t('s300.ch.modal.new')}</h3>
          <button onClick={onCancel}><X className="w-4 h-4 text-text-secondary" /></button>
        </div>

        <div className="space-y-3">
          <Field label={t('s300.ch.field.channel_no')} value={data.channel_no} disabled={!!initial}
            onChange={v => setData({...data, channel_no: v})} placeholder={t('s300.ch.field.channel_no_ph')} />
          <Field label={t('s300.ch.field.friendly_name')} value={data.name}
            onChange={v => setData({...data, name: v})} placeholder={t('s300.ch.field.friendly_name_ph')} />
          <Field label={t('s300.ch.field.s300_url')} value={data.s300_base_url}
            onChange={v => setData({...data, s300_base_url: v})} placeholder={t('s300.ch.field.s300_url_ph')} />
          <Field label={t('s300.ch.field.anpr_sn')} value={data.anpr_device_sn || ''}
            onChange={v => setData({...data, anpr_device_sn: v})} placeholder={t('s300.ch.field.anpr_sn_ph')} />

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-text-secondary mb-1">{t('s300.ch.field.kind')}</label>
              <select value={data.kind}
                onChange={e => setData({...data, kind: e.target.value as 'entry'|'exit', paired_channel_id: null})}
                className="w-full px-3 py-2 bg-surface-dark border border-border rounded-md text-sm text-text-primary">
                <option value="entry">{t('s300.ch.field.kind_entry')}</option>
                <option value="exit">{t('s300.ch.field.kind_exit')}</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-text-secondary mb-1">{t('s300.ch.field.paired', { kind: pairedKindLabel })}</label>
              <select value={data.paired_channel_id ?? ''}
                onChange={e => setData({...data, paired_channel_id: e.target.value ? parseInt(e.target.value) : null})}
                className="w-full px-3 py-2 bg-surface-dark border border-border rounded-md text-sm text-text-primary">
                <option value="">{t('s300.ch.field.paired_none')}</option>
                {pairableChannels.map(c => (
                  <option key={c.id} value={c.id}>{c.channel_no} {c.name ? `(${c.name})` : ''}</option>
                ))}
              </select>
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-text-primary">
            <input type="checkbox" checked={!!data.enabled}
              onChange={e => setData({...data, enabled: e.target.checked ? 1 : 0})} />
            {t('s300.ch.field.enabled')}
          </label>

          {data.kind === 'entry' && <>
          <div className="pt-3 border-t border-border">
            <h4 className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-2">{t('s300.ch.section.rb')}</h4>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('s300.ch.field.rb_ip')} value={data.rb_ip}
                onChange={v => setData({...data, rb_ip: v})} placeholder={t('s300.ch.field.rb_ip_ph')} />
              <Field label={t('s300.ch.field.rb_port')} value={String(data.rb_port)}
                onChange={v => setData({...data, rb_port: parseInt(v) || 8080})} placeholder="8080" />
              <Field label={t('s300.ch.field.rb_device_no')} value={data.rb_device_no}
                onChange={v => setData({...data, rb_device_no: v})} placeholder={t('s300.ch.field.rb_device_no_ph')} />
              <Field label={t('s300.ch.field.rb_board_id')} value={data.rb_board_id}
                onChange={v => setData({...data, rb_board_id: v})} placeholder="01" />
              <Field label={t('s300.ch.field.rb_column_num')} value={String(data.rb_column_num)}
                onChange={v => setData({...data, rb_column_num: parseInt(v) || 1})} placeholder="1" />
            </div>
          </div>

          <div className="pt-3 border-t border-border">
            <h4 className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-2">{t('s300.ch.section.decision')}</h4>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('s300.ch.field.uvis_timeout')} value={String(data.uvis_timeout_sec)}
                onChange={v => setData({...data, uvis_timeout_sec: parseInt(v) || 30})} placeholder="30" />
              <Field label={t('s300.ch.field.audio_index')} value={String(data.failure_audio_index)}
                onChange={v => setData({...data, failure_audio_index: parseInt(v) || 7})} placeholder="7" />
            </div>
            <p className="text-[10px] text-text-secondary mt-1">
              {t('s300.ch.audio_hint')}
            </p>
          </div>
          </>}
        </div>

        <div className="flex gap-2 mt-5 justify-end">
          <button onClick={onCancel}
            className="px-3 py-1.5 text-sm border border-border rounded-md text-text-secondary hover:text-text-primary">
            {t('common.cancel')}
          </button>
          <button onClick={() => onSave({
            channel_no: data.channel_no,
            name: data.name || null,
            kind: data.kind,
            paired_channel_id: data.paired_channel_id,
            s300_base_url: data.s300_base_url,
            anpr_device_sn: data.anpr_device_sn || null,
            enabled: data.enabled,
            rb_ip: data.rb_ip || null,
            rb_port: data.rb_port,
            rb_device_no: data.rb_device_no || null,
            rb_board_id: data.rb_board_id || null,
            rb_column_num: data.rb_column_num,
            uvis_timeout_sec: data.uvis_timeout_sec,
            failure_audio_index: data.failure_audio_index,
          })}
            className="flex items-center gap-1 px-3 py-1.5 bg-primary text-white text-sm rounded-md hover:bg-primary/90">
            <Check className="w-3.5 h-3.5" /> {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder, disabled }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <div>
      <label className="block text-xs text-text-secondary mb-1">{label}</label>
      <input value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder} disabled={disabled}
        className="w-full px-3 py-2 bg-surface-dark border border-border rounded-md text-sm text-text-primary disabled:opacity-50" />
    </div>
  );
}

// ============================ VIP TAB ============================
function VipTab({ showToast }: { showToast: (msg: string, ok: boolean) => void }) {
  const { t } = useI18n();
  const [vips, setVips] = useState<VipPlate[]>([]);
  const [newPlate, setNewPlate] = useState('');
  const [newDesc, setNewDesc] = useState('');

  const reload = useCallback(async () => {
    try { setVips(await listVipPlates()); }
    catch (e) { showToast(t('s300.vip.toast.load_failed', { msg: (e as Error).message }), false); }
  }, [showToast, t]);

  useEffect(() => { reload(); }, [reload]);

  const add = async () => {
    const plate = newPlate.trim().toUpperCase();
    if (!plate) return;
    try {
      await createVipPlate({ license_plate: plate, description: newDesc || undefined });
      setNewPlate(''); setNewDesc('');
      showToast(t('s300.vip.toast.added', { n: plate }), true);
      await reload();
    } catch (e) { showToast(t('s300.vip.toast.add_failed', { msg: (e as Error).message }), false); }
  };

  const toggle = async (v: VipPlate) => {
    try {
      await updateVipPlate(v.id, { enabled: v.enabled ? 0 : 1 });
      await reload();
    } catch (e) { showToast(t('s300.vip.toast.toggle_failed', { msg: (e as Error).message }), false); }
  };

  const remove = async (v: VipPlate) => {
    if (!confirm(t('s300.vip.confirm_delete', { n: v.license_plate }))) return;
    try {
      await deleteVipPlate(v.id);
      showToast(t('s300.vip.toast.removed'), true);
      await reload();
    } catch (e) { showToast(t('s300.vip.toast.delete_failed', { msg: (e as Error).message }), false); }
  };

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="bg-surface border border-border rounded-lg p-4">
        <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2 mb-1">
          <Crown className="w-4 h-4 text-amber-400" /> {t('s300.vip.title')}
        </h3>
        <p className="text-xs text-text-secondary mb-4">
          {t('s300.vip.hint')} <code className="text-text-primary">vip_skipped</code>.
        </p>

        <div className="flex gap-2">
          <input value={newPlate} onChange={e => setNewPlate(e.target.value)}
            placeholder={t('s300.vip.placeholder.plate')}
            className="flex-1 px-3 py-2 bg-surface-dark border border-border rounded-md text-sm font-mono text-text-primary" />
          <input value={newDesc} onChange={e => setNewDesc(e.target.value)}
            placeholder={t('s300.vip.placeholder.desc')}
            className="flex-1 px-3 py-2 bg-surface-dark border border-border rounded-md text-sm text-text-primary" />
          <button onClick={add} disabled={!newPlate.trim()}
            className="flex items-center gap-1 px-3 py-2 bg-primary text-white text-sm rounded-md hover:bg-primary/90 disabled:opacity-50">
            <Plus className="w-4 h-4" /> {t('s300.vip.add')}
          </button>
        </div>
      </div>

      <div className="bg-surface border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface-dark text-text-secondary text-xs uppercase">
            <tr>
              <th className="text-left px-4 py-2">{t('s300.vip.col.plate')}</th>
              <th className="text-left px-4 py-2">{t('s300.vip.col.description')}</th>
              <th className="text-left px-4 py-2">{t('s300.vip.col.status')}</th>
              <th className="text-left px-4 py-2">{t('s300.vip.col.added')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {vips.map(v => (
              <tr key={v.id} className="border-t border-border">
                <td className="px-4 py-2">
                  <span className="inline-flex items-center gap-1.5 font-mono font-medium text-text-primary">
                    <Crown className="w-3 h-3 text-amber-400" /> {v.license_plate}
                  </span>
                </td>
                <td className="px-4 py-2 text-text-secondary">{v.description || '-'}</td>
                <td className="px-4 py-2">
                  <button onClick={() => toggle(v)}
                    className={`text-xs px-2 py-0.5 rounded ${
                      v.enabled ? 'bg-green-500/20 text-green-500' : 'bg-surface-dark text-text-secondary'
                    }`}>
                    {v.enabled ? t('s300.vip.active') : t('s300.vip.disabled')}
                  </button>
                </td>
                <td className="px-4 py-2 text-text-secondary text-xs font-mono">{fmtPgTs(v.created_at)}</td>
                <td className="px-4 py-2 text-right">
                  <button onClick={() => remove(v)} className="p-1 text-text-secondary hover:text-red-500">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </td>
              </tr>
            ))}
            {vips.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-text-secondary text-sm">{t('s300.vip.empty')}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============================ SETTINGS TAB ============================
function SettingsTab({ channels, showToast }: {
  channels: S300Channel[];
  showToast: (msg: string, ok: boolean) => void;
}) {
  const { t } = useI18n();
  const [autoStart, setAutoStart] = useState(false);
  const [autoChannel, setAutoChannel] = useState('RJ001');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getSettings().then(s => {
      setAutoStart(s.auto_start_s300 === '1' || s.auto_start_s300 === 'true');
      setAutoChannel(s.auto_start_channel || 'RJ001');
    }).catch(() => undefined);
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await updateSettings({
        auto_start_s300: autoStart ? '1' : '0',
        auto_start_channel: autoChannel,
      });
      showToast(t('s300.set.toast.saved'), true);
    } catch (e) {
      showToast(t('s300.set.toast.failed', { msg: (e as Error).message }), false);
    } finally { setSaving(false); }
  };

  return (
    <div className="max-w-xl space-y-4">
      <div className="bg-surface border border-border rounded-lg p-5">
        <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2 mb-1">
          <Zap className="w-4 h-4 text-primary" /> {t('s300.set.title')}
        </h3>
        <p className="text-xs text-text-secondary mb-4">
          {t('s300.set.hint')}
          <br /><br />
          {t('s300.set.hint2')}
        </p>

        <label className="flex items-center gap-3 cursor-pointer mb-4">
          <input type="checkbox" checked={autoStart} onChange={e => setAutoStart(e.target.checked)}
            className="w-4 h-4" />
          <span className="text-sm text-text-primary">
            {t('s300.set.toggle')}
          </span>
        </label>

        <div className="mb-4">
          <label className="block text-xs text-text-secondary mb-1">{t('s300.set.fallback')}</label>
          <select value={autoChannel} onChange={e => setAutoChannel(e.target.value)}
            disabled={!autoStart}
            className="w-full px-3 py-2 bg-surface-dark border border-border rounded-md text-sm text-text-primary disabled:opacity-50">
            {channels.map(c => (
              <option key={c.id} value={c.channel_no}>
                {c.channel_no} {c.name ? `— ${c.name}` : ''}
              </option>
            ))}
          </select>
          <p className="text-[10px] text-text-secondary mt-1">
            {t('s300.set.fallback_hint')}
          </p>
        </div>

        <button onClick={save} disabled={saving}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-white text-sm rounded-md hover:bg-primary/90 disabled:opacity-50">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
          {t('s300.set.save')}
        </button>
      </div>
    </div>
  );
}
