// DPDP — public Privacy Policy / Terms of Service pages.
//
// The text below is a starter scaffold that already covers every
// disclosure DPDP s.5(1)/(2) requires (purpose, sharing, retention,
// data subject rights, grievance officer, withdrawal). It is NOT a
// substitute for an Indian Data Protection lawyer's review — task
// #117 / #118 own that follow-up.
//
// Until the lawyer-reviewed text replaces the placeholders, the
// rendered page shows a clear "DRAFT — under legal review" banner so
// it can never be mistaken for the final published policy.

import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { ffApi } from '@/api/namastepos';

type Kind = 'privacy' | 'terms';

interface Props { kind: Kind; }

export function LegalPage({ kind }: Props) {
  const [officer, setOfficer] = useState<any>(null);
  useEffect(() => {
    ffApi.grievanceOfficer().then(setOfficer).catch(() => null);
  }, []);

  const isPrivacy = kind === 'privacy';
  const title    = isPrivacy ? 'Privacy Policy' : 'Terms of Service';
  const version  = isPrivacy ? 'privacy-2026-05-26' : 'tos-2026-05-26';

  return (
    <div className="min-h-screen bg-background py-12 px-4">
      <div className="max-w-3xl mx-auto">
        <div className="mb-6 rounded border-2 border-amber-400 bg-amber-50 dark:bg-amber-950 p-4">
          <strong>DRAFT — under legal review.</strong>{' '}
          This text is a placeholder for the lawyer-reviewed policy.
          Treat it as informational until the published version
          replaces it. See <Link to="/privacy" className="underline">/privacy</Link>{' '}
          to exercise your rights right now.
        </div>

        <h1 className="text-3xl font-bold mb-2">{title}</h1>
        <p className="text-xs text-muted-foreground mb-6">Version {version}</p>

        {isPrivacy ? <PrivacyBody officer={officer} /> : <TermsBody />}

        <hr className="my-8" />
        <p className="text-xs text-muted-foreground">
          Questions? File a grievance at{' '}
          <Link to="/privacy" className="underline">/privacy</Link>{' '}
          or email the Grievance Officer at{' '}
          {officer?.grievanceOfficer?.email
            ? <a className="underline" href={`mailto:${officer.grievanceOfficer.email}`}>{officer.grievanceOfficer.email}</a>
            : <em>email pending</em>}.
        </p>
      </div>
    </div>
  );
}

function PrivacyBody({ officer }: { officer: any }) {
  return (
    <div className="space-y-4 text-sm leading-6">
      <Section title="1. Who we are">
        <p>
          NamastePOS is a multi-tenant SaaS POS for restaurants, cafés and
          street vendors in India. References to "we", "us", or "NamastePOS"
          mean {officer?.legalEntity?.name || <em>[Legal entity — pending incorporation]</em>}.
          Our registered address is{' '}
          {officer?.legalEntity?.address || <em>[address — pending]</em>}.
        </p>
      </Section>
      <Section title="2. Data we collect">
        <ul className="list-disc pl-5 space-y-1">
          <li>Account: name, email, phone, password (hashed), Google sub.</li>
          <li>Business: name, GSTIN, address, bank/UPI used for payouts.</li>
          <li>Operational: orders, invoices, expenses, menu, staff PINs.</li>
          <li>Customer: phone, name (optional), order history, loyalty points.</li>
          <li>Diagnostics: IP, device, error logs, audit events.</li>
        </ul>
      </Section>
      <Section title="3. Purposes & legal basis">
        <p>
          Personal data is processed for: providing the service (contract),
          complying with GST and income-tax obligations (legal obligation),
          customer support (legitimate interest), and marketing (only with
          your explicit, separate consent).
        </p>
      </Section>
      <Section title="4. Sharing">
        <p>
          We share data with sub-processors that are required to run the
          service: hosting (India region), payment processor (Razorpay), e-invoice
          IRP (NIC), email/WhatsApp delivery (Twilio), and error monitoring (Sentry).
          We do not sell personal data. Customer (diner) data stays with the
          merchant — we only act as a data processor for it.
        </p>
      </Section>
      <Section title="5. Retention">
        <p>
          Account data is kept while the account is active. After erasure,
          we retain only what the law requires us to keep — tax invoices for
          eight years, transaction records as required by RBI rules. We
          delete the rest within 30 days.
        </p>
      </Section>
      <Section title="6. Your rights (DPDP s.11–13)">
        <p>
          You can access, correct, erase, withdraw consent, and export your
          data at any time from{' '}
          <Link to="/privacy" className="underline">Privacy &amp; data</Link>{' '}
          inside the app. Withdrawal is as easy as opting in.
        </p>
      </Section>
      <Section title="7. Grievance Officer">
        {officer?.grievanceOfficer?.name ? (
          <p>
            {officer.grievanceOfficer.name}
            {officer.grievanceOfficer.email && <> · {officer.grievanceOfficer.email}</>}
            {officer.grievanceOfficer.phone && <> · {officer.grievanceOfficer.phone}</>}
          </p>
        ) : (
          <p><em>Grievance Officer contact will be published here once finalised.</em></p>
        )}
      </Section>
      <Section title="8. Children">
        <p>
          The service is not intended for users under 18. We do not knowingly
          collect data from children.
        </p>
      </Section>
      <Section title="9. Changes">
        <p>
          We will notify you by email and in-app when this policy changes.
          The version number above changes with each revision.
        </p>
      </Section>
    </div>
  );
}

function TermsBody() {
  return (
    <div className="space-y-4 text-sm leading-6">
      <Section title="1. Acceptance">
        <p>
          By creating an account, you agree to these Terms and the Privacy Policy.
          If you don't agree, don't use the service.
        </p>
      </Section>
      <Section title="2. The service">
        <p>
          NamastePOS gives Indian F&amp;B businesses a multi-tenant POS,
          billing, inventory, and customer-engagement platform. We may add,
          remove, or change features over time.
        </p>
      </Section>
      <Section title="3. Your data">
        <p>
          You retain ownership of all data you enter. We process it strictly
          to operate the service on your behalf. See the Privacy Policy for
          full detail.
        </p>
      </Section>
      <Section title="4. Acceptable use">
        <p>
          No unlawful, abusive, or fraudulent activity. No reverse engineering.
          No interference with the service for other tenants.
        </p>
      </Section>
      <Section title="5. Payments &amp; refunds">
        <p>
          Paid plans renew monthly until cancelled. You can cancel anytime
          via Plans &amp; Billing. Pro-rata refunds are at our discretion.
        </p>
      </Section>
      <Section title="6. Liability">
        <p>
          We provide the service "as is". Our liability is capped at the
          amount you paid in the past 12 months. We are not liable for lost
          profits or indirect damages.
        </p>
      </Section>
      <Section title="7. Governing law">
        <p>
          Indian law. Disputes go to the courts in the registered office's jurisdiction.
        </p>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="font-semibold text-base mt-4">{title}</h2>
      {children}
    </section>
  );
}
