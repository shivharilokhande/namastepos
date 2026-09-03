import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { RefreshCw, BadgeCheck, HandCoins, History, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { adminApi, DunningRow } from '@/api/admin';
import { apiError } from '@/api/client';
import { formatINR, formatDateTime } from '@/lib/utils';

// 2026-09-03 — dunning / billing ops.
//
// /subscriptions is the read-only ledger (every tenant, every status). This
// page is the WORK QUEUE for the subset that owes us money, with the three
// actions a finance operator actually takes. All three require revenue.write
// (finance + super_admin) and are audited server-side.
//
//   Retry     — re-send the recovery nudge and log the chase. It is NOT a
//               gateway charge: Razorpay owns the mandate retry schedule for
//               a subscription and there's no supported "charge now".
//   Waive     — forgive this cycle. Clears dunning, reactivates, rolls the
//               period forward. Writes NO invoice: nothing was collected.
//   Mark paid — money arrived out of band (bank transfer / UPI / cash).
//               Writes a real PAID invoice so revenue reports see it.

export function BillingOpsPage() {
  const qc = useQueryClient();
  const [includeRecovered, setIncludeRecovered] = useState(false);
  const [timelineFor, setTimelineFor] = useState<DunningRow | null>(null);
  const [waiveFor, setWaiveFor] = useState<DunningRow | null>(null);
  const [markPaidFor, setMarkPaidFor] = useState<DunningRow | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['dunning', includeRecovered],
    queryFn: () => adminApi.dunningQueue({ includeRecovered }),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['dunning'] });
    qc.invalidateQueries({ queryKey: ['overview'] });
    qc.invalidateQueries({ queryKey: ['subscriptions'] });
  };

  const retry = useMutation({
    mutationFn: (businessId: string) => adminApi.dunningRetry(businessId),
    onSuccess: (r) => {
      toast.success(r.emailed
        ? `Nudge sent to ${r.recipient} (attempt ${r.attemptNo})`
        : `Attempt ${r.attemptNo} logged — no email sent (no address or free plan)`);
      invalidate();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const rows = data?.rows || [];
  const summary = data?.summary;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Billing ops</h1>
        <p className="text-muted-foreground">
          Subscriptions that failed to collect — chase, forgive, or settle offline.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-5">
            <div className="text-2xl font-bold tracking-tight">
              {isLoading ? '—' : summary?.count ?? 0}
            </div>
            <div className="text-sm text-muted-foreground">In the queue</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <div className="text-2xl font-bold tracking-tight text-destructive">
              {isLoading ? '—' : formatINR(summary?.amountAtRiskInr || 0)}
            </div>
            <div className="text-sm text-muted-foreground">MRR at risk</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <div className="text-2xl font-bold tracking-tight text-amber-600">
              {isLoading ? '—' : summary?.atRiskOfChurn ?? 0}
            </div>
            <div className="text-sm text-muted-foreground">3+ failed attempts</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div>
              <CardTitle className="text-base">Recovery queue</CardTitle>
              <CardDescription>Most-failed first, then longest since the last nudge.</CardDescription>
            </div>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input type="checkbox" checked={includeRecovered}
                     onChange={(e) => setIncludeRecovered(e.target.checked)} />
              Include recently recovered
            </label>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Business</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">At risk</TableHead>
                <TableHead>Attempts</TableHead>
                <TableHead>Last nudge</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={7} className="text-muted-foreground">Loading…</TableCell></TableRow>
              )}
              {!isLoading && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                    Nothing past due. Every mandate is collecting.
                  </TableCell>
                </TableRow>
              )}
              {rows.map((r) => (
                <TableRow key={r.subscriptionId}>
                  <TableCell>
                    <Link to={`/customers/${r.businessId}`} className="font-medium hover:underline">
                      {r.businessName}
                    </Link>
                    <div className="text-xs text-muted-foreground">{r.businessEmail}</div>
                    {r.accountOwnerEmail && (
                      <div className="text-[10px] text-muted-foreground">
                        owner: {r.accountOwnerEmail}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="text-sm">{r.planName || r.planTier || '—'}</div>
                    <div className="text-xs text-muted-foreground">{r.billingPeriod}</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={r.status === 'past_due' ? 'destructive' : 'success'}>
                      {r.status}
                    </Badge>
                    {!r.razorpaySubscriptionId && (
                      <div className="mt-1 flex items-center gap-1 text-[10px] text-amber-600">
                        <AlertTriangle className="h-3 w-3" /> no gateway mandate
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {formatINR(r.amountAtRiskInr)}
                  </TableCell>
                  <TableCell>
                    <span className={r.dunningAttempts >= 3 ? 'font-bold text-destructive' : ''}>
                      {r.dunningAttempts}
                    </span>
                    <span className="text-xs text-muted-foreground"> / {r.lifetimeFailures} lifetime</span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {r.lastDunningAt ? formatDateTime(r.lastDunningAt) : 'never'}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" title="Dunning history"
                              onClick={() => setTimelineFor(r)}>
                        <History className="h-4 w-4" />
                      </Button>
                      <Button variant="outline" size="sm" title="Re-send the recovery nudge"
                              disabled={retry.isPending}
                              onClick={() => retry.mutate(r.businessId)}>
                        <RefreshCw className="mr-1 h-3 w-3" /> Retry
                      </Button>
                      <Button variant="outline" size="sm" title="Forgive this cycle"
                              onClick={() => setWaiveFor(r)}>
                        <HandCoins className="mr-1 h-3 w-3" /> Waive
                      </Button>
                      <Button variant="secondary" size="sm" title="Settled outside the gateway"
                              onClick={() => setMarkPaidFor(r)}>
                        <BadgeCheck className="mr-1 h-3 w-3" /> Mark paid
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <TimelineDialog row={timelineFor} onClose={() => setTimelineFor(null)} />
      <WaiveDialog row={waiveFor} onClose={() => setWaiveFor(null)} onDone={invalidate} />
      <MarkPaidDialog row={markPaidFor} onClose={() => setMarkPaidFor(null)} onDone={invalidate} />
    </div>
  );
}

// ── Per-tenant dunning timeline ───────────────────────────────────────
export function DunningTimeline({ businessId }: { businessId: string }) {
  const { data: events = [], isLoading } = useQuery({
    queryKey: ['dunning-timeline', businessId],
    queryFn: () => adminApi.dunningTimeline(businessId),
    enabled: !!businessId,
  });

  const variant = (e: string) => (e === 'recovered' ? 'success'
    : e === 'waived' ? 'secondary'
    : e === 'halted' ? 'destructive' : 'warning');

  if (isLoading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (events.length === 0) {
    return <div className="text-sm text-muted-foreground">No dunning events — this tenant has never failed a charge.</div>;
  }
  return (
    <div className="divide-y">
      {events.map((e) => (
        <div key={e.id} className="flex items-start justify-between gap-3 py-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Badge variant={variant(e.event) as any} className="text-[10px]">
                {e.event.replace(/_/g, ' ')}
              </Badge>
              {e.attemptNo ? (
                <span className="text-xs text-muted-foreground">attempt {e.attemptNo}</span>
              ) : null}
              {e.emailed && <span className="text-[10px] text-muted-foreground">· emailed</span>}
            </div>
            {e.reason && <div className="mt-0.5 text-xs text-muted-foreground">{e.reason}</div>}
          </div>
          <div className="shrink-0 text-xs text-muted-foreground">{formatDateTime(e.at)}</div>
        </div>
      ))}
    </div>
  );
}

function TimelineDialog({ row, onClose }: { row: DunningRow | null; onClose: () => void }) {
  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Dunning history · {row?.businessName}</DialogTitle></DialogHeader>
        {row && <DunningTimeline businessId={row.businessId} />}
        <DialogFooter><Button variant="outline" onClick={onClose}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WaiveDialog({ row, onClose, onDone }: {
  row: DunningRow | null; onClose: () => void; onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const waive = useMutation({
    mutationFn: () => adminApi.dunningWaive(row!.businessId, reason.trim()),
    onSuccess: () => {
      toast.success('Cycle waived — subscription reactivated');
      setReason(''); onDone(); onClose();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Waive this cycle · {row?.businessName}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Reactivates the subscription and rolls the billing period forward without
            collecting anything. No invoice is created — revenue reports will correctly
            show nothing was received for this cycle.
          </p>
          <div>
            <Label className="text-sm">Reason (recorded on the audit + dunning trail)</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)}
                   placeholder="e.g. goodwill after the 2-day outage" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => waive.mutate()}
                  disabled={waive.isPending || reason.trim().length < 3}>
            {waive.isPending ? 'Waiving…' : 'Waive cycle'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MarkPaidDialog({ row, onClose, onDone }: {
  row: DunningRow | null; onClose: () => void; onDone: () => void;
}) {
  const [amountInr, setAmountInr] = useState('');
  const [reference, setReference] = useState('');

  const markPaid = useMutation({
    mutationFn: () => adminApi.dunningMarkPaid(row!.businessId, {
      // Blank = charge the full plan price (the backend default).
      amountPaise: amountInr.trim() ? Math.round(Number(amountInr) * 100) : undefined,
      reference: reference.trim() || undefined,
    }),
    onSuccess: () => {
      toast.success('Recorded as paid — invoice created, subscription reactivated');
      setAmountInr(''); setReference(''); onDone(); onClose();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const invalidAmount = amountInr.trim() !== '' && !(Number(amountInr) > 0);

  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Mark paid offline · {row?.businessName}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Use this only when money actually arrived outside Razorpay (bank transfer,
            UPI to the company account, cash). It writes a PAID invoice, so it will show
            up in revenue and GST reports.
          </p>
          <div>
            <Label className="text-sm">
              Amount (₹) — leave blank for the full plan price
              {row ? ` (${formatINR(row.amountAtRiskInr)})` : ''}
            </Label>
            <Input type="number" min="0" step="0.01" value={amountInr}
                   onChange={(e) => setAmountInr(e.target.value)} placeholder="full plan price" />
          </div>
          <div>
            <Label className="text-sm">Reference (UTR / cheque no. / note)</Label>
            <Input value={reference} onChange={(e) => setReference(e.target.value)}
                   placeholder="e.g. UTR 123456789" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => markPaid.mutate()} disabled={markPaid.isPending || invalidAmount}>
            {markPaid.isPending ? 'Recording…' : 'Record payment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
