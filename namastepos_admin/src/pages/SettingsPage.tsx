import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Save, ShieldCheck, Activity } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { adminApi } from '@/api/admin';
import { apiError } from '@/api/client';

interface SettingMeta { key: string; label: string; description?: string; type?: 'string' | 'number' | 'boolean'; group: string; }

const FIELDS: SettingMeta[] = [
  // Brand
  { key: 'brand.name',           label: 'Brand name',          group: 'Brand' },
  { key: 'brand.support_email',  label: 'Support email',       group: 'Brand' },
  // Platform / tax
  { key: 'platform.legal_name',  label: 'Legal entity name',   group: 'Tax (GST)' },
  { key: 'platform.gstin',       label: 'Platform GSTIN',      group: 'Tax (GST)', description: '15-char GST number, e.g. 27AAAAA0000A1Z5' },
  { key: 'platform.hsn',         label: 'HSN/SAC code',        group: 'Tax (GST)', description: 'Default 998314 for SaaS' },
  { key: 'platform.tax_pct',     label: 'GST percentage',      group: 'Tax (GST)', type: 'number' },
  { key: 'platform.address',     label: 'Registered address',  group: 'Tax (GST)' },
  // Features
  { key: 'feature.maintenance_mode', label: 'Maintenance mode (block customer logins)', group: 'Feature flags', type: 'boolean' },
  { key: 'feature.new_signups_open', label: 'New signups open',                          group: 'Feature flags', type: 'boolean' },
  // Security
  { key: 'security.enforce_admin_2fa', label: 'Require 2FA for all admins', group: 'Security', type: 'boolean',
    description: 'When on, any admin who signs in without 2FA is forced to set it up before they can do anything.' },
];

export function SettingsPage() {
  const qc = useQueryClient();
  const { data: settings = [] } = useQuery({ queryKey: ['settings'], queryFn: adminApi.listSettings });
  const [draft, setDraft] = useState<Record<string, any>>({});

  useEffect(() => {
    if (settings.length > 0) {
      const m: Record<string, any> = {};
      for (const s of settings) m[s.key] = s.value;
      setDraft(m);
    }
  }, [settings.length]);

  const set = (k: string, v: any) => setDraft((d) => ({ ...d, [k]: v }));

  const save = useMutation({
    mutationFn: () => adminApi.saveSettings(draft),
    onSuccess: () => { toast.success('Settings saved'); qc.invalidateQueries({ queryKey: ['settings'] }); },
    onError: (e) => toast.error(apiError(e)),
  });

  const groups: Record<string, SettingMeta[]> = {};
  for (const f of FIELDS) { (groups[f.group] ||= []).push(f); }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Platform settings</h1>
        <p className="text-muted-foreground">
          Brand, tax info, feature flags. Changes apply immediately for new requests.
        </p>
      </div>

      {Object.entries(groups).map(([group, fields]) => (
        <Card key={group}>
          <CardHeader>
            <CardTitle>{group}</CardTitle>
            {group === 'Tax (GST)' && (
              <CardDescription>Used on tax invoices and GSTR-1 exports. Set this BEFORE you go live.</CardDescription>
            )}
          </CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {fields.map((f) => (
              <div key={f.key} className={f.type === 'boolean' ? 'md:col-span-2' : ''}>
                <Label className="text-sm">{f.label}</Label>
                {f.description && <p className="text-xs text-muted-foreground mb-1">{f.description}</p>}
                {f.type === 'boolean'
                  ? <select value={String(draft[f.key] ?? false)}
                            onChange={(e) => set(f.key, e.target.value === 'true')}
                            className="h-10 rounded-md border border-input bg-background px-3 text-sm">
                      <option value="true">Yes</option>
                      <option value="false">No</option>
                    </select>
                  : <Input type={f.type === 'number' ? 'number' : 'text'}
                           value={draft[f.key] !== undefined ? String(draft[f.key]).replace(/^"|"$/g, '') : ''}
                           onChange={(e) => set(f.key, f.type === 'number' ? +e.target.value : e.target.value)} />
                }
              </div>
            ))}
          </CardContent>
        </Card>
      ))}

      <div className="flex justify-end">
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          <Save className="mr-2 h-4 w-4" /> Save all settings
        </Button>
      </div>

      <PlatformHealthCard />
      <TwoFactorCard />
    </div>
  );
}

// ── Platform health (2026-09-03) ──────────────────────────────────────
// Read-only ops panel. Everything here comes from something that already
// existed — a DB round trip for latency, the _migrations bookkeeping table,
// webhook_events, and the cron worker's in-process last-run map. No new
// tables, no new pollers.
function PlatformHealthCard() {
  const { data: h, isLoading } = useQuery({
    queryKey: ['platform-health'],
    queryFn: adminApi.platformHealth,
    refetchInterval: 30_000,
  });

  const dot = (ok: boolean) =>
    `inline-block h-2 w-2 rounded-full ${ok ? 'bg-emerald-500' : 'bg-red-500'}`;

  const jobs = Object.entries(h?.cron.jobs || {})
    .sort((a, b) => String(b[1].at).localeCompare(String(a[1].at)));

  // The cron worker's memory is per-process. On a multi-instance deploy this
  // panel reports the instance that served THIS request, which is why the
  // note below says so rather than implying a cluster-wide view.
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-5 w-5" /> Platform health
        </CardTitle>
        <CardDescription>
          Live status of the API instance serving this request. Read-only.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {isLoading && <div className="text-sm text-muted-foreground">Checking…</div>}
        {h && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <div className="text-xs text-muted-foreground">API</div>
                <div className="flex items-center gap-2 font-medium">
                  <span className={dot(h.api.ok)} /> {h.api.env}
                </div>
                <div className="text-xs text-muted-foreground">
                  up {Math.floor(h.api.uptimeSec / 3600)}h {Math.floor((h.api.uptimeSec % 3600) / 60)}m
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Database</div>
                <div className="flex items-center gap-2 font-medium">
                  <span className={dot(h.db.ok)} />
                  {h.db.latencyMs !== null ? `${h.db.latencyMs} ms` : 'unknown'}
                </div>
                <div className="text-xs text-muted-foreground">
                  {h.db.connections !== null ? `${h.db.connections} connections` : ''}
                  {h.db.error ? h.db.error : ''}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Redis (feature cache)</div>
                <div className="flex items-center gap-2 font-medium">
                  <span className={dot(h.redis.configured ? h.redis.ready : true)} />
                  {h.redis.configured ? (h.redis.ready ? 'connected' : 'configured, not ready') : 'off'}
                </div>
                <div className="text-xs text-muted-foreground">{h.redis.mode}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Migrations applied</div>
                <div className="font-medium">{h.migrations.applied ?? '—'}</div>
                <div className="text-xs text-muted-foreground">
                  {h.migrations.lastAppliedAt
                    ? `last ${new Date(h.migrations.lastAppliedAt).toLocaleDateString('en-IN')}`
                    : ''}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 border-t pt-4 text-sm">
              <div>
                <div className="text-xs text-muted-foreground">Webhooks · 24h</div>
                <div className="font-medium">{h.webhooks.received24h ?? '—'} received</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Webhook errors · 24h</div>
                <div className={`font-medium ${(h.webhooks.errored24h || 0) > 0 ? 'text-destructive' : ''}`}>
                  {h.webhooks.errored24h ?? '—'}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Unprocessed · 24h</div>
                <div className={`font-medium ${(h.webhooks.unprocessed24h || 0) > 0 ? 'text-amber-600' : ''}`}>
                  {h.webhooks.unprocessed24h ?? '—'}
                </div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Cron worker</div>
                <div className="flex items-center gap-2 font-medium">
                  <span className={dot(h.cron.running)} />
                  {h.cron.running ? 'running' : 'not running here'}
                </div>
                <div className="text-xs text-muted-foreground">
                  {h.cron.lastTickAt
                    ? `last tick ${new Date(h.cron.lastTickAt).toLocaleTimeString('en-IN')} · ${h.cron.lastTickMs}ms`
                    : 'no tick yet'}
                </div>
              </div>
            </div>

            <div className="border-t pt-4">
              <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Last run per job
              </div>
              {jobs.length === 0 ? (
                <div className="text-sm text-muted-foreground">
                  No job has run on this instance yet (the worker runs on one instance,
                  and its history resets on deploy).
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1">
                  {jobs.map(([name, j]) => (
                    <div key={name} className="flex items-center justify-between border-b py-1 text-sm last:border-0">
                      <span className="flex items-center gap-2">
                        <span className={dot(j.ok)} />
                        <span className="font-mono text-xs">{name}</span>
                      </span>
                      <span className="text-xs text-muted-foreground" title={j.error || ''}>
                        {new Date(j.at).toLocaleTimeString('en-IN')} · {j.ms}ms
                        {!j.ok && ' · failed'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// 2FA enrol/disable for the signed-in admin (2026-08-25). Minimal UI: /auth/me
// does not report enrolment state, so we offer both flows and let the backend
// enforce (enrol errors if already on; disable errors if off).
function TwoFactorCard() {
  const [enrol, setEnrol] = useState<{ otpauth: string; secret: string; recoveryCodes: string[] } | null>(null);
  const [confirmCode, setConfirmCode] = useState('');
  const [disableCode, setDisableCode] = useState('');

  const start = useMutation({
    mutationFn: () => adminApi.enrol2faStart(),
    onSuccess: (d) => setEnrol(d),
    onError: (e) => toast.error(apiError(e)),
  });
  const confirm = useMutation({
    mutationFn: () => adminApi.enrol2faConfirm(confirmCode.trim()),
    onSuccess: () => { toast.success('2FA enabled'); setEnrol(null); setConfirmCode(''); },
    onError: (e) => toast.error(apiError(e)),
  });
  const disable = useMutation({
    mutationFn: () => adminApi.disable2fa(disableCode.trim()),
    onSuccess: () => { toast.success('2FA disabled'); setDisableCode(''); },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5" /> Two-factor authentication (your account)
        </CardTitle>
        <CardDescription>
          Protect your super-admin sign-in with a TOTP authenticator app.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Enable */}
        <div className="space-y-3">
          <div className="text-sm font-medium">Enable 2FA</div>
          {!enrol ? (
            <Button variant="outline" onClick={() => start.mutate()} disabled={start.isPending}>
              {start.isPending ? 'Generating…' : 'Set up authenticator'}
            </Button>
          ) : (
            <div className="space-y-3 rounded-md border border-border p-4">
              <p className="text-sm">
                Add this secret to your authenticator app (or scan the otpauth URI), then
                enter the current 6-digit code to confirm.
              </p>
              <div className="text-xs">
                <div className="mb-1">Secret</div>
                <code className="block break-all rounded bg-muted px-2 py-1 font-mono">{enrol.secret}</code>
              </div>
              <div className="text-xs">
                <div className="mb-1">otpauth URI</div>
                <code className="block break-all rounded bg-muted px-2 py-1 font-mono">{enrol.otpauth}</code>
              </div>
              <div className="text-xs">
                <div className="mb-1 font-medium text-amber-600">Recovery codes — save these now, shown once:</div>
                <code className="block whitespace-pre-wrap rounded bg-muted px-2 py-1 font-mono">
                  {enrol.recoveryCodes.join('  ')}
                </code>
              </div>
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <Label className="text-sm">Confirmation code</Label>
                  <Input inputMode="numeric" placeholder="6-digit code" value={confirmCode}
                         onChange={(e) => setConfirmCode(e.target.value)} />
                </div>
                <Button onClick={() => confirm.mutate()}
                        disabled={confirm.isPending || confirmCode.trim().length !== 6}>
                  {confirm.isPending ? 'Confirming…' : 'Confirm & enable'}
                </Button>
                <Button variant="ghost" onClick={() => { setEnrol(null); setConfirmCode(''); }}>Cancel</Button>
              </div>
            </div>
          )}
        </div>

        {/* Disable */}
        <div className="space-y-2">
          <div className="text-sm font-medium">Disable 2FA</div>
          <p className="text-xs text-muted-foreground">Requires a current code (or a recovery code).</p>
          <div className="flex items-end gap-2">
            <div className="flex-1 max-w-xs">
              <Input inputMode="numeric" placeholder="Current 2FA code" value={disableCode}
                     onChange={(e) => setDisableCode(e.target.value)} />
            </div>
            <Button variant="outline" onClick={() => disable.mutate()}
                    disabled={disable.isPending || disableCode.trim().length < 6}>
              {disable.isPending ? 'Disabling…' : 'Disable 2FA'}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
