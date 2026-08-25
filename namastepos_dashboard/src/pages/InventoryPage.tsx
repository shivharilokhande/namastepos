// NamastePOS dashboard - Inventory page (2026-08-25)
//
// GAP A: port of the mobile inventory feature (inventory_screen.dart +
// item_detail_screen.dart) so owners can manage stock from the web too.
// Uses the exact same backend endpoints as the Flutter app:
//   GET /businesses/:id/menu                     -> { items: [...] }   (menuService.serialize)
//   PUT /businesses/:id/menu/:itemId/stock       -> { item: {...} }    (menuService.adjustStock)
//   GET /businesses/:id/menu/:itemId/history     -> { history: [...] } (menuService.stockHistory)
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
}

interface StockMovement {
  id: string;
  menuItemId: string;
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
const isOut = (i: InventoryItem) => i.stock <= 0;
const isLow = (i: InventoryItem) => !isOut(i) && i.stock <= i.reorderLevel;

// ── Page ────────────────────────────────────────────────────────────────

export function InventoryPage() {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'low' | 'out'>('all');
  const [adjusting, setAdjusting] = useState<InventoryItem | null>(null);
  const [viewing, setViewing] = useState<InventoryItem | null>(null);

  // Reuse the existing menu binding — inventory is a projection of menu
  // items, not a separate resource (stock/reorderLevel live on menu_items).
  const { data: menu = [], isLoading, error, refetch, isFetching } = useQuery<InventoryItem[]>({
    queryKey: ['inventory-menu'],
    queryFn: ffApi.listMenu,
  });

  // Combos have no stock of their own (components are decremented instead)
  // and soft-deleted items keep their row with is_active=false — neither
  // should clutter the tracked list.
  const tracked = useMemo(
    () => menu.filter((i) => i.isActive && !i.isCombo),
    [menu],
  );

  const lowCount = tracked.filter(isLow).length;
  const outCount = tracked.filter(isOut).length;

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tracked.filter((i) => {
      if (filter === 'low' && !isLow(i)) return false;
      if (filter === 'out' && !isOut(i)) return false;
      if (q && !i.name.toLowerCase().includes(q) && !i.category.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [tracked, search, filter]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Boxes className="h-6 w-6 text-primary" /> Inventory
        </h1>
        <p className="text-muted-foreground">
          Live stock per menu item. Sales deduct automatically; record purchases and wastage here.
        </p>
      </div>

      {/* Summary header — total / low / out at a glance */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <SummaryCard label="Tracked items" value={tracked.length}
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
              {!isLoading && !error && tracked.length === 0 && (
                <TableRow><TableCell colSpan={6} className="text-center py-10 text-muted-foreground">
                  {/* Mirrors the mobile empty state: point owners at the Menu page,
                      because stock lives on menu items — there's nothing to "add" here. */}
                  No items to track yet. Add menu items (with stock &amp; reorder level) on the Menu page
                  and they&rsquo;ll appear here.
                </TableCell></TableRow>
              )}
              {!isLoading && !error && tracked.length > 0 && visible.length === 0 && (
                <TableRow><TableCell colSpan={6} className="text-center py-10 text-muted-foreground">
                  No items match your search/filter.
                </TableCell></TableRow>
              )}
              {visible.map((i) => {
                const out = isOut(i);
                const low = isLow(i);
                return (
                  // Amber wash for low, red for out — same signal as the
                  // amber-bordered rows in the mobile list.
                  <TableRow key={i.id} className={out ? 'bg-red-50/60' : low ? 'bg-amber-50/50' : ''}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {/* Veg/non-veg dot, standard Indian menu convention (FSSAI mark) */}
                        <span className={`inline-block h-2.5 w-2.5 rounded-full shrink-0 ${i.isVeg ? 'bg-green-600' : 'bg-red-600'}`}
                              title={i.isVeg ? 'Veg' : 'Non-veg'} />
                        <span className="font-medium">{i.name}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{i.category}</TableCell>
                    <TableCell className="text-right">
                      <strong>{fmtQty(i.stock)}</strong> {unitShort(i.unit)}
                    </TableCell>
                    <TableCell className="text-right text-sm text-muted-foreground">
                      {fmtQty(i.reorderLevel)} {unitShort(i.unit)}
                    </TableCell>
                    <TableCell>
                      {out ? <Badge variant="destructive">OUT OF STOCK</Badge>
                        : low ? <Badge variant="warning">LOW</Badge>
                        : <Badge variant="success">OK</Badge>}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <Button size="sm" variant="ghost" title="Stock movements" onClick={() => setViewing(i)}>
                        <History className="h-4 w-4" />
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setAdjusting(i)}>
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

      {adjusting && <AdjustStockDialog item={adjusting} onClose={() => setAdjusting(null)} />}
      {viewing && <HistoryDialog item={viewing} onClose={() => setViewing(null)} />}
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

function AdjustStockDialog({ item, onClose }: { item: InventoryItem; onClose: () => void }) {
  const qc = useQueryClient();
  // Delta kept as a string so the user can type "-" or "1.5" mid-edit
  // without the input snapping back to a number.
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState<string>('adjustment');
  const [note, setNote] = useState('');

  const parsed = parseFloat(delta);
  const valid = Number.isFinite(parsed) && parsed !== 0;
  const preview = valid ? item.stock + parsed : null;

  const adjust = useMutation({
    // Same endpoint the mobile app calls (api_service.dart adjustStock):
    // menu routes are mounted at /menu, NOT /menu-items — the old path
    // 404'd on mobile (route fix 2026-08-23), so don't regress it here.
    mutationFn: () => {
      const b = getBusinessCache();
      return api.put(
        `/businesses/${b.id}/menu/${item.id}/stock`,
        { delta: parsed, reason, ...(note.trim() ? { note: note.trim() } : {}) },
      ).then((r) => r.data.item as InventoryItem);
    },
    onSuccess: (updated) => {
      toast.success(`${item.name}: stock now ${fmtQty(updated.stock)} ${unitShort(updated.unit)}`);
      // Menu page and inventory share the same underlying rows — refresh both.
      qc.invalidateQueries({ queryKey: ['inventory-menu'] });
      qc.invalidateQueries({ queryKey: ['menu'] });
      qc.invalidateQueries({ queryKey: ['stock-history', item.id] });
      onClose();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Adjust stock — {item.name}</DialogTitle></DialogHeader>
        <CardDescription>
          Current stock: <strong>{fmtQty(item.stock)} {unitShort(item.unit)}</strong> ·
          reorder at {fmtQty(item.reorderLevel)} {unitShort(item.unit)}
        </CardDescription>
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
              New stock: <strong>{fmtQty(preview)} {unitShort(item.unit)}</strong>
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

function HistoryDialog({ item, onClose }: { item: InventoryItem; onClose: () => void }) {
  const { data: history = [], isLoading, error } = useQuery<StockMovement[]>({
    queryKey: ['stock-history', item.id],
    queryFn: () => {
      const b = getBusinessCache();
      // Backend caps limit at 200; 100 keeps the dialog scrollable but useful.
      return api.get(`/businesses/${b.id}/menu/${item.id}/history`, { params: { limit: 100 } })
        .then((r) => r.data.history as StockMovement[]);
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>Stock movements — {item.name}</DialogTitle></DialogHeader>
        <CardDescription>
          Current stock: <strong>{fmtQty(item.stock)} {unitShort(item.unit)}</strong>. Newest first.
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
                  {t.qtyChange >= 0 ? '+' : ''}{fmtQty(t.qtyChange)} {unitShort(item.unit)}
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
