import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ffApi } from '@/api/namastepos';
import {
  LogOut, Utensils, Menu as Hamburger, X, MessageSquare, ChevronDown, Lock,
} from 'lucide-react';
import { Button } from './ui/button';
import { ImpersonationBanner } from './ImpersonationBanner';
import { PlanLimitBanner } from './PlanLimitBanner';
import { OutletSwitcher } from './OutletSwitcher';
import { api, setSession, setBusinessCache, getBusinessCache, NAVIGATE_EVENT } from '@/api/client';
import { cn } from '@/lib/utils';
import { usePlan, useMe } from '@/hooks/usePlan';
import { useAddons } from '@/hooks/useAddons';
import {
  navTop, navGroups, navBottom, allNavItems, canSeeNavItem, type NavItem,
} from '@/lib/navConfig';

export function Layout() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const business = getBusinessCache();
  // QA P1 (Suresh #1): sidebar was `hidden md:flex` with no mobile fallback,
  // leaving phone-only owners with no way to navigate. Now there's a top
  // bar + hamburger that opens a slide-in drawer on <md.
  const [mobileOpen, setMobileOpen] = useState(false);

  // FF-217: on cold-start, if the business hasn't finished onboarding
  // yet, push them into the wizard. `me` is cached by usePlan/useAddons
  // so this is a piggy-back read.
  //
  // FF-217c: an existing business (menu + tables already in DB) may
  // still have `onboarded=false` from before the flag was tracked.
  // Migration 043 backfills these, but for good measure the client
  // also checks: if the account has ANY menu items OR tables, flip
  // the flag silently and skip the wizard — we never want to shove
  // a real cafe with data through a "create your first table" flow.
  // D-19 (2026-09-05): shares the single ['me'] query with usePlan() —
  // previously this was a second, identical /auth/me under its own key.
  const meQ = useMe();
  useEffect(() => {
    const biz = meQ.data?.business;
    if (!biz || biz.onboarded !== false) return;
    (async () => {
      try {
        const [menu, tables] = await Promise.all([
          ffApi.listMenu().catch(() => []),
          ffApi.listOpsTables().catch(() => []),
        ]);
        if ((menu?.length ?? 0) > 0 || (tables?.length ?? 0) > 0) {
          // Already has data — silently mark onboarded and stay put.
          await ffApi.patchMe({ onboarded: true });
          queryClient.invalidateQueries({ queryKey: ['me'] });
          return;
        }
        navigate('/onboarding', { replace: true });
      } catch {
        navigate('/onboarding', { replace: true });
      }
    })();
  }, [meQ.data, navigate, queryClient]);

  const logout = async () => {
    // Auth fix (2026-08-30): revoke the server-side refresh token + clear the
    // httpOnly ff_refresh cookie BEFORE wiping local state. Previously logout
    // only cleared localStorage, so the refresh cookie survived — the browser
    // kept minting fresh access tokens via /auth/refresh and the next person on
    // a shared counter/kitchen PC could resurrect the prior user's session.
    // Must run while the Bearer header is still attached (before setSession).
    try { await api.post('/auth/logout'); } catch { /* best-effort */ }
    setSession(null, null);
    setBusinessCache(null);
    // Privacy fix: previously the TanStack Query cache survived logout, so the
    // NEXT user on the same browser would briefly see the PREVIOUS owner's
    // cached menu/orders/staff for up to 60s (staleTime). Clear it explicitly.
    queryClient.clear();
    navigate('/login');
  };

  const plan = usePlan();
  const addons = useAddons();

  // "View plans" action on the global FEATURE_LOCKED toast (api/client.ts
  // has no router). Claim the event so the fallback full-page navigation
  // does not fire.
  useEffect(() => {
    const onNav = (e: Event) => {
      const path = (e as CustomEvent<{ path?: string }>).detail?.path;
      if (!path) return;
      e.preventDefault();
      navigate(path);
    };
    window.addEventListener(NAVIGATE_EVENT, onNav);
    return () => window.removeEventListener(NAVIGATE_EVENT, onNav);
  }, [navigate]);

  // D-09: a staffer who deep-links (or lands after login) on a page their
  // permissions do not cover is sent to their first visible nav item instead
  // of a page of 403 toasts. Owner is never redirected. Only routes that are
  // nav items are considered; unknown paths are left to their own page.
  const location = useLocation();
  useEffect(() => {
    if (plan.isLoading || !plan.role || plan.role === 'business_owner') return;
    const current = allNavItems.find((it) => it.to !== '/' && (location.pathname === it.to || location.pathname.startsWith(it.to + '/')))
      || (location.pathname === '/' ? navTop[0] : undefined);
    if (!current || canSeeNavItem(current, plan.role, plan.permissions)) return;
    const first = allNavItems.find((it) => canSeeNavItem(it, plan.role, plan.permissions));
    if (first && first.to !== location.pathname) navigate(first.to, { replace: true });
  }, [plan.isLoading, plan.role, plan.permissions, location.pathname, navigate]);

  // Sidebar regroup (2026-08-25): per-group expand/collapse, persisted per
  // group (key `np_nav_group_<name>`) so an owner's preferred layout
  // survives reloads. A MISSING key means expanded — existing users see
  // everything until they deliberately collapse, and new groups default open.
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const g of navGroups) init[g.name] = localStorage.getItem(`np_nav_group_${g.name}`) !== '0';
    return init;
  });
  const toggleGroup = (name: string) => {
    setOpenGroups((prev) => {
      const next = !prev[name];
      // '1'/'0' instead of JSON — readable in devtools and can't throw on parse.
      localStorage.setItem(`np_nav_group_${name}`, next ? '1' : '0');
      return { ...prev, [name]: next };
    });
  };
  // Auto-expand the group that owns the current route so a deep link or
  // in-app redirect never lands with the active item hidden in a collapsed
  // group. Transient by design — does NOT overwrite the persisted
  // preference, so the group re-collapses on next visit elsewhere.
  useEffect(() => {
    const active = navGroups.find((g) =>
      g.items.some((it) => location.pathname === it.to || location.pathname.startsWith(it.to + '/'))
    );
    if (!active) return;
    setOpenGroups((prev) => (prev[active.name] ? prev : { ...prev, [active.name]: true }));
  }, [location.pathname]);

  // Push 13.6 — Relaxed the Pro-only dashboard gate. Earlier this returned
  // a full-screen takeover for any Starter user, which felt punishing
  // (they couldn't even see what they had bought). Now Starter users get
  // the normal layout; the sidebar's per-item lock icons + the upgrade
  // banner already steer them toward /billing for paid features. Match
  // the mobile drawer UX where locked tiles show a PRO badge but the
  // unlocked ones (Overview, Menu, Orders, Tables, etc.) are usable.

  // Shared item renderer (2026-08-25): extracted from the old flat
  // `nav.map` UNCHANGED so lock behavior stays identical. Used by the
  // ungrouped top/bottom entries and every group body — and since both
  // the desktop sidebar and the mobile drawer render the same
  // `sidebarBody`, the drawer gets grouping + locks for free.
  const renderNavItem = (item: NavItem) => {
    // D-09: staff only see what their permissions cover (owner sees all).
    if (!canSeeNavItem(item, plan.role, plan.permissions)) return null;
    const featureOk = item.feature === null || plan.has(item.feature);
    // D-05: an add-on is an ALTERNATIVE unlock, not an extra requirement.
    // While the add-on list is still loading we optimistically treat
    // add-on-capable items as unlocked (existing-subscriber case) so the
    // sidebar doesn't briefly flash a lock icon.
    const addonOk = !!item.addon && (addons.isLoading || addons.has(item.addon));
    // D-15: before /auth/me has answered we do not know the plan, so we draw
    // NO lock badge and link to the real route — RequireFeature holds the
    // page behind a spinner and decides once the plan is known. (The whole
    // nav is a skeleton while the first load is in flight; this covers the
    // plan===null case where the server could not compute a summary.)
    const unlocked = !plan.loaded || featureOk || addonOk;
    // Feature-locked clicks go to /billing (upgrade the plan). Only when the
    // plan cannot unlock it at all — i.e. the item is add-on-only — do we
    // send them to /marketplace.
    const lockedTarget = item.feature ? '/billing' : '/marketplace';
    return (
      <NavLink
        key={item.to}
        to={unlocked ? item.to : lockedTarget}
        end={item.to === '/'}
        onClick={() => setMobileOpen(false)}
        className={({ isActive }) =>
          cn(
            'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
            isActive && unlocked
              ? 'bg-primary text-primary-foreground'
              : unlocked
                ? 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                : 'text-muted-foreground/60 hover:bg-accent hover:text-accent-foreground'
          )
        }
      >
        <item.icon className="h-4 w-4" />
        <span className="flex-1">{item.label}</span>
        {!unlocked && <Lock className="h-3 w-3 opacity-60" />}
      </NavLink>
    );
  };

  const sidebarBody = (
    <>
      <div className="flex items-center gap-2 px-3 mb-2">
        <div className="grid h-9 w-9 place-items-center rounded-lg bg-primary text-primary-foreground">
          <Utensils className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-bold leading-tight truncate">{business?.name || 'NamastePOS'}</div>
          <div className="text-xs text-muted-foreground truncate">{business?.email}</div>
        </div>
      </div>
      {/* Outlet switcher (2026-09-03) — founder's explicit placement: top-left,
          directly BELOW the business name. Renders for every tenant (the
          my-outlets feed is ungated); single-outlet owners get the one row
          plus "+ Create new outlet", which upsells on a 402 FEATURE_LOCKED. */}
      <OutletSwitcher onNavigate={() => setMobileOpen(false)} />
      {/* Plan badge — tap to upgrade. Owner-only (Billing is owner-only,
          D-09) and only once the plan is actually known (D-15). */}
      {plan.loaded && plan.role === 'business_owner' && (
      <NavLink
        to="/billing"
        onClick={() => setMobileOpen(false)}
        className="mx-3 mb-4 mt-1 flex items-center justify-between rounded-md border border-primary/30 bg-primary/5 px-2 py-1.5 text-xs hover:bg-primary/10"
      >
        <span className="flex items-center gap-1.5">
          <span className="rounded bg-primary px-1.5 py-0.5 text-[10px] font-black uppercase tracking-wider text-primary-foreground">
            {/* Owner-facing label, not the raw kind: 'pro_plan' would read
                as gibberish and 'pro' would read as the Pro plan when it is
                actually Growth. See @/lib/planTiers. */}
            {plan.tierLabel || plan.tierKind}
          </span>
          {plan.isStarter && <span className="text-muted-foreground">→ upgrade</span>}
        </span>
        {!plan.isEnterprise && <span className="text-primary font-semibold">View plans</span>}
      </NavLink>
      )}
      {/* D-15 (2026-09-05): no nav until /auth/me has answered. Rendering
          items before the plan + role are known would either flash lock
          icons (fail-open default) or show a staffer the owner's sidebar for
          a beat. A short skeleton is the honest state. */}
      {plan.isLoading ? (
        <nav className="flex-1 space-y-2 px-3 pt-2" aria-busy="true" aria-label="Loading navigation">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="h-7 rounded-md bg-muted animate-pulse" style={{ width: `${70 + ((i * 13) % 30)}%` }} />
          ))}
        </nav>
      ) : (
      <nav className="flex-1 space-y-1">
        {navTop.map(renderNavItem)}
        {navGroups.filter((group) => group.items.some((it) => canSeeNavItem(it, plan.role, plan.permissions))).map((group) => (
          <div key={group.name}>
            {/* Group header (2026-08-25): small uppercase muted text per the
                founder's spec; ChevronDown rotates -90° when collapsed so
                the state is visible at a glance. */}
            <button
              type="button"
              onClick={() => toggleGroup(group.name)}
              className="flex w-full items-center justify-between rounded-md px-3 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
              aria-expanded={openGroups[group.name]}
            >
              <span>{group.name}</span>
              <ChevronDown
                className={cn('h-3.5 w-3.5 transition-transform', !openGroups[group.name] && '-rotate-90')}
              />
            </button>
            {openGroups[group.name] && group.items.map(renderNavItem)}
          </div>
        ))}
        {navBottom.map(renderNavItem)}
      </nav>
      )}
      {/* FF-221 — WhatsApp support link. Hardcode-audit fix (2026-08-24):
          number now comes from VITE_SUPPORT_WHATSAPP (digits incl. country
          code, e.g. 91XXXXXXXXXX) instead of a personal number in source.
          Link is hidden when unset. */}
      {import.meta.env.VITE_SUPPORT_WHATSAPP && (
        <a
          href={`https://wa.me/${import.meta.env.VITE_SUPPORT_WHATSAPP}?text=Hi%20NamastePOS%20%E2%80%94%20I%20need%20help.`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => setMobileOpen(false)}
          className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-[#25D366] hover:bg-[#25D366]/10"
        >
          <MessageSquare className="h-4 w-4" />
          <span>Chat with support</span>
        </a>
      )}
      <Button variant="ghost" size="sm" className="justify-start" onClick={logout}>
        <LogOut className="mr-2 h-4 w-4" /> Sign out
      </Button>
    </>
  );

  return (
    <div className="min-h-screen">
      <ImpersonationBanner />

      {/* Mobile top bar */}
      <div className="md:hidden flex items-center justify-between border-b bg-card px-3 py-2">
        <button
          onClick={() => setMobileOpen(true)}
          className="grid h-9 w-9 place-items-center rounded-md hover:bg-accent"
          aria-label="Open menu"
        >
          <Hamburger className="h-5 w-5" />
        </button>
        <div className="font-bold truncate">{business?.name || 'NamastePOS'}</div>
        <div className="w-9" />
      </div>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <aside className="absolute left-0 top-0 bottom-0 w-72 bg-card px-3 py-5 flex flex-col shadow-xl">
            <button
              onClick={() => setMobileOpen(false)}
              className="self-end grid h-9 w-9 place-items-center rounded-md hover:bg-accent mb-2"
              aria-label="Close menu"
            >
              <X className="h-5 w-5" />
            </button>
            {sidebarBody}
          </aside>
        </div>
      )}

      <div className="flex">
        <aside className="hidden md:flex md:w-60 flex-col border-r bg-card px-3 py-5">
          {sidebarBody}
        </aside>
        <main className="flex-1 overflow-auto bg-muted/30">
          <div className="container mx-auto py-6 max-w-7xl px-3 md:px-6">
            {/* 2026-09-04 — plan-limit + past-due grace warnings. Mounted at
                the layout level, not on Billing, because the owner about to
                hit an order cap has no reason to open the Billing page. At
                100% of a cap the banner has no dismiss control by design. */}
            <PlanLimitBanner />
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}

// Push 13.6 — DashboardLockedTakeover removed. Was rendering a full-screen
// upgrade card whenever a Starter user opened the dashboard. We now let
// them in and rely on the sidebar's per-item lock icons + the upgrade
// banner above the nav to steer them to /billing for paid features.
