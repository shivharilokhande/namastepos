import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  LayoutGrid, Plus, Edit2, Trash2, Users, ArrowRight, X, Building, Move, Check, Printer,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { NewOrderDialog } from '@/components/NewOrderDialog';
import { BillSplitDialog } from '@/components/BillSplitDialog';
import { FloorCanvas } from '@/components/FloorCanvas';
import { ffApi } from '@/api/namastepos';
import { apiError, getBusinessCache } from '@/api/client';
import { formatINR, formatDateTime } from '@/lib/utils';

const STATUS_COLORS: Record<string, string> = {
  available: 'bg-emerald-100 border-emerald-300 text-emerald-700',
  occupied:  'bg-amber-100 border-amber-300 text-amber-800',
  reserved:  'bg-blue-100 border-blue-300 text-blue-700',
  cleaning:  'bg-slate-100 border-slate-300 text-slate-700',
  blocked:   'bg-red-100 border-red-300 text-red-700',
};

export function TablesPage() {
  const qc = useQueryClient();
  const { data: floors = [] } = useQuery({ queryKey: ['floors'], queryFn: ffApi.listFloors });
  const { data: tables = [], refetch } = useQuery({
    queryKey: ['ops-tables'], queryFn: () => ffApi.listOpsTables(),
    refetchInterval: 5000,
  });
  const [selectedFloor, setSelectedFloor] = useState<string | null>(null);
  const [editingTable, setEditingTable] = useState<any | null>(null);
  const [editingFloor, setEditingFloor] = useState<any | null>(null);
  const [seating, setSeating] = useState<any | null>(null);
  const [viewing, setViewing] = useState<any | null>(null);
  // Layout edit mode: drag tables to match the real cafe seating.
  // Positions persist to tables.x_pos / tables.y_pos.
  const [layoutEdit, setLayoutEdit] = useState(false);
  const [deletingTable, setDeletingTable] = useState<any | null>(null);

  // Hard-delete a table (allowed only when it's not occupied — would orphan
  // an open session). Cascade rules in migration 006 take care of related
  // rows once we proceed.
  const remove = useMutation({
    mutationFn: (id: string) => ffApi.deleteOpsTable(id),
    onSuccess: () => {
      toast.success('Table deleted');
      qc.invalidateQueries({ queryKey: ['ops-tables'] });
      setDeletingTable(null);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  useEffect(() => {
    if (!selectedFloor && floors.length > 0) setSelectedFloor(floors[0].id);
  }, [floors, selectedFloor]);

  const visibleTables = selectedFloor
    ? tables.filter((t: any) => t.floorId === selectedFloor)
    : tables;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <LayoutGrid className="h-6 w-6 text-primary" /> Tables
          </h1>
          <p className="text-muted-foreground">Floor plan & live table status.</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button
            variant={layoutEdit ? 'default' : 'outline'}
            onClick={() => setLayoutEdit((v) => !v)}
          >
            {layoutEdit ? (
              <><Check className="mr-2 h-4 w-4" /> Done arranging</>
            ) : (
              <><Move className="mr-2 h-4 w-4" /> Arrange layout</>
            )}
          </Button>
          <Button variant="outline" onClick={() => setEditingFloor({})}>
            <Building className="mr-2 h-4 w-4" /> Add floor
          </Button>
          <Button onClick={() => setEditingTable({ floorId: selectedFloor })} disabled={!selectedFloor}>
            <Plus className="mr-2 h-4 w-4" /> Add table
          </Button>
        </div>
      </div>

      {/* Floor tabs */}
      <div className="flex flex-wrap gap-2 border-b pb-3">
        {floors.length === 0 && (
          <div className="text-sm text-muted-foreground py-2">
            No floors yet. Create one first (e.g., "Ground floor").
          </div>
        )}
        {floors.map((f: any) => (
          <button key={f.id} onClick={() => setSelectedFloor(f.id)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              selectedFloor === f.id
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted hover:bg-accent'
            }`}>
            {f.name}
          </button>
        ))}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-3 text-xs">
        {Object.entries(STATUS_COLORS).map(([k, cls]) => (
          <div key={k} className="flex items-center gap-1">
            <div className={`h-3 w-3 rounded border ${cls.split(' ').filter(c => c.includes('bg-') || c.includes('border-')).join(' ')}`} />
            <span className="capitalize">{k}</span>
          </div>
        ))}
      </div>

      {/* Empty-state when there are no tables yet */}
      {visibleTables.length === 0 && selectedFloor && (
        <Card>
          <CardContent className="p-12 text-center text-muted-foreground">
            No tables on this floor yet. Click <strong>Add table</strong> top-right to create one.
          </CardContent>
        </Card>
      )}

      {/* Layout-edit helper banner */}
      {layoutEdit && visibleTables.length > 0 && (
        <div className="rounded-lg bg-primary/10 border border-primary px-4 py-2.5 text-sm flex items-center gap-2">
          <Move className="h-4 w-4 text-primary shrink-0" />
          <div>
            <strong>Layout edit mode.</strong> Drag any table to match the real seating in your cafe.
            Positions snap to a 20px grid and save automatically.
            Click <strong>Done arranging</strong> when finished.
          </div>
        </div>
      )}

      {/* Free-position floor canvas — drag tables in edit mode, tap in view mode */}
      {visibleTables.length > 0 && (
        <FloorCanvas
          tables={visibleTables}
          editMode={layoutEdit}
          onTableTap={(t: any) => {
            if (t.status === 'available') setSeating(t);
            else if (t.currentSessionId) setViewing({ tableId: t.id, sessionId: t.currentSessionId });
          }}
          onEdit={(t: any) => setEditingTable(t)}
          onDelete={(t: any) => {
            // Block deletion if the table is currently occupied — closing
            // the session first is the right move.
            if (t.status === 'occupied') {
              toast.error('Settle the running bill first, then delete the table');
              return;
            }
            setDeletingTable(t);
          }}
        />
      )}

      {/* Delete-confirmation dialog */}
      {deletingTable && (
        <Dialog open onOpenChange={(o) => !o && setDeletingTable(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete table {deletingTable.label}?</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              This will remove the table from the floor plan. Historical orders linked to it
              stay in the database (the table reference is set to null). This cannot be undone.
            </p>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setDeletingTable(null)}>Cancel</Button>
              <Button
                variant="destructive"
                onClick={() => remove.mutate(deletingTable.id)}
                disabled={remove.isPending}
              >
                {remove.isPending ? 'Deleting…' : 'Delete table'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {editingFloor && <FloorDialog floor={editingFloor}
        onClose={() => setEditingFloor(null)}
        onSaved={() => { qc.invalidateQueries({ queryKey: ['floors'] }); setEditingFloor(null); }} />}
      {editingTable && <TableDialog table={editingTable} floors={floors}
        onClose={() => setEditingTable(null)}
        onSaved={() => { refetch(); setEditingTable(null); }} />}
      {seating && <SeatingDialog table={seating}
        onClose={() => setSeating(null)}
        onSeated={() => { refetch(); setSeating(null); }} />}
      {viewing && <SessionDialog sessionId={viewing.sessionId}
        onClose={() => setViewing(null)}
        onClosed={() => { refetch(); setViewing(null); }} />}
    </div>
  );
}

function FloorDialog({ floor, onClose, onSaved }: any) {
  const mode = floor.id ? 'edit' : 'create';
  const [name, setName] = useState(floor.name || '');
  const save = useMutation({
    mutationFn: () => mode === 'create' ? ffApi.createFloor({ name }) : ffApi.updateFloor(floor.id, { name }),
    onSuccess: () => { toast.success('Saved'); onSaved(); },
    onError: (e) => toast.error(apiError(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{mode === 'create' ? 'Add floor' : 'Edit floor'}</DialogTitle></DialogHeader>
        <div><Label>Name *</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ground floor" /></div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={!name}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TableDialog({ table, floors, onClose, onSaved }: any) {
  const mode = table.id ? 'edit' : 'create';
  const [f, setF] = useState<any>(table.id ? {
    label: table.label, seats: table.seats, shape: table.shape,
    xPos: table.xPos, yPos: table.yPos,
    serviceMode: table.serviceMode ?? '',
  } : {
    floorId: table.floorId || (floors[0]?.id), label: '', seats: 4,
    shape: 'square', xPos: 0, yPos: 0,
    serviceMode: '',
  });
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  const save = useMutation({
    // FF-252 — normalise the "Auto" pick to null so the backend
    // treats the table as inheriting the business default.
    mutationFn: () => {
      const payload = { ...f, serviceMode: f.serviceMode || null };
      return mode === 'create' ? ffApi.createOpsTable(payload) : ffApi.updateOpsTable(table.id, payload);
    },
    onSuccess: () => { toast.success('Saved'); onSaved(); },
    onError: (e) => toast.error(apiError(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{mode === 'create' ? 'Add table' : 'Edit table'}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          {mode === 'create' && (
            <div>
              <Label>Floor</Label>
              <select value={f.floorId} onChange={(e) => set('floorId', e.target.value)}
                      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                {floors.map((fl: any) => <option key={fl.id} value={fl.id}>{fl.name}</option>)}
              </select>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Label *</Label><Input value={f.label} onChange={(e) => set('label', e.target.value)} placeholder="1" /></div>
            <div><Label>Seats</Label><Input type="number" value={f.seats} onChange={(e) => set('seats', +e.target.value)} /></div>
            <div>
              <Label>Shape</Label>
              <select value={f.shape} onChange={(e) => set('shape', e.target.value)}
                      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                <option value="square">Square</option><option value="round">Round</option>
                <option value="rectangle">Rectangle</option><option value="booth">Booth</option>
              </select>
            </div>
            {/* FF-252 — per-table service style. Auto = inherit business
                default (set in the setup wizard). Dine-in suppresses
                the "come collect" WhatsApp on ready; self-pickup keeps it. */}
            <div className="col-span-2">
              <Label>Service style</Label>
              <select value={f.serviceMode || ''} onChange={(e) => set('serviceMode', e.target.value)}
                      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                <option value="">Auto (use business default)</option>
                <option value="dine_in">Dine-in — waiter serves at the table</option>
                <option value="self_pickup">Self-pickup — guest collects at counter</option>
              </select>
              <p className="text-[11px] text-muted-foreground mt-1">
                Controls what happens when the kitchen marks an order ready.
              </p>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={!f.label}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SeatingDialog({ table, onClose, onSeated }: any) {
  const [f, setF] = useState({ guestCount: table.seats, customerPhone: '', customerName: '', notes: '' });
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  const seat = useMutation({
    mutationFn: () => ffApi.openSession(table.id, f),
    onSuccess: () => { toast.success('Table seated'); onSeated(); },
    onError: (e) => toast.error(apiError(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Seat table {table.label}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>Guest count</Label><Input type="number" value={f.guestCount} onChange={(e) => set('guestCount', +e.target.value)} /></div>
          <div><Label>Customer phone (optional)</Label><Input value={f.customerPhone} onChange={(e) => set('customerPhone', e.target.value)} placeholder="9876543210" /></div>
          <div><Label>Customer name (optional)</Label><Input value={f.customerName} onChange={(e) => set('customerName', e.target.value)} /></div>
          <div><Label>Notes (optional)</Label><Input value={f.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Birthday party, allergic to peanuts…" /></div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => seat.mutate()} disabled={seat.isPending}>Seat guests</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Gap B (2026-08-25) — consolidated session bill from the dashboard.
// The mobile app prints ONE merged bill per table session over Bluetooth
// (printer_service.dart → printSessionBill); the dashboard settle flow had
// no bill at all. We mirror it with the browser print dialog: an 80mm-style
// receipt rendered into a popup (window.open + document.write), then
// window.print() so the cashier can hit any system printer or save a PDF.
// Data comes from the SAME endpoint the dialog already polls
// (GET /businesses/:bid/ops/sessions/:id via ffApi.sessionDetail) — no new
// API surface needed.
// ---------------------------------------------------------------------------

// Escape user-controlled strings (item names, customer name, notes…) before
// document.write — a menu item literally named "<img onerror=…>" must print
// as text, not execute inside the popup.
function escHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// One merged line on the final bill: identical dishes across every KOT of the
// session collapsed into a single row (same shape SessionDialog's `grouped`
// memo produces).
type MergedBillLine = { name: string; qty: number; price: number; lineTotal: number };

function printSessionBill(session: any, mergedLines: MergedBillLine[]) {
  // Business identity for the header comes from the login-time cache — same
  // object BillingPage uses for the subscription invoice printout, so the
  // bill needs zero extra network calls.
  const biz = getBusinessCache() || {};

  // Bill # = last 8 chars of the session id, mirroring the mobile receipt,
  // so a bill printed from the app and one from the dashboard carry the SAME
  // number for the same table-night. KOT numbers stay kitchen-internal.
  const sessId = String(session.id || '');
  const billNo = (sessId.length >= 8 ? sessId.slice(-8) : sessId).toUpperCase();

  // Totals come from the backend (already summed across non-cancelled
  // orders) — we never recompute money client-side, matching the mobile
  // printer which also trusts subtotal/tax/discount/total off the session.
  const subtotal = session.subtotalInr || 0;
  const tax = session.taxInr || 0;
  const discount = session.discountInr || 0;
  const total = session.totalInr || 0;

  const itemRows = mergedLines
    .map(
      (l) => `
      <tr>
        <td>${escHtml(l.qty)}&times; ${escHtml(l.name)}</td>
        <td class="amt">${escHtml(formatINR(l.lineTotal))}</td>
      </tr>`
    )
    .join('');

  const customerLine = [session.customerName, session.customerPhone]
    .filter((v: any) => v)
    .join(' · ');

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Bill #${escHtml(billNo)} · Table ${escHtml(session.tableLabel || '')}</title>
<style>
  /* 80mm thermal-roll look: narrow column, dashed rules, mono digits. */
  @page { size: 80mm auto; margin: 4mm; }
  body {
    font-family: ui-monospace, 'Courier New', Menlo, monospace;
    width: 72mm; margin: 0 auto; padding: 8px 0;
    color: #000; font-size: 12px; line-height: 1.35;
  }
  .c { text-align: center; }
  .biz { font-size: 16px; font-weight: 800; }
  hr { border: none; border-top: 1px dashed #000; margin: 6px 0; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 2px 0; vertical-align: top; }
  .amt { text-align: right; white-space: nowrap; }
  .tot td { font-weight: 800; font-size: 14px; border-top: 1px solid #000; padding-top: 4px; }
  .noprint { text-align: center; margin-top: 14px; }
  .noprint button {
    padding: 8px 18px; font-weight: 700; cursor: pointer;
    border: 1px solid #000; background: #fff; border-radius: 4px;
  }
  @media print { .noprint { display: none; } body { padding: 0; } }
</style>
</head>
<body>
  <div class="c biz">${escHtml(biz.name || 'NamastePOS')}</div>
  ${biz.address ? `<div class="c">${escHtml(biz.address)}</div>` : ''}
  ${biz.phone ? `<div class="c">Ph: ${escHtml(biz.phone)}</div>` : ''}
  ${biz.gstin ? `<div class="c">GSTIN: ${escHtml(biz.gstin)}</div>` : ''}
  <hr />
  <div class="c" style="font-weight:800">TAX INVOICE</div>
  <div class="c">Bill #${escHtml(billNo)}</div>
  ${session.tableLabel ? `<div class="c">Table ${escHtml(session.tableLabel)}</div>` : ''}
  ${session.guestCount ? `<div class="c">Guests: ${escHtml(session.guestCount)}</div>` : ''}
  <div class="c">${escHtml(formatDateTime(session.closedAt || session.openedAt))}</div>
  ${customerLine ? `<div class="c">${escHtml(customerLine)}</div>` : ''}
  <hr />
  <table>${itemRows}</table>
  <hr />
  <table>
    <tr><td>Subtotal</td><td class="amt">${escHtml(formatINR(subtotal))}</td></tr>
    ${discount > 0 ? `<tr><td>Discount</td><td class="amt">-${escHtml(formatINR(discount))}</td></tr>` : ''}
    ${tax > 0 ? `<tr><td>GST</td><td class="amt">+${escHtml(formatINR(tax))}</td></tr>` : ''}
    <tr class="tot"><td>TOTAL</td><td class="amt">${escHtml(formatINR(total))}</td></tr>
  </table>
  <hr />
  <div class="c">Thank you, visit again!</div>
  <div class="noprint">
    <!-- Fallback for browsers where the auto-print below gets swallowed
         (e.g. popup focus quirks) — the cashier can always re-trigger. -->
    <button onclick="window.print()">Print / Save as PDF</button>
  </div>
</body>
</html>`;

  // Popup (not a hidden iframe) so the receipt stays open after printing —
  // cashiers often re-print or save the PDF a second time.
  const w = window.open('', '_blank', 'width=420,height=640');
  if (!w) {
    toast.error('Popup blocked — allow popups for this site to print the bill');
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
  // document.write is synchronous, so the DOM is ready here; focus first so
  // the print dialog attaches to the popup, not the dashboard tab.
  w.focus();
  w.print();
}

function SessionDialog({ sessionId, onClose, onClosed }: any) {
  const qc = useQueryClient();
  const { data: session } = useQuery({
    queryKey: ['session', sessionId],
    queryFn: () => ffApi.sessionDetail(sessionId),
    refetchInterval: 5000, // keep the running bill fresh
  });
  const [addingItems, setAddingItems] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'upi' | 'card'>('cash');
  // Toggle between "Items" (default — the cashier's view of what's been
  // eaten so far) and "KOTs" (the kitchen-side history of orders).
  const [viewMode, setViewMode] = useState<'items' | 'kots'>('items');

  const close = useMutation({
    mutationFn: () => ffApi.closeSession(sessionId, paymentMethod),
    onSuccess: () => {
      toast.success(`Bill settled — paid by ${paymentMethod.toUpperCase()}`);
      qc.invalidateQueries({ queryKey: ['ops-tables'] });
      onClosed();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  // Push 22 — release without billing. Only valid when no orders are
  // attached; backend refuses otherwise.
  const abandon = useMutation({
    mutationFn: () => ffApi.abandonSession(sessionId),
    onSuccess: () => {
      toast.success('Table released');
      qc.invalidateQueries({ queryKey: ['ops-tables'] });
      onClosed();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const onAbandonClick = () => {
    if (!window.confirm(
      'Release this table? The session will close and the table goes back to Available. ' +
      'No bill will be raised.'
    )) return;
    abandon.mutate();
  };

  if (!session) return null;

  const items = session.items || [];
  const orders = session.orders || [];

  // Group identical lines together so "2× Paneer Tikka" from KOT 1 +
  // "1× Paneer Tikka" from KOT 2 collapse into one line ("3× Paneer Tikka").
  const grouped = (() => {
    const m = new Map<string, any>();
    for (const it of items) {
      const key = `${it.menuItemId || it.name}|${it.price}`;
      const existing = m.get(key);
      if (existing) {
        existing.qty += it.qty;
        existing.lineTotal += it.lineTotal;
        existing.kots.add(it.orderNo);
      } else {
        m.set(key, { ...it, kots: new Set([it.orderNo]) });
      }
    }
    return Array.from(m.values());
  })();

  return (
    <>
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-w-xl w-[95vw] max-h-[92vh] overflow-hidden flex flex-col p-0">
          <DialogHeader className="px-5 py-3 border-b">
            <DialogTitle className="flex items-center justify-between gap-2">
              <span>Table {session.tableLabel} · Running bill</span>
              <Badge variant="warning" className="text-[10px]">OPEN</Badge>
            </DialogTitle>
          </DialogHeader>

          <div className="overflow-y-auto flex-1 px-5 py-4 space-y-3 text-sm">
            {/* Session meta */}
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div className="rounded bg-muted p-2">
                <div className="text-muted-foreground">Opened</div>
                <div className="font-medium">{formatDateTime(session.openedAt)}</div>
              </div>
              <div className="rounded bg-muted p-2">
                <div className="text-muted-foreground">Guests</div>
                <div className="font-medium">{session.guestCount}</div>
              </div>
              <div className="rounded bg-muted p-2">
                <div className="text-muted-foreground">KOTs sent</div>
                <div className="font-medium">{orders.length}</div>
              </div>
            </div>
            {session.customerPhone && (
              <div className="text-xs">📞 {session.customerPhone}{session.customerName ? ` · ${session.customerName}` : ''}</div>
            )}
            {session.notes && <div className="text-xs italic text-muted-foreground">"{session.notes}"</div>}

            {/* View toggle */}
            <div className="flex gap-1 border-b">
              {(['items', 'kots'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setViewMode(m)}
                  className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                    viewMode === m
                      ? 'border-primary text-primary'
                      : 'border-transparent text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {m === 'items'
                    ? `Items eaten (${grouped.length})`
                    : `KOT history (${orders.length})`}
                </button>
              ))}
            </div>

            {/* ITEMS VIEW — flat list of every dish across every KOT */}
            {viewMode === 'items' && (
              <>
                {grouped.length === 0 ? (
                  <div className="text-center text-muted-foreground py-8 text-sm">
                    No items yet. Tap <strong>Add items</strong> below to send the first KOT.
                  </div>
                ) : (
                  <div className="rounded-lg border bg-card divide-y">
                    {grouped.map((it: any, i: number) => (
                      <div key={i} className="px-3 py-2 flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="font-medium truncate">{it.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {it.qty} × {formatINR(it.price)}
                            {it.kots.size > 1 && (
                              <span className="ml-2 opacity-70">
                                · KOTs #{[...it.kots].join(', #')}
                              </span>
                            )}
                          </div>
                          {it.note && (
                            <div className="text-[11px] italic text-muted-foreground mt-0.5">
                              "{it.note}"
                            </div>
                          )}
                        </div>
                        <div className="font-semibold text-right whitespace-nowrap">
                          {formatINR(it.lineTotal)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {/* KOTS VIEW — history of orders that went to the kitchen */}
            {viewMode === 'kots' && (
              <div className="rounded-lg border bg-card divide-y">
                {orders.length === 0 && (
                  <div className="px-3 py-6 text-center text-muted-foreground text-sm">
                    No KOTs sent yet.
                  </div>
                )}
                {orders.map((o: any) => (
                  <div key={o.id} className="px-3 py-2 flex items-center justify-between gap-2">
                    <div>
                      <div className="font-medium">
                        KOT #{o.orderNo}
                        <span className="ml-2 text-xs text-muted-foreground capitalize">· {o.status}</span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {formatDateTime(o.createdAt)} · {o.itemCount} item{o.itemCount === 1 ? '' : 's'}
                        {o.paymentMethod && ` · ${o.paymentMethod}`}
                      </div>
                    </div>
                    <div className="font-semibold">{formatINR(o.total)}</div>
                  </div>
                ))}
              </div>
            )}

            {/* Bill totals */}
            <div className="rounded-lg bg-muted/40 p-3 space-y-1 text-sm">
              <div className="flex justify-between">
                <span>Subtotal</span><span>{formatINR(session.subtotalInr || 0)}</span>
              </div>
              {(session.taxInr || 0) > 0 && (
                <div className="flex justify-between text-muted-foreground">
                  <span>Tax</span><span>+ {formatINR(session.taxInr)}</span>
                </div>
              )}
              {(session.discountInr || 0) > 0 && (
                <div className="flex justify-between text-emerald-700">
                  <span>Discount</span><span>− {formatINR(session.discountInr)}</span>
                </div>
              )}
              <div className="flex justify-between font-bold text-lg border-t pt-2 mt-1">
                <span>Total due</span><span>{formatINR(session.totalInr)}</span>
              </div>
            </div>

            {/* Payment method picker, only when there's something to settle */}
            {orders.length > 0 && (
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                  Settle payment with
                </div>
                <div className="grid grid-cols-3 gap-1">
                  {(['cash', 'upi', 'card'] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => setPaymentMethod(m)}
                      className={`h-9 rounded-md border text-xs font-semibold capitalize transition-colors ${
                        paymentMethod === m
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-input hover:bg-accent'
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="px-5 py-3 border-t flex-wrap gap-2">
            <Button variant="ghost" onClick={onClose}>Close</Button>
            {orders.length === 0 && (
              <Button
                variant="outline"
                className="text-destructive border-destructive/40 hover:bg-destructive/5"
                onClick={onAbandonClick}
                disabled={abandon.isPending}
              >
                {abandon.isPending ? 'Releasing…' : 'Release table'}
              </Button>
            )}
            <Button variant="outline" onClick={() => setAddingItems(true)}>
              <Plus className="mr-1 h-4 w-4" /> Add items
            </Button>
            {/* Gap B — one consolidated bill for the whole session (all KOTs
                merged), same as the mobile Bluetooth receipt. Reuses the
                `grouped` lines already shown in the Items tab so what the
                cashier sees on screen is exactly what prints. Disabled until
                a KOT exists — an empty bill helps nobody. */}
            <Button
              variant="outline"
              onClick={() => printSessionBill(session, grouped)}
              disabled={orders.length === 0}
            >
              <Printer className="mr-1 h-4 w-4" /> Print bill
            </Button>
            <Button
              variant="outline"
              onClick={() => setSplitting(true)}
              disabled={orders.length === 0 || !session.totalInr}
            >
              <Users className="mr-1 h-4 w-4" /> Split bill
            </Button>
            <Button
              onClick={() => close.mutate()}
              disabled={close.isPending || orders.length === 0}
            >
              {close.isPending ? '…' : `Settle ${formatINR(session.totalInr)}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {addingItems && (
        <NewOrderDialog
          onClose={() => {
            setAddingItems(false);
            qc.invalidateQueries({ queryKey: ['session', sessionId] });
            qc.invalidateQueries({ queryKey: ['ops-tables'] });
          }}
          existingSession={{
            id: session.id,
            tableId: session.tableId,
            tableLabel: session.tableLabel,
            customerPhone: session.customerPhone,
            customerName: session.customerName,
          }}
          // Pass the already-eaten items so the cashier sees the running
          // bill side-by-side while picking the next round.
          previousItems={grouped.map((g: any) => ({
            name: g.name, qty: g.qty, price: g.price, lineTotal: g.lineTotal,
          }))}
          previousSubtotalInr={session.subtotalInr || session.totalInr || 0}
        />
      )}
      {splitting && (
        <BillSplitDialog
          sessionId={session.id}
          totalInr={session.totalInr || 0}
          onClose={() => {
            setSplitting(false);
            qc.invalidateQueries({ queryKey: ['session', sessionId] });
            qc.invalidateQueries({ queryKey: ['ops-tables'] });
          }}
        />
      )}
    </>
  );
}
