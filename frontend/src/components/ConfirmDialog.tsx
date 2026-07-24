import { AlertTriangle } from 'lucide-react';
import { useI18n } from '../contexts/I18nContext';

export type ConfirmTone = 'danger' | 'warning';

export interface ConfirmSpec {
  title: string;
  message: string;
  confirmLabel: string;
  tone?: ConfirmTone;
  onConfirm: () => void;
}

/**
 * Reusable confirmation popup for risk actions (blocker RAISE, enabling auto-open,
 * changing the S300 inspection mode). Controlled: render it only when a spec is
 * set, and clear the spec in onCancel / inside onConfirm.
 */
export default function ConfirmDialog({ spec, onCancel }: { spec: ConfirmSpec; onCancel: () => void }) {
  const { t } = useI18n();
  const danger = (spec.tone ?? 'warning') === 'danger';
  const accent = danger ? 'text-red-500' : 'text-amber-500';
  const btn = danger
    ? 'bg-red-600 hover:bg-red-700'
    : 'bg-amber-600 hover:bg-amber-700';

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60] p-4"
      role="dialog" aria-modal="true" onClick={onCancel}>
      <div className="bg-surface border border-border rounded-lg w-full max-w-sm p-5"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-start gap-3">
          <AlertTriangle className={`w-6 h-6 shrink-0 mt-0.5 ${accent}`} />
          <div>
            <h3 className="text-text-primary font-semibold mb-1">{spec.title}</h3>
            <p className="text-sm text-text-secondary whitespace-pre-line">{spec.message}</p>
          </div>
        </div>
        <div className="flex gap-2 mt-5 justify-end">
          <button onClick={onCancel}
            className="px-3 py-1.5 text-sm border border-border rounded-md text-text-secondary hover:text-text-primary">
            {t('common.cancel')}
          </button>
          <button onClick={spec.onConfirm}
            className={`px-3 py-1.5 text-white text-sm rounded-md ${btn}`}>
            {spec.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
