// BillSplitDialog — split a running table-session bill across multiple guests.
// Modes:
//   • equal  → divide total / N (₹ remainder lands on guest 1, paisa-exact)
//   • custom → enter an arbitrary amount per guest (sum must match bill)
//
// The "by_item" mode is supported by the backend but requires the order_item
// IDs from session.items. We expose it as a manual-line variant where the
// cashier toggles which items belong to which guest.
import { useState, useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Users, Plus, Trash2, IndianRupee, Receipt } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { ffApi } from '@/api/namastepos';
import { apiError } from '@/api/client';
import { formatINR } from '@/lib/utils';

type Mode = 'equal' | 'custom';
type Guest = { guestLabel: string; customerPhone?: string; amount?: number };

export function BillSplitDialog({
  sessionId,
  totalInr,
  paidInr = 0,
  onClose,
}: {
  sessionId: string;
  /** Round 3 (2026-09-06): the BALANCE due — KOTs already paid at "Pay &
   *  place" are excluded by the caller (TablesPage → sessionDue). */
  totalInr: number;
  /** What was already collected at order time (display only). */
  paidInr?: number;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<Mode>('equal');
  const [guests, setGuests] = useState<Guest[]>([
    { guestLabel: 'Guest 1' },
    { guestLabel: 'Guest 2' },
  ]);
  const [created, setCreated] = useState<any | null>(null);

  // After splitting we show the per-guest invoices and let the cashier
  // mark each one paid as the cash/UPI hits the till.
  // 2026-08-31 review fix: this used to be a useQuery keyed on created.id.
  // Because pay.onSuccess mutates `created` state WITHOUT changing the id,
  // the query key stayed stable and React Query never re-ran queryFn — so the
  // rendered `split` was frozen at the first snapshot: PAID badges never
  // flipped, allPaid never became true, and settled rows stayed clickable
  // (double-collection risk). Render straight from the `created` state so every
  // setCreated re-render reflects reality.
  const split = created;

  const totalCustom = useMemo(
    () => guests.reduce((s, g) => s + (g.amount || 0), 0),
    [guests]
  );
  const remainder = Math.round((totalInr - totalCustom) * 100) / 100;

  const update = (i: number, patch: Partial<Guest>) =>
    setGuests((arr) => arr.map((g, idx) => (idx === i ? { ...g, ...patch } : g)));

  const addGuest = () =>
    setGuests((arr) => [...arr, { guestLabel: `Guest ${arr.length + 1}` }]);

  const removeGuest = (i: number) =>
    setGuests((arr) => (arr.length <= 2 ? arr : arr.filter((_, idx) => idx !== i)));

  // When switching to "equal", prefill the auto-computed per-head amount so
  // the cashier sees what'll happen before they click Split.
  const perHead = Math.floor((totalInr * 100) / guests.length) / 100;

  const split$ = useMutation({
    mutationFn: () => {
      if (mode === 'equal') {
        return ffApi.splitBill(sessionId, {
          mode: 'equal',
          splits: guests.map((g) => ({ guestLabel: g.guestLabel, customerPhone: g.customerPhone })),
        });
      }
      return ffApi.splitBill(sessionId, {
        mode: 'custom',
        splits: guests.map((g) => ({
          guestLabel: g.guestLabel,
          customerPhone: g.customerPhone,
          amount: g.amount || 0,
        })),
      });
    },
    onSuccess: (s: any) => {
      toast.success(`Created ${s.invoices?.length || guests.length} split invoices`);
      setCreated(s);
      qc.invalidateQueries({ queryKey: ['ops-tables'] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const pay = useMutation({
    mutationFn: ({ id, method }: { id: string; method: string }) =>
      ffApi.paySplitInvoice(id, method),
    onSuccess: (updated: any) => {
      toast.success(`Marked paid · ${updated.payment_method?.toUpperCase()}`);
      // Refresh the local split state so paid invoices flip badge live
      setCreated((prev: any) => prev && {
        ...prev,
        invoices: prev.invoices.map((iv: any) => iv.id === updated.id ? updated : iv),
      });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  // STAGE 1: configure the split
  if (!split) return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5 text-primary" /> Split bill
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          {/* Bill total */}
          <div className="rounded-lg bg-muted p-3 flex items-center justify-between">
            <div className="text-muted-foreground">
              {paidInr > 0 ? 'Balance to split' : 'Total to split'}
              {paidInr > 0 && (
                <div className="text-[11px] text-emerald-700">
                  {formatINR(paidInr, { decimals: true })} already paid at order time
                </div>
              )}
            </div>
            <div className="font-bold text-xl">{formatINR(totalInr)}</div>
          </div>

          {/* Mode picker */}
          <div className="flex gap-2">
            {(['equal', 'custom'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`flex-1 h-10 rounded-md border text-sm font-medium capitalize transition-colors ${
                  mode === m
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-input hover:bg-accent'
                }`}
              >
                {m === 'equal' ? 'Equal split' : 'Custom amounts'}
              </button>
            ))}
          </div>

          {mode === 'equal' && (
            <div className="text-xs text-muted-foreground">
              Each guest pays approximately <strong>{formatINR(perHead)}</strong>.
              Any rounding remainder lands on Guest 1.
            </div>
          )}
          {mode === 'custom' && (
            <div className={`text-xs ${Math.abs(remainder) < 0.01 ? 'text-emerald-700' : 'text-amber-700'}`}>
              Sum so far: <strong>{formatINR(totalCustom)}</strong>
              {Math.abs(remainder) >= 0.01 && (
                <> · remaining <strong>{formatINR(remainder)}</strong></>
              )}
            </div>
          )}

          {/* Guest rows */}
          <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
            {guests.map((g, i) => (
              <div key={i} className="grid grid-cols-12 gap-2 items-end">
                <div className="col-span-4">
                  {i === 0 && <Label className="text-xs">Name</Label>}
                  <Input value={g.guestLabel} onChange={(e) => update(i, { guestLabel: e.target.value })} />
                </div>
                <div className="col-span-4">
                  {i === 0 && <Label className="text-xs">Phone (optional)</Label>}
                  <Input
                    placeholder="98765 43210"
                    value={g.customerPhone || ''}
                    onChange={(e) => update(i, { customerPhone: e.target.value })}
                  />
                </div>
                <div className="col-span-3">
                  {i === 0 && <Label className="text-xs">Amount (₹)</Label>}
                  {mode === 'custom' ? (
                    <Input
                      type="number"
                      step="0.01"
                      value={g.amount ?? ''}
                      onChange={(e) => update(i, { amount: parseFloat(e.target.value) || 0 })}
                    />
                  ) : (
                    <div className="h-10 px-3 rounded-md border border-input bg-muted/50 flex items-center text-sm text-muted-foreground">
                      ≈ {formatINR(perHead)}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => removeGuest(i)}
                  disabled={guests.length <= 2}
                  className="col-span-1 h-10 grid place-items-center rounded-md text-muted-foreground hover:bg-accent disabled:opacity-30 disabled:cursor-not-allowed"
                  title="Remove guest"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>

          <Button variant="outline" size="sm" onClick={addGuest} className="w-full">
            <Plus className="mr-1 h-3 w-3" /> Add guest
          </Button>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => split$.mutate()}
            disabled={
              split$.isPending ||
              guests.length < 2 ||
              guests.some((g) => !g.guestLabel) ||
              (mode === 'custom' && Math.abs(remainder) >= 0.01)
            }
          >
            <Receipt className="mr-1 h-4 w-4" />
            {split$.isPending ? 'Splitting…' : `Split into ${guests.length} bills`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  // STAGE 2: settle each split invoice (one Pay button per guest)
  const allPaid = (split?.invoices || []).every((iv: any) => iv.status === 'paid');
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IndianRupee className="h-5 w-5 text-primary" /> Settle splits
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-2 text-sm">
          {(split?.invoices || []).map((iv: any) => (
            <SplitInvoiceRow
              key={iv.id}
              invoice={iv}
              busy={pay.isPending}
              onPay={(method) => pay.mutate({ id: iv.id, method })}
            />
          ))}
        </div>

        <DialogFooter>
          <Button onClick={onClose} variant={allPaid ? 'default' : 'outline'}>
            {allPaid ? 'Done — all paid' : 'Close (settle remaining later)'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SplitInvoiceRow({ invoice, onPay, busy }: { invoice: any; onPay: (method: string) => void; busy?: boolean }) {
  const [picking, setPicking] = useState(false);
  const paid = invoice.status === 'paid';
  return (
    <div className={`rounded-lg border p-3 ${paid ? 'bg-emerald-50 border-emerald-200' : 'bg-card'}`}>
      <div className="flex items-center justify-between">
        <div>
          <div className="font-medium">{invoice.guest_label}</div>
          {invoice.customer_phone && (
            <div className="text-xs text-muted-foreground">📞 {invoice.customer_phone}</div>
          )}
        </div>
        <div className="text-right">
          <div className="font-bold">{formatINR((invoice.amount_paise || 0) / 100)}</div>
          {paid ? (
            <Badge variant="success" className="mt-1 text-[10px]">PAID · {invoice.payment_method?.toUpperCase()}</Badge>
          ) : (
            <Badge variant="warning" className="mt-1 text-[10px]">UNPAID</Badge>
          )}
        </div>
      </div>
      {!paid && (
        <>
          {!picking ? (
            <Button size="sm" className="w-full mt-2" onClick={() => setPicking(true)}>
              Mark paid
            </Button>
          ) : (
            <div className="grid grid-cols-3 gap-1 mt-2">
              {(['cash', 'upi', 'card'] as const).map((m) => (
                <Button key={m} size="sm" variant="outline" disabled={busy}
                  onClick={() => { if (busy) return; onPay(m); setPicking(false); }}>
                  {m.toUpperCase()}
                </Button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
