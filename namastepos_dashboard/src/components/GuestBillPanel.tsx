// NamastePOS — Guest running-bill + pay-all panel (FF-251).
//
// Renders inside GuestMenuPage. Polls `/guest/session/:token/current`
// every 15 s while visible so any orders the captain adds server-side
// (or new KOTs the guest just placed) show up without a manual reload.
//
// Pay flow:
//   1. Guest taps "Pay ₹total".
//   2. We call `paySession` → get {razorpayOrderId, keyId, amount, sessionId}.
//   3. Load Razorpay Checkout.js (cached), open the modal.
//   4. On success, POST `/confirm-pay` with the signature. Server
//      settles every order + closes the session + frees the table.
//   5. Show "Payment received" + hide the tab (Panel refetches +
//      backend returns {session: null}).

import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Receipt, IndianRupee, CheckCircle2 } from 'lucide-react';
import { guest } from '@/api/guest';
// Hardcode-audit (2026-08-24): formatINR is safe on guest views — it
// falls back to en-IN / INR when the authed business cache is absent
// (GuestMenuPage, the parent of this panel, already relies on it).
import { formatINR } from '@/lib/utils';

interface Props { token: string; brand?: { color?: string } }

function loadCheckoutJs(): Promise<void> {
  return new Promise((resolve, reject) => {
    if ((window as any).Razorpay) return resolve();
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Razorpay script blocked — check your network / ad-blocker'));
    document.body.appendChild(s);
  });
}

export function GuestBillPanel({ token, brand }: Props) {
  const [finalizing, setFinalizing] = useState(false);
  const q = useQuery({
    queryKey: ['guest-session', token],
    queryFn: () => guest.currentSession(token),
    refetchInterval: 15000,
  });
  const s = q.data;

  const pay = useMutation({
    mutationFn: async () => {
      const rz = await guest.paySession(token);
      await loadCheckoutJs();
      return new Promise<{ paymentId: string; signature: string; orderId: string; sessionId: string }>(
        (resolve, reject) => {
          const opts = {
            key: rz.keyId,
            amount: rz.amount,
            currency: 'INR',
            order_id: rz.razorpayOrderId,
            name: 'NamastePOS',
            description: 'Table bill',
            handler: (r: any) => resolve({
              paymentId: r.razorpay_payment_id,
              signature: r.razorpay_signature,
              orderId: r.razorpay_order_id,
              sessionId: rz.sessionId,
            }),
            modal: { ondismiss: () => reject(new Error('Cancelled')) },
            theme: { color: brand?.color || '#FF6B35' },
          };
          new (window as any).Razorpay(opts).open();
        }
      );
    },
    onSuccess: async (r) => {
      // Review 2026-08-28: the money is ALREADY captured by Razorpay here. If
      // the confirm POST fails, the bill still shows unpaid and the guest could
      // tap Pay again → double charge. So: block re-pay immediately, retry the
      // confirm a few times, and if it still fails show a clear "finalizing"
      // message telling them not to pay again (staff can settle on the POS).
      setFinalizing(true);
      const body = {
        sessionId: r.sessionId,
        razorpayOrderId: r.orderId,
        razorpayPaymentId: r.paymentId,
        razorpaySignature: r.signature,
      };
      let ok = false;
      for (let attempt = 0; attempt < 4 && !ok; attempt += 1) {
        try {
          await guest.confirmSessionPayment(token, body);
          ok = true;
        } catch {
          await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
        }
      }
      if (ok) {
        toast.success('Payment received. Thank you!');
        setFinalizing(false);
        q.refetch();
      } else {
        toast.success('Payment received — finalizing. Please do NOT pay again.');
        // Keep `finalizing` true so the Pay button stays disabled; a later poll
        // (session becomes paid server-side) will flip the panel to "Bill paid".
      }
    },
    onError: (e: any) => {
      if (e.message !== 'Cancelled') toast.error(e.message || 'Payment failed');
    },
  });

  if (q.isLoading) return null;
  if (!s) {
    return (
      <div className="p-6 text-center text-muted-foreground text-sm">
        No open bill on this table yet — place an order first!
      </div>
    );
  }
  if (s.paid) {
    return (
      <div className="p-6 text-center space-y-2">
        <CheckCircle2 className="w-10 h-10 mx-auto text-emerald-600" />
        <div className="font-semibold text-emerald-700">Bill paid</div>
        <div className="text-xs text-muted-foreground">Enjoy your meal 🎉</div>
      </div>
    );
  }
  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Receipt className="w-4 h-4 text-primary" />
        <h2 className="font-semibold">Your bill</h2>
      </div>
      <div className="border rounded-lg divide-y">
        {s.orders.map((o: any) => (
          <div key={o.id} className="p-3 space-y-1">
            <div className="text-xs text-muted-foreground">Order #{o.orderNo}</div>
            {o.items.map((it: any, i: number) => (
              <div key={i} className="flex justify-between text-sm">
                <span>{it.name} × {it.qty}{it.note ? <span className="italic text-muted-foreground"> · {it.note}</span> : null}</span>
                <span>{formatINR(it.price * it.qty, { decimals: true })}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="space-y-1 text-sm">
        <div className="flex justify-between"><span>Subtotal</span><span>{formatINR(s.totals.subtotal, { decimals: true })}</span></div>
        {s.totals.discount > 0 && <div className="flex justify-between text-emerald-700"><span>Discount</span><span>−{formatINR(s.totals.discount, { decimals: true })}</span></div>}
        {s.totals.tax > 0 && <div className="flex justify-between"><span>Tax</span><span>{formatINR(s.totals.tax, { decimals: true })}</span></div>}
        <div className="flex justify-between font-bold text-base border-t pt-2 mt-2">
          <span>Total</span><span>{formatINR(s.totals.total, { decimals: true })}</span>
        </div>
      </div>
      {finalizing && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 text-center">
          Payment received — finalizing your bill. Please do <strong>not</strong> pay again.
        </div>
      )}
      <button
        disabled={pay.isPending || finalizing || s.totals.total <= 0}
        onClick={() => pay.mutate()}
        className="w-full h-12 rounded-lg text-white font-semibold flex items-center justify-center gap-2 disabled:opacity-60"
        style={{ background: brand?.color || '#FF6B35' }}>
        <IndianRupee className="w-4 h-4" />
        {finalizing ? 'Finalizing…' : pay.isPending ? 'Opening payment…' : `Pay ${formatINR(s.totals.total, { decimals: true })}`}
      </button>
      <p className="text-[11px] text-center text-muted-foreground">
        Secure UPI / card / netbanking via Razorpay. No NamastePOS account needed.
      </p>
    </div>
  );
}
