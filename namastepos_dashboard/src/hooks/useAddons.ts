// NamastePOS dashboard — active add-ons for the current business.
//
// Mirrors usePlan but for the addon dimension. Backend endpoint
// /businesses/:bid/addons returns { active: [...], history: [...] }
// where each item in `active` has an `addon.slug` (e.g. 'loyalty').
//
// Consumers:
//   const { has, isLoading } = useAddons();
//   if (!has('loyalty')) return <Locked />;
//
// We refetch on window focus + every 60s so cancel/resume from the
// admin or marketplace surfaces propagate without a hard reload.

import { useQuery } from '@tanstack/react-query';
import { ffApi } from '@/api/namastepos';

type ActiveAddon = { addon: { slug: string } } & Record<string, unknown>;

export interface AddonState {
  slugs: string[];
  has: (slug: string) => boolean;
  isLoading: boolean;
}

export function useAddons(): AddonState {
  const { data, isLoading } = useQuery({
    queryKey: ['my-addons'],
    queryFn: () => ffApi.myAddons() as Promise<{ active: ActiveAddon[] }>,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const slugs = (data?.active || []).map((a) => a.addon?.slug).filter(Boolean) as string[];
  const set = new Set(slugs);
  return {
    slugs,
    has: (slug: string) => set.has(slug),
    isLoading,
  };
}
