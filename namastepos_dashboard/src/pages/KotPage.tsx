import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, ChefHat, Edit2, Trash2, Settings as SettingsIcon, Play, Check, X, History, Search } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { DateInput } from '@/components/ui/date-input';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { ffApi } from '@/api/namastepos';
import { apiError } from '@/api/client';
import { formatDateTime } from '@/lib/utils';

export function KotPage() {
  const [tab, setTab] = useState<'live' | 'stations' | 'history'>('live');
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <ChefHat className="h-6 w-6 text-primary" /> Kitchen Order Tickets
        </h1>
        <p className="text-muted-foreground">
          Route items to kitchen stations (Tandoor, Cold Counter, Bar…) with their own printers.
        </p>
      </div>
      <div className="flex gap-2 border-b">
        <button onClick={() => setTab('live')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === 'live' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground'
          }`}>Live tickets</button>
        <button onClick={() => setTab('stations')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === 'stations' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground'
          }`}>Stations</button>
        <button onClick={() => setTab('history')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            tab === 'history' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground'
          }`}>History</button>
      </div>
      {tab === 'live' && <LiveTickets />}
      {tab === 'stations' && <StationsTab />}
      {tab === 'history' && <HistoryTab />}
    </div>
  );
}

function LiveTickets() {
  const qc = useQueryClient();
  const { data: stations = [] } = useQuery({ queryKey: ['stations'], queryFn: ffApi.listStations });
  const { data: tickets = [] } = useQuery({
    queryKey: ['kot-tickets'], queryFn: () => ffApi.listTickets(),
    refetchInterval: 4000,
  });
  const update = useMutation({
    mutationFn: ({ id, s }: { id: string; s: string }) => ffApi.updateTicketStatus(id, s),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['kot-tickets'] }),
    onError: (e) => toast.error(apiError(e)),
  });

  if (stations.length === 0) {
    return <Card><CardContent className="p-10 text-center text-muted-foreground">
      Add stations first (Tandoor, Cold Counter, Bar…) under the <strong>Stations</strong> tab,
      then assign items to stations from your Menu.
    </CardContent></Card>;
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {stations.map((s: any) => {
        // Bug fix (2026-08-20): the earlier version rendered EVERY ticket
        // for the station (including `done` and `cancelled`), while the
        // header text counted only pending + in_progress. That produced
        // "0 pending · 0 cooking" above four green completed cards. The
        // "Live tickets" tab should show only work in-flight — matching
        // KDS behavior; completed history belongs elsewhere.
        const stationTickets = tickets.filter((t: any) => t.stationId === s.id);
        const pending = stationTickets.filter((t: any) => t.status === 'pending');
        const inProgress = stationTickets.filter((t: any) => t.status === 'in_progress');
        const done = stationTickets.filter((t: any) => t.status === 'done');
        const live = [...pending, ...inProgress];
        return (
          <Card key={s.id} className="flex flex-col">
            <CardHeader>
              <div className="flex items-center gap-2">
                <div className="h-3 w-3 rounded-full" style={{ background: s.color }} />
                <CardTitle>{s.name}</CardTitle>
              </div>
              <div className="text-xs text-muted-foreground">
                {pending.length} pending · {inProgress.length} cooking
                {done.length > 0 && <span className="ml-1">· {done.length} done today</span>}
              </div>
            </CardHeader>
            <CardContent className="space-y-2 flex-1">
              {live.length === 0 && (
                <div className="py-6 text-center text-muted-foreground text-sm">
                  {done.length > 0
                    ? `✅ All clear — ${done.length} ticket${done.length === 1 ? '' : 's'} finished today.`
                    : 'No tickets yet.'}
                </div>
              )}
              {live.map((t: any) => (
                <div key={t.id}
                  className={`p-3 rounded-lg border ${
                    t.status === 'pending' ? 'border-amber-300 bg-amber-50' :
                    t.status === 'in_progress' ? 'border-blue-300 bg-blue-50' :
                    'border-emerald-300 bg-emerald-50/40'
                  }`}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="font-bold">#{t.ticketNo}</div>
                    <div className="flex gap-1 text-xs">
                      <Badge variant="muted">Order #{t.orderNo}</Badge>
                      {t.tableLabel && <Badge variant="muted">T-{t.tableLabel}</Badge>}
                    </div>
                  </div>
                  <ul className="text-sm space-y-0.5 mb-2">
                    {t.items.map((i: any, idx: number) => (
                      <li key={idx}><strong>{i.qty}×</strong> {i.name}{i.note && <span className="text-xs text-muted-foreground"> · {i.note}</span>}</li>
                    ))}
                  </ul>
                  <div className="flex gap-1">
                    {t.status === 'pending' && (
                      <Button size="sm" className="flex-1" onClick={() => update.mutate({ id: t.id, s: 'in_progress' })}>
                        <Play className="mr-1 h-3 w-3" /> Start
                      </Button>
                    )}
                    {t.status === 'in_progress' && (
                      <Button size="sm" className="flex-1" onClick={() => update.mutate({ id: t.id, s: 'done' })}>
                        <Check className="mr-1 h-3 w-3" /> Done
                      </Button>
                    )}
                    {t.status !== 'cancelled' && t.status !== 'done' && (
                      <Button size="sm" variant="ghost" onClick={() => update.mutate({ id: t.id, s: 'cancelled' })}>
                        <X className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

// ── KOT History (Bug #9, 2026-08-25) ────────────────────────────────────
// The Live tab intentionally hides `done`/`cancelled` tickets (2026-08-20
// fix), which left owners with no way to review what the kitchen actually
// produced — the end-of-day ritual every Indian restaurant expects. We
// reuse the existing GET /ops/kot/tickets endpoint: it already supports a
// `day` filter (defaults to today server-side) and its serializer carries
// createdAt/completedAt, so no backend change is needed. We fetch the whole
// day and filter to done/cancelled client-side because the endpoint's
// `status` param accepts only ONE status per request — one call beats two.

interface KotHistoryItem { id: string; name: string; qty: number; note: string | null }
interface KotHistoryTicket {
  id: string;
  ticketNo: number;
  orderNo: number;
  status: 'pending' | 'in_progress' | 'done' | 'cancelled';
  stationName: string | null;
  tableLabel: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  items: KotHistoryItem[];
}

// Local-timezone ISO date (yyyy-mm-dd). toISOString() would shift dates
// for IST users after 5:30 AM UTC rollover — en-CA formats local time as ISO.
function todayISO(): string {
  return new Date().toLocaleDateString('en-CA');
}

// Human prep duration: ticket fired (createdAt) → marked done (completedAt).
// That is the number a kitchen cares about — how long the guest waited on
// the KOT — not just cooking time, so we don't start from startedAt.
function prepTime(t: KotHistoryTicket): string {
  if (!t.completedAt || !t.createdAt) return '—';
  const ms = new Date(t.completedAt).getTime() - new Date(t.createdAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  if (mins >= 60) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function HistoryTab() {
  const [day, setDay] = useState<string>(todayISO());
  const [search, setSearch] = useState('');
  const { data: tickets = [], isLoading, isError, error } = useQuery<KotHistoryTicket[]>({
    queryKey: ['kot-history', day],
    queryFn: () => ffApi.listTickets({ day }),
    // Poll only when watching today — past days can't gain new tickets.
    refetchInterval: day === todayISO() ? 30000 : false,
  });

  // History = tickets that left the live queue. Cancelled ones stay visible
  // (flagged red) so voided KOTs can't silently disappear — an anti-theft
  // expectation in Indian POS (matches the revenue-leakage philosophy).
  const finished = tickets.filter((t) => t.status === 'done' || t.status === 'cancelled');
  const q = search.trim().toLowerCase();
  const visible = finished
    .filter((t) => {
      if (!q) return true;
      // Search by order no, ticket no, table, or any item name.
      return (
        String(t.orderNo).includes(q) ||
        String(t.ticketNo).includes(q) ||
        (t.tableLabel || '').toLowerCase().includes(q) ||
        t.items.some((i) => i.name.toLowerCase().includes(q))
      );
    })
    // Newest-first by when work ended; fall back to createdAt for
    // cancelled tickets that never got a completedAt.
    .sort((a, b) =>
      new Date(b.completedAt || b.createdAt).getTime() -
      new Date(a.completedAt || a.createdAt).getTime());

  const doneCount = finished.filter((t) => t.status === 'done').length;
  const cancelledCount = finished.length - doneCount;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <History className="h-5 w-5 text-primary" /> Completed tickets
            </CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              {doneCount} done{cancelledCount > 0 ? ` · ${cancelledCount} cancelled` : ''} on this day
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="Search item, order or table…" className="pl-9 sm:w-56" />
            </div>
            <DateInput value={day} onChange={(iso) => iso && setDay(iso)} className="sm:w-36" />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isError && (
          <div className="py-10 text-center text-sm text-destructive">{apiError(error)}</div>
        )}
        {!isError && isLoading && (
          <div className="py-10 text-center text-sm text-muted-foreground">Loading history…</div>
        )}
        {!isError && !isLoading && visible.length === 0 && (
          <div className="py-10 text-center text-sm text-muted-foreground">
            {q ? 'No tickets match your search.' : 'No completed tickets on this day.'}
          </div>
        )}
        {!isError && !isLoading && visible.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ticket</TableHead>
                <TableHead>Order</TableHead>
                <TableHead>Table</TableHead>
                <TableHead>Station</TableHead>
                <TableHead>Items</TableHead>
                <TableHead>Completed</TableHead>
                <TableHead>Prep time</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-bold">#{t.ticketNo}</TableCell>
                  <TableCell>#{t.orderNo}</TableCell>
                  <TableCell>{t.tableLabel ? `T-${t.tableLabel}` : '—'}</TableCell>
                  <TableCell>{t.stationName || '—'}</TableCell>
                  <TableCell>
                    <ul className="space-y-0.5">
                      {t.items.map((i) => (
                        <li key={i.id}>
                          <strong>{i.qty}×</strong> {i.name}
                          {i.note && <span className="text-xs text-muted-foreground"> · {i.note}</span>}
                        </li>
                      ))}
                    </ul>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {t.completedAt ? formatDateTime(t.completedAt) : '—'}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{prepTime(t)}</TableCell>
                  <TableCell>
                    {t.status === 'done'
                      ? <Badge variant="success">Done</Badge>
                      : <Badge variant="destructive">Cancelled</Badge>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function StationsTab() {
  const qc = useQueryClient();
  const { data: stations = [] } = useQuery({ queryKey: ['stations'], queryFn: ffApi.listStations });
  const [editing, setEditing] = useState<any | null>(null);
  const remove = useMutation({
    mutationFn: ffApi.deleteStation,
    onSuccess: () => { toast.success('Deleted'); qc.invalidateQueries({ queryKey: ['stations'] }); },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setEditing({})}><Plus className="mr-2 h-4 w-4" /> Add station</Button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {stations.length === 0 && <div className="md:col-span-3 text-center py-10 text-muted-foreground">
          No stations yet. Create your first — e.g., "Tandoor", "Cold Counter", "Bar".
        </div>}
        {stations.map((s: any) => (
          <Card key={s.id}>
            <CardContent className="p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <div className="h-4 w-4 rounded-full" style={{ background: s.color }} />
                  <div className="font-bold">{s.name}</div>
                </div>
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>
                    <Edit2 className="h-4 w-4" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => remove.mutate(s.id)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </div>
              <div className="text-xs space-y-1 text-muted-foreground">
                <div>Printer: <code>{s.printerAddress || 'uses default'}</code></div>
                <div>Paper: {s.printerPaperMm}mm</div>
                {!s.isActive && <Badge variant="muted">Inactive</Badge>}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      {editing && <StationDialog station={editing} onClose={() => setEditing(null)}
        onSaved={() => { qc.invalidateQueries({ queryKey: ['stations'] }); setEditing(null); }} />}
    </div>
  );
}

function StationDialog({ station, onClose, onSaved }: any) {
  const mode = station.id ? 'edit' : 'create';
  const [f, setF] = useState<any>(station.id ? {
    name: station.name, printer_address: station.printerAddress || '',
    printer_paper_mm: station.printerPaperMm, color: station.color,
    is_active: station.isActive, display_order: station.displayOrder,
  } : { name: '', printer_address: '', printer_paper_mm: 58, color: '#FF6B35', is_active: true, display_order: 100 });
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  const save = useMutation({
    mutationFn: () => mode === 'create' ? ffApi.createStation(f) : ffApi.updateStation(station.id, f),
    onSuccess: () => { toast.success('Saved'); onSaved(); },
    onError: (e) => toast.error(apiError(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{mode === 'create' ? 'Add station' : 'Edit station'}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>Name *</Label><Input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Tandoor" /></div>
          <div><Label>Printer Bluetooth MAC (optional)</Label>
            <Input value={f.printer_address} onChange={(e) => set('printer_address', e.target.value)} placeholder="00:11:22:33:44:55" />
            <p className="text-xs text-muted-foreground mt-1">Leave empty to use the default printer.</p>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div><Label>Paper</Label>
              <select value={f.printer_paper_mm} onChange={(e) => set('printer_paper_mm', +e.target.value)}
                      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                <option value={58}>58 mm</option><option value={80}>80 mm</option>
              </select>
            </div>
            <div><Label>Color</Label><Input type="color" value={f.color} onChange={(e) => set('color', e.target.value)} /></div>
            <div><Label>Order</Label><Input type="number" value={f.display_order} onChange={(e) => set('display_order', +e.target.value)} /></div>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={f.is_active} onChange={(e) => set('is_active', e.target.checked)} />
            <span className="text-sm">Active</span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={!f.name || save.isPending}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
