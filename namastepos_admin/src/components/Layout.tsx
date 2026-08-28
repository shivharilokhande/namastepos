import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Users, CreditCard, BarChart3, LogOut, Utensils,
  Tag, Receipt, FileText, Shield, Settings, ScrollText, UsersRound,
  TrendingUp, Package, LifeBuoy, Send, Gift, ShieldCheck,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { adminApi, Admin } from '@/api/admin';
import { adminLogout } from '@/api/client';
import { cn } from '@/lib/utils';

interface NavItem { to: string; icon: any; label: string; needs?: string[]; }
type Section = { label: string; items: NavItem[] };

const SECTIONS: Section[] = [
  { label: 'Overview', items: [
    { to: '/',          icon: LayoutDashboard, label: 'Dashboard' },
    { to: '/reports',   icon: TrendingUp,      label: 'Reports' },
    { to: '/metrics',   icon: BarChart3,       label: 'Metrics' },
  ]},
  { label: 'Customers', items: [
    { to: '/customers', icon: Users,           label: 'Customers' },
    // FF-402 — CRM primitives: cross-tenant follow-up + renewal view
    { to: '/crm',       icon: TrendingUp,      label: 'CRM' },
    { to: '/support',   icon: LifeBuoy,        label: 'Support' },
    { to: '/broadcast', icon: Send,            label: 'Broadcast' },
    { to: '/referrals', icon: Gift,            label: 'Referrals' },
  ]},
  { label: 'Revenue', items: [
    { to: '/subscriptions', icon: CreditCard,  label: 'Subscriptions' },
    { to: '/plans',     icon: CreditCard,      label: 'Plans' },
    { to: '/addons',    icon: Package,         label: 'Add-ons' },
    { to: '/coupons',   icon: Tag,             label: 'Coupons' },
    { to: '/finance',   icon: Receipt,         label: 'Finance' },
    { to: '/refunds',   icon: Receipt,         label: 'Refunds' },
    { to: '/gst',       icon: FileText,        label: 'GST & Tax' },
  ]},
  { label: 'Operations', items: [
    { to: '/compliance', icon: ShieldCheck,    label: 'Compliance' },
    { to: '/audit',     icon: ScrollText,      label: 'Audit log' },
    { to: '/webhooks',  icon: BarChart3,       label: 'Webhooks' },
    { to: '/team',      icon: UsersRound,      label: 'Admin team' },
    { to: '/settings',  icon: Settings,        label: 'Platform settings' },
  ]},
];

export function Layout() {
  const navigate = useNavigate();
  const [me, setMe] = useState<Admin | null>(null);

  useEffect(() => { adminApi.me().then(setMe).catch(() => {}); }, []);

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

        <nav className="flex-1 space-y-4">
          {SECTIONS.map((sec) => (
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
