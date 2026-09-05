// NamastePOS admin — "My account" (F-11, 2026-09-06).
//
// Voluntary 2FA enrolment used to live only on /settings, which is nav-gated
// `settings.write` (super_admin only) and whose settings list needs
// `settings.read` — so a `support` or `sales` admin could not self-enrol 2FA
// unless org-wide enforcement was on. The 2FA endpoints themselves
// (/admin/auth/2fa/enrol, /confirm, /disable) are ungated for any signed-in
// admin, so this route is deliberately reachable by every role.

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ShieldCheck } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { adminApi } from '@/api/admin';
import { apiError } from '@/api/client';
import { useCan, ROLE_PERMS } from '@/lib/rbac';
import { formatDateTime } from '@/lib/utils';

export function AccountPage() {
  const { me } = useCan();
  const perms = me ? (me.permissions?.length ? me.permissions : ROLE_PERMS[me.role] ?? []) : [];
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">My account</h1>
        <p className="text-muted-foreground">Your sign-in security and what your role can do.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Signed in as</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {me ? (
            <>
              <div><span className="text-muted-foreground w-32 inline-block">Name</span>{me.displayName || '—'}</div>
              <div><span className="text-muted-foreground w-32 inline-block">Email</span>{me.email}</div>
              <div className="flex items-center">
                <span className="text-muted-foreground w-32 inline-block">Role</span>
                <Badge className="capitalize">{me.role.replace('_', ' ')}</Badge>
              </div>
              <div><span className="text-muted-foreground w-32 inline-block">Last login</span>{me.lastLoginAt ? formatDateTime(me.lastLoginAt) : '—'}</div>
              <div className="pt-2">
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1">Permissions</div>
                <div className="flex flex-wrap gap-1">
                  {perms.map((p) => (
                    <span key={p} className="font-mono text-[11px] rounded bg-muted px-1.5 py-0.5">{p === '*' ? '* (everything)' : p}</span>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground mt-1">
                  Enforced by the backend on every request; the console only hides what you cannot do.
                </p>
              </div>
            </>
          ) : (
            <div className="text-muted-foreground">Loading…</div>
          )}
        </CardContent>
      </Card>

      <TwoFactorCard />
    </div>
  );
}

// 2FA enrol/disable for the signed-in admin (2026-08-25; moved here 2026-09-06).
// Minimal UI: /auth/me does not report enrolment state, so we offer both flows
// and let the backend enforce (enrol errors if already on; disable errors if off).
export function TwoFactorCard() {
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
          Protect your admin sign-in with a TOTP authenticator app.
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
