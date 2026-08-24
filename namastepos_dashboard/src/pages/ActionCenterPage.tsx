// NamastePOS dashboard — Action Center (FF-244).
//
// One page that pulls together everything the owner needs to look at
// today. Backed by GET /action-center which returns four buckets
// (refunds, lowStock, disputed, expiringSubs) plus a total count.
//
// Empty state matters — a well-run cafe should see "You're all
// clear!" more often than not. That's a feature, not a design gap.

import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Inbox, AlertTriangle, Ban, Clock, RefreshCcw, ArrowRight, CheckCircle2,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ffApi } from '@/api/namastepos';
import { formatINR } from '@/lib/utils';

function timeAgo(iso: string | null | undefined) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function ActionCenterPage() {
  const q = useQuery({
    queryKey: ['action-center'],
    queryFn: ffApi.actionCenter,
    refetchInterval: 60_000,
  });
  const d = q.data;
  const total = d?.counts?.total ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Inbox className="h-6 w-6 text-primary" /> Action Center
          </h1>
          <p className="text-muted-foreground text-sm">
            Everything that needs your attention right now.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => q.refetch()}
          disabled={q.isFetching}>
          <RefreshCcw className={`h-3.5 w-3.5 mr-1 ${q.isFetching ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {total === 0 && !q.isLoading && (
        <Card className="border-emerald-300 bg-emerald-50/50">
          <CardContent className="p-8 text-center">
            <CheckCircle2 className="h-10 w-10 mx-auto text-emerald-600 mb-2" />
            <div className="text-lg font-semibold text-emerald-800">You&apos;re all clear</div>
            <div className="text-sm text-emerald-700">
              No refunds pending, no low-stock items, no cancellations, no expiring plans.
              Go make some cutting chai.
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Bucket
          title="Refunds waiting"
          icon={<RefreshCcw className="h-4 w-4" />}
          count={d?.counts?.refunds ?? 0}
          empty="No refunds pending."
          rows={(d?.refunds || []).map((r: any) => ({
            key: r.id,
            title: `${formatINR(r.amount)} · Order #${r.orderNo || '—'}`,
            sub: r.reason || 'No reason given',
            meta: timeAgo(r.createdAt),
          }))}
          link={<Link to="/billing" className="text-primary hover:underline text-sm inline-flex items-center gap-1">Open billing <ArrowRight className="h-3 w-3" /></Link>}
        />

        <Bucket
          title="Low stock"
          icon={<AlertTriangle className="h-4 w-4" />}
          count={d?.counts?.lowStock ?? 0}
          empty="All items stocked above reorder level."
          rows={(d?.lowStock || []).map((r: any) => ({
            key: r.id,
            title: r.name,
            sub: `${r.stock} ${r.unit} left · reorder at ${r.reorderLevel}`,
            meta: '',
            severity: 'warning',
          }))}
          link={<Link to="/menu" className="text-primary hover:underline text-sm inline-flex items-center gap-1">Restock menu <ArrowRight className="h-3 w-3" /></Link>}
        />

        <Bucket
          title="Cancelled orders · 24h"
          icon={<Ban className="h-4 w-4" />}
          count={d?.counts?.disputed ?? 0}
          empty="No cancellations in the last 24 hours."
          rows={(d?.disputed || []).map((r: any) => ({
            key: r.id,
            title: `Order #${r.orderNo} · ${formatINR(r.total)}`,
            sub: r.reason || 'No reason given',
            meta: timeAgo(r.cancelledAt),
          }))}
          link={<Link to="/orders" className="text-primary hover:underline text-sm inline-flex items-center gap-1">Open orders <ArrowRight className="h-3 w-3" /></Link>}
        />

        <Bucket
          title="Plan expiring"
          icon={<Clock className="h-4 w-4" />}
          count={d?.counts?.expiringSubs ?? 0}
          empty="Nothing expiring in the next 7 days."
          rows={(d?.expiringSubs || []).map((r: any) => ({
            key: r.id,
            title: r.status === 'trialing' ? 'Free trial ending' : 'Renewal due',
            sub: r.trialEndsAt
              ? `Trial ends ${new Date(r.trialEndsAt).toLocaleDateString('en-IN')}`
              : `Renews on ${new Date(r.currentPeriodEnd).toLocaleDateString('en-IN')}`,
            meta: '',
          }))}
          link={<Link to="/billing" className="text-primary hover:underline text-sm inline-flex items-center gap-1">Manage plan <ArrowRight className="h-3 w-3" /></Link>}
        />
      </div>
    </div>
  );
}

interface BucketProps {
  title: string;
  icon: React.ReactNode;
  count: number;
  empty: string;
  rows: Array<{ key: string; title: string; sub: string; meta?: string; severity?: 'warning' }>;
  link?: React.ReactNode;
}
function Bucket({ title, icon, count, empty, rows, link }: BucketProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <span className="text-muted-foreground">{icon}</span>
          {title}
          {count > 0 && <Badge variant="destructive" className="ml-1">{count}</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {rows.length === 0 ? (
          <div className="py-4 text-center text-muted-foreground">{empty}</div>
        ) : (
          rows.map((r) => (
            <div key={r.key}
              className={`py-2 border-b last:border-0 ${r.severity === 'warning' ? 'text-amber-800' : ''}`}>
              <div className="font-medium">{r.title}</div>
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{r.sub}</span>
                {r.meta && <span>{r.meta}</span>}
              </div>
            </div>
          ))
        )}
        {rows.length > 0 && link && <div className="pt-2">{link}</div>}
      </CardContent>
    </Card>
  );
}
