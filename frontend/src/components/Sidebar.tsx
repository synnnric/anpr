import {
  Camera, Settings, Activity, Shield, Radio, MessageSquare,
  Wifi, WifiOff, Loader2, Columns3, ShieldCheck, Car, LayoutDashboard,
  History, type LucideIcon,
} from 'lucide-react';
import { useMqtt } from '../contexts/MqttContext';
import { useI18n } from '../contexts/I18nContext';
import type { TKey } from '../i18n/translations';

interface SidebarProps {
  activePage: string;
  onNavigate: (page: string) => void;
}

interface NavItem {
  id: string;
  labelKey: TKey;
  icon: LucideIcon;
  badge?: 'recognition';
}

interface NavGroup {
  titleKey: TKey;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    titleKey: 'nav.group.overview',
    items: [
      { id: 'dashboard', labelKey: 'nav.dashboard', icon: LayoutDashboard },
    ],
  },
  {
    titleKey: 'nav.group.anpr',
    items: [
      { id: 'recognition', labelKey: 'nav.recognition', icon: Camera, badge: 'recognition' },
      { id: 'controls', labelKey: 'nav.controls', icon: Settings },
      { id: 'whitelist', labelKey: 'nav.whitelist', icon: Shield },
      { id: 'events', labelKey: 'nav.events', icon: Activity },
      { id: 'messages', labelKey: 'nav.messages', icon: MessageSquare },
      { id: 'connection', labelKey: 'nav.connection', icon: Radio },
    ],
  },
  {
    titleKey: 'nav.group.s300',
    items: [
      { id: 's300', labelKey: 'nav.s300', icon: ShieldCheck },
      { id: 'visits', labelKey: 'nav.visits', icon: Car },
    ],
  },
  {
    titleKey: 'nav.group.rb',
    items: [
      { id: 'roadblocker', labelKey: 'nav.roadblocker', icon: Columns3 },
    ],
  },
  {
    titleKey: 'nav.group.diagnostics',
    items: [
      { id: 'mqtt-logs', labelKey: 'nav.mqtt_logs', icon: Radio },
      { id: 'audit-log', labelKey: 'nav.audit_log', icon: History },
    ],
  },
];

export default function Sidebar({ activePage, onNavigate }: SidebarProps) {
  const { status, deviceSn } = useMqtt();
  const { t } = useI18n();
  const navGroups = NAV_GROUPS;

  const statusLabel =
    status === 'connected' ? t('common.connected') :
    status === 'connecting' ? t('common.connecting') :
    t('common.disconnected');

  return (
    <aside className="w-64 bg-surface border-r border-border flex flex-col shrink-0">
      <div className="p-5 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-primary flex items-center justify-center">
            <Camera className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-sm font-bold text-text-primary">{t('shell.brand.title')}</h1>
            <p className="text-xs text-text-secondary">{t('shell.brand.subtitle')}</p>
          </div>
        </div>
      </div>

      <div className="p-3 mx-3 mt-3 rounded-lg bg-surface-dark border border-border">
        <div className="flex items-center gap-2 mb-1">
          {status === 'connected' ? (
            <Wifi className="w-3.5 h-3.5 text-success" />
          ) : status === 'connecting' ? (
            <Loader2 className="w-3.5 h-3.5 text-warning animate-spin" />
          ) : (
            <WifiOff className="w-3.5 h-3.5 text-danger" />
          )}
          <span className="text-xs font-medium text-text-primary">{t('shell.mqtt.label')}: {statusLabel}</span>
        </div>
        {deviceSn && (
          <p className="text-[10px] text-text-secondary font-mono truncate" title={deviceSn}>
            {t('shell.mqtt.sn')}: {deviceSn}
          </p>
        )}
      </div>

      <nav className="flex-1 px-3 pt-2 pb-3 overflow-y-auto">
        {navGroups.map((group, gi) => (
          <div key={group.titleKey} className={gi > 0 ? 'mt-2' : ''}>
            <p className="px-3 pt-3 pb-1.5 text-[10px] font-semibold uppercase tracking-widest text-text-secondary/60">
              {t(group.titleKey)}
            </p>
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;
                const isActive = activePage === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => onNavigate(item.id)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all ${
                      isActive
                        ? 'bg-primary text-white font-medium'
                        : 'text-text-secondary hover:bg-surface-light hover:text-text-primary'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    {t(item.labelKey)}
                    {item.badge === 'recognition' && <RecognitionBadge />}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="p-3 border-t border-border">
        <p className="text-[10px] text-text-secondary text-center">
          {t('shell.footer')}
        </p>
      </div>
    </aside>
  );
}

function RecognitionBadge() {
  const { recognitions } = useMqtt();
  if (recognitions.length === 0) return null;
  return (
    <span className="ml-auto bg-accent text-black text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[20px] text-center">
      {recognitions.length > 99 ? '99+' : recognitions.length}
    </span>
  );
}
