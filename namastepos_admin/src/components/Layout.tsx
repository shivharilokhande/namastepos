import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Users, CreditCard, BarChart3, LogOut, Utensils,
  Tag, Receipt, FileText, Shield, Settings, ScrollText, UsersRound,
  TrendingUp, Package, LifeBuoy, Send, Gift, ShieldCheck,
  AlertTriangle, Gauge, PieChart, Activity,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { adminApi, Admin } from '@/api/admin';
import { adminLogout, apiError } from '@/api/client';
import { cn } from '@/lib/utils';

interface NavItem { to: string; icon: any; label: string; needs?: string; }
type Section = { label: string; items: NavItem[] };

// Mirror of the backend RBAC matrix (src/middleware/adminRbac.js) so we only
// SHOW nav a role can actually use — otherwise every non-super role saw items
// that 403 on click now that the backend re-checks the live role. Backend
// remains the source of truth; this is UX only. Keep in sync with the backend.
const ROLE_PERMS: Record<string, string[]> = {
  super_admin: ['*'],
  finance: ['revenue.read', 'revenue.write', 'refunds.read', 'refunds.write',
    'gst.read', 'gst.write', 'invoices.read', 'invoices.write', 'customers.read',
    'plans.read', 'coupons.read', 'audit.read', 'reports.read', 'settings.read',
    'compliance.read'],
  support: ['customers.read', 'customers.write', 'customers.impersonate',
    'notes.read', 'notes.write', 'staff.read', 'menu.read', 'orders.read',
    'reports.read', 'audit.read', 'plans.read', 'coupons.read', 'invoices.read',
    'refunds.read', 'gst.read', 'compliance.read', 'compliance.write'],
  sales: ['customers.read', 'customers.write', 'plans.read', 'plans.change',
    'coupons.read', 'reports.read'],
};
function roleCan(role: string | undefined, need?: string): boolean {
  if (!need) return true;            // always-visible items
  if (!role) return false;
  const g = ROLE_PERMS[role] || [];
  return g.includes('*') || g.includes(need);
}

const SECTIONS: Section[] = [
  { label: 'Overview', items: [
    { to: '/',          icon: LayoutDashboard, label: 'Overview' },
    { to: '/reports',   icon: TrendingUp,      label: 'Reports',  needs: 'reports.read' },
    { to: '/metrics',   icon: BarChart3,       label: 'Metrics',  needs: 'reports.read' },
    { to: '/charts',    icon: PieChart,        label: 'Charts',   needs: 'reports.read' },
  ]},
  { label: 'Customers', items: [
    { to: '/customers', icon: Users,           label: 'Customers', needs: 'customers.read' },
    // FF-402 — CRM primitives: cross-tenant follow-up + renewal view
    { to: '/crm',       icon: TrendingUp,      label: 'CRM',       needs: 'customers.read' },
    // Nav gates mirror what the routes actually require: support tickets and
    // broadcast are customers.* (not compliance.*).
    { to: '/support',   icon: LifeBuoy,        label: 'Support',   needs: 'customers.read' },
    { to: '/broadcast', icon: Send,            label: 'Broadcast', needs: 'customers.write' },
    { to: '/referrals', icon: Gift,            label: 'Referrals', needs: 'reports.read' },
    // Usage vs plan caps — upsell candidates + support triage in one table.
    { to: '/usage',     icon: Gauge,           label: 'Usage & limits', needs: 'reports.read' },
  ]},
  { label: 'Revenue', items: [
    { to: '/subscriptions', icon: CreditCard,  label: 'Subscriptions', needs: 'revenue.read' },
    // Dunning work queue. The three recovery actions are revenue.write, so
    // gate the nav on revenue.read (finance + super_admin) to match.
    { to: '/billing-ops', icon: AlertTriangle, label: 'Billing ops',  needs: 'revenue.read' },
    { to: '/plans',     icon: CreditCard,      label: 'Plans',    needs: 'plans.read' },
    { to: '/addons',    icon: Package,         label: 'Add-ons',  needs: 'plans.read' },
    { to: '/coupons',   icon: Tag,             label: 'Coupons',  needs: 'coupons.read' },
    { to: '/finance',   icon: Receipt,         label: 'Finance',  needs: 'revenue.read' },
    { to: '/refunds',   icon: Receipt,         label: 'Refunds',  needs: 'refunds.read' },
    { to: '/gst',       icon: FileText,        label: 'GST & Tax', needs: 'gst.read' },
  ]},
  { label: 'Operations', items: [
    // GET /admin/health/platform is reports.read — it was only reachable via
    // settings.write-gated Platform settings, so the roles allowed to read it
    // could never see it.
    { to: '/health',    icon: Activity,        label: 'Platform health', needs: 'reports.read' },
    { to: '/compliance', icon: ShieldCheck,    label: 'Compliance', needs: 'compliance.read' },
    { to: '/audit',     icon: ScrollText,      label: 'Audit log', needs: 'audit.read' },
    // GET /admin/webhooks/events is audit.read, not settings.write.
    { to: '/webhooks',  icon: BarChart3,       label: 'Webhooks',  needs: 'audit.read' },
    { to: '/team',      icon: UsersRound,      label: 'Admin team', needs: 'settings.write' },
    { to: '/settings',  icon: Settings,        label: 'Platform settings', needs: 'settings.write' },
  ]},
];

export function Layout() {
  const navigate = useNavigate();
  const [me, setMe] = useState<Admin | null>(null);
  // A failed /auth/me used to be swallowed, leaving `me=null` — every roleCan()
  // returned false and the console looked empty with no explanation. Surface it.
  const [meError, setMeError] = useState<string | null>(null);

  const loadMe = () => {
    setMeError(null);
    adminApi.me().then((m) => { setMe(m); setMeError(null); })
      .catch((e) => { setMe(null); setMeError(apiError(e)); });
  };
  useEffect(() => { loadMe(); }, []);

  const logout = async () => { await adminLogout(); navigate('/login'); };

  const roleColor: Record<string, any> = {
    super_admin: 'default', finance: 'secondary', support: 'muted', sales: 'warning',
  };

  return (
    <div className="flex min-h-screen">
      <aside className="hidden md:flex md:w-64 flex-col border-r bg-card px-3 py-4 overflow-y-auto">
        <div className="flex items-center gap-2 px-3 mb-4">
          <div className="grid h-9 w-9 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Utensils className="h-5 w-5" />
          </div>
          <div>
            <div className="text-sm font-bold leading-tight">NamastePOS</div>
            <div className="text-xs text-muted-foreground">Super Admin</div>
          </div>
        </div>

        {me && (
          <div className="px-3 py-2 mb-2 rounded-lg bg-accent">
            <div className="text-xs font-medium truncate">{me.displayName || me.email}</div>
            <div className="flex items-center gap-1 mt-0.5">
              <Badge variant={roleColor[me.role] || 'muted'} className="text-[10px] capitalize">
                {me.role.replace('_', ' ')}
              </Badge>
            </div>
          </div>
        )}

        {meError && (
          <div className="px-3 py-2 mb-2 rounded-lg border border-destructive/40 bg-destructive/10">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 text-destructive shrink-0" />
              <div className="text-xs">
                <div className="font-medium text-destructive">Couldn't load your permissions</div>
                <div className="text-muted-foreground mt-0.5 break-words">{meError}</div>
              </div>
            </div>
            <div className="flex gap-2 mt-2">
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={loadMe}>Retry</Button>
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={logout}>Sign in again</Button>
            </div>
          </div>
        )}

        <nav className="flex-1 space-y-4">
          {SECTIONS.map((sec) => ({
            ...sec,
            items: sec.items.filter((it) => roleCan(me?.role, it.needs)),
          }))
            .filter((sec) => sec.items.length > 0)
            .map((sec) => (
            <div key={sec.label}>
              <div className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {sec.label}
              </div>
              <div className="space-y-0.5">
                {sec.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/'}
                    className={({ isActive }) =>
                      cn(
                        'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                        isActive
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                      )
                    }
                  >
                    <item.icon className="h-4 w-4" />
                    {item.label}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        <Button variant="ghost" size="sm" className="justify-start mt-2" onClick={logout}>
          <LogOut className="mr-2 h-4 w-4" /> Sign out
        </Button>
      </aside>

      <main className="flex-1 overflow-auto bg-muted/30">
        <div className="container mx-auto py-6 max-w-7xl">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
