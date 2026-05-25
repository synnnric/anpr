import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { MqttProvider } from './contexts/MqttContext';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { I18nProvider } from './contexts/I18nContext';
import LoginPage from './pages/LoginPage';
import Sidebar from './components/Sidebar';
import StatusBar from './components/StatusBar';
import ConnectionPage from './pages/ConnectionPage';
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
import UsersPage from './pages/UsersPage';

function AuthGate() {
  const { status } = useAuth();
  const [activePage, setActivePage] = useState('dashboard');

  if (status === 'unknown') {
    // Brief moment while we validate the stored token against /me.
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center">
        <Loader2 className="w-6 h-6 text-text-secondary animate-spin" />
      </div>
    );
  }
  if (status === 'unauthenticated') {
    return <LoginPage />;
  }

  return (
    <MqttProvider>
      <div className="h-screen flex overflow-hidden">
        <Sidebar activePage={activePage} onNavigate={setActivePage} />
        <div className="flex-1 flex flex-col min-w-0">
          <StatusBar />
          <main className="flex-1 overflow-hidden">
            {activePage === 'dashboard' && <DashboardPage />}
            {activePage === 'connection' && <ConnectionPage />}
            {activePage === 'recognition' && <RecognitionPage />}
            {activePage === 'controls' && <DeviceControlPage />}
            {activePage === 'whitelist' && <WhitelistPage />}
            {activePage === 'events' && <EventsPage />}
            {activePage === 'messages' && <MessageLogPage />}
            {activePage === 'roadblocker' && <RoadBlockerPage />}
            {activePage === 's300' && <S300InspectionPage />}
            {activePage === 'visits' && <VisitsPage />}
            {activePage === 'mqtt-logs' && <MqttLogsPage />}
            {activePage === 'users' && <UsersPage />}
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
