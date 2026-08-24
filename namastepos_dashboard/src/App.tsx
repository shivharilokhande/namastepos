import { Routes, Route, Navigate } from 'react-router-dom';
import { getToken } from './api/client';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { DashboardPage } from './pages/DashboardPage';
import { MenuPage } from './pages/MenuPage';
import { OrdersPage } from './pages/OrdersPage';
import { KotPage } from './pages/KotPage';
import { TablesPage } from './pages/TablesPage';
import { QrCodesPage } from './pages/QrCodesPage';
import { GuestMenuPage } from './pages/GuestMenuPage';
import { IngredientsPage } from './pages/IngredientsPage';
import { ExpensesPage } from './pages/ExpensesPage';
import { ReportsPage } from './pages/ReportsPage';
import { InvoicesPage } from './pages/InvoicesPage';
import { StaffPage } from './pages/StaffPage';
import { CustomersPage } from './pages/CustomersPage';
import { BillingPage } from './pages/BillingPage';
import { MarketplacePage } from './pages/MarketplacePage';
import { SettingsPage } from './pages/SettingsPage';
import { BillTemplatePage } from './pages/BillTemplatePage';
import { AggregatorsPage } from './pages/AggregatorsPage';
import { DailyClosingPage } from './pages/DailyClosingPage';
import { ReservationsPage } from './pages/ReservationsPage';
import { WastagePage } from './pages/WastagePage';
import { DriversPage } from './pages/DriversPage';
import { OnlineSitePage } from './pages/OnlineSitePage';
import { AccountingPage } from './pages/AccountingPage';
import { RetailPage } from './pages/RetailPage';
import { HeatMapPage } from './pages/HeatMapPage';
import { ForecastPage } from './pages/ForecastPage';
import { KdsPage } from './pages/KdsPage';
import { AccountingReportsPage } from './pages/AccountingReportsPage';
import { PublicOrderTrackerPage } from './pages/PublicOrderTrackerPage';
import { CaptainPage } from './pages/CaptainPage';
import { CouponsPage } from './pages/CouponsPage';
import { ReservationWidgetPage } from './pages/ReservationWidgetPage';
import { CampaignsPage } from './pages/CampaignsPage';
import { BulkImportPage } from './pages/BulkImportPage';
import { BankReconcilePage } from './pages/BankReconcilePage';
import { B2BInvoiceTemplatePage } from './pages/B2BInvoiceTemplatePage';
import { RecurringInvoicesPage } from './pages/RecurringInvoicesPage';
import { SurgePage } from './pages/SurgePage';
import { PrivacyPage } from './pages/PrivacyPage';
import { LegalPage } from './pages/LegalPage';
import { CookieBanner } from './components/CookieBanner';
import { CrispChat } from './components/CrispChat';
import { FirstOrderTour } from './components/FirstOrderTour';
import { NotFoundPage } from './pages/NotFoundPage';
import { SetupWizardPage } from './pages/SetupWizardPage';
import { ActionCenterPage } from './pages/ActionCenterPage';
import { RevenueLeakagePage } from './pages/RevenueLeakagePage';
import { HelpCenterPage } from './pages/HelpCenterPage';
import { MembershipsPage } from './pages/MembershipsPage';
import { ReviewsPage } from './pages/ReviewsPage';
import { RefundsPage } from './pages/RefundsPage';

function RequireAuth({ children }: { children: React.ReactNode }) {
  if (!getToken()) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <>
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
      </Route>
      {/* Bug fix (2026-08-20): the old catch-all silently redirected to
          "/", turning any typo or stale bookmark into a fake Overview
          visit. Render a real 404 page so the user knows their URL
          didn't match — and still gets a one-click way home. */}
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
    <CookieBanner />
    <CrispChat />
    <FirstOrderTour />
    </>
  );
}
