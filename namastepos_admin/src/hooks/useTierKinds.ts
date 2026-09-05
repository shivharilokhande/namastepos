// The plan tier-kind ladder, fetched from the backend.
//
// SINGLE SOURCE OF TRUTH is namastepos_backend/src/services/planTiers.js
// (TIER_KIND_LADDER), served by GET /v1/admin/tier-kinds. Read that file's
// header before touching anything tier-related — plans have BOTH a tier CODE
// and a tier KIND, and the string 'pro' means different plans in each
// namespace (code 'pro' = Enterprise, kind 'pro' = Growth; the plan named
// Pro is 'pro_plan').
//
// 2026-09-04: two admin pages each kept their own
// `['starter','pro','enterprise']` copy. Both had drifted from the live
// five-kind ladder, so the Pro and Advanced levels were unselectable — a
// plan or a standalone custom plan could not be created at either. Never
// declare a local list; call this hook.

import { useQuery } from '@tanstack/react-query';
import { adminApi, TierKindOption } from '@/api/admin';

export function useTierKinds(): TierKindOption[] {
  const { data } = useQuery({
    queryKey: ['tier-kinds'],
    queryFn: adminApi.tierKinds,
    staleTime: Infinity, // the ladder only changes on deploy
  });
  return data ?? [];
}

// F-13 (2026-09-06): `tierKindLabel` had no call sites and was removed. Pages
// resolve labels inline via `useTierKinds().find(...)`.
