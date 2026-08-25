// Owner-facing Refunds page (2026-08-23).
//
// Refunds could be initiated from the Orders screen ("Refund…" on a
// collected order) but there was no place on the owner's dashboard to SEE
// refund history — it only showed on the platform admin panel, which lists
// every tenant. This page lists THIS business's refunds (backend scopes the
// GET /businesses/:id/refunds route to the caller's tenant) so the owner can
// review refunds where they expect to: on their own dashboard.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ffApi } from '@/api/namastepos';
import { formatINR, formatDateTime } from '@/lib/utils';

const STATUSES = ['all', 'pending', 'processed', 'failed', 'cancelled'] as const;

export function RefundsPage() {
  const [status, setStatus] = useState<string>('all');
  const { data: refunds = [], isLoading } = useQuery({
    queryKey: ['refunds', status],
    queryFn: () => ffApi.listRefunds(status === 'all' ? {} : { status }),
  });

  const total = (refunds as any[]).reduce((s, r) => s + (r.amount || 0), 0);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Refunds</h1>
          <p className="text-muted-foreground">
            {(refunds as any[]).length} refunds · {formatINR(total, { decimals: true })} total.
            {' '}Start a refund from <span className="font-medium">Orders → Refund…</span> on a collected order.
          </p>
        </div>
        <div className="flex gap-1 rounded-lg border p-1">
          {STATUSES.map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              // Bugfix 2026-08-25: the active tab used `bg-brand text-white`,
              // but `brand` is NOT a color in tailwind.config.js — the class
              // compiled to nothing, leaving white text on the white page, so
              // the selected tab's label went invisible on click. Use the
              // theme tokens (`bg-primary text-primary-foreground`) like the
              // segmented controls on MenuPage/TablesPage.
              className={`px-3 py-1 text-sm rounded-md capitalize transition ${
                status === s ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={4} className="text-center py-10 text-muted-foreground">Loading…</TableCell></TableRow>
              )}
              {!isLoading && (refunds as any[]).length === 0 && (
                // Empty-state 2026-08-25: filter-aware wording — with a status
                // tab active, "No refunds yet" would read like a bug ("I KNOW
                // I have refunds"); say the filter matched nothing instead.
                <TableRow><TableCell colSpan={4} className="text-center py-10 text-muted-foreground">
                  {status === 'all'
                    ? 'No refunds yet. Start one from Orders → Refund… on a collected order.'
                    : `No ${status} refunds. Switch to "all" to see every refund.`}
                </TableCell></TableRow>
              )}
              {(refunds as any[]).map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{formatDateTime(r.createdAt)}</TableCell>
                  <TableCell className="text-sm">{r.reason || '—'}</TableCell>
                  <TableCell>
                    <Badge variant={
                      r.status === 'processed' ? 'success' :
                      r.status === 'failed' ? 'destructive' :
                      r.status === 'cancelled' ? 'muted' : 'warning'
                    }>{r.status}</Badge>
                  </TableCell>
                  <TableCell className="text-right font-medium">{formatINR(r.amount, { decimals: true })}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
