import { useQuery } from '@tanstack/react-query';
import {
  AreaChart, Area, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid,
} from 'recharts';
import { TrendingUp, ArrowDownRight, DollarSign, Activity, Download } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { adminApi } from '@/api/admin';
import { apiError } from '@/api/client';
import { formatINR } from '@/lib/utils';

// Push 20c — minimal CSV builder. Wraps fields in quotes if they contain
// commas, quotes, or newlines; doubles internal quotes per RFC-4180.
function downloadCsv(filename: string, headers: string[], rows: any[][]) {
  const esc = (v: any) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  a.click(); URL.revokeObjectURL(url);
}

export function FinancePage() {
  const { data: metrics }  = useQuery({ queryKey: ['metrics-fin'], queryFn: adminApi.metrics });
  const { data: mrr = [] } = useQuery({ queryKey: ['mrr-trend'],   queryFn: () => adminApi.mrrTrend(12) });
  const { data: ltv }      = useQuery({ queryKey: ['ltv'],         queryFn: adminApi.ltv });
  const { data: churn }    = useQuery({ queryKey: ['churn'],       queryFn: adminApi.churn });
  // Push 19e — outstanding subscription invoices + aging buckets
  const {
    data: outstanding, isError: outErr, error: outErrObj, refetch: refetchOut,
  } = useQuery({
    queryKey: ['outstanding'],
    queryFn: adminApi.outstanding,
    refetchInterval: 60_000,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Finance</h1>
          <p className="text-muted-foreground">Revenue trends, LTV, churn, and active subscriptions.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!mrr || mrr.length === 0}
            onClick={() =>
              downloadCsv(
                `mrr-trend-${new Date().toISOString().slice(0, 10)}.csv`,
                ['Month', 'MRR (INR)'],
                (mrr || []).map((m: any) => [m.month, m.mrrInr])
              )
            }
          >
            <Download className="h-4 w-4 mr-2" /> MRR CSV
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!outstanding || outstanding.invoiceCount === 0}
            onClick={() =>
              downloadCsv(
                `outstanding-invoices-${new Date().toISOString().slice(0, 10)}.csv`,
                ['Invoice', 'Business', 'Email', 'Amount (INR)', 'Days Overdue', 'Status'],
                (outstanding?.rows || []).map((r: any) => [
                  r.number, r.businessName, r.businessEmail,
                  r.amountInr, r.daysOverdue, r.status,
                ])
              )
            }
          >
            <Download className="h-4 w-4 mr-2" /> Outstanding CSV
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!metrics}
            onClick={() => {
              const rows: any[][] = [];
              Object.entries(metrics?.subscriptionsByStatus || {}).forEach(([k, v]) => rows.push(['Subscription status', k, v]));
              Object.entries(metrics?.businessesByPlan || {}).forEach(([k, v]) => rows.push(['Businesses by plan', k, v]));
              rows.push(['KPI', 'MRR (INR)', metrics?.mrrInr || 0]);
              rows.push(['KPI', 'ARR (INR)', metrics?.arrInr || 0]);
              rows.push(['KPI', 'LTV (INR)', ltv?.ltvInr || 0]);
              rows.push(['KPI', 'Churn rate %', churn?.churnRatePct || 0]);
              rows.push(['KPI', 'Active subscriptions', churn?.activeNow || 0]);
              downloadCsv(`finance-summary-${new Date().toISOString().slice(0, 10)}.csv`,
                ['Section', 'Label', 'Value'], rows);
            }}
          >
            <Download className="h-4 w-4 mr-2" /> Summary CSV
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Kpi icon={<TrendingUp className="h-5 w-5" />} color="bg-emerald-100 text-emerald-700"
             label="MRR (now)" value={formatINR(metrics?.mrrInr || 0)} hint={`ARR ${formatINR(metrics?.arrInr || 0)}`} />
        <Kpi icon={<DollarSign className="h-5 w-5" />} color="bg-blue-100 text-blue-700"
             label="LTV" value={formatINR(ltv?.ltvInr || 0)} hint={`${ltv?.payingCustomers || 0} paying customers`} />
        <Kpi icon={<ArrowDownRight className="h-5 w-5" />} color="bg-red-100 text-red-700"
             label="Churn (30d)" value={`${churn?.churnRatePct || 0}%`} hint={`${churn?.cancelled30d || 0} cancelled`} />
        <Kpi icon={<Activity className="h-5 w-5" />} color="bg-violet-100 text-violet-700"
             label="Active subs" value={String(churn?.activeNow || 0)} hint={`${metrics?.subscriptionsByStatus?.trialing || 0} trialing`} />
      </div>

      <Card>
        <CardHeader><CardTitle>MRR · last 12 months</CardTitle></CardHeader>
        <CardContent className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={mrr}>
              <defs>
                <linearGradient id="mrr" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#FF6B35" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="#FF6B35" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="month" fontSize={11} />
              <YAxis tickFormatter={(v) => formatINR(v / 1000) + 'k'} fontSize={11} />
              <Tooltip formatter={(v: any) => formatINR(v)} />
              <Area type="monotone" dataKey="mrrInr" stroke="#FF6B35" fill="url(#mrr)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader><CardTitle>Subscriptions by status</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {Object.entries(metrics?.subscriptionsByStatus || {}).map(([k, v]) => (
              <div key={k} className="flex justify-between py-1.5 border-b last:border-0">
                <span className="capitalize">{k.replace('_', ' ')}</span><strong>{v}</strong>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Businesses by plan</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {Object.entries(metrics?.businessesByPlan || {}).map(([k, v]) => (
              <div key={k} className="flex justify-between py-1.5 border-b last:border-0">
                <span className="capitalize">{k}</span><strong>{v}</strong>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* Push 19e — Aging buckets + outstanding invoices */}
      <Card>
        <CardHeader>
          <CardTitle>
            Outstanding invoices ·{' '}
            {outstanding ? formatINR(outstanding.totalOutstandingInr) : '…'}{' '}
            <span className="text-sm font-normal text-muted-foreground">
              ({outErr ? '—' : `${outstanding?.invoiceCount || 0} unpaid`})
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {outErr && (
            // ₹0 in every aging bucket is a claim about what we're owed.
            <div>
              <div className="text-sm text-destructive">Couldn't load outstanding invoices — {apiError(outErrObj)}</div>
              <Button variant="outline" size="sm" className="mt-2" onClick={() => refetchOut()}>Retry</Button>
            </div>
          )}
          <div className="grid grid-cols-4 gap-3">
            {['0-30', '31-60', '61-90', '90+'].map((b) => {
              const amt = outstanding?.aging?.[b] || 0;
              const colors: any = {
                '0-30': 'bg-emerald-50 border-emerald-200',
                '31-60': 'bg-amber-50 border-amber-200',
                '61-90': 'bg-orange-50 border-orange-200',
                '90+':  'bg-red-50 border-red-200',
              };
              return (
                <div key={b} className={`rounded-md border p-3 ${colors[b]}`}>
                  <div className="text-xs uppercase tracking-wider text-muted-foreground">
                    {b} days
                  </div>
                  <div className="text-lg font-bold tabular-nums">{outErr ? '—' : formatINR(amt)}</div>
                </div>
              );
            })}
          </div>
          {outstanding?.rows?.length > 0 && (
            <div className="border rounded-md overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs uppercase tracking-wider">
                  <tr>
                    <th className="text-left py-2 px-3">Invoice</th>
                    <th className="text-left py-2 px-3">Business</th>
                    <th className="text-right py-2 px-3">Amount</th>
                    <th className="text-right py-2 px-3">Days overdue</th>
                    <th className="text-left py-2 px-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {outstanding.rows.map((r: any) => (
                    <tr key={r.id} className="border-t hover:bg-muted/30">
                      <td className="py-1.5 px-3 font-mono text-xs">{r.number}</td>
                      <td className="py-1.5 px-3">
                        <div className="font-medium">{r.businessName}</div>
                        <div className="text-xs text-muted-foreground">{r.businessEmail}</div>
                      </td>
                      <td className="py-1.5 px-3 text-right tabular-nums">{formatINR(r.amountInr)}</td>
                      <td className="py-1.5 px-3 text-right tabular-nums">
                        <span className={r.daysOverdue > 60 ? 'text-destructive font-semibold' : ''}>
                          {r.daysOverdue}
                        </span>
                      </td>
                      <td className="py-1.5 px-3 text-xs capitalize">{r.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!outErr && outstanding && outstanding.invoiceCount === 0 && (
            <div className="py-6 text-center text-muted-foreground text-sm">
              Nothing outstanding — every invoice is paid or void.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Kpi({ icon, label, value, hint, color }: any) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className={`grid h-10 w-10 place-items-center rounded-lg ${color}`}>{icon}</div>
        <div className="mt-4 text-2xl font-bold tracking-tight">{value}</div>
        <div className="text-sm text-muted-foreground">{label}</div>
        {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}
