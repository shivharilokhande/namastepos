import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  LayoutGrid, Plus, Edit2, Trash2, Users, ArrowRight, X, Building, Move, Check, Printer,
  Link2, Unlink, BadgeCheck,
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
import { api, apiError, getBusinessCache } from '@/api/client';
import { formatINR, formatDateTime } from '@/lib/utils';

// ── Joined tables API (2026-08-25, founder request) ─────────────────────
// One big party across several physical tables shares ONE session/bill.
// Called via the shared axios client directly (kept local to this page —
// TablesPage is the only consumer of the join/unjoin endpoints).
function joinTableApi(sessionId: string, tableId: string) {
  const b = getBusinessCache();
  return api
    .post(`/businesses/${b.id}/ops/sessions/${sessionId}/join-table`, { tableId })
    .then((r) => r.data.session);
}
function unjoinTableApi(sessionId: string, tableId: string) {
  const b = getBusinessCache();
  return api
    .post(`/businesses/${b.id}/ops/sessions/${sessionId}/unjoin-table`, { tableId })
    .then((r) => r.data.session);
}

// ── Split settle + shortfall (2026-08-25, founder) ──────────────────────
// ffApi.closeSession only carries paymentMethod; the settle rework needs
// the full close body (paymentBreakdown legs + shortfallInr), so the raw
// endpoint is called locally — same pattern as join/unjoin above.
function closeSessionApi(
  sessionId: string,
  body: { paymentMethod: string; paymentBreakdown?: { method: string; amountInr: number }[]; shortfallInr?: number },
) {
  const b = getBusinessCache();
  return api
    .post(`/businesses/${b.id}/ops/sessions/${sessionId}/close`, body)
    .then((r) => r.data.session);
}
// Wallet read: {balanceInr, transactions}. Shown beside the 'wallet' tender
// option; a 402 (loyalty addon missing) hides the option via the query's
// error state instead of surfacing an error toast at settle time.
function customerWalletApi(customerId: string) {
  const b = getBusinessCache();
  return api
    .get(`/businesses/${b.id}/customers/${customerId}/wallet`)
    .then((r) => r.data as { balanceInr: number; transactions: any[] });
}

// One split-payment leg. Amount stays a STRING while typing (clearable
// input); parsed only for math + submit.
type SettleLeg = {
  method: 'cash' | 'upi' | 'card' | 'online' | 'wallet';
  amountInr: string;
};
const SETTLE_METHODS = ['cash', 'upi', 'card', 'online'] as const;

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

  // Joined tables (2026-08-25): every member of a joined group — the primary
  // (has sessionJoinedTableIds) and the secondaries (isJoinedSecondary) —
  // gets a small link marker on its floor-plan chip. FloorCanvas renders the
  // label verbatim, so the marker rides along on the label string; tapping
  // any member still resolves to the SAME session via currentSessionId.
  const canvasTables = visibleTables.map((t: any) =>
    t.isJoinedSecondary || (t.sessionJoinedTableIds?.length > 0)
      ? { ...t, label: `${t.label} 🔗` }
      : t
  );

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
          tables={canvasTables}
          editMode={layoutEdit}
          onTableTap={(t: any) => {
            if (t.status === 'available') setSeating(t);
            else if (t.currentSessionId) setViewing({ tableId: t.id, sessionId: t.currentSessionId });
          }}
          // Resolve back to the ORIGINAL row — canvasTables may carry the
          // join marker inside `label`, which must never prefill the edit
          // dialog or get saved back as the table's real label.
          onEdit={(t: any) => setEditingTable(visibleTables.find((x: any) => x.id === t.id) || t)}
          onDelete={(canvasT: any) => {
            const t = visibleTables.find((x: any) => x.id === canvasT.id) || canvasT;
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

// Clamp to the backend's Joi bounds (1..50) so the cashier can't submit a
// value the API would 400 on — typing stays free, the number just snaps.
const clampGuests = (n: number) => Math.max(1, Math.min(50, Math.round(n) || 1));

function SeatingDialog({ table, onClose, onSeated }: any) {
  // Guest count defaults to 2 (founder, 2026-08-25: "always shows 2 — should
  // have option to put guest numbers"). The backend always ACCEPTED
  // guestCount; the dashboard just has to actually send what's typed here.
  const [f, setF] = useState({ guestCount: 2, customerPhone: '', customerName: '', notes: '' });
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  // Joined tables (2026-08-25): a big party can grab extra free tables
  // UPFRONT — all of them share the one session/bill opened below.
  const [extraTableIds, setExtraTableIds] = useState<string[]>([]);
  const { data: allTables = [] } = useQuery({
    queryKey: ['ops-tables'], queryFn: () => ffApi.listOpsTables(),
  });
  const freeTables = allTables.filter(
    (t: any) => t.status === 'available' && t.id !== table.id
  );
  const toggleExtra = (id: string) =>
    setExtraTableIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );

  const seat = useMutation({
    mutationFn: async () => {
      // Open the session on the tapped table first, then join the extras.
      // Joins are separate calls (POST sessions/:id/join-table) so a single
      // stolen table doesn't roll back the whole seating — the captain gets
      // a toast per failed join and the party is still seated.
      const session = await ffApi.openSession(table.id, {
        ...f, guestCount: clampGuests(f.guestCount),
      });
      for (const id of extraTableIds) {
        try {
          await joinTableApi(session.id, id);
        } catch (e) {
          const lbl = freeTables.find((t: any) => t.id === id)?.label || '';
          toast.error(`Could not join table ${lbl}: ${apiError(e)}`);
        }
      }
      return session;
    },
    onSuccess: () => { toast.success('Table seated'); onSeated(); },
    onError: (e) => toast.error(apiError(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Seat table {table.label}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Guest count</Label>
            <Input
              type="number" min={1} max={50} value={f.guestCount}
              onChange={(e) => set('guestCount', clampGuests(+e.target.value))}
            />
          </div>
          <div><Label>Customer phone (optional)</Label><Input value={f.customerPhone} onChange={(e) => set('customerPhone', e.target.value)} placeholder="9876543210" /></div>
          <div><Label>Customer name (optional)</Label><Input value={f.customerName} onChange={(e) => set('customerName', e.target.value)} /></div>
          <div><Label>Notes (optional)</Label><Input value={f.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Birthday party, allergic to peanuts…" /></div>
          {freeTables.length > 0 && (
            <div>
              <Label className="flex items-center gap-1">
                <Link2 className="h-3.5 w-3.5" /> Join more tables (big group)
              </Label>
              <p className="text-[11px] text-muted-foreground mb-1.5">
                Selected tables share ONE bill with {table.label}. Tap any of them later to open the same session.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {freeTables.map((t: any) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => toggleExtra(t.id)}
                    className={`px-3 h-8 rounded-md border text-xs font-semibold transition-colors ${
                      extraTableIds.includes(t.id)
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-input hover:bg-accent'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => seat.mutate()} disabled={seat.isPending}>
            {seat.isPending
              ? 'Seating…'
              : extraTableIds.length > 0
                ? `Seat guests (${extraTableIds.length + 1} tables)`
                : 'Seat guests'}
          </Button>
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

  // ── Split settle + shortfall state (2026-08-25, founder) ──────────────
  // Split off = single-method flow untouched. Shortfall = customer paid
  // less than the bill; the gap books as a NEGATIVE wallet movement (debt)
  // on the identified customer — server refuses without one.
  const [splitOn, setSplitOn] = useState(false);
  const [settleLegs, setSettleLegs] = useState<SettleLeg[]>([
    { method: 'cash', amountInr: '' }, { method: 'upi', amountInr: '' },
  ]);
  const [shortfallOpen, setShortfallOpen] = useState(false);
  const [shortfallInput, setShortfallInput] = useState(0);

  // Resolve the session's customer → id (customer-history lookup, the same
  // endpoint NewOrderDialog uses) → wallet balance for the wallet tender.
  const custPhone: string | undefined = session?.customerPhone || undefined;
  const { data: custProfile } = useQuery({
    queryKey: ['cust-profile', custPhone],
    queryFn: () => ffApi.customerProfile(custPhone!),
    enabled: !!custPhone,
    retry: false,
  });
  const custId: string | undefined = custProfile?.customer?.id;
  const { data: walletInfo, isError: walletError } = useQuery({
    queryKey: ['cust-wallet', custId],
    queryFn: () => customerWalletApi(custId!),
    enabled: !!custId,
    retry: false,
  });
  const walletBalance: number = walletInfo?.balanceInr ?? 0;
  const walletAvailable = !!custId && !!walletInfo && !walletError;

  // A hidden wallet option must never stay selected (server would 400 on
  // settle) — fall those legs back to cash if the wallet disappears.
  useEffect(() => {
    if (!walletAvailable) {
      setSettleLegs((ls) => ls.some((l) => l.method === 'wallet')
        ? ls.map((l) => (l.method === 'wallet' ? { ...l, method: 'cash' as const } : l))
        : ls);
    }
  }, [walletAvailable]);

  const setSettleLeg = (i: number, patch: Partial<SettleLeg>) =>
    setSettleLegs((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const close = useMutation({
    mutationFn: () => {
      // 2026-08-25: full close body. Legs must sum to (session total −
      // shortfall) ±₹0.01 — validated client-side below before the button
      // enables, and again server-side inside the settle txn.
      const body: any = { paymentMethod };
      if (shortfallOpen && shortfallInput > 0) body.shortfallInr = shortfallInput;
      if (splitOn) {
        body.paymentBreakdown = settleLegs.map((l) => ({
          method: l.method,
          amountInr: +(parseFloat(l.amountInr) || 0).toFixed(2),
        }));
      }
      return closeSessionApi(sessionId, body);
    },
    onSuccess: () => {
      toast.success(splitOn
        ? 'Bill settled — split payment recorded'
        : `Bill settled — paid by ${paymentMethod.toUpperCase()}`);
      qc.invalidateQueries({ queryKey: ['ops-tables'] });
      qc.invalidateQueries({ queryKey: ['cust-wallet'] });
      onClosed();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  // Joined tables (2026-08-25) — attach/detach extra free tables to THIS
  // running session. Every joined table flips to occupied and taps back
  // into this same dialog; settle/release frees the whole group at once.
  const [showJoinPicker, setShowJoinPicker] = useState(false);
  const { data: allTables = [] } = useQuery({
    queryKey: ['ops-tables'], queryFn: () => ffApi.listOpsTables(),
  });
  const join = useMutation({
    mutationFn: (tableId: string) => joinTableApi(sessionId, tableId),
    onSuccess: () => {
      toast.success('Table joined — one bill for the whole group');
      setShowJoinPicker(false);
      qc.invalidateQueries({ queryKey: ['session', sessionId] });
      qc.invalidateQueries({ queryKey: ['ops-tables'] });
    },
    onError: (e) => toast.error(apiError(e)),
  });
  const unjoin = useMutation({
    mutationFn: (tableId: string) => unjoinTableApi(sessionId, tableId),
    onSuccess: () => {
      toast.success('Table unjoined and freed');
      qc.invalidateQueries({ queryKey: ['session', sessionId] });
      qc.invalidateQueries({ queryKey: ['ops-tables'] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  // Paid-early release (2026-08-25, founder): every KOT was paid at order
  // time ("Pay & place") yet the table stays occupied because nobody hits
  // Settle — there is nothing left to collect. This closes the session via
  // the SAME settle endpoint, passing the HEAD order's payment method so
  // reporting stays truthful. No double charge: closeSession only flips
  // payment_method on orders still marked 'unpaid' (there are none here)
  // and re-marking collected is idempotent.
  const releasePaid = useMutation({
    mutationFn: () => {
      const active = (session?.orders || []).filter((o: any) => o.status !== 'cancelled');
      const headPm = active[0]?.paymentMethod;
      const pm = ['cash', 'upi', 'card', 'online'].includes(headPm) ? headPm : 'cash';
      return ffApi.closeSession(sessionId, pm);
    },
    onSuccess: () => {
      toast.success('Table released — bill was already paid');
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
  const joinedTables = session.joinedTables || [];
  const freeTables = allTables.filter((t: any) => t.status === 'available');

  // ── Settle math (2026-08-25, founder) ─────────────────────────────────
  // Shortfall is clamped to the bill so the due can't go negative; the
  // split legs must then cover exactly what's actually PAID (total − short).
  const sessionTotal = Number(session.totalInr) || 0;
  const shortfall = shortfallOpen
    ? Math.min(Math.max(0, Number(shortfallInput) || 0), sessionTotal)
    : 0;
  const totalDue = Math.max(0, +(sessionTotal - shortfall).toFixed(2));
  const legSum = settleLegs.reduce((s, l) => s + (parseFloat(l.amountInr) || 0), 0);
  const settleRemaining = +(totalDue - legSum).toFixed(2);
  const walletLegInr = settleLegs
    .filter((l) => l.method === 'wallet')
    .reduce((s, l) => s + (parseFloat(l.amountInr) || 0), 0);
  // Client-side mirror of the server's insufficient-wallet 400.
  const walletOver = walletLegInr > walletBalance + 0.001;
  // Backend: 1-3 POSITIVE legs summing to the due within ±₹0.01.
  const splitValid =
    Math.abs(settleRemaining) <= 0.01 && !walletOver &&
    settleLegs.every((l) => (parseFloat(l.amountInr) || 0) > 0);
  // Shortfall books a wallet DEBT — server refuses without an identified
  // customer on the session's orders; custId is the client-side proxy.
  const shortfallBlocked = shortfall > 0 && !custId;

  // Paid upfront = at least one live KOT and EVERY one already carries a
  // real payment method (the "Pay & place" flow). Only then does the
  // "Release table (already paid)" shortcut make sense.
  const activeOrders = orders.filter((o: any) => o.status !== 'cancelled');
  const allPaidUpfront =
    activeOrders.length > 0 &&
    activeOrders.every((o: any) => o.paymentMethod && o.paymentMethod !== 'unpaid');

  const onReleasePaidClick = () => {
    if (!window.confirm(
      'Release this table? All orders in this session are already paid, so ' +
      'nothing more will be charged — the session closes and ' +
      (joinedTables.length > 0
        ? 'the tables (including joined ones) go back to Available.'
        : 'the table goes back to Available.')
    )) return;
    releasePaid.mutate();
  };

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
              <span>
                Table {session.tableLabel}
                {joinedTables.length > 0 &&
                  ` + ${joinedTables.map((jt: any) => jt.label).join(', ')}`}
                {' '}· Running bill
              </span>
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

            {/* Joined tables (2026-08-25) — the whole group shares this one
                bill. Unjoin frees just that table; Settle/Release frees all. */}
            <div className="rounded-lg border border-dashed px-3 py-2 space-y-2">
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
                {joinedTables.length > 0 ? (
                  <>
                    <span className="text-muted-foreground">Joined:</span>
                    {joinedTables.map((jt: any) => (
                      <span
                        key={jt.id}
                        className="inline-flex items-center gap-1 rounded-md border bg-muted px-2 py-0.5 font-semibold"
                      >
                        {jt.label}
                        <button
                          title={`Unjoin table ${jt.label}`}
                          onClick={() => unjoin.mutate(jt.id)}
                          disabled={unjoin.isPending}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <Unlink className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </>
                ) : (
                  <span className="text-muted-foreground">
                    Big group? Join a nearby free table onto this bill.
                  </span>
                )}
                <button
                  onClick={() => setShowJoinPicker((v) => !v)}
                  className="ml-auto text-primary font-semibold hover:underline"
                >
                  {showJoinPicker ? 'Hide' : '+ Join another table'}
                </button>
              </div>
              {showJoinPicker && (
                freeTables.length === 0 ? (
                  <div className="text-xs text-muted-foreground">No free tables right now.</div>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {freeTables.map((t: any) => (
                      <button
                        key={t.id}
                        onClick={() => join.mutate(t.id)}
                        disabled={join.isPending}
                        className="px-3 h-8 rounded-md border border-input text-xs font-semibold hover:bg-accent transition-colors"
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                )
              )}
            </div>

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
                {orders.map((o: any) => {
                  // Paid-early (2026-08-25): make it obvious per-KOT whether
                  // money was already taken (Pay & place) or is still due at
                  // settle — cashiers were re-charging paid tables.
                  const paid = !!o.paymentMethod && o.paymentMethod !== 'unpaid';
                  return (
                    <div key={o.id} className="px-3 py-2 flex items-center justify-between gap-2">
                      <div>
                        <div className="font-medium flex items-center gap-2">
                          KOT #{o.orderNo}
                          <span className="text-xs text-muted-foreground capitalize">· {o.status}</span>
                          {o.status !== 'cancelled' && (
                            <span
                              className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                                paid
                                  ? 'bg-emerald-100 text-emerald-700'
                                  : 'bg-amber-100 text-amber-800'
                              }`}
                            >
                              {paid ? `Paid · ${o.paymentMethod}` : 'Unpaid'}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {formatDateTime(o.createdAt)} · {o.itemCount} item{o.itemCount === 1 ? '' : 's'}
                        </div>
                      </div>
                      <div className="font-semibold">{formatINR(o.total)}</div>
                    </div>
                  );
                })}
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
                <div className="flex items-center justify-between mb-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Settle payment with
                  </div>
                  {/* Split payments on settle (2026-08-25, founder) */}
                  <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                    <input type="checkbox" checked={splitOn}
                      onChange={(e) => setSplitOn(e.target.checked)} />
                    Split payment
                  </label>
                </div>
                {!splitOn ? (
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
                ) : (
                  <div className="space-y-1.5">
                    {settleLegs.map((leg, i) => (
                      <div key={i} className="flex items-center gap-1.5">
                        <select value={leg.method}
                          onChange={(e) => setSettleLeg(i, { method: e.target.value as SettleLeg['method'] })}
                          className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-xs capitalize">
                          {SETTLE_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                          {/* Wallet only for an identified customer — the
                              live balance rides on the option label. */}
                          {walletAvailable && (
                            <option value="wallet">wallet — {formatINR(walletBalance)}</option>
                          )}
                        </select>
                        <Input type="number" min={0} placeholder="0" value={leg.amountInr}
                          onChange={(e) => setSettleLeg(i, { amountInr: e.target.value })}
                          className="h-8 w-24 text-xs" />
                        {settleLegs.length > 2 && (
                          <button onClick={() => setSettleLegs((ls) => ls.filter((_, j) => j !== i))}
                            className="p-1 hover:bg-accent rounded" title="Remove leg">
                            <Trash2 className="h-3 w-3 text-muted-foreground" />
                          </button>
                        )}
                      </div>
                    ))}
                    {/* Backend caps the breakdown at 3 legs */}
                    {settleLegs.length < 3 && (
                      <button onClick={() => setSettleLegs((ls) => [...ls, { method: 'cash', amountInr: '' }])}
                        className="text-xs text-primary font-semibold hover:underline">
                        + Add payment method
                      </button>
                    )}
                    <div className={`text-xs font-medium ${
                      Math.abs(settleRemaining) <= 0.01 ? 'text-emerald-700' : 'text-amber-700'
                    }`}>
                      {Math.abs(settleRemaining) <= 0.01
                        ? '✓ Fully covered'
                        : settleRemaining > 0
                          ? `${formatINR(settleRemaining)} remaining`
                          : `${formatINR(-settleRemaining)} over`}
                    </div>
                    {walletOver && (
                      <div className="text-xs text-destructive">
                        Wallet has only {formatINR(walletBalance)} — reduce the wallet amount.
                      </div>
                    )}
                  </div>
                )}

                {/* Shortfall (2026-08-25, founder): customer can't pay the
                    full bill — the gap becomes a wallet debt so it's
                    recoverable on the next visit instead of silent leakage. */}
                <div className="mt-3 border-t pt-2">
                  <button
                    onClick={() => setShortfallOpen((v) => !v)}
                    className="text-xs text-primary font-semibold hover:underline"
                  >
                    {shortfallOpen ? 'Hide shortfall' : 'Customer short on payment?'}
                  </button>
                  {shortfallOpen && (
                    !custId ? (
                      <p className="mt-1.5 text-xs text-muted-foreground">
                        Shortfall is booked as due on the customer's wallet — this
                        session has no identified customer. Attach a customer phone
                        (via Add items) first.
                      </p>
                    ) : (
                      <div className="mt-1.5 space-y-1.5">
                        <Label className="text-xs">Shortfall (₹)</Label>
                        <Input type="number" min={0} max={sessionTotal} value={shortfallInput}
                          onChange={(e) => setShortfallInput(
                            Math.min(Math.max(0, +e.target.value || 0), sessionTotal))}
                          className="h-8" />
                        {shortfall > 0 && (
                          <div className="text-xs text-amber-700">
                            {formatINR(shortfall)} will be added as due on{' '}
                            <strong>{session.customerName || session.customerPhone}</strong>'s wallet.
                            Collect {formatINR(totalDue)} now.
                          </div>
                        )}
                      </div>
                    )
                  )}
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
            {/* Paid-early release (2026-08-25) — every KOT already paid at
                order time; close the session without collecting again. */}
            {allPaidUpfront && (
              <Button
                variant="outline"
                className="text-emerald-700 border-emerald-300 hover:bg-emerald-50"
                onClick={onReleasePaidClick}
                disabled={releasePaid.isPending}
              >
                <BadgeCheck className="mr-1 h-4 w-4" />
                {releasePaid.isPending ? 'Releasing…' : 'Release table (already paid)'}
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
            {/* 2026-08-25: split mode gates Settle until the legs balance;
                a shortfall without an identified customer is blocked (the
                server would refuse the wallet debt anyway). */}
            <Button
              onClick={() => close.mutate()}
              disabled={close.isPending || orders.length === 0
                || (splitOn && !splitValid) || shortfallBlocked}
            >
              {close.isPending ? '…' : `Settle ${formatINR(totalDue)}`}
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
