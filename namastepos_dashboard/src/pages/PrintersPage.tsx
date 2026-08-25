// NamastePOS dashboard - Printer setup (GAP C, 2026-08-25).
//
// Web-side management for thermal/network printers. The dashboard only
// stores the printer registry; the actual ESC/POS bytes are produced by
// the Flutter app (Bluetooth) or the namastepos_print_agent polling
// GET /print-jobs/next on the cashier's LAN — a browser cannot open raw
// TCP sockets to a 192.168.x.x printer. The one exception (added
// 2026-08-25) is Web Bluetooth: Chromium can drive a nearby BLE thermal
// printer directly, so this page now also hosts a connect/test-print card
// backed by src/lib/btPrinter.ts.
//
// Endpoint shapes (verified against sprintsAll.routes.js + printerService.js,
// 2026-08-25):
//   GET    /businesses/:id/printers        -> { printers: [row…] }  (snake_case pg rows + station_name join)
//   PUT    /businesses/:id/printers        -> { printer: row }      (camelCase body: id?, name, kind, connection, address, paperWidthMm, stationId, isDefault)
//   DELETE /businesses/:id/printers/:id    -> { success: true }     (soft delete: is_active = FALSE)

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Printer as PrinterIcon, Pencil, Trash2, Info, Star, Bluetooth } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { ffApi } from '@/api/namastepos';
// WHY (2026-08-25): ffApi has listPrinters/upsertPrinter but no deletePrinter,
// and API files are frozen for this change — so DELETE goes through the raw
// axios client with the cached business id, same URL shape the backend expects.
import { api, getBusinessCache, apiError } from '@/api/client';
// Web Bluetooth ESC/POS driver (2026-08-25) — Chromium-only browser printing
// to nearby BLE thermal printers; see btPrinter.ts for the full caveat list.
import {
  isWebBluetoothSupported, connectBtPrinter,
  getSharedBtPrinter, setSharedBtPrinter, type BtPrinter,
} from '@/lib/btPrinter';

// ── Types ─────────────────────────────────────────────────────────────────
// WHY snake_case (2026-08-25): printerService.listPrinters returns raw pg
// rows (SELECT p.*, ks.name AS station_name) with no camelize middleware,
// unlike the camelCase PUT body which is shaped by the Joi schema.
interface PrinterRow {
  id: string;
  name: string;
  kind: 'bill' | 'kot';
  connection: 'bluetooth' | 'wifi' | 'usb' | 'network';
  address: string | null;
  paper_width_mm: 58 | 80;
  station_id: string | null;
  station_name: string | null;
  is_default: boolean;
  is_active: boolean;
}

interface StationRow { id: string; name: string; }

// PUT body is camelCase per the route's Joi schema (sprintsAll.routes.js ~536).
interface PrinterForm {
  id: string | null;
  name: string;
  kind: 'bill' | 'kot';
  connection: 'bluetooth' | 'wifi' | 'usb' | 'network';
  address: string;
  paperWidthMm: 58 | 80;
  stationId: string | null;
  isDefault: boolean;
}

const EMPTY_FORM: PrinterForm = {
  id: null, name: '', kind: 'bill', connection: 'network',
  address: '', paperWidthMm: 80, stationId: null, isDefault: false,
};

const CONNECTION_LABELS: Record<PrinterRow['connection'], string> = {
  network: 'Network (LAN)',
  wifi: 'Wi-Fi',
  bluetooth: 'Bluetooth',
  usb: 'USB',
};

// WHY (2026-08-25): address is only meaningful for IP-reachable printers
// (network/wifi: "192.168.1.50:9100"). Bluetooth pairing happens on the
// phone (see printer_setup_screen.dart) and USB on the agent machine, so
// the field is optional there — mirrors the backend's allow('', null).
const needsAddress = (c: PrinterRow['connection']) => c === 'network' || c === 'wifi';

function rowToForm(p: PrinterRow): PrinterForm {
  return {
    id: p.id, name: p.name, kind: p.kind, connection: p.connection,
    address: p.address ?? '', paperWidthMm: p.paper_width_mm ?? 80,
    stationId: p.station_id, isDefault: p.is_default,
  };
}

export function PrintersPage() {
  const qc = useQueryClient();

  const { data: printers = [], isLoading, isError, error, refetch } = useQuery<PrinterRow[]>({
    queryKey: ['printers'],
    queryFn: ffApi.listPrinters,
  });
  // Stations feed the KOT-routing dropdown; failure here shouldn't block the
  // page, so it's a separate query and the dropdown just shows "(none)".
  const { data: stations = [] } = useQuery<StationRow[]>({
    queryKey: ['stations'],
    queryFn: ffApi.listStations,
  });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<PrinterForm>(EMPTY_FORM);
  const [deleting, setDeleting] = useState<PrinterRow | null>(null);

  // ── Web Bluetooth printer (2026-08-25) ──────────────────────────────────
  // WHY lazy initialiser from the shared singleton: the BLE connection lives
  // at module scope (btPrinter.ts) so it survives SPA navigation — when the
  // owner returns to this page we re-adopt the live handle instead of making
  // them re-pair. getSharedBtPrinter() also self-clears dead links.
  const btSupported = isWebBluetoothSupported();
  const [btPrinter, setBtPrinter] = useState<BtPrinter | null>(() => getSharedBtPrinter());
  const [btConnecting, setBtConnecting] = useState(false);
  const [btTesting, setBtTesting] = useState(false);

  const handleBtConnect = async () => {
    setBtConnecting(true);
    try {
      const p = await connectBtPrinter();
      setSharedBtPrinter(p);
      setBtPrinter(p);
      toast.success(`Connected to ${p.deviceName}`);
    } catch (e) {
      // WHY the NotFoundError filter (2026-08-25): Chromium throws it when
      // the owner simply closes the device chooser — cancelling is not an
      // error, and a red toast for it reads like a broken feature.
      if ((e as DOMException | null)?.name !== 'NotFoundError') {
        toast.error(e instanceof Error ? e.message : 'Could not connect to the printer');
      }
    } finally {
      setBtConnecting(false);
    }
  };

  const handleBtTest = async () => {
    if (!btPrinter) return;
    setBtTesting(true);
    try {
      await btPrinter.printTest();
      toast.success('Test print sent');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Test print failed');
      // Print failures are usually the link dying (printer sleep/out of
      // range) — re-read the singleton so a dead handle drops the green dot.
      setBtPrinter(getSharedBtPrinter());
    } finally {
      setBtTesting(false);
    }
  };

  const handleBtDisconnect = () => {
    setSharedBtPrinter(null); // disconnects the old handle internally
    setBtPrinter(null);
    toast.success('Bluetooth printer disconnected');
  };

  const set = <K extends keyof PrinterForm>(key: K, value: PrinterForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const save = useMutation({
    // WHY trim + null-coalescing (2026-08-25): backend Joi rejects
    // address > 120 chars but happily stores '' — normalising to null keeps
    // the DB clean and the "—" rendering logic simple.
    mutationFn: () => ffApi.upsertPrinter({
      id: form.id,
      name: form.name.trim(),
      kind: form.kind,
      connection: form.connection,
      address: form.address.trim() || null,
      paperWidthMm: form.paperWidthMm,
      // Station routing only applies to KOT printers; a stale stationId on a
      // bill printer would confuse the print agent's job routing (2026-08-25).
      stationId: form.kind === 'kot' ? form.stationId : null,
      isDefault: form.isDefault,
    }),
    onSuccess: () => {
      toast.success(form.id ? 'Printer updated' : 'Printer added');
      qc.invalidateQueries({ queryKey: ['printers'] });
      setDialogOpen(false);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => {
      const b = getBusinessCache();
      return api.delete(`/businesses/${b.id}/printers/${id}`).then((r) => r.data);
    },
    onSuccess: () => {
      toast.success('Printer removed');
      qc.invalidateQueries({ queryKey: ['printers'] });
      setDeleting(null);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const openAdd = () => { setForm(EMPTY_FORM); setDialogOpen(true); };
  const openEdit = (p: PrinterRow) => { setForm(rowToForm(p)); setDialogOpen(true); };

  const nameOk = form.name.trim().length > 0;
  const addressOk = !needsAddress(form.connection) || form.address.trim().length > 0;
  const canSave = nameOk && addressOk && !save.isPending;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Printers</h1>
          <p className="text-muted-foreground">
            {printers.length} printer{printers.length === 1 ? '' : 's'} — bill &amp; KOT
          </p>
        </div>
        <Button onClick={openAdd}><Plus className="mr-2 h-4 w-4" /> Add printer</Button>
      </div>

      {/* Web Bluetooth printer (2026-08-25): direct browser → BLE thermal
          printer connection, Chromium-only. Sits above the registry list
          because it's the only thing on this page that physically prints. */}
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-start gap-3">
              <Bluetooth className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
              <div>
                <p className="font-medium">Web Bluetooth printer</p>
                <p className="text-sm text-muted-foreground">
                  Connect a nearby BLE thermal printer and print directly from this browser.
                </p>
              </div>
            </div>

            {!btSupported ? (
              <Badge variant="outline" className="border-destructive/40 text-destructive">
                Not supported in this browser
              </Badge>
            ) : btPrinter && btPrinter.isConnected ? (
              <div className="flex flex-wrap items-center gap-2">
                {/* Green dot = live GATT link, mirrors the mobile app's
                    paired-printer indicator (2026-08-25). */}
                <span className="inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm">
                  <span className="h-2.5 w-2.5 rounded-full bg-green-500" />
                  <span className="font-medium">{btPrinter.deviceName}</span>
                </span>
                <Button variant="outline" size="sm" onClick={handleBtTest} disabled={btTesting}>
                  {btTesting ? 'Printing…' : 'Test print'}
                </Button>
                <Button variant="ghost" size="sm" onClick={handleBtDisconnect}>
                  Disconnect
                </Button>
              </div>
            ) : (
              <Button size="sm" onClick={handleBtConnect} disabled={btConnecting}>
                <Bluetooth className="mr-2 h-4 w-4" />
                {btConnecting ? 'Connecting…' : 'Connect printer'}
              </Button>
            )}
          </div>

          {!btSupported && (
            <p className="text-xs text-muted-foreground">
              Web Bluetooth needs Chrome or Edge over HTTPS. iOS Safari does not support
              it at all — on iPhone/iPad, print from the NamastePOS mobile app instead.
            </p>
          )}
          {/* WHY this caveat (2026-08-25): browser BLE printing dies with the
              tab and skips classic-Bluetooth printers, so we say out loud that
              it's a convenience, not the production print path. */}
          <p className="text-xs text-muted-foreground">
            Best for quick prints at the counter. For reliable day-long printing, use the
            NamastePOS mobile app (Bluetooth) or the{' '}
            <span className="font-medium text-foreground">namastepos_print_agent</span> for
            LAN printers — this connection ends when the browser tab closes.
          </p>
        </CardContent>
      </Card>

      {/* WHY this note (2026-08-25): owners kept asking why "test print" isn't
          on the web. Browsers can't reach LAN/Bluetooth printers, so we set
          expectations up front instead of letting them hunt for a button. */}
      <div className="flex items-start gap-3 rounded-md border bg-muted/50 p-4 text-sm">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <p className="text-muted-foreground">
          This page manages your printer list only. Physical printing happens on the
          NamastePOS mobile app (Bluetooth thermal printers) or via the{' '}
          <span className="font-medium text-foreground">namastepos_print_agent</span> running
          on a computer on the same network as your LAN printers — the web dashboard
          cannot reach printers on your restaurant&apos;s local network directly.
        </p>
      </div>

      {/* List */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="py-14 text-center text-muted-foreground">Loading printers…</div>
          ) : isError ? (
            <div className="py-14 text-center">
              <p className="text-destructive">{apiError(error)}</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => refetch()}>
                Retry
              </Button>
            </div>
          ) : printers.length === 0 ? (
            <div className="py-14 text-center text-muted-foreground">
              <PrinterIcon className="mx-auto mb-3 h-10 w-10 opacity-40" />
              <p className="font-medium text-foreground">No printers yet</p>
              <p className="mt-1 text-sm">
                Add your bill printer and one KOT printer per kitchen station to get started.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Station</TableHead>
                  <TableHead>Connection</TableHead>
                  <TableHead>Address</TableHead>
                  <TableHead>Paper</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {printers.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">
                      <span className="inline-flex items-center gap-2">
                        <PrinterIcon className="h-4 w-4 text-muted-foreground" />
                        {p.name}
                        {p.is_default && (
                          <span title="Default printer">
                            <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
                          </span>
                        )}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={p.kind === 'bill' ? 'default' : 'secondary'}>
                        {p.kind === 'bill' ? 'Bill' : 'KOT'}
                      </Badge>
                    </TableCell>
                    <TableCell>{p.station_name || '—'}</TableCell>
                    <TableCell>{CONNECTION_LABELS[p.connection] ?? p.connection}</TableCell>
                    <TableCell className="font-mono text-xs">{p.address || '—'}</TableCell>
                    <TableCell>{p.paper_width_mm} mm</TableCell>
                    <TableCell>
                      {/* WHY (2026-08-25): list endpoint filters is_active=TRUE, so
                          every visible row is enabled — shown explicitly so staff
                          don't misread a Bluetooth printer's blank address as broken. */}
                      <Badge variant="outline" className="border-green-600/40 text-green-700">
                        Enabled
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(p)} title="Edit">
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setDeleting(p)} title="Remove">
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Add / Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{form.id ? 'Edit printer' : 'Add printer'}</DialogTitle>
            <DialogDescription>
              Configure how bills and kitchen order tickets reach this printer.
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Label>Name</Label>
              <Input
                placeholder="e.g., Counter bill printer"
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
              />
            </div>

            <div>
              <Label>Type</Label>
              {/* Native <select>: the ui kit has no Select component and
                  ExpensesPage sets the same precedent (2026-08-25). */}
              <select
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={form.kind}
                onChange={(e) => set('kind', e.target.value as PrinterForm['kind'])}
              >
                <option value="bill">Bill (customer receipt)</option>
                <option value="kot">KOT (kitchen ticket)</option>
              </select>
            </div>

            <div>
              <Label>Connection</Label>
              <select
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={form.connection}
                onChange={(e) => set('connection', e.target.value as PrinterForm['connection'])}
              >
                <option value="network">Network (LAN)</option>
                <option value="wifi">Wi-Fi</option>
                <option value="bluetooth">Bluetooth</option>
                <option value="usb">USB</option>
              </select>
            </div>

            <div className="sm:col-span-2">
              <Label>
                Address{needsAddress(form.connection) ? '' : ' (optional)'}
              </Label>
              <Input
                placeholder={
                  needsAddress(form.connection)
                    ? 'e.g., 192.168.1.50:9100'
                    : form.connection === 'bluetooth'
                      ? 'Paired on the mobile app — leave blank'
                      : 'Handled by the print agent — leave blank'
                }
                value={form.address}
                maxLength={120} // Backend Joi caps address at 120 chars (2026-08-25)
                onChange={(e) => set('address', e.target.value)}
              />
              {!addressOk && (
                <p className="mt-1 text-xs text-destructive">
                  IP address (and port) is required for network/Wi-Fi printers.
                </p>
              )}
            </div>

            {/* Station routing only exists for KOT printers — bill printers
                always print the full receipt (2026-08-25). */}
            {form.kind === 'kot' && (
              <div className="sm:col-span-2">
                <Label>Kitchen station</Label>
                <select
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={form.stationId ?? ''}
                  onChange={(e) => set('stationId', e.target.value || null)}
                >
                  <option value="">All stations (no routing)</option>
                  {stations.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
                {stations.length === 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    No stations yet — create them on the KOT page to route tickets per station.
                  </p>
                )}
              </div>
            )}

            <div>
              <Label>Paper width</Label>
              {/* Only 58/80 — the backend Joi whitelists exactly these two,
                  matching the mobile app's 58/80mm segmented toggle (2026-08-25). */}
              <select
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={form.paperWidthMm}
                onChange={(e) => set('paperWidthMm', Number(e.target.value) as 58 | 80)}
              >
                <option value={58}>58 mm (32 chars)</option>
                <option value={80}>80 mm (48 chars)</option>
              </select>
            </div>

            <div className="flex items-end pb-1">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-input accent-primary"
                  checked={form.isDefault}
                  onChange={(e) => set('isDefault', e.target.checked)}
                />
                Default printer for this type
              </label>
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={() => save.mutate()} disabled={!canSave}>
              {save.isPending ? 'Saving…' : form.id ? 'Save changes' : 'Add printer'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation — soft delete on the backend (is_active=FALSE),
          but from the owner's POV it's gone, so we still confirm (2026-08-25). */}
      <Dialog open={deleting !== null} onOpenChange={(open) => { if (!open) setDeleting(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove printer?</DialogTitle>
            <DialogDescription>
              &ldquo;{deleting?.name}&rdquo; will stop receiving print jobs. Orders and
              past print history are not affected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => deleting && remove.mutate(deleting.id)}
            >
              {remove.isPending ? 'Removing…' : 'Remove'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
