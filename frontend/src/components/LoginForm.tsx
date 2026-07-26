import { useState } from 'react';
import { Camera, User as UserIcon, Lock, Loader2, Eye, EyeOff } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useI18n } from '../contexts/I18nContext';

/** Username + password login (authenticates against the shared SIGAP users
 *  table via POST /api/auth/login). Shown when there's no valid session. */
export default function LoginForm() {
  const { login } = useAuth();
  const { t } = useI18n();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setBusy(true);
    setError('');
    try {
      await login(username, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('login.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center p-6">
      <form onSubmit={submit} className="max-w-sm w-full bg-surface border border-border rounded-xl p-8">
        <div className="flex flex-col items-center mb-6">
          <div className="w-12 h-12 rounded-lg bg-primary flex items-center justify-center mb-3">
            <Camera className="w-6 h-6 text-white" />
          </div>
          <h1 className="text-base font-semibold text-text-primary">{t('shell.brand.title')}</h1>
          <p className="text-xs text-text-secondary mt-0.5">{t('login.subtitle')}</p>
        </div>

        <label className="block text-xs text-text-secondary mb-1">{t('login.username')}</label>
        <div className="relative mb-3">
          <UserIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-secondary" />
          <input value={username} onChange={e => setUsername(e.target.value)}
            autoFocus autoComplete="username" spellCheck={false}
            className="w-full pl-9 pr-3 py-2 bg-surface-dark border border-border rounded-md text-sm text-text-primary" />
        </div>

        <label className="block text-xs text-text-secondary mb-1">{t('login.password')}</label>
        <div className="relative mb-4">
          <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-secondary" />
          <input type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
            autoComplete="current-password"
            className="w-full pl-9 pr-9 py-2 bg-surface-dark border border-border rounded-md text-sm text-text-primary" />
          <button type="button" onClick={() => setShowPw(v => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-text-secondary hover:text-text-primary">
            {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>

        {error && (
          <div className="mb-3 px-3 py-2 rounded-md text-xs bg-danger/10 border border-danger/30 text-danger">
            {error}
          </div>
        )}

        <button type="submit" disabled={busy || !username.trim() || !password}
          className="w-full flex items-center justify-center gap-2 py-2.5 bg-primary hover:bg-primary/90 text-white text-sm font-medium rounded-md disabled:opacity-50">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          {t('login.submit')}
        </button>
      </form>
    </div>
  );
}
