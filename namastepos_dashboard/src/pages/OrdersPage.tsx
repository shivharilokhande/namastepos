import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Printer, FileText, RotateCcw, Bike } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { NewOrderDialog } from '@/components/NewOrderDialog';
import { ffApi } from '@/api/namastepos';
import { apiError } from '@/api/client';
import { formatINR, formatDateTime } from '@/lib/utils';

const STATUS_TABS = [
  { key: 'pending',    label: 'Pending' },
  { key: 'ready',      label: 'Ready' },
  { key: 'collected',  label: 'Collected' },
  { key: 'cancelled',  label: 'Cancelled' },
];

// Channel tabs let the owner split Zomato/Swiggy "live online orders" from
// in-restaurant POS orders (dineIn + takeaway). Backend resolves the
// `channel=online` / `channel=offline` filter against the order source.
const CHANNEL_TABS = [
  { key: 'all',     label: 'All',     emoji: '📋' },
  { key: 'online',  label: 'Online',  emoji: '🛵', hint: 'Zomato + Swiggy' },
  { key: 'offline', label: 'Offline', emoji: '🏪', hint: 'Dine-in + Takeaway' },
];

const SOURCE_BADGE: Record<string, { label: string; cls: string }> = {
  zomato:   { label: 'Zomato',   cls: 'bg-red-100 text-red-700' },
  swiggy:   { label: 'Swiggy',   cls: 'bg-orange-100 text-orange-700' },
  dineIn:   { label: 'Dine-in',  cls: 'bg-blue-100 text-blue-700' },
  takeaway: { label: 'Takeaway', cls: 'bg-emerald-100 text-emerald-700' },
  other:    { label: 'Other',    cls: 'bg-slate-100 text-slate-700' },
};

export function OrdersPage() {
  const [status, setStatus] = useState('pending');
  const [channel, setChannel] = useState<'all' | 'online' | 'offline'>('all');
  const [newOrderOpen, setNewOrderOpen] = useState(false);
  const [cancelling, setCancelling] = useState<any | null>(null);
  // FF-304 code-review pass — full/partial refund workflow. Backend
  // endpoint already existed; owners couldn't reach it from the UI.
  const [refunding, setRefunding] = useState<any | null>(null);
  // FF-903-b — assign-driver workflow. Owners had drivers listed but
  // no way to attach a driver to a specific order from the queue.
  const [assigning, setAssigning] = useState<any | null>(null);
  const qc = useQueryClient();

  const { data: cancelReasons = [] } = useQuery({
    queryKey: ['cancel-reasons'], queryFn: ffApi.listCancelReasons,
  });

  const reprint = useMutation({
    mutationFn: ffApi.reprintOrder,
    onSuccess: (r: any) => {
      toast.success(`Duplicate printed (copy ${r.reprintCount})`);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  // FF-602: GST E-Invoice (IRN) generation — only meaningful once the
  // order has been settled. Backend posts to the IRP and returns IRN.
  const einvoice = useMutation({
    mutationFn: (orderId: string) => ffApi.generateEinvoice(orderId),
    onSuccess: (irn: any) => {
      toast.success(`IRN generated · ${irn?.irn || 'OK'}`);
      qc.invalidateQueries({ queryKey: ['orders'] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const { data: orders = [], isLoading } = useQuery({
    queryKey: ['orders', status, channel],
    queryFn: () => ffApi.listOrders({
      status,
      ...(channel !== 'all' ? { channel } : {}),
      // Collapse multi-KOT dine-in orders into one bill per session. The
      // backend collapses by table_session_id; takeaway/QR/aggregator
      // orders pass through unchanged. KOT/KDS views call this without
      // groupBy so each ticket stays separate for the kitchen.
      groupBy: 'session',
    }),
    refetchInterval: 5000, // live queue — auto-refresh every 5s
  });

  const update = useMutation({
    mutationFn: ({ id, s }: { id: string; s: string }) => ffApi.updateOrderStatus(id, s),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['orders'] }); },
    onError: (e) => toast.error(apiError(e)),
  });

  // Bill rows wrap multiple KOTs. Tapping "Mark ready" on the bill has
  // to flip EVERY pending KOT, otherwise the collapse logic keeps the
  // bill in Pending (worst-status wins). For plain orders this just
  // updates the one row.
  const updateBill = async (o: any, s: string) => {
    const ids = (o.isBill && Array.isArray(o.kots) && o.kots.length > 0)
      ? o.kots.map((k: any) => k.id).filter(Boolean)
      : [o.id];
    try {
      await Promise.all(ids.map((id: string) => ffApi.updateOrderStatus(id, s)));
      qc.invalidateQueries({ queryKey: ['orders'] });
    } catch (e) {
      toast.error(apiError(e));
    }
  };

  // Per-channel counts shown on the tab chips
  const counts = orders.reduce(
    (acc: any, o: any) => {
      if (['zomato', 'swiggy'].includes(o.source)) acc.online += 1;
      else if (['dineIn', 'takeaway'].includes(o.source)) acc.offline += 1;
      acc.all += 1;
      return acc;
    },
    { all: 0, online: 0, offline: 0 }
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Live orders</h1>
          <p className="text-muted-foreground">
            Auto-refreshes every 5 seconds. Online orders flow in from Zomato &amp; Swiggy;
            offline orders are taken at the counter or table.
          </p>
        </div>
        <Button size="lg" onClick={() => setNewOrderOpen(true)}>
          <Plus className="mr-2 h-5 w-5" /> Take order
        </Button>
      </div>

      {newOrderOpen && <NewOrderDialog onClose={() => setNewOrderOpen(false)} />}

      {/* Channel tabs (online / offline / all) */}
      <div className="grid grid-cols-3 gap-2">
        {CHANNEL_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setChannel(t.key as any)}
            className={`flex items-center justify-between rounded-lg border px-4 py-3 text-left transition-colors ${
              channel === t.key
                ? 'border-primary bg-primary/5 text-primary'
                : 'border-input bg-card hover:bg-accent'
            }`}
          >
            <div>
              <div className="text-sm font-semibold flex items-center gap-2">
                <span className="text-base">{t.emoji}</span> {t.label}
              </div>
              {t.hint && <div className="text-xs text-muted-foreground mt-0.5">{t.hint}</div>}
            </div>
            <div className="text-2xl font-bold tabular-nums">
              {(counts as any)[t.key] ?? 0}
            </div>
          </button>
        ))}
      </div>

      {/* Status tabs (pending / ready / collected / cancelled) */}
      <div className="flex gap-2 border-b overflow-x-auto">
        {STATUS_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setStatus(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
              status === t.key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {isLoading && (
        <Card><CardContent className="p-10 text-center text-muted-foreground">Loading…</CardContent></Card>
      )}
      {!isLoading && orders.length === 0 && (
        <Card>
          <CardContent className="p-10 text-center text-muted-foreground">
            No {status} {channel !== 'all' ? `${channel} ` : ''}orders.
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {orders.map((o: any) => {
          const src = SOURCE_BADGE[o.source] || SOURCE_BADGE.other;
          return (
            <Card key={o.id}>
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {/* Bill rows (groupBy=session) show the pinned bill
                        number; plain orders show their own KOT number. */}
                    <div className="text-xl font-bold">#{o.displayNo ?? o.orderNo}</div>
                    {o.isBill && Array.isArray(o.kots) && o.kots.length > 1 && (
                      <span className="inline-flex items-center rounded-full bg-primary/10 text-primary px-2 py-0.5 text-[10px] font-semibold">
                        {o.kots.length} KOTs
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${src.cls}`}>
                      {src.label}
                    </span>
                    <Badge
                      variant={
                        o.status === 'pending' ? 'warning' :
                        o.status === 'ready' ? 'success' :
                        o.status === 'cancelled' ? 'destructive' : 'muted'
                      }
                    >
                      {o.status}
                    </Badge>
                  </div>
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  {formatDateTime(o.createdAt)}
                </div>
                <ul className="mt-3 space-y-1 text-sm">
                  {o.items.map((it: any, i: number) => (
                    <li key={i} className="flex justify-between">
                      <span>{it.qty} × {it.name}</span>
                      <span className="text-muted-foreground">{formatINR(it.price * it.qty)}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-3 flex justify-between border-t pt-3">
                  <div className="text-xs text-muted-foreground capitalize">
                    {o.tableNo ? `Table ${o.tableNo} · ` : ''}{o.paymentMethod}
                    {o.customerPhone ? ` · ${o.customerPhone}` : ''}
                  </div>
                  <div className="font-bold">{formatINR(o.total)}</div>
                </div>
                {o.status === 'pending' && (
                  <div className="mt-3 flex gap-2">
                    <Button size="sm" className="flex-1"
                      onClick={() => updateBill(o, 'ready')}>
                      Mark ready
                    </Button>
                    <Button size="sm" variant="ghost"
                      onClick={() => setCancelling(o)}>
                      Cancel
                    </Button>
                  </div>
                )}
                {o.status === 'ready' && (
                  <Button size="sm" className="mt-3 w-full"
                    onClick={() => updateBill(o, 'collected')}>
                    Mark collected
                  </Button>
                )}
                {/* FF-903-b — assign a driver on a ready order. Visible
                    for any ready order; the dialog also gates on whether
                    the plan has driver_mode enabled at all. */}
                {o.status === 'ready' && (
                  <Button size="sm" variant="ghost" className="mt-2 w-full"
                    onClick={() => setAssigning(o)}>
                    <Bike className="mr-1 h-3.5 w-3.5" />
                    Assign driver
                  </Button>
                )}
                {/* FF-305: reprint available once the order has been
                    collected or cancelled (i.e. its lifecycle is closed). */}
                {(o.status === 'collected' || o.status === 'cancelled') && (
                  <Button size="sm" variant="ghost" className="mt-3 w-full"
                    onClick={() => reprint.mutate(o.id)} disabled={reprint.isPending}>
                    <Printer className="mr-1 h-3.5 w-3.5" />
                    Reprint {o.reprintCount > 0 ? `(${o.reprintCount + 1})` : ''}
                  </Button>
                )}
                {/* FF-602: e-invoice for B2B orders > 5 lakh OR business has
                    forceEinvoice flag. We surface it on every collected order
                    so the cashier can decide; backend rejects if not B2B-eligible. */}
                {o.status === 'collected' && (
                  <Button size="sm" variant="ghost" className="mt-2 w-full"
                    onClick={() => einvoice.mutate(o.id)} disabled={einvoice.isPending || !!o.irn}>
                    <FileText className="mr-1 h-3.5 w-3.5" />
                    {o.irn ? `IRN ${String(o.irn).slice(0, 12)}…` : 'Generate e-invoice'}
                  </Button>
                )}
                {/* FF-304 partial-refund entry point. Only visible on
                    collected orders (nothing to refund otherwise) and
                    when the order was actually paid (paymentMethod set). */}
                {o.status === 'collected' && o.paymentMethod && (
                  <Button size="sm" variant="ghost" className="mt-2 w-full"
                    onClick={() => setRefunding(o)}>
                    <RotateCcw className="mr-1 h-3.5 w-3.5" />
                    Refund…
                  </Button>
                )}
                {/* FF-501: token display for takeaway */}
                {o.tokenNo && (
                  <div className="mt-2 text-center text-2xl font-extrabold tracking-wider text-primary border-t pt-2">
                    TOKEN #{o.tokenNo}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* FF-503: Cancel with structured reason picker */}
      {cancelling && (
        <CancelOrderDialog
          order={cancelling}
          reasons={cancelReasons}
          onClose={() => setCancelling(null)}
          onCancelled={() => {
            qc.invalidateQueries({ queryKey: ['orders'] });
            setCancelling(null);
          }}
        />
      )}
      {/* FF-304: partial-refund dialog. Renders when the owner taps
          the Refund button on a collected order. */}
      {refunding && (
        <RefundOrderDialog
          order={refunding}
          onClose={() => setRefunding(null)}
          onRefunded={() => {
            qc.invalidateQueries({ queryKey: ['orders'] });
            setRefunding(null);
          }}
        />
      )}
      {/* FF-903-b: assign-driver dialog. */}
      {assigning && (
        <AssignDriverDialog
          order={assigning}
          onClose={() => setAssigning(null)}
          onAssigned={() => {
            qc.invalidateQueries({ queryKey: ['orders'] });
            qc.invalidateQueries({ queryKey: ['live-deliveries'] });
            setAssigning(null);
          }}
        />
      )}
    </div>
  );
}

function CancelOrderDialog({
  order, reasons, onClose, onCancelled,
}: { order: any; reasons: any[]; onClose: () => void; onCancelled: () => void }) {
  const [reasonCode, setReasonCode] = useState(reasons[0]?.code || '');
  const [note, setNote] = useState('');

  const cancel = useMutation({
    mutationFn: () => ffApi.updateOrderStatus(order.id, 'cancelled', note || undefined, reasonCode),
    onSuccess: () => { toast.success('Order cancelled'); onCancelled(); },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Cancel order #{order.orderNo}?</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Reason *</Label>
            <select
              value={reasonCode}
              onChange={(e) => setReasonCode(e.target.value)}
              className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              {reasons.map((r) => (
                <option key={r.id} value={r.code}>{r.label}</option>
              ))}
            </select>
          </div>
          <div>
            <Label>Note (optional)</Label>
            <Input value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="Extra context for the report" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Keep order</Button>
          <Button variant="destructive" onClick={() => cancel.mutate()}
            disabled={cancel.isPending || !reasonCode}>
            {cancel.isPending ? 'Cancelling…' : 'Cancel order'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// FF-304 partial-refund dialog. Two modes:
//   * Amount refund — owner enters a rupee amount ≤ order total.
//   * Item refund   — owner ticks specific items; amount is computed
//                     as sum(qty*price) of ticked items so it reflects
//                     the pre-tax line-item value the customer paid.
// Backend derives whichever path the caller sent (itemIds vs amountInr)
// and issues the reversal through the original payment gateway.
function RefundOrderDialog({
  order, onClose, onRefunded,
}: { order: any; onClose: () => void; onRefunded: () => void }) {
  const orderTotal = Number(order?.total ?? 0);
  const [mode, setMode] = useState<'amount' | 'items'>('amount');
  const [amountStr, setAmountStr] = useState<string>(orderTotal.toFixed(2));
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const [reason, setReason] = useState('');

  const items: Array<{ id?: string; name: string; qty: number; price: number }> =
    Array.isArray(order?.items) ? order.items : [];

  const itemsTotal = items.reduce((sum, it, i) => {
    if (!checked[i]) return sum;
    return sum + Number(it.price ?? 0) * Number(it.qty ?? 0);
  }, 0);

  const parsedAmount = Number.parseFloat(amountStr);
  const effectiveAmount = mode === 'items' ? itemsTotal : parsedAmount;
  const amountValid = Number.isFinite(effectiveAmount)
    && effectiveAmount > 0
    && effectiveAmount <= orderTotal + 0.005;

  const refund = useMutation({
    mutationFn: () => {
      // In item-mode, prefer sending itemIds (backend re-derives the
      // amount from menu-item prices so a stale UI number can't
      // over-refund). If the items don't have IDs (some legacy rows),
      // fall back to amountInr.
      if (mode === 'items') {
        const withIds = items
          .map((it, i) => (checked[i] && it.id ? String(it.id) : null))
          .filter((x): x is string => !!x);
        if (withIds.length > 0) {
          return ffApi.refundOrder(order.id, {
            itemIds: withIds,
            reason: reason || undefined,
          });
        }
        return ffApi.refundOrder(order.id, {
          amountInr: itemsTotal,
          reason: reason || undefined,
        });
      }
      return ffApi.refundOrder(order.id, {
        amountInr: parsedAmount,
        reason: reason || undefined,
      });
    },
    onSuccess: () => {
      toast.success(`Refunded ${formatINR(effectiveAmount)}`);
      onRefunded();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Refund order #{order.orderNo}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            Original total <span className="font-semibold text-foreground">{formatINR(orderTotal)}</span>
            {order.paymentMethod && (
              <> · paid via <span className="font-semibold text-foreground capitalize">{order.paymentMethod}</span></>
            )}
          </div>

          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant={mode === 'amount' ? 'default' : 'outline'}
              onClick={() => setMode('amount')}
            >
              Refund amount
            </Button>
            <Button
              type="button"
              size="sm"
              variant={mode === 'items' ? 'default' : 'outline'}
              onClick={() => setMode('items')}
              disabled={items.length === 0}
            >
              Refund items
            </Button>
          </div>

          {mode === 'amount' && (
            <div>
              <Label>Amount (₹) *</Label>
              <Input
                type="number" step="0.01" min="0" max={orderTotal}
                value={amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
                placeholder="0.00"
              />
              <div className="mt-1 flex gap-1">
                <Button type="button" size="sm" variant="ghost"
                  onClick={() => setAmountStr(orderTotal.toFixed(2))}>
                  Full refund
                </Button>
                <Button type="button" size="sm" variant="ghost"
                  onClick={() => setAmountStr((orderTotal / 2).toFixed(2))}>
                  Half
                </Button>
              </div>
            </div>
          )}

          {mode === 'items' && (
            <div className="max-h-56 overflow-auto rounded-md border">
              {items.length === 0 ? (
                <div className="p-3 text-sm text-muted-foreground">No line items on this order.</div>
              ) : (
                <ul className="divide-y">
                  {items.map((it, i) => {
                    const line = Number(it.price ?? 0) * Number(it.qty ?? 0);
                    return (
                      <li key={i}
                        className="flex items-center justify-between gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-muted/40"
                        onClick={() => setChecked((c) => ({ ...c, [i]: !c[i] }))}
                      >
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={!!checked[i]}
                            onChange={() => setChecked((c) => ({ ...c, [i]: !c[i] }))}
                          />
                          <span>{it.qty} × {it.name}</span>
                        </label>
                        <span className="text-muted-foreground">{formatINR(line)}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="flex justify-between border-t px-3 py-2 text-sm font-semibold">
                <span>Selected total</span><span>{formatINR(itemsTotal)}</span>
              </div>
            </div>
          )}

          <div>
            <Label>Reason (optional)</Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Customer complaint — cold food" />
          </div>

          {!amountValid && (
            <div className="text-xs text-destructive">
              Refund must be greater than {formatINR(0)} and no more than {formatINR(orderTotal)}.
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button
            onClick={() => refund.mutate()}
            disabled={refund.isPending || !amountValid}
          >
            {refund.isPending ? 'Refunding…' : `Refund ${formatINR(effectiveAmount || 0)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// FF-903-b assign-driver dialog. Fetches the driver list on open,
// lets the owner pick one, optionally attach a delivery fee, and
// posts to /orders/:id/assign-driver. If no drivers exist we push
// the owner toward DriversPage instead of showing an empty picker.
function AssignDriverDialog({
  order, onClose, onAssigned,
}: { order: any; onClose: () => void; onAssigned: () => void }) {
  const { data: drivers = [], isLoading: driversLoading, isError, error } = useQuery({
    queryKey: ['drivers'],
    queryFn: ffApi.listDrivers,
  });
  const [driverId, setDriverId] = useState<string>('');
  const [feeInr, setFeeInr] = useState<string>('0');
  const [address, setAddress] = useState<string>(order?.customerAddress || '');

  const assign = useMutation({
    mutationFn: () => {
      const feePaise = Math.round(Number.parseFloat(feeInr || '0') * 100);
      return ffApi.assignDriver(order.id, {
        driverId,
        address: address || undefined,
        deliveryFeePaise: Number.isFinite(feePaise) && feePaise > 0 ? feePaise : 0,
      });
    },
    onSuccess: () => {
      toast.success('Driver assigned');
      onAssigned();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const noDrivers = !driversLoading && drivers.length === 0;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign driver — order #{order.orderNo}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {driversLoading && (
            <div className="text-sm text-muted-foreground">Loading drivers…</div>
          )}
          {isError && (
            <div className="text-sm text-destructive">
              Could not load drivers: {apiError(error)}
            </div>
          )}
          {noDrivers && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              No drivers yet. Add a driver from <span className="font-semibold">Drivers</span> in the sidebar,
              then come back to assign them.
            </div>
          )}

          {!noDrivers && (
            <>
              <div>
                <Label>Driver *</Label>
                <select
                  value={driverId}
                  onChange={(e) => setDriverId(e.target.value)}
                  className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">Choose a driver…</option>
                  {drivers.map((d: any) => {
                    const status = d.status ? ` · ${d.status}` : '';
                    return (
                      <option key={d.id} value={d.id}>
                        {d.name || d.phone || d.id}{status}
                      </option>
                    );
                  })}
                </select>
              </div>
              <div>
                <Label>Delivery address (optional)</Label>
                <Input value={address} onChange={(e) => setAddress(e.target.value)}
                  placeholder="Customer address for this drop" />
              </div>
              <div>
                <Label>Delivery fee (₹, optional)</Label>
                <Input type="number" min="0" step="1" value={feeInr}
                  onChange={(e) => setFeeInr(e.target.value)} />
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button
            onClick={() => assign.mutate()}
            disabled={assign.isPending || !driverId || noDrivers}
          >
            {assign.isPending ? 'Assigning…' : 'Assign'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
