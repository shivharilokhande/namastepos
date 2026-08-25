import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Trash2, Plus, Utensils } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { ffApi } from '@/api/namastepos';
import { apiError } from '@/api/client';
import { formatINR } from '@/lib/utils';

// 2026-08-25 (founder): 'extra_prepared' — "made 20 plates pav bhaji, sold
// 17" → the 3 unsold plates are dish wastage, not an ingredient event.
const REASONS = [
  { code: 'expired',        label: 'Expired' },
  { code: 'spilled',        label: 'Spilled' },
  { code: 'over_prep',      label: 'Over-prep' },
  { code: 'extra_prepared', label: 'Extra prepared' },
  { code: 'damaged',        label: 'Damaged' },
  { code: 'other',          label: 'Other' },
];

export function WastagePage() {
  const qc = useQueryClient();
  const [logging, setLogging] = useState(false);
  const { data: report } = useQuery({ queryKey: ['wastage'], queryFn: () => ffApi.wastageReport() });
  const { data: ingredients = [] } = useQuery({
    queryKey: ['ingredients-all'], queryFn: () => ffApi.listIngredients(),
  });
  // Dish wastage picker needs the menu (same cache key as order dialog)
  const { data: menuItems = [] } = useQuery({
    queryKey: ['menu'], queryFn: () => ffApi.listMenu(),
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
            <div className="text-lg font-bold capitalize">{report.byReason?.[0]?.reason?.replace(/_/g, ' ') || '—'}</div>
          </CardContent></Card>
        </div>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">By reason</CardTitle></CardHeader>
        <CardContent className="space-y-1 text-sm">
          {(report?.byReason || []).map((r: any) => (
            <div key={r.reason} className="flex justify-between py-1 border-b">
              <span className="capitalize">{r.reason.replace(/_/g, ' ')}</span>
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
              {/* 2026-08-25: dish rows (menu_item_name set) render with a
                  plate icon + dish name; ingredient rows unchanged. */}
              <span className="flex items-center gap-1.5">
                {r.menu_item_name && <Utensils className="h-3.5 w-3.5 shrink-0 text-primary" />}
                <span>
                  {r.menu_item_name || r.ingredient_name || '—'} · {r.qty}{' '}
                  {r.unit || (r.menu_item_name ? 'plate' : '')}
                  <span className="ml-2 text-xs text-muted-foreground capitalize">
                    ({r.reason?.replace(/_/g, ' ')})
                  </span>
                </span>
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
            <LogForm ingredients={ingredients} menuItems={menuItems} onSaved={() => {
              setLogging(false);
              qc.invalidateQueries({ queryKey: ['wastage'] });
            }} />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

type WastageMode = 'ingredient' | 'dish';

interface LogFormProps {
  ingredients: any[];
  menuItems: any[];
  onSaved: () => void;
}

function LogForm({ ingredients, menuItems, onSaved }: LogFormProps) {
  // 2026-08-25 (founder): two kinds of wastage — raw ingredients (existing
  // flow, untouched) and prepared dishes that didn't sell. Toggle between.
  const [mode, setMode] = useState<WastageMode>('ingredient');
  const [f, setF] = useState({
    ingredientId: '', qty: 0, unit: 'g', costInr: 0, reason: 'expired', note: '',
  });
  // Dish mode defaults reason to 'extra_prepared' — that's the founder's
  // headline case ("prepared 20, sold 17").
  const [dish, setDish] = useState({
    menuItemId: '', plates: 1, reason: 'extra_prepared', note: '',
  });
  const [dishSearch, setDishSearch] = useState('');
  const set = (k: string, v: any) => setF((p) => ({ ...p, [k]: v }));
  const setD = (k: string, v: any) => setDish((p) => ({ ...p, [k]: v }));

  const filteredDishes = useMemo(() => {
    const q = dishSearch.trim().toLowerCase();
    return menuItems.filter((m: any) => !q || m.name?.toLowerCase().includes(q));
  }, [menuItems, dishSearch]);

  const log = useMutation({
    mutationFn: () => mode === 'dish'
      ? ffApi.logWastage({
          // No costPaise on purpose: backend values plates at RECIPE cost
          // (real COGS burned), or ₹0 when the item has no recipe — never
          // the sale price, which would inflate the expense mirror.
          menuItemId: dish.menuItemId,
          qty: dish.plates,
          unit: 'plate',
          reason: dish.reason,
          note: dish.note,
        })
      : ffApi.logWastage({
          ingredientId: f.ingredientId || null,
          qty: f.qty, unit: f.unit,
          costPaise: Math.round(f.costInr * 100),
          reason: f.reason, note: f.note,
        }),
    onSuccess: () => { toast.success('Logged'); onSaved(); },
    onError: (e) => toast.error(apiError(e)),
  });

  const canSubmit = mode === 'dish'
    ? !!dish.menuItemId && dish.plates > 0
    : f.qty > 0;

  return (
    <>
      <div className="space-y-3">
        {/* Type toggle */}
        <div className="grid grid-cols-2 gap-2">
          <Button type="button" variant={mode === 'ingredient' ? 'default' : 'outline'}
            onClick={() => setMode('ingredient')}>
            Ingredient
          </Button>
          <Button type="button" variant={mode === 'dish' ? 'default' : 'outline'}
            onClick={() => setMode('dish')}>
            <Utensils className="mr-1 h-4 w-4" /> Prepared dish
          </Button>
        </div>

        {mode === 'ingredient' ? (
          <>
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
          </>
        ) : (
          <>
            <div>
              <Label>Dish *</Label>
              <Input placeholder="Search menu…" value={dishSearch}
                onChange={(e) => setDishSearch(e.target.value)} className="mb-2" />
              <select value={dish.menuItemId} onChange={(e) => setD('menuItemId', e.target.value)}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                <option value="">— pick a dish —</option>
                {filteredDishes.map((m: any) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </div>
            <div>
              <Label>Plates *</Label>
              <Input type="number" min={1} step="1" value={dish.plates}
                onChange={(e) => setD('plates', Math.max(0, Math.floor(+e.target.value || 0)))} />
              <p className="text-xs text-muted-foreground mt-1">
                Cost is taken from the dish's recipe automatically.
              </p>
            </div>
            <div>
              <Label>Reason *</Label>
              <select value={dish.reason} onChange={(e) => setD('reason', e.target.value)}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                {REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
              </select>
            </div>
            <div><Label>Note</Label><Input value={dish.note} onChange={(e) => setD('note', e.target.value)} /></div>
          </>
        )}
      </div>
      <DialogFooter className="mt-3">
        <Button onClick={() => log.mutate()} disabled={log.isPending || !canSubmit}>
          {log.isPending ? '…' : 'Log it'}
        </Button>
      </DialogFooter>
    </>
  );
}
