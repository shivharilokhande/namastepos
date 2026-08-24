// NamastePOS dashboard — plan tier + feature flags.
//
// Backend's /auth/me returns { plan: { tierKind, features[] } }. We cache
// that in React Query so any component can do:
//
//   const { has } = usePlan();
//   if (!has('kds')) return <UpgradeCard featureKey="kds" />;

import { useQuery } from '@tanstack/react-query';
import { ffApi } from '@/api/namastepos';

const STARTER_DEFAULT = {
  tierKind: 'starter',
  features: ['pos','orders','token_generation','tables_single_floor',
    'menu_basic','reports_basic','expenses','invoice_basic',
    'staff_lite','customers_basic'],
};

export interface PlanState {
  tierKind: 'starter' | 'pro' | 'enterprise';
  features: string[];
  has: (key: string) => boolean;
  isStarter: boolean;
  isPro: boolean;
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
    tierKind: plan.tierKind as PlanState['tierKind'],
    features: plan.features,
    has: (key: string) => set.has(key),
    isStarter: plan.tierKind === 'starter',
    isPro: plan.tierKind === 'pro',
    isEnterprise: plan.tierKind === 'enterprise',
  };
}
