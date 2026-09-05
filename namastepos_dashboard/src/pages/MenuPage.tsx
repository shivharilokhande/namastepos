// NamastePOS dashboard — Menu manager (PetPooja-style).
//
//   ┌─────────────┬─────────────────────────────────────────────┐
//   │ Categories  │  Search + filters                            │
//   │ ──────────  │  ─────────────────────────────────────────── │
//   │ ▸ Starters  │  ┌────┐ ┌────┐ ┌────┐ ┌────┐                 │
//   │ ▸ Mains     │  │card│ │card│ │card│ │card│                 │
//   │ ▸ Bev       │  └────┘ └────┘ └────┘ └────┘                 │
//   │ ▸ Combos    │  ...                                          │
//   └─────────────┴─────────────────────────────────────────────┘
//
// Categories are derived from items.category (free-text). Combos appear
// under their own "🎁 Combos" pseudo-category at the top of the sidebar.

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Plus, Trash2, Edit2, Search, Filter, Gift, Leaf, X, ChefHat, ImageOff,
  Ban, Check as CheckIcon, Upload as UploadIcon, Lock,
  Sparkles, ClipboardPaste, PencilLine,
} from 'lucide-react';
import { MenuCsvImportDialog } from '@/components/MenuCsvImportDialog';
import { MenuTemplateDialog } from '@/components/MenuTemplateDialog';
import { MenuPasteDialog } from '@/components/MenuPasteDialog';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { ffApi } from '@/api/namastepos';
import { apiError } from '@/api/client';
import { usePlan } from '@/hooks/usePlan';
import { trackMenuReadyAsync } from '@/lib/activation';
import { formatINR, fullImageUrl } from '@/lib/utils';

const COMBO_KEY = '__combos__';

export function MenuPage() {
  const qc = useQueryClient();
  const { data: items = [], isLoading } = useQuery({ queryKey: ['menu'], queryFn: ffApi.listMenu });

  // Activation funnel — `menu_ready`. Watched on the LIST rather than on the
  // create mutation because the event is a threshold crossing ("this
  // business now has >= 3 owner-authored active items"), not an action: an
  // item added on the phone, a CSV import or a /migrate run must all be
  // able to trip it. trackMenuReady() is first-time-only per business and
  // returns immediately once fired, so calling it on every refetch is free.
  useEffect(() => {
    if (isLoading || !Array.isArray(items) || items.length === 0) return;
    trackMenuReadyAsync(items, 'manual');
  }, [items, isLoading]);

  const [selectedCat, setSelectedCat] = useState<string>('__all__');
  const [search, setSearch] = useState('');
  const [vegOnly, setVegOnly] = useState(false);
  const [activeOnly, setActiveOnly] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<any | null>(null);
  const [csvOpen, setCsvOpen] = useState(false);   // FF-218
  // 2026-09-05 — the two new routes past the menu wall (activation audit).
  const [templateOpen, setTemplateOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);

  // ── Derive category list from items.category ────────────────────────────
  const categoryCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of items) {
      if (it.isCombo) continue; // combos counted separately
      const c = it.category || 'Other';
      m.set(c, (m.get(c) || 0) + 1);
    }
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [items]);

  const comboCount = useMemo(
    () => items.filter((i: any) => i.isCombo).length,
    [items]
  );

  // ── Filtered view ───────────────────────────────────────────────────────
  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((it: any) => {
      if (selectedCat === COMBO_KEY && !it.isCombo) return false;
      if (selectedCat !== COMBO_KEY && selectedCat !== '__all__' && it.category !== selectedCat) return false;
      if (vegOnly && !it.isVeg) return false;
      if (activeOnly && !it.isActive) return false;
      if (q && !it.name.toLowerCase().includes(q)
         && !(it.description || '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [items, selectedCat, search, vegOnly, activeOnly]);

  // A genuinely empty menu, as distinct from a filter that matched nothing.
  // The old code conflated the two and told brand-new owners their filters
  // were too narrow.
  const menuIsEmpty = !isLoading && items.length === 0;

  const remove = useMutation({
    mutationFn: (id: string) => ffApi.deleteMenuItem(id),
    onSuccess: () => {
      toast.success('Item removed');
      qc.invalidateQueries({ queryKey: ['menu'] });
      setConfirmDelete(null);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Menu</h1>
          <p className="text-muted-foreground text-sm">
            {items.length} items · {categoryCounts.length} categories · {comboCount} combos
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {/* 2026-09-05 — the fast routes come first in the header too, not
              just in the empty state: an owner who typed five items and gave
              up is looking for exactly this. */}
          <Button variant="outline" onClick={() => setTemplateOpen(true)}>
            <Sparkles className="mr-2 h-4 w-4" /> Start with a menu
          </Button>
          <Button variant="outline" onClick={() => setPasteOpen(true)}>
            <ClipboardPaste className="mr-2 h-4 w-4" /> Paste a menu
          </Button>
          <Button variant="outline" onClick={() => setCsvOpen(true)}>
            <UploadIcon className="mr-2 h-4 w-4" /> Import CSV
          </Button>
          <Button variant="outline" onClick={() => setEditing({ isCombo: true })}>
            <Gift className="mr-2 h-4 w-4" /> New combo
          </Button>
          <Button onClick={() => setEditing({})}>
            <Plus className="mr-2 h-4 w-4" /> Add item
          </Button>
        </div>
      </div>
      <MenuCsvImportDialog open={csvOpen} onClose={() => setCsvOpen(false)} />
      <MenuTemplateDialog open={templateOpen} onClose={() => setTemplateOpen(false)} />
      <MenuPasteDialog open={pasteOpen} onClose={() => setPasteOpen(false)} />

      {/* ── EMPTY MENU ────────────────────────────────────────────────────
          The wall, and the moment it matters most. This screen used to say
          "No items match these filters." to an owner who had no items and no
          filters — technically true, and completely useless. A new owner
          landing here has to be told the three real ways in, with the fastest
          one first and the 45-minute one last. Filters, the search box and the
          category sidebar are all hidden while the menu is empty: there is
          nothing to search. */}
      {menuIsEmpty && (
        <>
          <Card className="border-primary/30 bg-primary/5">
            <CardContent className="p-6 text-center space-y-2">
              <h2 className="text-xl font-bold">Your menu is empty</h2>
              <p className="text-sm text-muted-foreground max-w-xl mx-auto">
                You need a menu before you can bill anything — but you do not
                need to type it. Pick whichever of these matches what you have
                right now.
              </p>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <EmptyRoute
              icon={<Sparkles className="h-5 w-5" />}
              title="Start with a menu"
              time="about 1 minute"
              body="Load a ready menu for your kind of kitchen — cafe, dhaba, tiffin, QSR, bakery, bar, cloud kitchen, tea stall. Items, categories and GST come pre-filled. Change prices after."
              cta="Pick a starter menu"
              onClick={() => setTemplateOpen(true)}
              primary
            />
            <EmptyRoute
              icon={<ClipboardPaste className="h-5 w-5" />}
              title="Paste what you have"
              time="about 5 minutes"
              body="Already have the menu as text — a WhatsApp message, a typed list? Paste it and we read the names and prices. You check the list before it saves."
              cta="Paste a menu"
              onClick={() => setPasteOpen(true)}
            />
            <EmptyRoute
              icon={<UploadIcon className="h-5 w-5" />}
              title="Import from your old system"
              time="about 5 minutes"
              body="Moving off another POS or a spreadsheet? Upload the CSV export. Name and Price are the only columns we need."
              cta="Import a CSV"
              onClick={() => setCsvOpen(true)}
            />
          </div>

          <Card>
            <CardContent className="p-4 flex items-center justify-between gap-3 flex-wrap">
              <div className="text-sm text-muted-foreground flex items-center gap-2">
                <PencilLine className="h-4 w-4" />
                Only sell a handful of things? Typing them is fine too.
              </div>
              <Button variant="outline" onClick={() => setEditing({})}>
                <Plus className="mr-2 h-4 w-4" /> Add an item by hand
              </Button>
            </CardContent>
          </Card>
        </>
      )}

      {/* Search + filters */}
      {!menuIsEmpty && (
      <Card>
        <CardContent className="p-3 flex flex-col md:flex-row gap-3 md:items-center">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search items by name or description…"
              className="pl-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="flex gap-1.5 items-center text-sm">
            <FilterChip on={vegOnly} onClick={() => setVegOnly((v) => !v)} icon={<Leaf className="h-3.5 w-3.5" />}>
              Veg only
            </FilterChip>
            <FilterChip on={activeOnly} onClick={() => setActiveOnly((v) => !v)}>
              Active only
            </FilterChip>
            {(vegOnly || activeOnly || search) && (
              <button
                onClick={() => { setVegOnly(false); setActiveOnly(false); setSearch(''); }}
                className="text-xs text-muted-foreground hover:text-foreground px-2"
              >
                Clear
              </button>
            )}
          </div>
        </CardContent>
      </Card>
      )}

      {/* Body — sidebar + grid */}
      {!menuIsEmpty && (
      <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-4">
        {/* Category sidebar */}
        <Card>
          <CardContent className="p-2 space-y-1">
            <CatRow
              label="All items"
              count={items.length}
              active={selectedCat === '__all__'}
              onClick={() => setSelectedCat('__all__')}
            />
            {comboCount > 0 && (
              <CatRow
                label="🎁 Combos"
                count={comboCount}
                active={selectedCat === COMBO_KEY}
                onClick={() => setSelectedCat(COMBO_KEY)}
                highlight
              />
            )}
            <div className="border-t my-2" />
            {categoryCounts.length === 0 && (
              <div className="text-xs text-muted-foreground p-2">
                No items yet. Add one to get started.
              </div>
            )}
            {categoryCounts.map(([cat, n]) => (
              <CatRow
                key={cat}
                label={cat}
                count={n}
                active={selectedCat === cat}
                onClick={() => setSelectedCat(cat)}
              />
            ))}
          </CardContent>
        </Card>

        {/* Item grid */}
        <div>
          {isLoading && (
            <Card><CardContent className="p-10 text-center text-muted-foreground">Loading…</CardContent></Card>
          )}
          {!isLoading && filteredItems.length === 0 && (
            <Card>
              <CardContent className="p-10 text-center text-muted-foreground space-y-2">
                <div>No items match these filters.</div>
                {(search || vegOnly || activeOnly) && (
                  <Button variant="ghost" size="sm"
                    onClick={() => { setSearch(''); setVegOnly(false); setActiveOnly(false); }}>
                    Clear filters
                  </Button>
                )}
              </CardContent>
            </Card>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {filteredItems.map((it: any) => (
              <ItemCard
                key={it.id}
                item={it}
                allItems={items}
                onEdit={() => setEditing(it)}
                onDelete={() => setConfirmDelete(it)}
              />
            ))}
          </div>
        </div>
      </div>
      )}

      {/* Edit / Create dialog */}
      {editing && (
        <EditDialog
          item={editing}
          allItems={items}
          onClose={() => setEditing(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['menu'] });
            // WHY (2026-08-25, founder bug "variants not working"): the
            // EditDialog caches its variant rows under ['variants', itemId].
            // We never invalidated that key after a save, so reopening the
            // dialog seeded the editor from the STALE cached list and the
            // just-saved variants appeared to vanish. Invalidate here so the
            // next open refetches from the server.
            qc.invalidateQueries({ queryKey: ['variants'] });
            setEditing(null);
          }}
        />
      )}

      {/* Delete confirm */}
      {confirmDelete && (
        <Dialog open onOpenChange={(o) => !o && setConfirmDelete(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Remove "{confirmDelete.name}"?</DialogTitle></DialogHeader>
            <p className="text-sm text-muted-foreground">
              This soft-deletes the item — it stops showing in the menu but historical orders
              that reference it stay intact.
            </p>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirmDelete(null)}>Cancel</Button>
              <Button variant="destructive" onClick={() => remove.mutate(confirmDelete.id)} disabled={remove.isPending}>
                {remove.isPending ? 'Removing…' : 'Remove item'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

// ── Small bits ──────────────────────────────────────────────────────────

/**
 * One of the three routes out of an empty menu. `time` is an honest estimate,
 * not a promise: an owner who is told "1 minute" and spends 20 stops
 * believing anything else the product says.
 */
function EmptyRoute({
  icon, title, time, body, cta, onClick, primary,
}: {
  icon: React.ReactNode;
  title: string;
  time: string;
  body: string;
  cta: string;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <Card className={primary ? 'border-primary' : ''}>
      <CardContent className="p-4 flex flex-col gap-2 h-full">
        <div className="flex items-center gap-2">
          <span className={`grid place-items-center h-9 w-9 rounded-lg ${
            primary ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'}`}>
            {icon}
          </span>
          <div>
            <div className="font-semibold leading-tight">{title}</div>
            <div className="text-[11px] text-muted-foreground">{time}</div>
          </div>
        </div>
        <p className="text-xs text-muted-foreground flex-1">{body}</p>
        <Button variant={primary ? 'default' : 'outline'} className="w-full" onClick={onClick}>
          {cta}
        </Button>
      </CardContent>
    </Card>
  );
}

function FilterChip({
  on, onClick, icon, children,
}: { on: boolean; onClick: () => void; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors ${
        on
          ? 'border-primary bg-primary/10 text-primary'
          : 'border-input bg-card hover:bg-accent'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

function CatRow({
  label, count, active, onClick, highlight,
}: { label: string; count: number; active: boolean; onClick: () => void; highlight?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center justify-between px-3 py-2 rounded-md text-sm transition-colors ${
        active
          ? 'bg-primary text-primary-foreground font-semibold'
          : highlight
            ? 'bg-amber-50 hover:bg-amber-100 text-amber-900'
            : 'hover:bg-accent'
      }`}
    >
      <span className="truncate">{label}</span>
      <span className={`text-xs ${active ? 'opacity-90' : 'opacity-60'}`}>{count}</span>
    </button>
  );
}

function ItemCard({
  item, allItems, onEdit, onDelete,
}: { item: any; allItems: any[]; onEdit: () => void; onDelete: () => void }) {
  const qc = useQueryClient();
  // NP-205 — only a TRACKED item can be low or out (migration 084). Every
  // untracked dish sits at stock 0 forever, so this card used to stamp a red
  // "Out" badge across a menu that was entirely available.
  const tracked = item.trackStock === true;
  const isLow = tracked && item.stock <= item.reorderLevel && item.stock > 0;
  const isOut = tracked && item.stock <= 0 && !item.isCombo;
  const margin = item.costPrice != null && item.price > 0
    ? Math.round(((item.price - item.costPrice) / item.price) * 100)
    : null;
  const soldOut = item.soldOutUntil && new Date(item.soldOutUntil) > new Date();

  // FF-401: 86 / sold-out toggle. Flicks instantly with optimistic feedback
  // via React-Query invalidate, no separate confirm dialog.
  const toggleSoldOut = useMutation({
    mutationFn: () => ffApi.toggleSoldOut(item.id, soldOut ? null : 'tomorrow_open'),
    onSuccess: () => {
      toast.success(soldOut ? `${item.name} is back in stock` : `${item.name} marked sold out`);
      qc.invalidateQueries({ queryKey: ['menu'] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div className={`bg-card rounded-lg border overflow-hidden flex flex-col transition-shadow hover:shadow-md ${
      !item.isActive || soldOut ? 'opacity-60' : ''
    }`}>
      {/* Image / placeholder */}
      <div className="relative aspect-[4/3] bg-muted">
        {item.imageUrl ? (
          <img src={fullImageUrl(item.imageUrl)} alt={item.name} className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <div className="absolute inset-0 grid place-items-center text-muted-foreground">
            <ImageOff className="h-8 w-8 opacity-40" />
          </div>
        )}
        {soldOut && (
          <div className="absolute inset-0 bg-red-900/40 grid place-items-center">
            <span className="bg-red-700 text-white text-xs font-bold px-3 py-1 rounded-full">
              SOLD OUT
            </span>
          </div>
        )}
        {/* Badges overlay */}
        <div className="absolute top-2 left-2 flex gap-1">
          <span
            className={`h-4 w-4 rounded-sm border-2 grid place-items-center ${
              item.isVeg ? 'border-emerald-600' : 'border-red-600'
            } bg-white`}
            title={item.isVeg ? 'Veg' : 'Non-veg'}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${item.isVeg ? 'bg-emerald-600' : 'bg-red-600'}`} />
          </span>
          {item.isCombo && (
            <span className="bg-amber-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded flex items-center gap-0.5">
              <Gift className="h-2.5 w-2.5" /> COMBO
            </span>
          )}
        </div>
        <div className="absolute top-2 right-2 flex gap-1">
          {!item.isActive && <Badge variant="muted" className="text-[10px]">Hidden</Badge>}
          {isOut && !soldOut && <Badge variant="destructive" className="text-[10px]">Out</Badge>}
          {!isOut && !soldOut && isLow && <Badge variant="warning" className="text-[10px]">Low</Badge>}
        </div>
      </div>

      {/* Body */}
      <div className="p-3 flex-1 flex flex-col gap-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-semibold truncate" title={item.name}>{item.name}</div>
            <div className="text-xs text-muted-foreground truncate">{item.category}</div>
          </div>
          <div className="font-bold text-primary text-right whitespace-nowrap">{formatINR(item.price)}</div>
        </div>

        {item.description && (
          <div className="text-xs text-muted-foreground line-clamp-2">{item.description}</div>
        )}

        {/* Combo components */}
        {item.isCombo && Array.isArray(item.comboItems) && item.comboItems.length > 0 && (
          <div className="text-[11px] text-muted-foreground mt-1 border-t pt-1">
            <div className="font-semibold mb-0.5">Includes:</div>
            {item.comboItems.slice(0, 3).map((c: any, i: number) => {
              const inner = allItems.find((x: any) => x.id === c.menuItemId);
              return (
                <div key={i} className="truncate">• {c.qty}× {inner?.name || c.name || '—'}</div>
              );
            })}
            {item.comboItems.length > 3 && (
              <div className="opacity-70">+ {item.comboItems.length - 3} more…</div>
            )}
          </div>
        )}

        {/* Footer row */}
        <div className="flex items-center justify-between mt-auto pt-2 text-xs">
          <div className="text-muted-foreground">
            {!item.isCombo && <>Stock: <strong>{item.stock} {item.unit}</strong></>}
            {margin != null && <span className="ml-2">· margin {margin}%</span>}
            {item.prepMinutes && (
              <span className="ml-2 inline-flex items-center gap-0.5">
                <ChefHat className="h-3 w-3" /> {item.prepMinutes}m
              </span>
            )}
          </div>
          <div className="flex gap-0.5">
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0"
              onClick={() => toggleSoldOut.mutate()}
              disabled={toggleSoldOut.isPending}
              title={soldOut ? 'Mark in stock' : 'Mark sold out (until tomorrow 06:00)'}>
              {soldOut
                ? <CheckIcon className="h-3.5 w-3.5 text-emerald-700" />
                : <Ban className="h-3.5 w-3.5 text-red-700" />}
            </Button>
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={onEdit} title="Edit">
              <Edit2 className="h-3.5 w-3.5" />
            </Button>
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={onDelete} title="Remove">
              <Trash2 className="h-3.5 w-3.5 text-destructive" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Edit / Create dialog ────────────────────────────────────────────────

function EditDialog({
  item, allItems, onClose, onSaved,
}: { item: any; allItems: any[]; onClose: () => void; onSaved: () => void }) {
  const mode = item.id ? 'edit' : 'create';

  // WHY (2026-08-25, founder bug "variants not working"): variants +
  // modifier-groups are gated server-side by the `menu_variants_modifiers`
  // plan feature (Pro tier — see backend featureGate.js + migration 031).
  // On the free Starter plan the backend 402s BOTH the list (GET) and save
  // (PUT) endpoints, and this dialog used to swallow the 402 — so the form
  // rendered, accepted input, said "Item updated"… and silently dropped the
  // variants. We now read the plan here and (a) skip the gated network
  // calls, (b) replace the dead forms with an explicit lock + upgrade hint.
  const plan = usePlan();
  const canVariants = plan.has('menu_variants_modifiers');

  const [f, setF] = useState<any>({
    name:         item.name || '',
    description:  item.description || '',
    category:     item.category || 'Food',
    price:        item.price ?? 0,
    costPrice:    item.costPrice ?? 0,
    stock:        item.stock ?? 0,
    // NP-205 (migration 084). New items default to OFF — most Indian
    // restaurants don't count dishes, and the old implicit default ("any
    // number you typed is tracked") is what made `stock = 0` ambiguous in the
    // first place. An owner who types an opening stock turns it on.
    trackStock:   item.trackStock ?? false,
    reorderLevel: item.reorderLevel ?? 10,
    unit:         item.unit || 'piece',
    isVeg:        item.isVeg ?? true,
    isActive:     item.isActive ?? true,
    imageUrl:     item.imageUrl || '',
    isCombo:      item.isCombo ?? false,
    comboItems:   Array.isArray(item.comboItems) ? item.comboItems : [],
    prepMinutes:  item.prepMinutes ?? null,
    displayOrder: item.displayOrder ?? 100,
    gstPct:       item.gstPct ?? 5,
  });
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));

  // Variants + modifier-group attachments are persisted via separate
  // endpoints, so we hold them in their own state and save in a chain
  // after the main item save below.
  // WHY: `enabled: canVariants` — on Starter these GETs would 402 (and
  // react-query would retry them), so we don't fire them at all when the
  // plan lacks the feature.
  const { data: existingVariants = [] } = useQuery({
    queryKey: ['variants', item.id],
    queryFn: () => item.id ? ffApi.listVariants(item.id) : Promise.resolve([]),
    enabled: !!item.id && canVariants,
  });
  const { data: allModGroups = [] } = useQuery({
    queryKey: ['modifier-groups'], queryFn: () => ffApi.listModifierGroups(),
    enabled: canVariants,
  });
  const [variants, setVariants] = useState<any[]>([]);
  const [attachedGroupIds, setAttachedGroupIds] = useState<string[]>([]);

  useEffect(() => {
    if (existingVariants.length > 0 && variants.length === 0) {
      // WHY (2026-08-25): deletes are SOFT on the backend (is_active=false,
      // to keep historical order_items.variant_id intact) and listVariants
      // returns those rows too. Seeding them back made deleted variants
      // "reappear" every time the dialog opened — filter them out.
      setVariants(existingVariants
        .filter((v: any) => v.isActive !== false)
        .map((v: any) => ({
          id: v.id, label: v.label, price: v.price, sku: v.sku || '',
          // NP-205: each variant owns its stock (migration 084). `trackStock`
          // is what makes a count mean something — without it, 0 is
          // indistinguishable from "not counted".
          stock: v.stock ?? '',
          trackStock: v.trackStock === true,
        })));
    }
  }, [existingVariants]);
  useEffect(() => {
    // WHY: skip on Starter — this endpoint is feature-gated (402) too.
    if (canVariants && item.id && attachedGroupIds.length === 0) {
      ffApi.getItemModifierGroups?.(item.id)?.then((ids: string[]) => setAttachedGroupIds(ids || [])).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, canVariants]);

  const componentChoices = allItems.filter((it: any) => !it.isCombo && it.id !== item.id);
  const comboTotal = (f.comboItems || []).reduce((s: number, c: any) => {
    const ref = allItems.find((x: any) => x.id === c.menuItemId);
    return s + (ref ? ref.price * c.qty : 0);
  }, 0);
  const comboSavings = f.isCombo ? Math.max(0, comboTotal - f.price) : 0;

  const save = useMutation({
    mutationFn: async () => {
      const body: any = { ...f };
      if (!body.imageUrl) body.imageUrl = null;
      if (!body.description) body.description = null;
      if (!body.isCombo) body.comboItems = null;
      else body.comboItems = (body.comboItems || []).filter((c: any) => c.menuItemId && c.qty > 0);
      if (body.prepMinutes === '' || body.prepMinutes === undefined) body.prepMinutes = null;
      const saved = mode === 'create'
        ? await ffApi.createMenuItem(body)
        : await ffApi.updateMenuItem(item.id, body);
      const itemId = saved.id || item.id;
      // WHY (2026-08-25): variants + modifier-groups are Pro features
      // (`menu_variants_modifiers`). Previously we always fired these calls
      // and silently swallowed the Starter plan's 402 — the founder-reported
      // "variants not working" bug: the form accepted input, toasted
      // success, and persisted nothing. Now: when the plan lacks the
      // feature the editor renders a lock instead of a form (below), so
      // there is nothing to save and we skip the calls entirely. The 402
      // swallow stays only as a backstop for a mid-session downgrade race
      // (plan changed after the dialog opened) — the item save itself must
      // still succeed in that case.
      if (canVariants) {
        // NP-205: normalise the per-variant stock fields. The inputs hold
        // strings (so the box can be empty mid-edit); the API wants a number
        // or null, and `trackStock` must be sent explicitly — the server only
        // falls back to inferring it from a non-zero stock when the key is
        // absent, and an owner untracking a variant that still shows a count
        // has to be able to say so.
        const cleanVariants = variants
          .filter((v) => v.label && v.price >= 0)
          .map((v) => ({
            ...v,
            stock: v.stock === '' || v.stock === null || v.stock === undefined
              ? null : Number(v.stock),
            trackStock: !!v.trackStock,
          }));
        if (cleanVariants.length > 0 || existingVariants.length > 0) {
          try { await ffApi.setVariants(itemId, cleanVariants); }
          catch (err: any) {
            if (err?.response?.status !== 402) throw err;
            toast.warning('Variants need the Pro plan — item saved without them.');
          }
        }
        // Bug fix: always send the group set, even when empty — otherwise
        // un-checking the last attached group never reaches the backend and
        // the modifier remains attached on the server.
        try { await ffApi.setItemModifierGroups(itemId, attachedGroupIds); }
        catch (err: any) {
          if (err?.response?.status !== 402) throw err;
        }
      }
      return saved;
    },
    onSuccess: () => {
      toast.success(mode === 'create' ? 'Item added' : 'Item updated');
      onSaved();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl w-[95vw] max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {f.isCombo && <Gift className="h-5 w-5 text-amber-500" />}
            {mode === 'create' ? (f.isCombo ? 'New combo' : 'New menu item') : `Edit "${item.name}"`}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Basics */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="md:col-span-2">
              <Label>Name *</Label>
              <Input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Paneer Tikka" />
            </div>
            <div>
              <Label>Category</Label>
              <Input value={f.category} onChange={(e) => set('category', e.target.value)} placeholder="Starters" list="ff-categories" />
              <datalist id="ff-categories">
                {Array.from(new Set(allItems.map((i: any) => i.category))).map((c: any) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </div>
            <div>
              <Label>Selling price (₹) *</Label>
              <Input type="number" step="1" value={f.price} onChange={(e) => set('price', +e.target.value)} />
            </div>
            <div className="md:col-span-2">
              <Label>Short description</Label>
              <Input value={f.description} onChange={(e) => set('description', e.target.value)}
                placeholder="Marinated cottage cheese chargrilled in the tandoor" />
            </div>
            <div className="md:col-span-2">
              <Label>Image</Label>
              <div className="flex items-center gap-3">
                {/* Live preview */}
                <div className="h-20 w-20 rounded-md border border-input bg-muted overflow-hidden flex items-center justify-center text-muted-foreground">
                  {f.imageUrl ? (
                    <img
                      src={fullImageUrl(f.imageUrl)}
                      alt="preview"
                      className="h-full w-full object-cover"
                      onError={(e) => (e.currentTarget.style.display = 'none')}
                    />
                  ) : <ImageOff className="h-6 w-6 opacity-40" />}
                </div>
                {/* Upload / URL toggle */}
                <div className="flex-1 space-y-2">
                  <div className="flex gap-2">
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/gif"
                      className="hidden"
                      id="menu-img-upload"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        try {
                          const r = await ffApi.uploadImage(file);
                          set('imageUrl', r.url);
                          toast.success('Image uploaded');
                        } catch (err) {
                          toast.error(apiError(err));
                        }
                      }}
                    />
                    <Button type="button" variant="outline"
                      onClick={() => document.getElementById('menu-img-upload')?.click()}>
                      Upload photo
                    </Button>
                    {f.imageUrl && (
                      <Button type="button" variant="ghost"
                        onClick={() => set('imageUrl', '')}>
                        Remove
                      </Button>
                    )}
                  </div>
                  <Input value={f.imageUrl}
                    onChange={(e) => set('imageUrl', e.target.value)}
                    placeholder="Or paste an image URL (https://…)" />
                </div>
              </div>
            </div>
          </div>

          {/* Combo toggle + components */}
          <div className="rounded-lg border bg-muted/30 p-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={f.isCombo} onChange={(e) => set('isCombo', e.target.checked)} />
              <span className="font-semibold">This is a combo / meal deal</span>
              <Gift className="h-4 w-4 text-amber-500" />
            </label>

            {f.isCombo && (
              <div className="mt-3 space-y-2">
                <div className="text-xs text-muted-foreground">
                  Pick the items the combo bundles. The order will land as one line at the combo price;
                  stock + recipes deduct from each component.
                </div>
                {(f.comboItems || []).map((c: any, idx: number) => {
                  const ref = allItems.find((x: any) => x.id === c.menuItemId);
                  return (
                    <div key={idx} className="flex items-center gap-2">
                      <select
                        value={c.menuItemId || ''}
                        onChange={(e) => {
                          const next = [...f.comboItems];
                          const picked = componentChoices.find((x: any) => x.id === e.target.value);
                          next[idx] = { ...next[idx], menuItemId: e.target.value, name: picked?.name };
                          set('comboItems', next);
                        }}
                        className="flex-1 h-9 rounded-md border border-input bg-background px-2 text-sm"
                      >
                        <option value="">— pick item —</option>
                        {componentChoices.map((x: any) => (
                          <option key={x.id} value={x.id}>{x.name} ({formatINR(x.price)})</option>
                        ))}
                      </select>
                      <Input
                        type="number"
                        step="0.5"
                        className="w-20 h-9"
                        value={c.qty}
                        onChange={(e) => {
                          const next = [...f.comboItems];
                          next[idx] = { ...next[idx], qty: +e.target.value };
                          set('comboItems', next);
                        }}
                      />
                      <span className="text-xs text-muted-foreground w-20 text-right">
                        {ref ? formatINR(ref.price * c.qty) : '—'}
                      </span>
                      <button
                        onClick={() => set('comboItems', f.comboItems.filter((_: any, i: number) => i !== idx))}
                        className="p-1 hover:bg-accent rounded"
                      >
                        <X className="h-3.5 w-3.5 text-destructive" />
                      </button>
                    </div>
                  );
                })}
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
                  onClick={() => set('comboItems', [...(f.comboItems || []), { menuItemId: '', qty: 1 }])}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" /> Add component
                </Button>
                <div className="grid grid-cols-3 gap-2 pt-2 text-sm border-t mt-2">
                  <div>
                    <div className="text-xs text-muted-foreground">À-la-carte total</div>
                    <div className="font-semibold">{formatINR(comboTotal)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Combo price</div>
                    <div className="font-semibold text-primary">{formatINR(f.price)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Customer saves</div>
                    <div className={`font-semibold ${comboSavings > 0 ? 'text-emerald-700' : 'text-muted-foreground'}`}>
                      {formatINR(comboSavings)}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Variants (Sprint 1 / FF-201) */}
          {/* WHY (2026-08-25, founder bug): on Starter this section used to
              render a fully editable form whose save was a silent 402 no-op.
              Plan-gated features must LOOK locked — show the lock + upgrade
              hint instead of a dead form. */}
          {!f.isCombo && !canVariants && (
            <div className="rounded-lg border border-dashed bg-muted/30 p-3">
              <div className="font-semibold mb-1 flex items-center gap-2">
                <Lock className="h-3.5 w-3.5 text-muted-foreground" />
                <span>Variants</span>
                <Badge variant="muted" className="text-[10px]">Pro</Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                Sell one dish in multiple portions with their own prices
                (Half / Full, Small / Medium / Large). Available on the Pro plan.{' '}
                <a href="/billing" className="underline text-primary font-medium">
                  Upgrade to unlock
                </a>
              </p>
            </div>
          )}
          {!f.isCombo && canVariants && (
            <div className="rounded-lg border bg-muted/30 p-3">
              <div className="font-semibold mb-2 flex items-center gap-2">
                <span>Variants</span>
                <Badge variant="muted" className="text-[10px]">{variants.length}</Badge>
                <span className="text-xs text-muted-foreground font-normal">
                  e.g. Half / Full, Small / Medium / Large
                </span>
              </div>
              {variants.map((v, idx) => {
                const patch = (p: any) => {
                  const next = [...variants];
                  next[idx] = { ...next[idx], ...p };
                  setVariants(next);
                };
                return (
                  <div key={idx} className="flex items-center gap-2 mb-1">
                    <Input value={v.label} onChange={(e) => patch({ label: e.target.value })}
                      placeholder="Label" className="flex-1 h-8" />
                    <Input type="number" value={v.price}
                      onChange={(e) => patch({ price: +e.target.value })}
                      placeholder="Price" className="w-24 h-8" />
                    <Input value={v.sku || ''} onChange={(e) => patch({ sku: e.target.value })}
                      placeholder="SKU" className="w-20 h-8" />
                    {/* NP-205 — this variant's OWN stock (migration 084).
                        Kept as a string so the box can be emptied mid-edit;
                        normalised on save. Disabled until tracking is on,
                        because an untracked number is ignored by the POS and
                        a live-looking input that changes nothing is worse
                        than no input at all. */}
                    <Input type="number" value={v.stock ?? ''}
                      disabled={!v.trackStock}
                      onChange={(e) => patch({ stock: e.target.value })}
                      placeholder="Stock" className="w-20 h-8"
                      title={v.trackStock
                        ? "Units left of this size. 0 = sold out at the POS."
                        : 'Turn on "Track" to count this size'} />
                    <label className="flex items-center gap-1 text-[11px] text-muted-foreground cursor-pointer select-none shrink-0"
                      title="Count this size. Off = unlimited: sales never reduce it and it can never show as sold out.">
                      <input type="checkbox" checked={!!v.trackStock}
                        onChange={(e) => patch({
                          trackStock: e.target.checked,
                          // Turning tracking ON with no number yet starts at
                          // 0 — which reads as SOLD OUT, so seed it from the
                          // parent's stock when there is one. Never silently
                          // 86 a dish the owner was only trying to count.
                          stock: e.target.checked && (v.stock === '' || v.stock == null)
                            ? (f.stock ?? 0) : v.stock,
                        })} />
                      Track
                    </label>
                    <button onClick={() => setVariants(variants.filter((_, i) => i !== idx))}
                      className="p-1 hover:bg-accent rounded">
                      <X className="h-3.5 w-3.5 text-destructive" />
                    </button>
                  </div>
                );
              })}
              <Button size="sm" variant="outline" className="w-full mt-1"
                onClick={() => setVariants([...variants,
                  { label: '', price: f.price || 0, sku: '', stock: '', trackStock: false }])}>
                <Plus className="mr-1 h-3 w-3" /> Add variant
              </Button>
              {variants.some((v) => v.trackStock) && (
                <p className="text-[11px] text-muted-foreground mt-2">
                  Tracked sizes have their own stock: selling a Large only
                  reduces Large. A tracked size at 0 shows as sold out and
                  can&rsquo;t be billed. Adjust counts any time from Inventory.
                </p>
              )}
            </div>
          )}

          {/* Modifier groups attachment (Sprint 1 / FF-202) */}
          {/* WHY: gated by the same `menu_variants_modifiers` Pro feature as
              variants — same explicit lock instead of a silently dead list. */}
          {!f.isCombo && !canVariants && (
            <div className="rounded-lg border border-dashed bg-muted/30 p-3">
              <div className="font-semibold mb-1 flex items-center gap-2">
                <Lock className="h-3.5 w-3.5 text-muted-foreground" />
                <span>Modifier groups</span>
                <Badge variant="muted" className="text-[10px]">Pro</Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                Reusable add-on sets (toppings, spice level, extras) you attach
                to many items. Available on the Pro plan.{' '}
                <a href="/billing" className="underline text-primary font-medium">
                  Upgrade to unlock
                </a>
              </p>
            </div>
          )}
          {!f.isCombo && canVariants && (
            <div className="rounded-lg border bg-muted/30 p-3">
              <div className="font-semibold mb-2">Modifier groups</div>
              {/* Founder bug #2 fix (2026-08-25): the "TBD" placeholder is
                  dead — a real management page exists at /modifier-groups. */}
              {allModGroups.length === 0 && (
                <div className="text-xs text-muted-foreground">
                  No modifier groups yet.{' '}
                  <a href="/modifier-groups" className="underline text-primary font-medium">
                    Create them in Modifier groups
                  </a>{' '}
                  (sidebar), then attach them here.
                </div>
              )}
              {allModGroups.map((g: any) => {
                const checked = attachedGroupIds.includes(g.id);
                return (
                  <label key={g.id} className="flex items-center gap-2 text-sm py-1 cursor-pointer">
                    <input type="checkbox" checked={checked}
                      onChange={(e) => {
                        if (e.target.checked) setAttachedGroupIds([...attachedGroupIds, g.id]);
                        else setAttachedGroupIds(attachedGroupIds.filter((x) => x !== g.id));
                      }} />
                    <span>{g.name}</span>
                    <span className="text-xs text-muted-foreground">
                      · {g.kind === 'single_select' ? 'pick 1' : 'multi'} ({g.minSelect}–{g.maxSelect})
                    </span>
                  </label>
                );
              })}
            </div>
          )}

          {/* Inventory / cost — hidden for combos */}
          {!f.isCombo && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div>
                <Label>Cost price (₹)</Label>
                <Input type="number" value={f.costPrice} onChange={(e) => set('costPrice', +e.target.value)} />
              </div>
              <div>
                <Label>Stock</Label>
                <Input type="number" step="0.01" value={f.stock}
                  disabled={!f.trackStock}
                  onChange={(e) => set('stock', +e.target.value)} />
                {/* NP-205 (migration 084) — explicit tracking. Until now
                    stock 0 meant EITHER "sold out" or "not tracked" and every
                    screen guessed: the QR menu told diners "only 0 left" for
                    dishes the kitchen had plenty of, while the nightly alert
                    named them as out. Off = unlimited. */}
                <label className="flex items-center gap-1.5 mt-1 text-[11px] text-muted-foreground cursor-pointer select-none"
                  title="Off = unlimited: sales never reduce this and it can never show as sold out.">
                  <input type="checkbox" checked={!!f.trackStock}
                    onChange={(e) => set('trackStock', e.target.checked)} />
                  Track stock
                </label>
              </div>
              <div>
                <Label>Reorder at</Label>
                <Input type="number" step="0.01" value={f.reorderLevel} onChange={(e) => set('reorderLevel', +e.target.value)} />
              </div>
              <div>
                <Label>Unit</Label>
                <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                        value={f.unit} onChange={(e) => set('unit', e.target.value)}>
                  {['piece', 'kg', 'gram', 'liter', 'ml', 'plate'].map((u) => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>
            </div>
          )}

          {/* Prep + display + flags */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
            <div>
              <Label>Prep time (mins)</Label>
              <Input
                type="number"
                value={f.prepMinutes ?? ''}
                onChange={(e) => set('prepMinutes', e.target.value === '' ? null : +e.target.value)}
                placeholder="—"
              />
            </div>
            <div>
              <Label>Display order</Label>
              <Input type="number" value={f.displayOrder} onChange={(e) => set('displayOrder', +e.target.value)} />
            </div>
            <div className="flex items-center gap-4 pt-1">
              <label className="flex items-center gap-2 cursor-pointer text-sm">
                <input type="checkbox" checked={f.isVeg} onChange={(e) => set('isVeg', e.target.checked)} />
                Veg
              </label>
              <label className="flex items-center gap-2 cursor-pointer text-sm">
                <input type="checkbox" checked={f.isActive} onChange={(e) => set('isActive', e.target.checked)} />
                Active
              </label>
            </div>
          </div>
        </div>

        <DialogFooter className="flex-wrap gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => save.mutate()}
            // Bug fix: `!f.price` is true for 0, blocking complimentary/promo
            // items at ₹0. Explicitly check for missing or negative instead.
            disabled={save.isPending || !f.name || f.price === undefined || f.price === null || f.price === '' || Number(f.price) < 0}
          >
            {save.isPending ? 'Saving…' : (mode === 'create' ? 'Add to menu' : 'Save changes')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
