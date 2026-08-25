import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { GoogleLogin, CredentialResponse } from '@react-oauth/google';
import { toast } from 'sonner';
import { Utensils, Mail, Lock, Eye, EyeOff, KeyRound } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ffApi } from '@/api/namastepos';
import { api, setSession, setBusinessCache, getBusinessCache, apiError } from '@/api/client';

// Shape returned by POST /auth/staff-picker (Push 14b): active, non-owner
// staff of a business who have a PIN set. The owner never appears here —
// owners sign in with email/password or Google, same as mobile.
type StaffPickerEntry = { userId: string; role: string; displayName: string };

export function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [busy, setBusy] = useState(false);

  // --- Staff PIN sign-in (2026-08-25, founder bug #8 + gap E) ---
  // WHY: mobile has had PIN staff login since Push 14; the dashboard only
  // offered email/password + Google, so staff on shop PCs ended up sharing
  // the owner's password. Same flow as mobile's pin_login_screen: it needs
  // a businessId cached from a previous OWNER login on this device
  // (staff-picker is business-scoped and staff don't know the UUID).
  // NOTE: OTP/SMS login is deliberately NOT added here — SMS isn't
  // configured in prod yet; OTP UI is deferred until MSG91 DLT approval.
  const [staffMode, setStaffMode] = useState(false);
  const [staffList, setStaffList] = useState<StaffPickerEntry[] | null>(null);
  const [staffLoading, setStaffLoading] = useState(false);
  const [selectedStaff, setSelectedStaff] = useState<StaffPickerEntry | null>(null);
  const [pin, setPin] = useState('');
  const [pinBusy, setPinBusy] = useState(false);
  // Read once per render — setBusinessCache() only ever runs on the way out
  // of this page, so there's no staleness risk while the form is open.
  const cachedBusiness = getBusinessCache();

  const finish = (token: string, refreshToken: string, business: any) => {
    setSession(token, refreshToken);
    setBusinessCache(business);
    navigate('/');
  };

  const onGoogle = async (cred: CredentialResponse) => {
    if (!cred.credential) { toast.error('Google did not return a token'); return; }
    try {
      const { token, refreshToken, business } = await ffApi.googleLogin(cred.credential);
      finish(token, refreshToken, business);
    } catch (err) {
      toast.error(apiError(err));
    }
  };

  const onPasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) { toast.error('Enter email and password'); return; }
    setBusy(true);
    try {
      const { token, refreshToken, business } = await ffApi.passwordLogin(email, password);
      finish(token, refreshToken, business);
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleStaffMode = async () => {
    const opening = !staffMode;
    setStaffMode(opening);
    // Fetch the picker list lazily on first open (not on mount) so the
    // common owner-login path never pays for the extra request.
    if (!opening || !cachedBusiness?.id || staffList !== null) return;
    setStaffLoading(true);
    try {
      // POST /auth/staff-picker { businessId } -> { staff: StaffPickerEntry[] }
      const { staff } = await api
        .post('/auth/staff-picker', { businessId: cachedBusiness.id })
        .then((r) => r.data as { staff: StaffPickerEntry[] });
      setStaffList(staff ?? []);
    } catch (err) {
      toast.error(apiError(err));
      setStaffList(null); // retryable on next toggle
      setStaffMode(false);
    } finally {
      setStaffLoading(false);
    }
  };

  const onPinLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cachedBusiness?.id || !selectedStaff) return;
    // Backend Joi schema requires exactly 4 digits (pinLoginSchema) —
    // mirror it client-side so users get instant feedback, not a 400.
    if (!/^\d{4}$/.test(pin)) { toast.error('Enter your 4-digit PIN'); return; }
    setPinBusy(true);
    try {
      // POST /auth/pin-login { businessId, userId, pin } returns the same
      // session payload as password/Google login (token, refreshToken,
      // user, business, role, permissions, memberships, plan) — so we can
      // reuse finish() unchanged. refreshToken is blanked by the backend
      // in cookie mode and ignored by setSession(); harmless either way.
      const { token, refreshToken, business } = await api
        .post('/auth/pin-login', {
          businessId: cachedBusiness.id,
          userId: selectedStaff.userId,
          pin,
        })
        .then((r) => r.data);
      finish(token, refreshToken, business);
    } catch (err) {
      // Server messages matter here: the persistent PIN lockout replies
      // "Too many wrong PINs. Try again in N min…" — surface it verbatim
      // via apiError() rather than a generic "wrong PIN".
      toast.error(apiError(err));
      setPin('');
    } finally {
      setPinBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary/10 via-background to-secondary/5 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-primary text-primary-foreground mb-2">
            <Utensils className="h-6 w-6" />
          </div>
          <CardTitle>Welcome back</CardTitle>
          <CardDescription>Sign in to manage your restaurant</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onPasswordLogin} className="space-y-3">
            <div>
              <Label>Email</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                <Input
                  type="email"
                  className="pl-10"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  placeholder="you@example.com"
                />
              </div>
            </div>
            <div>
              <Label>Password</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                <Input
                  type={showPwd ? 'text' : 'password'}
                  className="pl-10 pr-10"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                />
                <button type="button" className="absolute right-3 top-3 text-muted-foreground"
                  onClick={() => setShowPwd((v) => !v)}>
                  {showPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <Button type="submit" disabled={busy} className="w-full h-11 text-base font-bold">
              {busy ? 'Signing in…' : 'Log in'}
            </Button>
          </form>

          <div className="flex items-center gap-3 my-5">
            <div className="flex-1 h-px bg-border" />
            <span className="text-xs font-bold text-muted-foreground tracking-widest">OR</span>
            <div className="flex-1 h-px bg-border" />
          </div>

          <div className="flex justify-center">
            <GoogleLogin
              onSuccess={onGoogle}
              onError={() => toast.error('Google sign-in failed')}
              theme="outline"
              size="large"
              text="continue_with"
              shape="rectangular"
            />
          </div>

          {/* Staff PIN sign-in (founder bug #8 + gap E, 2026-08-25) —
              parity with mobile's pin_login_screen. OTP UI deferred until
              MSG91 DLT approval; do not add an SMS option here yet. */}
          <div className="mt-5">
            <button
              type="button"
              onClick={toggleStaffMode}
              className="w-full flex items-center justify-center gap-2 text-sm font-semibold text-primary hover:underline"
            >
              <KeyRound className="h-4 w-4" />
              {staffMode ? 'Hide staff sign-in' : 'Sign in as staff (PIN)'}
            </button>

            {staffMode && (
              <div className="mt-4 rounded-lg border bg-muted/30 p-4">
                {!cachedBusiness?.id ? (
                  // Mobile parity: staff-picker needs a businessId, which we
                  // only have after an owner login cached the business here.
                  <p className="text-sm text-center text-muted-foreground">
                    Ask the owner to sign in once on this device first.
                  </p>
                ) : staffLoading ? (
                  <p className="text-sm text-center text-muted-foreground">Loading staff…</p>
                ) : staffList && staffList.length === 0 ? (
                  <p className="text-sm text-center text-muted-foreground">
                    No staff with a PIN yet. The owner can set PINs from Staff settings.
                  </p>
                ) : (
                  <form onSubmit={onPinLogin} className="space-y-3">
                    <p className="text-xs font-semibold text-muted-foreground text-center">
                      {cachedBusiness?.name ? `Staff of ${cachedBusiness.name}` : 'Select your name'}
                    </p>
                    <div className="flex flex-wrap justify-center gap-2">
                      {(staffList ?? []).map((s) => (
                        <button
                          key={s.userId}
                          type="button"
                          onClick={() => { setSelectedStaff(s); setPin(''); }}
                          className={`rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
                            selectedStaff?.userId === s.userId
                              ? 'bg-primary text-primary-foreground border-primary'
                              : 'bg-background hover:bg-accent'
                          }`}
                        >
                          {s.displayName}
                          <span className="ml-1 text-xs opacity-70">({s.role})</span>
                        </button>
                      ))}
                    </div>
                    {selectedStaff && (
                      <>
                        <div>
                          <Label>PIN for {selectedStaff.displayName}</Label>
                          <Input
                            type="password"
                            inputMode="numeric"
                            autoComplete="off"
                            maxLength={4}
                            className="text-center tracking-[0.5em] font-bold"
                            placeholder="••••"
                            value={pin}
                            // Digits only — backend accepts exactly 4 numeric chars.
                            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                          />
                        </div>
                        <Button
                          type="submit"
                          disabled={pinBusy || pin.length !== 4}
                          className="w-full h-11 text-base font-bold"
                        >
                          {pinBusy ? 'Signing in…' : 'Sign in with PIN'}
                        </Button>
                      </>
                    )}
                  </form>
                )}
              </div>
            )}
          </div>

          <p className="text-sm text-center text-muted-foreground mt-5">
            Don't have an account?{' '}
            <Link to="/register" className="text-primary font-semibold hover:underline">
              Create one
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
