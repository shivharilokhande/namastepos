import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  TrendingUp, Users, CreditCard, AlertTriangle, Ticket, Package,
  Receipt, UserPlus, ArrowRight,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { adminApi, AttentionItem, Overview } from '@/api/admin';
import { formatINR, formatDateTime } from '@/lib/utils';

// 2026-09-03 — the admin landing page. Previously the index route was a
// two-chart summary that couldn't answer "what should I do today". This page
// is the SaaS control panel: vitals on top, a work queue underneath.
//
// Deliberately NO chart library here (recharts is only pulled in on the
// Charts/Reports pages). The trend is a hand-rolled inline SVG sparkline —
// ~30 lines, zero bundle cost, and it renders fine at any card width.

export function OverviewPage() {
  const { data, isLoading, isError, error } = useQuery<Overview>({
    queryKey: ['overview'],
    queryFn: adminApi.overview,
    // The home page is what an admin leaves open on a second monitor.
    refetchInterval: 60_000,
  });

  const c = data?.counts;
  const dash = (v: any) => (isLoading || v === undefined ? '—' : v);

  // Month-over-month revenue delta, guarded against a zero baseline (the
  // first month of trading would otherwise render "Infinity%").
  const revDelta = useMemo(() => {
    if (!data) return null;
    const { thisMonthInr, lastMonthInr } = data.revenue;
    if (!lastMonthInr) return null;
    return Math.round(((thisMonthInr - lastMonthInr) / lastMonthInr) * 1000) / 10;
  }, [data]);

  if (isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Couldn't load the overview</CardTitle>
          <CardDescription>{String((error as any)?.message || error)}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Overview</h1>
        <p className="text-muted-foreground">
          How NamastePOS is doing right now, and what needs a human today.
        </p>
      </div>

      {/* ── Revenue vitals ─────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat
          icon={<TrendingUp className="h-5 w-5" />}
          color="bg-emerald-100 text-emerald-700"
          label="MRR"
          value={isLoading ? '—' : formatINR(data!.mrrInr)}
          hint={isLoading ? undefined : `ARR ${formatINR(data!.arrInr)}`}
        />
        <Stat
          icon={<Receipt className="h-5 w-5" />}
          color="bg-sky-100 text-sky-700"
          label="Collected this month"
          value={isLoading ? '—' : formatINR(data!.revenue.thisMonthInr)}
          hint={isLoading ? undefined
            : `${revDelta === null ? 'no prior month' : `${revDelta > 0 ? '+' : ''}${revDelta}% vs last month`}`
            + (data!.revenue.refundsThisMonthInr > 0
              ? ` · ${formatINR(data!.revenue.refundsThisMonthInr)} refunded` : '')}
        />
        <Stat
          icon={<Users className="h-5 w-5" />}
          color="bg-blue-100 text-blue-700"
          label="Customers"
          value={String(dash(c?.customers))}
          hint={isLoading ? undefined
            : `${c!.active} active · ${c!.trialing} trialing · ${c!.paused} paused`}
        />
        <Stat
          icon={<UserPlus className="h-5 w-5" />}
          color="bg-violet-100 text-violet-700"
          label="New signups"
          value={String(dash(c?.signups7d))}
          hint={isLoading ? undefined : `last 7 days · ${c!.signups30d} in 30d`}
        />
      </div>

      {/* ── Risk vitals — these are the numbers that cost money ────── */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <MiniStat label="Past due" value={dash(c?.pastDue)} to="/billing-ops"
                  tone={(c?.pastDue || 0) > 0 ? 'bad' : 'ok'} />
        <MiniStat label="Failed payments · 24h" value={dash(c?.failedPayments24h)} to="/billing-ops"
                  tone={(c?.failedPayments24h || 0) > 0 ? 'warn' : 'ok'} />
        <MiniStat label="Churned · 30d" value={dash(c?.churned30d)} to="/subscriptions"
                  tone={(c?.churned30d || 0) > 0 ? 'warn' : 'ok'} />
        <MiniStat label="Open tickets" value={dash(c?.openTickets)} to="/support"
                  tone={(c?.p1Tickets || 0) > 0 ? 'bad' : 'ok'}
                  hint={c ? `${c.p1Tickets} high/critical` : undefined} />
        <MiniStat label="Pending refunds" value={dash(c?.pendingRefunds)} to="/refunds"
                  tone={(c?.pendingRefunds || 0) > 0 ? 'warn' : 'ok'} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* ── Signup trend (inline SVG, no chart lib) ──────────────── */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Signups · last 30 days</CardTitle>
            <CardDescription>
              {isLoading ? '…' : `${data!.counts.signups30d} businesses joined`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Sparkline points={(data?.signupTrend || []).map((p) => p.count)} />
            <div className="mt-4">
              <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Collected per month
              </div>
              <Sparkline
                points={(data?.mrrTrend || []).map((p) => p.inr)}
                height={40}
                stroke="#2EC4B6"
              />
              <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
                <span>{data?.mrrTrend?.[0]?.month || ''}</span>
                <span>{data?.mrrTrend?.slice(-1)[0]?.month || ''}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* ── Plan mix + addon attach ──────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Plan mix</CardTitle>
            <CardDescription>Currently paying or trialing</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {(data?.plans || []).length === 0 && !isLoading && (
              <div className="text-sm text-muted-foreground">No live subscriptions yet.</div>
            )}
            {(data?.plans || []).map((p) => {
              const total = (data?.plans || []).reduce((s, x) => s + x.count, 0) || 1;
              const pct = Math.round((p.count / total) * 100);
              return (
                <div key={p.tier}>
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="font-medium">{p.name}</span>
                    <span className="text-muted-foreground">{p.count} · {pct}%</span>
                  </div>
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}

            <div className="border-t pt-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Package className="h-4 w-4 text-muted-foreground" /> Add-on attach rate
              </div>
              <div className="mt-1 text-2xl font-bold tracking-tight">
                {isLoading ? '—' : `${data!.addons.attachRatePct}%`}
              </div>
              <div className="text-xs text-muted-foreground">
                {isLoading ? '' : `${data!.addons.tenantsWithAddon} of ${data!.addons.liveTenants} live tenants · `
                  + `${data!.addons.activeActivations} activations`}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Needs attention ───────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <AlertTriangle className="h-4 w-4 text-amber-600" /> Needs attention
              </CardTitle>
              <CardDescription>
                Past-due billing, stuck refunds, expiring add-ons, high-priority tickets,
                trials about to lapse — worst first.
              </CardDescription>
            </div>
            <Button variant="ghost" size="sm" asChild>
              <Link to="/billing-ops">Billing ops <ArrowRight className="ml-1 h-3 w-3" /></Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
          {!isLoading && (data?.needsAttention || []).length === 0 && (
            <div className="py-6 text-center text-sm text-muted-foreground">
              Nothing needs attention. Quiet is good.
            </div>
          )}
          <div className="divide-y">
            {(data?.needsAttention || []).map((item, i) => (
              <AttentionRow key={`${item.kind}-${item.businessId}-${i}`} item={item} />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Inline SVG sparkline ──────────────────────────────────────────────
// Renders in a fixed viewBox and stretches to the container via
// preserveAspectRatio="none", so it stays crisp without a resize observer.
// A flat series (max === min) draws on the mid-line instead of dividing by 0.
function Sparkline({
  points, height = 88, stroke = '#FF6B35',
}: { points: number[]; height?: number; stroke?: string }) {
  const W = 600;
  const H = 100;
  if (points.length === 0) {
    return <div className="text-sm text-muted-foreground" style={{ height }}>No data yet.</div>;
  }
  // A single sample can't draw a line — duplicate it so we render a flat one.
  const series = points.length === 1 ? [points[0], points[0]] : points;

  const max = Math.max(...series);
  const min = Math.min(...series);
  const span = max - min || 1;
  const flat = max === min;
  const step = W / (series.length - 1);

  const xy = series.map((v, i) => {
    const x = i * step;
    const y = flat ? H / 2 : H - ((v - min) / span) * (H - 8) - 4;
    return [x, y] as const;
  });
  const line = xy.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${W},${H} L0,${H} Z`;
  const gradId = `spark-${stroke.replace('#', '')}`;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
           style={{ width: '100%', height }} role="img"
           aria-label={`Trend: ${min} to ${max}`}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity={0.35} />
            <stop offset="100%" stopColor={stroke} stopOpacity={0} />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${gradId})`} />
        <path d={line} fill="none" stroke={stroke} strokeWidth={2}
              vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>min {min.toLocaleString('en-IN')}</span>
        <span>max {max.toLocaleString('en-IN')}</span>
      </div>
    </div>
  );
}

// ── Cards ─────────────────────────────────────────────────────────────
function Stat({ icon, label, value, hint, color }: {
  icon: React.ReactNode; label: string; value: string; hint?: string; color: string;
}) {
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

function MiniStat({ label, value, to, tone, hint }: {
  label: string; value: any; to: string; tone: 'ok' | 'warn' | 'bad'; hint?: string;
}) {
  const toneCls = tone === 'bad' ? 'text-destructive'
    : tone === 'warn' ? 'text-amber-600' : 'text-foreground';
  return (
    <Link to={to}>
      <Card className="transition-colors hover:bg-accent/50">
        <CardContent className="p-4">
          <div className={`text-xl font-bold tracking-tight ${toneCls}`}>{value}</div>
          <div className="text-xs text-muted-foreground">{label}</div>
          {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
        </CardContent>
      </Card>
    </Link>
  );
}

const KIND_LABEL: Record<AttentionItem['kind'], string> = {
  past_due: 'Billing',
  stuck_refund: 'Refund',
  expiring_addon: 'Add-on',
  p1_ticket: 'Support',
  trial_ending: 'Trial',
};
const SEVERITY_VARIANT: Record<string, any> = {
  critical: 'destructive', high: 'warning', medium: 'secondary', low: 'muted',
};

function AttentionRow({ item }: { item: AttentionItem }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Badge variant={SEVERITY_VARIANT[item.severity] || 'muted'} className="text-[10px]">
            {KIND_LABEL[item.kind] || item.kind}
          </Badge>
          <span className="truncate text-sm font-medium">{item.label}</span>
        </div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">
          {item.businessName || 'Unknown business'}
          {item.detail ? ` · ${item.detail}` : ''}
          {item.at ? ` · ${formatDateTime(item.at)}` : ''}
        </div>
      </div>
      {item.businessId && (
        <Button variant="ghost" size="sm" asChild>
          <Link to={`/customers/${item.businessId}`}>
            {item.kind === 'p1_ticket' ? <Ticket className="h-4 w-4" />
              : item.kind === 'past_due' ? <CreditCard className="h-4 w-4" />
              : <ArrowRight className="h-4 w-4" />}
          </Link>
        </Button>
      )}
    </div>
  );
}
