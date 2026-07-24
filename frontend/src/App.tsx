import { useEffect, useState } from 'react';
import { Loader2, ShieldAlert } from 'lucide-react';
import { MqttProvider } from './contexts/MqttContext';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { I18nProvider, useI18n } from './contexts/I18nContext';
import Sidebar from './components/Sidebar';
import StatusBar from './components/StatusBar';
import OrphanExitAlert from './components/OrphanExitAlert';
import RecognitionPage from './pages/RecognitionPage';
import DeviceControlPage from './pages/DeviceControlPage';
import WhitelistPage from './pages/WhitelistPage';
import EventsPage from './pages/EventsPage';
import MessageLogPage from './pages/MessageLogPage';
import RoadBlockerPage from './pages/RoadBlockerPage';
import S300InspectionPage from './pages/S300InspectionPage';
import VisitsPage from './pages/VisitsPage';
import MqttLogsPage from './pages/MqttLogsPage';
import DashboardPage from './pages/DashboardPage';
import AuditLogPage from './pages/AuditLogPage';
import ApiLogPage from './pages/ApiLogPage';
import SettingsPage from './pages/SettingsPage';
import VipPage from './pages/VipPage';
import BlacklistPage from './pages/BlacklistPage';

function BlockedAccess() {
  const { error } = useAuth();
  const { t } = useI18n();
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center p-6">
      <div className="max-w-md w-full bg-surface border border-border rounded-xl p-8 text-center">
        <div className="w-12 h-12 rounded-full bg-danger/10 border border-danger/30 flex items-center justify-center mx-auto mb-4">
          <ShieldAlert className="w-6 h-6 text-danger" />
        </div>
        <h1 className="text-base font-semibold text-text-primary mb-2">{t('sso.blocked.title')}</h1>
        <p className="text-sm text-text-secondary">{t('sso.blocked.hint')}</p>
        {error && (
          <p className="mt-4 text-[11px] text-danger font-mono break-all">{error}</p>
        )}
      </div>
    </div>
  );
}

// The active page lives in the URL hash (#s300, #settings, …) so a refresh —
// or a bookmarked/shared link — lands on the same page instead of resetting
// to the dashboard. Unknown/empty hash falls back to the dashboard.
const PAGE_IDS = [
  'dashboard', 'recognition', 'controls', 'whitelist', 'events', 'messages',
  'roadblocker', 's300', 'vip', 'plate-blacklist', 'visits', 'mqtt-logs',
  'audit-log', 'api-log', 'settings',
];
const pageFromHash = () => {
  const h = window.location.hash.replace(/^#\/?/, '');
  return PAGE_IDS.includes(h) ? h : 'dashboard';
};

function AuthGate() {
  const { status } = useAuth();
  const [activePage, setActivePage] = useState(pageFromHash);

  // Keep state in sync with the hash (browser back/forward, manual edits).
  useEffect(() => {
    const onHash = () => setActivePage(pageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const navigate = (page: string) => {
    window.location.hash = page;
    setActivePage(page);
  };

  if (status === 'unknown') {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center">
        <Loader2 className="w-6 h-6 text-text-secondary animate-spin" />
      </div>
    );
  }
  if (status === 'blocked' || status === 'unauthenticated') {
    return <BlockedAccess />;
  }

  return (
    <MqttProvider>
      {/* Global: orphan-exit confirmation popup — visible on every page */}
      <OrphanExitAlert />
      <div className="h-screen flex overflow-hidden">
        <Sidebar activePage={activePage} onNavigate={navigate} />
        <div className="flex-1 flex flex-col min-w-0">
          <StatusBar />
          <main className="flex-1 overflow-hidden">
            {activePage === 'dashboard' && <DashboardPage />}
            {activePage === 'recognition' && <RecognitionPage />}
            {activePage === 'controls' && <DeviceControlPage />}
            {activePage === 'whitelist' && <WhitelistPage />}
            {activePage === 'events' && <EventsPage />}
            {activePage === 'messages' && <MessageLogPage />}
            {activePage === 'roadblocker' && <RoadBlockerPage />}
            {activePage === 's300' && <S300InspectionPage />}
            {activePage === 'vip' && <VipPage />}
            {activePage === 'plate-blacklist' && <BlacklistPage />}
            {activePage === 'visits' && <VisitsPage />}
            {activePage === 'mqtt-logs' && <MqttLogsPage />}
            {activePage === 'audit-log' && <AuditLogPage />}
            {activePage === 'api-log' && <ApiLogPage />}
            {activePage === 'settings' && <SettingsPage />}
          </main>
        </div>
      </div>
    </MqttProvider>
  );
}

function App() {
  return (
    <I18nProvider>
      <AuthProvider>
        <AuthGate />
      </AuthProvider>
    </I18nProvider>
  );
}

export default App;
