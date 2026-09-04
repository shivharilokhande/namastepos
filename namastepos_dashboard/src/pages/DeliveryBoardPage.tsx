// NamastePOS dashboard — Delivery fulfilment board (2026-09-04)
//
// One screen a counter tablet can be driven from with a thumb: live delivery
// orders grouped into state columns, each card carrying the order number, a
// ticking minutes-since-placed, the diner, and exactly the buttons the
// BACKEND says are legal (`order.nextStates`). We never hardcode the ladder
// — an aggregator order can arrive already accepted, and the transition
// graph lives server-side.
//
// Deliberately NOT optimistic: a POS that shows "Food ready" before the
// server agrees is worse than a half-second of latency, so every action
// just invalidates the board query on success. A 409 means another device
// (KDS, the mobile app, an aggregator webhook) moved the order first —
// refetch immediately and say so, rather than leaving a stale card.

import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Bike, Phone, Clock, User, AlertTriangle } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { ffApi } from '@/api/namastepos';
import type { FulfilmentOrder, FulfilmentState, FulfilmentTransitionBody } from '@/api/namastepos';
import { apiError } from '@/api/client';
import { formatINR } from '@/lib/utils';

// Restaurant language, never enum names — the person reading this is
// plating food, not debugging a state machine.
const STATE_LABEL: Record<FulfilmentState, string> = {
  placed: 'New',
  accepted: 'Accepted',
  preparing: 'Preparing',
  food_ready: 'Food ready',
  rider_assigned: 'With delivery partner',
  picked_up: 'With delivery partner',
  delivered: 'Delivered',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

// What the BUTTON does, phrased as the outcome.
const ACTION_LABEL: Record<FulfilmentState, string> = {
  placed: 'Move to New',
  accepted: 'Accept',
  preparing: 'Start preparing',
  food_ready: 'Food ready',
  rider_assigned: 'Assign partner',
  picked_up: 'Hand over',
  delivered: 'Mark delivered',
  rejected: 'Reject',
  cancelled: 'Cancel',
};

const STATE_BADGE: Record<FulfilmentState, 'default' | 'success' | 'warning' | 'muted' | 'destructive'> = {
  placed: 'warning',
  accepted: 'default',
  preparing: 'default',
  food_ready: 'success',
  rider_assigned: 'muted',
  picked_up: 'muted',
  delivered: 'success',
  rejected: 'destructive',
  cancelled: 'muted',
};

// The board's columns. `rider_assigned` and `picked_up` share one column —
// to the counter they're the same situation ("it's with the partner"), and
// two near-empty columns would waste tablet width.
const COLUMNS: { key: string; label: string; states: FulfilmentState[] }[] = [
  { key: 'new',      label: 'New',                   states: ['placed'] },
  { key: 'accepted', label: 'Accepted',              states: ['accepted'] },
  { key: 'prep',     label: 'Preparing',             states: ['preparing'] },
  { key: 'ready',    label: 'Food ready',            states: ['food_ready'] },
  { key: 'rider',    label: 'With delivery partner', states: ['rider_assigned', 'picked_up'] },
];

const QUICK_PREP = [10, 15, 20, 30];

function minutesSince(iso: string, now: number): number {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now - t) / 60000));
}

type Pending =
  | { kind: 'accept'; order: FulfilmentOrder }
  | { kind: 'reject'; order: FulfilmentOrder }
  | { kind: 'cancel'; order: FulfilmentOrder }
  | { kind: 'rider'; order: FulfilmentOrder }
  | { kind: 'handover'; order: FulfilmentOrder };

export function DeliveryBoardPage() {
  const qc = useQueryClient();
  const [pending, setPending] = useState<Pending | null>(null);

  const { data: orders = [], isLoading } = useQuery<FulfilmentOrder[]>({
    queryKey: ['fulfilment-board'],
    queryFn: ffApi.fulfilmentBoard,
    refetchInterval: 10_000,
  });

  // Drives the "N min ago" counters so they tick between polls instead of
  // freezing until the next refetch.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['fulfilment-board'] });

  const transition = useMutation({
    mutationFn: ({ orderId, body }: { orderId: string; body: FulfilmentTransitionBody }) =>
      ffApi.fulfilmentTransition(orderId, body),
    onSuccess: (order) => {
      setPending(null);
      invalidate();
      toast.success(`#${order.orderNo} · ${STATE_LABEL[order.state]}`);
    },
    onError: (e: any) => {
      // 409 = the transition was illegal by the time it landed, i.e. someone
      // else already moved this order. Pull the truth back immediately.
      if (e?.response?.status === 409) {
        invalidate();
        toast.error('Someone else already moved this order — refreshed the board.');
        setPending(null);
        return;
      }
      toast.error(apiError(e));
    },
  });

  const move = (order: FulfilmentOrder, state: FulfilmentState, extra?: Partial<FulfilmentTransitionBody>) =>
    transition.mutate({ orderId: order.id, body: { state, ...extra } });

  // A tap on a nextState either fires straight away (Food ready, Mark
  // delivered, Start preparing) or opens the sheet that collects what the
  // backend requires for that state.
  const onAction = (order: FulfilmentOrder, state: FulfilmentState) => {
    if (state === 'accepted') return setPending({ kind: 'accept', order });
    if (state === 'rejected') return setPending({ kind: 'reject', order });
    if (state === 'cancelled') return setPending({ kind: 'cancel', order });
    if (state === 'rider_assigned') return setPending({ kind: 'rider', order });
    // Handover always confirms; the dialog only asks for a code when the
    // backend flagged the order as needing one.
    if (state === 'picked_up') return setPending({ kind: 'handover', order });
    move(order, state);
  };

  const grouped = useMemo(() => {
    const map: Record<string, FulfilmentOrder[]> = {};
    for (const col of COLUMNS) map[col.key] = [];
    for (const o of orders) {
      const col = COLUMNS.find((c) => c.states.includes(o.state));
      if (col) map[col.key].push(o);
    }
    // Oldest first inside a column: the order that has been waiting longest
    // is the one the counter should touch next.
    for (const key of Object.keys(map)) {
      map[key].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    }
    return map;
  }, [orders]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Bike className="h-6 w-6 text-primary" /> Delivery board
        </h1>
        <p className="text-muted-foreground text-sm">
          Live delivery orders — accept, cook, hand over. Refreshes every 10 seconds.
        </p>
      </div>

      {orders.length === 0 && !isLoading && (
        <Card>
          <CardContent className="py-16 text-center text-muted-foreground">
            No live delivery orders.
          </CardContent>
        </Card>
      )}

      {orders.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3 items-start">
          {COLUMNS.map((col) => (
            <div key={col.key} className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <span className="text-sm font-semibold">{col.label}</span>
                <Badge variant="muted">{grouped[col.key].length}</Badge>
              </div>
              {grouped[col.key].length === 0 && (
                <div className="rounded-md border border-dashed py-6 text-center text-xs text-muted-foreground">
                  Empty
                </div>
              )}
              {grouped[col.key].map((o) => (
                <OrderCard
                  key={o.id}
                  order={o}
                  now={now}
                  busy={transition.isPending}
                  onAction={onAction}
                />
              ))}
            </div>
          ))}
        </div>
      )}

      {pending?.kind === 'accept' && (
        <AcceptDialog
          order={pending.order}
          busy={transition.isPending}
          onClose={() => setPending(null)}
          onConfirm={(prepMinutes) => move(pending.order, 'accepted', { prepMinutes })}
        />
      )}
      {pending?.kind === 'reject' && (
        <ReasonDialog
          order={pending.order}
          busy={transition.isPending}
          onClose={() => setPending(null)}
          onConfirm={(reason) => move(pending.order, 'rejected', { reason })}
        />
      )}
      {pending?.kind === 'cancel' && (
        <ReasonDialog
          order={pending.order}
          mode="cancel"
          busy={transition.isPending}
          onClose={() => setPending(null)}
          onConfirm={(reason) => move(pending.order, 'cancelled', reason ? { reason } : undefined)}
        />
      )}
      {pending?.kind === 'rider' && (
        <RiderDialog
          order={pending.order}
          busy={transition.isPending}
          onClose={() => setPending(null)}
          onConfirm={(rider) => move(pending.order, 'rider_assigned', { rider })}
        />
      )}
      {pending?.kind === 'handover' && (
        <HandoverDialog
          order={pending.order}
          busy={transition.isPending}
          onClose={() => setPending(null)}
          onConfirm={(otp) => move(pending.order, 'picked_up', otp ? { otp } : undefined)}
        />
      )}
    </div>
  );
}

function OrderCard({
  order, now, busy, onAction,
}: {
  order: FulfilmentOrder;
  now: number;
  busy: boolean;
  onAction: (o: FulfilmentOrder, s: FulfilmentState) => void;
}) {
  const mins = minutesSince(order.createdAt, now);
  // Anything sitting unaccepted past 5 minutes is the thing that loses a
  // rating, so it gets a visible edge.
  const late = order.state === 'placed' && mins >= 5;

  // Cancel is available on nearly every rung but it is never the button a
  // counter should hit by accident — it goes last, quiet and outlined.
  const primaryStates = order.nextStates.filter((s) => s !== 'cancelled' && s !== 'rejected');
  const rejectState = order.nextStates.find((s) => s === 'rejected');
  const cancelState = order.nextStates.find((s) => s === 'cancelled');

  return (
    <Card className={late ? 'border-destructive' : undefined}>
      <CardContent className="p-3 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="text-xl font-bold leading-none">#{order.orderNo}</div>
          <Badge variant={STATE_BADGE[order.state]}>{STATE_LABEL[order.state]}</Badge>
        </div>

        <div className={`flex items-center gap-1 text-xs ${late ? 'text-destructive font-semibold' : 'text-muted-foreground'}`}>
          <Clock className="h-3 w-3" />
          {mins === 0 ? 'just now' : `${mins} min ago`}
          {order.prepMinutes ? ` · ${order.prepMinutes} min prep` : ''}
        </div>

        <div className="text-sm">
          <div className="flex items-center gap-1 font-medium">
            <User className="h-3 w-3 text-muted-foreground" />
            {order.customerName || 'Walk-in'}
          </div>
          {order.customerPhone && (
            <a href={`tel:${order.customerPhone}`} className="flex items-center gap-1 text-xs text-muted-foreground hover:underline">
              <Phone className="h-3 w-3" /> {order.customerPhone}
            </a>
          )}
        </div>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{order.source || order.channel || 'delivery'}</span>
          <span className="font-semibold text-foreground">{formatINR(Number(order.total) || 0)}</span>
        </div>

        {order.rider && (
          <div className="rounded-md bg-muted px-2 py-1 text-xs">
            <span className="font-medium">{order.rider.name}</span>
            {order.rider.phone ? ` · ${order.rider.phone}` : ''}
          </div>
        )}

        {order.otpRequired && !order.otpVerified && (
          <div className="flex items-center gap-1 text-xs text-amber-700">
            <AlertTriangle className="h-3 w-3" /> Handover code needed
          </div>
        )}

        {/* Big targets: the whole point is one confident thumb tap. */}
        <div className="space-y-1 pt-1">
          {primaryStates.map((s) => (
            <Button
              key={s}
              className="w-full h-11 text-base"
              disabled={busy}
              onClick={() => onAction(order, s)}
            >
              {ACTION_LABEL[s]}
            </Button>
          ))}
          <div className="flex gap-1">
            {rejectState && (
              <Button variant="destructive" className="flex-1 h-9" disabled={busy}
                onClick={() => onAction(order, 'rejected')}>
                Reject
              </Button>
            )}
            {cancelState && (
              <Button variant="outline" className="flex-1 h-9" disabled={busy}
                onClick={() => onAction(order, 'cancelled')}>
                Cancel
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// Accept is the most-used control on the board, so the four quick chips ARE
// the control: one tap picks the prep time and submits. The free input is
// the escape hatch for a 45-minute biryani.
function AcceptDialog({
  order, busy, onClose, onConfirm,
}: { order: FulfilmentOrder; busy: boolean; onClose: () => void; onConfirm: (prepMinutes: number) => void }) {
  const [custom, setCustom] = useState('');
  const n = parseInt(custom, 10);
  const customValid = Number.isFinite(n) && n >= 1 && n <= 240;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Accept #{order.orderNo} — how long?</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-4 gap-2">
            {QUICK_PREP.map((m) => (
              <Button key={m} className="h-16 text-lg" disabled={busy} onClick={() => onConfirm(m)}>
                {m}<span className="text-xs ml-1">min</span>
              </Button>
            ))}
          </div>
          <div>
            <Label htmlFor="prep">Or type minutes (1-240)</Label>
            <div className="flex gap-2 mt-1">
              <Input id="prep" type="number" inputMode="numeric" min={1} max={240}
                value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="45" />
              <Button disabled={busy || !customValid} onClick={() => onConfirm(n)}>Accept</Button>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Back</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Reject REQUIRES a reason (backend 400s without one); cancel does not, but
// we still offer the field because "why did this order vanish" is the first
// question the owner asks the next morning.
function ReasonDialog({
  order, busy, onClose, onConfirm, mode = 'reject',
}: {
  order: FulfilmentOrder;
  busy: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  mode?: 'reject' | 'cancel';
}) {
  const [reason, setReason] = useState('');
  const quick = mode === 'reject'
    ? ['Out of stock', 'Kitchen too busy', 'Outside delivery area', 'Shop closing']
    : ['Diner cancelled', 'No delivery partner', 'Item unavailable', 'Duplicate order'];
  const required = mode === 'reject';

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {mode === 'reject' ? 'Reject' : 'Cancel'} #{order.orderNo}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {quick.map((q) => (
              <Button key={q} variant={reason === q ? 'default' : 'outline'} size="sm"
                onClick={() => setReason(q)}>{q}</Button>
            ))}
          </div>
          <div>
            <Label htmlFor="reason">Reason{required ? ' (required)' : ' (optional)'}</Label>
            <Input id="reason" className="mt-1" value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={mode === 'reject' ? 'Why are you rejecting this?' : 'Why is this being cancelled?'} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Back</Button>
          <Button variant="destructive" disabled={busy || (required && !reason.trim())}
            onClick={() => onConfirm(reason.trim())}>
            {mode === 'reject' ? 'Reject order' : 'Cancel order'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RiderDialog({
  order, busy, onClose, onConfirm,
}: { order: FulfilmentOrder; busy: boolean; onClose: () => void; onConfirm: (rider: { name?: string; phone?: string; otp?: string }) => void }) {
  const [name, setName] = useState(order.rider?.name ?? '');
  const [phone, setPhone] = useState(order.rider?.phone ?? '');
  const [otp, setOtp] = useState('');

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Delivery partner for #{order.orderNo}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">All optional — leave blank if the partner hasn't said.</p>
          <div>
            <Label htmlFor="rname">Name</Label>
            <Input id="rname" className="mt-1" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="rphone">Phone</Label>
            <Input id="rphone" className="mt-1" type="tel" inputMode="tel" value={phone}
              onChange={(e) => setPhone(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="rotp">Handover code (if they gave one)</Label>
            <Input id="rotp" className="mt-1" inputMode="numeric" autoComplete="one-time-code"
              value={otp} onChange={(e) => setOtp(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Back</Button>
          <Button disabled={busy} onClick={() => onConfirm({
            name: name.trim() || undefined,
            phone: phone.trim() || undefined,
            otp: otp.trim() || undefined,
          })}>Assign partner</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// The handover code is READ OUT by the delivery partner and TYPED here. We
// never receive the expected value, so there is nothing to display and no
// way to "show" it — a wrong code comes back as a 400 from the backend with
// its own message, which the shared error toast surfaces.
function HandoverDialog({
  order, busy, onClose, onConfirm,
}: { order: FulfilmentOrder; busy: boolean; onClose: () => void; onConfirm: (otp?: string) => void }) {
  const [otp, setOtp] = useState('');
  const needsOtp = order.otpRequired && !order.otpVerified;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Hand over #{order.orderNo}</DialogTitle></DialogHeader>
        {needsOtp ? (
          <div className="space-y-2">
            <Label htmlFor="otp">Ask the delivery partner for the code</Label>
            <Input
              id="otp"
              className="h-14 text-2xl tracking-widest text-center"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
              placeholder="••••"
            />
          </div>
        ) : (
          <p className="text-sm">Confirm the food has gone out with the delivery partner.</p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Back</Button>
          <Button
            className="h-11"
            disabled={busy || (needsOtp && otp.trim().length === 0)}
            onClick={() => onConfirm(needsOtp ? otp.trim() : undefined)}
          >
            Hand over
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
