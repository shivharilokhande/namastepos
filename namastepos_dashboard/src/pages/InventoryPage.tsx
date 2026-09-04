// NamastePOS dashboard - Inventory page (2026-08-25)
//
// GAP A: port of the mobile inventory feature (inventory_screen.dart +
// item_detail_screen.dart) so owners can manage stock from the web too.
// Uses the exact same backend endpoints as the Flutter app:
//   GET /businesses/:id/menu?withVariants=true   -> { items: [...] }   (menuService.serialize + variants)
//   PUT /businesses/:id/menu/:itemId/stock       -> { item: {...} }    (menuService.adjustStock)
//   PUT /businesses/:id/menu/:itemId/variants/:variantId/stock
//                                                -> { variant: {...} } (menuService.adjustVariantStock)
//   GET /businesses/:id/menu/:itemId/history     -> { history: [...] } (menuService.stockHistory)
//
// NP-205 (2026-09-04): variants own their stock (migration 084), so each size
// is its own adjustable row, indented under its dish — and `trackStock` now
// decides whether a count means anything at all. Until then every untracked
// item sat at 0 and this screen called it OUT OF STOCK.
// There is no ffApi binding for the stock endpoints yet (and we must not
// edit the api files), so those two calls go through `api` +
// `getBusinessCache` directly — same pattern ffApi itself uses internally.

import { useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Boxes, Search, AlertTriangle, PackageX, SlidersHorizontal,
  History, ArrowUp, ArrowDown, RefreshCw,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { ffApi } from '@/api/namastepos';
import { api, apiError, getBusinessCache } from '@/api/client';

// ── Types (mirror menuService.serialize / stockHistory exactly) ─────────

interface InventoryVariant {
  id: string;
  label: string;
  price: number;
  stock: number | null;
  trackStock: boolean;
  isActive: boolean;
}

interface InventoryItem {
  id: string;
  name: string;
  category: string;
  unit: string;             // 'piece' | 'kg' | 'gram' | 'liter' | 'ml' | 'plate'
  stock: number;
  reorderLevel: number;
  isActive: boolean;
  isVeg: boolean;
  isCombo: boolean;
  // NP-205 (migration 084): FALSE = unlimited — the number above is ignored by
  // the order path, so this screen must not call it "out of stock".
  trackStock: boolean;
  // Present only on ?withVariants — each size owns its own stock.
  variants?: InventoryVariant[];
}

// One adjustable stock row. A menu item and one of its variants are the same
// thing to this screen (a name, a count, a tracking flag and an endpoint that
// books a delta), so the adjust dialog and the history dialog take this
// instead of two near-identical shapes.
interface StockTarget {
  key: string;              // react key / query key
  itemId: string;           // parent menu item (the ledger is keyed on it)
  variantId: string | null; // null = the parent item's own stock
  name: string;             // what the owner sees in the dialog title
  unit: string;
  stock: number;
  reorderLevel: number;
  trackStock: boolean;
}

interface StockMovement {
  id: string;
  menuItemId: string;
  variantId: string | null;
  qtyChange: number;
  balanceAfter: number;
  reason: string;
  orderId: string | null;
  note: string | null;
  createdAt: string;
}

// Must match the backend Joi enum in menuController.stockBody — anything
// else is rejected with a 400. 'sale' is normally written by the order
// pipeline but stays selectable to mirror the mobile dropdown (e.g. a
// cash sale rung up outside the POS).
const REASONS = ['purchase', 'adjustment', 'waste', 'returned', 'transfer', 'sale'] as const;

// Same abbreviations as the Flutter MenuUnitX.short extension, so owners
// see identical labels on phone and web.
const UNIT_SHORT: Record<string, string> = {
  piece: 'pcs', kg: 'kg', gram: 'g', liter: 'L', ml: 'ml', plate: 'plt',
};
const unitShort = (u: string) => UNIT_SHORT[u] ?? u;

// Stock can be fractional (kg/L items) — show up to 2 decimals but keep
// whole numbers clean ("12", not "12.00").
const fmtQty = (n: number) =>
  n.toLocaleString('en-IN', { maximumFractionDigits: 2 });

// Mobile parity: isLowStock = stock <= reorderLevel. "Out" is the harder
// subset (nothing left to sell) so it gets its own bucket and badge.
//
// NP-205 (migration 084): both are FALSE for an untracked row, whatever the
// number says. Before `track_stock` existed this screen showed every dish of
// a restaurant that doesn't count stock as "OUT OF STOCK" — 0 was the default
// and 0 looked empty — and the summary cards counted them all.
const isOut = (t: StockTarget) => t.trackStock && t.stock <= 0;
const isLow = (t: StockTarget) => t.trackStock && !isOut(t) && t.stock <= t.reorderLevel;

// A menu item, as a stock row.
const targetOfItem = (i: InventoryItem): StockTarget => ({
  key: i.id,
  itemId: i.id,
  variantId: null,
  name: i.name,
  unit: i.unit,
  stock: i.stock,
  reorderLevel: i.reorderLevel,
  trackStock: i.trackStock === true,
});

// One variant, as a stock row. Variants have no reorder_level column of their
// own, so they inherit the parent's threshold for the "LOW" signal — an owner
// who wants to be warned at 5 Large means 5, not a second number to maintain.
const targetOfVariant = (i: InventoryItem, v: InventoryVariant): StockTarget => ({
  key: v.id,
  itemId: i.id,
  variantId: v.id,
  name: `${i.name} · ${v.label}`,
  unit: i.unit,
  stock: v.stock ?? 0,
  reorderLevel: i.reorderLevel,
  trackStock: v.trackStock === true,
});

// ── Page ────────────────────────────────────────────────────────────────

export function InventoryPage() {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'low' | 'out'>('all');
  const [adjusting, setAdjusting] = useState<StockTarget | null>(null);
  const [viewing, setViewing] = useState<StockTarget | null>(null);

  // Reuse the existing menu binding — inventory is a projection of menu
  // items, not a separate resource (stock/reorderLevel live on menu_items).
  // NP-205: `withVariants` so each size can be adjusted on its own row —
  // variants own their stock now, and the number the owner needs to correct
  // when a crate of Large arrives is Large's, not the dish's.
  const { data: menu = [], isLoading, error, refetch, isFetching } = useQuery<InventoryItem[]>({
    queryKey: ['inventory-menu'],
    queryFn: ffApi.listMenuWithVariants,
  });

  // Combos have no stock of their own (components are decremented instead)
  // and soft-deleted items keep their row with is_active=false — neither
  // should clutter the list.
  const listed = useMemo(
    () => menu.filter((i) => i.isActive && !i.isCombo),
    [menu],
  );

  // Flatten to rows: the item, then each of its ACTIVE variants right under
  // it. Kept as one flat list (rather than a nested render) so search, the
  // low/out filters and the summary counts all operate on exactly the rows
  // the owner can act on — a dish whose Large is empty must be findable
  // under "Out of stock only" even though the dish itself isn't tracked.
  const rows = useMemo(() => {
    const out: Array<{ target: StockTarget; isVariant: boolean; item: InventoryItem }> = [];
    for (const i of listed) {
      out.push({ target: targetOfItem(i), isVariant: false, item: i });
      for (const v of i.variants || []) {
        if (v.isActive === false) continue;
        out.push({ target: targetOfVariant(i, v), isVariant: true, item: i });
      }
    }
    return out;
  }, [listed]);

  const lowCount = rows.filter((r) => isLow(r.target)).length;
  const outCount = rows.filter((r) => isOut(r.target)).length;
  const trackedCount = rows.filter((r) => r.target.trackStock).length;

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    // A variant row survives a text search on its parent's name/category too
    // (its own `name` already carries "Parent · Label", and `item` gives us
    // the category), so searching "pizza" keeps Small and Large with it.
    return rows.filter((r) => {
      if (filter === 'low' && !isLow(r.target)) return false;
      if (filter === 'out' && !isOut(r.target)) return false;
      if (q && !r.target.name.toLowerCase().includes(q)
          && !r.item.category.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, search, filter]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Boxes className="h-6 w-6 text-primary" /> Inventory
        </h1>
        <p className="text-muted-foreground">
          Live stock per item and per size. Sales deduct automatically; record
          purchases and wastage here. Sizes are listed under their dish — each
          keeps its own count.
        </p>
      </div>

      {/* Summary header — total / low / out at a glance */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* NP-205: "tracked" now means what it says — rows with track_stock
            on. It used to count every listed item, including the untracked
            majority whose 0 this screen then reported as "out of stock". */}
        <SummaryCard label="Tracked rows" value={trackedCount}
          icon={<Boxes className="h-5 w-5 text-primary" />} />
        <SummaryCard label="Low stock" value={lowCount} highlight={lowCount > 0 ? 'amber' : undefined}
          icon={<AlertTriangle className="h-5 w-5 text-amber-600" />} />
        <SummaryCard label="Out of stock" value={outCount} highlight={outCount > 0 ? 'red' : undefined}
          icon={<PackageX className="h-5 w-5 text-red-600" />} />
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col md:flex-row md:items-center gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input placeholder="Search items or categories…" className="pl-9"
                     value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <select value={filter} onChange={(e) => setFilter(e.target.value as 'all' | 'low' | 'out')}
                    className="h-10 rounded-md border border-input bg-background px-3 text-sm">
              <option value="all">All items</option>
              <option value="low">Low stock only</option>
              <option value="out">Out of stock only</option>
            </select>
            <Button variant="outline" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={`mr-2 h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} /> Refresh
            </Button>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Item</TableHead>
              <TableHead>Category</TableHead>
              <TableHead className="text-right">Current stock</TableHead>
              <TableHead className="text-right">Reorder at</TableHead>
              <TableHead>Status</TableHead>
              <TableHead></TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={6} className="text-center py-10 text-muted-foreground">
                  Loading inventory…
                </TableCell></TableRow>
              )}
              {!isLoading && !!error && (
                <TableRow><TableCell colSpan={6} className="text-center py-10">
                  <div className="text-destructive font-medium mb-2">Couldn&rsquo;t load inventory</div>
                  <div className="text-sm text-muted-foreground mb-4">{apiError(error)}</div>
                  <Button variant="outline" size="sm" onClick={() => refetch()}>Try again</Button>
                </TableCell></TableRow>
              )}
              {!isLoading && !error && rows.length === 0 && (
                <TableRow><TableCell colSpan={6} className="text-center py-10 text-muted-foreground">
                  {/* Mirrors the mobile empty state: point owners at the Menu page,
                      because stock lives on menu items — there's nothing to "add" here. */}
                  No items to track yet. Add menu items (with stock &amp; reorder level) on the Menu page
                  and they&rsquo;ll appear here.
                </TableCell></TableRow>
              )}
              {!isLoading && !error && rows.length > 0 && visible.length === 0 && (
                <TableRow><TableCell colSpan={6} className="text-center py-10 text-muted-foreground">
                  No items match your search/filter.
                </TableCell></TableRow>
              )}
              {visible.map(({ target: t, isVariant, item }) => {
                const out = isOut(t);
                const low = isLow(t);
                return (
                  // Amber wash for low, red for out — same signal as the
                  // amber-bordered rows in the mobile list.
                  <TableRow key={t.key} className={out ? 'bg-red-50/60' : low ? 'bg-amber-50/50' : ''}>
                    <TableCell>
                      {/* NP-205 — a variant is INDENTED under its dish and
                          shows only its own label; the parent's name is
                          already on the row above. */}
                      <div className={`flex items-center gap-2 ${isVariant ? 'pl-6' : ''}`}>
                        {isVariant
                          ? <span className="text-muted-foreground select-none">↳</span>
                          : (
                            /* Veg/non-veg dot, standard Indian menu convention (FSSAI mark) */
                            <span className={`inline-block h-2.5 w-2.5 rounded-full shrink-0 ${item.isVeg ? 'bg-green-600' : 'bg-red-600'}`}
                                  title={item.isVeg ? 'Veg' : 'Non-veg'} />
                          )}
                        <span className={isVariant ? '' : 'font-medium'}>
                          {isVariant ? t.name.split(' · ').slice(1).join(' · ') : t.name}
                        </span>
                        {!t.trackStock && (
                          <Badge variant="muted" className="text-[10px]"
                            title="Stock isn't counted for this row — sales don't reduce it and it never shows as sold out.">
                            Not tracked
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {isVariant ? '' : item.category}
                    </TableCell>
                    <TableCell className="text-right">
                      {t.trackStock
                        ? <><strong>{fmtQty(t.stock)}</strong> {unitShort(t.unit)}</>
                        : <span className="text-muted-foreground">unlimited</span>}
                    </TableCell>
                    <TableCell className="text-right text-sm text-muted-foreground">
                      {t.trackStock ? `${fmtQty(t.reorderLevel)} ${unitShort(t.unit)}` : '—'}
                    </TableCell>
                    <TableCell>
                      {!t.trackStock ? <Badge variant="muted">—</Badge>
                        : out ? <Badge variant="destructive">OUT OF STOCK</Badge>
                        : low ? <Badge variant="warning">LOW</Badge>
                        : <Badge variant="success">OK</Badge>}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <Button size="sm" variant="ghost" title="Stock movements" onClick={() => setViewing(t)}>
                        <History className="h-4 w-4" />
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setAdjusting(t)}>
                        <SlidersHorizontal className="mr-2 h-3.5 w-3.5" /> Adjust
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {adjusting && <AdjustStockDialog target={adjusting} onClose={() => setAdjusting(null)} />}
      {viewing && <HistoryDialog target={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

// ── Summary card ────────────────────────────────────────────────────────

function SummaryCard({ label, value, icon, highlight }: {
  label: string; value: number; icon: ReactNode; highlight?: 'amber' | 'red';
}) {
  const border = highlight === 'red' ? 'border-red-200'
    : highlight === 'amber' ? 'border-amber-200' : '';
  return (
    <Card className={border}>
      <CardContent className="p-4 flex items-center justify-between">
        <div>
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="text-2xl font-bold">{value}</div>
        </div>
        {icon}
      </CardContent>
    </Card>
  );
}

// ── Adjust stock dialog ─────────────────────────────────────────────────

function AdjustStockDialog({ target, onClose }: { target: StockTarget; onClose: () => void }) {
  const qc = useQueryClient();
  // Delta kept as a string so the user can type "-" or "1.5" mid-edit
  // without the input snapping back to a number.
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState<string>('adjustment');
  const [note, setNote] = useState('');

  const parsed = parseFloat(delta);
  const valid = Number.isFinite(parsed) && parsed !== 0;
  const preview = valid ? target.stock + parsed : null;

  const adjust = useMutation({
    // Same endpoint the mobile app calls (api_service.dart adjustStock):
    // menu routes are mounted at /menu, NOT /menu-items — the old path
    // 404'd on mobile (route fix 2026-08-23), so don't regress it here.
    // NP-205: a variant goes to its own twin of that route
    // (…/menu/:itemId/variants/:variantId/stock) rather than through the
    // replace-all variant list, which would race a concurrent menu edit.
    mutationFn: () => {
      const b = getBusinessCache();
      const url = target.variantId
        ? `/businesses/${b.id}/menu/${target.itemId}/variants/${target.variantId}/stock`
        : `/businesses/${b.id}/menu/${target.itemId}/stock`;
      return api.put(url, {
        delta: parsed, reason, ...(note.trim() ? { note: note.trim() } : {}),
      }).then((r) => (r.data.item ?? r.data.variant) as { stock: number });
    },
    onSuccess: (updated) => {
      toast.success(`${target.name}: stock now ${fmtQty(updated.stock)} ${unitShort(target.unit)}`);
      // Menu page and inventory share the same underlying rows — refresh both.
      qc.invalidateQueries({ queryKey: ['inventory-menu'] });
      qc.invalidateQueries({ queryKey: ['menu'] });
      qc.invalidateQueries({ queryKey: ['variants'] });
      qc.invalidateQueries({ queryKey: ['stock-history', target.key] });
      onClose();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Adjust stock — {target.name}</DialogTitle></DialogHeader>
        <CardDescription>
          Current stock: <strong>{fmtQty(target.stock)} {unitShort(target.unit)}</strong> ·
          reorder at {fmtQty(target.reorderLevel)} {unitShort(target.unit)}
        </CardDescription>
        {!target.trackStock && (
          // NP-205: booking a count is how an owner opts INTO tracking, and
          // that has teeth (a tracked row at 0 stops selling), so say so
          // before they save rather than after the POS refuses a sale.
          <div className="text-xs p-2 rounded-md bg-amber-50 text-amber-800">
            Stock isn&rsquo;t counted for this row yet. Saving an adjustment
            starts counting it — after that, sales reduce it and it stops
            being sellable at 0.
          </div>
        )}
        <div className="space-y-3">
          <div>
            <Label>Quantity change (+ / −)</Label>
            <div className="flex gap-2">
              {/* Steppers cover the common "received one crate / binned one plate"
                  case without keyboard input — faster during service. */}
              <Button type="button" variant="outline" size="sm" className="shrink-0"
                onClick={() => setDelta(String((Number.isFinite(parsed) ? parsed : 0) - 1))}>−1</Button>
              <Input inputMode="decimal" placeholder="e.g. 10 or -2" value={delta}
                     onChange={(e) => setDelta(e.target.value)} autoFocus />
              <Button type="button" variant="outline" size="sm" className="shrink-0"
                onClick={() => setDelta(String((Number.isFinite(parsed) ? parsed : 0) + 1))}>+1</Button>
            </div>
          </div>
          <div>
            <Label>Reason</Label>
            <select value={reason} onChange={(e) => setReason(e.target.value)}
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm capitalize">
              {REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div>
            <Label>Note (optional)</Label>
            <Input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)}
                   placeholder='e.g. "Morning market run, invoice 502"' />
          </div>
          {preview !== null && (
            <div className={`text-sm p-2 rounded-md ${preview < 0 ? 'bg-red-50 text-red-700' : 'bg-muted text-muted-foreground'}`}>
              New stock: <strong>{fmtQty(preview)} {unitShort(target.unit)}</strong>
              {/* Backend allows negative stock (over-sold tracking) — warn but
                  don't block, matching mobile behaviour. */}
              {preview < 0 && ' — this goes negative. Double-check the sign.'}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => adjust.mutate()} disabled={!valid || adjust.isPending}>
            {adjust.isPending ? 'Saving…' : 'Save adjustment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Stock movements dialog (port of mobile item_detail_screen) ──────────

function HistoryDialog({ target, onClose }: { target: StockTarget; onClose: () => void }) {
  const { data: history = [], isLoading, error } = useQuery<StockMovement[]>({
    queryKey: ['stock-history', target.key],
    queryFn: () => {
      const b = getBusinessCache();
      // Backend caps limit at 200; 100 keeps the dialog scrollable but useful.
      // NP-205: the ledger's menu_item_id is always the PARENT, so the item's
      // history shows every size together; `variantId` narrows it to one.
      return api.get(`/businesses/${b.id}/menu/${target.itemId}/history`, {
        params: { limit: 100, ...(target.variantId ? { variantId: target.variantId } : {}) },
      }).then((r) => r.data.history as StockMovement[]);
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>Stock movements — {target.name}</DialogTitle></DialogHeader>
        <CardDescription>
          Current stock: <strong>{fmtQty(target.stock)} {unitShort(target.unit)}</strong>. Newest first.
        </CardDescription>
        <div className="max-h-[420px] overflow-y-auto space-y-2 pr-1">
          {isLoading && <div className="py-8 text-center text-muted-foreground text-sm">Loading movements…</div>}
          {!!error && <div className="py-8 text-center text-destructive text-sm">{apiError(error)}</div>}
          {!isLoading && !error && history.length === 0 && (
            <div className="py-8 text-center text-muted-foreground text-sm">
              No movements yet — adjustments and sales will show up here.
            </div>
          )}
          {history.map((t) => (
            <div key={t.id} className="flex items-center gap-3 p-3 rounded-md border">
              {t.qtyChange >= 0
                ? <ArrowUp className="h-4 w-4 text-green-600 shrink-0" />
                : <ArrowDown className="h-4 w-4 text-red-600 shrink-0" />}
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm">
                  {t.qtyChange >= 0 ? '+' : ''}{fmtQty(t.qtyChange)} {unitShort(target.unit)}
                  <span className="text-muted-foreground font-normal capitalize"> · {t.reason}</span>
                </div>
                <div className="text-xs text-muted-foreground truncate">
                  {new Date(t.createdAt).toLocaleString('en-IN', {
                    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
                  })}
                  {t.note ? ` · ${t.note}` : ''}
                </div>
              </div>
              <div className="text-sm text-muted-foreground whitespace-nowrap">
                = {fmtQty(t.balanceAfter)}
              </div>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
