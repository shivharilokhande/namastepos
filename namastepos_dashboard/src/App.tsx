import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { getToken } from './api/client';

// Code-splitting (2026-08-25): App.tsx used to STATICALLY import ~55 page
// components, so Vite bundled every page — Reports/HeatMap/Forecast (recharts),
// Accounting, etc. — into one ~1.3 MB main chunk that even the /login screen
// had to download before rendering. The shell (Layout, auth guard, login,
// always-mounted widgets) stays EAGER so the login path is instant; every
// routed page is now React.lazy so it downloads only when its route is hit.
import { Layout } from './components/Layout';
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

function RequireAuth({ children }: { children: React.ReactNode }) {
  if (!getToken()) return <Navigate to="/login" replace />;
  return <>{children}</>;
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
        <Route path="menu"     element={<MenuPage />} />
        <Route path="orders"   element={<OrdersPage />} />
        <Route path="kot"      element={<KotPage />} />
        <Route path="tables"   element={<TablesPage />} />
        <Route path="qr-codes" element={<QrCodesPage />} />
        <Route path="ingredients" element={<IngredientsPage />} />
        <Route path="inventory" element={<InventoryPage />} />
        <Route path="printers" element={<PrintersPage />} />
        <Route path="modifier-groups" element={<ModifierGroupsPage />} />
        <Route path="expenses" element={<ExpensesPage />} />
        <Route path="reports"  element={<ReportsPage />} />
        <Route path="invoices" element={<InvoicesPage />} />
        <Route path="refunds"  element={<RefundsPage />} />
        <Route path="staff"    element={<StaffPage />} />
        <Route path="customers"   element={<CustomersPage />} />
        <Route path="memberships" element={<MembershipsPage />} />
        <Route path="reviews"     element={<ReviewsPage />} />
        <Route path="marketplace" element={<MarketplacePage />} />
        <Route path="billing"  element={<BillingPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="bill-template" element={<BillTemplatePage />} />
        <Route path="aggregators" element={<AggregatorsPage />} />
        <Route path="daily-closing" element={<DailyClosingPage />} />
        <Route path="reservations" element={<ReservationsPage />} />
        <Route path="wastage" element={<WastagePage />} />
        <Route path="drivers" element={<DriversPage />} />
        <Route path="online-site" element={<OnlineSitePage />} />
        <Route path="accounting" element={<AccountingPage />} />
        <Route path="retail" element={<RetailPage />} />
        <Route path="heat-map" element={<HeatMapPage />} />
        <Route path="forecast" element={<ForecastPage />} />
        <Route path="kds" element={<KdsPage />} />
        <Route path="captain" element={<CaptainPage />} />
        <Route path="accounting-reports" element={<AccountingReportsPage />} />
        <Route path="food-coupons" element={<CouponsPage />} />
        <Route path="reservation-widget" element={<ReservationWidgetPage />} />
        <Route path="campaigns" element={<CampaignsPage />} />
        <Route path="bulk-import" element={<BulkImportPage />} />
        <Route path="bank-reconcile" element={<BankReconcilePage />} />
        <Route path="b2b-invoice-template" element={<B2BInvoiceTemplatePage />} />
        <Route path="recurring-invoices" element={<RecurringInvoicesPage />} />
        <Route path="surge" element={<SurgePage />} />
        <Route path="privacy" element={<PrivacyPage />} />
        {/* Wave 2 + support additions */}
        <Route path="action-center" element={<ActionCenterPage />} />
        <Route path="leakage"       element={<RevenueLeakagePage />} />
        <Route path="help"          element={<HelpCenterPage />} />
        <Route path="support"       element={<SupportPage />} />
        <Route path="refer"         element={<ReferPage />} />
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
