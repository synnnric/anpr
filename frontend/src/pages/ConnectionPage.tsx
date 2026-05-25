import { useState } from 'react';
import { Wifi, WifiOff, Loader2, Server, Key, User, Hash, Globe, Lock } from 'lucide-react';
import { useMqtt } from '../contexts/MqttContext';
import { useI18n } from '../contexts/I18nContext';

export default function ConnectionPage() {
  const { t } = useI18n();
  const { config, setConfig, status, connect, disconnect, deviceSn, setDeviceSn } = useMqtt();
  const [error, setError] = useState('');

  const handleConnect = async () => {
    setError('');
    try {
      await connect();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('connection.error.failed'));
    }
  };

  const statusText =
    status === 'connected' ? t('common.connected') :
    status === 'connecting' ? t('common.connecting') :
    t('common.disconnected');

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h2 className="text-xl font-bold text-text-primary mb-1">{t('connection.title')}</h2>
      <p className="text-sm text-text-secondary mb-6">{t('connection.subtitle')}</p>

      <div className="bg-surface rounded-xl border border-border p-6 space-y-5">
        <div className="flex items-center gap-3 pb-4 border-b border-border">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center ${
            status === 'connected' ? 'bg-success/20' : status === 'connecting' ? 'bg-warning/20' : 'bg-danger/20'
          }`}>
            {status === 'connected' ? (
              <Wifi className="w-5 h-5 text-success" />
            ) : status === 'connecting' ? (
              <Loader2 className="w-5 h-5 text-warning animate-spin" />
            ) : (
              <WifiOff className="w-5 h-5 text-danger" />
            )}
          </div>
          <div>
            <p className="text-sm font-semibold text-text-primary">{t('connection.status_label', { s: statusText })}</p>
            <p className="text-xs text-text-secondary">
              {status === 'connected' ? t('connection.status.connected') : t('connection.status.not_connected')}
            </p>
          </div>
        </div>

        {error && (
          <div className="bg-danger/10 border border-danger/30 rounded-lg p-3 text-sm text-danger">
            {error}
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className="text-xs font-medium text-text-secondary mb-1.5 flex items-center gap-1.5">
              <Server className="w-3.5 h-3.5" /> {t('connection.broker_address')}
            </label>
            <input
              type="text"
              value={config.brokerUrl}
              onChange={(e) => setConfig({ ...config, brokerUrl: e.target.value })}
              placeholder="192.168.1.100"
              disabled={status === 'connected'}
              className="w-full bg-surface-dark border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-secondary/50 focus:outline-none focus:border-primary-light disabled:opacity-50"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-text-secondary mb-1.5 flex items-center gap-1.5">
              <Globe className="w-3.5 h-3.5" /> {t('connection.port_ws')}
            </label>
            <input
              type="number"
              value={config.port}
              onChange={(e) => setConfig({ ...config, port: parseInt(e.target.value) || 8083 })}
              disabled={status === 'connected'}
              className="w-full bg-surface-dark border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-primary-light disabled:opacity-50"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-text-secondary mb-1.5 flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5" /> {t('connection.use_ssl')}
            </label>
            <select
              value={config.useSSL ? 'yes' : 'no'}
              onChange={(e) => setConfig({ ...config, useSSL: e.target.value === 'yes' })}
              disabled={status === 'connected'}
              className="w-full bg-surface-dark border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-primary-light disabled:opacity-50"
            >
              <option value="no">{t('connection.ssl_no')}</option>
              <option value="yes">{t('connection.ssl_yes')}</option>
            </select>
          </div>

          <div>
            <label className="text-xs font-medium text-text-secondary mb-1.5 flex items-center gap-1.5">
              <User className="w-3.5 h-3.5" /> {t('connection.username')}
            </label>
            <input
              type="text"
              value={config.username}
              onChange={(e) => setConfig({ ...config, username: e.target.value })}
              placeholder="admin"
              disabled={status === 'connected'}
              className="w-full bg-surface-dark border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-secondary/50 focus:outline-none focus:border-primary-light disabled:opacity-50"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-text-secondary mb-1.5 flex items-center gap-1.5">
              <Key className="w-3.5 h-3.5" /> {t('connection.password')}
            </label>
            <input
              type="password"
              value={config.password}
              onChange={(e) => setConfig({ ...config, password: e.target.value })}
              placeholder="••••••"
              disabled={status === 'connected'}
              className="w-full bg-surface-dark border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-secondary/50 focus:outline-none focus:border-primary-light disabled:opacity-50"
            />
          </div>

          <div className="col-span-2">
            <label className="text-xs font-medium text-text-secondary mb-1.5 flex items-center gap-1.5">
              <Hash className="w-3.5 h-3.5" /> {t('connection.client_id')}
            </label>
            <input
              type="text"
              value={config.clientId}
              onChange={(e) => setConfig({ ...config, clientId: e.target.value })}
              disabled={status === 'connected'}
              className="w-full bg-surface-dark border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-primary-light disabled:opacity-50"
            />
          </div>
        </div>

        <div className="pt-2 border-t border-border">
          <label className="text-xs font-medium text-text-secondary mb-1.5 flex items-center gap-1.5">
            <Hash className="w-3.5 h-3.5" /> {t('connection.device_sn')}
          </label>
          <input
            type="text"
            value={deviceSn}
            onChange={(e) => setDeviceSn(e.target.value)}
            placeholder="e.g. 265e1040-85e01fb7"
            className="w-full bg-surface-dark border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder-text-secondary/50 focus:outline-none focus:border-primary-light"
          />
          <p className="text-[10px] text-text-secondary mt-1">
            {t('connection.device_sn_hint', { sn: '{sn}' })}
          </p>
        </div>

        <div className="flex gap-3 pt-2">
          {status === 'connected' ? (
            <button
              onClick={disconnect}
              className="flex-1 bg-danger hover:bg-danger/80 text-white font-medium py-2.5 rounded-lg text-sm transition-colors flex items-center justify-center gap-2"
            >
              <WifiOff className="w-4 h-4" />
              {t('connection.disconnect')}
            </button>
          ) : (
            <button
              onClick={handleConnect}
              disabled={status === 'connecting' || !config.brokerUrl}
              className="flex-1 bg-primary hover:bg-primary-light text-white font-medium py-2.5 rounded-lg text-sm transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {status === 'connecting' ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Wifi className="w-4 h-4" />
              )}
              {status === 'connecting' ? t('connection.connecting') : t('connection.connect')}
            </button>
          )}
        </div>
      </div>

      <div className="mt-6 bg-surface rounded-xl border border-border p-6">
        <h3 className="text-sm font-semibold text-text-primary mb-3">{t('connection.topic_ref')}</h3>
        <div className="space-y-2 text-xs font-mono">
          <div className="flex gap-3">
            <span className="text-success min-w-[100px]">{t('connection.topic.sub')}</span>
            <span className="text-text-secondary">device/&#123;sn&#125;/message/up/&#123;name&#125;</span>
          </div>
          <div className="flex gap-3">
            <span className="text-primary-light min-w-[100px]">{t('connection.topic.pub')}</span>
            <span className="text-text-secondary">device/&#123;sn&#125;/message/down/&#123;name&#125;</span>
          </div>
          <div className="flex gap-3">
            <span className="text-accent min-w-[100px]">{t('connection.topic.reply')}</span>
            <span className="text-text-secondary">device/&#123;sn&#125;/message/down/&#123;name&#125;/reply</span>
          </div>
          <div className="flex gap-3">
            <span className="text-warning min-w-[100px]">{t('connection.topic.heartbeat')}</span>
            <span className="text-text-secondary">$/device/&#123;sn&#125;/message/up/keep_alive</span>
          </div>
        </div>
      </div>
    </div>
  );
}
