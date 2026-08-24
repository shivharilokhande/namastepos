import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Utensils, Mail, Lock, User, Store, Eye, EyeOff } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ffApi } from '@/api/namastepos';
import { setSession, setBusinessCache, apiError } from '@/api/client';

// DPDP — bump these every time the published policy text changes. The
// version string is stamped on the consent_event row so we can prove
// what the user actually saw.
const PRIVACY_POLICY_VERSION  = 'privacy-2026-05-26';
const TERMS_OF_SERVICE_VERSION = 'tos-2026-05-26';

export function RegisterPage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  // DPDP requires granular consent. First box mandatory, the others
  // optional and default-OFF (silence is never consent).
  const [agreePolicy, setAgreePolicy] = useState(false);
  const [marketingEmail, setMarketingEmail] = useState(false);
  const [marketingWhatsapp, setMarketingWhatsapp] = useState(false);
  const [showPwd, setShowPwd] = useState(false);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) { toast.error('Email and password required'); return; }
    if (password.length < 8) { toast.error('Password must be at least 8 characters'); return; }
    if (password !== confirm) { toast.error('Passwords do not match'); return; }
    if (!agreePolicy) {
      toast.error('Please accept the Privacy Policy and Terms of Service');
      return;
    }
    setBusy(true);
    try {
      const { token, refreshToken, business } = await ffApi.register({
        email, password, name: name || undefined, businessName: businessName || undefined,
      });
      setSession(token, refreshToken);
      setBusinessCache(business);

      // DPDP — record the consents immediately so the audit trail
      // starts the same instant the account exists. Best-effort: if
      // the call fails (transient network), the next /me/consents
      // check will reveal the gap so the app can re-prompt. We
      // deliberately don't block the happy path.
      try {
        await ffApi.recordConsent({
          consentKey: 'privacy_policy', granted: true,
          policyVersion: PRIVACY_POLICY_VERSION,
          context: { flow: 'registration' },
        });
        await ffApi.recordConsent({
          consentKey: 'terms_of_service', granted: true,
          policyVersion: TERMS_OF_SERVICE_VERSION,
          context: { flow: 'registration' },
        });
        if (marketingEmail) {
          await ffApi.recordConsent({
            consentKey: 'marketing_email', granted: true,
            context: { flow: 'registration' },
          });
        }
        if (marketingWhatsapp) {
          await ffApi.recordConsent({
            consentKey: 'marketing_whatsapp', granted: true,
            context: { flow: 'registration' },
          });
        }
      } catch (_) { /* non-fatal */ }

      toast.success('Welcome aboard! You\'re on the Starter plan.');
      navigate('/');
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary/10 via-background to-secondary/5 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-primary text-primary-foreground mb-2">
            <Utensils className="h-6 w-6" />
          </div>
          <CardTitle>Create your account</CardTitle>
          <CardDescription>Free Starter plan — no credit card needed</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-3">
            <div>
              <Label>Your name (optional)</Label>
              <div className="relative">
                <User className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                <Input className="pl-10" value={name}
                  onChange={(e) => setName(e.target.value)} />
              </div>
            </div>
            <div>
              <Label>Business name</Label>
              <div className="relative">
                <Store className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                <Input className="pl-10" value={businessName}
                  placeholder="Shiv's Cafe"
                  onChange={(e) => setBusinessName(e.target.value)} />
              </div>
            </div>
            <div>
              <Label>Email *</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                <Input className="pl-10" type="email" required value={email}
                  onChange={(e) => setEmail(e.target.value)} />
              </div>
            </div>
            <div>
              <Label>Password * (8+ characters)</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                <Input className="pl-10 pr-10" type={showPwd ? 'text' : 'password'}
                  required value={password}
                  onChange={(e) => setPassword(e.target.value)} />
                <button type="button" className="absolute right-3 top-3 text-muted-foreground"
                  onClick={() => setShowPwd((v) => !v)}>
                  {showPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <div>
              <Label>Confirm password *</Label>
              <Input type={showPwd ? 'text' : 'password'} required value={confirm}
                onChange={(e) => setConfirm(e.target.value)} />
            </div>
            {/* DPDP — granular consent. First box mandatory; others
                optional and default to OFF. */}
            <label className="flex items-start gap-2 text-xs text-muted-foreground pt-1">
              <input type="checkbox" checked={agreePolicy}
                onChange={(e) => setAgreePolicy(e.target.checked)} />
              <span>
                I have read &amp; accept NamastePOS's{' '}
                <Link to="/legal/privacy" target="_blank" className="underline">Privacy Policy</Link>
                {' '}and{' '}
                <Link to="/legal/terms" target="_blank" className="underline">Terms of Service</Link> *
              </span>
            </label>
            <label className="flex items-start gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={marketingEmail}
                onChange={(e) => setMarketingEmail(e.target.checked)} />
              Send me product updates &amp; tips by email (optional)
            </label>
            <label className="flex items-start gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={marketingWhatsapp}
                onChange={(e) => setMarketingWhatsapp(e.target.checked)} />
              Send me product updates on WhatsApp (optional)
            </label>
            <p className="text-[11px] text-muted-foreground italic pt-1">
              You can withdraw any consent at any time from Settings → Privacy.
              Withdrawal is as easy as opting in.
            </p>
            <Button type="submit" disabled={busy} className="w-full h-11 text-base font-bold">
              {busy ? 'Creating account…' : 'Create account'}
            </Button>
          </form>
          <p className="text-sm text-center text-muted-foreground mt-4">
            Already have an account?{' '}
            <Link to="/login" className="text-primary font-semibold hover:underline">
              Log in
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
