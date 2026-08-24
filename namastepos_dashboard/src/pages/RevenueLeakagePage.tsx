// NamastePOS dashboard — Revenue leakage (FF-246).
//
// Shows the money that DID NOT make it to the till — voids after KOT
// print, manual discounts, and comps — broken down by staff. Owner
// picks a date range (default: last 30 days) and sees three ranked
// lists plus a leakage total.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, TrendingDown, Percent, Ban } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { ffApi } from '@/api/namastepos';
import { formatINR } from '@/lib/utils';

const daysAgo = (n: number) =>
  new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

export function RevenueLeakagePage() {
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(daysAgo(0));
  const q = useQuery({
    queryKey: ['leakage', from, to],
    queryFn: () => ffApi.revenueLeakage(from, to),
  });
  const d = q.data;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <TrendingDown className="h-6 w-6 text-red-600" /> Revenue leakage
        </h1>
        <p className="text-muted-foreground text-sm">
          Every rupee that <em>didn&apos;t</em> reach the till, grouped by staff.
          Investigate patterns — a single captain with high void counts
          deserves a conversation.
        </p>
      </div>

      <Card>
        <CardContent className="p-4 flex flex-wrap items-end gap-3">
          <div>
            <Label>From</Label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="max-w-[180px]" />
          </div>
          <div>
            <Label>To</Label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="max-w-[180px]" />
          </div>
          <Button variant="outline" onClick={() => q.refetch()}>Refresh</Button>
          <div className="ml-auto text-right">
            <div className="text-xs text-muted-foreground">Total leakage</div>
            <div className="text-2xl font-bold text-red-700">
              {formatINR(d?.totalLeakage || 0)}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <LeakBucket
          icon={<Ban className="h-4 w-4" />}
          title="Voids after KOT"
          hint="KOT printed, then cancelled. Highest-risk pattern."
          rows={d?.voids?.rows || []}
          totalAmount={d?.voids?.totalAmount || 0}
        />
        <LeakBucket
          icon={<Percent className="h-4 w-4" />}
          title="Manual discounts"
          hint="Owner-approved discounts are fine — patterns of many small ones aren't."
          rows={d?.discounts?.rows || []}
          totalAmount={d?.discounts?.totalAmount || 0}
        />
        <LeakBucket
          icon={<AlertTriangle className="h-4 w-4" />}
          title="Comps (100%)"
          hint='"Free" or 100%-discounted orders. Should be rare.'
          rows={d?.comps?.rows || []}
          totalAmount={d?.comps?.totalAmount || 0}
        />
      </div>
    </div>
  );
}

function LeakBucket({ icon, title, hint, rows, totalAmount }: {
  icon: React.ReactNode; title: string; hint: string;
  rows: any[]; totalAmount: number;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <span className="text-muted-foreground">{icon}</span>
          {title}
        </CardTitle>
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      </CardHeader>
      <CardContent className="text-sm">
        {rows.length === 0 ? (
          <div className="py-4 text-center text-muted-foreground">Nothing to show.</div>
        ) : (
          <>
            <div className="flex justify-between font-semibold border-b pb-2 mb-2">
              <span>Total</span>
              <span>{formatINR(totalAmount)}</span>
            </div>
            {rows.map((r: any) => (
              <div key={(r.staff_id || '?') + r.staff_name} className="flex justify-between py-1">
                <span>{r.staff_name} <span className="text-muted-foreground text-xs">· {r.n}</span></span>
                <strong>{formatINR(parseFloat(r.amount) || 0)}</strong>
              </div>
            ))}
          </>
        )}
      </CardContent>
    </Card>
  );
}
