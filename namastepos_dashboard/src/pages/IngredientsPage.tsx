import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import axios from 'axios';
import {
  Plus, Carrot, Lock, ShoppingBag, Edit2, AlertTriangle,
  TrendingDown, Trash2,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { ffApi } from '@/api/namastepos';
import { apiError } from '@/api/client';
import { formatINR } from '@/lib/utils';

const CATEGORIES = ['grains', 'dairy', 'vegetables', 'meats', 'spices', 'oils', 'packaging', 'other'];
const UNITS = ['g', 'kg', 'ml', 'l', 'piece', 'pack', 'dozen'];

export function IngredientsPage() {
  const [tab, setTab] = useState<'list' | 'food-cost' | 'recipes'>('list');
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Carrot className="h-6 w-6 text-primary" /> Ingredients
        </h1>
        <p className="text-muted-foreground">
          Track raw materials, define recipes, see real food cost per dish.
        </p>
      </div>

      <div className="flex gap-2 border-b">
        {(['list', 'recipes', 'food-cost'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 capitalize transition-colors whitespace-nowrap ${
              tab === t ? 'border-primary text-primary' : 'border-transparent text-muted-foreground'
            }`}>
            {t.replace('-', ' ')}
          </button>
        ))}
      </div>

      {tab === 'list' && <IngredientsList />}
      {tab === 'recipes' && <RecipeBuilder />}
      {tab === 'food-cost' && <FoodCostReport />}
    </div>
  );
}

function IngredientsList() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [purchasing, setPurchasing] = useState<any | null>(null);

  // ⚠️ All hooks must be called unconditionally and in the same order on
  // every render. The previous version called `useMutation` AFTER an early
  // `return` for the addon-upsell branch — when the addon-required state
  // flipped, React saw a different hook count and threw "Rendered fewer
  // hooks than during the previous render," which made the whole page
  // go blank. Hooks now sit above any conditional return.
  const { data: ingredients = [], isLoading, error } = useQuery({
    queryKey: ['ingredients', search, category],
    queryFn: () => ffApi.listIngredients({ search: search || undefined, category: category || undefined }),
    retry: false,
  });

  const remove = useMutation({
    mutationFn: (id: string) => ffApi.deleteIngredient(id),
    onSuccess: () => { toast.success('Removed'); qc.invalidateQueries({ queryKey: ['ingredients'] }); },
    onError: (e) => toast.error(apiError(e)),
  });

  const addonRequired = axios.isAxiosError(error) && error.response?.status === 402;
  if (addonRequired) {
    return (
      <Card className="border-primary">
        <CardContent className="p-10 text-center">
          <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-primary/10 text-primary mb-4">
            <Lock className="h-8 w-8" />
          </div>
          <h2 className="text-xl font-bold mb-2">Recipe & Food Cost is a paid add-on</h2>
          <p className="text-muted-foreground mb-6">
            Track raw ingredients, auto-deduct stock per dish sold, and see your real food cost % per item.
            Subscribe to the <strong>Recipe & Food Cost</strong> add-on to unlock this.
          </p>
          <Button asChild><a href="/marketplace">Open Marketplace</a></Button>
        </CardContent>
      </Card>
    );
  }

  const lowCount = Array.isArray(ingredients) ? ingredients.filter((i: any) => i.isLow).length : 0;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-col md:flex-row md:items-center gap-3">
            <Input placeholder="Search ingredients…" className="flex-1"
                   value={search} onChange={(e) => setSearch(e.target.value)} />
            <select value={category} onChange={(e) => setCategory(e.target.value)}
                    className="h-10 rounded-md border border-input bg-background px-3 text-sm">
              <option value="">All categories</option>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <Button onClick={() => setAdding(true)}>
              <Plus className="mr-2 h-4 w-4" /> Add ingredient
            </Button>
          </div>
        </CardHeader>
        {lowCount > 0 && (
          <CardContent className="pt-0">
            <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-900">
              <AlertTriangle className="h-4 w-4" />
              {lowCount} ingredient{lowCount > 1 ? 's are' : ' is'} below reorder level.
            </div>
          </CardContent>
        )}
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Ingredient</TableHead><TableHead>Category</TableHead>
              <TableHead className="text-right">Stock</TableHead>
              <TableHead className="text-right">Unit cost</TableHead>
              <TableHead className="text-right">Stock value</TableHead>
              <TableHead>Vendor</TableHead>
              <TableHead></TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {isLoading && <TableRow><TableCell colSpan={7} className="text-center py-10 text-muted-foreground">Loading…</TableCell></TableRow>}
              {!isLoading && ingredients.length === 0 && (
                <TableRow><TableCell colSpan={7} className="text-center py-10 text-muted-foreground">
                  No ingredients yet. Add your first — e.g., "Basmati rice", "Cooking oil", "Onion".
                </TableCell></TableRow>
              )}
              {ingredients.map((i: any) => (
                <TableRow key={i.id} className={i.isLow ? 'bg-amber-50/50' : ''}>
                  <TableCell>
                    <div className="font-medium">{i.name}</div>
                    {i.isLow && <Badge variant="warning" className="text-[10px] mt-1">Reorder</Badge>}
                  </TableCell>
                  <TableCell className="capitalize text-sm">{i.category || '—'}</TableCell>
                  <TableCell className="text-right">
                    <strong>{i.stock.toLocaleString('en-IN')}</strong> {i.unit}
                    <div className="text-xs text-muted-foreground">reorder at {i.reorderLevel}</div>
                  </TableCell>
                  <TableCell className="text-right text-sm">
                    {formatINR(i.costPerUnitInr, { decimals: true })}/{i.unit}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {formatINR(i.stock * i.costPerUnitInr)}
                  </TableCell>
                  <TableCell className="text-sm">{i.vendor || '—'}</TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="ghost" onClick={() => setPurchasing(i)}>
                      <ShoppingBag className="h-4 w-4" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(i)}>
                      <Edit2 className="h-4 w-4" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => remove.mutate(i.id)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {(adding || editing) && <IngredientDialog
        ingredient={editing}
        onClose={() => { setAdding(false); setEditing(null); }}
        onSaved={() => { qc.invalidateQueries({ queryKey: ['ingredients'] }); setAdding(false); setEditing(null); }} />}
      {purchasing && <PurchaseDialog ingredient={purchasing}
        onClose={() => setPurchasing(null)}
        onSaved={() => { qc.invalidateQueries({ queryKey: ['ingredients'] }); setPurchasing(null); }} />}
    </div>
  );
}

function IngredientDialog({ ingredient, onClose, onSaved }: any) {
  const mode = ingredient ? 'edit' : 'create';
  const [f, setF] = useState<any>(ingredient ? {
    name: ingredient.name, category: ingredient.category || '',
    unit: ingredient.unit, reorderLevel: ingredient.reorderLevel,
    costPerUnitInr: ingredient.costPerUnitInr,
    vendor: ingredient.vendor || '', vendorPhone: ingredient.vendorPhone || '',
    notes: ingredient.notes || '',
  } : {
    name: '', category: 'grains', unit: 'g', stock: 0, reorderLevel: 0,
    costPerUnitInr: 0, vendor: '', vendorPhone: '', notes: '',
  });
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  const save = useMutation({
    mutationFn: () => mode === 'create' ? ffApi.createIngredient(f) : ffApi.updateIngredient(ingredient.id, f),
    onSuccess: () => { toast.success('Saved'); onSaved(); },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader><DialogTitle>{mode === 'create' ? 'Add ingredient' : `Edit ${ingredient.name}`}</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2"><Label>Name *</Label><Input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Basmati rice" /></div>
          <div>
            <Label>Category</Label>
            <select value={f.category} onChange={(e) => set('category', e.target.value)}
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <Label>Unit</Label>
            <select value={f.unit} onChange={(e) => set('unit', e.target.value)}
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
          {mode === 'create' && (
            <div><Label>Initial stock</Label><Input type="number" step="0.001" value={f.stock} onChange={(e) => set('stock', +e.target.value)} /></div>
          )}
          <div><Label>Reorder level</Label><Input type="number" step="0.001" value={f.reorderLevel} onChange={(e) => set('reorderLevel', +e.target.value)} /></div>
          <div className={mode === 'create' ? '' : 'col-span-2'}>
            <Label>Cost per unit (₹)</Label><Input type="number" step="0.01" value={f.costPerUnitInr} onChange={(e) => set('costPerUnitInr', +e.target.value)} />
          </div>
          <div><Label>Vendor</Label><Input value={f.vendor} onChange={(e) => set('vendor', e.target.value)} /></div>
          <div><Label>Vendor phone</Label><Input value={f.vendorPhone} onChange={(e) => set('vendorPhone', e.target.value)} /></div>
          <div className="col-span-2"><Label>Notes</Label><Input value={f.notes} onChange={(e) => set('notes', e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={!f.name || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PurchaseDialog({ ingredient, onClose, onSaved }: any) {
  const [f, setF] = useState({ qty: 0, totalCostInr: 0, vendor: ingredient.vendor || '', note: '' });
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  const unitCost = f.qty > 0 ? (f.totalCostInr / f.qty) : 0;
  const purchase = useMutation({
    mutationFn: () => ffApi.purchaseIngredient(ingredient.id, f),
    onSuccess: () => { toast.success('Purchase recorded'); onSaved(); },
    onError: (e) => toast.error(apiError(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Record purchase: {ingredient.name}</DialogTitle></DialogHeader>
        <CardDescription>
          Current stock: {ingredient.stock} {ingredient.unit} · cost {formatINR(ingredient.costPerUnitInr, { decimals: true })}/{ingredient.unit}.
          This will update stock and re-compute the weighted-avg cost.
        </CardDescription>
        <div className="space-y-3 mt-3">
          <div><Label>Quantity received ({ingredient.unit})</Label><Input type="number" step="0.001" value={f.qty} onChange={(e) => set('qty', +e.target.value)} /></div>
          <div><Label>Total cost (₹)</Label><Input type="number" step="0.01" value={f.totalCostInr} onChange={(e) => set('totalCostInr', +e.target.value)} /></div>
          <div className="text-sm text-muted-foreground">
            Unit cost: <strong>{formatINR(unitCost, { decimals: true })}/{ingredient.unit}</strong>
          </div>
          <div><Label>Vendor</Label><Input value={f.vendor} onChange={(e) => set('vendor', e.target.value)} /></div>
          <div><Label>Note (optional)</Label><Input value={f.note} onChange={(e) => set('note', e.target.value)} placeholder="Invoice 5023, paid by UPI" /></div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => purchase.mutate()} disabled={!f.qty || !f.totalCostInr || purchase.isPending}>
            Record purchase
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Recipe builder ────────────────────────────────────────────────────
function RecipeBuilder() {
  const { data: menu = [] } = useQuery({ queryKey: ['menu'], queryFn: ffApi.listMenu });
  const { data: ingredients = [] } = useQuery({ queryKey: ['ingredients-all'], queryFn: () => ffApi.listIngredients() });
  const [selectedItem, setSelectedItem] = useState<any | null>(null);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <Card className="lg:col-span-1">
        <CardHeader><CardTitle>Menu items</CardTitle><CardDescription>Pick an item to define its recipe.</CardDescription></CardHeader>
        <CardContent className="p-0 max-h-[600px] overflow-y-auto">
          {menu.length === 0 && <div className="p-6 text-center text-muted-foreground text-sm">No menu items yet.</div>}
          {menu.map((m: any) => (
            <button key={m.id} onClick={() => setSelectedItem(m)}
              className={`w-full text-left px-4 py-3 border-b hover:bg-accent transition-colors ${
                selectedItem?.id === m.id ? 'bg-primary/10' : ''
              }`}>
              <div className="font-medium">{m.name}</div>
              <div className="text-xs text-muted-foreground">{m.category} · {formatINR(m.price)}</div>
            </button>
          ))}
        </CardContent>
      </Card>
      <Card className="lg:col-span-2">
        {selectedItem
          ? <RecipeEditor item={selectedItem} ingredients={ingredients} />
          : <CardContent className="p-10 text-center text-muted-foreground">
              Select a menu item to define its recipe.
            </CardContent>}
      </Card>
    </div>
  );
}

function RecipeEditor({ item, ingredients }: { item: any; ingredients: any[] }) {
  const qc = useQueryClient();
  const { data: lines = [] } = useQuery({ queryKey: ['recipe', item.id], queryFn: () => ffApi.getRecipe(item.id) });
  const [draft, setDraft] = useState<any[]>([]);

  // P0-3 fix: sync draft via useEffect (was infinite loop in render body).
  useEffect(() => {
    if (lines.length && draft.length === 0) {
      setDraft(lines.map((l: any) => ({
        ingredientId: l.ingredientId, qty: l.qty, note: l.note || '',
      })));
    }
  }, [lines, draft.length]);

  const totalCost = draft.reduce((sum, d) => {
    const ing = ingredients.find((i) => i.id === d.ingredientId);
    return sum + (ing ? ing.costPerUnitInr * d.qty : 0);
  }, 0);
  const margin = item.price - totalCost;
  const foodCostPct = item.price > 0 ? (totalCost / item.price) * 100 : 0;

  const save = useMutation({
    mutationFn: () => ffApi.setRecipe(item.id, draft),
    onSuccess: () => { toast.success('Recipe saved'); qc.invalidateQueries({ queryKey: ['recipe', item.id] }); },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div>
            <CardTitle>{item.name}</CardTitle>
            <CardDescription>Sells at {formatINR(item.price)}</CardDescription>
          </div>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>Save recipe</Button>
        </div>
        <div className="grid grid-cols-3 gap-3 mt-3">
          <div className="p-3 rounded-lg bg-muted">
            <div className="text-xs text-muted-foreground">Food cost</div>
            <div className="font-bold">{formatINR(totalCost, { decimals: true })}</div>
          </div>
          <div className="p-3 rounded-lg bg-muted">
            <div className="text-xs text-muted-foreground">Margin</div>
            <div className={`font-bold ${margin > 0 ? 'text-emerald-700' : 'text-red-700'}`}>{formatINR(margin, { decimals: true })}</div>
          </div>
          <div className="p-3 rounded-lg bg-muted">
            <div className="text-xs text-muted-foreground">Food cost %</div>
            <div className={`font-bold ${foodCostPct < 35 ? 'text-emerald-700' : foodCostPct < 50 ? 'text-amber-700' : 'text-red-700'}`}>{foodCostPct.toFixed(0)}%</div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {draft.map((d, idx) => {
          const ing = ingredients.find((i) => i.id === d.ingredientId);
          return (
            <div key={idx} className="flex items-center gap-2 p-2 rounded-md border">
              <select value={d.ingredientId}
                onChange={(e) => {
                  const next = [...draft]; next[idx] = { ...next[idx], ingredientId: e.target.value }; setDraft(next);
                }}
                className="flex-1 h-9 rounded-md border border-input bg-background px-2 text-sm">
                <option value="">-- pick --</option>
                {ingredients.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.unit})</option>)}
              </select>
              <Input type="number" step="0.001" className="w-28" value={d.qty}
                     onChange={(e) => {
                       const next = [...draft]; next[idx] = { ...next[idx], qty: +e.target.value }; setDraft(next);
                     }} placeholder="qty" />
              <div className="text-xs text-muted-foreground w-16">{ing?.unit || ''}</div>
              <div className="text-sm font-medium w-20 text-right">
                {ing ? formatINR(ing.costPerUnitInr * d.qty, { decimals: true }) : '—'}
              </div>
              <Button size="sm" variant="ghost" onClick={() => setDraft(draft.filter((_, i) => i !== idx))}>
                <Trash2 className="h-3 w-3 text-destructive" />
              </Button>
            </div>
          );
        })}
        <Button size="sm" variant="outline" className="w-full" onClick={() => setDraft([...draft, { ingredientId: '', qty: 0, note: '' }])}>
          <Plus className="mr-2 h-3 w-3" /> Add ingredient line
        </Button>
      </CardContent>
    </>
  );
}

// ── Food-cost report ──────────────────────────────────────────────────
function FoodCostReport() {
  const { data: report = [] } = useQuery({ queryKey: ['food-cost-report'], queryFn: () => ffApi.foodCostReport() });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Food cost per dish</CardTitle>
        <CardDescription>
          Real food cost & margin per menu item, based on the recipes you've defined.
          Items missing recipes will show 0 cost — define them in the Recipes tab.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader><TableRow>
            <TableHead>Item</TableHead>
            <TableHead className="text-right">Sells at</TableHead>
            <TableHead className="text-right">Sold (qty)</TableHead>
            <TableHead className="text-right">Revenue</TableHead>
            <TableHead className="text-right">Food cost</TableHead>
            <TableHead className="text-right">Food cost %</TableHead>
            <TableHead className="text-right">Margin</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {report.length === 0 && <TableRow><TableCell colSpan={7} className="text-center py-10 text-muted-foreground">
              No data yet — sell a few items after defining recipes to see this report.
            </TableCell></TableRow>}
            {report.map((r: any) => (
              <TableRow key={r.menuItemId}>
                <TableCell className="font-medium">{r.name}</TableCell>
                <TableCell className="text-right">{formatINR(r.sellPriceInr)}</TableCell>
                <TableCell className="text-right">{r.qtySold}</TableCell>
                <TableCell className="text-right">{formatINR(r.revenueInr)}</TableCell>
                <TableCell className="text-right">{formatINR(r.foodCostInr)}</TableCell>
                <TableCell className="text-right">
                  {r.foodCostPct === null ? '—' : (
                    <Badge variant={r.foodCostPct < 35 ? 'success' : r.foodCostPct < 50 ? 'warning' : 'destructive'}>
                      {r.foodCostPct.toFixed(0)}%
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-right font-medium">
                  <span className={r.grossMarginInr > 0 ? 'text-emerald-700' : 'text-red-700'}>
                    {formatINR(r.grossMarginInr)}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
