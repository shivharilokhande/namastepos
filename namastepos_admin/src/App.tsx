import { Routes, Route, Navigate } from 'react-router-dom';
import { getAdminToken } from './api/client';
import { Layout } from './components/Layout';

import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { MetricsPage } from './pages/MetricsPage';
import { CustomersPage } from './pages/CustomersPage';
import { CustomerDetailPage } from './pages/CustomerDetailPage';
import { PlansPage } from './pages/PlansPage';
import { AddonsPage } from './pages/AddonsPage';
import { CouponsPage } from './pages/CouponsPage';
import { FinancePage } from './pages/FinancePage';
import { RefundsPage } from './pages/RefundsPage';
import { SubscriptionsPage } from './pages/SubscriptionsPage';
import { GstPage } from './pages/GstPage';
import { ReportsPage } from './pages/ReportsPage';
import { AuditPage } from './pages/AuditPage';
import { WebhooksPage } from './pages/WebhooksPage';
import { AdminTeamPage } from './pages/AdminTeamPage';
import { SettingsPage } from './pages/SettingsPage';
import { CrmPage } from './pages/CrmPage';   // FF-402
import { NotFoundPage } from './pages/NotFoundPage';

function RequireAuth({ children }: { children: React.ReactNode }) {
  if (!getAdminToken()) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<RequireAuth><Layout /></RequireAuth>}>
        <Route index element={<DashboardPage />} />
        <Route path="metrics"       element={<MetricsPage />} />
        <Route path="customers"     element={<CustomersPage />} />
        <Route path="customers/:id" element={<CustomerDetailPage />} />
        <Route path="plans"         element={<PlansPage />} />
        <Route path="addons"        element={<AddonsPage />} />
        <Route path="coupons"       element={<CouponsPage />} />
        <Route path="finance"       element={<FinancePage />} />
        <Route path="subscriptions" element={<SubscriptionsPage />} />
        <Route path="refunds"       element={<RefundsPage />} />
        <Route path="gst"           element={<GstPage />} />
        <Route path="reports"       element={<ReportsPage />} />
        <Route path="audit"         element={<AuditPage />} />
        <Route path="webhooks"      element={<WebhooksPage />} />
        <Route path="crm"           element={<CrmPage />} />
        <Route path="team"          element={<AdminTeamPage />} />
        <Route path="settings"      element={<SettingsPage />} />
      </Route>
      {/* Bug fix (2026-08-20): show a real 404 rather than silently
          redirecting to the platform overview. */}
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
