import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { adminApi, UsageMetric, UsageRow } from '@/api/admin';
import { apiError } from '@/api/client';

// 2026-09-03 — platform-wide usage vs plan limits.
//
// The backend already maintained every one of these counters (menu_items,
// staff, tables, floors are counted live; monthly_orders comes from
// usage_counters, bumped by subscriptionService.incrementUsage) — but nothing
// ever showed them to a human. An over-limit tenant is either an upsell or a
// support ticket waiting to happen; a 0%-utilisation paid tenant is a churn
// risk. Sorted worst-first server-side.

const METRIC_LABEL: Record<string, string> = {
  staff: 'Staff',
  tables: 'Tables',
  floors: 'Floors',
  menu_items: 'Menu items',
  monthly_orders: 'Orders (this month)',
};

const PAGE_SIZE = 100;

export function UsagePage() {
  const [overLimitOnly, setOverLimitOnly] = useState(false);
  const [page, setPage] = useState(0);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['platform-usage', overLimitOnly, page],
    queryFn: () => adminApi.platformUsage({
      overLimitOnly, limit: PAGE_SIZE, offset: page * PAGE_SIZE,
    }),
  });

  const rows = data?.rows || [];
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const overCount = rows.filter((r) => r.overLimitCount > 0).length;
  const nearCount = rows.filter((r) => r.overLimitCount === 0 && r.nearLimitCount > 0).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Usage &amp; limits</h1>
        <p className="text-muted-foreground">
          What every tenant is consuming against their plan caps. Over-limit first.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card><CardContent className="p-5">
          <div className="text-2xl font-bold tracking-tight text-destructive">
            {isLoading ? '—' : overCount}
          </div>
          <div className="text-sm text-muted-foreground">At or over a cap (this page)</div>
        </CardContent></Card>
        <Card><CardContent className="p-5">
          <div className="text-2xl font-bold tracking-tight text-amber-600">
            {isLoading ? '—' : nearCount}
          </div>
          <div className="text-sm text-muted-foreground">Above 80% on some cap</div>
        </CardContent></Card>
        <Card><CardContent className="p-5">
          <div className="text-2xl font-bold tracking-tight">{isLoading ? '—' : total}</div>
          <div className="text-sm text-muted-foreground">Live tenants tracked</div>
        </CardContent></Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div>
              <CardTitle className="text-base">Per-tenant usage</CardTitle>
              <CardDescription>
                Grey = unlimited on this plan. Amber = 80%+. Red = at or over the cap
                (further writes are blocked with PLAN_LIMIT).
              </CardDescription>
            </div>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input type="checkbox" checked={overLimitOnly}
                     onChange={(e) => { setOverLimitOnly(e.target.checked); setPage(0); }} />
              Over-limit only
            </label>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Business</TableHead>
                <TableHead>Plan</TableHead>
                {Object.keys(METRIC_LABEL).map((m) => (
                  <TableHead key={m} className="text-right">{METRIC_LABEL[m]}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={7} className="text-muted-foreground">Loading…</TableCell></TableRow>
              )}
              {isError && (
                // "Nobody is over their plan limits." on a failed fetch is a
                // false all-clear — say the load failed and offer a retry.
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center">
                    <div className="text-sm text-destructive">Couldn't load usage — {apiError(error)}</div>
                    <Button variant="outline" size="sm" className="mt-2" onClick={() => refetch()}>Retry</Button>
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && !isError && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                    {overLimitOnly ? 'Nobody is over their plan limits.' : 'No tenants to show.'}
                  </TableCell>
                </TableRow>
              )}
              {rows.map((r) => (
                <TableRow key={r.businessId}>
                  <TableCell>
                    <Link to={`/customers/${r.businessId}`} className="font-medium hover:underline">
                      {r.businessName}
                    </Link>
                    {r.overLimitCount > 0 && (
                      <Badge variant="destructive" className="ml-2 text-[10px]">
                        {r.overLimitCount} over
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="text-sm">{r.planName || r.planTier || '—'}</div>
                    <div className="text-xs text-muted-foreground">{r.subscriptionStatus || 'no sub'}</div>
                  </TableCell>
                  {Object.keys(METRIC_LABEL).map((key) => {
                    const m = r.metrics.find((x) => x.metric === key);
                    return <TableCell key={key} className="text-right"><MetricCell m={m} /></TableCell>;
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {pageCount > 1 && (
            <div className="mt-4 flex items-center justify-between">
              <div className="text-sm text-muted-foreground">
                Page {page + 1} of {pageCount} · {total} tenants
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page === 0}
                        onClick={() => setPage((p) => Math.max(0, p - 1))}>Previous</Button>
                <Button variant="outline" size="sm" disabled={page + 1 >= pageCount}
                        onClick={() => setPage((p) => p + 1)}>Next</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Shared metric renderer (also used on the customer drilldown) ───────
export function MetricCell({ m }: { m?: UsageMetric }) {
  if (!m) return <span className="text-muted-foreground">—</span>;
  if (m.unlimited) {
    return (
      <span className="text-xs text-muted-foreground" title="No cap on this plan">
        {m.used.toLocaleString('en-IN')} <span className="opacity-60">/ ∞</span>
      </span>
    );
  }
  const cls = m.over ? 'text-destructive font-semibold'
    : m.near ? 'text-amber-600 font-medium' : '';
  return (
    <span className={`text-xs font-mono ${cls}`}
          title={m.utilisationPct !== null ? `${m.utilisationPct}% of cap` : undefined}>
      {m.used.toLocaleString('en-IN')} / {m.limit.toLocaleString('en-IN')}
    </span>
  );
}

// ── Per-customer usage card (rendered on the customer drilldown) ───────
export function CustomerUsageCard({ businessId }: { businessId: string }) {
  const { data, isLoading, isError, error, refetch } = useQuery<UsageRow>({
    queryKey: ['customer-usage', businessId],
    queryFn: () => adminApi.customerUsage(businessId),
    enabled: !!businessId,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Usage vs plan limits</CardTitle>
        <CardDescription>
          {isError ? '—'
            : isLoading ? 'Loading…'
            : `${data?.planName || data?.planTier || 'No plan'} · `
              + `${data?.overLimitCount || 0} over, ${data?.nearLimitCount || 0} near the cap`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {(data?.metrics || []).map((m) => {
          const pct = m.unlimited ? 0 : Math.min(100, m.utilisationPct ?? 0);
          const bar = m.over ? 'bg-destructive' : m.near ? 'bg-amber-500' : 'bg-primary';
          return (
            <div key={m.metric}>
              <div className="flex items-baseline justify-between text-sm">
                <span className="font-medium">{METRIC_LABEL[m.metric] || m.metric}</span>
                <MetricCell m={m} />
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                {!m.unlimited && (
                  <div className={`h-full rounded-full ${bar}`} style={{ width: `${pct}%` }} />
                )}
              </div>
            </div>
          );
        })}
        {isError && (
          <div>
            <div className="text-sm text-destructive">Couldn't load this tenant's usage — {apiError(error)}</div>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => refetch()}>Retry</Button>
          </div>
        )}
        {!isLoading && !isError && (data?.metrics || []).length === 0 && (
          <div className="text-sm text-muted-foreground">No usage data for this tenant.</div>
        )}
      </CardContent>
    </Card>
  );
}
