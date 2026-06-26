import { useState } from 'react';
import {
  Crosshair, ToggleLeft, Camera, RotateCcw, Clock, Volume2, DoorOpen,
  ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Square, Send
} from 'lucide-react';
import { useMqtt } from '../contexts/MqttContext';
import { generateMessageId } from '../utils/helpers';
import { useI18n } from '../contexts/I18nContext';

export default function DeviceControlPage() {
  const { t } = useI18n();
  const { publishMessage, deviceSn, status } = useMqtt();
  const isDisabled = status !== 'connected' || !deviceSn;

  return (
    <div className="p-6 overflow-y-auto">
      <h2 className="text-xl font-bold text-text-primary mb-1">{t('controls.title')}</h2>
      <p className="text-sm text-text-secondary mb-6">
        {t('controls.subtitle')}
        {isDisabled && <span className="text-danger ml-2">{t('controls.no_device')}</span>}
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TriggerCard publishMessage={publishMessage} deviceSn={deviceSn} disabled={isDisabled} />
        <IoOutputCard publishMessage={publishMessage} deviceSn={deviceSn} disabled={isDisabled} />
        <SnapshotCard publishMessage={publishMessage} deviceSn={deviceSn} disabled={isDisabled} />
        <GateOpenCard publishMessage={publishMessage} deviceSn={deviceSn} disabled={isDisabled} />
        <SetTimeCard publishMessage={publishMessage} deviceSn={deviceSn} disabled={isDisabled} />
        <TtsCard publishMessage={publishMessage} deviceSn={deviceSn} disabled={isDisabled} />
        <CloudControlCard publishMessage={publishMessage} deviceSn={deviceSn} disabled={isDisabled} />
        <RebootCard publishMessage={publishMessage} deviceSn={deviceSn} disabled={isDisabled} />
      </div>
    </div>
  );
}

interface CardProps {
  publishMessage: (name: string, payload: unknown) => void;
  deviceSn: string;
  disabled: boolean;
}

function TriggerCard({ publishMessage, deviceSn, disabled }: CardProps) {
  const { t } = useI18n();
  const handleTrigger = () => {
    publishMessage('ivs_trigger', {
      id: generateMessageId(),
      sn: deviceSn,
      name: 'ivs_trigger',
      version: '1.0',
      timestamp: Math.floor(Date.now() / 1000),
      payload: { type: 'ivs_trigger', body: {} },
    });
  };

  return (
    <ControlCard title={t('controls.trigger.title')} icon={Crosshair} description={t('controls.trigger.desc')}>
      <button onClick={handleTrigger} disabled={disabled}
        className="w-full bg-primary hover:bg-primary-light text-white font-medium py-3 rounded-lg text-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
        <Crosshair className="w-4 h-4" /> {t('controls.trigger.btn')}
      </button>
    </ControlCard>
  );
}

function IoOutputCard({ publishMessage, deviceSn, disabled }: CardProps) {
  const { t } = useI18n();
  const [io, setIo] = useState(0);
  const [value, setValue] = useState(2);
  const [delay, setDelay] = useState(500);

  const handleSend = () => {
    publishMessage('gpio_out', {
      id: generateMessageId(),
      sn: deviceSn,
      name: 'gpio_out',
      version: '1.0',
      timestamp: Math.floor(Date.now() / 1000),
      payload: { type: 'gpio_out', body: { io, value, delay } },
    });
  };

  return (
    <ControlCard title={t('controls.io.title')} icon={ToggleLeft} description={t('controls.io.desc')}>
      <div className="grid grid-cols-3 gap-3 mb-3">
        <div>
          <label className="text-[10px] text-text-secondary">{t('controls.io.port')}</label>
          <select value={io} onChange={(e) => setIo(Number(e.target.value))} className="input-sm w-full">
            {[0, 1, 2, 3].map((i) => <option key={i} value={i}>IO {i}</option>)}
          </select>
        </div>
        <div>
          <label className="text-[10px] text-text-secondary">{t('controls.io.state')}</label>
          <select value={value} onChange={(e) => setValue(Number(e.target.value))} className="input-sm w-full">
            <option value={0}>{t('controls.io.off')}</option>
            <option value={1}>{t('controls.io.on')}</option>
            <option value={2}>{t('controls.io.pulse')}</option>
          </select>
        </div>
        <div>
          <label className="text-[10px] text-text-secondary">{t('controls.io.delay')}</label>
          <input type="number" value={delay} onChange={(e) => setDelay(Number(e.target.value))} min={500} max={5000} className="input-sm w-full" />
        </div>
      </div>
      <button onClick={handleSend} disabled={disabled}
        className="w-full bg-primary hover:bg-primary-light text-white font-medium py-2.5 rounded-lg text-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
        <Send className="w-4 h-4" /> {t('controls.io.btn')}
      </button>
    </ControlCard>
  );
}

function SnapshotCard({ publishMessage, deviceSn, disabled }: CardProps) {
  const { t } = useI18n();
  const handleSnapshot = () => {
    publishMessage('snapshot', {
      id: generateMessageId(),
      sn: deviceSn,
      name: 'snapshot',
      version: '1.0',
      timestamp: Math.floor(Date.now() / 1000),
      payload: { type: 'snapshot', body: {} },
    });
  };

  return (
    <ControlCard title={t('controls.snapshot.title')} icon={Camera} description={t('controls.snapshot.desc')}>
      <button onClick={handleSnapshot} disabled={disabled}
        className="w-full bg-primary hover:bg-primary-light text-white font-medium py-3 rounded-lg text-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
        <Camera className="w-4 h-4" /> {t('controls.snapshot.btn')}
      </button>
    </ControlCard>
  );
}

function GateOpenCard({ publishMessage, deviceSn, disabled }: CardProps) {
  const { t } = useI18n();
  const handleGateOpen = () => {
    // The camera opens its barrier via gpio_out (relay pulse), the same command
    // the vendor CP and our backend use — there is no `gate_direct_open` command.
    // io=0 relay, value=2 pulse (ON then OFF), delay=1000ms. Matches DecisionExecutor::openEntryGate.
    publishMessage('gpio_out', {
      id: generateMessageId(),
      sn: deviceSn,
      name: 'gpio_out',
      version: '1.0',
      timestamp: Math.floor(Date.now() / 1000),
      payload: { type: 'gpio_out', body: { delay: 1000, io: 0, value: 2 } },
    });
  };

  return (
    <ControlCard title={t('controls.gate.title')} icon={DoorOpen} description={t('controls.gate.desc')}>
      <button onClick={handleGateOpen} disabled={disabled}
        className="w-full bg-success hover:bg-success/80 text-white font-medium py-3 rounded-lg text-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
        <DoorOpen className="w-4 h-4" /> {t('controls.gate.btn')}
      </button>
    </ControlCard>
  );
}

function SetTimeCard({ publishMessage, deviceSn, disabled }: CardProps) {
  const { t } = useI18n();
  const handleSetTime = () => {
    const now = new Date();
    publishMessage('set_time', {
      id: generateMessageId(),
      sn: deviceSn,
      name: 'set_time',
      version: '1.0',
      timestamp: Math.floor(Date.now() / 1000),
      payload: {
        type: 'set_time',
        body: {
          year: String(now.getFullYear()),
          month: String(now.getMonth() + 1).padStart(2, '0'),
          day: String(now.getDate()).padStart(2, '0'),
          hour: String(now.getHours()).padStart(2, '0'),
          min: String(now.getMinutes()).padStart(2, '0'),
          sec: String(now.getSeconds()).padStart(2, '0'),
        },
      },
    });
  };

  return (
    <ControlCard title={t('controls.time.title')} icon={Clock} description={t('controls.time.desc')}>
      <button onClick={handleSetTime} disabled={disabled}
        className="w-full bg-primary hover:bg-primary-light text-white font-medium py-3 rounded-lg text-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
        <Clock className="w-4 h-4" /> {t('controls.time.btn')}
      </button>
    </ControlCard>
  );
}

function TtsCard({ publishMessage, deviceSn, disabled }: CardProps) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [gender, setGender] = useState(0);
  const [volume, setVolume] = useState(100);

  const handleSpeak = () => {
    if (!text) return;
    const encoded = btoa(unescape(encodeURIComponent(text)));
    publishMessage('tts_voice', {
      id: generateMessageId(),
      sn: deviceSn,
      name: 'tts_voice',
      version: '1.0',
      timestamp: Math.floor(Date.now() / 1000),
      payload: {
        type: 'play_voice',
        body: { voice_male: gender, voice_volume: volume, voice_data: encoded },
      },
    });
  };

  return (
    <ControlCard title={t('controls.tts.title')} icon={Volume2} description={t('controls.tts.desc')}>
      <div className="space-y-3 mb-3">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('controls.tts.placeholder')}
          className="input-sm w-full"
        />
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] text-text-secondary">{t('controls.tts.voice')}</label>
            <select value={gender} onChange={(e) => setGender(Number(e.target.value))} className="input-sm w-full">
              <option value={0}>{t('controls.tts.male')}</option>
              <option value={1}>{t('controls.tts.female')}</option>
            </select>
          </div>
          <div>
            <label className="text-[10px] text-text-secondary">{t('controls.tts.volume', { n: volume })}</label>
            <input type="range" min={1} max={100} value={volume} onChange={(e) => setVolume(Number(e.target.value))} className="w-full mt-1" />
          </div>
        </div>
      </div>
      <button onClick={handleSpeak} disabled={disabled || !text}
        className="w-full bg-primary hover:bg-primary-light text-white font-medium py-2.5 rounded-lg text-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2">
        <Volume2 className="w-4 h-4" /> {t('controls.tts.btn')}
      </button>
    </ControlCard>
  );
}

function CloudControlCard({ publishMessage, deviceSn, disabled }: CardProps) {
  const { t } = useI18n();
  const handleMove = (type: number) => {
    publishMessage('set_cloud_ctrl', {
      id: generateMessageId(),
      sn: deviceSn,
      name: 'set_cloud_ctrl',
      version: '1.0',
      timestamp: Math.floor(Date.now() / 1000),
      payload: { type: 'set_cloud_ctrl', body: { type, value: -1 } },
    });
  };

  return (
    <ControlCard title={t('controls.ptz.title')} icon={Crosshair} description={t('controls.ptz.desc')}>
      <div className="grid grid-cols-3 gap-2">
        <div />
        <button onClick={() => handleMove(2)} disabled={disabled} className="btn-ptz"><ChevronUp className="w-5 h-5" /></button>
        <div />
        <button onClick={() => handleMove(16)} disabled={disabled} className="btn-ptz"><ChevronLeft className="w-5 h-5" /></button>
        <button onClick={() => handleMove(8)} disabled={disabled} className="btn-ptz text-danger"><Square className="w-4 h-4" /></button>
        <button onClick={() => handleMove(32)} disabled={disabled} className="btn-ptz"><ChevronRight className="w-5 h-5" /></button>
        <div />
        <button onClick={() => handleMove(4)} disabled={disabled} className="btn-ptz"><ChevronDown className="w-5 h-5" /></button>
        <div />
      </div>
    </ControlCard>
  );
}

function RebootCard({ publishMessage, deviceSn, disabled }: CardProps) {
  const { t } = useI18n();
  const [confirmed, setConfirmed] = useState(false);

  const handleReboot = () => {
    if (!confirmed) {
      setConfirmed(true);
      setTimeout(() => setConfirmed(false), 5000);
      return;
    }
    publishMessage('reboot_dev', {
      id: generateMessageId(),
      sn: deviceSn,
      name: 'reboot_dev',
      version: '1.0',
      timestamp: Math.floor(Date.now() / 1000),
      payload: { type: 'reboot_dev', body: {} },
    });
    setConfirmed(false);
  };

  return (
    <ControlCard title={t('controls.reboot.title')} icon={RotateCcw} description={t('controls.reboot.desc')}>
      <button onClick={handleReboot} disabled={disabled}
        className={`w-full font-medium py-3 rounded-lg text-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2 ${
          confirmed ? 'bg-danger hover:bg-danger/80 text-white' : 'bg-surface-light hover:bg-surface text-text-primary border border-border'
        }`}>
        <RotateCcw className="w-4 h-4" />
        {confirmed ? t('controls.reboot.confirm') : t('controls.reboot.btn')}
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
