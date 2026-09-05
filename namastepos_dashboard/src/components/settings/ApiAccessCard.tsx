// Settings → API access (2026-09-06, round 2, CONTRACTS §3).
//
// Tenant API keys: `GET/POST /businesses/:id/api-keys`, `DELETE /:keyId`.
// All three are owner-only and requireFeature('api_access') server-side;
// this card mirrors that (owner check + <RequireFeature> upgrade card) so a
// Pro owner sees WHY the section is locked instead of a 402 toast.
//
// The secret (`npk_live_…`) comes back from POST exactly once and is stored
// server-side as a sha256 hash — so the dialog below is the only time it is
// ever visible. Keys are READ-ONLY by design (non-GET → 405
// API_KEY_READ_ONLY), which the how-to copy says plainly.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { KeyRound, Copy, Check, Plus, Trash2, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { ffApi, type ApiKeyCreated } from '@/api/namastepos';
import { api, apiError, getBusinessCache } from '@/api/client';
import { usePlan } from '@/hooks/usePlan';
import { RequireFeature } from '@/components/RequireFeature';
import { formatDateTime } from '@/lib/utils';

export const API_KEYS_QUERY_KEY = ['api-keys'] as const;
// Mirrors the server cap (CONTRACTS §3: max 10 ACTIVE keys per business).
const MAX_ACTIVE_KEYS = 10;

/** Public API origin for the how-to snippet. Absolute VITE_API_URL wins; the dev proxy ('/v1') falls back to prod. */
function publicApiBase(): string {
  const base = api.defaults.baseURL || '';
  return /^https?:\/\//.test(base) ? base.replace(/\/$/, '') : 'https://api.namastepos.in/v1';
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button size="sm" variant="outline" type="button" onClick={async () => {
      try {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      } catch {
        toast.error('Copy failed — select the text and copy it manually');
      }
    }}>
      {done ? <Check className="h-3.5 w-3.5 mr-1" /> : <Copy className="h-3.5 w-3.5 mr-1" />}
      {done ? 'Copied' : label}
    </Button>
  );
}

export function ApiAccessCard() {
  const plan = usePlan();
  // Owner only — staff never reach Settings via the nav, but the route is
  // open, so the section itself checks (least privilege, same as the server).
  if (plan.loaded && plan.role !== 'business_owner') return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><KeyRound className="h-4 w-4" /> API access</CardTitle>
        <CardDescription>
          Read your orders, menu, reports and customers from your own tools with an API key. Keys are read-only.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <RequireFeature feature="api_access" compact title="API access is not in your plan">
          <ApiKeysBody />
        </RequireFeature>
      </CardContent>
    </Card>
  );
}

function ApiKeysBody() {
  const qc = useQueryClient();
  const bizId: string = getBusinessCache()?.id || '<business-id>';
  const { data: keys = [], isLoading, isError, error, refetch } = useQuery({
    queryKey: API_KEYS_QUERY_KEY,
    queryFn: ffApi.listApiKeys,
    retry: false,
  });
  const activeCount = keys.filter((k) => !k.revokedAt).length;

  const [label, setLabel] = useState('');
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);

  const create = useMutation({
    mutationFn: () => ffApi.createApiKey(label.trim()),
    onSuccess: (r) => {
      setCreated(r);
      setLabel('');
      qc.invalidateQueries({ queryKey: API_KEYS_QUERY_KEY });
    },
    onError: (e) => toast.error(apiError(e)),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => ffApi.revokeApiKey(id),
    onSuccess: () => { toast.success('Key revoked — requests with it now get 401'); qc.invalidateQueries({ queryKey: API_KEYS_QUERY_KEY }); },
    onError: (e) => toast.error(apiError(e)),
  });

  const snippet = (secret: string) =>
    `curl -H "X-API-Key: ${secret}" ${publicApiBase()}/businesses/${bizId}/orders`;

  return (
    <div className="space-y-4">
      {/* Create */}
      <div className="flex flex-col sm:flex-row sm:items-end gap-2">
        <div className="flex-1">
          <Label>New key label</Label>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80}
            placeholder="e.g. Tally sync, Zapier, Accountant laptop" />
        </div>
        <Button onClick={() => create.mutate()} disabled={create.isPending || !label.trim() || activeCount >= MAX_ACTIVE_KEYS}>
          <Plus className="h-4 w-4 mr-1" /> {create.isPending ? 'Creating…' : 'Create key'}
        </Button>
      </div>
      {activeCount >= MAX_ACTIVE_KEYS && (
        <p className="text-xs text-amber-700">You have {MAX_ACTIVE_KEYS} active keys — revoke one before creating another.</p>
      )}

      {/* List */}
      {isError && (
        <div className="text-sm flex items-center justify-between gap-3">
          <span className="text-destructive">{apiError(error)}</span>
          <Button size="sm" variant="outline" onClick={() => refetch()}>Retry</Button>
        </div>
      )}
      {isLoading ? (
        <div className="text-sm text-muted-foreground">Loading keys…</div>
      ) : keys.length === 0 && !isError ? (
        <div className="text-sm text-muted-foreground">No API keys yet.</div>
      ) : (
        <div className="divide-y rounded-md border">
          {keys.map((k) => (
            <div key={k.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <div className="min-w-0">
                <div className="font-medium flex items-center gap-2">
                  <span className="truncate">{k.label}</span>
                  <code className="text-xs text-muted-foreground">{k.prefix}…</code>
                  {k.revokedAt
                    ? <Badge variant="secondary">Revoked</Badge>
                    : <Badge variant="success">Active</Badge>}
                </div>
                <div className="text-xs text-muted-foreground">
                  Created {formatDateTime(k.createdAt)}
                  {' · '}{k.lastUsedAt ? `last used ${formatDateTime(k.lastUsedAt)}` : 'never used'}
                  {k.revokedAt ? ` · revoked ${formatDateTime(k.revokedAt)}` : ''}
                </div>
              </div>
              {!k.revokedAt && (
                <Button size="sm" variant="ghost" className="text-destructive" disabled={revoke.isPending}
                  onClick={() => {
                    if (window.confirm(`Revoke "${k.label}"? Anything using it stops working immediately.`)) revoke.mutate(k.id);
                  }}>
                  <Trash2 className="h-3.5 w-3.5 mr-1" /> Revoke
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* How to call */}
      <div className="rounded-md bg-muted/50 p-3 text-xs space-y-2">
        <div className="font-medium text-sm">How to call</div>
        <p className="text-muted-foreground">
          Send the key in an <code>X-API-Key</code> header on any <code>GET</code> under your business.
          Keys are read-only (orders, menu, reports, customers); writes return 405. Limit: 600 requests/min per key.
        </p>
        <pre className="overflow-x-auto rounded bg-background border p-2 font-mono">{snippet('npk_live_…')}</pre>
      </div>

      {/* Secret shown ONCE */}
      <Dialog open={!!created} onOpenChange={(o) => { if (!o) setCreated(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Your new API key</DialogTitle>
            <DialogDescription>
              <strong className="text-foreground">Copy it now.</strong> For security we store only a hash — this secret
              is shown once and cannot be recovered. If you lose it, revoke this key and create a new one.
            </DialogDescription>
          </DialogHeader>
          {created && (
            <div className="space-y-3">
              <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
                <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                Treat this like a password. Anyone holding it can read your orders, menu, reports and customers.
              </div>
              <div>
                <Label>Secret · {created.key.label}</Label>
                <div className="mt-1 flex items-center gap-2">
                  <code className="flex-1 break-all rounded border bg-muted px-2 py-1.5 text-xs" data-testid="api-key-secret">{created.secret}</code>
                  <CopyButton text={created.secret} />
                </div>
              </div>
              <div>
                <Label>Try it</Label>
                <div className="mt-1 flex items-start gap-2">
                  <pre className="flex-1 overflow-x-auto rounded border bg-muted p-2 text-xs font-mono">{snippet(created.secret)}</pre>
                  <CopyButton text={snippet(created.secret)} label="Copy curl" />
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setCreated(null)}>I have copied it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
