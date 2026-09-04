import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Utensils } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { adminApi } from '@/api/admin';
import { setAdminToken, establishSession, apiError } from '@/api/client';

type Step = 'login' | '2fa' | 'enrol';

export function LoginPage() {
  const navigate = useNavigate();
  // Hardcode-audit fix (2026-08-24): never prefill the super-admin
  // identity — it disclosed half the highest-privilege credential pair.
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<Step>('login');
  // 2FA fix (2026-08-25): login can return a challenge instead of a token for
  // admins with 2FA enrolled. Now we switch to a TOTP step and verify.
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  // Enforced-enrolment (2026-08-28): org-wide 2FA is on and this admin hasn't
  // enrolled — login returns an enrol-only token, and we force setup here.
  const [enrol, setEnrol] = useState<{ otpauth: string; secret: string; recoveryCodes: string[] } | null>(null);
  const [enrolCode, setEnrolCode] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const r = await adminApi.login(email, password);
      if (r.requires2fa && r.challengeId) {
        setChallengeId(r.challengeId);
        setStep('2fa');
      } else if (r.mustEnrol2fa) {
        // The response already set the enrol-only session cookie; confirm it
        // round-trips, then kick off setup immediately. (2026-09-04: no token
        // is returned any more — the cookie IS the session.)
        await establishSession();
        const data = await adminApi.enrol2faStart();
        setEnrol(data);
        setStep('enrol');
      } else if (r.authenticated) {
        await establishSession();
        navigate('/');
      } else {
        toast.error('Unexpected login response');
      }
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setLoading(false);
    }
  };

  const submitCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!challengeId) return;
    setLoading(true);
    try {
      await adminApi.verify2fa(challengeId, code.trim()); // sets the session cookie
      await establishSession();
      navigate('/');
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setLoading(false);
    }
  };

  const submitEnrol = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const r = await adminApi.enrol2faConfirm(enrolCode.trim());
      // The confirm response swapped the enrol-only cookie for a full session.
      if (r.authenticated) await establishSession();
      toast.success('2FA enabled');
      navigate('/');
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setLoading(false);
    }
  };

  const backToLogin = () => {
    setStep('login'); setChallengeId(null); setCode('');
    setEnrol(null); setEnrolCode(''); setAdminToken(null);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary/10 via-background to-secondary/5 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-primary text-primary-foreground mb-2">
            <Utensils className="h-6 w-6" />
          </div>
          <CardTitle>NamastePOS Super Admin</CardTitle>
          <CardDescription>
            {step === '2fa' ? 'Enter your 2FA code'
              : step === 'enrol' ? 'Two-factor setup required'
              : 'Platform operator sign-in'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {step === 'login' && (
            <form onSubmit={submit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" value={email}
                       onChange={(e) => setEmail(e.target.value)} required autoFocus />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input id="password" type="password" value={password}
                       onChange={(e) => setPassword(e.target.value)} required />
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>
          )}

          {step === '2fa' && (
            <form onSubmit={submitCode} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="code">Authenticator code</Label>
                <Input id="code" inputMode="numeric" autoComplete="one-time-code"
                       placeholder="6-digit code or recovery code"
                       value={code} onChange={(e) => setCode(e.target.value)}
                       required autoFocus />
                <p className="text-xs text-muted-foreground">
                  Enter the code from your authenticator app, or a recovery code.
                </p>
              </div>
              <Button type="submit" className="w-full" disabled={loading || code.trim().length < 6}>
                {loading ? 'Verifying…' : 'Verify & sign in'}
              </Button>
              <Button type="button" variant="ghost" className="w-full" onClick={backToLogin}>
                Back
              </Button>
            </form>
          )}

          {step === 'enrol' && enrol && (
            <form onSubmit={submitEnrol} className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Your organization requires two-factor authentication. Add this secret to an
                authenticator app (Google Authenticator, Authy…), then enter the current
                6-digit code to finish signing in.
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
              <div className="space-y-2">
                <Label htmlFor="enrolCode">Confirmation code</Label>
                <Input id="enrolCode" inputMode="numeric" autoComplete="one-time-code"
                       placeholder="6-digit code" value={enrolCode}
                       onChange={(e) => setEnrolCode(e.target.value)} required autoFocus />
              </div>
              <Button type="submit" className="w-full" disabled={loading || enrolCode.trim().length !== 6}>
                {loading ? 'Confirming…' : 'Confirm & continue'}
              </Button>
              <Button type="button" variant="ghost" className="w-full" onClick={backToLogin}>
                Cancel
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
