import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AreaChart, Area, XAxis, YAxis, ResponsiveContainer, Tooltip, BarChart, Bar, CartesianGrid,
  PieChart, Pie, Cell, Legend,
} from 'recharts';
import { toast } from 'sonner';
import { Download, FileSpreadsheet, FileText } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { ffApi } from '@/api/namastepos';
import { api, apiError, getBusinessCache } from '@/api/client';
import { formatINR } from '@/lib/utils';

type TabId = 'pnl' | 'income' | 'expense' | 'invoices' | 'daily' | 'monthly' | 'tips';

// ── Report charts — mobile parity (2026-08-25) ───────────────────────
// The Flutter reports screens (reports_screen.dart, monthly_report.dart)
// render pies/bars via fl_chart; the web dashboard only had the monthly
// area chart. The blocks below reuse data the page ALREADY fetches
// (dailyReport, incomeRegister, expenseRegister, monthlyReport) — no
// new endpoints were added.

// WHY (2026-08-25): mirrors AppColors.chartPalette in
// namastepos_flutter/lib/constants/colors.dart so web and mobile
// reports read the same. Keep the two lists in sync.
const CHART_COLORS = ['#FF6B35', '#2EC4B6', '#FFB627', '#8B5CF6', '#3B82F6', '#EC4899'];

// WHY (2026-08-25): raw INR axis labels overflow the axis gutter above
// ₹99,999, so compact to Indian k/L units for ticks only. Tooltips and
// tables keep full formatINR precision.
function inrAxisTick(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 100000) return `₹${(v / 100000).toFixed(1)}L`;
  if (abs >= 1000) return `₹${(v / 1000).toFixed(0)}k`;
  return `₹${v}`;
}

function ChartEmpty({ msg }: { msg: string }) {
  return (
    <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
      {msg}
    </div>
  );
}

export function ReportsPage() {
  const [tab, setTab] = useState<TabId>('pnl');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));

  // Push 15 — shared date range for all detail-style reports
  const firstOfMonth = new Date(); firstOfMonth.setDate(1);
  const [pnlStart, setPnlStart] = useState(firstOfMonth.toISOString().slice(0, 10));
  const [pnlEnd,   setPnlEnd]   = useState(new Date().toISOString().slice(0, 10));

  const pnl = useQuery({
    queryKey: ['income-statement', pnlStart, pnlEnd],
    queryFn:  () => ffApi.incomeStatement(pnlStart, pnlEnd),
    enabled: tab === 'pnl',
  });
  const incomeReg = useQuery({
    queryKey: ['income-register', pnlStart, pnlEnd],
    queryFn:  () => ffApi.incomeRegister(pnlStart, pnlEnd),
    enabled: tab === 'income',
  });
  const expenseReg = useQuery({
    queryKey: ['expense-register', pnlStart, pnlEnd],
    queryFn:  () => ffApi.expenseRegister(pnlStart, pnlEnd),
    enabled: tab === 'expense',
  });
  const invoiceReg = useQuery({
    queryKey: ['invoice-register', pnlStart, pnlEnd],
    queryFn:  () => ffApi.invoiceRegister(pnlStart, pnlEnd),
    enabled: tab === 'invoices',
  });

  const [exporting, setExporting] = useState<'pdf' | 'xlsx' | 'csv' | null>(null);
  const exportPnl = async (format: 'pdf' | 'xlsx' | 'csv') => {
    setExporting(format);
    try {
      await ffApi.downloadIncomeStatement(format, pnlStart, pnlEnd);
      toast.success(`${format.toUpperCase()} ready`);
    } catch (e) { toast.error(apiError(e)); }
    finally { setExporting(null); }
  };
  const exportIncomeReg = async (format: 'pdf' | 'xlsx' | 'csv') => {
    setExporting(format);
    try {
      await ffApi.downloadIncomeRegister(format, pnlStart, pnlEnd);
      toast.success(`${format.toUpperCase()} ready`);
    } catch (e) { toast.error(apiError(e)); }
    finally { setExporting(null); }
  };
  const exportExpenseReg = async (format: 'pdf' | 'xlsx' | 'csv') => {
    setExporting(format);
    try {
      await ffApi.downloadExpenseRegister(format, pnlStart, pnlEnd);
      toast.success(`${format.toUpperCase()} ready`);
    } catch (e) { toast.error(apiError(e)); }
    finally { setExporting(null); }
  };
  const exportInvoiceReg = async (format: 'pdf' | 'xlsx' | 'csv') => {
    setExporting(format);
    try {
      await ffApi.downloadInvoiceRegister(format, pnlStart, pnlEnd);
      toast.success(`${format.toUpperCase()} ready`);
    } catch (e) { toast.error(apiError(e)); }
    finally { setExporting(null); }
  };

  const daily = useQuery({
    queryKey: ['daily', date], queryFn: () => ffApi.dailyReport(date),
    enabled: tab === 'daily',
  });
  const monthly = useQuery({
    queryKey: ['monthly', month], queryFn: () => ffApi.monthlyReport(month),
    enabled: tab === 'monthly',
  });
  // FF-903-c tip report — per-server tip totals + count for the same
  // date range as the P&L / registers tabs. Backend endpoint existed;
  // owners couldn't reach it. Enabled only when this tab is active
  // so the query doesn't fire on every Reports page load.
  const tips = useQuery({
    // Backend service reads startDate/endDate from req.query — not
    // from/to. Passing the wrong names silently returns every tip
    // ever recorded, so keep these aligned with membershipService.
    queryKey: ['tip-report', pnlStart, pnlEnd],
    queryFn: () => ffApi.tipReport({ startDate: pnlStart, endDate: pnlEnd }),
    enabled: tab === 'tips',
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Reports</h1>
        <p className="text-muted-foreground">Daily and monthly P&L.</p>
      </div>

      <div className="flex gap-2 border-b overflow-x-auto">
        {([
          { id: 'pnl',      label: 'P&L statement' },
          { id: 'income',   label: 'Income register' },
          { id: 'expense',  label: 'Expense register' },
          { id: 'invoices', label: 'Invoice register' },
          { id: 'daily',    label: 'Daily' },
          { id: 'monthly',  label: 'Monthly' },
          { id: 'tips',     label: 'Tips (per server)' },
        ] as const).map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id as TabId)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
              tab === t.id ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >{t.label}</button>
        ))}
      </div>

      {(tab === 'income' || tab === 'expense' || tab === 'invoices') && (
        <Card>
          <CardHeader>
            <CardTitle>
              {tab === 'income' && 'Income Register'}
              {tab === 'expense' && 'Expense Register'}
              {tab === 'invoices' && 'Tax Invoice Register'}
            </CardTitle>
            <CardDescription>
              {tab === 'income' && 'Every sale with GST split, suitable for cross-checking against GSTR-1.'}
              {tab === 'expense' && 'Every expense logged, grouped by category for the audit footer.'}
              {tab === 'invoices' && 'Every tax invoice issued — sequential within the financial year.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-end gap-3">
              <div><Label>From</Label><Input type="date" value={pnlStart} onChange={(e) => setPnlStart(e.target.value)} /></div>
              <div><Label>To</Label>  <Input type="date" value={pnlEnd}   onChange={(e) => setPnlEnd(e.target.value)} /></div>
              <div className="flex-1" />
              <Button variant="outline" disabled={!!exporting}
                  onClick={() => {
                    if (tab === 'income') exportIncomeReg('pdf');
                    if (tab === 'expense') exportExpenseReg('pdf');
                    if (tab === 'invoices') exportInvoiceReg('pdf');
                  }}>
                <FileText className="mr-2 h-4 w-4" />{exporting === 'pdf' ? '...' : 'Export PDF'}
              </Button>
              <Button variant="outline" disabled={!!exporting}
                  onClick={() => {
                    if (tab === 'income') exportIncomeReg('xlsx');
                    if (tab === 'expense') exportExpenseReg('xlsx');
                    if (tab === 'invoices') exportInvoiceReg('xlsx');
                  }}>
                <FileSpreadsheet className="mr-2 h-4 w-4" />{exporting === 'xlsx' ? '...' : 'Export Excel'}
              </Button>
              <Button variant="outline" disabled={!!exporting}
                  onClick={() => {
                    if (tab === 'income') exportIncomeReg('csv');
                    if (tab === 'expense') exportExpenseReg('csv');
                    if (tab === 'invoices') exportInvoiceReg('csv');
                  }}>
                <Download className="mr-2 h-4 w-4" />{exporting === 'csv' ? '...' : 'Export CSV'}
              </Button>
              {/* FF-323 — GSTR CSVs for CA. Available on the invoice
                  register tab only, since the columns come from tax
                  invoices. */}
              {/* Hardcode-audit fix (2026-08-24): was reading the nonexistent
                  'ff_business' localStorage key (client stores
                  'ff_dash_business'), so the business id was always '' and
                  the URL malformed; also bypassed VITE_API_URL. Now uses
                  the shared client's business cache + resolved base URL. */}
              {tab === 'invoices' && (
                <>
                  <Button variant="outline"
                    onClick={() => window.open(
                      `${api.defaults.baseURL}/businesses/${getBusinessCache()?.id ?? ''}/reports/gstr1.csv?from=${pnlStart}&to=${pnlEnd}`,
                      '_blank')}>
                    <Download className="mr-2 h-4 w-4" /> GSTR-1 CSV
                  </Button>
                  <Button variant="outline"
                    onClick={() => window.open(
                      `${api.defaults.baseURL}/businesses/${getBusinessCache()?.id ?? ''}/reports/gstr3b.csv?from=${pnlStart}&to=${pnlEnd}`,
                      '_blank')}>
                    <Download className="mr-2 h-4 w-4" /> GSTR-3B CSV
                  </Button>
                </>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {tab === 'income' && (
        <>
          {incomeReg.isLoading && <div className="py-8 text-center text-muted-foreground">Loading…</div>}
          {incomeReg.error && <RegisterError error={incomeReg.error} refetch={() => incomeReg.refetch()} />}
          {/* Mobile parity (2026-08-25): revenue-by-day bar for the selected
              period, aggregated client-side from register rows. */}
          {incomeReg.data && <RevenueByDayChart rows={incomeReg.data.rows ?? []} />}
          {incomeReg.data && <IncomeRegisterTable data={incomeReg.data} />}
        </>
      )}
      {tab === 'expense' && (
        <>
          {expenseReg.isLoading && <div className="py-8 text-center text-muted-foreground">Loading…</div>}
          {expenseReg.error && <RegisterError error={expenseReg.error} refetch={() => expenseReg.refetch()} />}
          {/* Mobile parity (2026-08-25): category split pie fed by the
              register's existing per-category summary. */}
          {expenseReg.data && <ExpenseCategoryPie slices={expenseReg.data.summary ?? []} />}
          {expenseReg.data && <ExpenseRegisterTable data={expenseReg.data} />}
        </>
      )}
      {tab === 'invoices' && (
        <>
          {invoiceReg.isLoading && <div className="py-8 text-center text-muted-foreground">Loading…</div>}
          {invoiceReg.error && <RegisterError error={invoiceReg.error} refetch={() => invoiceReg.refetch()} />}
          {invoiceReg.data && <InvoiceRegisterTable data={invoiceReg.data} />}
        </>
      )}

      {/* FF-903-c per-server tips report */}
      {tab === 'tips' && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Tips by server</CardTitle>
              <CardDescription>
                Every tip recorded in the selected window, aggregated per server.
                Useful for weekly payouts and shift bonuses.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-end gap-3">
                <div><Label>From</Label><Input type="date" value={pnlStart} onChange={(e) => setPnlStart(e.target.value)} /></div>
                <div><Label>To</Label>  <Input type="date" value={pnlEnd}   onChange={(e) => setPnlEnd(e.target.value)} /></div>
              </div>
            </CardContent>
          </Card>

          {tips.isLoading && <div className="py-8 text-center text-muted-foreground">Loading…</div>}
          {tips.error && <RegisterError error={tips.error} refetch={() => tips.refetch()} />}
          {tips.data && <TipReportTable data={tips.data} />}
        </>
      )}

      {tab === 'pnl' && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Statement of Profit &amp; Loss</CardTitle>
              <CardDescription>
                Schedule III–style income statement. Includes revenue from operations, COGS,
                operating expenses, EBITDA, and a memorandum of GST collected.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-end gap-3">
                <div><Label>From</Label><Input type="date" value={pnlStart} onChange={(e) => setPnlStart(e.target.value)} /></div>
                <div><Label>To</Label>  <Input type="date" value={pnlEnd}   onChange={(e) => setPnlEnd(e.target.value)} /></div>
                <div className="flex-1" />
                <Button variant="outline" disabled={!!exporting} onClick={() => exportPnl('pdf')}>
                  <FileText className="mr-2 h-4 w-4" />{exporting === 'pdf' ? 'Generating…' : 'Export PDF'}
                </Button>
                <Button variant="outline" disabled={!!exporting} onClick={() => exportPnl('xlsx')}>
                  <FileSpreadsheet className="mr-2 h-4 w-4" />{exporting === 'xlsx' ? '...' : 'Export Excel'}
                </Button>
                <Button variant="outline" disabled={!!exporting} onClick={() => exportPnl('csv')}>
                  <Download className="mr-2 h-4 w-4" />{exporting === 'csv' ? '...' : 'Export CSV'}
                </Button>
              </div>
            </CardContent>
          </Card>

          {pnl.isLoading && <div className="py-8 text-center text-muted-foreground">Building report…</div>}
          {pnl.error && (
            <Card className="border-destructive">
              <CardContent className="p-6 text-sm">
                <div className="font-semibold text-destructive mb-2">Couldn't load the P&amp;L</div>
                <div className="text-muted-foreground">{apiError(pnl.error)}</div>
                <div className="text-xs text-muted-foreground mt-2">
                  If you just installed Push 15, restart the backend and run <code className="bg-muted px-1 rounded">npm run migrate</code>.
                  Check the server console for a <code className="bg-muted px-1 rounded">[reports.incomeStatement]</code> message
                  that names the failing query.
                </div>
                <Button variant="outline" size="sm" className="mt-3" onClick={() => pnl.refetch()}>
                  Retry
                </Button>
              </CardContent>
            </Card>
          )}
          {pnl.data && <PnlStatement data={pnl.data} />}
        </>
      )}

      {tab === 'daily' && (
        <>
          <div className="flex items-end gap-3">
            <div><Label>Date</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Kpi label="Revenue" value={formatINR(daily.data?.revenue?.total ?? 0)} />
            <Kpi label="Expenses" value={formatINR(daily.data?.expenses?.total ?? 0)} />
            <Kpi label="Profit" value={formatINR(daily.data?.profit ?? 0)} />
            <Kpi label="Margin" value={`${(daily.data?.margin ?? 0).toFixed(0)}%`} />
          </div>
          {/* Mobile parity (2026-08-25): reports_screen.dart shows a
              top-items chart and an expense split for the day; render the
              same from the dailyReport payload this tab already fetches. */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <TopItemsChart items={daily.data?.topItems ?? []} />
            <ExpenseCategoryPie
              title="Expenses by category"
              // WHY (2026-08-25): dailyReport.expenses arrives flattened as
              // { [category]: amount, total } — strip the `total` key so the
              // pie doesn't double-count the whole day as a slice.
              slices={Object.entries((daily.data?.expenses ?? {}) as Record<string, number>)
                .filter(([k]) => k !== 'total')
                .map(([category, amount]) => ({ category, amount: Number(amount) }))}
            />
          </div>
          <Card>
            <CardHeader><CardTitle>Top items</CardTitle></CardHeader>
            <CardContent>
              {(daily.data?.topItems || []).map((it: any, i: number) => (
                <div key={i} className="flex justify-between py-2 border-b last:border-0">
                  <span>{it.qty} × {it.name}</span>
                  <span className="text-muted-foreground">{formatINR(it.revenue)}</span>
                </div>
              ))}
              {(daily.data?.topItems || []).length === 0 && <div className="py-6 text-center text-muted-foreground">No sales.</div>}
            </CardContent>
          </Card>
        </>
      )}

      {tab === 'monthly' && (
        <>
          <div className="flex items-end gap-3">
            <div><Label>Month</Label><Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <Kpi label="Revenue" value={formatINR(monthly.data?.totalRevenue ?? 0)} />
            <Kpi label="Expenses" value={formatINR(monthly.data?.totalExpenses ?? 0)} />
            <Kpi label="Profit" value={formatINR(monthly.data?.profit ?? 0)} />
            <Kpi label="Margin" value={`${(monthly.data?.margin ?? 0).toFixed(0)}%`} />
          </div>
          <Card>
            <CardHeader><CardTitle>Daily series</CardTitle></CardHeader>
            <CardContent className="h-80">
              {(monthly.data?.series || []).length === 0 ? (
                <ChartEmpty msg="No activity recorded this month." />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={monthly.data?.series || []}>
                    <defs>
                      <linearGradient id="rev" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#FF6B35" stopOpacity={0.4} />
                        <stop offset="100%" stopColor="#FF6B35" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="exp" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#2EC4B6" stopOpacity={0.25} />
                        <stop offset="100%" stopColor="#2EC4B6" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="date" fontSize={11} />
                    {/* 2026-08-25: INR ticks + ₹ tooltip — axis previously
                        showed bare numbers, breaking the page's ₹ convention. */}
                    <YAxis fontSize={11} tickFormatter={inrAxisTick} width={52} />
                    <Tooltip formatter={(v: any) => formatINR(Number(v))} />
                    <Legend />
                    <Area type="monotone" dataKey="revenue" name="Revenue" stroke="#FF6B35" fill="url(#rev)" strokeWidth={2} />
                    {/* 2026-08-25: monthlyReport.series already carries a
                        per-day `expenses` value — plot it so owners see the
                        spend line the same way mobile P&L implies it. */}
                    <Area type="monotone" dataKey="expenses" name="Expenses" stroke="#2EC4B6" fill="url(#exp)" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="text-2xl font-bold tracking-tight">{value}</div>
        <div className="text-sm text-muted-foreground">{label}</div>
      </CardContent>
    </Card>
  );
}

// ── Mobile-parity charts (2026-08-25) ────────────────────────────────

// Revenue-by-day bar for the selected From/To period (Income register
// tab). WHY (2026-08-25): the income register already returns every
// order in the window, so grouping client-side avoids inventing a new
// /reports endpoint just for a series. en-CA locale gives a sortable
// YYYY-MM-DD key in the browser's local calendar day — the same day the
// register table itself displays via en-IN formatting.
function RevenueByDayChart({ rows }: { rows: Array<{ createdAt: string; total: number | string }> }) {
  const byDay = new Map<string, number>();
  for (const r of rows) {
    const key = new Date(r.createdAt).toLocaleDateString('en-CA');
    byDay.set(key, (byDay.get(key) ?? 0) + Number(r.total ?? 0));
  }
  const series = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, revenue]) => ({
      label: new Date(`${date}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }),
      revenue,
    }));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Revenue by day</CardTitle>
        <CardDescription>Order totals per day across the selected period.</CardDescription>
      </CardHeader>
      <CardContent className="h-72">
        {series.length === 0 ? (
          <ChartEmpty msg="No sales in this range." />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={series}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="label" fontSize={11} />
              <YAxis fontSize={11} tickFormatter={inrAxisTick} width={52} />
              <Tooltip formatter={(v: any) => formatINR(Number(v))} />
              <Bar dataKey="revenue" name="Revenue" fill="#FF6B35" radius={[4, 4, 0, 0]} maxBarSize={36} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

// Top items as a horizontal bar (Daily tab) — matches the fl_chart
// top-items visual in reports_screen.dart. Data comes straight from
// dailyReport.topItems (already limited to 5 server-side).
function TopItemsChart({ items }: { items: Array<{ name: string; qty: number; revenue: number }> }) {
  const data = items.map((it) => ({
    name: it.name,
    qty: Number(it.qty ?? 0),
    revenue: Number(it.revenue ?? 0),
  }));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Top items by revenue</CardTitle>
        <CardDescription>Best sellers for the selected day.</CardDescription>
      </CardHeader>
      <CardContent className="h-72">
        {data.length === 0 ? (
          <ChartEmpty msg="No sales." />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
              <XAxis type="number" fontSize={11} tickFormatter={inrAxisTick} />
              <YAxis
                type="category"
                dataKey="name"
                width={120}
                fontSize={11}
                // WHY (2026-08-25): long dish names squeeze the plot area to
                // nothing; recharts has no built-in ellipsis, so cap at 16.
                tickFormatter={(n: string) => (n.length > 16 ? `${n.slice(0, 15)}…` : n)}
              />
              <Tooltip formatter={(v: any) => formatINR(Number(v))} />
              <Bar dataKey="revenue" name="Revenue" radius={[0, 4, 4, 0]} maxBarSize={22}>
                {data.map((_, i) => (
                  <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

// Expense split donut — fed by expenseRegister.summary (period) or the
// flattened dailyReport.expenses map (single day). Matches the category
// split visual in the Flutter reports screen.
function ExpenseCategoryPie({
  slices,
  title,
}: {
  slices: Array<{ category: string; amount: number | string }>;
  title?: string;
}) {
  const data = slices
    .map((s) => ({
      name: (s.category || 'other').replace(/_/g, ' '),
      value: Number(s.amount ?? 0),
    }))
    .filter((s) => s.value > 0);
  const total = data.reduce((sum, d) => sum + d.value, 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title ?? 'Expense split by category'}</CardTitle>
        <CardDescription>
          {total > 0 ? `${formatINR(total)} total` : 'Where the money went.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="h-72">
        {data.length === 0 ? (
          <ChartEmpty msg="No expenses recorded." />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                dataKey="value"
                nameKey="name"
                innerRadius="45%"
                outerRadius="72%"
                paddingAngle={3}
                labelLine={false}
                // WHY (2026-08-25): percent labels like mobile's pie; amounts
                // live in the tooltip to keep small slices readable.
                label={(p: any) => `${((p.percent ?? 0) * 100).toFixed(0)}%`}
              >
                {data.map((_, i) => (
                  <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip formatter={(v: any) => formatINR(Number(v))} />
              <Legend
                formatter={(name: any) => (
                  <span className="capitalize text-xs text-foreground">{name}</span>
                )}
              />
            </PieChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

// Push 15 — Schedule III income statement viewer
function PnlStatement({ data }: { data: any }) {
  const m = data?.meta;
  const r = data?.revenue;
  const opex: any[] = data?.operatingExpenses || [];
  const taxes = data?.indirectTaxesCollected || { cgst: 0, sgst: 0, igst: 0, total: 0 };
  return (
    <Card>
      <CardHeader className="border-b">
        <div className="text-center">
          <CardTitle className="text-xl">{m?.business?.name || ''}</CardTitle>
          {m?.business?.address && (
            <div className="text-xs text-muted-foreground">{m.business.address}</div>
          )}
          <div className="text-xs text-muted-foreground">
            {m?.business?.gstin && <>GSTIN: {m.business.gstin}{' • '}</>}
            {m?.business?.phone}
          </div>
          <div className="mt-2 font-semibold">Statement of Profit &amp; Loss</div>
          <div className="text-xs text-muted-foreground">
            For the period {m?.period?.startDate} to {m?.period?.endDate}
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase tracking-wider">
            <tr>
              <th className="text-left py-2 px-4">Particulars</th>
              <th className="text-right py-2 px-4 w-44">Amount (INR)</th>
            </tr>
          </thead>
          <tbody>
            <SectionRow title="I. Revenue from operations" />
            {(r?.fromOperations || []).map((x: any) => (
              <DetailRow key={x.source} label={x.label} amt={x.grossValue} />
            ))}
            <TotalRow label="Gross revenue" amt={r?.grossRevenue || 0} />
            <DetailRow label="Less: GST collected (pass-through)" amt={taxes.total} />
            <TotalRow label="II. Net revenue" amt={r?.netRevenue || 0} />

            <SectionRow title="III. Cost of goods sold (COGS)" />
            <DetailRow label="Ingredients"  amt={data?.cogs?.ingredients} />
            <DetailRow label="Wastage"      amt={data?.cogs?.wastage} />
            <TotalRow  label="Total COGS"   amt={data?.cogs?.total || 0} />

            <TotalRow label="IV. Gross profit (II - III)" amt={data?.grossProfit || 0} highlight />

            <SectionRow title="V. Operating expenses" />
            {opex.map((e: any) => (
              <DetailRow key={e.category} label={e.label} amt={e.amount} />
            ))}
            <TotalRow label="Total operating expenses" amt={data?.totalOperatingExpenses || 0} />

            <TotalRow label="VI. EBITDA (IV - V)"   amt={data?.ebitda || 0} highlight />
            <DetailRow label="VII. Depreciation"    amt={data?.depreciation} />
            <DetailRow label="VIII. Finance costs"  amt={data?.financeCosts} />
            <DetailRow label="IX. Tax expense"      amt={data?.taxExpense} />

            <TotalRow
              label="X. NET PROFIT / (LOSS)"
              amt={data?.netProfit || 0}
              highlight
              big
            />
            <tr className="border-t">
              <td className="py-2 px-4 italic text-muted-foreground">Net margin %</td>
              <td className="py-2 px-4 text-right">{data?.netMargin}%</td>
            </tr>

            <SectionRow title="GST collected — memorandum" />
            <DetailRow label="CGST" amt={taxes.cgst} />
            <DetailRow label="SGST" amt={taxes.sgst} />
            <DetailRow label="IGST" amt={taxes.igst} />
            <TotalRow  label="Total GST collected" amt={taxes.total} />
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
function SectionRow({ title }: { title: string }) {
  return (
    <tr className="bg-muted/30">
      <td colSpan={2} className="py-2 px-4 font-semibold text-xs uppercase tracking-wider">{title}</td>
    </tr>
  );
}
function DetailRow({ label, amt }: { label: string; amt: number | undefined }) {
  return (
    <tr className="border-b last:border-0">
      <td className="py-1.5 px-8">{label}</td>
      <td className="py-1.5 px-4 text-right tabular-nums">{formatINR(amt ?? 0)}</td>
    </tr>
  );
}
function TotalRow({ label, amt, highlight, big }: { label: string; amt: number; highlight?: boolean; big?: boolean }) {
  return (
    <tr className={`border-t ${highlight ? 'bg-amber-50' : ''}`}>
      <td className={`py-2 px-4 ${big ? 'text-lg font-extrabold' : 'font-bold'}`}>{label}</td>
      <td className={`py-2 px-4 text-right tabular-nums ${big ? 'text-lg font-extrabold' : 'font-bold'}`}>
        {formatINR(amt)}
      </td>
    </tr>
  );
}

// ── Push 15h — register tables ────────────────────────────────────────
function RegisterError({ error, refetch }: { error: unknown; refetch: () => void }) {
  return (
    <Card className="border-destructive">
      <CardContent className="p-6 text-sm">
        <div className="font-semibold text-destructive mb-2">Couldn't load report</div>
        <div className="text-muted-foreground">{apiError(error)}</div>
        <Button variant="outline" size="sm" className="mt-3" onClick={refetch}>Retry</Button>
      </CardContent>
    </Card>
  );
}

function RegisterHeader({ meta, title }: { meta: any; title: string }) {
  return (
    <CardHeader className="border-b">
      <div className="text-center">
        <CardTitle className="text-xl">{meta?.business?.name || ''}</CardTitle>
        {meta?.business?.address && (
          <div className="text-xs text-muted-foreground">{meta.business.address}</div>
        )}
        <div className="text-xs text-muted-foreground">
          {meta?.business?.gstin && <>GSTIN: {meta.business.gstin}{' • '}</>}
          {meta?.business?.phone}
        </div>
        <div className="mt-2 font-semibold">{title}</div>
        <div className="text-xs text-muted-foreground">
          For the period {meta?.period?.startDate} to {meta?.period?.endDate}
        </div>
      </div>
    </CardHeader>
  );
}

function IncomeRegisterTable({ data }: { data: any }) {
  const rows: any[] = data?.rows || [];
  const t = data?.totals || {};
  return (
    <Card>
      <RegisterHeader meta={data?.meta} title="Income Register" />
      <CardContent className="p-0 overflow-x-auto">
        {rows.length === 0 ? (
          <div className="py-12 text-center text-muted-foreground">No sales in this range.</div>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-muted/40">
              <tr>
                <th className="text-left py-2 px-3">Date</th>
                <th className="text-left py-2 px-3">Time</th>
                <th className="text-left py-2 px-3">Order #</th>
                <th className="text-left py-2 px-3">Source</th>
                <th className="text-left py-2 px-3">Customer</th>
                <th className="text-right py-2 px-3">Taxable</th>
                <th className="text-right py-2 px-3">CGST</th>
                <th className="text-right py-2 px-3">SGST</th>
                <th className="text-right py-2 px-3">IGST</th>
                <th className="text-right py-2 px-3">Discount</th>
                <th className="text-right py-2 px-3">Total</th>
                <th className="text-left py-2 px-3">Payment</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const d = new Date(r.createdAt);
                return (
                  <tr key={r.id} className="border-t hover:bg-muted/30">
                    <td className="py-1.5 px-3">{d.toLocaleDateString('en-IN')}</td>
                    <td className="py-1.5 px-3">{d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</td>
                    <td className="py-1.5 px-3 font-mono">{r.orderNo || '—'}</td>
                    <td className="py-1.5 px-3 capitalize">{(r.source || '').replace(/_/g, ' ')}</td>
                    <td className="py-1.5 px-3">{r.customerName || '—'}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{formatINR(r.taxableValue)}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{formatINR(r.cgst)}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{formatINR(r.sgst)}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{formatINR(r.igst)}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{formatINR(r.discount)}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums font-semibold">{formatINR(r.total)}</td>
                    <td className="py-1.5 px-3">{r.paymentMethod || '—'}</td>
                  </tr>
                );
              })}
              <tr className="bg-amber-50 border-t-2 border-amber-300 font-bold">
                <td className="py-2 px-3" colSpan={5}>TOTALS · {t.orderCount} orders</td>
                <td className="py-2 px-3 text-right tabular-nums">{formatINR(t.taxableValue)}</td>
                <td className="py-2 px-3 text-right tabular-nums">{formatINR(t.cgst)}</td>
                <td className="py-2 px-3 text-right tabular-nums">{formatINR(t.sgst)}</td>
                <td className="py-2 px-3 text-right tabular-nums">{formatINR(t.igst)}</td>
                <td className="py-2 px-3 text-right tabular-nums">{formatINR(t.discount)}</td>
                <td className="py-2 px-3 text-right tabular-nums">{formatINR(t.total)}</td>
                <td></td>
              </tr>
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

function ExpenseRegisterTable({ data }: { data: any }) {
  const rows: any[] = data?.rows || [];
  const summary: any[] = data?.summary || [];
  const t = data?.totals || {};
  return (
    <>
      <Card>
        <RegisterHeader meta={data?.meta} title="Expense Register" />
        <CardContent className="p-0 overflow-x-auto">
          {rows.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground">No expenses in this range.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/40">
                <tr>
                  <th className="text-left py-2 px-3">Date</th>
                  <th className="text-left py-2 px-3">Category</th>
                  <th className="text-left py-2 px-3">Description</th>
                  <th className="text-right py-2 px-3">Amount</th>
                  <th className="text-left py-2 px-3">Receipt</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const d = r.date ? new Date(r.date) : null;
                  return (
                    <tr key={r.id} className="border-t hover:bg-muted/30">
                      <td className="py-1.5 px-3">{d ? d.toLocaleDateString('en-IN') : '—'}</td>
                      <td className="py-1.5 px-3 capitalize">{(r.category || '').replace(/_/g, ' ')}</td>
                      <td className="py-1.5 px-3">{r.description || '—'}</td>
                      <td className="py-1.5 px-3 text-right tabular-nums font-semibold">{formatINR(r.amount)}</td>
                      <td className="py-1.5 px-3">
                        {r.receiptUrl ? <a href={r.receiptUrl} target="_blank" rel="noreferrer" className="text-primary underline">View</a> : '—'}
                      </td>
                    </tr>
                  );
                })}
                <tr className="bg-amber-50 border-t-2 border-amber-300 font-bold">
                  <td colSpan={3} className="py-2 px-3">TOTAL · {t.entryCount} entries</td>
                  <td className="py-2 px-3 text-right tabular-nums">{formatINR(t.total)}</td>
                  <td></td>
                </tr>
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
      {summary.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">By category</CardTitle></CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <tbody>
                {summary.map((s) => (
                  <tr key={s.category} className="border-t">
                    <td className="py-1.5 px-3 capitalize">{(s.category || '').replace(/_/g, ' ')}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{formatINR(s.amount)}</td>
                  </tr>
                ))}
                <tr className="bg-amber-50 border-t-2 border-amber-300 font-bold">
                  <td className="py-2 px-3">TOTAL</td>
                  <td className="py-2 px-3 text-right tabular-nums">{formatINR(t.total)}</td>
                </tr>
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </>
  );
}

function InvoiceRegisterTable({ data }: { data: any }) {
  const rows: any[] = data?.rows || [];
  const t = data?.totals || {};
  return (
    <Card>
      <RegisterHeader meta={data?.meta} title="Tax Invoice Register" />
      <CardContent className="p-0 overflow-x-auto">
        {rows.length === 0 ? (
          <div className="py-12 text-center text-muted-foreground">
            No tax invoices in this range. Invoices are issued automatically when an order is collected.
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-muted/40">
              <tr>
                <th className="text-left py-2 px-3">Invoice No</th>
                <th className="text-left py-2 px-3">Date</th>
                <th className="text-left py-2 px-3">Recipient</th>
                <th className="text-left py-2 px-3">GSTIN</th>
                <th className="text-left py-2 px-3">PoS</th>
                <th className="text-right py-2 px-3">Taxable</th>
                <th className="text-right py-2 px-3">CGST</th>
                <th className="text-right py-2 px-3">SGST</th>
                <th className="text-right py-2 px-3">IGST</th>
                <th className="text-right py-2 px-3">Total</th>
                <th className="text-left py-2 px-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const d = new Date(r.invoiceDate);
                const isCancelled = r.status === 'cancelled';
                return (
                  <tr key={r.id} className={`border-t hover:bg-muted/30 ${isCancelled ? 'opacity-50 line-through' : ''}`}>
                    <td className="py-1.5 px-3 font-mono">{r.invoiceNo}</td>
                    <td className="py-1.5 px-3">{d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                    <td className="py-1.5 px-3">{r.recipientName || '—'}</td>
                    <td className="py-1.5 px-3 font-mono">{r.recipientGstin || '—'}</td>
                    <td className="py-1.5 px-3">{r.placeOfSupply || '—'}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{formatINR(r.taxableValue)}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{formatINR(r.cgst)}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{formatINR(r.sgst)}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{formatINR(r.igst)}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums font-semibold">{formatINR(r.total)}</td>
                    <td className="py-1.5 px-3">{r.status}</td>
                  </tr>
                );
              })}
              <tr className="bg-amber-50 border-t-2 border-amber-300 font-bold">
                <td colSpan={5} className="py-2 px-3">
                  TOTALS · {t.invoiceCount} issued
                  {t.cancelledCount > 0 && <span className="font-normal text-muted-foreground ml-2">({t.cancelledCount} cancelled excluded)</span>}
                </td>
                <td className="py-2 px-3 text-right tabular-nums">{formatINR(t.taxableValue)}</td>
                <td className="py-2 px-3 text-right tabular-nums">{formatINR(t.cgst)}</td>
                <td className="py-2 px-3 text-right tabular-nums">{formatINR(t.sgst)}</td>
                <td className="py-2 px-3 text-right tabular-nums">{formatINR(t.igst)}</td>
                <td className="py-2 px-3 text-right tabular-nums">{formatINR(t.total)}</td>
                <td></td>
              </tr>
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

// FF-903-c tip report. Backend returns an array of rows with shape:
//   { server_user_id, tip_count, total_inr }
// Owner-friendly rendering: totals up top, per-server table underneath.
// server_user_id is a UUID; we truncate it and label servers whose id
// is null as "Unassigned".
function TipReportTable({ data }: { data: any }) {
  const rows: Array<{ server_user_id: string | null; tip_count: number; total_inr: number }> =
    Array.isArray(data) ? data : (data?.rows ?? []);
  const totalTips = rows.reduce((s, r) => s + Number(r.total_inr ?? 0), 0);
  const totalCount = rows.reduce((s, r) => s + Number(r.tip_count ?? 0), 0);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle>Per-server tips</CardTitle>
          <CardDescription>{totalCount} tips totalling {formatINR(totalTips)}</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No tips recorded in this window.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b bg-muted/40">
                <th className="py-2 px-3">Server</th>
                <th className="py-2 px-3 text-right">Tips</th>
                <th className="py-2 px-3 text-right">Total</th>
                <th className="py-2 px-3 text-right">Avg / tip</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const avg = r.tip_count > 0
                  ? Number(r.total_inr) / Number(r.tip_count)
                  : 0;
                const label = r.server_user_id
                  ? `Server ${String(r.server_user_id).slice(0, 8)}…`
                  : 'Unassigned';
                return (
                  <tr key={i} className="border-b hover:bg-muted/20">
                    <td className="py-1.5 px-3 font-mono text-xs">{label}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{r.tip_count}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums font-semibold">{formatINR(r.total_inr)}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{formatINR(avg)}</td>
                  </tr>
                );
              })}
              <tr className="bg-amber-50 border-t-2 border-amber-300 font-bold">
                <td className="py-2 px-3">TOTAL</td>
                <td className="py-2 px-3 text-right tabular-nums">{totalCount}</td>
                <td className="py-2 px-3 text-right tabular-nums">{formatINR(totalTips)}</td>
                <td></td>
              </tr>
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
