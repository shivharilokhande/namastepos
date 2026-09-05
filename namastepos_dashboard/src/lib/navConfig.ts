// NamastePOS dashboard — the sidebar table, shared by Layout (lock icons,
// staff filtering) and App.tsx (route guards). Lives outside Layout.tsx so it
// is a plain module (react-refresh wants component files to export only
// components) and so the tables can be unit-tested without rendering.
//
// Extracted from Layout.tsx on 2026-09-05 (D-05 / D-09 / D-10 / D-14); the
// item comments below are the original history and still apply.

import {
  LayoutDashboard, Menu as MenuIcon, ShoppingCart, Receipt, BarChart3,
  Users, CreditCard, Settings, Package, Heart,
  ChefHat, LayoutGrid, QrCode, Carrot,
  ReceiptText, Truck, ClipboardCheck, CalendarPlus, Trash2 as TrashIcon,
  Bike, Globe, FileSpreadsheet, ShoppingBag,
  Activity, TrendingUp, BookOpen, Ticket, Calendar as CalIcon,
  MessageSquare, Upload, Landmark, FileText, Repeat, Zap,
  ShieldCheck, Inbox, TrendingDown, HelpCircle, Undo2,
  LifeBuoy, Gift, ArrowRightLeft, Building2,
} from 'lucide-react';

// `feature` is the plan_features key the route requires. `null` = always on
// (Starter-tier baseline). `addon` is an optional add-on slug that ALSO
// unlocks the item (OR, not AND — D-05, 2026-09-05): the backend accepts
// either the plan feature or the paid add-on for /customers
// (`requireAddon('loyalty', { orFeature: 'loyalty' })`), so the nav must
// too. Locked items still render so users see what they'd unlock —
// clicking them routes to /billing (or /marketplace when only an add-on
// could unlock it).
//
// `perm` (D-09, 2026-09-05) is the staff PERMISSION key (staffService
// PERMISSION_KEYS — a different namespace from feature keys) a non-owner
// needs to see the item. `'owner'` = business_owner only; `null` = every
// signed-in user. The owner always sees everything. The server still
// enforces (requireRole / requireStaffPerm) — this only stops a kitchen PC
// from showing Billing, Staff and Settings to every employee.
export type StaffPerm = string | 'owner' | null;
export type NavItem = {
  to: string; icon: any; label: string; feature: string | null; addon?: string; perm: StaffPerm;
};

// Founder feedback (2026-08-25): the flat sidebar had grown to 47 entries
// and was unscannable. Restructured into collapsible task-based groups
// ("Sales", "Money", ...) instead of the old plan-tier ordering — the old
// `// Pro` / `// Enterprise` / `// Always-on` section markers are gone,
// but each item's feature gate still carries its tier. Every entry, icon,
// gate, and the lock-badge behavior is unchanged; only grouping moved.
// `navTop` and `navBottom` stay ungrouped/always visible: Overview and
// Action Center are the daily landing spots, and Plans & Billing is the
// monetization surface that must never hide inside a collapsed group.
export const navTop: NavItem[] = [
  { to: '/',          icon: LayoutDashboard, label: 'Overview',         feature: null, perm: 'home' },
  { to: '/action-center', icon: Inbox,       label: 'Action Center',    feature: null, perm: 'home' },
];

export const navGroups: { name: string; items: NavItem[] }[] = [
  {
    name: 'Sales',
    items: [
      { to: '/orders',    icon: ShoppingCart,    label: 'Orders',           feature: 'orders', perm: 'orders' },
      // Delivery board (2026-09-04): the accept→hand-over lifecycle for live
      // delivery orders. Deliberately UNGATED (feature: null) — it is not the
      // `aggregators` integration and not the `driver_mode` rider fleet; a
      // Starter cafe taking its own phone/WhatsApp delivery orders needs this
      // to promise a prep time and mark the handover, so gating it would just
      // send the daily-use screen to /billing.
      { to: '/delivery',  icon: Bike,            label: 'Delivery board',   feature: null, perm: 'orders' },
      { to: '/tables',    icon: LayoutGrid,      label: 'Tables',           feature: 'tables_single_floor', perm: 'tables' },
      { to: '/kot',       icon: ChefHat,         label: 'Kitchen (KOT)',    feature: 'kds', perm: 'kds' },
      { to: '/kds',       icon: ChefHat,         label: 'KDS',              feature: 'kds', perm: 'kds' },
      // D-14 (2026-09-05): stays `captain_mode` — the registry now marks it
      // client-gated (this nav + the route guard ARE the gate; the backend
      // `/captain/` rule matches no route).
      { to: '/captain',   icon: ChefHat,         label: 'Captain',          feature: 'captain_mode', perm: 'captain' },
      { to: '/reservations', icon: CalendarPlus, label: 'Reservations',     feature: 'reservations', perm: 'reservations' },
      { to: '/reservation-widget', icon: CalIcon, label: 'Booking widget',  feature: 'reservations', perm: 'reservations' },
      { to: '/qr-codes',  icon: QrCode,          label: 'QR codes',         feature: 'qr_ordering', perm: 'qr_codes' },
    ],
  },
  {
    name: 'Catalog',
    items: [
      { to: '/menu',      icon: MenuIcon,        label: 'Menu',             feature: 'menu_basic', perm: 'menu_editor' },
      // Founder bug #16 + gap-ports (2026-08-25): every shipped feature must
      // be reachable from the sidebar (locked or not). Inventory/Printers/
      // Modifier groups are the mobile-parity ports; Marketplace existed as
      // a route but was never listed. (Printers now lives under "Team &
      // setup" and Marketplace under "Growth" per the 2026-08-25 regroup.)
      { to: '/modifier-groups', icon: MenuIcon,  label: 'Modifier groups',  feature: 'menu_variants_modifiers', perm: 'modifier_groups' },
      // D-13 (2026-09-06): was `menu_basic`, which unlocked Inventory for
      // Starter on web while the mobile tile is gated on `inventory_tracking`
      // (Pro+). Founder decision: web aligns to mobile. The registry entry now
      // lists clients ['mobile','dashboard']. Stock fields inside the menu
      // editor stay available to every plan — only this page is gated.
      { to: '/inventory', icon: Package,         label: 'Inventory',        feature: 'inventory_tracking', perm: 'menu_editor' },
      { to: '/ingredients', icon: Carrot,        label: 'Ingredients',      feature: 'recipe_costing', perm: 'menu_editor' },
      { to: '/wastage',   icon: TrashIcon,       label: 'Wastage',          feature: 'wastage', perm: 'wastage' },
    ],
  },
  {
    name: 'Money',
    items: [
      { to: '/reports',   icon: BarChart3,       label: 'Reports',          feature: 'reports_basic', perm: 'reports' },
      { to: '/leakage',   icon: TrendingDown,    label: 'Revenue leakage',  feature: 'reports_basic', perm: 'reports' },
      { to: '/invoices',  icon: ReceiptText,     label: 'Tax invoices',     feature: 'invoice_basic', perm: 'tax_invoices' },
      { to: '/refunds',   icon: Undo2,           label: 'Refunds',          feature: 'orders', perm: 'orders' },
      { to: '/expenses',  icon: Receipt,         label: 'Expenses',         feature: 'expenses', perm: 'expenses' },
      { to: '/daily-closing', icon: ClipboardCheck, label: 'Daily closing', feature: 'daily_closing', perm: 'daily_closing' },
      { to: '/accounting', icon: FileSpreadsheet, label: 'Accounting',      feature: 'accounting_pnl_bs', perm: 'pnl_statement' },
      { to: '/accounting-reports', icon: BookOpen, label: 'P&L reports',    feature: 'accounting_pnl_bs', perm: 'pnl_statement' },
      { to: '/bank-reconcile', icon: Landmark,   label: 'Bank reconcile',   feature: 'bank_reconcile', perm: 'owner' },
      { to: '/recurring-invoices', icon: Repeat, label: 'Recurring inv',    feature: 'recurring_invoices', perm: 'owner' },
      { to: '/b2b-invoice-template', icon: FileText, label: 'B2B template', feature: 'b2b_invoice', perm: 'owner' },
      { to: '/surge',     icon: Zap,             label: 'Surge pricing',    feature: 'surge_pricing', perm: 'surge' },
    ],
  },
  {
    name: 'Customers',
    items: [
      // D-05 (2026-09-05): the backend customer routes accept EITHER the
      // plan feature `loyalty` (Growth and up) OR the paid Loyalty add-on
      // (`requireAddon('loyalty', { orFeature: 'loyalty' })`, 2026-09-03).
      // The nav used to demand the add-on alone, so every Growth/Pro/
      // Advanced/Enterprise owner saw Customers locked and was sent to the
      // marketplace to buy something their plan already includes. Now
      // `feature` OR `addon` unlocks it.
      { to: '/customers',   icon: Heart,           label: 'Customers',        feature: 'loyalty', addon: 'loyalty', perm: 'customers' },
      // Sync-fix (2026-08-22): were both gated on `customers_basic`, which
      // meant Starter plans (which include customers_basic) saw them
      // unlocked and got a 402 on click because backend middleware gates
      // /memberships on `memberships` and /reviews on `reviews`. Aligned.
      // D-05: `/memberships` is gated server-side on `memberships` ONLY (no
      // add-on check in growth.routes.js) — the add-on requirement is gone.
      { to: '/memberships', icon: Heart,           label: 'Memberships',      feature: 'memberships', perm: 'customers' },
      { to: '/reviews',     icon: MessageSquare,   label: 'Reviews',          feature: 'reviews', perm: 'customers' },
      // D-14: coupons stay under `loyalty` (product decision with backend,
      // 2026-09-05) even though /food-coupons has no server rule yet.
      { to: '/food-coupons', icon: Ticket,       label: 'Coupons',          feature: 'loyalty', perm: 'customers' },
      { to: '/campaigns', icon: MessageSquare,   label: 'Campaigns',        feature: 'whatsapp_marketing', perm: 'whatsapp_marketing' },
    ],
  },
  {
    name: 'Growth',
    items: [
      // D-14 (2026-09-05): was gated on `qr_ordering`, which the page never
      // uses — it edits the brand site (/site, ungated server-side). A lock
      // the API does not enforce is a lie, so it is always-on now.
      { to: '/online-site', icon: Globe,         label: 'Online site',      feature: null, perm: 'owner' },
      { to: '/marketplace', icon: ShoppingBag,   label: 'Marketplace',      feature: null, perm: 'owner' },
      { to: '/aggregators', icon: Truck,         label: 'Aggregators',      feature: 'aggregators', perm: 'aggregators' },
      // Delivery/driver is Enterprise-only per Sprint 12 brainstorm — most
      // small cafes rely on Zomato/Swiggy for delivery, so exposing this on
      // lower tiers just clutters the sidebar. The feature_key gate makes
      // it lock-visible on Pro/Advanced and unlocked on Enterprise.
      // Sync-fix: was `multi_outlet` (Enterprise-only) — but backend
      // middleware and mobile drawer both gate this on `driver_mode` (Pro).
      // Pro owners were seeing this locked despite being entitled.
      { to: '/drivers',   icon: Bike,            label: 'In-house delivery', feature: 'driver_mode', perm: 'driver' },
      { to: '/forecast',   icon: TrendingUp,     label: 'Forecast',         feature: 'forecast', perm: 'reports' },
      { to: '/heat-map',   icon: Activity,       label: 'Heat map',         feature: 'heat_map', perm: 'reports' },
      { to: '/retail',     icon: ShoppingBag,    label: 'Retail',           feature: 'multi_outlet', perm: 'owner' },
    ],
  },
  {
    name: 'Team & setup',
    items: [
      // Outlets (2026-09-03): manage/switch outlets + the consolidated group
      // rollup. Gated on `multi_outlet` exactly like the backend's
      // /outlet-groups router (only its /my-outlets feed is exempt, which is
      // what powers the always-visible switcher above the nav).
      { to: '/outlets',   icon: Building2,       label: 'Outlets',          feature: 'multi_outlet', perm: 'owner' },
      { to: '/staff',     icon: Users,           label: 'Staff',            feature: 'staff_lite', perm: 'owner' },
      { to: '/printers',  icon: ReceiptText,     label: 'Printers',         feature: null, perm: 'thermal_printer' },
      { to: '/bill-template', icon: ReceiptText, label: 'Receipt template', feature: null, perm: 'bill_template' },
      // Gate change (2026-08-25): was `bulk_import` — a parallel backend
      // change made bulk imports available on ALL plans, so the sidebar
      // must not show a lock the API no longer enforces. `null` = always on.
      { to: '/bulk-import', icon: Upload,        label: 'Bulk import',      feature: null, perm: 'menu_editor' },
      // Migration wizard (2026-09-03): step-by-step "bring your data from
      // your old POS" flow. Ungated — switchers migrate before picking a
      // plan, so this must be visible to every tenant.
      { to: '/migrate',   icon: ArrowRightLeft,  label: 'Switch to NamastePOS', feature: null, perm: 'owner' },
      // DPDP: always-on entry point — every user must be able to reach
      // their privacy controls in at most one click. Cannot be plan-gated
      // or role-gated.
      { to: '/privacy',   icon: ShieldCheck,     label: 'Privacy',          feature: null, perm: null },
      { to: '/settings',  icon: Settings,        label: 'Settings',         feature: null, perm: 'owner' },
      { to: '/help',      icon: HelpCircle,      label: 'Help',             feature: null, perm: null },
    ],
  },
];

export const navBottom: NavItem[] = [
  { to: '/billing',   icon: CreditCard,      label: 'Plans & Billing',  feature: null, perm: 'owner' },
  { to: '/refer',     icon: Gift,            label: 'Refer & earn',     feature: null, perm: 'owner' },
  { to: '/support',   icon: LifeBuoy,        label: 'Support',          feature: null, perm: null },
];

export const allNavItems: NavItem[] = [...navTop, ...navGroups.flatMap((g) => g.items), ...navBottom];

/**
 * The plan feature key a route requires, or null when the route is always-on
 * or can ALSO be unlocked by an add-on (those pages handle their own 402).
 * App.tsx's route guards read this so nav lock === route guard by
 * construction — one table, no second list to drift (D-10, 2026-09-05).
 */
export function featureForRoute(path: string): string | null {
  const item = allNavItems.find((it) => it.to === path);
  if (!item || !item.feature || item.addon) return null;
  return item.feature;
}

/**
 * D-09 (2026-09-05): can this user see a nav item? Owner: always. Staff:
 * only when the item is open to all (`perm: null`) or its permission key is
 * in the effective list from /auth/me. Unknown role (still loading, or a
 * value we do not recognise) → least privilege.
 */
export function canSeeNavItem(
  item: Pick<NavItem, 'perm'>, role: string | null, permissions: string[] | null,
): boolean {
  if (role === 'business_owner') return true;
  if (item.perm === null) return true;
  if (!role) return false;
  if (item.perm === 'owner') return false;
  return Array.isArray(permissions) && permissions.includes(item.perm);
}
