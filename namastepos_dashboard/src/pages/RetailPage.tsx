import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ShoppingBag, Plus, Barcode, Building2, FileText } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { ffApi } from '@/api/namastepos';
import { apiError } from '@/api/client';
import { formatINR } from '@/lib/utils';

export function RetailPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'items' | 'vendors' | 'pos'>('items');
  const [adding, setAdding] = useState(false);
  const { data: items = [] } = useQuery({ queryKey: ['retail-items'], queryFn: () => ffApi.listRetailItems() });
  const { data: vendors = [] } = useQuery({ queryKey: ['vendors'], queryFn: ffApi.listVendors });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <ShoppingBag className="h-6 w-6 text-primary" /> Retail (non-food)
          </h1>
          <p className="text-muted-foreground text-sm">SKUs, vendors, POs, ledgers. Switch NamastePOS into retail-shop mode.</p>
        </div>
        <Button onClick={() => setAdding(true)}><Plus className="mr-1 h-4 w-4" />
          {tab === 'items' ? 'New SKU' : tab === 'vendors' ? 'New vendor' : 'New PO'}
        </Button>
      </div>

      <div className="flex gap-2 border-b">
        {(['items','vendors','pos'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 ${tab===t ? 'border-primary text-primary' : 'border-transparent text-muted-foreground'}`}>
            {t === 'pos' ? 'Purchase orders' : t}
          </button>
        ))}
      </div>

      {tab === 'items' && (
        <Card><CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground border-b">
              <tr><th className="p-3">Name</th><th>Category</th><th>HSN/GST</th><th>Stock</th><th>Price</th></tr>
            </thead>
            <tbody>
              {items.map((it: any) => (
                <tr key={it.id} className="border-b">
                  <td className="p-3 font-medium">{it.name}</td>
                  <td>{it.category}</td>
                  <td>{it.hsn_code || '—'} · {it.gst_pct}%</td>
                  <td>{it.stock} {it.unit}</td>
                  <td className="font-bold">{formatINR(it.default_price_paise / 100)}</td>
                </tr>
              ))}
              {items.length === 0 && <tr><td colSpan={5} className="p-8 text-center text-muted-foreground">No retail items yet. Add one or bulk-import.</td></tr>}
            </tbody>
          </table>
        </CardContent></Card>
      )}

      {tab === 'vendors' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {vendors.map((v: any) => (
            <Card key={v.id}>
              <CardContent className="p-4">
                <div className="font-semibold">{v.name}</div>
                <div className="text-xs text-muted-foreground">{v.contact_person} · {v.phone}</div>
                <div className="text-xs">GSTIN: {v.gstin || '—'}</div>
                <div className="text-xs">Terms: net {v.payment_terms_days}d · limit {formatINR(v.credit_limit_paise / 100)}</div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {tab === 'pos' && (
        <Card><CardContent className="p-8 text-center text-muted-foreground text-sm">
          PO creation flow is wired — use API: <code>POST /retail/purchase-orders</code>. UI builder coming next sprint.
        </CardContent></Card>
      )}

      {adding && (tab === 'items'
        ? <NewItemDialog onClose={() => setAdding(false)} onCreated={() => { qc.invalidateQueries({ queryKey:['retail-items'] }); setAdding(false); }} />
        : tab === 'vendors'
          ? <NewVendorDialog onClose={() => setAdding(false)} onCreated={() => { qc.invalidateQueries({ queryKey:['vendors'] }); setAdding(false); }} />
          : null)}
    </div>
  );
}

function NewItemDialog({ onClose, onCreated }: any) {
  const [f, setF] = useState({ name: '', category: '', unit: 'piece', hsnCode: '', gstPct: 18, priceInr: 0, stock: 0 });
  const save = useMutation({
    mutationFn: () => ffApi.createRetailItem(f),
    onSuccess: () => { toast.success('Item added'); onCreated(); },
    onError: (e) => toast.error(apiError(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>New retail SKU</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2"><Label>Name</Label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div><Label>Category</Label><Input value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} /></div>
          <div><Label>Unit</Label><Input value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} /></div>
          <div><Label>HSN</Label><Input value={f.hsnCode} onChange={(e) => setF({ ...f, hsnCode: e.target.value })} /></div>
          <div><Label>GST %</Label>
            <select value={f.gstPct} onChange={(e) => setF({ ...f, gstPct: +e.target.value })}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              {[0,5,12,18,28].map((g) => <option key={g} value={g}>{g}%</option>)}
            </select>
          </div>
          <div><Label>Selling price (₹)</Label><Input type="number" value={f.priceInr} onChange={(e) => setF({ ...f, priceInr: +e.target.value })} /></div>
          <div><Label>Stock</Label><Input type="number" value={f.stock} onChange={(e) => setF({ ...f, stock: +e.target.value })} /></div>
        </div>
        <DialogFooter><Button onClick={() => save.mutate()} disabled={!f.name || !f.priceInr}>Save</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewVendorDialog({ onClose, onCreated }: any) {
  const [f, setF] = useState({ name: '', contactPerson: '', phone: '', email: '', gstin: '', paymentTermsDays: 0 });
  const save = useMutation({
    mutationFn: () => ffApi.createVendor(f),
    onSuccess: () => { toast.success('Vendor added'); onCreated(); },
    onError: (e) => toast.error(apiError(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>New vendor</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2"><Label>Name</Label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div><Label>Contact person</Label><Input value={f.contactPerson} onChange={(e) => setF({ ...f, contactPerson: e.target.value })} /></div>
          <div><Label>Phone</Label><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></div>
          <div><Label>Email</Label><Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
          <div><Label>GSTIN</Label><Input value={f.gstin} onChange={(e) => setF({ ...f, gstin: e.target.value })} /></div>
          <div><Label>Payment terms (days)</Label><Input type="number" value={f.paymentTermsDays} onChange={(e) => setF({ ...f, paymentTermsDays: +e.target.value })} /></div>
        </div>
        <DialogFooter><Button onClick={() => save.mutate()} disabled={!f.name}>Save</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
