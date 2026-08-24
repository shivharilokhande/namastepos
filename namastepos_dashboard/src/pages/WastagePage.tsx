import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Trash2, Plus } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { ffApi } from '@/api/namastepos';
import { apiError } from '@/api/client';
import { formatINR } from '@/lib/utils';

const REASONS = [
  { code: 'expired',   label: 'Expired' },
  { code: 'spilled',   label: 'Spilled' },
  { code: 'over_prep', label: 'Over-prep' },
  { code: 'damaged',   label: 'Damaged' },
  { code: 'other',     label: 'Other' },
];

export function WastagePage() {
  const qc = useQueryClient();
  const [logging, setLogging] = useState(false);
  const { data: report } = useQuery({ queryKey: ['wastage'], queryFn: () => ffApi.wastageReport() });
  const { data: ingredients = [] } = useQuery({
    queryKey: ['ingredients-all'], queryFn: () => ffApi.listIngredients(),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Trash2 className="h-6 w-6 text-destructive" /> Wastage tracking
          </h1>
          <p className="text-muted-foreground text-sm">
            Log what's thrown away so your food cost & inventory stay honest.
          </p>
        </div>
        <Button onClick={() => setLogging(true)}><Plus className="mr-1 h-4 w-4" /> Log wastage</Button>
      </div>

      {report && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Card><CardContent className="p-4">
            <div className="text-xs text-muted-foreground">Total lost</div>
            <div className="text-2xl font-bold">{formatINR(report.summary?.total_inr || 0)}</div>
          </CardContent></Card>
          <Card><CardContent className="p-4">
            <div className="text-xs text-muted-foreground">Events</div>
            <div className="text-2xl font-bold">{report.summary?.event_count || 0}</div>
          </CardContent></Card>
          <Card><CardContent className="p-4">
            <div className="text-xs text-muted-foreground">Top reason</div>
            <div className="text-lg font-bold capitalize">{report.byReason?.[0]?.reason || '—'}</div>
          </CardContent></Card>
        </div>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">By reason</CardTitle></CardHeader>
        <CardContent className="space-y-1 text-sm">
          {(report?.byReason || []).map((r: any) => (
            <div key={r.reason} className="flex justify-between py-1 border-b">
              <span className="capitalize">{r.reason.replace('_',' ')}</span>
              <span>{r.n} × · {formatINR(r.inr)}</span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Recent entries</CardTitle></CardHeader>
        <CardContent className="text-sm space-y-1">
          {(report?.recent || []).slice(0, 20).map((r: any) => (
            <div key={r.id} className="flex justify-between py-1 border-b">
              <span>
                {r.ingredient_name || '—'} · {r.qty} {r.unit}
                <span className="ml-2 text-xs text-muted-foreground capitalize">({r.reason})</span>
              </span>
              <span>{formatINR((r.cost_paise || 0) / 100)}</span>
            </div>
          ))}
        </CardContent>
      </Card>

      {logging && (
        <Dialog open onOpenChange={(o) => !o && setLogging(false)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Log wastage</DialogTitle></DialogHeader>
            <LogForm ingredients={ingredients} onSaved={() => {
              setLogging(false);
              qc.invalidateQueries({ queryKey: ['wastage'] });
            }} />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function LogForm({ ingredients, onSaved }: any) {
  const [f, setF] = useState({
    ingredientId: '', qty: 0, unit: 'g', costInr: 0, reason: 'expired', note: '',
  });
  const set = (k: string, v: any) => setF((p) => ({ ...p, [k]: v }));
  const log = useMutation({
    mutationFn: () => ffApi.logWastage({
      ingredientId: f.ingredientId || null,
      qty: f.qty, unit: f.unit,
      costPaise: Math.round(f.costInr * 100),
      reason: f.reason, note: f.note,
    }),
    onSuccess: () => { toast.success('Logged'); onSaved(); },
    onError: (e) => toast.error(apiError(e)),
  });
  return (
    <>
      <div className="space-y-3">
        <div>
          <Label>Ingredient (optional)</Label>
          <select value={f.ingredientId} onChange={(e) => {
              const ing = ingredients.find((i: any) => i.id === e.target.value);
              setF({ ...f, ingredientId: e.target.value, unit: ing?.unit || 'g' });
            }}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
            <option value="">— pick —</option>
            {ingredients.map((i: any) => <option key={i.id} value={i.id}>{i.name} ({i.unit})</option>)}
          </select>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div><Label>Qty</Label><Input type="number" step="0.001" value={f.qty} onChange={(e) => set('qty', +e.target.value)} /></div>
          <div><Label>Unit</Label><Input value={f.unit} onChange={(e) => set('unit', e.target.value)} /></div>
          <div><Label>Cost (₹)</Label><Input type="number" step="0.01" value={f.costInr} onChange={(e) => set('costInr', +e.target.value)} /></div>
        </div>
        <div>
          <Label>Reason *</Label>
          <select value={f.reason} onChange={(e) => set('reason', e.target.value)}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
            {REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
          </select>
        </div>
        <div><Label>Note</Label><Input value={f.note} onChange={(e) => set('note', e.target.value)} /></div>
      </div>
      <DialogFooter className="mt-3">
        <Button onClick={() => log.mutate()} disabled={log.isPending || !f.qty}>
          {log.isPending ? '…' : 'Log it'}
        </Button>
      </DialogFooter>
    </>
  );
}
