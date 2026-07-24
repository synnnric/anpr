import { Clock, Cpu, LogOut, User as UserIcon, Crown, ShieldCheck, Eye } from 'lucide-react';
import { useMqtt } from '../contexts/MqttContext';
import { useAuth } from '../contexts/AuthContext';
import { useI18n } from '../contexts/I18nContext';
import { useEffect, useState, useRef } from 'react';
import { timeAgo } from '../utils/helpers';

const ROLE_ICON = {
  admin:    { Icon: Crown,       cls: 'text-red-300' },
  operator: { Icon: ShieldCheck, cls: 'text-blue-300' },
  viewer:   { Icon: Eye,         cls: 'text-text-secondary' },
};

export default function StatusBar() {
  const { heartbeats, recognitions, messageLog, status } = useMqtt();
  const { user, logout } = useAuth();
  const { lang, setLang, t } = useI18n();
  const [now, setNow] = useState(new Date());
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Close the profile menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  const latestHeartbeat = heartbeats.size > 0
    ? Array.from(heartbeats.values()).sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime())[0]
    : null;
  const role = user?.role && ROLE_ICON[user.role] ? ROLE_ICON[user.role] : ROLE_ICON.viewer;
  const roleLabel = user?.role ? t(`role.${user.role}` as 'role.admin') : '';

  return (
    <div className="h-10 bg-surface border-b border-border flex items-center px-4 gap-6 text-[11px] text-text-secondary shrink-0">
      <div className="flex items-center gap-1.5">
        <Clock className="w-3 h-3" />
        {now.toLocaleTimeString()}
      </div>
      <div className="flex items-center gap-1.5">
        <Cpu className="w-3 h-3" />
        {t('statusbar.devices')}: {heartbeats.size}
      </div>
      <div>{t('statusbar.recognitions')}: {recognitions.length}</div>
      <div>{t('statusbar.messages')}: {messageLog.length}</div>
      {latestHeartbeat && (
        <div className="text-text-secondary/80">
          {t('statusbar.last_heartbeat')}: {timeAgo(latestHeartbeat.lastSeen)}
        </div>
      )}
      {status !== 'connected' && (
        <div className="text-danger font-medium">{t('statusbar.not_connected')}</div>
      )}

      {/* Language toggle + profile — top right */}
      <div className="ml-auto flex items-center gap-2">
        <LangToggle lang={lang} setLang={setLang} />

        {user && (
          <div className="relative" ref={menuRef}>
            <button onClick={() => setMenuOpen(v => !v)}
              className="flex items-center gap-2 pl-2 pr-2.5 py-1 rounded-md hover:bg-surface-dark border border-border">
              <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center">
                <UserIcon className="w-3 h-3 text-primary" />
              </div>
              <div className="text-left leading-tight">
                <div className="text-[11px] font-medium text-text-primary">
                  {user.display_name || user.username}
                </div>
                <div className={`text-[10px] flex items-center gap-0.5 ${role.cls}`}>
                  <role.Icon className="w-2.5 h-2.5" />
                  <span>{roleLabel}</span>
                </div>
              </div>
            </button>

            {menuOpen && (
              <div className="absolute right-0 top-full mt-1 w-56 bg-surface border border-border rounded-lg shadow-xl z-50 overflow-hidden">
                <div className="px-3 py-2.5 border-b border-border">
                  <div className="text-xs text-text-secondary">{t('common.signed_in_as')}</div>
                  <div className="text-sm font-medium text-text-primary truncate">{user.username}</div>
                  {user.display_name && (
                    <div className="text-[11px] text-text-secondary truncate">{user.display_name}</div>
                  )}
                </div>
                <button onClick={() => { setMenuOpen(false); logout(); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-secondary hover:text-danger hover:bg-surface-dark text-left">
                  <LogOut className="w-3.5 h-3.5" /> {t('common.sign_out')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function LangToggle({ lang, setLang }: { lang: 'id' | 'en'; setLang: (l: 'id' | 'en') => void }) {
  const btn = (l: 'id' | 'en') =>
    `px-2 py-0.5 text-[10px] font-bold rounded transition-colors ${
      lang === l
        ? 'bg-primary text-white'
        : 'text-text-secondary hover:text-text-primary'
    }`;
  return (
    <div className="flex items-center gap-0.5 border border-border rounded-md p-0.5 bg-surface-dark"
      title="Bahasa / Language">
      <button onClick={() => setLang('id')} className={btn('id')}>ID</button>
      <button onClick={() => setLang('en')} className={btn('en')}>EN</button>
    </div>
  );
}
