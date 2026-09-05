// NamastePOS admin — Ops → Review checks (2026-09-06).
//
// One card per check from GET /admin/ops/review-checks (CONTRACTS_round2 §5):
// zero-GST invoices, stub IRNs, aggregator rows without the `aggregators` key,
// lapsed cancel-at-period-end rows, suspended tenants, DB SSL unverified,
// ORDER_TAX_ENFORCE mode, plans selling `ungated` keys. These are the queries
// the 2026-09-05 review had to run by hand; the backend now runs them on demand
// so the founder can re-check after every deploy without a psql session.
//
// Super-admin only server-side (403 for everyone else); the nav item is gated
// on settings.write, the one permission only super_admin holds.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { RefreshCw, Copy, ChevronDown, ChevronRight, AlertOctagon, AlertTriangle, Info } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { adminApi, ReviewCheck } from '@/api/admin';
import { apiError } from '@/api/client';
import { formatDateTime } from '@/lib/utils';

const SEVERITY: Record<ReviewCheck['severity'], { stripe: string; badge: 'destructive' | 'warning' | 'secondary'; icon: typeof Info; label: string }> = {
  critical: { stripe: 'border-l-red-600', badge: 'destructive', icon: AlertOctagon, label: 'Critical' },
  warn:     { stripe: 'border-l-amber-500', badge: 'warning', icon: AlertTriangle, label: 'Warning' },
  info:     { stripe: 'border-l-sky-500', badge: 'secondary', icon: Info, label: 'Info' },
};
const SEVERITY_RANK: Record<ReviewCheck['severity'], number> = { critical: 0, warn: 1, info: 2 };

export function ReviewChecksPage() {
  const q = useQuery({
    queryKey: ['ops-review-checks'],
    queryFn: adminApi.reviewChecks,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const checks = [...(q.data?.checks ?? [])].sort((a, b) => {
    // Failing checks first, then by severity, then by count.
    const af = a.count > 0 ? 0 : 1, bf = b.count > 0 ? 0 : 1;
    if (af !== bf) return af - bf;
    if (SEVERITY_RANK[a.severity] !== SEVERITY_RANK[b.severity]) return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    return b.count - a.count;
  });
  const failing = checks.filter((c) => c.count > 0);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Review checks</h1>
          <p className="text-muted-foreground">
            The data-integrity and configuration queries from the 2026-09-05 review, run live against production.
            {q.data?.generatedAt && <> Generated {formatDateTime(q.data.generatedAt)}.</>}
          </p>
        </div>
        <Button variant="outline" onClick={() => q.refetch()} disabled={q.isFetching}>
          <RefreshCw className={`mr-2 h-4 w-4 ${q.isFetching ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      </div>

      {q.isLoading ? (
        <div className="text-sm text-muted-foreground">Running checks…</div>
      ) : q.isError ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Couldn't run the checks</CardTitle>
            <CardDescription>{apiError(q.error)}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" size="sm" onClick={() => q.refetch()}>Retry</Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap gap-2 text-sm">
            <Badge variant={failing.length ? 'destructive' : 'success'}>
              {failing.length === 0 ? 'All clear' : `${failing.length} of ${checks.length} checks have findings`}
            </Badge>
            {(['critical', 'warn', 'info'] as const).map((sev) => {
              const n = failing.filter((c) => c.severity === sev).length;
              return n > 0 ? <Badge key={sev} variant={SEVERITY[sev].badge}>{n} {SEVERITY[sev].label.toLowerCase()}</Badge> : null;
            })}
          </div>
          {checks.length === 0 && (
            <div className="text-sm text-muted-foreground">The backend returned no checks.</div>
          )}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {checks.map((c) => <CheckCard key={c.id} check={c} />)}
          </div>
        </>
      )}
    </div>
  );
}

function CheckCard({ check }: { check: ReviewCheck }) {
  const [open, setOpen] = useState(false);
  const [showSql, setShowSql] = useState(false);
  const sev = SEVERITY[check.severity] ?? SEVERITY.info;
  const Icon = sev.icon;
  const clean = check.count === 0;
  const copySql = async () => {
    try {
      await navigator.clipboard.writeText(check.sql);
      toast.success('SQL copied');
    } catch {
      toast.error('Clipboard blocked — select the text and copy manually');
    }
  };
  const columns = check.sample.length > 0
    ? Array.from(new Set(check.sample.flatMap((r) => Object.keys(r))))
    : [];

  return (
    <Card className={`border-l-4 ${clean ? 'border-l-emerald-500 opacity-90' : sev.stripe}`}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-base flex items-center gap-2">
              <Icon className={`h-4 w-4 shrink-0 ${clean ? 'text-emerald-600' : check.severity === 'critical' ? 'text-red-600' : check.severity === 'warn' ? 'text-amber-600' : 'text-sky-600'}`} />
              <span className="truncate">{check.label}</span>
            </CardTitle>
            <CardDescription className="mt-1">{check.description}</CardDescription>
            <code className="block text-[10px] text-muted-foreground mt-1">id: {check.id}</code>
          </div>
          <div className="text-right shrink-0">
            <div className={`text-3xl font-bold tabular-nums ${clean ? 'text-emerald-700' : ''}`}>{check.count.toLocaleString('en-IN')}</div>
            <Badge variant={clean ? 'success' : sev.badge} className="text-[10px]">{clean ? 'clean' : sev.label}</Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 pt-0">
        <div className="flex gap-2 flex-wrap">
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setOpen((v) => !v)}
            disabled={check.sample.length === 0}>
            {open ? <ChevronDown className="h-3.5 w-3.5 mr-1" /> : <ChevronRight className="h-3.5 w-3.5 mr-1" />}
            {check.sample.length === 0 ? 'No sample rows' : `Sample rows (${check.sample.length}${check.count > check.sample.length ? ` of ${check.count}` : ''})`}
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setShowSql((v) => !v)} disabled={!check.sql}>
            {showSql ? <ChevronDown className="h-3.5 w-3.5 mr-1" /> : <ChevronRight className="h-3.5 w-3.5 mr-1" />}
            SQL
          </Button>
          {check.sql && (
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={copySql}>
              <Copy className="h-3.5 w-3.5 mr-1" /> Copy SQL
            </Button>
          )}
        </div>
        {open && check.sample.length > 0 && (
          <div className="overflow-x-auto rounded border">
            <table className="w-full text-xs">
              <thead className="bg-muted/50">
                <tr>{columns.map((col) => <th key={col} className="text-left px-2 py-1 font-semibold whitespace-nowrap">{col}</th>)}</tr>
              </thead>
              <tbody className="divide-y">
                {check.sample.map((row, i) => (
                  <tr key={i}>
                    {columns.map((col) => (
                      <td key={col} className="px-2 py-1 font-mono whitespace-nowrap max-w-[16rem] truncate" title={cell(row[col])}>
                        {cell(row[col])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {showSql && check.sql && (
          <pre className="rounded bg-muted p-3 text-[11px] leading-5 overflow-x-auto whitespace-pre-wrap break-words select-all">{check.sql}</pre>
        )}
      </CardContent>
    </Card>
  );
}

function cell(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
