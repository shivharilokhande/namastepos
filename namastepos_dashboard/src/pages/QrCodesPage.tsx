import { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { QRCodeSVG } from 'qrcode.react';
import {
  Download, RefreshCw, Settings as SettingsIcon, QrCode, Copy,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { ffApi } from '@/api/namastepos';
import { apiError } from '@/api/client';

export function QrCodesPage() {
  const qc = useQueryClient();
  const { data: tables = [] } = useQuery({ queryKey: ['ops-tables-qr'], queryFn: () => ffApi.listOpsTables() });
  const { data: settings } = useQuery({ queryKey: ['qr-settings'], queryFn: ffApi.qrSettings });
  const [editing, setEditing] = useState(false);

  const tokenFetcher = useMutation({
    mutationFn: (tableId: string) => ffApi.qrTokenForTable(tableId),
  });

  const rotate = useMutation({
    mutationFn: (tableId: string) => ffApi.rotateQrToken(tableId),
    onSuccess: () => { toast.success('QR rotated — old QR is now invalid'); qc.invalidateQueries({ queryKey: ['ops-tables-qr'] }); },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <QrCode className="h-6 w-6 text-primary" /> QR codes
          </h1>
          <p className="text-muted-foreground">
            One QR per table. Customers scan → menu opens → they order without a waiter.
          </p>
        </div>
        <Button variant="outline" onClick={() => setEditing(true)}>
          <SettingsIcon className="mr-2 h-4 w-4" /> QR settings
        </Button>
      </div>

      {settings && !settings.isEnabled && (
        <Card className="border-amber-300 bg-amber-50">
          <CardContent className="p-4 text-sm text-amber-900">
            <strong>Guest ordering is paused.</strong> Customers scanning these QRs will see
            an "ordering paused" message. Re-enable in QR settings.
          </CardContent>
        </Card>
      )}

      {tables.length === 0 ? (
        <Card><CardContent className="p-10 text-center text-muted-foreground">
          Add tables first under the <strong>Tables</strong> page, then come back here to print QRs.
        </CardContent></Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {tables.map((t: any) => (
            <QrCard key={t.id} table={t}
              onRotate={() => rotate.mutate(t.id)} />
          ))}
        </div>
      )}

      {editing && <QrSettingsDialog onClose={() => setEditing(false)}
        onSaved={() => { qc.invalidateQueries({ queryKey: ['qr-settings'] }); setEditing(false); }} />}
    </div>
  );
}

function QrCard({ table, onRotate }: { table: any; onRotate: () => void }) {
  const tokenQ = useQuery({
    queryKey: ['qr-token', table.id],
    queryFn: () => ffApi.qrTokenForTable(table.id),
    retry: 1,
  });
  const token = tokenQ.data;
  // Push 15k — wrap the QR in a div ref and look up the real <svg> via
  // querySelector. `qrcode.react`'s QRCodeSVG doesn't forwardRef in all
  // versions, so a direct ref={svgRef} silently stays null on render —
  // which is exactly the "QR not ready yet" we were seeing.
  const wrapRef = useRef<HTMLDivElement>(null);
  // Push 15i — surface query errors. Previously a failed token request
  // left the card on "Generating…" forever with no signal to the user.
  // Now we render a clear error block with the real backend message and
  // a retry button.
  const url = token
    ? `${window.location.origin}/qr/${token}`
    : '';

  // Push 15j — PNG download. Rasterises the inline <svg> through an
  // Image + canvas pipeline (no library). 4× upscale so the QR stays
  // crisp when printed on A4 / posters. Includes the standard quiet
  // zone (white margin) by drawing the SVG inside a slightly larger
  // white canvas — without that, scanners can struggle.
  const downloadPng = async () => {
    // Prefer the wrapper ref's querySelector; fall back to the ref the
    // QRCodeSVG was given (works on versions that DO forwardRef).
    const svgEl = wrapRef.current?.querySelector('svg') as SVGSVGElement | null;
    if (!svgEl) {
      toast.error('QR not ready yet');
      return;
    }
    const cloned = svgEl.cloneNode(true) as SVGSVGElement;
    cloned.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const svgString = new XMLSerializer().serializeToString(cloned);
    // Inline as data URI rather than blob URL — works around a Chrome
    // taint bug where blob: SVGs sometimes refuse to render to canvas.
    const svgDataUri =
      'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgString);

    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Could not load SVG into image'));
        img.src = svgDataUri;
      });

      const scale = 4;
      const base = svgEl.viewBox?.baseVal?.width
        || Number(svgEl.getAttribute('width'))
        || 180;
      const inner = base * scale;
      const margin = 16 * scale;       // quiet zone
      const total = inner + margin * 2;

      const canvas = document.createElement('canvas');
      canvas.width = total;
      canvas.height = total;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas not supported');
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, total, total);
      ctx.drawImage(img, margin, margin, inner, inner);

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), 'image/png')
      );
      if (!blob) throw new Error('Could not generate PNG');

      const u = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = u;
      a.download = `qr-table-${table.label}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(u), 1000);
      toast.success(`Saved qr-table-${table.label}.png`);
    } catch (e: any) {
      toast.error(e?.message || 'PNG download failed');
    }
  };

  const copyUrl = () => { navigator.clipboard.writeText(url); toast.success('URL copied'); };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Table {table.label}</CardTitle>
          {!table.qrEnabled && <Badge variant="destructive">QR disabled</Badge>}
        </div>
        <CardDescription>{table.seats} seats · {table.floorName || '—'}</CardDescription>
      </CardHeader>
      <CardContent>
        {/* Bug fix (2026-08-20): `qrcode.react`'s QRCodeSVG isn't a
            forwardRef component in the pinned version, so a
            `ref={svgRef}` prop triggered a React "cannot be given
            refs" warning on every render. The download path already
            queries the DOM via wrapRef.current.querySelector('svg'),
            so the ref-on-SVG line was pure dead weight — dropped. */}
        <div ref={wrapRef} className="flex justify-center bg-white p-4 rounded-lg border min-h-[212px]">
          {url ? (
            <QRCodeSVG
              value={url}
              size={180}
              level="M"
              includeMargin={false}
            />
          ) : tokenQ.isLoading ? (
            <div className="h-44 w-44 grid place-items-center text-muted-foreground text-sm">
              Generating…
            </div>
          ) : tokenQ.error ? (
            <div className="h-44 w-44 flex flex-col items-center justify-center text-center px-2">
              <QrCode className="h-7 w-7 text-destructive mb-1" />
              <div className="text-xs font-semibold text-destructive">QR token error</div>
              <div className="text-[10px] text-muted-foreground mt-1 line-clamp-3">
                {apiError(tokenQ.error)}
              </div>
              <Button size="sm" variant="outline" className="mt-2 h-6 text-[10px] px-2"
                  onClick={() => tokenQ.refetch()}>
                Retry
              </Button>
            </div>
          ) : (
            <div className="h-44 w-44 grid place-items-center text-muted-foreground text-xs text-center">
              No token returned by server.<br />
              <Button size="sm" variant="outline" className="mt-2 h-6 text-[10px] px-2"
                  onClick={() => tokenQ.refetch()}>Retry</Button>
            </div>
          )}
        </div>
        {url && (
          <div className="mt-3 text-xs text-muted-foreground break-all flex items-center gap-2">
            <code className="flex-1 truncate">{url}</code>
            <Button size="sm" variant="ghost" onClick={copyUrl}><Copy className="h-3 w-3" /></Button>
          </div>
        )}
        <div className="mt-4 grid grid-cols-2 gap-2">
          <Button size="sm" variant="outline" onClick={downloadPng}>
            <Download className="mr-1 h-3 w-3" /> Download PNG
          </Button>
          <Button size="sm" variant="ghost" onClick={onRotate}>
            <RefreshCw className="mr-1 h-3 w-3" /> Rotate
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function QrSettingsDialog({ onClose, onSaved }: any) {
  const { data: settings } = useQuery({ queryKey: ['qr-settings'], queryFn: ffApi.qrSettings });
  const [form, setForm] = useState<any>(null);

  // P0-3 fix: hydrate form via useEffect — calling setForm in render was an
  // infinite loop (Maximum update depth exceeded).
  useEffect(() => {
    if (settings && !form) {
      setForm({
        is_enabled: settings.isEnabled,
        welcome_title: settings.welcomeTitle,
        welcome_subtitle: settings.welcomeSubtitle,
        brand_color: settings.brandColor,
        require_phone: settings.requirePhone,
        require_name: settings.requireName,
        show_prices: settings.showPrices,
        show_veg_badge: settings.showVegBadge,
        auto_accept: settings.autoAccept,
      });
    }
  }, [settings, form]);

  const save = useMutation({
    mutationFn: () => ffApi.updateQrSettings(form),
    onSuccess: () => { toast.success('Saved'); onSaved(); },
    onError: (e) => toast.error(apiError(e)),
  });

  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  if (!form) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent><DialogHeader><DialogTitle>QR settings</DialogTitle></DialogHeader>
          <div className="py-6 text-muted-foreground">Loading…</div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader><DialogTitle>QR ordering settings</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={form.is_enabled} onChange={(e) => set('is_enabled', e.target.checked)} />
            <span className="text-sm font-medium">Guest ordering is live</span>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Welcome title</Label><Input value={form.welcome_title} onChange={(e) => set('welcome_title', e.target.value)} /></div>
            <div><Label>Brand color</Label><Input type="color" value={form.brand_color} onChange={(e) => set('brand_color', e.target.value)} /></div>
          </div>
          <div><Label>Welcome subtitle</Label><Input value={form.welcome_subtitle} onChange={(e) => set('welcome_subtitle', e.target.value)} /></div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.require_phone} onChange={(e) => set('require_phone', e.target.checked)} />
              Require phone number
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.require_name} onChange={(e) => set('require_name', e.target.checked)} />
              Require name
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.show_prices} onChange={(e) => set('show_prices', e.target.checked)} />
              Show prices
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.show_veg_badge} onChange={(e) => set('show_veg_badge', e.target.checked)} />
              Show veg/non-veg badge
            </label>
            <label className="flex items-center gap-2 cursor-pointer col-span-2">
              <input type="checkbox" checked={form.auto_accept} onChange={(e) => set('auto_accept', e.target.checked)} />
              Auto-accept orders (otherwise staff must approve from POS)
            </label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
