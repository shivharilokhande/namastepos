// NamastePOS admin — client-side RBAC mirror + `useCan()` hook (F-10, 2026-09-06).
//
// The backend (src/middleware/adminRbac.js) is the ONLY authority: every route
// re-checks the live role and 403s. This module exists so the console does not
// SHOW an action a role cannot take — before it, a `finance` or `support` admin
// saw Edit/Delete plan, Add override, Attach addon… and got a 403 toast.
//
// `GET /admin/auth/me` returns the admin row only (no permission list — see
// adminTeamService.me → serialize). So permissions are DERIVED from the role
// via the mirror below. If the backend ever adds `admin.permissions`, `useCan`
// prefers that array automatically and the mirror becomes a fallback.
//
// 2026-09-06: the mirror that used to live in Layout.tsx had drifted — `sales`
// lacked `coupons.write`, which the backend grants. Kept here, in ONE place, so
// the nav and the page-level buttons cannot disagree with each other again.
// Keep in sync with adminRbac.js PERMISSIONS.

import { useQuery } from '@tanstack/react-query';
import { adminApi, Admin } from '@/api/admin';

export const ROLE_PERMS: Record<string, string[]> = {
  super_admin: ['*'],
  finance: [
    'revenue.read', 'revenue.write',
    'refunds.read', 'refunds.write',
    'gst.read', 'gst.write',
    'invoices.read', 'invoices.write',
    'customers.read', 'plans.read', 'coupons.read',
    'audit.read', 'reports.read', 'settings.read',
    'compliance.read',
  ],
  support: [
    'customers.read', 'customers.write', 'customers.impersonate',
    'notes.read', 'notes.write',
    'staff.read', 'menu.read', 'orders.read',
    'reports.read', 'audit.read',
    'plans.read', 'coupons.read', 'invoices.read', 'refunds.read', 'gst.read',
    'compliance.read', 'compliance.write',
  ],
  sales: [
    'customers.read', 'customers.write',
    'plans.read', 'plans.change',
    'coupons.read', 'coupons.write',
    'reports.read',
  ],
};

/** Pure check against the mirror (or an explicit permission list). */
export function roleCan(role: string | undefined | null, need?: string, explicit?: string[] | null): boolean {
  if (!need) return true;            // ungated
  if (explicit && explicit.length) return explicit.includes('*') || explicit.includes(need);
  if (!role) return false;           // no session yet → hide, never flash a button that 403s
  const g = ROLE_PERMS[role] || [];
  return g.includes('*') || g.includes(need);
}

export const ME_QUERY_KEY = ['admin-me'] as const;

/**
 * The signed-in admin + a `can(perm)` predicate. Shared react-query cache so
 * the Layout nav and every page read ONE /auth/me call.
 *   const { can } = useCan();  {can('plans.change') && <Button>Edit</Button>}
 */
export function useCan() {
  const q = useQuery<Admin>({
    queryKey: ME_QUERY_KEY,
    queryFn: adminApi.me,
    staleTime: 60_000,
    retry: 1,
  });
  const me = q.data ?? null;
  const explicit = (me as (Admin & { permissions?: string[] }) | null)?.permissions ?? null;
  return {
    me,
    isLoading: q.isLoading,
    isError: q.isError,
    error: q.error,
    refetch: q.refetch,
    isSuperAdmin: me?.role === 'super_admin',
    can: (need?: string) => roleCan(me?.role, need, explicit),
  };
}
