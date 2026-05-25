import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Users, RefreshCw, Plus, Trash2, KeyRound, Loader2, AlertCircle, X,
  ShieldCheck, User as UserIcon, Eye, Crown, CheckCircle2,
} from 'lucide-react';
import {
  listUsers, createUser, updateUser, setUserPassword, deleteUser,
  type Role, type CreateUserPayload,
} from '../services/usersService';
import type { AuthUser } from '../services/authService';
import { useAuth } from '../contexts/AuthContext';
import { fmtPgTs } from '../utils/helpers';
import { useI18n } from '../contexts/I18nContext';
import type { TKey } from '../i18n/translations';

const ROLE_META: Record<Role, { key: TKey; bg: string; text: string; icon: typeof UserIcon }> = {
  admin:    { key: 'users.role.admin',    bg: 'bg-red-500/15',    text: 'text-red-300',        icon: Crown },
  operator: { key: 'users.role.operator', bg: 'bg-blue-500/15',   text: 'text-blue-300',       icon: ShieldCheck },
  viewer:   { key: 'users.role.viewer',   bg: 'bg-gray-500/15',   text: 'text-text-secondary', icon: Eye },
};

export default function UsersPage() {
  const { t } = useI18n();
  const { user: me } = useAuth();
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<AuthUser | null>(null);

  const showToast = (msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3000);
  };

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setUsers(await listUsers());
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const onRoleChange = async (u: AuthUser, role: Role) => {
    try {
      await updateUser(u.id, { role });
      showToast(t('users.toast.role_change', { username: u.username, role }));
      reload();
    } catch (e) { showToast((e as Error).message, false); }
  };

  const onToggleEnabled = async (u: AuthUser) => {
    try {
      await updateUser(u.id, { enabled: !u.enabled });
      showToast(u.enabled
        ? t('users.toast.disabled', { username: u.username })
        : t('users.toast.enabled', { username: u.username }));
      reload();
    } catch (e) { showToast((e as Error).message, false); }
  };

  const onDelete = async (u: AuthUser) => {
    if (!confirm(t('users.confirm_delete', { username: u.username }))) return;
    try {
      await deleteUser(u.id);
      showToast(t('users.toast.deleted', { username: u.username }));
      reload();
    } catch (e) { showToast((e as Error).message, false); }
  };

  return (
    <div className="h-full flex flex-col bg-bg overflow-hidden">
      <header className="bg-surface border-b border-border px-6 py-4 shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-text-primary flex items-center gap-2">
              <Users className="w-5 h-5 text-primary" /> {t('users.title')}
            </h1>
            <p className="text-xs text-text-secondary mt-0.5">
              {t('users.subtitle')}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setCreating(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-primary text-white rounded-md hover:bg-primary/90">
              <Plus className="w-3.5 h-3.5" /> {t('users.new')}
            </button>
            <button onClick={reload} disabled={loading}
              className="flex items-center gap-1 px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary border border-border rounded-md">
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> {t('common.refresh')}
            </button>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6 space-y-3">
        {error && (
          <div className="text-xs text-danger bg-danger/10 border border-danger/30 rounded-md px-3 py-2 flex items-center gap-2">
            <AlertCircle className="w-3.5 h-3.5" /> {error}
          </div>
        )}

        <div className="bg-surface border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-surface-dark text-text-secondary text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-2">{t('users.col.id')}</th>
                <th className="text-left px-4 py-2">{t('users.col.username')}</th>
                <th className="text-left px-4 py-2">{t('users.col.display_name')}</th>
                <th className="text-left px-4 py-2">{t('users.col.role')}</th>
                <th className="text-left px-4 py-2">{t('users.col.status')}</th>
                <th className="text-left px-4 py-2">{t('users.col.created')}</th>
                <th className="text-right px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {users.map(u => {
                const isSelf = me?.id === u.id;
                const meta = ROLE_META[u.role];
                const Icon = meta.icon;
                return (
                  <tr key={u.id} className="border-t border-border hover:bg-surface-dark/40">
                    <td className="px-4 py-2 text-text-secondary font-mono">#{u.id}</td>
                    <td className="px-4 py-2 text-text-primary font-mono">
                      {u.username}
                      {isSelf && <span className="ml-2 text-[10px] text-primary">{t('users.you')}</span>}
                    </td>
                    <td className="px-4 py-2 text-text-secondary">{u.display_name || '—'}</td>
                    <td className="px-4 py-2">
                      <select value={u.role}
                        onChange={e => onRoleChange(u, e.target.value as Role)}
                        className={`text-[11px] font-semibold px-2 py-0.5 rounded border-none focus:outline-none ${meta.bg} ${meta.text}`}>
                        <option value="admin">{t('users.role.admin')}</option>
                        <option value="operator">{t('users.role.operator')}</option>
                        <option value="viewer">{t('users.role.viewer')}</option>
                      </select>
                      <Icon className={`inline w-3 h-3 ml-1.5 ${meta.text}`} />
                    </td>
                    <td className="px-4 py-2">
                      <button onClick={() => onToggleEnabled(u)}
                        className={`text-[11px] px-1.5 py-0.5 rounded font-semibold border ${
                          u.enabled
                            ? 'bg-green-500/15 text-green-300 border-green-500/30'
                            : 'bg-surface-dark text-text-secondary border-border'
                        }`}>
                        {u.enabled ? t('users.status.active') : t('users.status.disabled')}
                      </button>
                    </td>
                    <td className="px-4 py-2 text-text-secondary text-xs font-mono">{fmtPgTs(u.created_at)}</td>
                    <td className="px-4 py-2 text-right">
                      <button onClick={() => setResetting(u)} title={t('users.action.reset_pw')}
                        className="p-1.5 text-text-secondary hover:text-amber-300">
                        <KeyRound className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => onDelete(u)} disabled={isSelf}
                        title={isSelf ? t('users.action.delete_self') : t('users.action.delete')}
                        className="p-1.5 text-text-secondary hover:text-danger disabled:opacity-30 disabled:cursor-not-allowed">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })}
              {users.length === 0 && !loading && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-text-secondary text-sm">{t('users.empty')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {creating && (
        <CreateUserModal
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); reload(); showToast(t('users.toast.created')); }}
          onError={(e) => showToast(e, false)}
        />
      )}
      {resetting && (
        <ResetPasswordModal
          user={resetting}
          onClose={() => setResetting(null)}
          onDone={() => { setResetting(null); showToast(t('users.toast.pw_reset', { username: resetting.username })); }}
          onError={(e) => showToast(e, false)}
        />
      )}
      {toast && (
        <div className={`fixed bottom-6 right-6 px-4 py-2 rounded-md shadow-lg text-sm flex items-center gap-2 ${
          toast.ok ? 'bg-green-500/20 text-green-300 border border-green-500/40'
                   : 'bg-danger/20 text-danger border border-danger/40'
        }`}>
          {toast.ok ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
          {toast.msg}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────

function CreateUserModal({ onClose, onCreated, onError }: {
  onClose: () => void;
  onCreated: () => void;
  onError: (msg: string) => void;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState<CreateUserPayload>({
    username: '', password: '', display_name: '', role: 'operator',
  });
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await createUser(form);
      onCreated();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title={t('users.modal.new_title')} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label={t('users.field.username')}>
          <input value={form.username} autoFocus required
            onChange={e => setForm({ ...form, username: e.target.value })} />
        </Field>
        <Field label={t('users.field.display_name')}>
          <input value={form.display_name ?? ''}
            onChange={e => setForm({ ...form, display_name: e.target.value })} />
        </Field>
        <Field label={t('users.field.password')}>
          <input type="password" value={form.password} required minLength={6}
            onChange={e => setForm({ ...form, password: e.target.value })} />
        </Field>
        <Field label={t('users.field.role')}>
          <select value={form.role}
            onChange={e => setForm({ ...form, role: e.target.value as Role })}>
            <option value="admin">{t('users.role.admin_desc')}</option>
            <option value="operator">{t('users.role.operator_desc')}</option>
            <option value="viewer">{t('users.role.viewer_desc')}</option>
          </select>
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose}
            className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary border border-border rounded-md">
            {t('common.cancel')}
          </button>
          <button type="submit" disabled={submitting}
            className="px-3 py-1.5 text-xs bg-primary text-white rounded-md hover:bg-primary/90 flex items-center gap-1.5">
            {submitting && <Loader2 className="w-3 h-3 animate-spin" />}
            {t('users.btn.create')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ResetPasswordModal({ user, onClose, onDone, onError }: {
  user: AuthUser;
  onClose: () => void;
  onDone: () => void;
  onError: (msg: string) => void;
}) {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 6) return;
    setSubmitting(true);
    try {
      await setUserPassword(user.id, password);
      onDone();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title={t('users.modal.reset_title', { username: user.username })} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <p className="text-xs text-text-secondary">
          {t('users.modal.reset_hint')}
        </p>
        <Field label={t('users.field.new_password')}>
          <input type="password" autoFocus required minLength={6}
            value={password} onChange={e => setPassword(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose}
            className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary border border-border rounded-md">
            {t('common.cancel')}
          </button>
          <button type="submit" disabled={submitting || password.length < 6}
            className="px-3 py-1.5 text-xs bg-primary text-white rounded-md hover:bg-primary/90 disabled:opacity-60 flex items-center gap-1.5">
            {submitting && <Loader2 className="w-3 h-3 animate-spin" />}
            {t('users.btn.set_password')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Modal({ title, children, onClose }: {
  title: string; children: React.ReactNode; onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/50 z-40 flex items-center justify-center p-4"
      onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl w-full max-w-md shadow-2xl"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
          <button onClick={onClose}
            className="p-1 text-text-secondary hover:text-text-primary rounded">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-xs font-medium text-text-secondary mb-1">{label}</div>
      <div className="[&_input]:w-full [&_select]:w-full [&_input]:bg-surface-dark [&_select]:bg-surface-dark
                      [&_input]:border [&_select]:border [&_input]:border-border [&_select]:border-border
                      [&_input]:rounded-md [&_select]:rounded-md [&_input]:px-3 [&_select]:px-3
                      [&_input]:py-2 [&_select]:py-2 [&_input]:text-sm [&_select]:text-sm
                      [&_input]:text-text-primary [&_select]:text-text-primary
                      [&_input]:focus:outline-none [&_input]:focus:border-primary
                      [&_select]:focus:outline-none [&_select]:focus:border-primary">
        {children}
      </div>
    </label>
  );
}
