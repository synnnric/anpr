import type { S300Channel } from '../types/s300';
import { useI18n } from '../contexts/I18nContext';

/**
 * Lane-scope picker for plate lists: "all lanes" (default) or a set of specific
 * entry lanes. Selected lanes become the create call's channel_nos (one plate
 * row per lane); all-lanes sends none (a single NULL-scope row).
 */
export function LaneScopePicker({ channels, allLanes, setAllLanes, sel, setSel }: {
  channels: S300Channel[];
  allLanes: boolean;
  setAllLanes: (v: boolean) => void;
  sel: string[];
  setSel: (v: string[]) => void;
}) {
  const { t } = useI18n();
  const entryLanes = channels.filter(c => c.kind === 'entry');
  const toggleLane = (chNo: string) =>
    setSel(sel.includes(chNo) ? sel.filter(x => x !== chNo) : [...sel, chNo]);
  return (
    <div className="flex flex-wrap items-center gap-3 mt-3">
      <span className="text-xs text-text-secondary">{t('s300.scope.label')}</span>
      <label className="flex items-center gap-1.5 text-xs text-text-primary cursor-pointer">
        <input type="checkbox" checked={allLanes} onChange={e => setAllLanes(e.target.checked)} />
        {t('s300.scope.all')}
      </label>
      {entryLanes.map(c => (
        <label key={c.id} className={`flex items-center gap-1.5 text-xs cursor-pointer ${
          allLanes ? 'text-text-secondary/50' : 'text-text-primary'
        }`}>
          <input type="checkbox" disabled={allLanes}
            checked={!allLanes && sel.includes(c.channel_no)}
            onChange={() => toggleLane(c.channel_no)} />
          <span className="font-mono">{c.channel_no}</span>{c.name ? ` — ${c.name}` : ''}
        </label>
      ))}
    </div>
  );
}

/** Scope badge for a plate row: the lane it applies to, or "all lanes". */
export function ScopeBadge({ channelNo }: { channelNo: string | null }) {
  const { t } = useI18n();
  return channelNo
    ? <span className="text-[10px] px-1.5 py-0.5 rounded font-mono bg-blue-500/15 text-blue-300">{channelNo}</span>
    : <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-dark text-text-secondary">{t('s300.scope.all')}</span>;
}
