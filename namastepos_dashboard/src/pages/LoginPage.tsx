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
import { api, setSession, setBusinessCache, apiError } from '@/api/client';
import { trackSignup, trackBusinessCreated } from '@/lib/activation';

// Phone-first staff sign-in (2026-08-26): a staffer enters their mobile
// number and POST /auth/staff-resolve returns the outlet(s) they belong to.
// No owner pre-login needed — a kitchen/counter PC works standalone.
type Outlet = {
  userId: string; businessId: string; role: string;
  displayName: string; businessName: string;
};

export function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [busy, setBusy] = useState(false);

  // --- Staff phone+PIN sign-in (2026-08-26) ---
  // A kitchen/counter PC can sign a staffer in with just their mobile number
  // and PIN — no owner login required first. Mirrors the mobile app.
  const [staffMode, setStaffMode] = useState(false);
  const [staffPhone, setStaffPhone] = useState('');
  const [outlets, setOutlets] = useState<Outlet[] | null>(null);
  const [resolving, setResolving] = useState(false);
  const [selectedOutlet, setSelectedOutlet] = useState<Outlet | null>(null);
  const [pin, setPin] = useState('');
  const [pinBusy, setPinBusy] = useState(false);

  const finish = (token: string, refreshToken: string, business: any) => {
    setSession(token, refreshToken);
    setBusinessCache(business);
    navigate('/');
  };

  const onGoogle = async (cred: CredentialResponse) => {
    if (!cred.credential) { toast.error('Google did not return a token'); return; }
    try {
      const res = await ffApi.googleLogin(cred.credential);
      const { token, refreshToken, business } = res;
      finish(token, refreshToken, business);
      // Activation funnel: /auth/google is find-or-create, so "Continue
      // with Google" on the LOGIN screen is also a real signup path (which
      // matters — every public CTA currently lands strangers here, not on
      // /register). Only fires when the backend says the account/business
      // was actually created.
      if (res?.isNewUser === true || res?.isNewBusiness === true) {
        trackSignup({
          method: 'google',
          hasBusinessName: !!business?.name,
          referralCode: null,
        });
        trackBusinessCreated({
          isNew: res?.isNewBusiness === true,
          category: business?.category || null,
        });
      }
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

  const resetStaff = () => {
    setOutlets(null); setSelectedOutlet(null); setPin('');
  };

  const onResolvePhone = async (e: React.FormEvent) => {
    e.preventDefault();
    const phone = staffPhone.trim();
    if (!/^\d{10}$/.test(phone)) { toast.error('Enter a valid 10-digit mobile number'); return; }
    setResolving(true);
    try {
      // POST /auth/staff-resolve { phone } -> { outlets: Outlet[] }
      const { outlets: list } = await api
        .post('/auth/staff-resolve', { phone })
        .then((r) => r.data as { outlets: Outlet[] });
      if (!list || list.length === 0) {
        toast.error('No staff account found for this number. Ask the owner to add you.');
        return;
      }
      setOutlets(list);
      if (list.length === 1) setSelectedOutlet(list[0]); // skip the picker
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setResolving(false);
    }
  };

  const onPinLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedOutlet) return;
    if (!/^\d{4}$/.test(pin)) { toast.error('Enter your 4-digit PIN'); return; }
    setPinBusy(true);
    try {
      const { token, refreshToken, business } = await api
        .post('/auth/pin-login', {
          businessId: selectedOutlet.businessId,
          userId: selectedOutlet.userId,
          pin,
        })
        .then((r) => r.data);
      finish(token, refreshToken, business);
    } catch (err) {
      // Surface the backend's PIN-lockout message verbatim.
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
              onClick={() => { setStaffMode((v) => !v); if (staffMode) resetStaff(); }}
              className="w-full flex items-center justify-center gap-2 text-sm font-semibold text-primary hover:underline"
            >
              <KeyRound className="h-4 w-4" />
              {staffMode ? 'Hide staff sign-in' : 'Sign in as staff (phone + PIN)'}
            </button>

            {staffMode && (
              <div className="mt-4 rounded-lg border bg-muted/30 p-4">
                {/* Step 1 — phone number */}
                {!outlets && (
                  <form onSubmit={onResolvePhone} className="space-y-3">
                    <p className="text-xs font-semibold text-muted-foreground text-center">
                      Enter the mobile number your owner registered you with.
                    </p>
                    <Input
                      type="tel"
                      inputMode="numeric"
                      autoComplete="off"
                      maxLength={10}
                      placeholder="10-digit mobile number"
                      value={staffPhone}
                      onChange={(e) => setStaffPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
                    />
                    <Button type="submit" disabled={resolving} className="w-full h-11 text-base font-bold">
                      {resolving ? 'Checking…' : 'Continue'}
                    </Button>
                  </form>
                )}

                {/* Step 2 — pick outlet if the number works at more than one */}
                {outlets && !selectedOutlet && (
                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-muted-foreground text-center">Choose your outlet</p>
                    {outlets.map((o) => (
                      <button
                        key={o.businessId}
                        type="button"
                        onClick={() => { setSelectedOutlet(o); setPin(''); }}
                        className="w-full rounded-lg border bg-background px-3 py-2 text-left text-sm font-medium hover:bg-accent"
                      >
                        {o.businessName}
                        <span className="ml-1 text-xs opacity-70">· {o.displayName} ({o.role})</span>
                      </button>
                    ))}
                    <button type="button" onClick={resetStaff}
                      className="w-full text-xs text-muted-foreground hover:underline pt-1">
                      Use a different number
                    </button>
                  </div>
                )}

                {/* Step 3 — PIN */}
                {selectedOutlet && (
                  <form onSubmit={onPinLogin} className="space-y-3">
                    <p className="text-xs font-semibold text-muted-foreground text-center">
                      {selectedOutlet.businessName} · {selectedOutlet.displayName}
                    </p>
                    <div>
                      <Label>Your 4-digit PIN</Label>
                      <Input
                        type="password"
                        inputMode="numeric"
                        autoComplete="off"
                        maxLength={4}
                        className="text-center tracking-[0.5em] font-bold"
                        placeholder="••••"
                        value={pin}
                        onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                        autoFocus
                      />
                    </div>
                    <Button type="submit" disabled={pinBusy || pin.length !== 4}
                      className="w-full h-11 text-base font-bold">
                      {pinBusy ? 'Signing in…' : 'Sign in with PIN'}
                    </Button>
                    <button type="button" onClick={resetStaff}
                      className="w-full text-xs text-muted-foreground hover:underline">
                      Use a different number
                    </button>
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
