import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Utensils } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { adminApi } from '@/api/admin';
import { setAdminToken, apiError } from '@/api/client';

export function LoginPage() {
  const navigate = useNavigate();
  // Hardcode-audit fix (2026-08-24): never prefill the super-admin
  // identity — it disclosed half the highest-privilege credential pair.
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  // 2FA fix (2026-08-25): login can return a challenge instead of a token for
  // admins with 2FA enrolled. Previously we destructured only { token } and
  // silently stored undefined → enrolled admins could never sign in. Now we
  // switch to a TOTP step and POST to /admin/auth/2fa/verify.
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const r = await adminApi.login(email, password);
      if (r.requires2fa && r.challengeId) {
        setChallengeId(r.challengeId);
      } else if (r.token) {
        setAdminToken(r.token);
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
      const { token } = await adminApi.verify2fa(challengeId, code.trim());
      setAdminToken(token);
      navigate('/');
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setLoading(false);
    }
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
            {challengeId ? 'Enter your 2FA code' : 'Platform operator sign-in'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!challengeId ? (
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
          ) : (
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
              <Button type="button" variant="ghost" className="w-full"
                      onClick={() => { setChallengeId(null); setCode(''); }}>
                Back
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
