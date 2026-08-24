import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Crown, Gift, Plus, Pencil, Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { ffApi } from '@/api/namastepos';
import { apiError } from '@/api/client';
import { formatINR } from '@/lib/utils';

export function MembershipsPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'plans' | 'gifts'>('plans');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<any | null>(null); // plan being edited
  const { data: plans = [] } = useQuery({ queryKey: ['memberships'], queryFn: ffApi.listMemberships });
  const { data: cards = [] } = useQuery({ queryKey: ['gift-cards'], queryFn: ffApi.listGiftCards });

  const del = useMutation({
    mutationFn: (id: string) => ffApi.deleteMembership(id),
    onSuccess: () => { toast.success('Plan deleted'); qc.invalidateQueries({ queryKey: ['memberships'] }); },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Crown className="h-6 w-6 text-amber-500" /> Memberships &amp; Gift cards
          </h1>
          <p className="text-muted-foreground text-sm">Sell pre-paid value and recurring perks.</p>
        </div>
        <Button onClick={() => setAdding(true)}>
          <Plus className="mr-1 h-4 w-4" />
          {tab === 'plans' ? 'New plan' : 'Issue gift card'}
        </Button>
      </div>

      <div className="flex gap-2 border-b">
        {(['plans','gifts'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 ${tab===t ? 'border-primary text-primary' : 'border-transparent text-muted-foreground'}`}>
            {t === 'plans' ? 'Membership plans' : 'Gift cards'}
          </button>
        ))}
      </div>

      {tab === 'plans' && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {plans.map((p: any) => {
            const itemCount = ((p.benefits?.items as any[]) || []).length;
            return (
              <Card key={p.id}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="font-bold text-lg">{p.name}</div>
                    <div className="flex gap-1">
                      <button title="Edit" className="p-1 rounded hover:bg-muted" onClick={() => setEditing(p)}>
                        <Pencil className="h-4 w-4 text-muted-foreground" />
                      </button>
                      <button title="Delete" className="p-1 rounded hover:bg-muted" onClick={() => del.mutate(p.id)}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </button>
                    </div>
                  </div>
                  <div className="text-2xl font-extrabold text-primary mt-1">{formatINR(p.price_paise / 100)}</div>
                  <div className="text-xs text-muted-foreground">
                    Valid {p.validity_days} days{itemCount > 0 ? ` · ${itemCount}-item bundle` : ''}
                  </div>
                  {p.description && <div className="text-sm mt-2">{p.description}</div>}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {tab === 'gifts' && (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground border-b">
                <tr><th className="p-3">Code</th><th>Issued</th><th>Remaining</th><th>Buyer</th></tr>
              </thead>
              <tbody>
                {cards.map((c: any) => (
                  <tr key={c.id} className="border-b">
                    <td className="p-3 font-mono">{c.code}</td>
                    <td>{formatINR(c.initial_paise / 100)}</td>
                    <td className="font-bold">{formatINR(c.remaining_paise / 100)}</td>
                    <td className="text-xs text-muted-foreground">{c.purchaser_phone || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {adding && (tab === 'plans' ? <NewPlanDialog onClose={() => setAdding(false)} onCreated={() => { qc.invalidateQueries({ queryKey:['memberships'] }); setAdding(false); }} />
                                  : <NewGiftDialog onClose={() => setAdding(false)} onCreated={() => { qc.invalidateQueries({ queryKey:['gift-cards'] }); setAdding(false); }} />)}
      {editing && <NewPlanDialog existing={editing} onClose={() => setEditing(null)} onCreated={() => { qc.invalidateQueries({ queryKey:['memberships'] }); setEditing(null); }} />}
    </div>
  );
}

function NewPlanDialog({ onClose, onCreated, existing }: any) {
  // §4.2 gap fill (2026-08-23) + full CRUD (2026-08-24): create OR edit. When
  // `existing` is passed we prefill and PUT instead of POST.
  const isEdit = !!existing;
  const [f, setF] = useState({
    name: existing?.name ?? '',
    description: existing?.description ?? '',
    priceInr: existing ? Math.round((existing.price_paise ?? 0) / 100) : 999,
    validityDays: existing?.validity_days ?? 30,
  });
  const [items, setItems] = useState<{ menuItemId: string; qty: number }[]>(
    (existing?.benefits?.items as any[])?.map((it) => ({
      menuItemId: String(it.menuItemId), qty: Number(it.qty) || 1,
    })) ?? []
  );
  const { data: menu = [] } = useQuery({ queryKey: ['menu'], queryFn: ffApi.listMenu });

  const addRow = () => setItems([...items, { menuItemId: '', qty: 1 }]);
  const setRow = (i: number, patch: Partial<{ menuItemId: string; qty: number }>) =>
    setItems(items.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const delRow = (i: number) => setItems(items.filter((_, idx) => idx !== i));

  const save = useMutation({
    mutationFn: () => {
      const clean = items.filter((r) => r.menuItemId && r.qty > 0);
      const body: any = { ...f };
      // On edit always send benefits (possibly empty) so clearing the bundle
      // persists; on create only attach when non-empty.
      if (clean.length || isEdit) body.benefits = { items: clean };
      return isEdit ? ffApi.updateMembership(existing.id, body) : ffApi.createMembership(body);
    },
    onSuccess: () => { toast.success(isEdit ? 'Plan updated' : 'Plan added'); onCreated(); },
    onError: (e) => toast.error(apiError(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{isEdit ? 'Edit membership plan' : 'New membership plan'}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>Name *</Label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Unlimited lunch" /></div>
          <div><Label>Description</Label><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Price (₹)</Label><Input type="number" value={f.priceInr} onChange={(e) => setF({ ...f, priceInr: +e.target.value })} /></div>
            <div><Label>Validity (days)</Label><Input type="number" value={f.validityDays} onChange={(e) => setF({ ...f, validityDays: +e.target.value })} /></div>
          </div>

          <div className="pt-2 border-t">
            <div className="flex items-center justify-between">
              <Label>Included items (bundle)</Label>
              <Button type="button" variant="outline" size="sm" onClick={addRow}>
                <Plus className="h-3 w-3 mr-1" /> Add item
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mb-2">
              Optional. Add items and quantities the member gets over the validity
              period (e.g. 20 × Cold Coffee). These auto-discount at billing.
            </p>
            {items.length === 0 && (
              <p className="text-xs text-muted-foreground italic">No items — this is a time-based plan.</p>
            )}
            <div className="space-y-2">
              {items.map((r, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <select
                    className="flex-1 border rounded-md h-9 px-2 text-sm bg-background"
                    value={r.menuItemId}
                    onChange={(e) => setRow(i, { menuItemId: e.target.value })}
                  >
                    <option value="">Select item…</option>
                    {(menu as any[]).map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  </select>
                  <Input
                    type="number" min={1} className="w-20"
                    value={r.qty}
                    onChange={(e) => setRow(i, { qty: +e.target.value })}
                  />
                  <Button type="button" variant="ghost" size="sm" onClick={() => delRow(i)}>✕</Button>
                </div>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter><Button onClick={() => save.mutate()} disabled={!f.name || save.isPending}>{isEdit ? 'Save changes' : 'Save'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
function NewGiftDialog({ onClose, onCreated }: any) {
  const [f, setF] = useState({ amountInr: 500, purchaserPhone: '', recipientPhone: '' });
  const issue = useMutation({
    mutationFn: () => ffApi.issueGiftCard(f),
    onSuccess: (g: any) => { toast.success(`Card ${g.code} issued`); onCreated(); },
    onError: (e) => toast.error(apiError(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle><Gift className="inline h-4 w-4 mr-1" />Issue gift card</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>Amount (₹) *</Label><Input type="number" value={f.amountInr} onChange={(e) => setF({ ...f, amountInr: +e.target.value })} /></div>
          <div><Label>Buyer phone</Label><Input value={f.purchaserPhone} onChange={(e) => setF({ ...f, purchaserPhone: e.target.value })} /></div>
          <div><Label>Recipient phone</Label><Input value={f.recipientPhone} onChange={(e) => setF({ ...f, recipientPhone: e.target.value })} /></div>
        </div>
        <DialogFooter><Button onClick={() => issue.mutate()}>Issue</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
