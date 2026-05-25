import { useState, type FormEvent } from 'react';
import { Camera, Lock, User as UserIcon, Loader2, AlertCircle } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useI18n } from '../contexts/I18nContext';

export default function LoginPage() {
  const { login } = useAuth();
  const { lang, setLang, t } = useI18n();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError(t('login.error.required'));
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await login(username.trim(), password);
    } catch (err) {
      setError((err as Error).message || t('login.error.failed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="flex justify-end mb-3">
          <div className="flex items-center gap-0.5 border border-border rounded-md p-0.5 bg-surface-dark"
            title="Bahasa / Language">
            <button onClick={() => setLang('id')}
              className={`px-2 py-0.5 text-[10px] font-bold rounded transition-colors ${
                lang === 'id' ? 'bg-primary text-white' : 'text-text-secondary hover:text-text-primary'
              }`}>ID</button>
            <button onClick={() => setLang('en')}
              className={`px-2 py-0.5 text-[10px] font-bold rounded transition-colors ${
                lang === 'en' ? 'bg-primary text-white' : 'text-text-secondary hover:text-text-primary'
              }`}>EN</button>
          </div>
        </div>

        <div className="flex flex-col items-center mb-6">
          <div className="w-14 h-14 rounded-2xl bg-primary flex items-center justify-center mb-3">
            <Camera className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-lg font-bold text-text-primary">{t('shell.brand.title')}</h1>
          <p className="text-xs text-text-secondary mt-0.5">{t('shell.brand.subtitle')}</p>
        </div>

        <form onSubmit={onSubmit}
          className="bg-surface border border-border rounded-xl p-6 space-y-4 shadow-lg">
          <div>
            <label className="text-xs font-medium text-text-secondary mb-1.5 flex items-center gap-1.5">
              <UserIcon className="w-3.5 h-3.5" /> {t('login.username.label')}
            </label>
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoFocus
              autoComplete="username"
              className="w-full bg-surface-dark border border-border rounded-md px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-primary"
              placeholder={t('login.username.placeholder')}
              disabled={submitting}
            />
          </div>

          <div>
            <label className="text-xs font-medium text-text-secondary mb-1.5 flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5" /> {t('login.password.label')}
            </label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="current-password"
              className="w-full bg-surface-dark border border-border rounded-md px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-primary"
              placeholder={t('login.password.placeholder')}
              disabled={submitting}
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 text-xs text-danger bg-danger/10 border border-danger/30 rounded-md p-2">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full bg-primary hover:bg-primary/90 disabled:opacity-60 text-white text-sm font-medium rounded-md py-2 flex items-center justify-center gap-2 transition-colors">
            {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {submitting ? t('login.submitting') : t('login.submit')}
          </button>
        </form>

        <p className="text-[10px] text-text-secondary text-center mt-4">
          {t('shell.footer.login')}
        </p>
      </div>
    </div>
  );
}
