// DPDP — owner-facing privacy control center.
//
// Lets the signed-in business owner:
//   - See the current state of every consent key they've granted
//   - Toggle each consent on/off (writes an append-only consent_event)
//   - Download their data (DPDP s.11 — right to portability)
//   - File a correction request (DPDP s.11 — right to correction)
//   - Delete their account (DPDP s.12 — right to erasure)
//   - File a grievance with the Grievance Officer (DPDP s.13)
//
// The page is reachable via /privacy from the Settings sidebar.

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ffApi } from '@/api/namastepos';
import { setSession, apiError } from '@/api/client';

// Founder bug (2026-08-25): apiError() only surfaces the top-level `message`,
// so Joi rejections rendered as an unhelpful "BAD_REQUEST: Validation failed".
// The backend's validate middleware puts per-field reasons in `details`
// (e.g. `body.subject: "subject" is required`) — append the first one so the
// user can actually see WHICH field failed.
function friendlyError(err: unknown): string {
  const base = apiError(err);
  const details = (err as any)?.response?.data?.details;
  return Array.isArray(details) && details.length > 0
    ? `${base} — ${details[0]}`
    : base;
}

type Consent = {
  consentKey: string;
  granted: boolean;
  policyVersion?: string | null;
  source: string;
  recordedAt: string;
};

// Keys the user can toggle themselves. We deliberately do NOT expose
// `privacy_policy` / `terms_of_service` here — those are non-optional
// while the account exists (they were granted at registration, and a
// withdrawal there is equivalent to account deletion).
const TOGGLEABLE_KEYS: Array<{ key: string; label: string; help: string }> = [
  { key: 'marketing_email',     label: 'Marketing emails',
    help: 'Product updates, tips and offers in your inbox.' },
  { key: 'marketing_whatsapp',  label: 'Marketing on WhatsApp',
    help: 'Same content, but on WhatsApp Business.' },
  { key: 'marketing_sms',       label: 'Marketing SMS',
    help: 'Promotional SMS (rare — only for major launches).' },
  { key: 'cookies_analytics',   label: 'Analytics cookies',
    help: 'Helps us measure feature usage. No third-party sharing.' },
  { key: 'cookies_marketing',   label: 'Marketing cookies',
    help: 'Used to measure ad performance on external networks.' },
];

export function PrivacyPage() {
  const navigate = useNavigate();
  const [consents, setConsents] = useState<Consent[]>([]);
  const [loading, setLoading] = useState(true);
  const [officer, setOfficer] = useState<any>(null);
  // Founder bug (2026-08-25): /compliance/grievance is a public endpoint that
  // (for anonymous filers) needs a contact email/phone — fields this page
  // never collected, so filings failed validation. We already know who the
  // signed-in owner is: load the profile once and attach name/email/business
  // to the grievance instead of making the founder retype them.
  const [me, setMe] = useState<any>(null);

  // Grievance form
  const [grievSubject, setGrievSubject] = useState('');
  const [grievBody, setGrievBody] = useState('');
  const [grievCategory, setGrievCategory] = useState('privacy');
  const [grievBusy, setGrievBusy] = useState(false);

  // Correction form
  const [corField, setCorField] = useState('');
  const [corValue, setCorValue] = useState('');
  const [corReason, setCorReason] = useState('');
  const [corBusy, setCorBusy] = useState(false);

  const [eraseBusy, setEraseBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);

  useEffect(() => { void reload(); /* eslint-disable-line */ }, []);

  async function reload() {
    setLoading(true);
    try {
      const [c, g, m] = await Promise.all([
        ffApi.currentConsents(),
        ffApi.grievanceOfficer().catch(() => null),
        // Best-effort — the page still works if the profile call fails; the
        // backend also falls back to the JWT's email for signed-in filers.
        ffApi.me().catch(() => null),
      ]);
      setConsents(c || []);
      setOfficer(g);
      setMe(m);
    } catch (err) {
      toast.error(friendlyError(err));
    } finally {
      setLoading(false);
    }
  }

  function consentGranted(key: string): boolean {
    return !!consents.find((c) => c.consentKey === key && c.granted);
  }

  async function toggleConsent(key: string, granted: boolean) {
    try {
      await ffApi.recordConsent({ consentKey: key, granted, source: 'dashboard',
        context: { surface: 'privacy_page' } });
      toast.success(granted ? 'Consent recorded' : 'Consent withdrawn');
      await reload();
    } catch (err) {
      toast.error(friendlyError(err));
    }
  }

  async function onExport() {
    setExportBusy(true);
    try {
      const data = await ffApi.exportMyData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `namastepos-data-export.json`;
      a.click(); URL.revokeObjectURL(url);
      toast.success('Your data has been exported.');
    } catch (err) {
      toast.error(friendlyError(err));
    } finally {
      setExportBusy(false);
    }
  }

  async function onErase() {
    if (!window.confirm(
      'Delete your account?\n\nWe will anonymise your direct identifiers immediately. ' +
      'Records we are legally required to keep (e.g. tax invoices) will be retained ' +
      'for the period required by law and then deleted.\n\nThis cannot be undone.'
    )) return;
    setEraseBusy(true);
    try {
      await ffApi.eraseMyAccount();
      toast.success('Your account has been erased.');
      setSession(null, null);
      navigate('/login', { replace: true });
    } catch (err) {
      toast.error(friendlyError(err));
    } finally {
      setEraseBusy(false);
    }
  }

  async function onFileCorrection(e: React.FormEvent) {
    e.preventDefault();
    if (!corField || !corValue) return;
    setCorBusy(true);
    try {
      await ffApi.fileCorrection({ field: corField, newValue: corValue, reason: corReason });
      toast.success('Correction request filed. Our team will review within 30 days.');
      setCorField(''); setCorValue(''); setCorReason('');
    } catch (err) {
      toast.error(friendlyError(err));
    } finally {
      setCorBusy(false);
    }
  }

  async function onFileGrievance(e: React.FormEvent) {
    e.preventDefault();
    if (!grievSubject || !grievBody) return;
    setGrievBusy(true);
    try {
      // 2026-08-25: include the signed-in owner's identity so the Grievance
      // Officer has a reply channel (the public endpoint requires a contact
      // for anonymous filers) and the complaint is linked to this business.
      // Keys are only sent when we have a value — the backend rejects
      // unknown/empty-invalid fields (allowUnknown: false).
      await ffApi.fileGrievance({
        subject: grievSubject, body: grievBody, category: grievCategory,
        ...(me?.user?.email ? { complainantEmail: me.user.email } : {}),
        ...(me?.user?.displayName ? { complainantName: me.user.displayName } : {}),
        ...(me?.business?.id ? { businessId: me.business.id } : {}),
      });
      toast.success('Grievance filed. You will hear back from the Grievance Officer.');
      setGrievSubject(''); setGrievBody(''); setGrievCategory('privacy');
    } catch (err) {
      toast.error(friendlyError(err));
    } finally {
      setGrievBusy(false);
    }
  }

  if (loading) {
    return <div className="p-6"><div className="text-muted-foreground">Loading…</div></div>;
  }

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold">Privacy &amp; data</h1>
        <p className="text-sm text-muted-foreground">
          Manage your consents, download your data, or delete your account.
          Your rights under the DPDP Act 2023.
        </p>
      </div>

      {/* Consents */}
      <Card>
        <CardHeader>
          <CardTitle>Communication preferences</CardTitle>
          <CardDescription>
            Turn each one on or off. Withdrawal takes effect immediately.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {TOGGLEABLE_KEYS.map(({ key, label, help }) => (
            <div key={key} className="flex items-start justify-between gap-4 border-b last:border-b-0 pb-2">
              <div className="flex-1">
                <div className="font-medium">{label}</div>
                <div className="text-xs text-muted-foreground">{help}</div>
              </div>
              <label className="inline-flex items-center cursor-pointer">
                <input type="checkbox"
                  checked={consentGranted(key)}
                  onChange={(e) => toggleConsent(key, e.target.checked)}
                  className="w-5 h-5"
                  aria-label={label} />
              </label>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Export + Erase */}
      <Card>
        <CardHeader>
          <CardTitle>Your data</CardTitle>
          <CardDescription>
            Download a full copy of everything we hold on you, or delete your account.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Button variant="outline" disabled={exportBusy} onClick={onExport}>
            {exportBusy ? 'Preparing…' : 'Download my data (JSON)'}
          </Button>
          <Button variant="destructive" disabled={eraseBusy} onClick={onErase}>
            {eraseBusy ? 'Working…' : 'Delete my account'}
          </Button>
        </CardContent>
      </Card>

      {/* Correction */}
      <Card>
        <CardHeader>
          <CardTitle>Request a correction</CardTitle>
          <CardDescription>
            Spot something wrong in your profile or business data? File a correction
            request and we'll respond within 30 days.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onFileCorrection} className="space-y-3">
            <div>
              <Label>Field to correct</Label>
              <Input value={corField} onChange={(e) => setCorField(e.target.value)}
                placeholder="e.g. business address" required />
            </div>
            <div>
              <Label>Correct value</Label>
              <Input value={corValue} onChange={(e) => setCorValue(e.target.value)} required />
            </div>
            <div>
              <Label>Why (optional)</Label>
              <textarea className="w-full border rounded p-2 text-sm"
                value={corReason} onChange={(e) => setCorReason(e.target.value)} rows={2} />
            </div>
            <Button type="submit" disabled={corBusy}>
              {corBusy ? 'Filing…' : 'File correction request'}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Grievance officer */}
      <Card>
        <CardHeader>
          <CardTitle>Grievance Officer</CardTitle>
          <CardDescription>
            Under the DPDP Act 2023, you can escalate any privacy concern to our
            Grievance Officer. Acknowledged within 48 hours, resolved within 30 days.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {officer?.grievanceOfficer?.name ? (
            <div className="rounded border p-3 bg-muted/30 text-sm space-y-1">
              <div><strong>Name:</strong> {officer.grievanceOfficer.name}</div>
              {officer.grievanceOfficer.email && (
                <div><strong>Email:</strong> {officer.grievanceOfficer.email}</div>
              )}
              {officer.grievanceOfficer.phone && (
                <div><strong>Phone:</strong> {officer.grievanceOfficer.phone}</div>
              )}
              {officer.grievanceOfficer.address && (
                <div><strong>Address:</strong> {officer.grievanceOfficer.address}</div>
              )}
            </div>
          ) : (
            <div className="text-xs italic text-muted-foreground">
              Grievance Officer contact will be published here once finalised.
            </div>
          )}
          <form onSubmit={onFileGrievance} className="space-y-3 pt-2">
            <div>
              <Label>Category</Label>
              <select className="w-full border rounded h-9 px-2"
                value={grievCategory} onChange={(e) => setGrievCategory(e.target.value)}>
                <option value="privacy">Privacy</option>
                <option value="data_misuse">Data misuse</option>
                <option value="consent">Consent</option>
                <option value="security">Security</option>
                <option value="billing">Billing</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div>
              <Label>Subject</Label>
              <Input value={grievSubject}
                onChange={(e) => setGrievSubject(e.target.value)} required />
            </div>
            <div>
              <Label>Details</Label>
              <textarea className="w-full border rounded p-2 text-sm" rows={4}
                value={grievBody} onChange={(e) => setGrievBody(e.target.value)} required />
            </div>
            <Button type="submit" disabled={grievBusy}>
              {grievBusy ? 'Filing…' : 'File grievance'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
