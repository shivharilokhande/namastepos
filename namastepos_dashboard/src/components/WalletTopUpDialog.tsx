// WalletTopUpDialog — load money into a customer's wallet at the counter.
//
// Round 3 (2026-09-06, founder Bug 1b): when the wallet cannot cover the
// bill, the cashier can either "Cover shortfall" (wallet + another tender)
// or take cash/UPI/card INTO the wallet first and then pay the whole bill
// from it. This is the second path. Used from NewOrderDialog (order time)
// and TablesPage's SessionDialog (settle time).
//
// API: POST /businesses/:bid/customers/:customerId/wallet/topup
//      { amountInr, method: 'cash'|'upi'|'card', note? }
//   → { wallet: { balancePaise }, transaction: { id } }   (round-3 contract)
//   → { balance }                                          (pre-round-3 shape)
// Both shapes are accepted so the dialog keeps working across the deploy.
// The caller invalidates ['cust-wallet'] in onDone so every balance on
// screen refreshes.

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Wallet } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, apiError, getBusinessCache } from '@/api/client';
import { formatINR } from '@/lib/utils';
import { r2 } from '@/lib/checkout';

export type TopUpMethod = 'cash' | 'upi' | 'card';
const TOPUP_METHODS: TopUpMethod[] = ['cash', 'upi', 'card'];

export async function walletTopUpApi(
  customerId: string,
  body: { amountInr: number; method: TopUpMethod; note?: string },
): Promise<{ balanceInr: number }> {
  const b = getBusinessCache();
  const r = await api.post(`/businesses/${b.id}/customers/${customerId}/wallet/topup`, body);
  const d = r.data || {};
  const balanceInr = d.wallet?.balancePaise != null
    ? Number(d.wallet.balancePaise) / 100
    : d.balancePaise != null
      ? Number(d.balancePaise) / 100
      : Number(d.balance ?? d.balanceInr ?? 0);
  return { balanceInr: r2(balanceInr) };
}

export function WalletTopUpDialog({
  customerId, customerLabel, currentBalanceInr, suggestedInr, onClose, onDone,
}: {
  customerId: string;
  customerLabel: string;
  currentBalanceInr: number;
  /** Pre-filled amount — the shortfall when opened from a checkout. */
  suggestedInr?: number;
  onClose: () => void;
  onDone: (balanceInr: number) => void;
}) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState<string>(
    suggestedInr && suggestedInr > 0 ? suggestedInr.toFixed(2) : '',
  );
  const [method, setMethod] = useState<TopUpMethod>('cash');
  const [note, setNote] = useState('');
  const amountInr = r2(parseFloat(amount) || 0);
  const valid = amountInr > 0;

  const topUp = useMutation({
    mutationFn: () => walletTopUpApi(customerId, {
      amountInr, method, note: note.trim() || undefined,
    }),
    onSuccess: ({ balanceInr }) => {
      toast.success(`Wallet topped up ${formatINR(amountInr, { decimals: true })} by ${method.toUpperCase()} — balance ${formatINR(balanceInr, { decimals: true })}`);
      // Every wallet read on screen (order dialog, settle dialog, customer
      // drawer) keys off ['cust-wallet', customerId] / ['customer-wallet', id].
      qc.invalidateQueries({ queryKey: ['cust-wallet'] });
      qc.invalidateQueries({ queryKey: ['customer-wallet'] });
      qc.invalidateQueries({ queryKey: ['cust-profile'] });
      onDone(balanceInr);
    },
    onError: (e: any) => toast.error(apiError(e) || 'Could not top up wallet'),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wallet className="h-5 w-5 text-primary" /> Top up wallet
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="rounded-md bg-muted p-2 text-xs flex items-center justify-between">
            <span className="truncate"><strong>{customerLabel}</strong></span>
            <span>Balance {formatINR(currentBalanceInr, { decimals: true })}</span>
          </div>
          <div>
            <Label className="text-xs">Amount (₹)</Label>
            <Input type="number" min={0} step="0.01" autoFocus value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00" className="mt-1 h-9" data-testid="topup-amount" />
            {suggestedInr && suggestedInr > 0 ? (
              <div className="text-[11px] text-muted-foreground mt-1">
                Shortfall on this bill is {formatINR(suggestedInr, { decimals: true })}.
              </div>
            ) : null}
          </div>
          <div>
            <Label className="text-xs">Customer pays by</Label>
            <div className="grid grid-cols-3 gap-1 mt-1">
              {TOPUP_METHODS.map((m) => (
                <button key={m} type="button" onClick={() => setMethod(m)}
                  className={`h-9 rounded-md border text-xs font-semibold uppercase transition-colors ${
                    method === m ? 'border-primary bg-primary/10 text-primary' : 'border-input hover:bg-accent'
                  }`}>{m}</button>
              ))}
            </div>
          </div>
          <div>
            <Label className="text-xs">Note (optional)</Label>
            <Input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)}
              placeholder="Advance for today's bill" className="mt-1 h-9" />
          </div>
          {valid && (
            <div className="text-xs text-muted-foreground">
              New balance will be{' '}
              <strong>{formatINR(r2(currentBalanceInr + amountInr), { decimals: true })}</strong>.
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={topUp.isPending}>Cancel</Button>
          <Button onClick={() => topUp.mutate()} disabled={!valid || topUp.isPending}>
            {topUp.isPending ? '…' : `Add ${valid ? formatINR(amountInr, { decimals: true }) : ''} to wallet`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
