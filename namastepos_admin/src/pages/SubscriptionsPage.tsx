import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { adminApi } from '@/api/admin';
import { apiError } from '@/api/client';
import { formatINR, formatDateTime } from '@/lib/utils';
import { SUBSCRIPTION_STATUSES, subscriptionStatusVariant } from '@/lib/plans';

// N4 (2026-08-27): consolidated subscription / invoice ledger. One operable
// view of every tenant subscription — plan, status, next-charge, trial, and
// whether it's PAID (Razorpay), COMPED (manual grant) or FREE. Finance no
// longer has to drill customer-by-customer.

interface LedgerRow {
  id: string;
  businessId: string;
  businessName: string;
  planTier: string | null;
  planName: string | null;
  priceInr: number;
  status: string;
  billingMode: 'paid' | 'comped' | 'free';
  nextChargeAt: string | null;
  trialEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  cancelledAt: string | null;
  createdAt: string;
  dunningAttempts: number;
  lastDunningAt: string | null;
}
interface LedgerResp {
  rows: LedgerRow[];
  summary: {
    total: number;
    byStatus: Record<string, number>;
    byBillingMode: Record<string, number>;
    mrrInr: number;
    pastDueCount: number;
  };
}

// 2026-09-06: status list + badge map live in src/lib/plans.ts (know `suspended`).
const MODE_VARIANT: Record<string, any> = {
  paid: 'success', comped: 'warning', free: 'muted',
};

export function SubscriptionsPage() {
  const [status, setStatus] = useState('');
  const [billingMode, setBillingMode] = useState('');
  const { data, isLoading, isError, error, refetch } = useQuery<LedgerResp>({
    queryKey: ['subscriptions', status, billingMode],
    queryFn: () => adminApi.subscriptions({
      status: status || undefined, billingMode: billingMode || undefined,
    }),
  });

  // Memoised so the `??` fallback does not hand useMemo a fresh [] each render.
  const rows = useMemo(() => data?.rows ?? [], [data?.rows]);
  const s = data?.summary;

  const exportCsv = useMemo(() => () => {
    const head = ['Business', 'Plan', 'Status', 'Billing', 'Price(INR)', 'Next charge', 'Trial ends', 'Cancels at period end', 'Created'];
    const lines = rows.map((r) => [
      r.businessName, r.planName || r.planTier || '', r.status, r.billingMode,
      r.priceInr, r.nextChargeAt || '', r.trialEndsAt || '',
      r.cancelAtPeriodEnd ? 'yes' : 'no', r.createdAt,
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
    const csv = [head.join(','), ...lines].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = `subscriptions_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
  }, [rows]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Subscriptions</h1>
          <p className="text-muted-foreground">
            {isError ? '—' : s ? `${s.total} subscriptions · ${formatINR(s.mrrInr)} MRR` : 'Loading…'}
          </p>
        </div>
        <Button variant="ghost" onClick={exportCsv} disabled={rows.length === 0}>Export CSV</Button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <SummaryCard label="MRR (paid, active)" value={s ? formatINR(s.mrrInr) : '—'} />
        <SummaryCard label="Past due" value={s ? String(s.pastDueCount) : '—'}
          tone={s && s.pastDueCount > 0 ? 'bad' : undefined} />
        <SummaryCard label="Paid" value={s ? String(s.byBillingMode.paid || 0) : '—'} />
        <SummaryCard label="Comped" value={s ? String(s.byBillingMode.comped || 0) : '—'} />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        <select className="h-9 rounded-md border bg-background px-3 text-sm"
          value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          {SUBSCRIPTION_STATUSES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select className="h-9 rounded-md border bg-background px-3 text-sm"
          value={billingMode} onChange={(e) => setBillingMode(e.target.value)}>
          <option value="">All billing</option>
          <option value="paid">Paid</option>
          <option value="comped">Comped</option>
          <option value="free">Free</option>
        </select>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Business</TableHead><TableHead>Plan</TableHead>
              <TableHead>Status</TableHead><TableHead>Billing</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead>Next charge</TableHead><TableHead>Trial ends</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={7} className="text-center py-10 text-muted-foreground">Loading…</TableCell></TableRow>
              )}
              {isError && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-10">
                    <div className="text-sm text-destructive">Couldn't load the subscription ledger — {apiError(error)}</div>
                    <Button variant="outline" size="sm" className="mt-2" onClick={() => refetch()}>Retry</Button>
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && !isError && rows.length === 0 && (
                <TableRow><TableCell colSpan={7} className="text-center py-10 text-muted-foreground">No subscriptions match.</TableCell></TableRow>
              )}
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">
                    <Link to={`/customers/${r.businessId}`} className="hover:underline">{r.businessName}</Link>
                  </TableCell>
                  <TableCell>{r.planName || r.planTier || '—'}</TableCell>
                  <TableCell>
                    <Badge variant={subscriptionStatusVariant(r.status) || 'muted'}>{r.status}</Badge>
                    {r.status === 'past_due' && r.dunningAttempts > 0 && (
                      <span className="ml-1 text-xs text-destructive">· {r.dunningAttempts} failed</span>
                    )}
                    {r.cancelAtPeriodEnd && <span className="ml-1 text-xs text-muted-foreground">(cancelling)</span>}
                  </TableCell>
                  <TableCell><Badge variant={MODE_VARIANT[r.billingMode]}>{r.billingMode}</Badge></TableCell>
                  <TableCell className="text-right">{r.priceInr > 0 ? formatINR(r.priceInr) : '—'}</TableCell>
                  <TableCell className="text-sm">{r.nextChargeAt ? formatDateTime(r.nextChargeAt) : '—'}</TableCell>
                  <TableCell className="text-sm">{r.trialEndsAt ? formatDateTime(r.trialEndsAt) : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryCard({ label, value, tone }: { label: string; value: string; tone?: 'bad' }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={`text-2xl font-bold mt-1 ${tone === 'bad' ? 'text-destructive' : ''}`}>{value}</div>
      </CardContent>
    </Card>
  );
}
