import { lazy, Suspense, useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { getToken, bootstrapAuth } from './api/client';

// Code-splitting (2026-08-25): App.tsx used to STATICALLY import ~55 page
// components, so Vite bundled every page — Reports/HeatMap/Forecast (recharts),
// Accounting, etc. — into one ~1.3 MB main chunk that even the /login screen
// had to download before rendering. The shell (Layout, auth guard, login,
// always-mounted widgets) stays EAGER so the login path is instant; every
// routed page is now React.lazy so it downloads only when its route is hit.
import { Layout } from './components/Layout';
import { featureForRoute } from './lib/navConfig';
import { RequireFeature } from './components/RequireFeature';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { CookieBanner } from './components/CookieBanner';
import { CrispChat } from './components/CrispChat';
import { FirstOrderTour } from './components/FirstOrderTour';

// Lazy page chunks. Most pages are NAMED exports (`export function XPage`),
// so React.lazy — which expects a module with a `default` — needs the
// `.then(m => ({ default: m.XPage }))` shim on each import.
const DashboardPage = lazy(() => import('./pages/DashboardPage').then(m => ({ default: m.DashboardPage })));
const MenuPage = lazy(() => import('./pages/MenuPage').then(m => ({ default: m.MenuPage })));
const OrdersPage = lazy(() => import('./pages/OrdersPage').then(m => ({ default: m.OrdersPage })));
const KotPage = lazy(() => import('./pages/KotPage').then(m => ({ default: m.KotPage })));
const TablesPage = lazy(() => import('./pages/TablesPage').then(m => ({ default: m.TablesPage })));
const QrCodesPage = lazy(() => import('./pages/QrCodesPage').then(m => ({ default: m.QrCodesPage })));
const GuestMenuPage = lazy(() => import('./pages/GuestMenuPage').then(m => ({ default: m.GuestMenuPage })));
const IngredientsPage = lazy(() => import('./pages/IngredientsPage').then(m => ({ default: m.IngredientsPage })));
const ExpensesPage = lazy(() => import('./pages/ExpensesPage').then(m => ({ default: m.ExpensesPage })));
const ReportsPage = lazy(() => import('./pages/ReportsPage').then(m => ({ default: m.ReportsPage })));
const InvoicesPage = lazy(() => import('./pages/InvoicesPage').then(m => ({ default: m.InvoicesPage })));
const StaffPage = lazy(() => import('./pages/StaffPage').then(m => ({ default: m.StaffPage })));
const CustomersPage = lazy(() => import('./pages/CustomersPage').then(m => ({ default: m.CustomersPage })));
const BillingPage = lazy(() => import('./pages/BillingPage').then(m => ({ default: m.BillingPage })));
const MarketplacePage = lazy(() => import('./pages/MarketplacePage').then(m => ({ default: m.MarketplacePage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then(m => ({ default: m.SettingsPage })));
const BillTemplatePage = lazy(() => import('./pages/BillTemplatePage').then(m => ({ default: m.BillTemplatePage })));
const AggregatorsPage = lazy(() => import('./pages/AggregatorsPage').then(m => ({ default: m.AggregatorsPage })));
const DailyClosingPage = lazy(() => import('./pages/DailyClosingPage').then(m => ({ default: m.DailyClosingPage })));
const ReservationsPage = lazy(() => import('./pages/ReservationsPage').then(m => ({ default: m.ReservationsPage })));
const WastagePage = lazy(() => import('./pages/WastagePage').then(m => ({ default: m.WastagePage })));
const DriversPage = lazy(() => import('./pages/DriversPage').then(m => ({ default: m.DriversPage })));
const DeliveryBoardPage = lazy(() => import('./pages/DeliveryBoardPage').then(m => ({ default: m.DeliveryBoardPage })));
const OnlineSitePage = lazy(() => import('./pages/OnlineSitePage').then(m => ({ default: m.OnlineSitePage })));
const AccountingPage = lazy(() => import('./pages/AccountingPage').then(m => ({ default: m.AccountingPage })));
const RetailPage = lazy(() => import('./pages/RetailPage').then(m => ({ default: m.RetailPage })));
const HeatMapPage = lazy(() => import('./pages/HeatMapPage').then(m => ({ default: m.HeatMapPage })));
const ForecastPage = lazy(() => import('./pages/ForecastPage').then(m => ({ default: m.ForecastPage })));
const KdsPage = lazy(() => import('./pages/KdsPage').then(m => ({ default: m.KdsPage })));
const AccountingReportsPage = lazy(() => import('./pages/AccountingReportsPage').then(m => ({ default: m.AccountingReportsPage })));
const PublicOrderTrackerPage = lazy(() => import('./pages/PublicOrderTrackerPage').then(m => ({ default: m.PublicOrderTrackerPage })));
const CaptainPage = lazy(() => import('./pages/CaptainPage').then(m => ({ default: m.CaptainPage })));
const CouponsPage = lazy(() => import('./pages/CouponsPage').then(m => ({ default: m.CouponsPage })));
const ReservationWidgetPage = lazy(() => import('./pages/ReservationWidgetPage').then(m => ({ default: m.ReservationWidgetPage })));
const CampaignsPage = lazy(() => import('./pages/CampaignsPage').then(m => ({ default: m.CampaignsPage })));
const BulkImportPage = lazy(() => import('./pages/BulkImportPage').then(m => ({ default: m.BulkImportPage })));
const MigrationPage = lazy(() => import('./pages/MigrationPage').then(m => ({ default: m.MigrationPage })));
const BankReconcilePage = lazy(() => import('./pages/BankReconcilePage').then(m => ({ default: m.BankReconcilePage })));
const B2BInvoiceTemplatePage = lazy(() => import('./pages/B2BInvoiceTemplatePage').then(m => ({ default: m.B2BInvoiceTemplatePage })));
const RecurringInvoicesPage = lazy(() => import('./pages/RecurringInvoicesPage').then(m => ({ default: m.RecurringInvoicesPage })));
const SurgePage = lazy(() => import('./pages/SurgePage').then(m => ({ default: m.SurgePage })));
const PrivacyPage = lazy(() => import('./pages/PrivacyPage').then(m => ({ default: m.PrivacyPage })));
const LegalPage = lazy(() => import('./pages/LegalPage').then(m => ({ default: m.LegalPage })));
const SetupWizardPage = lazy(() => import('./pages/SetupWizardPage').then(m => ({ default: m.SetupWizardPage })));
const ActionCenterPage = lazy(() => import('./pages/ActionCenterPage').then(m => ({ default: m.ActionCenterPage })));
const RevenueLeakagePage = lazy(() => import('./pages/RevenueLeakagePage').then(m => ({ default: m.RevenueLeakagePage })));
const HelpCenterPage = lazy(() => import('./pages/HelpCenterPage').then(m => ({ default: m.HelpCenterPage })));
const SupportPage = lazy(() => import('./pages/SupportPage').then(m => ({ default: m.SupportPage })));
const ReferPage = lazy(() => import('./pages/ReferPage').then(m => ({ default: m.ReferPage })));
const MembershipsPage = lazy(() => import('./pages/MembershipsPage').then(m => ({ default: m.MembershipsPage })));
const ReviewsPage = lazy(() => import('./pages/ReviewsPage').then(m => ({ default: m.ReviewsPage })));
const RefundsPage = lazy(() => import('./pages/RefundsPage').then(m => ({ default: m.RefundsPage })));
// Founder gap-ports (2026-08-25): mobile-only features now on web too.
const InventoryPage = lazy(() => import('./pages/InventoryPage').then(m => ({ default: m.InventoryPage })));
const PrintersPage = lazy(() => import('./pages/PrintersPage').then(m => ({ default: m.PrintersPage })));
const ModifierGroupsPage = lazy(() => import('./pages/ModifierGroupsPage').then(m => ({ default: m.ModifierGroupsPage })));
// Multi-outlet (2026-09-03): outlet list + switch + group revenue rollup.
const OutletsPage = lazy(() => import('./pages/OutletsPage').then(m => ({ default: m.OutletsPage })));

function RequireAuth({ children }: { children: React.ReactNode }) {
  if (!getToken()) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

// D-10 (2026-09-05): route-level plan gate. The feature key comes from the
// SAME nav table Layout draws its lock icons from (featureForRoute), so a
// route is guarded exactly when its sidebar entry is lockable — one list,
// no drift. Always-on routes (feature null) and add-on-capable routes
// (Customers, which handles its own 402) render straight through.
function Gated({ path, children }: { path: string; children: React.ReactNode }) {
  const feature = featureForRoute(`/${path}`);
  if (!feature) return <>{children}</>;
  return <RequireFeature feature={feature}>{children}</RequireFeature>;
}

// Lightweight fallback shown while a lazy page chunk downloads. Deliberately
// tiny (no extra deps) so it never adds to the eager bundle it's meant to
// shrink.
function PageFallback() {
  return (
    <div className="flex items-center justify-center py-24" role="status" aria-live="polite">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-primary" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}

export default function App() {
  // L-1 (2026-09-01): the access token is now in-memory only, so on a fresh
  // page load it's gone and RequireAuth (which reads getToken synchronously)
  // would bounce a still-logged-in user to /login. Restore it first by
  // exchanging the httpOnly refresh cookie for a new access token, and hold
  // the routes behind a loader until that one-time check resolves.
  const [booting, setBooting] = useState(true);
  useEffect(() => { bootstrapAuth().finally(() => setBooting(false)); }, []);
  if (booting) return <PageFallback />;

  return (
    <>
    <Suspense fallback={<PageFallback />}>
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />

      {/* PUBLIC guest QR ordering — NO auth required */}
      <Route path="/qr/:token" element={<GuestMenuPage />} />
      {/* PUBLIC order tracker */}
      <Route path="/track/:token" element={<PublicOrderTrackerPage />} />

      {/* PUBLIC legal pages — DPDP requires Privacy + ToS to be
          reachable without authentication. */}
      <Route path="/legal/privacy" element={<LegalPage kind="privacy" />} />
      <Route path="/legal/terms"   element={<LegalPage kind="terms" />} />

      {/* FF-217 First-time setup wizard. Auth-required but runs OUTSIDE
          the main Layout so the sidebar doesn't distract while onboarding. */}
      <Route path="/onboarding" element={<RequireAuth><SetupWizardPage /></RequireAuth>} />

      <Route path="/" element={<RequireAuth><Layout /></RequireAuth>}>
        <Route index element={<DashboardPage />} />
        <Route path="menu"     element={<Gated path="menu"><MenuPage /></Gated>} />
        <Route path="orders"   element={<Gated path="orders"><OrdersPage /></Gated>} />
        <Route path="kot"      element={<Gated path="kot"><KotPage /></Gated>} />
        <Route path="tables"   element={<Gated path="tables"><TablesPage /></Gated>} />
        <Route path="qr-codes" element={<Gated path="qr-codes"><QrCodesPage /></Gated>} />
        <Route path="ingredients" element={<Gated path="ingredients"><IngredientsPage /></Gated>} />
        <Route path="inventory" element={<Gated path="inventory"><InventoryPage /></Gated>} />
        <Route path="printers" element={<Gated path="printers"><PrintersPage /></Gated>} />
        <Route path="modifier-groups" element={<Gated path="modifier-groups"><ModifierGroupsPage /></Gated>} />
        <Route path="expenses" element={<Gated path="expenses"><ExpensesPage /></Gated>} />
        <Route path="reports"  element={<Gated path="reports"><ReportsPage /></Gated>} />
        <Route path="invoices" element={<Gated path="invoices"><InvoicesPage /></Gated>} />
        <Route path="refunds"  element={<Gated path="refunds"><RefundsPage /></Gated>} />
        <Route path="staff"    element={<Gated path="staff"><StaffPage /></Gated>} />
        <Route path="outlets"  element={<Gated path="outlets"><OutletsPage /></Gated>} />
        <Route path="customers"   element={<Gated path="customers"><CustomersPage /></Gated>} />
        <Route path="memberships" element={<Gated path="memberships"><MembershipsPage /></Gated>} />
        <Route path="reviews"     element={<Gated path="reviews"><ReviewsPage /></Gated>} />
        <Route path="marketplace" element={<Gated path="marketplace"><MarketplacePage /></Gated>} />
        <Route path="billing"  element={<Gated path="billing"><BillingPage /></Gated>} />
        <Route path="settings" element={<Gated path="settings"><SettingsPage /></Gated>} />
        <Route path="bill-template" element={<Gated path="bill-template"><BillTemplatePage /></Gated>} />
        <Route path="aggregators" element={<Gated path="aggregators"><AggregatorsPage /></Gated>} />
        <Route path="daily-closing" element={<Gated path="daily-closing"><DailyClosingPage /></Gated>} />
        <Route path="reservations" element={<Gated path="reservations"><ReservationsPage /></Gated>} />
        <Route path="wastage" element={<Gated path="wastage"><WastagePage /></Gated>} />
        <Route path="drivers" element={<Gated path="drivers"><DriversPage /></Gated>} />
        <Route path="delivery" element={<Gated path="delivery"><DeliveryBoardPage /></Gated>} />
        <Route path="online-site" element={<Gated path="online-site"><OnlineSitePage /></Gated>} />
        <Route path="accounting" element={<Gated path="accounting"><AccountingPage /></Gated>} />
        <Route path="retail" element={<Gated path="retail"><RetailPage /></Gated>} />
        <Route path="heat-map" element={<Gated path="heat-map"><HeatMapPage /></Gated>} />
        <Route path="forecast" element={<Gated path="forecast"><ForecastPage /></Gated>} />
        <Route path="kds" element={<Gated path="kds"><KdsPage /></Gated>} />
        <Route path="captain" element={<Gated path="captain"><CaptainPage /></Gated>} />
        <Route path="accounting-reports" element={<Gated path="accounting-reports"><AccountingReportsPage /></Gated>} />
        <Route path="food-coupons" element={<Gated path="food-coupons"><CouponsPage /></Gated>} />
        <Route path="reservation-widget" element={<Gated path="reservation-widget"><ReservationWidgetPage /></Gated>} />
        <Route path="campaigns" element={<Gated path="campaigns"><CampaignsPage /></Gated>} />
        <Route path="bulk-import" element={<Gated path="bulk-import"><BulkImportPage /></Gated>} />
        <Route path="migrate" element={<Gated path="migrate"><MigrationPage /></Gated>} />
        <Route path="bank-reconcile" element={<Gated path="bank-reconcile"><BankReconcilePage /></Gated>} />
        <Route path="b2b-invoice-template" element={<Gated path="b2b-invoice-template"><B2BInvoiceTemplatePage /></Gated>} />
        <Route path="recurring-invoices" element={<Gated path="recurring-invoices"><RecurringInvoicesPage /></Gated>} />
        <Route path="surge" element={<Gated path="surge"><SurgePage /></Gated>} />
        <Route path="privacy" element={<Gated path="privacy"><PrivacyPage /></Gated>} />
        {/* Wave 2 + support additions */}
        <Route path="action-center" element={<Gated path="action-center"><ActionCenterPage /></Gated>} />
        <Route path="leakage"       element={<Gated path="leakage"><RevenueLeakagePage /></Gated>} />
        <Route path="help"          element={<Gated path="help"><HelpCenterPage /></Gated>} />
        <Route path="support"       element={<Gated path="support"><SupportPage /></Gated>} />
        <Route path="refer"         element={<Gated path="refer"><ReferPage /></Gated>} />
      </Route>
      {/* Bug fix (2026-08-20): the old catch-all silently redirected to
          "/", turning any typo or stale bookmark into a fake Overview
          visit. Render a real 404 page so the user knows their URL
          didn't match — and still gets a one-click way home. */}
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
    </Suspense>
    <CookieBanner />
    <CrispChat />
    <FirstOrderTour />
    </>
  );
}
