import { useState, useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { ffApi } from '@/api/namastepos';
import { api, apiError, setBusinessCache } from '@/api/client';

// 2026-08-25 — mirror of the backend Joi enum on PUT /businesses/:id/aggregators.
// Zomato/Swiggy are the two the founder cares about; dunzo/magicpin exist in
// the enum but have no webhook adapters wired yet, so we don't advertise them.
const AGGREGATOR_PROVIDERS = ['zomato', 'swiggy'] as const;
type AggregatorProvider = (typeof AGGREGATOR_PROVIDERS)[number];

// Shape of one row from GET /businesses/:id/aggregators (snake_case straight
// from aggregatorService.listCredentials — includes FF-245 health join).
interface AggregatorCredential {
  provider: string;
  outlet_id: string | null;
  auto_accept: boolean;
  is_active: boolean;
  updated_at: string;
  last_ok_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
}

// 2026-08-25 — upload constraints mirror the backend multer config on
// POST /businesses/:id/uploads. Checking client-side first gives an instant
// toast instead of a 413/415 round-trip on slow connections.
const LOGO_MAX_BYTES = 5 * 1024 * 1024;
const LOGO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export function SettingsPage() {
  const qc = useQueryClient();
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: ffApi.me });
  const [form, setForm] = useState<any>({});

  useEffect(() => {
    if (me?.business) setForm({
      name: me.business.name || '',
      phone: me.business.phone || '',
      city: me.business.city || '',
      category: me.business.category || '',
      gstin: me.business.gstin || '',
      address: me.business.address || '',
      upi_id: me.business.upiId || '',
      bank_account: me.business.bankAccount || '',
      bank_ifsc: me.business.bankIfsc || '',
    });
  }, [me]);

  const save = useMutation({
    mutationFn: () => ffApi.patchMe(form),
    onSuccess: (res: any) => {
      toast.success('Saved');
      if (res.business) setBusinessCache(res.business);
      qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  // ── Logo upload ─────────────────────────────────────────────────────────
  // 2026-08-25 (gap D) — same persistence path as mobile: upload the file to
  // POST /businesses/:id/uploads, then PATCH /auth/me with the returned URL
  // in `logo_url` (the businesses-table column authService whitelists).
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadLogo = useMutation({
    mutationFn: async (file: File) => {
      const { url } = await ffApi.uploadImage(file);
      return ffApi.patchMe({ logo_url: url });
    },
    onSuccess: (res: any) => {
      toast.success('Logo updated');
      if (res.business) setBusinessCache(res.business);
      qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (e) => toast.error(apiError(e)),
    onSettled: () => {
      // Reset so re-selecting the same file fires onChange again.
      if (fileInputRef.current) fileInputRef.current.value = '';
    },
  });

  const removeLogo = useMutation({
    // Backend Joi allows '' for logo_url — clears the column.
    mutationFn: () => ffApi.patchMe({ logo_url: '' }),
    onSuccess: (res: any) => {
      toast.success('Logo removed');
      if (res.business) setBusinessCache(res.business);
      qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const onLogoPicked = (file: File | undefined) => {
    if (!file) return;
    if (!LOGO_MIME_TYPES.includes(file.type)) {
      toast.error('Please pick a JPEG, PNG or WebP image');
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      toast.error('Image is too large — max 5 MB');
      return;
    }
    uploadLogo.mutate(file);
  };

  // ── Change password (founder bug #1) ────────────────────────────────────
  // 2026-08-25 — hasPassword comes from GET /auth/me. Google-only accounts
  // (hasPassword: false) have no current password to verify, so the backend
  // contract takes currentPassword: null and this becomes a first-time
  // "set password" flow that unlocks email+password login.
  const hasPassword: boolean = !!me?.hasPassword;
  const [pwCurrent, setPwCurrent] = useState('');
  const [pwNew, setPwNew] = useState('');
  const [pwConfirm, setPwConfirm] = useState('');

  const changePassword = useMutation({
    // Path is relative to the axios base (…/v1), so this hits
    // POST /v1/auth/change-password.
    mutationFn: () => api.post('/auth/change-password', {
      currentPassword: hasPassword ? pwCurrent : null,
      newPassword: pwNew,
    }).then((r) => r.data),
    onSuccess: () => {
      toast.success(hasPassword ? 'Password changed' : 'Password set — you can now log in with email too');
      setPwCurrent(''); setPwNew(''); setPwConfirm('');
      // hasPassword flips to true after a first-time set — refetch so the
      // card switches to the "current password" variant.
      qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const submitPassword = () => {
    // Client-side mirrors the backend Joi (min 8) for instant feedback;
    // the server remains the authority.
    if (hasPassword && !pwCurrent) { toast.error('Enter your current password'); return; }
    if (pwNew.length < 8) { toast.error('New password must be at least 8 characters'); return; }
    if (pwNew !== pwConfirm) { toast.error('Passwords do not match'); return; }
    changePassword.mutate();
  };

  // ── Aggregators (gap D) ─────────────────────────────────────────────────
  // 2026-08-25 — same plan gate as mobile Push 17c: the card only renders
  // when the active plan carries the `aggregators` feature (from me.plan,
  // bootstrapped by /auth/me). Server-side gating still enforces regardless.
  const hasAggregators: boolean = !!me?.plan?.features?.includes('aggregators');

  const { data: aggregators } = useQuery<AggregatorCredential[]>({
    queryKey: ['aggregators'],
    queryFn: ffApi.listAggregators,
    enabled: hasAggregators && !!me?.business,
  });

  const [aggDialogOpen, setAggDialogOpen] = useState(false);
  const [aggForm, setAggForm] = useState<{
    provider: AggregatorProvider;
    outletId: string;
    apiKey: string;
    webhookSecret: string;
    autoAccept: boolean;
  }>({ provider: 'zomato', outletId: '', apiKey: '', webhookSecret: '', autoAccept: false });

  const openAggDialog = (provider: AggregatorProvider) => {
    const existing = aggregators?.find((c) => c.provider === provider);
    setAggForm({
      provider,
      outletId: existing?.outlet_id || '',
      // Secrets are write-only: the list endpoint never echoes apiKey /
      // webhookSecret back, so editing always starts blank. Blank fields
      // are sent as null on save (see saveAggregator) so the backend's
      // COALESCE keeps the stored secret instead of blanking it.
      apiKey: '',
      webhookSecret: '',
      autoAccept: existing?.auto_accept ?? false,
    });
    setAggDialogOpen(true);
  };

  const saveAggregator = useMutation({
    // 2026-08-25 — blank secrets go up as null, NOT ''. The backend upsert
    // uses COALESCE(EXCLUDED.api_key, existing): null preserves the stored
    // secret on edit, whereas '' would silently overwrite it with empty.
    mutationFn: () => ffApi.saveAggregator({
      provider: aggForm.provider,
      outletId: aggForm.outletId || null,
      apiKey: aggForm.apiKey || null,
      webhookSecret: aggForm.webhookSecret || null,
      autoAccept: aggForm.autoAccept,
    }),
    onSuccess: () => {
      toast.success(`${labelFor(aggForm.provider)} saved`);
      setAggDialogOpen(false);
      qc.invalidateQueries({ queryKey: ['aggregators'] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const labelFor = (p: string) => p.charAt(0).toUpperCase() + p.slice(1);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">Business profile, branding, security and integrations.</p>
      </div>

      {/* ── Profile ─────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader><CardTitle>Business profile</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div><Label>Name</Label><Input value={form.name || ''} onChange={(e) => set('name', e.target.value)} /></div>
          <div><Label>Phone</Label><Input value={form.phone || ''} onChange={(e) => set('phone', e.target.value)} /></div>
          <div><Label>City</Label><Input value={form.city || ''} onChange={(e) => set('city', e.target.value)} /></div>
          <div><Label>Category</Label><Input value={form.category || ''} onChange={(e) => set('category', e.target.value)} /></div>
          <div className="md:col-span-2"><Label>Address</Label><Input value={form.address || ''} onChange={(e) => set('address', e.target.value)} /></div>
          <div><Label>GSTIN</Label><Input value={form.gstin || ''} onChange={(e) => set('gstin', e.target.value)} /></div>
          <div><Label>UPI ID</Label><Input value={form.upi_id || ''} onChange={(e) => set('upi_id', e.target.value)} placeholder="yourbusiness@upi" /></div>
          <div><Label>Bank account</Label><Input value={form.bank_account || ''} onChange={(e) => set('bank_account', e.target.value)} /></div>
          <div><Label>IFSC</Label><Input value={form.bank_ifsc || ''} onChange={(e) => set('bank_ifsc', e.target.value)} /></div>
          <div className="md:col-span-2 flex justify-end">
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── Logo ────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader><CardTitle>Business logo</CardTitle></CardHeader>
        <CardContent className="flex items-center gap-4">
          {me?.business?.logoUrl ? (
            <img
              src={me.business.logoUrl}
              alt="Business logo"
              className="h-16 w-16 rounded-lg border object-contain bg-white"
            />
          ) : (
            <div className="h-16 w-16 rounded-lg border border-dashed flex items-center justify-center text-xs text-muted-foreground">
              No logo
            </div>
          )}
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Shown on your QR ordering page and receipts. JPEG, PNG or WebP, max 5 MB.
            </p>
            <div className="flex gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept={LOGO_MIME_TYPES.join(',')}
                className="hidden"
                onChange={(e) => onLogoPicked(e.target.files?.[0])}
              />
              <Button
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadLogo.isPending}
              >
                {uploadLogo.isPending ? 'Uploading…' : me?.business?.logoUrl ? 'Replace logo' : 'Upload logo'}
              </Button>
              {me?.business?.logoUrl && (
                <Button
                  variant="ghost"
                  onClick={() => removeLogo.mutate()}
                  disabled={removeLogo.isPending}
                >
                  Remove
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Password (founder bug #1) ───────────────────────────────────── */}
      <Card>
        <CardHeader><CardTitle>Password</CardTitle></CardHeader>
        <CardContent className="space-y-4 max-w-md">
          {!hasPassword && (
            <p className="text-sm text-muted-foreground">
              You signed up with Google — set a password to also log in with email.
            </p>
          )}
          {hasPassword && (
            <div>
              <Label>Current password</Label>
              <Input
                type="password"
                autoComplete="current-password"
                value={pwCurrent}
                onChange={(e) => setPwCurrent(e.target.value)}
              />
            </div>
          )}
          <div>
            <Label>New password</Label>
            <Input
              type="password"
              autoComplete="new-password"
              value={pwNew}
              onChange={(e) => setPwNew(e.target.value)}
              placeholder="At least 8 characters"
            />
          </div>
          <div>
            <Label>Confirm new password</Label>
            <Input
              type="password"
              autoComplete="new-password"
              value={pwConfirm}
              onChange={(e) => setPwConfirm(e.target.value)}
            />
            {pwConfirm.length > 0 && pwNew !== pwConfirm && (
              <p className="text-xs text-destructive mt-1">Passwords do not match</p>
            )}
          </div>
          <div className="flex justify-end">
            <Button onClick={submitPassword} disabled={changePassword.isPending}>
              {changePassword.isPending
                ? 'Saving…'
                : hasPassword ? 'Change password' : 'Set password'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── Notifications ───────────────────────────────────────────────── */}
      {/* 2026-08-25 — the mobile "Auto WhatsApp on order ready" and "Low
          stock alerts" toggles persist to SharedPreferences on the device
          only (settings_provider.dart); there is no per-business backend
          endpoint for them yet. Wiring web toggles would silently NOT sync
          to the phone that actually sends the WhatsApp / shows the alert,
          so we explain instead of pretending. */}
      <Card>
        <CardHeader><CardTitle>Notifications</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Auto-WhatsApp on order ready and low-stock alerts are per-device
            preferences — manage them in the NamastePOS mobile app under
            Settings → Integrations on the phone or tablet that runs your counter.
          </p>
        </CardContent>
      </Card>

      {/* ── Integrations ────────────────────────────────────────────────── */}
      <Card>
        <CardHeader><CardTitle>Integrations — Aggregators</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {!hasAggregators ? (
            <p className="text-sm text-muted-foreground">
              Aggregator integrations (Zomato, Swiggy) are not included in your
              current plan. Upgrade from the Billing page to connect them.
            </p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Connect your Zomato / Swiggy outlet so online orders land
                directly in NamastePOS.
              </p>
              <div className="space-y-2">
                {AGGREGATOR_PROVIDERS.map((provider) => {
                  const cred = aggregators?.find((c) => c.provider === provider);
                  return (
                    <div
                      key={provider}
                      className="flex items-center justify-between rounded-lg border p-3"
                    >
                      <div>
                        <div className="font-medium">{labelFor(provider)}</div>
                        <div className="text-xs text-muted-foreground">
                          {cred
                            ? `Outlet ${cred.outlet_id || '—'} · ${cred.is_active ? 'Active' : 'Inactive'}`
                              + (cred.auto_accept ? ' · Auto-accept on' : '')
                              + (cred.last_error
                                  ? ` · Last error: ${cred.last_error}`
                                  : cred.last_ok_at
                                    ? ` · Last sync ${new Date(cred.last_ok_at).toLocaleString()}`
                                    : '')
                            : 'Not connected'}
                        </div>
                      </div>
                      <Button
                        variant={cred ? 'outline' : 'default'}
                        size="sm"
                        onClick={() => openAggDialog(provider)}
                      >
                        {cred ? 'Edit' : 'Connect'}
                      </Button>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Aggregator connect/edit dialog */}
      <Dialog open={aggDialogOpen} onOpenChange={setAggDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect {labelFor(aggForm.provider)}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Outlet ID</Label>
              <Input
                value={aggForm.outletId}
                onChange={(e) => setAggForm((f) => ({ ...f, outletId: e.target.value }))}
                placeholder={`Your ${labelFor(aggForm.provider)} outlet / restaurant ID`}
              />
            </div>
            <div>
              <Label>API key</Label>
              <Input
                type="password"
                autoComplete="off"
                value={aggForm.apiKey}
                onChange={(e) => setAggForm((f) => ({ ...f, apiKey: e.target.value }))}
                placeholder="From your partner dashboard"
              />
            </div>
            <div>
              <Label>Webhook secret</Label>
              <Input
                type="password"
                autoComplete="off"
                value={aggForm.webhookSecret}
                onChange={(e) => setAggForm((f) => ({ ...f, webhookSecret: e.target.value }))}
                placeholder="Used to verify incoming order webhooks"
              />
            </div>
            {/* No shadcn Switch in this project — plain labelled checkbox,
                same convention as other dashboard toggles. */}
            <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={aggForm.autoAccept}
                onChange={(e) => setAggForm((f) => ({ ...f, autoAccept: e.target.checked }))}
              />
              Auto-accept incoming orders
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAggDialogOpen(false)}>Cancel</Button>
            <Button onClick={() => saveAggregator.mutate()} disabled={saveAggregator.isPending}>
              {saveAggregator.isPending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
