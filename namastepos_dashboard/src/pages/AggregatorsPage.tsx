import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Truck, AlertTriangle, Save, Wand2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { ffApi } from '@/api/namastepos';
import { apiError } from '@/api/client';
// FF-103b — SKU auto-map dialog. Was orphaned (built but never
// mounted). Wired into the "Unmapped items" card so owners can
// bulk-map incoming aggregator SKUs to menu items in one shot.
import { SkuAutoMapDialog } from '@/components/SkuAutoMapDialog';

const PROVIDERS = [
  { id: 'zomato',  label: 'Zomato',  color: 'bg-red-100 text-red-700' },
  { id: 'swiggy',  label: 'Swiggy',  color: 'bg-orange-100 text-orange-700' },
  { id: 'dunzo',   label: 'Dunzo',   color: 'bg-emerald-100 text-emerald-700' },
  { id: 'magicpin',label: 'Magicpin',color: 'bg-fuchsia-100 text-fuchsia-700' },
];

export function AggregatorsPage() {
  const qc = useQueryClient();
  const { data: creds = [] } = useQuery({ queryKey: ['aggregators'], queryFn: ffApi.listAggregators });
  const { data: issues = [] } = useQuery({ queryKey: ['agg-issues'], queryFn: ffApi.listMappingIssues });
  // FF-103b — auto-map dialog is per-provider. Track which provider
  // the owner wants to map. Null = closed.
  const [autoMapProvider, setAutoMapProvider] = useState<
    'zomato' | 'swiggy' | 'dunzo' | 'magicpin' | null
  >(null);
  // Providers that actually have unmapped items — offer them as the
  // dropdown options when the Auto-map button is clicked.
  const providersWithIssues = Array.from(
    new Set((issues as any[]).map((i) => i.provider))
  ) as Array<'zomato' | 'swiggy' | 'dunzo' | 'magicpin'>;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Truck className="h-6 w-6 text-primary" /> Aggregator integrations
          <Badge variant="warning">Beta</Badge>
        </h1>
        <p className="text-muted-foreground text-sm">
          Configure Zomato &amp; Swiggy so their orders flow straight into your queue.
          Set your webhook URL to <code>/v1/aggregator-webhooks/&lt;provider&gt;</code> on their portal.
        </p>
        {/* §4.4 (2026-08-23): be upfront that this ingests orders via webhook.
            Direct one-click onboarding with the aggregators' official APIs is
            still in progress, so owners don't expect a turnkey connection. */}
        <p className="mt-1 text-xs text-amber-600">
          Order ingestion works via webhook today. One-click official API onboarding
          with each platform is coming soon — for now, set the webhook on their portal.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {PROVIDERS.map((p) => {
          const cred = creds.find((c: any) => c.provider === p.id);
          return <ProviderCard key={p.id} provider={p} cred={cred}
            onSaved={() => qc.invalidateQueries({ queryKey: ['aggregators'] })} />;
        })}
      </div>

      {issues.length > 0 && (
        <Card className="border-amber-300 bg-amber-50">
          <CardHeader className="flex flex-row items-start justify-between space-y-0">
            <div className="space-y-1">
              <CardTitle className="text-amber-900 flex items-center gap-2">
                <AlertTriangle className="h-5 w-5" /> Unmapped items ({issues.length})
              </CardTitle>
              <CardDescription>Items in incoming orders that don't match any menu SKU.</CardDescription>
            </div>
            <div className="flex gap-2">
              {providersWithIssues.map((prov) => (
                <Button key={prov} size="sm" variant="outline"
                  onClick={() => setAutoMapProvider(prov)}>
                  <Wand2 className="h-4 w-4 mr-1" /> Auto-map {prov}
                </Button>
              ))}
            </div>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {issues.slice(0, 20).map((i: any) => (
              <div key={i.id} className="flex justify-between border-b pb-1">
                <span>
                  <Badge variant="muted" className="capitalize mr-2">{i.provider}</Badge>
                  {i.external_name || '(no name)'}
                </span>
                <span className="text-xs text-muted-foreground">
                  SKU: {i.external_sku} · seen {i.count_seen}×
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      {autoMapProvider && (
        <SkuAutoMapDialog
          open
          provider={autoMapProvider}
          onClose={() => {
            setAutoMapProvider(null);
            qc.invalidateQueries({ queryKey: ['agg-issues'] });
          }}
        />
      )}
    </div>
  );
}

function ProviderCard({ provider, cred, onSaved }: any) {
  const [f, setF] = useState({
    provider: provider.id,
    outletId: cred?.outlet_id || '',
    apiKey: '',
    webhookSecret: '',
    autoAccept: cred?.auto_accept || false,
  });
  const save = useMutation({
    mutationFn: () => ffApi.saveAggregator(f),
    onSuccess: () => { toast.success(`${provider.label} saved`); onSaved(); },
    onError: (e) => toast.error(apiError(e)),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className={`px-2 py-0.5 rounded text-xs font-bold ${provider.color}`}>{provider.label}</span>
          {cred && <Badge variant="success" className="ml-auto">connected</Badge>}
        </CardTitle>
        {/* FF-245 — live sync-status badge. Backend returns last_ok_at
            and last_error_at on the credentials row; we show whichever
            is more recent so a broken integration surfaces immediately. */}
        {cred && <SyncStatus cred={cred} />}
      </CardHeader>
      <CardContent className="space-y-3">
        <div><Label>Outlet ID</Label><Input value={f.outletId} onChange={(e) => setF({ ...f, outletId: e.target.value })} placeholder="from their dashboard" /></div>
        <div><Label>API key</Label><Input type="password" value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} placeholder={cred ? '(unchanged)' : ''} /></div>
        <div><Label>Webhook secret</Label><Input type="password" value={f.webhookSecret} onChange={(e) => setF({ ...f, webhookSecret: e.target.value })} placeholder={cred ? '(unchanged)' : ''} /></div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={f.autoAccept} onChange={(e) => setF({ ...f, autoAccept: e.target.checked })} />
          <span className="text-sm">Auto-accept (skip kitchen approval)</span>
        </label>
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          <Save className="mr-2 h-4 w-4" /> Save
        </Button>
      </CardContent>
    </Card>
  );
}

// FF-245 — displays "last synced Nm ago" (green) or an error badge
// (red) based on which timestamp is more recent on the credentials row.
function SyncStatus({ cred }: { cred: any }) {
  const okAt  = cred?.last_ok_at   ? new Date(cred.last_ok_at).getTime()   : 0;
  const errAt = cred?.last_error_at ? new Date(cred.last_error_at).getTime() : 0;
  if (!okAt && !errAt) {
    return <div className="text-xs text-muted-foreground mt-1">Waiting for the first webhook…</div>;
  }
  const isError = errAt > okAt;
  const ts = new Date(isError ? errAt : okAt);
  const ago = Math.max(1, Math.round((Date.now() - ts.getTime()) / 60000));
  const label = ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`;
  return (
    <div className={`mt-1 text-xs flex items-center gap-1 ${isError ? 'text-red-700' : 'text-emerald-700'}`}>
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${isError ? 'bg-red-600' : 'bg-emerald-600'}`} />
      {isError ? `Error ${label}` : `Last synced ${label}`}
      {isError && cred.last_error && (
        <span className="text-muted-foreground truncate max-w-[240px]">· {cred.last_error}</span>
      )}
    </div>
  );
}
