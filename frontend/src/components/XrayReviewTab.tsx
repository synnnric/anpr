import { useCallback, useEffect, useState } from 'react';
import {
  ScanLine, RefreshCw, Loader2, Check, X, Send, ChevronLeft, ChevronRight, Search,
} from 'lucide-react';
import { listXray, reviewXray, resendXrayReceipt } from '../services/s300Service';
import type { Xray, XrayAlarm, XrayReviewStatus } from '../types/s300';
import ImageWithFallback from './ImageWithFallback';
import ImageLightbox, { type LightboxImage } from './ImageLightbox';
import cameraPlaceholder from '../assets/camera-placeholder.svg';
import { fmtPgTs } from '../utils/helpers';
import { useI18n } from '../contexts/I18nContext';

const PAGE_SIZE = 20;

/**
 * X-Ray review tab (Vehicle Inspection page). Lists scans pushed by the x-ray
 * station; a pending (anomaly) scan is decided here — Pass/Deny sends the
 * vendor receipt (POST /x-ray/{channelNo}) that opens or keeps closed the exit
 * barrier. Clean scans are auto-receipted by the backend and appear as 'auto'.
 */
export default function XrayReviewTab({ refreshSignal, onPending }: {
  refreshSignal: number;
  onPending: (n: number) => void;
}) {
  const { t } = useI18n();
  const [items, setItems] = useState<Xray[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState('');
  const [plateInput, setPlateInput] = useState('');
  const [plate, setPlate] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [preview, setPreview] = useState<LightboxImage | null>(null);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  const showToast = (msg: string, ok: boolean) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3000);
  };

  const reload = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const r = await listXray({
        limit: PAGE_SIZE, offset: page * PAGE_SIZE,
        ...(status ? { status } : {}), ...(plate ? { license_plate: plate } : {}),
      });
      setItems(r.items);
      setTotal(r.total);
      onPending(r.pending);
    } catch { /* toast on actions only — list refresh stays quiet */ }
    finally { setLoading(false); }
  }, [page, status, plate, onPending]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { setPage(0); }, [status, plate]);
  // SSE-driven refresh from the parent page (new scan / receipt event)
  useEffect(() => { if (refreshSignal > 0) reload(true); }, [refreshSignal, reload]);

  const decide = async (x: Xray, result: boolean) => {
    const p = x.vehicle_number ?? '?';
    if (!confirm(t(result ? 'xray.confirm.pass' : 'xray.confirm.deny', { p }))) return;
    setBusy(x.id);
    try {
      await reviewXray(x.id, result, notes[x.id]?.trim() || undefined);
      showToast(t('xray.toast.reviewed'), true);
      await reload(true);
    } catch (e) { showToast((e as Error).message, false); }
    finally { setBusy(null); }
  };

  const resend = async (x: Xray) => {
    setBusy(x.id);
    try {
      await resendXrayReceipt(x.id);
      showToast(t('xray.toast.resent'), true);
      await reload(true);
    } catch (e) { showToast((e as Error).message, false); }
    finally { setBusy(null); }
  };

  const isOpen = (x: Xray) => open[x.id] ?? (x.review_status === 'pending');
  const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-3">
      <ImageLightbox image={preview} onClose={() => setPreview(null)} />
      {toast && (
        <div className={`px-3 py-2 rounded-lg text-xs ${
          toast.ok ? 'bg-success/10 border border-success/30 text-success'
                   : 'bg-danger/10 border border-danger/30 text-danger'
        }`}>{toast.msg}</div>
      )}

      <div className="bg-surface border border-border rounded-lg p-4">
        <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2 mb-1">
          <ScanLine className="w-4 h-4 text-primary" /> {t('xray.title')}
        </h3>
        <p className="text-xs text-text-secondary mb-3">{t('xray.subtitle')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <select value={status} onChange={e => setStatus(e.target.value)}
            className="bg-surface-dark border border-border rounded-md px-2 py-1.5 text-xs text-text-primary">
            <option value="">{t('xray.filter.all_status')}</option>
            <option value="pending">{t('xray.status.pending')}</option>
            <option value="auto">{t('xray.status.auto')}</option>
            <option value="passed">{t('xray.status.passed')}</option>
            <option value="denied">{t('xray.status.denied')}</option>
          </select>
          <div className="flex items-center gap-1 bg-surface-dark border border-border rounded-md px-2 py-0.5">
            <Search className="w-3.5 h-3.5 text-text-secondary" />
            <input value={plateInput}
              onChange={e => setPlateInput(e.target.value.toUpperCase())}
              onKeyDown={e => { if (e.key === 'Enter') setPlate(plateInput.trim()); }}
              onBlur={() => setPlate(plateInput.trim())}
              placeholder={t('xray.filter.plate_ph')}
              className="bg-transparent w-32 text-xs py-1 text-text-primary focus:outline-none placeholder:text-text-secondary/60" />
          </div>
          <button onClick={() => reload()} disabled={loading}
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-text-secondary hover:text-text-primary border border-border rounded-md">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> {t('common.refresh')}
          </button>
          <span className="ml-auto text-[11px] text-text-secondary">{total.toLocaleString()}</span>
        </div>
      </div>

      {items.length === 0 && !loading && (
        <div className="bg-surface border border-border rounded-lg p-8 text-center text-sm text-text-secondary">
          {t('xray.empty')}
        </div>
      )}

      {items.map(x => (
        <div key={x.id} className={`bg-surface border rounded-lg ${
          x.review_status === 'pending' ? 'border-amber-500/50' : 'border-border'
        }`}>
          {/* Header row — always visible, click toggles the body */}
          <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 cursor-pointer"
            onClick={() => setOpen(o => ({ ...o, [x.id]: !isOpen(x) }))}>
            <span className="font-mono font-semibold text-text-primary">{x.vehicle_number || '—'}</span>
            <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${
              x.is_anomaly ? 'bg-red-500/15 text-red-400' : 'bg-green-500/15 text-green-400'
            }`}>
              {x.is_anomaly ? t('s300.xray.anomaly') : t('s300.xray.normal')}
            </span>
            <ReviewBadge status={x.review_status} />
            <ReceiptChip x={x} />
            <span className="ml-auto text-[10px] text-text-secondary font-mono">{fmtPgTs(x.received_at)}</span>
          </div>

          {isOpen(x) && (
            <div className="border-t border-border p-4 space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="md:col-span-2">
                  <XrayScanImage src={x.scanned_image_url} alarms={x.alarm_info}
                    onZoom={src => setPreview({ src, alt: 'x-ray scan' })} />
                </div>
                <div className="space-y-2">
                  {x.plate_image_url && (
                    <div className="bg-surface-dark border border-border rounded overflow-hidden cursor-zoom-in"
                      onClick={() => x.plate_image_url && setPreview({ src: x.plate_image_url, alt: 'plate' })}>
                      <ImageWithFallback src={x.plate_image_url} alt="plate" fallback={cameraPlaceholder}
                        className="w-full max-h-28 object-contain" />
                    </div>
                  )}
                  <div className="text-[11px] text-text-secondary space-y-0.5">
                    {x.anomaly_comments && <div className="text-red-400">{x.anomaly_comments}</div>}
                    {Array.isArray(x.alarm_info) && x.alarm_info.map((a, i) => (
                      <div key={i}>• {a.Comments} {a.Confidence != null ? `(${Math.round(a.Confidence * 100)}%)` : ''}</div>
                    ))}
                    {x.scanner_operator && <div>{t('s300.xray.operator')}: {x.scanner_operator}</div>}
                    <div>
                      {x.inspection_id
                        ? t('xray.linked', { id: x.inspection_id })
                        : t('xray.standalone')}
                    </div>
                    {x.reviewed_by && (
                      <div>{x.reviewed_by} · {fmtPgTs(x.reviewed_at)}{x.review_note ? ` — ${x.review_note}` : ''}</div>
                    )}
                  </div>
                </div>
              </div>

              {x.review_status === 'pending' && (
                <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-border">
                  <input value={notes[x.id] ?? ''} onChange={e => setNotes(n => ({ ...n, [x.id]: e.target.value }))}
                    placeholder={t('xray.note_ph')} maxLength={200}
                    className="flex-1 min-w-48 px-3 py-2 bg-surface-dark border border-border rounded-md text-xs text-text-primary" />
                  <button onClick={() => decide(x, true)} disabled={busy !== null}
                    className="flex items-center gap-1.5 px-3 py-2 bg-green-600 hover:bg-green-500 text-white text-xs font-medium rounded-md disabled:opacity-50">
                    {busy === x.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                    {t('xray.btn.pass')}
                  </button>
                  <button onClick={() => decide(x, false)} disabled={busy !== null}
                    className="flex items-center gap-1.5 px-3 py-2 bg-red-600 hover:bg-red-500 text-white text-xs font-medium rounded-md disabled:opacity-50">
                    {busy === x.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
                    {t('xray.btn.deny')}
                  </button>
                </div>
              )}

              {x.receipt_status === 'failed' && (
                <div className="flex items-center gap-2 pt-2 border-t border-border">
                  <span className="text-[11px] text-danger">{x.receipt_error}</span>
                  <button onClick={() => resend(x)} disabled={busy !== null}
                    className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-xs text-text-primary border border-border rounded-md hover:border-primary disabled:opacity-50">
                    {busy === x.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                    {t('xray.receipt.resend')}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      ))}

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-xs text-text-secondary">
          <span>{t('mqtt_logs.page.info', { p: page + 1, m: maxPage })}</span>
          <div className="flex items-center gap-2">
            <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0 || loading}
              className="flex items-center gap-1 px-2.5 py-1 border border-border rounded-md hover:text-text-primary disabled:opacity-40">
              <ChevronLeft className="w-3.5 h-3.5" /> {t('common.previous')}
            </button>
            <button onClick={() => setPage(p => p + 1)} disabled={page + 1 >= maxPage || loading}
              className="flex items-center gap-1 px-2.5 py-1 border border-border rounded-md hover:text-text-primary disabled:opacity-40">
              {t('common.next')} <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ReviewBadge({ status }: { status: XrayReviewStatus }) {
  const { t } = useI18n();
  const cls = status === 'pending' ? 'bg-amber-500/15 text-amber-400'
    : status === 'denied' ? 'bg-red-500/15 text-red-400'
    : status === 'passed' ? 'bg-green-500/15 text-green-400'
    : 'bg-surface-dark text-text-secondary';
  const key = status === 'pending' ? 'xray.status.pending'
    : status === 'auto' ? 'xray.status.auto'
    : status === 'passed' ? 'xray.status.passed' : 'xray.status.denied';
  return <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${cls}`}>{t(key)}</span>;
}

function ReceiptChip({ x }: { x: Xray }) {
  const { t } = useI18n();
  if (x.receipt_status === 'sent') {
    return (
      <span className={`text-[10px] px-2 py-0.5 rounded-full ${
        x.receipt_result === 1 ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'
      }`}>
        {t(x.receipt_result === 1 ? 'xray.receipt.sent_open' : 'xray.receipt.sent_closed')}
      </span>
    );
  }
  if (x.receipt_status === 'failed') {
    return <span className="text-[10px] px-2 py-0.5 rounded-full bg-danger/15 text-danger">{t('xray.receipt.failed')}</span>;
  }
  return null;
}

/** Scan image with the vendor's AlarmInfo regions drawn on top (native-pixel
 *  coords scaled to the displayed size, same approach as the UVIS overlay). */
function XrayScanImage({ src, alarms, onZoom }: {
  src: string | null;
  alarms: XrayAlarm[] | null;
  onZoom?: (src: string) => void;
}) {
  const [usingDummy, setUsingDummy] = useState(false);
  const [scale, setScale] = useState({ x: 1, y: 1 });
  const regions = Array.isArray(alarms) ? alarms.filter(a => a.Region) : [];
  const showOverlay = !usingDummy && !!src && regions.length > 0;

  return (
    <div className={`relative inline-block max-w-full overflow-hidden rounded border border-border ${src ? 'cursor-zoom-in' : ''}`}
      onClick={() => src && onZoom?.(src)}>
      <ImageWithFallback
        src={src}
        alt="x-ray scan"
        fallback={cameraPlaceholder}
        onFallbackChange={setUsingDummy}
        className="block max-w-full w-auto"
        onLoad={(e) => {
          const img = e.currentTarget;
          if (img.naturalWidth > 0) {
            setScale({ x: img.clientWidth / img.naturalWidth, y: img.clientHeight / img.naturalHeight });
          }
        }}
      />
      {showOverlay && regions.map((a, idx) => (
        <div key={idx}
          className="absolute border-2 border-red-500 bg-red-500/15"
          style={{
            left: (a.Region!.x ?? 0) * scale.x, top: (a.Region!.y ?? 0) * scale.y,
            width: (a.Region!.Width ?? 0) * scale.x, height: (a.Region!.Height ?? 0) * scale.y,
          }}>
          <span className="absolute -top-5 left-0 text-[10px] bg-red-500 text-white px-1 rounded whitespace-nowrap">
            {a.Comments ?? ''} {a.Confidence != null ? `${Math.round(a.Confidence * 100)}%` : ''}
          </span>
        </div>
      ))}
    </div>
  );
}
