// NamastePOS dashboard — plan tier + feature flags.
//
// Backend's /auth/me returns { plan: { tierKind, features[] } }. We cache
// that in React Query so any component can do:
//
//   const { has } = usePlan();
//   if (!has('kds')) return <UpgradeCard featureKey="kds" />;

import { useQuery } from '@tanstack/react-query';
import { ffApi } from '@/api/namastepos';
import { isTopTier, tierAtLeast, tierLabel, TIER_KIND_LADDER } from '@/lib/planTiers';

const STARTER_DEFAULT = {
  tierKind: TIER_KIND_LADDER[0],
  features: ['pos','orders','token_generation','tables_single_floor',
    'menu_basic','reports_basic','expenses','invoice_basic',
    'staff_lite','customers_basic'],
};

export interface PlanState {
  // A tier KIND (not a plan tier code), and the list is open-ended — see
  // @/lib/planTiers. This was typed 'starter' | 'pro' | 'enterprise', a
  // three-value union that had drifted from the live five-kind ladder, so
  // the 'pro_plan' and 'advanced' kinds were mistyped at every use site.
  tierKind: string;
  /** Owner-facing name for tierKind ('pro_plan' -> 'Pro'). */
  tierLabel: string;
  features: string[];
  has: (key: string) => boolean;
  /** True when the plan sits at or above `kind` on the ladder. */
  atLeast: (kind: string) => boolean;
  isStarter: boolean;
  /** At or above Growth (kind 'pro') — i.e. any paid plan. */
  isPro: boolean;
  /** The TOP rung of the ladder. Used to hide "View plans". */
  isEnterprise: boolean;
}

export function usePlan(): PlanState {
  const { data } = useQuery({
    queryKey: ['plan-summary'],
    queryFn: () => ffApi.me(),
    // Refetch every minute (catches admin-side plan changes) plus on
    // every window focus (catches the user coming back from billing).
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const plan = (data?.plan as { tierKind: string; features: string[] } | undefined)
    || STARTER_DEFAULT;
  const set = new Set(plan.features);
  return {
    tierKind: plan.tierKind,
    tierLabel: tierLabel(plan.tierKind),
    features: plan.features,
    has: (key: string) => set.has(key),
    atLeast: (kind: string) => tierAtLeast(plan.tierKind, kind),
    isStarter: plan.tierKind === TIER_KIND_LADDER[0],
    isPro: tierAtLeast(plan.tierKind, 'pro'),
    isEnterprise: isTopTier(plan.tierKind),
  };
}
