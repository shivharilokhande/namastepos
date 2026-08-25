import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CalendarPlus, Users, Phone, Plus } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { ffApi } from '@/api/namastepos';
import { apiError } from '@/api/client';

export function ReservationsPage() {
  const qc = useQueryClient();
  const today = new Date().toISOString().slice(0, 10);
  const [day, setDay] = useState(today);
  const [adding, setAdding] = useState(false);

  const from = new Date(`${day}T00:00:00`);
  const to = new Date(`${day}T23:59:59`);
  const { data: list = [] } = useQuery({
    queryKey: ['reservations', day],
    queryFn: () => ffApi.listReservations({ from: from.toISOString(), to: to.toISOString() }),
  });
  const { data: waitList = [] } = useQuery({ queryKey: ['wait-list'], queryFn: ffApi.listWaitList });

  const seat = useMutation({
    mutationFn: (id: string) => ffApi.seatReservation(id),
    onSuccess: () => {
      toast.success('Seated');
      qc.invalidateQueries({ queryKey: ['reservations'] });
      qc.invalidateQueries({ queryKey: ['ops-tables'] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <CalendarPlus className="h-6 w-6 text-primary" /> Reservations
          </h1>
          <p className="text-muted-foreground text-sm">Bookings + walk-in wait list.</p>
        </div>
        <div className="flex gap-2 items-center">
          <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} className="max-w-[180px]" />
          <Button onClick={() => setAdding(true)}><Plus className="mr-1 h-4 w-4" />New booking</Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4">
        <Card>
          <CardHeader><CardTitle>Reservations · {day}</CardTitle></CardHeader>
          <CardContent className="divide-y">
            {list.length === 0 && <div className="py-8 text-center text-muted-foreground text-sm">No reservations.</div>}
            {list.map((r: any) => (
              <div key={r.id} className="py-2 flex items-center justify-between gap-3">
                <div>
                  <div className="font-medium">{r.customerName} · <Users className="inline h-3 w-3" /> {r.partySize}</div>
                  <div className="text-xs text-muted-foreground">
                    <Phone className="inline h-3 w-3 mr-1" />{r.customerPhone} ·
                    {' '}{new Date(r.reservedAt).toLocaleTimeString()}
                    {r.tableLabel && ` · Table ${r.tableLabel}`}
                  </div>
                  {r.specialRequests && (
                    <div className="text-xs italic text-muted-foreground">"{r.specialRequests}"</div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={r.status === 'seated' ? 'success' : r.status === 'no_show' ? 'destructive' : 'muted'}>
                    {r.status}
                  </Badge>
                  {(r.status === 'booked' || r.status === 'confirmed') && (
                    <Button size="sm" onClick={() => seat.mutate(r.id)}>Seat</Button>
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Wait list</CardTitle></CardHeader>
          <CardContent className="text-sm divide-y">
            {waitList.length === 0 && <div className="py-6 text-muted-foreground text-center">No one waiting.</div>}
            {waitList.map((w: any) => (
              <div key={w.id} className="py-2">
                <div className="font-medium">{w.customer_name}</div>
                <div className="text-xs text-muted-foreground">
                  Party {w.party_size} · ETA {w.estimated_wait_min || '?'}m
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {adding && <NewReservationDialog onClose={() => setAdding(false)}
        onCreated={() => { qc.invalidateQueries({ queryKey: ['reservations'] }); setAdding(false); }} />}
    </div>
  );
}

// WHY (2026-08-25, Bug #11): datetime-local inputs speak LOCAL wall-clock
// strings, but toISOString() emits UTC — for IST users the old default
// rendered 5.5h behind the wall clock (i.e. in the past). Format manually
// in local time for value/min/max so all three agree.
function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function NewReservationDialog({ onClose, onCreated }: any) {
  // WHY (2026-08-25, Bug #11): the picker accepted any past date/time. Bound
  // it to [now rounded up to the next 5 min, now + 90 days] to mirror the
  // mobile picker (reservations_screen.dart firstDate/lastDate). useState
  // initializers are enough for "recompute when the dialog opens" because
  // this component mounts fresh on every open ({adding && <Dialog/>}).
  const [minAt] = useState(() => {
    const d = new Date();
    d.setSeconds(0, 0);
    d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5); // Date rolls 60 → next hour
    return d;
  });
  const [maxAt] = useState(() => new Date(Date.now() + 90 * 24 * 60 * 60 * 1000));
  const [f, setF] = useState({
    customerName: '', customerPhone: '', customerEmail: '',
    partySize: 2, reservedAt: toLocalInputValue(new Date(Date.now() + 60 * 60 * 1000)),
    specialRequests: '',
  });
  const set = (k: string, v: any) => setF((p) => ({ ...p, [k]: v }));
  const create = useMutation({
    mutationFn: () => ffApi.createReservation({ ...f, reservedAt: new Date(f.reservedAt).toISOString() }),
    onSuccess: () => { toast.success('Booking saved'); onCreated(); },
    onError: (e) => toast.error(apiError(e)),
  });
  const save = () => {
    // WHY (2026-08-25, Bug #11): min/max only constrain the native picker —
    // typed input bypasses them — so re-validate before hitting the API.
    const at = new Date(f.reservedAt);
    if (Number.isNaN(at.getTime()) || at.getTime() < Date.now()) {
      toast.error('Reservation time is in the past — pick a future time');
      return;
    }
    if (at.getTime() > maxAt.getTime()) {
      toast.error('Reservations can be made at most 90 days ahead');
      return;
    }
    create.mutate();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>New reservation</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>Name *</Label><Input value={f.customerName} onChange={(e) => set('customerName', e.target.value)} /></div>
          <div><Label>Phone *</Label><Input value={f.customerPhone} onChange={(e) => set('customerPhone', e.target.value)} /></div>
          <div><Label>Email</Label><Input type="email" value={f.customerEmail} onChange={(e) => set('customerEmail', e.target.value)} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Party size</Label><Input type="number" value={f.partySize} onChange={(e) => set('partySize', +e.target.value)} /></div>
            <div><Label>Date &amp; time</Label><Input type="datetime-local" min={toLocalInputValue(minAt)} max={toLocalInputValue(maxAt)} value={f.reservedAt} onChange={(e) => set('reservedAt', e.target.value)} /></div>
          </div>
          <div><Label>Special requests</Label><Input value={f.specialRequests} onChange={(e) => set('specialRequests', e.target.value)} placeholder="Window seat, vegetarian only…" /></div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={!f.customerName || !f.customerPhone}>Save booking</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
