// NamastePOS admin — ONE grouped feature-key picker (F-04, 2026-09-06).
//
// Before this file the console had FOUR pickers for the same registry: the
// plan editor (grouped by registry section, with the `ungated` badge and the
// `why` tooltip), the custom-plan extras (grouped by the key's first `_`
// segment — "accounting", "auto", "b2b", "bill"…), the per-business override
// <select> (no badge, no tooltip) and the addon "grants features" list (flat).
// Granting `api_access` / `white_label` / `customers_crm` from three of them
// carried no warning — exactly the 2026-09-05 Voice POS class of bug.
//
// Every picker now renders through this component, from ONE catalog call
// (`useFeatureCatalog`), so labels, sections, the enforcement chip and the
// ungated/unregistered warning are identical everywhere. There is deliberately
// no local key list, label map or bucket map here — the backend registry
// (src/config/featureRegistry.js) is the only source, and its drift test holds
// the `enforcement` field to the real gates.

import { useMemo, useState } from 'react';
import { FeatureCatalogEntry } from '@/api/admin';
import { Input } from '@/components/ui/input';
// Catalog hook + grouping helpers live in src/lib/featureCatalog.ts (import
// `useFeatureCatalog` from there); this file is components only.
import { groupCatalog, isToothless, ENFORCEMENT_TITLE } from '@/lib/featureCatalog';

const ENFORCEMENT_STYLE: Record<string, string> = {
  route: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  middleware: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  service: 'bg-sky-50 text-sky-700 border-sky-200',
  client: 'bg-slate-50 text-slate-600 border-slate-200',
  ungated: 'bg-amber-50 text-amber-700 border-amber-300',
  unregistered: 'bg-red-50 text-red-700 border-red-300',
  unknown: 'bg-muted text-muted-foreground border-transparent',
};
/** Small chip saying what actually gates the key (route / service / client / ungated…). */
export function EnforcementChip({ enforcement, className = '' }: { enforcement?: string; className?: string }) {
  const kind = enforcement || 'unknown';
  return (
    <span
      className={`inline-block rounded border px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide shrink-0 ${ENFORCEMENT_STYLE[kind] ?? ENFORCEMENT_STYLE.unknown} ${className}`}
      title={ENFORCEMENT_TITLE[kind] ?? ENFORCEMENT_TITLE.unknown}>
      {kind}
    </span>
  );
}

export interface FeaturePickerProps {
  catalog: FeatureCatalogEntry[];
  groups: string[];
  /** Keys currently ticked. */
  selected: Set<string>;
  onToggle: (key: string) => void;
  /** Keys shown ticked + disabled (e.g. inherited from a base plan). */
  locked?: Set<string>;
  lockedBadge?: string;           // e.g. "base"
  lockedTitle?: (key: string) => string | undefined;
  /** Radio semantics: exactly one key; the parent sets `selected` to `new Set([key])`. */
  single?: boolean;
  /** Show the filter box (default true). */
  searchable?: boolean;
  columns?: 1 | 2 | 3;
  /** Tailwind max-height class for the scroll area; '' = unbounded. */
  maxHeightClass?: string;
  emptyText?: string;
  /** Hide keys already used elsewhere (e.g. existing overrides). */
  exclude?: Set<string>;
  className?: string;
}

export function FeaturePicker({
  catalog, groups, selected, onToggle, locked, lockedBadge = 'base', lockedTitle,
  single = false, searchable = true, columns = 2, maxHeightClass = 'max-h-72',
  emptyText = 'No feature keys available — check that the admin API is reachable.',
  exclude, className = '',
}: FeaturePickerProps) {
  const [search, setSearch] = useState('');
  const sections = useMemo(() => {
    const q = search.trim().toLowerCase();
    const visible = catalog.filter((e) =>
      (!exclude || !exclude.has(e.key))
      && (!q || e.key.toLowerCase().includes(q) || (e.label || '').toLowerCase().includes(q)
        || (e.group || '').toLowerCase().includes(q)));
    return groupCatalog(visible, groups);
  }, [catalog, groups, search, exclude]);

  const gridCols = columns === 1 ? 'grid-cols-1'
    : columns === 3 ? 'grid-cols-1 md:grid-cols-3'
    : 'grid-cols-1 md:grid-cols-2';
  const inputName = useMemo(() => `fp-${Math.random().toString(36).slice(2, 8)}`, []);

  return (
    <div className={className}>
      {searchable && (
        <Input className="h-8 mb-2" placeholder="Filter features (key, label or section)…"
          value={search} onChange={(e) => setSearch(e.target.value)} />
      )}
      <div className={`border rounded-md p-3 overflow-y-auto space-y-3 ${maxHeightClass}`}>
        {catalog.length === 0 && (
          <div className="text-sm text-muted-foreground">{emptyText}</div>
        )}
        {catalog.length > 0 && sections.length === 0 && (
          <div className="text-sm text-muted-foreground">No feature matches “{search}”.</div>
        )}
        {sections.map(([groupName, entries]) => (
          <div key={groupName}>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
              {groupName}
            </div>
            <div className={`grid ${gridCols} gap-1`}>
              {entries.map((entry) => {
                const isLocked = !!locked?.has(entry.key);
                const checked = isLocked || selected.has(entry.key);
                const toothless = isToothless(entry);
                const title = isLocked
                  ? (lockedTitle?.(entry.key) ?? 'Included automatically')
                  : (entry.why ?? entry.key);
                return (
                  <label key={entry.key} title={title}
                    className={`flex items-center gap-2 px-2 py-1 rounded text-sm ${
                      isLocked ? 'opacity-70' : 'hover:bg-muted/50 cursor-pointer'}`}>
                    <input
                      type={single ? 'radio' : 'checkbox'}
                      name={single ? inputName : undefined}
                      checked={checked}
                      disabled={isLocked}
                      onChange={() => !isLocked && onToggle(entry.key)} />
                    <span className="flex-1 min-w-0">
                      <span className="block truncate">{entry.label || entry.key}</span>
                      <span className="block font-mono text-[11px] text-muted-foreground truncate">{entry.key}</span>
                    </span>
                    {isLocked && (
                      <span className="text-[10px] uppercase tracking-wide text-emerald-700 shrink-0">{lockedBadge}</span>
                    )}
                    {toothless ? (
                      <span className="text-[10px] font-semibold uppercase text-amber-600 shrink-0"
                        title={ENFORCEMENT_TITLE[entry.enforcement] ?? ENFORCEMENT_TITLE.ungated}>
                        {entry.enforcement}
                      </span>
                    ) : (
                      <EnforcementChip enforcement={entry.enforcement} />
                    )}
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
