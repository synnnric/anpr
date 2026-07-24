import { useI18n } from '../contexts/I18nContext';

export type DurationChoice = 'permanent' | '1d' | '7d' | '30d' | 'custom';

/** Resolve a duration choice to an expiry timestamp the backend/camera wants
 *  ('YYYY-MM-DD HH:MM:SS'), or '' for permanent. `custom` is a
 *  datetime-local value ('YYYY-MM-DDTHH:MM'). */
export function computeExpiry(choice: DurationChoice, custom: string): string {
  if (choice === 'permanent') return '';
  if (choice === 'custom') {
    if (!custom) return '';
    return custom.replace('T', ' ') + (custom.length === 16 ? ':00' : '');
  }
  const days = choice === '1d' ? 1 : choice === '7d' ? 7 : 30;
  const d = new Date(Date.now() + days * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Duration choice for list entries (VIP / blacklist / camera whitelist):
 * permanent (default) or 1/7/30 days or a custom date-time.
 */
export default function DurationPicker({ choice, setChoice, custom, setCustom }: {
  choice: DurationChoice;
  setChoice: (c: DurationChoice) => void;
  custom: string;
  setCustom: (v: string) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <select value={choice} onChange={e => setChoice(e.target.value as DurationChoice)}
        title={t('dur.label')}
        className="px-3 py-2 bg-surface-dark border border-border rounded-md text-sm text-text-primary">
        <option value="permanent">{t('dur.permanent')}</option>
        <option value="1d">{t('dur.1d')}</option>
        <option value="7d">{t('dur.7d')}</option>
        <option value="30d">{t('dur.30d')}</option>
        <option value="custom">{t('dur.custom')}</option>
      </select>
      {choice === 'custom' && (
        <input type="datetime-local" value={custom} onChange={e => setCustom(e.target.value)}
          className="px-3 py-2 bg-surface-dark border border-border rounded-md text-sm text-text-primary" />
      )}
    </>
  );
}

/** True when an expiry timestamp ('YYYY-MM-DD HH:MM:SS' or ISO) is in the past. */
export function isExpired(expiresAt: string | null | undefined): boolean {
  if (!expiresAt) return false;
  const d = new Date(expiresAt.replace(' ', 'T'));
  return !isNaN(d.getTime()) && d.getTime() < Date.now();
}
