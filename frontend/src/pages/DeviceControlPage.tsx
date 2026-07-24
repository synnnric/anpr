import { useEffect, useState } from 'react';
import { Volume2, DoorOpen, Loader2 } from 'lucide-react';
import { listChannels } from '../services/s300Service';
import type { S300Channel } from '../types/s300';
import { API_BASE, authHeaders } from '../services/adminService';
import { useI18n } from '../contexts/I18nContext';

/**
 * ANPR Control — manual camera actions, addressed by CHANNEL (the camera SN
 * comes from the channel config on the Settings page, not from the browser's
 * MQTT session). Commands go through the backend outbound queue → worker, the
 * same proven path the automatic flow uses. Voice is sent as serial_data
 * control-card frames — the real camera has no working native TTS command.
 */
export default function DeviceControlPage() {
  const { t } = useI18n();
  const [channels, setChannels] = useState<S300Channel[]>([]);
  const [channelNo, setChannelNo] = useState('');
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  useEffect(() => {
    listChannels().then(list => {
      const cams = list.filter(c => c.enabled === 1 && c.anpr_device_sn);
      setChannels(cams);
      if (cams.length) setChannelNo(cams[0].channel_no);
    }).catch(() => undefined);
  }, []);

  const showToast = (msg: string, ok: boolean) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3000);
  };

  const call = async (path: string, body: Record<string, unknown>): Promise<void> => {
    const res = await fetch(API_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok || data.code !== 200) throw new Error(data.message || `HTTP ${res.status}`);
  };

  const selected = channels.find(c => c.channel_no === channelNo);

  return (
    <div className="p-6 overflow-y-auto">
      <h2 className="text-xl font-bold text-text-primary mb-1">{t('controls.title')}</h2>
      <p className="text-sm text-text-secondary mb-4">
        {t('controls.subtitle')}
        {channels.length === 0 && <span className="text-danger ml-2">{t('controls.no_device')}</span>}
      </p>

      {toast && (
        <div className={`mb-4 max-w-2xl px-3 py-2 rounded-lg text-xs ${
          toast.ok ? 'bg-success/10 border border-success/30 text-success'
                   : 'bg-danger/10 border border-danger/30 text-danger'
        }`}>{toast.msg}</div>
      )}

      {/* Channel picker — the target camera is the channel's configured SN */}
      <div className="max-w-2xl mb-4">
        <label className="block text-xs text-text-secondary mb-1">{t('controls.channel')}</label>
        <select value={channelNo} onChange={e => setChannelNo(e.target.value)}
          className="w-full px-3 py-2 bg-surface-dark border border-border rounded-md text-sm text-text-primary">
          {channels.map(c => (
            <option key={c.id} value={c.channel_no}>
              {c.channel_no} {c.name ? `— ${c.name}` : ''} ({c.anpr_device_sn})
            </option>
          ))}
        </select>
        {selected && (
          <p className="text-[10px] text-text-secondary mt-1 font-mono">SN: {selected.anpr_device_sn}</p>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 max-w-4xl">
        <GateOpenCard channelNo={channelNo} call={call} showToast={showToast} />
        <TtsCard channelNo={channelNo} call={call} showToast={showToast} />
      </div>
    </div>
  );
}

interface ActionProps {
  channelNo: string;
  call: (path: string, body: Record<string, unknown>) => Promise<void>;
  showToast: (msg: string, ok: boolean) => void;
}

function GateOpenCard({ channelNo, call, showToast }: ActionProps) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [plate, setPlate] = useState('');
  const handleGateOpen = async () => {
    setBusy(true);
    try {
      const p = plate.trim().toUpperCase();
      if (p) {
        // With a plate the vehicle goes through the NORMAL flow — same as a
        // camera recognition: VIP/blacklist/clearance checks, inspection,
        // gate + greeting all happen exactly like an automatic entry.
        await call(`/api/s300/come/${encodeURIComponent(channelNo)}`, { licensePlateNo: p });
        showToast(t('controls.gate.admitted', { p }), true);
      } else {
        await call('/api/anpr/gate-open', { channel_no: channelNo });
        showToast(t('controls.toast.sent'), true);
      }
      setPlate('');
    } catch (e) {
      showToast(t('controls.toast.failed', { msg: (e as Error).message }), false);
    } finally { setBusy(false); }
  };

  return (
    <ControlCard title={t('controls.gate.title')} icon={DoorOpen} description={t('controls.gate.desc')}>
      <input value={plate} onChange={e => setPlate(e.target.value.toUpperCase())}
        placeholder={t('controls.gate.plate_ph')}
        className="w-full mb-2 px-3 py-2 bg-surface-dark border border-border rounded-lg text-sm font-mono text-text-primary placeholder:text-text-secondary/60" />
      <button onClick={handleGateOpen} disabled={busy || !channelNo}
        className="w-full bg-success hover:bg-success/80 text-white font-medium py-3 rounded-lg text-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <DoorOpen className="w-4 h-4" />}
        {t('controls.gate.btn')}
      </button>
      <p className="mt-1.5 text-[10px] text-text-secondary">{t('controls.gate.plate_hint')}</p>
    </ControlCard>
  );
}

function TtsCard({ channelNo, call, showToast }: ActionProps) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSpeak = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await call('/api/anpr/speak', { channel_no: channelNo, text: text.trim() });
      showToast(t('controls.toast.sent'), true);
    } catch (e) {
      showToast(t('controls.toast.failed', { msg: (e as Error).message }), false);
    } finally { setBusy(false); }
  };

  return (
    <ControlCard title={t('controls.tts.title')} icon={Volume2} description={t('controls.tts.desc')}>
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') handleSpeak(); }}
        placeholder={t('controls.tts.placeholder')}
        className="input-sm w-full mb-3"
      />
      <button onClick={handleSpeak} disabled={busy || !text.trim() || !channelNo}
        className="w-full bg-primary hover:bg-primary-light text-white font-medium py-2.5 rounded-lg text-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Volume2 className="w-4 h-4" />}
        {t('controls.tts.btn')}
      </button>
    </ControlCard>
  );
}

function ControlCard({ title, icon: Icon, description, children }: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-surface border border-border rounded-xl p-5">
      <div className="flex items-center gap-2 mb-1">
        <Icon className="w-4 h-4 text-primary-light" />
        <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
      </div>
      <p className="text-xs text-text-secondary mb-4">{description}</p>
      {children}
    </div>
  );
}
