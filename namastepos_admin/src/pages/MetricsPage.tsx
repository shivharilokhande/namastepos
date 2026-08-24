import { useQuery } from '@tanstack/react-query';
import {
  BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { adminApi } from '@/api/admin';
import { formatINR } from '@/lib/utils';

export function MetricsPage() {
  const { data: m } = useQuery({ queryKey: ['metrics'], queryFn: adminApi.metrics });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Metrics</h1>
        <p className="text-muted-foreground">Deeper look at platform performance.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat label="MRR" value={formatINR(m?.mrrInr || 0)} />
        <Stat label="ARR" value={formatINR(m?.arrInr || 0)} />
        <Stat label="GMV · 30d" value={formatINR(m?.gmv30dInr || 0)} />
        <Stat label="Orders · 30d" value={(m?.orders30d || 0).toLocaleString('en-IN')} />
      </div>

      <Card>
        <CardHeader><CardTitle>Daily signups · last 30 days</CardTitle></CardHeader>
        <CardContent className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={m?.signups30d || []}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="date" fontSize={11} />
              <YAxis allowDecimals={false} fontSize={11} />
              <Tooltip />
              <Bar dataKey="count" fill="#FF6B35" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader><CardTitle>Subscriptions by status</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {Object.entries(m?.subscriptionsByStatus || {}).map(([k, v]) => (
              <div key={k} className="flex justify-between py-1.5 border-b last:border-0">
                <span className="capitalize">{k}</span>
                <strong>{v}</strong>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Businesses by plan</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {Object.entries(m?.businessesByPlan || {}).map(([k, v]) => (
              <div key={k} className="flex justify-between py-1.5 border-b last:border-0">
                <span className="capitalize">{k}</span>
                <strong>{v}</strong>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="text-2xl font-bold tracking-tight">{value}</div>
        <div className="text-sm text-muted-foreground">{label}</div>
      </CardContent>
    </Card>
  );
}
