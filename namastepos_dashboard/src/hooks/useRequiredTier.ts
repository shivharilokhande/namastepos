// NamastePOS dashboard — which plan includes a feature? (D-10, 2026-09-05)
//
// Computed from the live /plans feed (lowest ladder rung whose featureKeys
// include the key) so upgrade copy follows whatever the super-admin
// configured — never a hardcoded "this is a Pro feature" string.

import { useQuery } from '@tanstack/react-query';
import { ffApi } from '@/api/namastepos';
import { tierLabel, tierRank } from '@/lib/planTiers';

interface PlanFeed {
  name?: string;
  tierKind?: string | null;
  featureKeys?: string[];
  isCustom?: boolean;
}

/**
 * Owner-facing name of the cheapest public plan that includes `feature`,
 * or null when the live catalog does not list it anywhere.
 */
export function useRequiredTierFor(feature: string | null | undefined): {
  label: string | null; isLoading: boolean;
} {
  const { data, isLoading } = useQuery<PlanFeed[]>({
    queryKey: ['plans'],
    queryFn: ffApi.plans,
    staleTime: 60_000,
    enabled: !!feature,
  });
  if (!feature || !Array.isArray(data)) return { label: null, isLoading };
  let best: PlanFeed | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const p of data) {
    if (!Array.isArray(p.featureKeys) || !p.featureKeys.includes(feature)) continue;
    const rank = tierRank(p.tierKind ?? null);
    if (rank === null) continue; // bespoke/custom plans are not an upsell target
    if (rank < bestRank) { bestRank = rank; best = p; }
  }
  if (!best) return { label: null, isLoading };
  return { label: best.name || tierLabel(best.tierKind) || null, isLoading };
}
