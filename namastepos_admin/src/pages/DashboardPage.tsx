import { useQuery } from '@tanstack/react-query';
import { TrendingUp, Users, ShoppingCart, CreditCard } from 'lucide-react';
import {
  AreaChart, Area, XAxis, YAxis, ResponsiveContainer, Tooltip,
  PieChart, Pie, Cell, Legend,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { adminApi } from '@/api/admin';
import { formatINR } from '@/lib/utils';

const PIE_COLORS = ['#FF6B35', '#2EC4B6', '#FFB627', '#8B5CF6', '#EF4444'];

export function DashboardPage() {
  const { data: m, isLoading } = useQuery({
    queryKey: ['metrics'], queryFn: adminApi.metrics,
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Platform overview</h1>
        <p className="text-muted-foreground">All your NamastePOS customers at a glance.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          icon={<TrendingUp className="h-5 w-5" />}
          label="MRR"
          value={isLoading ? '—' : formatINR(m?.mrrInr || 0)}
          hint={`ARR: ${formatINR(m?.arrInr || 0)}`}
          color="bg-emerald-100 text-emerald-700"
        />
        <KpiCard
          icon={<Users className="h-5 w-5" />}
          label="Customers"
          value={isLoading ? '—' : String(m?.totalBusinesses ?? 0)}
          hint="Signed up businesses"
          color="bg-blue-100 text-blue-700"
        />
        <KpiCard
          icon={<ShoppingCart className="h-5 w-5" />}
          label="Orders (30d)"
          value={isLoading ? '—' : (m?.orders30d || 0).toLocaleString('en-IN')}
          hint={`GMV: ${formatINR(m?.gmv30dInr || 0)}`}
          color="bg-amber-100 text-amber-700"
        />
        <KpiCard
          icon={<CreditCard className="h-5 w-5" />}
          label="Active subs"
          value={isLoading ? '—' : String(m?.subscriptionsByStatus?.active ?? 0)}
          hint={`Trial: ${m?.subscriptionsByStatus?.trialing ?? 0}`}
          color="bg-violet-100 text-violet-700"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>New signups · last 30 days</CardTitle></CardHeader>
          <CardContent className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={m?.signups30d || []}>
                <defs>
                  <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#FF6B35" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="#FF6B35" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="date" hide />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Area type="monotone" dataKey="count" stroke="#FF6B35" fill="url(#g1)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>By plan</CardTitle></CardHeader>
          <CardContent className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={Object.entries(m?.businessesByPlan || {}).map(([name, value]) => ({ name, value }))}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  outerRadius={80}
                  label
                >
                  {Object.keys(m?.businessesByPlan || {}).map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function KpiCard({ icon, label, value, hint, color }: {
  icon: React.ReactNode; label: string; value: string; hint?: string; color: string;
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-center justify-between">
          <div className={`grid h-10 w-10 place-items-center rounded-lg ${color}`}>{icon}</div>
        </div>
        <div className="mt-4 text-2xl font-bold tracking-tight">{value}</div>
        <div className="text-sm text-muted-foreground">{label}</div>
        {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}
