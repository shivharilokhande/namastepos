import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, Download, FileText } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ffApi } from '@/api/namastepos';
import type { SaveOffer } from '@/api/namastepos';
import { apiError, getBusinessCache } from '@/api/client';
import { trackUpgradePaid } from '@/lib/activation';
import { formatINR, formatDate } from '@/lib/utils';
import { escapeHtml } from '@/lib/receiptPrint';
import { TIER_KIND_COLORS, TIER_KIND_LADDER, TIER_KIND_TAGLINES } from '@/lib/planTiers';

declare global {
  interface Window { Razorpay: any; }
}

// FF-402g — printable HTML receipt used as a fallback when the invoice
// row has no `pdfUrl` yet (real Razorpay invoices always eventually
// get one; this covers the gap + our test rows). Opens a new tab
// filled with a self-contained HTML page the user can print or
// "Save as PDF" via their browser's print dialog.
// NP-133: `win` lets the caller hand in a tab it already opened
// synchronously inside the click gesture — window.open AFTER an await is
// popup-blocked, so the invoice-PDF button pre-opens the tab and we fill it.
function openInvoicePreview(inv: any, sub: any, biz: any, win?: Window | null) {
  const w = win ?? window.open('', '_blank');
  if (!w) return;
  const line = (label: string, value: string) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#666">${label}</td><td style="padding:4px 0;font-weight:600">${value}</td></tr>`;
  const cadence = (() => {
    if (!inv.periodStart || !inv.periodEnd) return null;
    const days = (new Date(inv.periodEnd).getTime() - new Date(inv.periodStart).getTime()) / 86400000;
    return days > 200 ? 'Yearly' : 'Monthly';
  })();
  const fmtDate = (d: string) => d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
  // Hardcode-audit (2026-08-24): route through the shared helper so the
  // receipt honours the business currency/locale instead of a literal ₹.
  // Same input semantics as before: `inv.amount` is in rupees.
  const fmtInr  = (n: number) => formatINR(Number(n), { decimals: true });
  // XSS fix (2026-08-25): business name/address/gstin/email, plan name and
  // invoice number/status are all owner-editable and were written RAW into
  // this popup via document.write — a business literally named
  // "<img onerror=…>" would execute. Every dynamic value below now goes
  // through escapeHtml (the same helper the receipt/session-bill printers
  // already use); fmtDate/fmtInr output is formatter-generated so it's safe.
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Invoice ${escapeHtml(inv.number || inv.id)}</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;margin:40px;color:#111}
  h1{font-size:28px;margin:0 0 4px 0}
  .muted{color:#666;font-size:13px}
  .top{display:flex;justify-content:space-between;border-bottom:2px solid #FF6B35;padding-bottom:16px;margin-bottom:24px}
  .brand{font-weight:800;font-size:20px;color:#FF6B35}
  table.rows{width:100%;border-collapse:collapse;font-size:14px}
  table.summary{margin-top:32px;border-top:1px solid #eee;padding-top:16px;width:100%}
  .amount{font-size:28px;font-weight:800;color:#111}
  .status{display:inline-block;padding:2px 10px;border-radius:99px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px}
  .status.paid{background:#d1fae5;color:#065f46}
  .status.open{background:#fef3c7;color:#92400e}
  .status.failed{background:#fee2e2;color:#991b1b}
  .actions{margin-top:32px;padding-top:16px;border-top:1px solid #eee}
  .btn{display:inline-block;padding:8px 16px;background:#FF6B35;color:#fff;border-radius:6px;text-decoration:none;font-weight:600;font-size:13px}
  @media print { .actions{display:none} body{margin:20px} }
</style></head>
<body>
  <div class="top">
    <div>
      <div class="brand">NamastePOS</div>
      <div class="muted">Subscription invoice</div>
    </div>
    <div style="text-align:right">
      <div style="font-weight:700">${escapeHtml(inv.number || `INV-${(inv.id || '').slice(0,8).toUpperCase()}`)}</div>
      <div class="muted">${fmtDate(inv.createdAt || inv.paidAt)}</div>
      <span class="status ${escapeHtml(inv.status || 'open')}">${escapeHtml(inv.status || 'open')}</span>
    </div>
  </div>

  <div style="display:flex;gap:48px;margin-bottom:32px">
    <div>
      <div class="muted" style="text-transform:uppercase;font-size:11px;letter-spacing:0.5px;margin-bottom:6px">Billed to</div>
      <div style="font-weight:700">${escapeHtml(biz.name || '—')}</div>
      ${biz.gstin ? `<div class="muted">GSTIN: ${escapeHtml(biz.gstin)}</div>` : ''}
      ${biz.address ? `<div class="muted">${escapeHtml(biz.address)}</div>` : ''}
      ${biz.email ? `<div class="muted">${escapeHtml(biz.email)}</div>` : ''}
    </div>
    <div>
      <div class="muted" style="text-transform:uppercase;font-size:11px;letter-spacing:0.5px;margin-bottom:6px">Plan</div>
      <div style="font-weight:700">${escapeHtml(sub?.plan?.name || '—')}${cadence ? ` · ${cadence}` : ''}</div>
      ${inv.periodStart && inv.periodEnd ? `<div class="muted">Period: ${fmtDate(inv.periodStart)} → ${fmtDate(inv.periodEnd)}</div>` : ''}
      ${inv.paidAt ? `<div class="muted">Paid: ${fmtDate(inv.paidAt)}</div>` : ''}
    </div>
  </div>

  <table class="rows">
    <thead>
      <tr style="border-bottom:1px solid #eee;text-align:left">
        <th style="padding:8px 0;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#666">Description</th>
        <th style="padding:8px 0;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#666;text-align:right">Amount</th>
      </tr>
    </thead>
    <tbody>
      <tr style="border-bottom:1px solid #f3f4f6">
        <td style="padding:12px 0">
          ${escapeHtml(sub?.plan?.name || 'NamastePOS')} subscription${cadence ? ` (${cadence.toLowerCase()})` : ''}
          ${inv.periodStart && inv.periodEnd ? `<div class="muted" style="margin-top:2px">${fmtDate(inv.periodStart)} → ${fmtDate(inv.periodEnd)}</div>` : ''}
        </td>
        <td style="padding:12px 0;text-align:right;font-weight:600">${fmtInr(inv.amount)}</td>
      </tr>
    </tbody>
  </table>

  <table class="summary">
    <tr><td style="text-align:right;padding:4px 8px 4px 0;color:#666">Subtotal</td><td style="text-align:right;width:120px;font-weight:600">${fmtInr(inv.amount)}</td></tr>
    <tr><td style="text-align:right;padding:12px 8px 4px 0;font-weight:700">Total</td><td style="text-align:right;font-weight:800" class="amount">${fmtInr(inv.amount)}</td></tr>
  </table>

  <div class="actions">
    <a href="javascript:window.print()" class="btn">Print / Save as PDF</a>
    <span class="muted" style="margin-left:12px">Use your browser's print dialog to save this as a PDF.</span>
  </div>
</body></html>`;
  w.document.open();
  w.document.write(html);
  w.document.close();
}

// Push 14f — readable labels for the raw feature keys stored in
// plan_features. Anything missing falls back to a humanised key, so
// adding a brand-new feature still shows up in the compare card (just
// with its raw name) until we drop a label here.
const FEATURE_LABELS: Record<string, string> = {
  pos: 'POS / new order',
  orders: 'Orders list',
  token_generation: 'Token generation',
  tables_single_floor: '1 floor of tables',
  tables_multi_floor: 'Multi-floor + drag layout',
  menu_basic: 'Basic menu',
  menu_variants_modifiers: 'Variants + modifier groups',
  reports_basic: 'Daily + monthly reports',
  expenses: 'Expenses tracking',
  invoice_basic: 'GST invoices',
  b2b_invoice: 'B2B / GST invoices',
  staff_lite: 'Staff (PIN logins)',
  staff_unlimited: 'Unlimited staff accounts',
  customers_basic: 'Customer directory',
  customers_crm: 'CRM with notes',
  loyalty: 'Loyalty points',
  memberships: 'Memberships',
  reviews: 'Customer reviews',
  reservations: 'Reservations',
  wastage: 'Wastage tracking',
  daily_closing: 'Daily closing',
  kds: 'KDS (kitchen display)',
  captain_mode: 'Captain mode',
  driver_mode: 'Driver / delivery',
  aggregators: 'Aggregator integrations (Zomato/Swiggy)',
  qr_ordering: 'QR ordering',
  whatsapp_marketing: 'WhatsApp marketing',
  recipe_costing: 'Recipe costing',
  voice_pos: 'Voice POS',
  bill_split: 'Bill split',
  surge_pricing: 'Surge pricing',
  marketplace_addons: 'Marketplace add-ons',
  multi_outlet: 'Multi-outlet management',
  accounting_pnl_bs: 'P&L · Balance Sheet · TB',
  // 2026-09-05 — the capability is the IRN/e-invoice document pipeline; the
  // filing leg needs a GSP/IRP connection NamastePOS does not have yet. The
  // label must not read as "you can file from here".
  einvoice_gst: 'E-invoice ready (GSP connection required)',
  recurring_invoices: 'Recurring invoices',
  bank_reconcile: 'Bank reconciliation',
  heat_map: 'Heat map',
  forecast: 'Forecasting',
  dead_stock: 'Dead-stock analytics',
  bulk_import: 'Bulk import',
  api_access: 'API access',
  white_label: 'White-label',
  tds_tcs: 'TDS / TCS',
  multi_currency_fx: 'Multi-currency / FX',
};

// 2026-09-04 — colours + taglines moved to @/lib/planTiers, which mirrors
// the backend's tier-kind ladder. The local three-entry maps here had gone
// stale against the live five-kind ladder, so the Pro and Advanced cards
// rendered with the grey fallback colour and NO tagline at all.
const TIER_COLORS = TIER_KIND_COLORS;
const TIER_TAGLINES = TIER_KIND_TAGLINES;

function loadRazorpayScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.Razorpay) return resolve();
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load Razorpay'));
    document.body.appendChild(s);
  });
}

export function BillingPage() {
  const qc = useQueryClient();
  // FF-313 — Yearly billing toggle. Persists in localStorage so the
  // last choice sticks between visits. When "yearly" the price grid
  // shows the yearly price, and change() passes billingPeriod so the
  // backend picks the yearly Razorpay plan.
  // FF-402b / B12+B25 — Default the toggle to the user's ACTUAL sub
  // cadence on first load. Only after the user manually clicks
  // Monthly/Yearly do we start persisting their override to
  // localStorage — until then, we track "has the user touched this
  // yet?" via a ref so an owner on Yearly doesn't land on Monthly.
  const LS_KEY = 'ff_billing_period_user';
  const userOverride = useRef<boolean>(!!localStorage.getItem(LS_KEY));
  const [billingPeriod, setBillingPeriod] = useState<'monthly' | 'yearly'>(
    (localStorage.getItem(LS_KEY) as any) || 'yearly'
  );
  // Only persist when the user actually clicked the toggle — never
  // during a passive sync from `sub`.
  const setBillingPeriodByUser = (v: 'monthly' | 'yearly') => {
    userOverride.current = true;
    localStorage.setItem(LS_KEY, v);
    setBillingPeriod(v);
  };
  // NP-127: keep isError/refetch — an API failure must render as an error
  // + Retry, not silently hide the current-plan card (error ≠ empty).
  const {
    data: sub, isError: subIsError, error: subError, refetch: refetchSub,
  } = useQuery({ queryKey: ['sub'], queryFn: ffApi.subscription });
  // FF-402d — one-shot sync from sub.billingPeriod on load.
  const syncedFromSub = useRef(false);
  useEffect(() => {
    if (syncedFromSub.current) return;
    if (!sub?.billingPeriod) return;
    if (!userOverride.current) setBillingPeriod(sub.billingPeriod as any);
    syncedFromSub.current = true;
  }, [sub]);
  // Push 14f — single source of truth for plan cards: backend /plans
  // returns each plan enriched with featureKeys from plan_features.
  // refetchInterval keeps the customer view in sync with super-admin
  // changes within ~60s.
  const { data: plans = [] } = useQuery({
    queryKey: ['plans'],
    queryFn: ffApi.plans,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  // Activation funnel — `upgrade_paid`. The Razorpay webhook is server-side
  // and invisible to the browser, so we watch for the row the webhook
  // WRITES: a non-free plan with status 'active'. Deliberately NOT the
  // Razorpay checkout `handler` callback — that is the client claiming a
  // charge succeeded, before the mandate is confirmed. This query already
  // refetches on window focus and after `change` invalidates it, so the
  // confirmed state is picked up on the owner's next look at this page.
  useEffect(() => {
    if (!sub) return;
    trackUpgradePaid(sub, getBusinessCache()?.id ?? null);
  }, [sub]);
  // NP-127: same deal for invoices — the `= []` default made a failed
  // fetch indistinguishable from "no invoices yet".
  const {
    data: invoices = [], isError: invIsError, error: invError, refetch: refetchInvoices,
  } = useQuery({ queryKey: ['invoices'], queryFn: ffApi.invoices });
  const biz = getBusinessCache() || {};

  // Bug #14 (2026-08-25) — RBI e-mandate disclosure. Razorpay subscription
  // checkout authorises a RECURRING autopay mandate (UPI Autopay / card
  // autopay), and RBI rules for recurring payments require explicit,
  // informed customer consent BEFORE that mandate is set up. `consent`
  // holds the copy for the popup plus the resolver the checkout flow is
  // awaiting; null = dialog closed.
  const [consent, setConsent] = useState<{
    planName: string;
    amountInr: number;
    cadence: 'monthly' | 'yearly';
    resolve: (agreed: boolean) => void;
  } | null>(null);
  // Single close path so Cancel, "Agree & Continue", Esc and the ✕ button
  // all settle the pending promise exactly once.
  const answerConsent = (agreed: boolean) => {
    consent?.resolve(agreed);
    setConsent(null);
  };

  const change = useMutation({
    mutationFn: async (tier: string) => {
      const res = await ffApi.changePlan(tier, billingPeriod);
      // Free downgrade OR manual activation (backend billingController
      // returns { manual: true, subscription } — no subscriptionId — when
      // Razorpay isn't configured, so NO mandate is ever created): keep the
      // old instant path, deliberately WITHOUT the autopay consent popup.
      if (tier === 'free' || res.manual === true || !res.subscriptionId) return res;
      // Bug #14 (2026-08-25): from here on the Razorpay checkout WILL open
      // and set up a recurring mandate — block on the RBI-required
      // disclosure and only proceed if the owner explicitly agrees.
      const plan = plans.find((p: any) => p.tier === tier);
      // FF-402e semantics: trial-only plans have no yearly price, so even
      // with the toggle on Yearly the mandate is monthly — mirror that in
      // the disclosed amount/cadence so the popup never misstates a charge.
      const cadence: 'monthly' | 'yearly' =
        billingPeriod === 'yearly' && plan?.priceYearlyInr != null ? 'yearly' : 'monthly';
      const agreed = await new Promise<boolean>((resolve) => {
        setConsent({
          planName: plan?.name || tier,
          amountInr: cadence === 'yearly' ? (plan?.priceYearlyInr ?? 0) : (plan?.priceInr ?? 0),
          cadence,
          resolve,
        });
      });
      // Same rejection shape as dismissing the Razorpay modal below, so
      // onError shows the familiar "Cancelled" toast and no charge happens.
      if (!agreed) throw new Error('Cancelled');
      await loadRazorpayScript();
      return new Promise((resolve, reject) => {
        const rz = new window.Razorpay({
          ...res.checkoutOptions,
          handler: () => resolve(res),
          modal: { ondismiss: () => reject(new Error('Cancelled')) },
        });
        rz.open();
      });
    },
    onSuccess: (res: any) => {
      // X2 proration — if the upgrade carries a pro-rated charge for the
      // unused remainder of the current period, tell the owner.
      const prorate = Number(res?.prorationInr || 0);
      if (prorate > 0) {
        toast.success(`Plan upgraded — ₹${prorate.toLocaleString('en-IN')} charged now for the rest of this cycle`);
      } else {
        toast.success('Plan updated');
      }
      qc.invalidateQueries({ queryKey: ['sub'] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  // ── Cancel flow (2026-09-05, churn batch) ─────────────────────────────
  //
  // "Cancel at period end" used to be one button that just cancelled. It now
  // opens a two-screen flow: pick a reason, then see what that reason
  // produces. The branching is the server's job (churnService.offerFor) — this
  // component renders whatever comes back and, crucially, renders NO "stay"
  // control when `offer.save` is false. That is what keeps a discount from
  // ever appearing in front of somebody whose restaurant has closed.
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reasonCode, setReasonCode] = useState<string>('');
  const [reasonNote, setReasonNote] = useState('');
  const [offer, setOffer] = useState<SaveOffer | null>(null);

  const { data: cancelReasons = [] } = useQuery({
    queryKey: ['cancel-reasons'],
    queryFn: ffApi.cancelReasons,
    // Static list; only fetched once the owner actually opens the flow.
    enabled: cancelOpen,
    staleTime: 60 * 60 * 1000,
  });

  const closeCancel = () => {
    setCancelOpen(false);
    setOffer(null);
    setReasonCode('');
    setReasonNote('');
  };

  const survey = useMutation({
    mutationFn: () => ffApi.cancelSurvey(reasonCode, reasonNote || undefined),
    onSuccess: (res) => setOffer(res.offer),
    onError: (e) => toast.error(apiError(e)),
  });

  const cancel = useMutation({
    mutationFn: ffApi.cancelSubscription,
    onSuccess: () => {
      toast.success('Will cancel at period end — nothing is deleted');
      closeCancel();
      qc.invalidateQueries({ queryKey: ['sub'] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const pause = useMutation({
    mutationFn: (months: 1 | 2 | 3) => ffApi.pauseSubscription(months, reasonCode || undefined),
    onSuccess: () => {
      toast.success('Paused. Billing stops and nothing is deleted.');
      closeCancel();
      qc.invalidateQueries({ queryKey: ['sub'] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const resume = useMutation({
    mutationFn: ffApi.resumeSubscription,
    onSuccess: () => {
      toast.success('Resumed on the same plan');
      qc.invalidateQueries({ queryKey: ['sub'] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const downgrade = useMutation({
    mutationFn: () => ffApi.changePlan('free'),
    onSuccess: () => {
      toast.success('Moved to Starter. Free, no expiry, nothing deleted.');
      closeCancel();
      qc.invalidateQueries({ queryKey: ['sub'] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  // The export is a real file, so it downloads rather than navigating — the
  // API client sends auth headers a plain <a href> could not.
  const exportAccount = useMutation({
    mutationFn: ffApi.exportAccount,
    onSuccess: (blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `namastepos-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success('Your data is downloading');
    },
    onError: (e) => toast.error(apiError(e)),
  });

  // Order plans by price for a natural compare order. Cheapest first.
  const orderedPlans = [...plans].sort((a: any, b: any) => (a.priceInr || 0) - (b.priceInr || 0));
  // The cheapest paid plan (≥ ₹1) becomes the visual "Recommended" card —
  // matches the previous design without hardcoding to 'pro' tier_kind.
  const recommendedId = orderedPlans.find((p: any) => p.priceInr > 0)?.id;

  return (
    <div className="space-y-6">
      {/* Bug #14 (2026-08-25) — RBI-compliant auto-pay disclosure. Rendered
          only while the change() mutation is awaiting consent, i.e. only
          when the Razorpay checkout is actually about to open (never on the
          free-plan / manual-activation path). onOpenChange catches Esc and
          the ✕ close button — anything short of an explicit
          "Agree & Continue" resolves as Cancel and aborts checkout. */}
      <Dialog open={!!consent} onOpenChange={(open) => { if (!open) answerConsent(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Auto-pay setup</DialogTitle>
            <DialogDescription>
              You are setting up automatic recurring payment for the{' '}
              <strong className="text-foreground">{consent?.planName}</strong> plan
              {' '}({consent ? formatINR(consent.amountInr) : ''}/{consent?.cadence === 'yearly' ? 'year' : 'month'}).
              Your payment method will be charged automatically each billing cycle.
              You can cancel anytime from Plans &amp; Billing — no questions asked.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => answerConsent(false)}>Cancel</Button>
            <Button onClick={() => answerConsent(true)}>Agree &amp; Continue</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div>
        <h1 className="text-2xl font-bold tracking-tight">Billing</h1>
        <p className="text-muted-foreground">Plan, invoices, payment method.</p>
      </div>

      {/* N1 dunning — actionable past-due banner.
          2026-09-04: only rendered once the GRACE WINDOW HAS PASSED. While a
          failed charge is still inside the grace window, features are still
          on and PlanLimitBanner (mounted in Layout, so present on every
          screen including this one) shows the amount and the date access
          ends. Rendering both would put two contradictory banners about the
          same failed charge on this page. */}
      {sub?.status === 'past_due' && !sub?.grace && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex-1">
            <div className="font-semibold text-red-800">Payment failed — your plan is past due</div>
            <div className="text-sm text-red-700">
              Loyalty, reports and add-ons are paused until this is settled. We retry automatically, but you can fix it now — nothing has been deleted.
            </div>
          </div>
          <Button variant="default" onClick={() => { const el = document.getElementById('choose-plan'); el?.scrollIntoView({ behavior: 'smooth' }); }}>
            Update payment
          </Button>
        </div>
      )}

      {/* 2026-09-05 — paused account. Says what still works, names the resume
          date, and gives one button. No alarm colour: pausing is a normal,
          deliberate thing to do and the banner should not read as a fault. */}
      {sub?.pause?.paused && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex-1">
            <div className="font-semibold text-amber-900">
              Paused until {formatDate(sub.pause.pauseEndsAt)}
            </div>
            <div className="text-sm text-amber-800">
              Billing has stopped and nothing is deleted. You can still open the app and
              read every bill, report and customer. New bills start again when you resume —
              we do it automatically on {formatDate(sub.pause.pauseEndsAt)}, or you can
              resume now.
            </div>
          </div>
          <Button variant="default" disabled={resume.isPending} onClick={() => resume.mutate()}>
            Resume now
          </Button>
        </div>
      )}

      {/* ── Cancel flow ────────────────────────────────────────────────────
          Screen 1 is the reason. Screen 2 is whatever that reason produced.
          `offer.save === false` (missing_feature, switching, closing_down)
          renders NO stay control — the only buttons are "go back" and
          "confirm". A save offer in front of an owner whose restaurant has
          shut is insulting, and this is where that rule is enforced in the
          UI. */}
      <Dialog open={cancelOpen} onOpenChange={(open) => { if (!open) closeCancel(); }}>
        <DialogContent className="max-w-lg">
          {!offer ? (
            <>
              <DialogHeader>
                <DialogTitle>Before you go — what went wrong?</DialogTitle>
                <DialogDescription>
                  One tap. It is the only way the product gets less annoying, and it
                  decides what we can actually do for you on the next screen.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                {cancelReasons.map((r) => (
                  <button
                    key={r.code}
                    type="button"
                    onClick={() => setReasonCode(r.code)}
                    className={`w-full text-left rounded-md border px-3 py-2 text-sm transition ${
                      reasonCode === r.code
                        ? 'border-primary bg-primary/5 font-medium'
                        : 'border-border hover:bg-muted'
                    }`}
                  >
                    {r.label}
                  </button>
                ))}
                <textarea
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  rows={3}
                  placeholder={
                    cancelReasons.find((r) => r.code === reasonCode)?.noteRequired
                      ? 'What was missing? (required — this goes to the founder)'
                      : 'Anything else? (optional)'
                  }
                  value={reasonNote}
                  onChange={(e) => setReasonNote(e.target.value)}
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={closeCancel}>Never mind</Button>
                <Button
                  disabled={!reasonCode || survey.isPending}
                  onClick={() => survey.mutate()}
                >
                  Continue
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>{offer.headline}</DialogTitle>
                {offer.detail && <DialogDescription>{offer.detail}</DialogDescription>}
              </DialogHeader>
              {offer.save && (
                <div className="space-y-3">
                  {offer.options.map((o) => (
                    <div key={o.action} className="rounded-md border border-border p-3">
                      <div className="font-medium text-sm">{o.title}</div>
                      <div className="text-sm text-muted-foreground mt-1">{o.detail}</div>
                      {o.action === 'pause' && (
                        <div className="flex gap-2 mt-2">
                          {(o.months || [1, 2, 3]).map((m) => (
                            <Button
                              key={m}
                              size="sm"
                              variant="outline"
                              disabled={pause.isPending}
                              onClick={() => pause.mutate(m as 1 | 2 | 3)}
                            >
                              {m} month{m === 1 ? '' : 's'}
                            </Button>
                          ))}
                        </div>
                      )}
                      {o.action === 'downgrade' && (
                        <Button
                          size="sm"
                          className="mt-2"
                          disabled={downgrade.isPending}
                          onClick={() => downgrade.mutate()}
                        >
                          Move to Starter
                        </Button>
                      )}
                      {o.action === 'annual' && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="mt-2"
                          onClick={() => {
                            closeCancel();
                            document.getElementById('choose-plan')?.scrollIntoView({ behavior: 'smooth' });
                          }}
                        >
                          Switch to yearly
                        </Button>
                      )}
                      {o.action === 'founder_call' && (
                        <div className="text-xs text-muted-foreground mt-2">
                          Reply to any NamastePOS message and we will book it.
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {!offer.save && offer.kind === 'goodbye' && (
                <Button
                  variant="outline"
                  disabled={exportAccount.isPending}
                  onClick={() => exportAccount.mutate()}
                >
                  <Download className="h-4 w-4 mr-1" />
                  Take a copy of my data
                </Button>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={() => setOffer(null)}>Back</Button>
                <Button
                  variant="destructive"
                  disabled={cancel.isPending}
                  onClick={() => cancel.mutate()}
                >
                  Cancel at period end
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* NP-127 — the current-plan card used to just vanish when the sub
          fetch failed (looks identical to "no subscription"). Same error +
          Retry pattern as PrintersPage. */}
      {subIsError && !sub && (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="font-medium">Couldn't load your current plan</p>
            <p className="text-sm text-destructive mt-1">{apiError(subError)}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => refetchSub()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {sub && (() => {
        // Derive the cadence from the ACTUAL current period span rather than
        // trusting sub.billingPeriod alone — an admin/manual plan set could
        // leave billing_period='monthly' while pushing the period ~a year out,
        // which showed a "Monthly" badge next to a "renews next year" date.
        // Prefer the span so the badge, price and renewal date always agree.
        const spanDays = (sub.currentPeriodStart && sub.currentPeriodEnd)
          ? (new Date(sub.currentPeriodEnd).getTime() - new Date(sub.currentPeriodStart).getTime()) / 86400000
          : null;
        const effectiveCadence: 'monthly' | 'yearly' =
          spanDays != null ? (spanDays > 200 ? 'yearly' : 'monthly')
                           : ((sub.billingPeriod as 'monthly' | 'yearly') || 'monthly');
        return (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Current plan</CardTitle>
                {/* Bug fix (2026-08-20): CardDescription renders as
                    <p>, and Badge renders a <div>. Nesting <div> inside
                    <p> is invalid HTML and React logs a validateDOM
                    warning on every render. Swap the wrapper to a
                    <div> so both children are legal siblings. */}
                <div className="text-sm text-muted-foreground flex items-center gap-2 flex-wrap">
                  <span>{sub.plan?.name} ·</span>
                  <Badge variant={sub.status === 'active' ? 'success' : 'warning'}>{sub.status}</Badge>
                  {/* FF-402d — surface the ACTUAL cadence on the current
                      plan card so an owner on yearly can see it clearly
                      and doesn't assume they're being charged monthly. */}
                  {sub.plan?.priceInr > 0 && (
                    <Badge variant={effectiveCadence === 'yearly' ? 'default' : 'secondary'}>
                      {effectiveCadence === 'yearly' ? 'Yearly' : 'Monthly'}
                    </Badge>
                  )}
                </div>
              </div>
              {sub.plan?.priceInr ? (
                <div className="text-right">
                  {/* Show the amount that matches the actual cadence. */}
                  <div className="text-2xl font-bold">
                    {effectiveCadence === 'yearly' && sub.plan.priceYearlyInr
                      ? formatINR(sub.plan.priceYearlyInr)
                      : formatINR(sub.plan.priceInr)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    per {effectiveCadence === 'yearly' ? 'year' : 'month'}
                  </div>
                </div>
              ) : null}
            </div>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-1">
            {/* FF-402f — a period_end in the past + status=active almost
                always means a Razorpay charge failed or the plan was
                manually set without rolling the period forward. Show
                that as an explicit warning, not a friendly "renews on". */}
            {(() => {
              const end = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd) : null;
              const isPastDue = end && end.getTime() < Date.now();
              if (isPastDue && sub.status === 'active') {
                return (
                  <div className="text-amber-700 font-medium">
                    ⚠ Renewal overdue — cycle ended {formatDate(sub.currentPeriodEnd)}.
                    Reach out to support if you weren't charged for the next period.
                  </div>
                );
              }
              return (
                <div>{sub.status === 'trialing' ? 'Trial ends on ' : 'Renews on '}
                  <strong className="text-foreground">{formatDate(sub.currentPeriodEnd)}</strong>
                </div>
              );
            })()}
            {sub.cancelAtPeriodEnd && <div className="text-destructive">Will not auto-renew</div>}
            <div className="flex flex-wrap gap-2 pt-2">
              {sub.status === 'active' && !sub.cancelAtPeriodEnd && (
                <Button variant="outline" size="sm" onClick={() => setCancelOpen(true)}>
                  Cancel subscription
                </Button>
              )}
              {(sub.cancelAtPeriodEnd || sub.status === 'paused') && (
                <Button variant="default" size="sm" disabled={resume.isPending} onClick={() => resume.mutate()}>
                  {sub.status === 'paused' ? 'Resume now' : 'Keep my plan'}
                </Button>
              )}
              {/* The export is here, not buried in the cancel flow. An owner
                  should never have to start cancelling to get a copy of their
                  own menu. */}
              <Button variant="ghost" size="sm" disabled={exportAccount.isPending} onClick={() => exportAccount.mutate()}>
                <Download className="h-4 w-4 mr-1" />
                Export my data
              </Button>
            </div>
          </CardContent>
        </Card>
        );
      })()}

      {/* Push 14f — compare cards driven by /plans endpoint. Whatever
          the super-admin sets in the Plans page is exactly what shows
          here (within the 60s poll window). */}
      <div>
        <div className="flex items-end justify-between mb-3">
          <h2 className="text-lg font-semibold">Compare plans</h2>
          {/* FF-321 monthly/yearly toggle. Yearly is priced at 10× monthly
              (2 months free) — the loss-aversion framing beats percent
              discounts in Indian SaaS. */}
          <div className="flex bg-muted rounded-lg p-1 text-sm">
            <button onClick={() => setBillingPeriodByUser('monthly')}
              className={`px-3 py-1 rounded-md ${billingPeriod === 'monthly' ? 'bg-background shadow font-semibold' : 'text-muted-foreground'}`}>
              Monthly
            </button>
            <button onClick={() => setBillingPeriodByUser('yearly')}
              className={`relative px-3 py-1 rounded-md flex items-center gap-1 ${billingPeriod === 'yearly' ? 'bg-background shadow font-semibold' : 'text-muted-foreground'}`}>
              Yearly
              <span className="inline-block text-[10px] uppercase tracking-wider bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded font-bold">
                2 months free
              </span>
              {/* FF-402b — "Recommended" chip on the Yearly button so
                  it's the visually louder option even when the user
                  is on Monthly today. */}
              <span className="absolute -top-2 -right-2 text-[9px] uppercase tracking-wider bg-amber-500 text-white px-1.5 py-0.5 rounded font-bold shadow">
                Recommended
              </span>
            </button>
          </div>
        </div>
        <div id="choose-plan" className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          {orderedPlans.map((p: any) => {
            const tierKind: string = p.tierKind || TIER_KIND_LADDER[0];
            const color = TIER_COLORS[tierKind] || '#888';
            // FF-402d — "Current" means SAME tier AND SAME cadence. If
            // the tier matches but the cadence differs, we surface a
            // "Switch to yearly" / "Switch to monthly" CTA instead of
            // greying the button — that was the blocker the owner hit
            // when their active plan was yearly and they wanted to
            // adjust cadence.
            const isSameTier = sub?.plan?.tier === p.tier;
            const isCurrent = isSameTier && (sub?.billingPeriod || 'monthly') === billingPeriod;
            const isCadenceSwitch = isSameTier && !isCurrent;
            const isRecommended = p.id === recommendedId;
            const featureKeys: string[] = p.featureKeys || [];
            // Show top ~8 features per card so the layout stays scannable.
            // Owners can see the full feature list in the raw limits
            // card below or in the super-admin matrix card.
            const visibleFeatures = featureKeys.slice(0, 8);
            const hidden = featureKeys.length - visibleFeatures.length;
            return (
              <Card key={p.id}
                className={isCurrent ? 'border-2 border-primary'
                  : isRecommended ? 'border-2 border-amber-500' : ''}>
                {isRecommended && (
                  <div className="bg-amber-500 text-white text-center text-[10px] font-black tracking-widest py-1">
                    RECOMMENDED
                  </div>
                )}
                <CardHeader>
                  <div className="flex items-baseline justify-between">
                    <CardTitle style={{ color }}>{p.name}</CardTitle>
                    <div className="text-right">
                      {(() => {
                        // FF-402e — starter/trial plans have NO yearly
                        // price. When the toggle is on Yearly, show the
                        // monthly rate + a "Trial only" note instead of
                        // fabricating a yearly amount.
                        const yearlyMode = billingPeriod === 'yearly';
                        const trialOnly = p.priceInr > 0 && p.priceYearlyInr == null;
                        const showYearly = yearlyMode && !trialOnly && p.priceInr > 0;
                        return (
                          <>
                            <div className="text-2xl font-extrabold">
                              {p.priceInr === 0
                                ? formatINR(0)
                                : showYearly
                                  // Hardcode-audit fix (2026-08-24): no client-side
                                  // "×10" pricing rule — backend is the source of truth
                                  // (showYearly guarantees priceYearlyInr is set).
                                  ? formatINR(p.priceYearlyInr ?? 0)
                                  : formatINR(p.priceInr)}
                              <span className="text-xs font-normal text-muted-foreground">
                                /{p.priceInr === 0 ? 'forever' : showYearly ? 'yr' : 'mo'}
                              </span>
                            </div>
                            {trialOnly && yearlyMode && (
                              <div className="text-[11px] text-muted-foreground mt-0.5 italic">
                                Trial plan · monthly only
                              </div>
                            )}
                            {showYearly && (() => {
                              const monthlyAnnualised = p.priceInr * 12;
                              const yearly = p.priceYearlyInr ?? 0;
                              const save = monthlyAnnualised - yearly;
                              return save > 0 ? (
                                <div className="text-[11px] font-semibold text-emerald-700 mt-0.5">
                                  Save {formatINR(save)}/yr
                                </div>
                              ) : null;
                            })()}
                          </>
                        );
                      })()}
                    </div>
                  </div>
                  <CardDescription>{TIER_TAGLINES[tierKind] || ''}</CardDescription>
                </CardHeader>
                <CardContent>
                  <ul className="text-sm space-y-1.5">
                    {featureKeys.length === 0 ? (
                      <li className="text-xs italic text-muted-foreground">
                        No features assigned to this tier yet.
                      </li>
                    ) : visibleFeatures.map((k) => (
                      <li key={k} className="flex items-start gap-2">
                        <Check className="h-4 w-4 mt-0.5 text-emerald-600 flex-shrink-0" />
                        <span>{FEATURE_LABELS[k] || k.replace(/_/g, ' ')}</span>
                      </li>
                    ))}
                    {hidden > 0 && (
                      <li className="text-xs text-muted-foreground pl-6">
                        +{hidden} more
                      </li>
                    )}
                  </ul>
                  {isCurrent ? (
                    <Button className="w-full mt-4" disabled>Your current plan</Button>
                  ) : (
                    <Button className="w-full mt-4"
                      style={{ backgroundColor: color, color: 'white' }}
                      onClick={() => change.mutate(p.tier)}
                      disabled={change.isPending}>
                      {p.priceInr === 0
                        ? `Downgrade to ${p.name}`
                        : isCadenceSwitch
                          ? `Switch to ${billingPeriod === 'yearly' ? 'yearly' : 'monthly'}`
                          : `Switch to ${p.name} · ${billingPeriod === 'yearly' ? 'yearly' : 'monthly'}`}
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-3">Plan limits</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {orderedPlans.map((p: any) => {
            // FF-402d — same "tier + cadence" definition of current as
            // the compare grid above; keeps the two panels consistent.
            const sameTier = sub?.plan?.tier === p.tier;
            const current = sameTier && (sub?.billingPeriod || 'monthly') === billingPeriod;
            return (
              <Card key={p.id} className={current ? 'border-primary' : ''}>
                <CardHeader>
                  <CardTitle className="text-xl">{p.name}</CardTitle>
                  <div className="text-2xl font-bold">
                    {(() => {
                      // FF-402e — starter/trial plans have no yearly.
                      // Fall back to monthly + /mo so the unit matches
                      // the number the user sees.
                      const hasYearly = billingPeriod === 'yearly' && p.priceYearlyInr != null;
                      return (
                        <>
                          {hasYearly ? formatINR(p.priceYearlyInr) : formatINR(p.priceInr)}
                          <span className="text-sm font-normal text-muted-foreground">
                            /{hasYearly ? 'yr' : 'mo'}
                          </span>
                        </>
                      );
                    })()}
                  </div>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  {Object.entries(p.limits || {}).map(([k, v]: any) => (
                    <div key={k} className="flex items-center gap-2">
                      <Check className="h-4 w-4 text-emerald-600" />
                      <span>{v === -1 ? 'Unlimited' : v} {k.replace(/_/g, ' ')}</span>
                    </div>
                  ))}
                  <Button
                    className="w-full mt-3"
                    variant={current ? 'outline' : 'default'}
                    disabled={current || change.isPending}
                    onClick={() => change.mutate(p.tier)}
                  >
                    {current
                      ? 'Current plan'
                      : sameTier
                        ? `Switch to ${billingPeriod === 'yearly' ? 'yearly' : 'monthly'}`
                        : `Switch to ${p.name} · ${billingPeriod === 'yearly' ? 'yearly' : 'monthly'}`}
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      {/* FF-402g — Subscription invoices. Every Razorpay charge event
          ($subscription.charged$ webhook) inserts an invoice row. The
          cadence chip is inferred from period length so historical
          rows without an explicit cadence field still render right.
          PDF opens in a new tab; when the row has no pdfUrl yet
          (still generating) we grey the button. */}
      <Card>
        <CardHeader>
          <CardTitle>Invoices &amp; receipts</CardTitle>
          <p className="text-xs text-muted-foreground pt-1">
            Every subscription charge (monthly or yearly) lands here.
            Download the PDF for your GST records.
          </p>
        </CardHeader>
        <CardContent className="space-y-1">
          {/* NP-127 — a failed fetch must NOT masquerade as "No invoices
              yet." (the `= []` default made them identical). */}
          {invIsError && (
            <div className="py-6 text-center">
              <p className="text-destructive text-sm">{apiError(invError)}</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => refetchInvoices()}>
                Retry
              </Button>
            </div>
          )}
          {!invIsError && invoices.length === 0 && (
            <div className="py-6 text-center text-muted-foreground">
              <FileText className="w-8 h-8 mx-auto mb-2 opacity-40" />
              <div>No invoices yet.</div>
              <div className="text-xs">Your first invoice will appear here after your next Razorpay charge.</div>
            </div>
          )}
          {invoices.map((i: any) => {
            // Infer cadence from the invoice's own period length. > 200
            // days = yearly, otherwise monthly. Falls back to "Charge"
            // if periods are missing (some webhooks omit them).
            let cadenceLabel: string | null = null;
            if (i.periodStart && i.periodEnd) {
              const days = (new Date(i.periodEnd).getTime() - new Date(i.periodStart).getTime()) / 86400000;
              cadenceLabel = days > 200 ? 'Yearly' : 'Monthly';
            }
            return (
              <div key={i.id} className="flex items-center justify-between py-2.5 border-b last:border-0 text-sm">
                <div className="flex items-start gap-3 min-w-0">
                  <FileText className="w-4 h-4 mt-1 text-muted-foreground flex-shrink-0" />
                  <div className="min-w-0">
                    <div className="font-medium">
                      {i.number || `INV-${i.id.slice(0, 8).toUpperCase()}`}
                      {cadenceLabel && (
                        <span className="ml-2 text-[10px] uppercase tracking-wider bg-muted px-1.5 py-0.5 rounded">
                          {cadenceLabel}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {i.periodStart && i.periodEnd
                        ? `${formatDate(i.periodStart)} → ${formatDate(i.periodEnd)}`
                        : formatDate(i.createdAt)}
                      {i.paidAt && ` · paid ${formatDate(i.paidAt)}`}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <Badge variant={i.status === 'paid' ? 'success' : i.status === 'failed' ? 'destructive' : 'warning'}>
                    {i.status}
                  </Badge>
                  <div className="font-medium w-24 text-right">
                    {formatINR(i.amount, { decimals: true })}
                  </div>
                  {/* FF-402g — always give a way to VIEW the invoice.
                      Real Razorpay invoices provide a hosted PDF URL;
                      for rows without one (webhook running late, or
                      test data) we render a printable HTML receipt
                      from the row itself so the user can print or
                      "Save as PDF" from their browser. */}
                  {/* 2026-08-26 — download our own GST-compliant invoice PDF
                      (generated on demand). Falls back to the printable HTML
                      receipt if the PDF endpoint errors. */}
                  <button
                    onClick={async () => {
                      // NP-133: window.open AFTER the await gets popup-blocked
                      // (the click gesture is spent by then) — the button
                      // silently did nothing for most users. Open the tab
                      // synchronously NOW, then point it at the PDF blob once
                      // it arrives; the HTML-receipt fallback reuses the same
                      // pre-opened tab.
                      const w = window.open('', '_blank');
                      try {
                        const blob = await ffApi.subscriptionInvoicePdf(i.id);
                        const url = URL.createObjectURL(blob);
                        if (w) w.location.href = url;
                        else window.open(url, '_blank'); // popups hard-blocked — best effort
                        setTimeout(() => URL.revokeObjectURL(url), 60000);
                      } catch {
                        openInvoicePreview(i, sub, biz, w);
                      }
                    }}
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                    <Download className="w-3.5 h-3.5" /> GST invoice
                  </button>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
