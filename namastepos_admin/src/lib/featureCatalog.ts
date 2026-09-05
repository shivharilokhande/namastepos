// NamastePOS admin — the registry feature catalog, shared by every picker (F-04, 2026-09-06).
// Hook + pure helpers only (no components) so pages and components import it
// freely. Rendering lives in src/components/FeaturePicker.tsx.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { adminApi, FeatureCatalogEntry } from '@/api/admin';

/** The registry catalog + declared group order. Cached 60s across all pickers. */
export function useFeatureCatalog() {
  const q = useQuery({
    queryKey: ['feature-catalog-detailed'],
    queryFn: adminApi.featureCatalogDetailed,
    staleTime: 60_000,
  });
  // Memoised so consumers can hang useMemo/useEffect deps off stable arrays
  // instead of a fresh `?? []` every render.
  const catalog = useMemo(() => q.data?.catalog ?? [], [q.data?.catalog]);
  const groups = useMemo(() => q.data?.groups ?? [], [q.data?.groups]);
  return { catalog, groups, isLoading: q.isLoading, isError: q.isError, error: q.error, refetch: q.refetch };
}

/** Sections in registry order; unknown groups appended so nothing disappears. */
export function groupCatalog<T extends Pick<FeatureCatalogEntry, 'key' | 'group'>>(catalog: T[], order: string[]): [string, T[]][] {
  const buckets = new Map<string, T[]>();
  for (const g of order) buckets.set(g, []);
  for (const entry of catalog) {
    const g = entry.group || 'Other';
    if (!buckets.has(g)) buckets.set(g, []);
    buckets.get(g)!.push(entry);
  }
  return [...buckets.entries()].filter(([, v]) => v.length > 0);
}

/** "Nothing enforces this" — granting it charges for a promise no gate keeps. */
export function isToothless(e: Pick<FeatureCatalogEntry, 'enforcement'>): boolean {
  return e.enforcement === 'ungated' || e.enforcement === 'unregistered';
}

export const ENFORCEMENT_TITLE: Record<string, string> = {
  route: 'A backend route gate returns 402 without this key.',
  middleware: 'Backend middleware returns 402/403 without this key.',
  service: 'A backend service re-checks this key at use time.',
  client: 'No server surface — the dashboard / mobile app honours the key.',
  ungated: 'No gate enforces this key — granting it promises something nothing checks.',
  unregistered: 'A plan_features row for a key the registry does not declare — nothing reads it.',
  unknown: 'Older backend: enforcement not reported.',
};
