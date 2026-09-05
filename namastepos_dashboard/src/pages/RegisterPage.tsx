import { useEffect, useState } from 'react';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { GoogleLogin, CredentialResponse } from '@react-oauth/google';
import {
  Utensils, Mail, Lock, User, Store, Eye, EyeOff,
  CreditCard, CalendarClock, WifiOff,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ffApi } from '@/api/namastepos';
import { setSession, setBusinessCache, apiError } from '@/api/client';
import { trackSignup, trackBusinessCreated } from '@/lib/activation';

// DPDP — bump these every time the published policy text changes. The
// version string is stamped on the consent_event row so we can prove
// what the user actually saw.
const PRIVACY_POLICY_VERSION  = 'privacy-2026-05-26';
const TERMS_OF_SERVICE_VERSION = 'tos-2026-05-26';

/**
 * Trial length shown on this page.
 *
 * The authoritative value is the backend's `TRIAL_DAYS` env var, which is not
 * exposed on any public endpoint. It is 7 today, and "7-day free trial, no
 * card" is stated on every acquisition surface (landing hero, all five pricing
 * cards, FAQ, meta description, blog CTAs). Leaving the promise OFF the page
 * where the visitor actually decides is the larger error, so it is stated here
 * and this constant is the one place to change if TRIAL_DAYS ever moves.
 */
const TRIAL_DAYS = 7;

interface PublicPlan {
  tier: string;
  name: string;
  priceInr: number;
  featureKeys?: string[];
}

export function RegisterPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const referralCode = searchParams.get('ref') || undefined; // L2 referral link
  // 2026-09-04 (pricing audit F-01/F-02): the plan card the visitor clicked,
  // e.g. /register?plan=pro_plan. The backend provisions the 7-day trial on
  // that plan instead of always on Starter — before this, every "Start free
  // trial" button, on every card, produced a Starter account with a 10-item
  // menu. Validated server-side against active/public/shared plans, so a
  // hand-typed value cannot grant anything.
  const planTier = searchParams.get('plan')?.trim() || undefined;
  const [name, setName] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // "Confirm password" was removed (2026-09-05, signup audit). It is a field
  // every visitor has to type twice on a phone keyboard, and the show/hide eye
  // below already lets them read what they typed — which is the same
  // protection with none of the friction. Password can be reset by email.
  //
  // Errors used to be toast-only: on a phone the toast appears at the top,
  // often above the fold the visitor is looking at, and it never marks WHICH
  // field is wrong. Now the failing field is named inline and announced.
  const [fieldErr, setFieldErr] = useState<{ email?: string; password?: string; consent?: string }>({});
  // DPDP requires granular consent. First box mandatory, the others
  // optional and default-OFF (silence is never consent).
  const [agreePolicy, setAgreePolicy] = useState(false);
  const [marketingEmail, setMarketingEmail] = useState(false);
  const [marketingWhatsapp, setMarketingWhatsapp] = useState(false);
  const [showPwd, setShowPwd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [trialPlan, setTrialPlan] = useState<PublicPlan | null>(null);

  // The register page used to be titled "NamastePOS · Dashboard" — the tab of
  // a product the visitor does not have yet. Name the step they are on.
  useEffect(() => {
    const prev = document.title;
    document.title = 'Create your free NamastePOS account';
    return () => { document.title = prev; };
  }, []);

  // Name what the trial actually grants. The plan comes from the live public
  // catalogue keyed by the ?plan= tier the pricing card passed, never from a
  // hardcoded name — the tier codes do not match the display names (Pro's tier
  // is `pro_plan`, while `pro` is Enterprise), so anything typed here would
  // eventually tell a visitor they are trialling the wrong product. If the
  // call fails or no ?plan= was passed, the reassurance strip simply drops the
  // plan name and keeps the parts that are true of every signup.
  useEffect(() => {
    if (!planTier) return;
    let live = true;
    ffApi.plans()
      .then((list: PublicPlan[]) => {
        if (!live || !Array.isArray(list)) return;
        setTrialPlan(list.find((p) => p.tier === planTier) || null);
      })
      .catch(() => { /* reassurance strip degrades, signup is unaffected */ });
    return () => { live = false; };
  }, [planTier]);

  const trialsGst = !!trialPlan?.featureKeys?.includes('tax_invoices');

  // DPDP — shared consent recorder used by both signup paths.
  const recordSignupConsents = async () => {
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
  };

  // Google sign-up: the backend finds-or-creates the account from the
  // Google token, so this is a full registration path. DPDP consent is
  // still mandatory before the account is created.
  const onGoogle = async (cred: CredentialResponse) => {
    if (!agreePolicy) {
      setFieldErr({ consent: 'Tick this box to continue — it is the only one that is required.' });
      toast.error('Please accept the Privacy Policy and Terms of Service first');
      return;
    }
    if (!cred.credential) { toast.error('Google did not return a token'); return; }
    setFieldErr({});
    setBusy(true);
    try {
      const res = await ffApi.googleLogin(cred.credential, planTier);
      const { token, refreshToken, business } = res;
      setSession(token, refreshToken);
      setBusinessCache(business);
      // Activation funnel. setBusinessCache() first so the analytics
      // identity provider can resolve business_id + signupAt.
      trackSignup({
        method: 'google',
        hasBusinessName: !!business?.name,
        referralCode,
      });
      trackBusinessCreated({
        // Google sign-up is find-or-create; the backend tells us which.
        isNew: res?.isNewBusiness === true,
        category: business?.category || null,
      });
      await recordSignupConsents();
      // 2026-09-04: this said "You're on the Starter plan", which stopped
      // being true when the trial started provisioning the plan the visitor
      // actually chose. Deliberately does not name a plan or a day count —
      // the plan is resolved server-side and the trial length is
      // env-configurable (TRIAL_DAYS), so naming either here would be a
      // second copy of the truth waiting to drift. The exact plan and end
      // date are on Plans & Billing.
      toast.success('Welcome aboard! Your free trial has started — no card needed.');
      navigate('/');
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Validate everything in one pass and mark every failing field, rather
    // than firing one toast, letting the visitor fix it, and firing the next.
    const errs: typeof fieldErr = {};
    if (!email.trim()) errs.email = 'We need an email to create the account.';
    if (!password) errs.password = 'Choose a password.';
    else if (password.length < 8) errs.password = 'A little longer — 8 characters or more.';
    if (!agreePolicy) errs.consent = 'Tick this box to continue — it is the only one that is required.';
    setFieldErr(errs);
    if (Object.keys(errs).length) {
      toast.error('Check the highlighted fields');
      return;
    }
    setBusy(true);
    try {
      const res = await ffApi.register({
        email, password, name: name || undefined, businessName: businessName || undefined,
        referralCode,
        plan: planTier,
      });
      const { token, refreshToken, business } = res;
      setSession(token, refreshToken);
      setBusinessCache(business);

      // Activation funnel — the top of it. No email, no name, no password
      // goes anywhere near this: `signup` carries method + a boolean +
      // the referral code only.
      trackSignup({
        method: 'email',
        hasBusinessName: !!businessName.trim(),
        referralCode,
      });
      trackBusinessCreated({
        isNew: res?.isNewBusiness !== false,
        category: business?.category || null,
      });

      // DPDP — record the consents immediately so the audit trail
      // starts the same instant the account exists. Best-effort: if
      // the call fails (transient network), the next /me/consents
      // check will reveal the gap so the app can re-prompt. We
      // deliberately don't block the happy path.
      await recordSignupConsents();

      // 2026-09-04: this said "You're on the Starter plan", which stopped
      // being true when the trial started provisioning the plan the visitor
      // actually chose. Deliberately does not name a plan or a day count —
      // the plan is resolved server-side and the trial length is
      // env-configurable (TRIAL_DAYS), so naming either here would be a
      // second copy of the truth waiting to drift. The exact plan and end
      // date are on Plans & Billing.
      toast.success('Welcome aboard! Your free trial has started — no card needed.');
      navigate('/');
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    // items-start on a phone: with the keyboard open, vertical centring pushes
    // the card off-screen and the visitor has to scroll to find the button
    // they were already looking at.
    <div className="min-h-screen flex items-start sm:items-center justify-center bg-gradient-to-br from-primary/10 via-background to-secondary/5 p-4 py-8">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center pb-4">
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-primary text-primary-foreground mb-2">
            <Utensils className="h-6 w-6" />
          </div>
          <CardTitle>Create your account</CardTitle>
          <CardDescription>
            {trialPlan && trialPlan.priceInr > 0
              ? `${TRIAL_DAYS} days of ${trialPlan.name} free — no credit card`
              : `${TRIAL_DAYS}-day free trial — no credit card`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* THE PROMISE, AT THE POINT OF DECISION. The landing page carries
              "7-day free trial, no card" on every CTA; the page the click
              lands on used to carry none of it, so the reassurance evaporated
              exactly where the visitor starts typing. Nothing here is a claim
              we cannot show: the trial plan is read from the live catalogue,
              the no-card fact is structural (no card is collected), and the
              day-8 landing is what the backend actually does when a trial
              lapses (authService trial-expiry downgrade to the free plan). */}
          <div className="rounded-lg border bg-muted/40 p-3 mb-4 space-y-2">
            <p className="flex items-start gap-2 text-xs">
              <CreditCard className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
              <span>
                <b>No card, now or at the end.</b> We do not ask for card
                details to start, so nothing can be charged automatically.
              </span>
            </p>
            <p className="flex items-start gap-2 text-xs">
              <CalendarClock className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
              <span>
                <b>Day {TRIAL_DAYS + 1} is a soft landing.</b> When the trial ends
                your account moves to the free Starter plan and you carry on
                billing — the paid features simply switch off until you upgrade.
              </span>
            </p>
            {trialsGst && (
              // Only shown when the trialled plan genuinely carries the
              // `tax_invoices` feature key. GST tax invoices start at Pro
              // (Rs 799); e-invoice-READY documents start at Advanced (filing
              // still needs a GSP/IRP connection). Implying either is free is
              // the error that causes refunds, so this line is gated on the
              // live feature list rather than on the page being the register page.
              <p className="flex items-start gap-2 text-xs">
                <Utensils className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                <span>
                  <b>GST tax invoices are on during the trial.</b> CGST/SGST with
                  HSN per item. They are a {trialPlan?.name} feature — the free
                  Starter plan prints plain invoices and receipts instead.
                </span>
              </p>
            )}
            <p className="flex items-start gap-2 text-xs">
              <WifiOff className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
              <span>
                <b>Bill without a network.</b> Orders are saved on the device and
                sync when the connection returns.
              </span>
            </p>
          </div>

          {/* Google first. The ICP arrives on an Android phone where the
              account is already signed in, so one tap beats four fields and a
              password they will have to invent and then remember. */}
          <div className="flex justify-center">
            <GoogleLogin
              onSuccess={onGoogle}
              onError={() => toast.error('Google sign-up failed')}
              theme="outline"
              size="large"
              text="signup_with"
              shape="rectangular"
              width="320"
            />
          </div>
          <div className="flex items-center gap-3 my-4">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs text-muted-foreground">or use an email</span>
            <div className="h-px flex-1 bg-border" />
          </div>

          <form onSubmit={onSubmit} className="space-y-3" noValidate>
            {/* Email and password are the only two required fields. Name and
                business name are optional and marked as such, because an
                unmarked field reads as compulsory and both are asked again in
                the setup wizard where they actually get used. h-11 inputs:
                the default height is under the 44px touch target and this form
                is filled one-handed on a phone. Every field carries an
                autoComplete hint so Android and iOS password managers can fill
                it. */}
            <div>
              <Label htmlFor="reg-email">Email</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-[0.85rem] h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <Input id="reg-email" className="pl-10 h-11" type="email" value={email}
                  autoComplete="email" inputMode="email" autoCapitalize="none" autoCorrect="off"
                  aria-invalid={!!fieldErr.email}
                  aria-describedby={fieldErr.email ? 'reg-email-err' : undefined}
                  onChange={(e) => { setEmail(e.target.value); setFieldErr((f) => ({ ...f, email: undefined })); }} />
              </div>
              {fieldErr.email && (
                <p id="reg-email-err" className="text-xs text-destructive mt-1">{fieldErr.email}</p>
              )}
            </div>
            <div>
              <Label htmlFor="reg-password">Password (8+ characters)</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-[0.85rem] h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <Input id="reg-password" className="pl-10 pr-11 h-11" type={showPwd ? 'text' : 'password'}
                  value={password} autoComplete="new-password"
                  aria-invalid={!!fieldErr.password}
                  aria-describedby={fieldErr.password ? 'reg-password-err' : undefined}
                  onChange={(e) => { setPassword(e.target.value); setFieldErr((f) => ({ ...f, password: undefined })); }} />
                <button type="button"
                  className="absolute right-1 top-1 h-9 w-9 grid place-items-center text-muted-foreground"
                  aria-label={showPwd ? 'Hide password' : 'Show password'}
                  aria-pressed={showPwd}
                  onClick={() => setShowPwd((v) => !v)}>
                  {showPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {fieldErr.password && (
                <p id="reg-password-err" className="text-xs text-destructive mt-1">{fieldErr.password}</p>
              )}
            </div>
            <div>
              <Label htmlFor="reg-business">Restaurant name <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <div className="relative">
                <Store className="absolute left-3 top-[0.85rem] h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <Input id="reg-business" className="pl-10 h-11" value={businessName}
                  placeholder="Shiv's Cafe" autoComplete="organization"
                  onChange={(e) => setBusinessName(e.target.value)} />
              </div>
            </div>
            <div>
              <Label htmlFor="reg-name">Your name <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <div className="relative">
                <User className="absolute left-3 top-[0.85rem] h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <Input id="reg-name" className="pl-10 h-11" value={name} autoComplete="name"
                  onChange={(e) => setName(e.target.value)} />
              </div>
            </div>
            {/* DPDP — granular consent. First box mandatory; others
                optional and default to OFF. */}
            <label className={`flex items-start gap-2 text-xs pt-1 ${fieldErr.consent ? 'text-destructive' : 'text-muted-foreground'}`}>
              <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0" checked={agreePolicy}
                aria-invalid={!!fieldErr.consent}
                aria-describedby={fieldErr.consent ? 'reg-consent-err' : undefined}
                onChange={(e) => { setAgreePolicy(e.target.checked); setFieldErr((f) => ({ ...f, consent: undefined })); }} />
              <span>
                I have read &amp; accept NamastePOS's{' '}
                <Link to="/legal/privacy" target="_blank" className="underline">Privacy Policy</Link>
                {' '}and{' '}
                <Link to="/legal/terms" target="_blank" className="underline">Terms of Service</Link> *
              </span>
            </label>
            {fieldErr.consent && (
              <p id="reg-consent-err" className="text-xs text-destructive">{fieldErr.consent}</p>
            )}
            <label className="flex items-start gap-2 text-xs text-muted-foreground">
              <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0" checked={marketingEmail}
                onChange={(e) => setMarketingEmail(e.target.checked)} />
              Send me product updates &amp; tips by email (optional)
            </label>
            <label className="flex items-start gap-2 text-xs text-muted-foreground">
              <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0" checked={marketingWhatsapp}
                onChange={(e) => setMarketingWhatsapp(e.target.checked)} />
              Send me product updates on WhatsApp (optional)
            </label>
            <p className="text-[11px] text-muted-foreground italic pt-1">
              You can withdraw any consent at any time from Settings → Privacy.
              Withdrawal is as easy as opting in.
            </p>
            <Button type="submit" disabled={busy} className="w-full h-12 text-base font-bold">
              {busy ? 'Creating account…' : 'Start free — no card'}
            </Button>
            <p className="text-[11px] text-center text-muted-foreground">
              Free to start. Paid plans are billed per register, monthly, with no lock-in.
            </p>
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
