import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid,
  LineChart, Line, Legend,
} from 'recharts';
import { toast } from 'sonner';
import { Download } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { adminApi } from '@/api/admin';
import { formatINR } from '@/lib/utils';

export function ReportsPage() {
  // Push 19c — owner-tunable period. funnel & top-items/cities are
  // "last N days" — cohorts is "last M months". The period selector
  // re-queries everything in one shot.
  const [days, setDays] = useState(30);
  const [months, setMonths] = useState(6);
  const [limit, setLimit] = useState(10);

  const { data: cohorts = [] } = useQuery({
    queryKey: ['cohorts', months], queryFn: () => adminApi.cohorts(months),
  });
  const { data: funnel } = useQuery({
    queryKey: ['funnel', days], queryFn: () => adminApi.funnel(days),
  });
  const { data: items = [] } = useQuery({
    queryKey: ['top-items', days, limit], queryFn: () => adminApi.topItems(days, limit),
  });
  const { data: cities = [] } = useQuery({
    queryKey: ['top-cities', days, limit], queryFn: () => adminApi.topCities(days, limit),
  });

  // Push 20d — platform P&L period. Defaults to current FY-to-date on the
  // backend if from/to are omitted. UI exposes a quick override.
  const [pnlFrom, setPnlFrom] = useState('');
  const [pnlTo, setPnlTo] = useState('');
  const { data: pnl } = useQuery({
    queryKey: ['pnl', pnlFrom, pnlTo],
    queryFn: () => adminApi.pnl({ from: pnlFrom || undefined, to: pnlTo || undefined }),
  });
  const { data: custKpi } = useQuery({
    queryKey: ['customers-kpi'], queryFn: () => adminApi.customersKpi(),
  });
  const { data: revBreak = [] } = useQuery({
    queryKey: ['revenue-breakdown', months],
    queryFn: () => adminApi.revenueBreakdown(months),
  });

  // Push 19c — client-side CSV export. The data is already in memory
  // from the queries above so we don't need an extra backend endpoint.
  const exportCsv = (filename: string, headers: string[], rows: any[][]) => {
    const escape = (v: any) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [
      headers.join(','),
      ...rows.map((r) => r.map(escape).join(',')),
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast.success(`Downloaded ${filename}`);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Advanced reports</h1>
          <p className="text-muted-foreground">Cohort retention, signup funnel, geographic and item trends.</p>
        </div>
        <Card className="p-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-28">
              <Label className="text-xs">Days window</Label>
              <Input type="number" min={1} max={365} value={days}
                  onChange={(e) => setDays(+e.target.value || 30)} />
            </div>
            <div className="w-28">
              <Label className="text-xs">Cohort months</Label>
              <Input type="number" min={1} max={24} value={months}
                  onChange={(e) => setMonths(+e.target.value || 6)} />
            </div>
            <div className="w-24">
              <Label className="text-xs">Top N</Label>
              <Input type="number" min={1} max={100} value={limit}
                  onChange={(e) => setLimit(+e.target.value || 10)} />
            </div>
          </div>
        </Card>
      </div>

      {/* Push 20d — Platform P&L (consolidated income vs expenses) */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Platform P&amp;L</CardTitle>
              <CardDescription>
                {pnl ? `${pnl.from} → ${pnl.to}` : 'Loading…'} · Cash-basis income vs expenses vs refunds.
              </CardDescription>
            </div>
            <div className="flex items-end gap-2">
              <div className="w-36">
                <Label className="text-xs">From</Label>
                <Input type="date" value={pnlFrom} onChange={(e) => setPnlFrom(e.target.value)} />
              </div>
              <div className="w-36">
                <Label className="text-xs">To</Label>
                <Input type="date" value={pnlTo} onChange={(e) => setPnlTo(e.target.value)} />
              </div>
              <Button size="sm" variant="outline"
                  disabled={!pnl}
                  onClick={() => pnl && exportCsv(
                    `pnl_${pnl.from}_${pnl.to}.csv`,
                    ['Section', 'Line', 'Amount (INR)'],
                    [
                      ['Income', 'Subscription invoices (paid)', pnl.income.subscriptionInr],
                      ['Income', 'Add-on revenue', pnl.income.addonsInr],
                      ['Income', 'Total income', pnl.income.totalInr],
                      ['Refunds', 'Refunds issued', pnl.refunds.totalInr],
                      ['Net', 'Gross revenue (income − refunds)', pnl.grossRevenueInr],
                      ['Expense', 'Operating expenses', pnl.expenses?.totalInr || 0],
                      ['Net', 'Net profit', pnl.netProfitInr],
                      ...(pnl.expenses?.items || []).map((x: any) =>
                        ['Expense breakdown', x.category, x.amountInr]),
                    ],
                  )}>
                <Download className="mr-1 h-3.5 w-3.5" /> CSV
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <PnlTile label="Subscription income" value={pnl?.income.subscriptionInr} sub={`${pnl?.income.subscriptionInvoiceCount || 0} invoices`} tone="emerald" />
            <PnlTile label="Add-on income" value={pnl?.income.addonsInr} sub={`${pnl?.income.addonsInvoiceCount || 0} charges`} tone="emerald" />
            <PnlTile label="Refunds" value={pnl?.refunds.totalInr} sub={`${pnl?.refunds.count || 0} processed`} tone="amber" />
            <PnlTile label="Operating expenses" value={pnl?.expenses?.totalInr || 0} sub={pnl?.expenses ? `${pnl.expenses.items.length} categories` : 'No expense data'} tone="rose" />
            <PnlTile label="Net profit" value={pnl?.netProfitInr} sub="Gross revenue − expenses" tone={(pnl?.netProfitInr || 0) >= 0 ? 'emerald' : 'rose'} />
          </div>
          {pnl?.expenses && pnl.expenses.items.length > 0 && (
            <div className="border rounded-md overflow-hidden">
              <Table>
                <TableHeader><TableRow>
                  <TableHead>Expense category</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow></TableHeader>
                <TableBody>
                  {pnl.expenses.items.map((x: any) => (
                    <TableRow key={x.category}>
                      <TableCell className="capitalize">{x.category}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatINR(x.amountInr)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Push 20d — Customer KPIs */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card>
          <CardHeader><CardTitle>Customer totals</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between"><span>Total customers</span><strong>{custKpi?.total ?? '—'}</strong></div>
            <div className="flex justify-between"><span>Active (not deleted)</span><strong>{custKpi?.alive ?? '—'}</strong></div>
            <div className="flex justify-between"><span>New in last 30 days</span><strong className="text-emerald-700">{custKpi?.new30d ?? '—'}</strong></div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div className="flex justify-between items-start">
              <CardTitle>Customers by plan</CardTitle>
              <Button size="sm" variant="outline"
                  disabled={!custKpi?.byPlan?.length}
                  onClick={() => exportCsv(
                    'customers_by_plan.csv',
                    ['Tier', 'Plan', 'Customers'],
                    (custKpi?.byPlan || []).map((p: any) => [p.tier, p.name, p.customers]),
                  )}>
                <Download className="mr-1 h-3.5 w-3.5" /> CSV
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-1.5 text-sm">
            {(custKpi?.byPlan || []).map((p: any, i: number) => (
              <div key={`${p.tier}-${p.name}-${i}`} className="flex justify-between py-1 border-b last:border-0">
                <span className="capitalize">{p.name}</span><strong>{p.customers}</strong>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>By subscription status</CardTitle></CardHeader>
          <CardContent className="space-y-1.5 text-sm">
            {(custKpi?.byStatus || []).map((p: any) => (
              <div key={p.status} className="flex justify-between py-1 border-b last:border-0">
                <span className="capitalize">{p.status.replace('_', ' ')}</span><strong>{p.customers}</strong>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* Push 20d — Revenue breakdown (subscription vs addons vs refunds) */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle>Revenue split · last {months} months</CardTitle>
              <CardDescription>Subscription billing vs add-on charges vs refunds, month by month.</CardDescription>
            </div>
            <Button size="sm" variant="outline"
                disabled={!revBreak.length}
                onClick={() => exportCsv(
                  `revenue_breakdown_${months}m.csv`,
                  ['Month', 'Subscription (INR)', 'Add-ons (INR)', 'Refunds (INR)', 'Net (INR)'],
                  revBreak.map((r: any) => [r.month, r.subscriptionInr, r.addonsInr, r.refundsInr, r.netInr]),
                )}>
              <Download className="mr-1 h-3.5 w-3.5" /> CSV
            </Button>
          </div>
        </CardHeader>
        <CardContent className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={revBreak}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="month" fontSize={11} />
              <YAxis tickFormatter={(v) => formatINR(v / 1000) + 'k'} fontSize={11} />
              <Tooltip formatter={(v: any) => formatINR(v)} />
              <Legend />
              <Line type="monotone" dataKey="subscriptionInr" name="Subscription" stroke="#10b981" strokeWidth={2} />
              <Line type="monotone" dataKey="addonsInr"       name="Add-ons"      stroke="#3b82f6" strokeWidth={2} />
              <Line type="monotone" dataKey="refundsInr"      name="Refunds"      stroke="#ef4444" strokeWidth={2} />
              <Line type="monotone" dataKey="netInr"          name="Net"          stroke="#FF6B35" strokeWidth={2} strokeDasharray="4 2" />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Funnel */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle>Signup funnel · last {days} days</CardTitle>
              <CardDescription>How many sign-ups make it to first order, then to a paid plan.</CardDescription>
            </div>
            <Button size="sm" variant="outline"
                disabled={!funnel}
                onClick={() => exportCsv(
                  `funnel_${days}d.csv`,
                  ['Stage', 'Count'],
                  funnel ? [
                    ['Sign-ups', funnel.signups],
                    ['Placed first order', funnel.placedFirstOrder],
                    ['On paid plan', funnel.onPaidPlan],
                  ] : []
                )}>
              <Download className="mr-1 h-3.5 w-3.5" /> CSV
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {!funnel ? (
            <div className="py-6 text-muted-foreground">Loading…</div>
          ) : (
            <div className="space-y-3">
              <FunnelBar label="Sign-ups"             value={funnel.signups} max={funnel.signups} color="bg-blue-500" />
              <FunnelBar label="Placed first order"   value={funnel.placedFirstOrder} max={funnel.signups} color="bg-amber-500" />
              <FunnelBar label="On paid plan"         value={funnel.onPaidPlan} max={funnel.signups} color="bg-emerald-500" />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Cohorts */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle>Cohort retention · {months} months</CardTitle>
              <CardDescription>% of each signup-month cohort placing orders in following months</CardDescription>
            </div>
            <Button size="sm" variant="outline"
                onClick={() => exportCsv(
                  `cohorts_${months}m.csv`,
                  ['Cohort', 'Size', 'M0', 'M1', 'M2', 'M3', 'M4', 'M5'],
                  cohorts.map((c: any) => [
                    c.cohort, c.size,
                    ...[0, 1, 2, 3, 4, 5].map((m) => c.retention?.[m] ?? ''),
                  ])
                )}>
              <Download className="mr-1 h-3.5 w-3.5" /> CSV
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="px-4 py-2 text-left font-medium text-muted-foreground">Cohort</th>
                <th className="px-2 py-2 text-right font-medium text-muted-foreground">Size</th>
                {[0, 1, 2, 3, 4, 5].map((m) => (
                  <th key={m} className="px-2 py-2 text-right font-medium text-muted-foreground">M{m}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cohorts.length === 0 && (
                <tr><td colSpan={8} className="text-center py-8 text-muted-foreground">Not enough data yet</td></tr>
              )}
              {cohorts.map((c: any) => (
                <tr key={c.cohort} className="border-b">
                  <td className="px-4 py-2 font-mono text-xs">{c.cohort}</td>
                  <td className="px-2 py-2 text-right">{c.size}</td>
                  {[0, 1, 2, 3, 4, 5].map((m) => {
                    const v = c.retention?.[m];
                    return (
                      <td key={m} className="px-2 py-2 text-right">
                        {v !== undefined ? <Heat pct={v} /> : <span className="text-muted-foreground">—</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Top items */}
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <CardTitle>Top items · {days} days</CardTitle>
              <Button size="sm" variant="outline"
                  onClick={() => exportCsv(
                    `top_items_${days}d.csv`,
                    ['Item', 'Qty', 'Revenue (INR)', 'Sold by N businesses'],
                    items.map((it: any) => [it.name, it.qty, it.revenue, it.businesses_selling]),
                  )}>
                <Download className="mr-1 h-3.5 w-3.5" /> CSV
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Item</TableHead><TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Revenue</TableHead>
                <TableHead className="text-right">Sold by</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {items.length === 0 && <TableRow><TableCell colSpan={4} className="text-center py-6 text-muted-foreground">No data</TableCell></TableRow>}
                {items.map((it: any) => (
                  <TableRow key={it.name}>
                    <TableCell className="font-medium">{it.name}</TableCell>
                    <TableCell className="text-right">{it.qty}</TableCell>
                    <TableCell className="text-right">{formatINR(it.revenue)}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{it.businesses_selling}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Top cities */}
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <CardTitle>Top cities by GMV · {days} days</CardTitle>
              <Button size="sm" variant="outline"
                  onClick={() => exportCsv(
                    `top_cities_${days}d.csv`,
                    ['City', 'GMV (INR)'],
                    cities.map((c: any) => [c.city, c.gmv]),
                  )}>
                <Download className="mr-1 h-3.5 w-3.5" /> CSV
              </Button>
            </div>
          </CardHeader>
          <CardContent className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={cities} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis type="number" tickFormatter={(v) => formatINR(v / 1000) + 'k'} />
                <YAxis dataKey="city" type="category" width={100} />
                <Tooltip formatter={(v: any) => formatINR(v)} />
                <Bar dataKey="gmv" fill="#FF6B35" radius={[0, 6, 6, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function FunnelBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div>
      <div className="flex justify-between text-sm mb-1">
        <span>{label}</span>
        <span><strong>{value}</strong> <span className="text-muted-foreground">({pct.toFixed(0)}%)</span></span>
      </div>
      <div className="h-3 bg-muted rounded overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// Push 20d — small KPI tile used by the P&L summary row.
function PnlTile({ label, value, sub, tone }: { label: string; value: number | undefined; sub?: string; tone: 'emerald' | 'amber' | 'rose' }) {
  const bg = tone === 'emerald' ? 'bg-emerald-50 border-emerald-200'
          : tone === 'amber'   ? 'bg-amber-50 border-amber-200'
                               : 'bg-rose-50 border-rose-200';
  const fg = tone === 'emerald' ? 'text-emerald-800'
          : tone === 'amber'   ? 'text-amber-800'
                               : 'text-rose-800';
  return (
    <div className={`rounded-md border p-3 ${bg}`}>
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`text-xl font-bold tabular-nums ${fg}`}>
        {value == null ? '—' : formatINR(value)}
      </div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

function Heat({ pct }: { pct: number }) {
  // 0 → muted, 50 → amber, 100 → green
  const bg = pct >= 70 ? 'bg-emerald-200 text-emerald-900'
           : pct >= 40 ? 'bg-amber-200 text-amber-900'
           : pct >= 10 ? 'bg-orange-200 text-orange-900'
           : 'bg-muted text-muted-foreground';
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-bold ${bg}`}>{pct}%</span>
  );
}
