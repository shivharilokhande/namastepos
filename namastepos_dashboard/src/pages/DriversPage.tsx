import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Bike, Plus, Phone } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { ffApi } from '@/api/namastepos';
import { apiError } from '@/api/client';
import { formatINR } from '@/lib/utils';

export function DriversPage() {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const { data: drivers = [] } = useQuery({ queryKey: ['drivers'], queryFn: ffApi.listDrivers, refetchInterval: 10000 });
  const { data: live = [] } = useQuery({ queryKey: ['live-deliveries'], queryFn: ffApi.liveDeliveries, refetchInterval: 5000 });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Bike className="h-6 w-6 text-primary" /> Delivery riders
          </h1>
          <p className="text-muted-foreground text-sm">
            Manage your rider fleet + assign live orders.
          </p>
        </div>
        <Button onClick={() => setAdding(true)}><Plus className="mr-1 h-4 w-4" />Add rider</Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {drivers.map((d: any) => (
          <Card key={d.id}>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-semibold">{d.name}</div>
                  <div className="text-xs text-muted-foreground flex items-center gap-1">
                    <Phone className="h-3 w-3" /> {d.phone}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {d.vehicleType} · {d.vehicleNo || 'no plate'}
                  </div>
                </div>
                <Badge variant={d.isOnDuty ? 'success' : 'muted'}>
                  {d.isOnDuty ? 'On duty' : 'Off'}
                </Badge>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Live deliveries ({live.length})</CardTitle></CardHeader>
        <CardContent className="text-sm divide-y">
          {live.length === 0 && <div className="py-6 text-muted-foreground text-center">No active deliveries.</div>}
          {live.map((a: any) => (
            <div key={a.id} className="py-2 flex justify-between">
              <div>
                <div className="font-medium">#{a.order_no} · {a.driver_name}</div>
                <div className="text-xs text-muted-foreground">{a.delivery_address || 'No address'}</div>
              </div>
              <div className="text-right">
                <Badge variant={a.status === 'picked_up' ? 'warning' : 'muted'}>{a.status}</Badge>
                <div className="text-xs mt-1">{formatINR(parseFloat(a.total))}</div>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {adding && <AddDriverDialog onClose={() => setAdding(false)}
        onCreated={() => { qc.invalidateQueries({ queryKey: ['drivers'] }); setAdding(false); }} />}
    </div>
  );
}

function AddDriverDialog({ onClose, onCreated }: any) {
  const [f, setF] = useState({ name: '', phone: '', vehicleNo: '', vehicleType: 'bike' });
  const set = (k: string, v: any) => setF((p) => ({ ...p, [k]: v }));
  const create = useMutation({
    mutationFn: () => ffApi.createDriver(f),
    onSuccess: () => { toast.success('Rider added'); onCreated(); },
    onError: (e) => toast.error(apiError(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Add delivery rider</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>Name *</Label><Input value={f.name} onChange={(e) => set('name', e.target.value)} /></div>
          <div><Label>Phone *</Label><Input value={f.phone} onChange={(e) => set('phone', e.target.value)} /></div>
          <div><Label>Vehicle number</Label><Input value={f.vehicleNo} onChange={(e) => set('vehicleNo', e.target.value)} /></div>
          <div>
            <Label>Vehicle type</Label>
            <select value={f.vehicleType} onChange={(e) => set('vehicleType', e.target.value)}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              {['bike','scooter','car','cycle','other'].map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => create.mutate()} disabled={!f.name || !f.phone}>Add</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
