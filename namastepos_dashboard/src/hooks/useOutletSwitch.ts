// NamastePOS dashboard — outlet list + outlet switching (2026-09-03).
//
// A "switch" trades the active session for one scoped to another business
// (outlet) the same user is a member of. The server re-verifies the
// business_users row, so a session for outlet A can never be traded for
// outlet B without a live membership.
//
// Everything the user sees afterwards is that outlet's own data because
// every request is scoped by the NEW token's business id (and by
// getBusinessCache().id in the /businesses/:bid URLs). The two things that
// must therefore happen atomically with the token swap are:
//   1. setBusinessCache(newBusiness)  — before anything can refetch, or a
//      refetch would build /businesses/<OLD id> URLs with the new token.
//   2. queryClient.clear()            — the guarantee that not one row of
//      the previous outlet's menu/orders/staff survives in the cache.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import axios from 'axios';
import { ffApi, type MyOutlet } from '@/api/namastepos';
import {
  apiError, getBusinessCache, setBusinessCache, setSession,
  clearBusinessScopedStorage,
} from '@/api/client';

export const MY_OUTLETS_KEY = ['my-outlets'] as const;

export function useMyOutlets() {
  return useQuery({
    queryKey: MY_OUTLETS_KEY,
    queryFn: () => ffApi.myOutlets(),
    staleTime: 60_000,
  });
}

/**
 * True when `err` is the backend's 402 FEATURE_LOCKED envelope
 * ({ error, feature, currentTier, requiredTier, upgradeUrl }) — i.e. the
 * plan/addon doesn't include multi-outlet, so we show the upsell instead
 * of a generic red toast.
 */
export function featureLockedInfo(err: unknown): { feature?: string; requiredTier?: string } | null {
  if (!axios.isAxiosError(err)) return null;
  const data = err.response?.data as any;
  if (err.response?.status !== 402 || data?.error !== 'FEATURE_LOCKED') return null;
  return { feature: data.feature, requiredTier: data.requiredTier };
}

export function useOutletSwitch() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (outlet: Pick<MyOutlet, 'businessId' | 'name' | 'outletLabel'>) => {
      // Capture BEFORE the cache is re-keyed — used to purge any storage
      // key that embeds the outgoing business id.
      const prevBusinessId = getBusinessCache()?.id ?? null;
      const res = await ffApi.switchBusiness(outlet.businessId);
      // Access token is in-memory only (client.ts L-1); the refresh token
      // rides the httpOnly `ff_refresh` cookie the server just reset. Same
      // persistence path LoginPage.finish() uses.
      setSession(res.token, res.refreshToken ?? null);
      clearBusinessScopedStorage(prevBusinessId);
      setBusinessCache(res.business);
      queryClient.clear();
      return { res, outlet };
    },
    onSuccess: ({ outlet }) => {
      // Belt-and-braces: clear() already dropped these entries, so mounted
      // usePlan()/useAddons()/me observers refetch as they re-subscribe.
      // Invalidating explicitly keeps that true if clear() ever narrows.
      queryClient.invalidateQueries({ queryKey: ['me'] });
      queryClient.invalidateQueries({ queryKey: ['my-addons'] });
      queryClient.invalidateQueries({ queryKey: MY_OUTLETS_KEY });
      toast.success(`Switched to ${outlet.outletLabel || outlet.name}`);
      navigate('/');
    },
    onError: (err) => toast.error(apiError(err)),
  });
}
