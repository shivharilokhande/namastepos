// Reservation widget embed snippet (F21 / FF-704)
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Calendar } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { getBusinessCache } from '@/api/client';

export function ReservationWidgetPage() {
  const biz = getBusinessCache();
  const slug = biz?.id || 'YOUR_BUSINESS_ID';
  // Review fix (2026-08-23): domain was hardcoded (https://app.namastepos.in).
  // Derive from env override or the dashboard's own origin so the snippet
  // survives the pending product/domain rename without a code change.
  const appOrigin =
    (import.meta.env.VITE_APP_ORIGIN as string | undefined) ||
    window.location.origin;
  const html = `<iframe
  src="${appOrigin}/reservation-widget?business=${slug}"
  style="border:0;width:100%;max-width:480px;height:560px"
  loading="lazy"
></iframe>`;
  const copy = () => {
    navigator.clipboard.writeText(html);
    toast.success('Embed code copied');
  };
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Calendar className="h-6 w-6 text-primary" /> Reservation widget
        </h1>
        <p className="text-muted-foreground text-sm">Paste this on your own website or Google Business profile.</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Embed code</CardTitle>
          <CardDescription>Drop this HTML into any page. Posts directly to /v1/businesses/:id/reservations.</CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="bg-muted/40 p-3 rounded text-xs overflow-x-auto whitespace-pre-wrap">{html}</pre>
          <Button className="mt-3" onClick={copy}>Copy embed</Button>
        </CardContent>
      </Card>
    </div>
  );
}
