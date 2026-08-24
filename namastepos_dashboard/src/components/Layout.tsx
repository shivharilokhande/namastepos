import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ffApi } from '@/api/namastepos';
import {
  LayoutDashboard, Menu as MenuIcon, ShoppingCart, Receipt, BarChart3,
  Users, CreditCard, Settings, LogOut, Utensils, Package, Heart,
  ChefHat, LayoutGrid, QrCode, Carrot, Menu as Hamburger, X,
  ReceiptText, Truck, ClipboardCheck, CalendarPlus, Trash2 as TrashIcon,
  Bike, Crown, Globe, FileSpreadsheet, ShoppingBag,
  Activity, TrendingUp, Star, BookOpen, Ticket, Calendar as CalIcon,
  MessageSquare, Upload, Landmark, FileText, Repeat, Zap,
  ShieldCheck, Inbox, TrendingDown, HelpCircle, Undo2,
} from 'lucide-react';
import { Button } from './ui/button';
import { ImpersonationBanner } from './ImpersonationBanner';
import { setSession, setBusinessCache, getBusinessCache } from '@/api/client';
import { cn } from '@/lib/utils';
import { usePlan } from '@/hooks/usePlan';
import { useAddons } from '@/hooks/useAddons';
import { Lock } from 'lucide-react';

// `feature` is the plan_features key the route requires. `null` = always on
// (Starter-tier baseline). `addon` is an optional add-on slug that must
// also be active for the item to unlock — used for sections like
// /customers that are gated by the Loyalty & Cashback addon. Locked
// items still render so users see what they'd unlock — clicking them
// routes to /billing (or /marketplace for addon-gated entries).
const nav: { to: string; icon: any; label: string; feature: string | null; addon?: string }[] = [
  { to: '/',          icon: LayoutDashboard, label: 'Overview',         feature: null },
  { to: '/action-center', icon: Inbox,       label: 'Action Center',    feature: null },
  { to: '/menu',      icon: MenuIcon,        label: 'Menu',             feature: 'menu_basic' },
  { to: '/orders',    icon: ShoppingCart,    label: 'Orders',           feature: 'orders' },
  { to: '/tables',    icon: LayoutGrid,      label: 'Tables',           feature: 'tables_single_floor' },
  { to: '/expenses',  icon: Receipt,         label: 'Expenses',         feature: 'expenses' },
  { to: '/reports',   icon: BarChart3,       label: 'Reports',          feature: 'reports_basic' },
  { to: '/leakage',   icon: TrendingDown,    label: 'Revenue leakage',  feature: 'reports_basic' },
  { to: '/invoices',  icon: ReceiptText,     label: 'Tax invoices',     feature: 'invoice_basic' },
  { to: '/refunds',   icon: Undo2,           label: 'Refunds',          feature: 'orders' },
  { to: '/customers',   icon: Heart,           label: 'Customers',        feature: 'customers_basic', addon: 'loyalty' },
  // Sync-fix (2026-08-22): were both gated on `customers_basic`, which
  // meant Starter plans (which include customers_basic) saw them
  // unlocked and got a 402 on click because backend middleware gates
  // /memberships on `memberships` and /reviews on `reviews`. Aligned.
  { to: '/memberships', icon: Heart,           label: 'Memberships',      feature: 'memberships', addon: 'loyalty' },
  { to: '/reviews',     icon: MessageSquare,   label: 'Reviews',          feature: 'reviews' },
  { to: '/staff',     icon: Users,           label: 'Staff',            feature: 'staff_lite' },
  { to: '/bill-template', icon: ReceiptText, label: 'Receipt template', feature: null },
  // Pro
  { to: '/kot',       icon: ChefHat,         label: 'Kitchen (KOT)',    feature: 'kds' },
  { to: '/kds',       icon: ChefHat,         label: 'KDS',              feature: 'kds' },
  { to: '/captain',   icon: ChefHat,         label: 'Captain',          feature: 'captain_mode' },
  { to: '/qr-codes',  icon: QrCode,          label: 'QR codes',         feature: 'qr_ordering' },
  { to: '/ingredients', icon: Carrot,        label: 'Ingredients',      feature: 'recipe_costing' },
  { to: '/reservations', icon: CalendarPlus, label: 'Reservations',     feature: 'reservations' },
  // Delivery/driver is Enterprise-only per Sprint 12 brainstorm — most
  // small cafes rely on Zomato/Swiggy for delivery, so exposing this on
  // lower tiers just clutters the sidebar. The feature_key gate makes
  // it lock-visible on Pro/Advanced and unlocked on Enterprise.
  // Sync-fix: was `multi_outlet` (Enterprise-only) — but backend
  // middleware and mobile drawer both gate this on `driver_mode` (Pro).
  // Pro owners were seeing this locked despite being entitled.
  { to: '/drivers',   icon: Bike,            label: 'In-house delivery', feature: 'driver_mode' },
  { to: '/wastage',   icon: TrashIcon,       label: 'Wastage',          feature: 'wastage' },
  { to: '/daily-closing', icon: ClipboardCheck, label: 'Daily closing', feature: 'daily_closing' },
  { to: '/aggregators', icon: Truck,         label: 'Aggregators',      feature: 'aggregators' },
  { to: '/online-site', icon: Globe,         label: 'Online site',      feature: 'qr_ordering' },
  { to: '/food-coupons', icon: Ticket,       label: 'Coupons',          feature: 'loyalty' },
  { to: '/reservation-widget', icon: CalIcon, label: 'Booking widget',  feature: 'reservations' },
  { to: '/campaigns', icon: MessageSquare,   label: 'Campaigns',        feature: 'whatsapp_marketing' },
  // Enterprise
  { to: '/accounting', icon: FileSpreadsheet, label: 'Accounting',      feature: 'accounting_pnl_bs' },
  { to: '/retail',     icon: ShoppingBag,    label: 'Retail',           feature: 'multi_outlet' },
  { to: '/heat-map',   icon: Activity,       label: 'Heat map',         feature: 'heat_map' },
  { to: '/forecast',   icon: TrendingUp,     label: 'Forecast',         feature: 'forecast' },
  { to: '/accounting-reports', icon: BookOpen, label: 'P&L reports',    feature: 'accounting_pnl_bs' },
  { to: '/bulk-import', icon: Upload,        label: 'Bulk import',      feature: 'bulk_import' },
  { to: '/bank-reconcile', icon: Landmark,   label: 'Bank reconcile',   feature: 'bank_reconcile' },
  { to: '/b2b-invoice-template', icon: FileText, label: 'B2B template', feature: 'b2b_invoice' },
  { to: '/recurring-invoices', icon: Repeat, label: 'Recurring inv',    feature: 'recurring_invoices' },
  { to: '/surge',     icon: Zap,             label: 'Surge pricing',    feature: 'surge_pricing' },
  // Always-on
  { to: '/billing',   icon: CreditCard,      label: 'Plans & Billing',  feature: null },
  { to: '/settings',  icon: Settings,        label: 'Settings',         feature: null },
  // DPDP: always-on entry point — every user must be able to reach
  // their privacy controls in at most one click. Cannot be plan-gated.
  { to: '/privacy',   icon: ShieldCheck,     label: 'Privacy',          feature: null },
  { to: '/help',      icon: HelpCircle,      label: 'Help',             feature: null },
];

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
  const meQ = useQuery({ queryKey: ['me'], queryFn: () => ffApi.me(), staleTime: 60_000 });
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

  const logout = () => {
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

  // Push 13.6 — Relaxed the Pro-only dashboard gate. Earlier this returned
  // a full-screen takeover for any Starter user, which felt punishing
  // (they couldn't even see what they had bought). Now Starter users get
  // the normal layout; the sidebar's per-item lock icons + the upgrade
  // banner already steer them toward /billing for paid features. Match
  // the mobile drawer UX where locked tiles show a PRO badge but the
  // unlocked ones (Overview, Menu, Orders, Tables, etc.) are usable.

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
      {/* Plan badge — tap to upgrade */}
      <NavLink
        to="/billing"
        onClick={() => setMobileOpen(false)}
        className="mx-3 mb-4 mt-1 flex items-center justify-between rounded-md border border-primary/30 bg-primary/5 px-2 py-1.5 text-xs hover:bg-primary/10"
      >
        <span className="flex items-center gap-1.5">
          <span className="rounded bg-primary px-1.5 py-0.5 text-[10px] font-black uppercase tracking-wider text-primary-foreground">
            {plan.tierKind}
          </span>
          {plan.isStarter && <span className="text-muted-foreground">→ upgrade</span>}
        </span>
        {!plan.isEnterprise && <span className="text-primary font-semibold">View plans</span>}
      </NavLink>
      <nav className="flex-1 space-y-1">
        {nav.map((item) => {
          const featureOk = item.feature === null || plan.has(item.feature);
          // Addon-gated items: while the addon list is loading we
          // optimistically treat them as unlocked (existing-subscriber
          // case) so the sidebar doesn't briefly flash a lock icon.
          const addonOk = !item.addon || addons.isLoading || addons.has(item.addon);
          const unlocked = featureOk && addonOk;
          // Send addon-locked clicks to /marketplace (where they can
          // buy it) and feature-locked clicks to /billing (where they
          // can upgrade their plan).
          const lockedTarget = !featureOk ? '/billing' : '/marketplace';
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
        })}
      </nav>
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
