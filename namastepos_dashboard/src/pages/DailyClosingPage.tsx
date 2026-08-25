import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ClipboardCheck, Lock, Unlock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { ffApi } from '@/api/namastepos';
import { api, apiError, getBusinessCache } from '@/api/client';
import { formatINR } from '@/lib/utils';

export function DailyClosingPage() {
  const qc = useQueryClient();
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [cashCounted, setCashCounted] = useState<number>(0);
  const [notes, setNotes] = useState('');
  const [signature, setSignature] = useState('');
  const [confirmUnlock, setConfirmUnlock] = useState(false);

  const { data: preview, refetch } = useQuery({
    queryKey: ['closing-preview', date],
    queryFn: () => ffApi.previewClosing(date),
  });
  const { data: history = [] } = useQuery({
    queryKey: ['closings'], queryFn: ffApi.listClosings,
  });

  const close = useMutation({
    mutationFn: () => ffApi.closeDay({
      date, cashCounted: Math.round(cashCounted * 100), notes, signature,
    }),
    onSuccess: () => {
      toast.success('Day closed and locked');
      qc.invalidateQueries({ queryKey: ['closings'] });
      qc.invalidateQueries({ queryKey: ['closing-preview'] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const reopen = useMutation({
    // WHY (2026-08-25, Bug #11b): ffApi has no reopen helper yet, so call the
    // backend endpoint directly: POST /businesses/:id/daily-closings/:date/reopen
    // (owner-only, responds { success: true }). It deletes the closing row and
    // clears day_closed on that day's orders.
    mutationFn: () => {
      const b = getBusinessCache();
      return api.post(`/businesses/${b.id}/daily-closings/${date}/reopen`).then((r) => r.data);
    },
    onSuccess: () => {
      setConfirmUnlock(false);
      toast.success(`Day ${date} unlocked`);
      qc.invalidateQueries({ queryKey: ['closings'] });
      qc.invalidateQueries({ queryKey: ['closing-preview'] });
    },
    onError: (e: any) => {
      setConfirmUnlock(false);
      // WHY (2026-08-25, Bug #11b): backend gates reopen behind
      // requireRole(['business_owner']) — managers get a 403. Show a human
      // message for that case instead of the raw error code.
      if (e?.response?.status === 403) toast.error('Only the owner can unlock a closed day');
      else toast.error(apiError(e));
    },
  });

  if (!preview) return <div className="p-10 text-center text-muted-foreground">Loading…</div>;

  const expected = (preview.cashExpectedPaise || 0) / 100;
  const variance = cashCounted - expected;

  // WHY (2026-08-25, Bug #11b): a day is "locked" iff a daily_closings row
  // exists for it (reopen deletes the row, so no separate flag). pg may
  // serialize closing_date as a bare date or a full ISO timestamp, so
  // compare on the YYYY-MM-DD prefix only.
  const isLocked = history.some((c: any) => String(c.closing_date).slice(0, 10) === date);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <ClipboardCheck className="h-6 w-6 text-primary" /> Daily closing (Z-report)
        </h1>
        <p className="text-muted-foreground text-sm">
          Reconcile cash, lock the day, and sign off.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Preview for {date}</span>
            <Input type="date" value={date} onChange={(e) => { setDate(e.target.value); setTimeout(refetch, 100); }} className="max-w-[180px]" />
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Tile label="Orders"        value={preview.orderCount} />
            <Tile label="Gross sales"   value={formatINR(preview.grossSales)} />
            <Tile label="Discounts"     value={formatINR(preview.discountsGiven?.given || 0)} />
            <Tile label="Cancellations" value={Object.values(preview.cancellations || {}).reduce((s: number, x: any) => s + x.count, 0)} />
          </div>

          <div>
            <div className="text-xs font-bold uppercase mt-3">Payment breakdown</div>
            {Object.entries(preview.paymentBreakdown || {}).map(([m, v]: any) => (
              <div key={m} className="flex justify-between py-1 border-b text-sm">
                <span className="capitalize">{m}</span>
                {/* Bug fix (2026-08-20): the earlier "{count} × · {amount}"
                    layout was reading as "count × amount" ("2 × ₹250")
                    when the actual meaning is "2 orders totalling ₹250".
                    Split it clearly. */}
                <span>{v.count} order{v.count === 1 ? '' : 's'} · <span className="font-medium">{formatINR(v.amount)}</span></span>
              </div>
            ))}
          </div>

          <div className="border-t pt-3">
            <div className="text-xs font-bold uppercase mb-2">Cash drawer</div>
            <div className="flex justify-between"><span>Expected</span><span className="font-bold">{formatINR(expected)}</span></div>
            <div className="grid grid-cols-2 gap-2 mt-2">
              <div>
                <Label>Counted (₹)</Label>
                <Input type="number" value={cashCounted} onChange={(e) => setCashCounted(+e.target.value)} />
              </div>
              <div>
                <Label>Variance</Label>
                <div className={`mt-1 px-3 py-2 rounded-md border text-right font-bold ${variance < 0 ? 'border-red-300 bg-red-50 text-red-700' : 'border-emerald-300 bg-emerald-50 text-emerald-700'}`}>
                  {formatINR(variance)}
                </div>
              </div>
            </div>
            <div className="mt-3"><Label>Cashier signature</Label><Input value={signature} onChange={(e) => setSignature(e.target.value)} placeholder="Type your name" /></div>
            <div className="mt-3"><Label>Notes</Label><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything unusual today?" /></div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button onClick={() => close.mutate()} disabled={close.isPending || !signature}>
                <Lock className="mr-2 h-4 w-4" /> Close &amp; lock {date}
              </Button>
              {/* WHY (2026-08-25, Bug #11b): mobile already exposes reopen but
                  the dashboard had no way to unlock a mis-closed day. Only
                  rendered when this date is locked (a closing row exists). */}
              {isLocked && (
                <Button variant="destructive" onClick={() => setConfirmUnlock(true)} disabled={reopen.isPending}>
                  <Unlock className="mr-2 h-4 w-4" /> Unlock day
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">History</CardTitle></CardHeader>
        <CardContent className="text-sm">
          {history.length === 0 && <div className="text-muted-foreground">No prior closings.</div>}
          {history.map((c: any) => (
            <div key={c.id} className="flex justify-between py-1 border-b">
              <span>{c.closing_date}</span>
              <span>{formatINR((c.cash_counted || 0) / 100)} (variance {formatINR(c.variance / 100)})</span>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* WHY (2026-08-25, Bug #11b): unlocking deletes the Z-report and lets
          that day's orders be edited again — destructive enough to warrant an
          explicit confirm instead of a one-click action. */}
      {confirmUnlock && (
        <Dialog open onOpenChange={(o) => !o && setConfirmUnlock(false)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Unlock {date}?</DialogTitle></DialogHeader>
            <p className="text-sm text-muted-foreground">
              Unlocking lets entries be edited — owner only. The Z-report for this day
              will be deleted, and the day must be closed and signed off again.
            </p>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirmUnlock(false)}>Cancel</Button>
              <Button variant="destructive" onClick={() => reopen.mutate()} disabled={reopen.isPending}>
                <Unlock className="mr-2 h-4 w-4" /> Unlock day
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: any }) {
  return (
    <div className="bg-muted/40 rounded p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-bold">{value}</div>
    </div>
  );
}
