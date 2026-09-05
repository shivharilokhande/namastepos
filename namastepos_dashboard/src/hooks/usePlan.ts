// NamastePOS dashboard — plan tier + feature flags.
//
// Backend's /auth/me returns { plan: { tierKind, features[], planVersion },
// role, permissions }. We cache that in React Query so any component can do:
//
//   const { has, loaded } = usePlan();
//   if (loaded && !has('kds')) return <UpgradeCard featureKey="kds" />;
//
// FAIL-CLOSED (D-15, 2026-09-05): there is deliberately NO default feature
// list here. Until /auth/me has answered, `has()` returns false for every
// key and `loaded` is false. The previous `STARTER_DEFAULT` granted ten
// hardcoded keys while loading (fail-open) and had already drifted from the
// live Starter plan. Callers that must not flash a lock icon should render a
// skeleton (or no badge) while `!loaded` instead of assuming a plan.
//
// D-19: this hook and Layout used to run two identical /auth/me queries
// under different keys (['plan-summary'] and ['me']). Both now share
// `useMe()` below under the single key ['me'].

import { useQuery } from '@tanstack/react-query';
import { ffApi, type MeResponse } from '@/api/namastepos';
import { isTopTier, tierAtLeast, tierLabel, TIER_KIND_LADDER } from '@/lib/planTiers';

export const ME_QUERY_KEY = ['me'] as const;

/** The one /auth/me query every entitlement/identity consumer shares. */
export function useMe() {
  return useQuery<MeResponse>({
    queryKey: ME_QUERY_KEY,
    queryFn: () => ffApi.me(),
    // Refetch every minute (catches admin-side plan changes) plus on
    // every window focus (catches the user coming back from billing).
    // The X-Plan-Version interceptor in api/client.ts invalidates this
    // query the moment any API response reports a new entitlement version,
    // so the poll is only the backstop.
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

export interface PlanState {
  // A tier KIND (not a plan tier code), and the list is open-ended — see
  // @/lib/planTiers. This was typed 'starter' | 'pro' | 'enterprise', a
  // three-value union that had drifted from the live five-kind ladder, so
  // the 'pro_plan' and 'advanced' kinds were mistyped at every use site.
  tierKind: string;
  /** Owner-facing name for tierKind ('pro_plan' -> 'Pro'). */
  tierLabel: string;
  /** Owner-facing name of the next plan up, or null at the top / bespoke. */
  nextTierLabel: string | null;
  features: string[];
  /** False for EVERY key until /auth/me has loaded (fail-closed). */
  has: (key: string) => boolean;
  /** True when the plan sits at or above `kind` on the ladder. */
  atLeast: (kind: string) => boolean;
  isStarter: boolean;
  /** At or above Growth (kind 'pro') — i.e. any paid plan. */
  isPro: boolean;
  /** The TOP rung of the ladder. Used to hide "View plans". */
  isEnterprise: boolean;
  /** /auth/me is still in flight (first load). */
  isLoading: boolean;
  /** /auth/me has answered with a plan block. Gate lock badges on this. */
  loaded: boolean;
  /** Server-side entitlement version (same as the X-Plan-Version header). */
  planVersion: string | number | null;
  /** 'business_owner' | 'staff_*' | null while loading. */
  role: string | null;
  /**
   * Effective staff permission keys. null for the owner ("all") AND while
   * loading — callers must check `loaded` before treating null as "owner".
   */
  permissions: string[] | null;
}

export function usePlan(): PlanState {
  const { data, isLoading } = useMe();
  const plan = data?.plan ?? null;
  const features = plan?.features ?? [];
  const set = new Set(features);
  const tierKind = plan?.tierKind ?? '';
  const loaded = !!plan;
  return {
    tierKind,
    tierLabel: loaded ? tierLabel(tierKind) : '',
    nextTierLabel: plan?.nextTierLabel ?? null,
    features,
    has: (key: string) => loaded && set.has(key),
    atLeast: (kind: string) => loaded && tierAtLeast(tierKind, kind),
    isStarter: loaded && tierKind === TIER_KIND_LADDER[0],
    isPro: loaded && tierAtLeast(tierKind, 'pro'),
    isEnterprise: loaded && isTopTier(tierKind),
    isLoading,
    loaded,
    planVersion: plan?.planVersion ?? null,
    role: data?.role ?? null,
    permissions: data?.permissions ?? null,
  };
}
