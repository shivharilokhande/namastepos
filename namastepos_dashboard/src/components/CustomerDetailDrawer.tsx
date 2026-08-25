// NamastePOS dashboard — Customer detail drawer (2026-08-25, founder bug #7).
//
// The web Customers page was a flat table while the mobile app already had
// a full customer profile (customer_detail_screen.dart). This drawer ports
// it: header stats (spend / visits / points / tier), active membership,
// favourite items and order history — same endpoint the app uses:
//   GET /businesses/:id/customer-history/:phone
// Response shape (backend customerHistoryService.profileForCashier):
//   { customer: {camelCase profile}, recentOrders: [snake_case rows],
//     favourites: [{name, n, qty_total}], activeMembership: {…}|null }
// NB: recentOrders rows come straight off the SQL query (snake_case,
// `total` is a pg-numeric STRING) — do not "fix" the casing here, the
// mobile app consumes the same raw shape and the backend is frozen for
// this bug. Per-order items are NOT in that payload; we lazy-load them
// via GET /orders/:orderId when a row is expanded (see OrderRow).
//
// WHY a hand-rolled fixed panel (2026-08-25): src/components/ui/ has no
// shadcn sheet/drawer primitive and this bug is dashboard-only, so we
// build a right-side overlay panel with Tailwind instead of adding a new
// ui dependency.

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import axios from 'axios';
import {
  X, Receipt, Heart, CreditCard, Award, Star, Wallet,
  ChevronDown, ChevronUp, Loader2, Plus, Ban, AlertTriangle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
// WHY `api` directly (2026-08-25): ffApi has no customer-history or
// single-order binding and the api files are out of scope for this fix,
// so we call the endpoints with the shared axios instance + cached
// business id, exactly like ffApi's own helpers do internally.
// ffApi IS used where a binding already exists (listMemberships for the
// plan picker, lookupCustomer for the subscription id — see WHY below).
import { api, apiError, getBusinessCache } from '@/api/client';
import { ffApi } from '@/api/namastepos';
import { formatINR, formatDate, formatDateTime } from '@/lib/utils';

// ── Types (mirror backend response, see header comment) ──────────────────

/** Minimal row shape passed in from the customers list table. */
export interface CustomerListRow {
  id: string;
  name?: string | null;
  phone: string;
  tier: string;
  visitCount: number;
  totalSpent: number;
  pointsBalance: number;
  lastOrderAt?: string | null;
}

interface HistoryProfile {
  customer: {
    id: string;
    name: string | null;
    phone: string;
    emailMasked: string | null;
    birthday: string | null;
    tier: string;
    pointsBalance: number;
    totalOrders: number;
    totalSpent: number;
    firstOrderAt: string | null;
    lastOrderAt: string | null;
    notes: string | null;
    walletInr: number;
  };
  // Raw SQL rows — snake_case; `total` is a numeric string.
  recentOrders: Array<{
    id: string;
    order_no: number;
    created_at: string;
    total: string;
    status: string;
  }>;
  favourites: Array<{
    menu_item_id: string | null;
    name: string;
    n: number;         // number of orders containing the item
    qty_total: number; // total units ever ordered
  }>;
  activeMembership: {
    name: string;
    expires_at: string;
    benefits: Record<string, unknown> | null;
    // Bundle balance: [{menuItemId, qty}] — qty units left.
    remaining: Array<{ menuItemId?: string; qty: number }> | null;
  } | null;
}

// GET /businesses/:id/customers/:customerId/wallet (giftCardService.getWallet).
// Backend returns INR floats + the raw ledger `kind` as `reason`.
interface WalletData {
  balanceInr: number;
  transactions: Array<{
    id: string;
    orderId: string | null;
    reason: string;
    amountInr: number; // positive = credit, negative = debit
    note: string | null;
    createdAt: string;
  }>;
}

// Membership plan row (snake_case straight from the memberships table —
// same shape MembershipsPage consumes via ffApi.listMemberships).
interface MembershipPlan {
  id: string;
  name: string;
  description: string | null;
  price_paise: number;
  validity_days: number;
}

// membershipService.activeForCustomer row, surfaced by GET /customers/lookup.
interface ActiveSubscription {
  subscription_id: string;
  membership_id: string;
  name: string;
  price_paise: number;
  validity_days: number;
  expires_at: string;
}

// POST /customer-memberships/:id/cancel → `refund` (backend computes it —
// bundle- or time-based unused share; NOT reproducible client-side).
interface CancelRefund {
  mode: 'wallet' | 'cash' | 'upi';
  basis: 'bundle' | 'time';
  remainingValueInr: number;
  cancellationPct: number;
  cancellationFeeInr: number;
  refundInr: number;
}

interface OrderDetail {
  id: string;
  orderNo: number;
  status: string;
  total: number;
  items: Array<{
    id: string;
    name: string;
    qty: number;
    price: number;
    variantLabel: string | null;
    note: string | null;
  }>;
}

// Same tier styling as the customers table so the drawer badge matches.
const TIER_COLORS: Record<string, 'muted' | 'secondary' | 'default'> = {
  bronze: 'muted', silver: 'secondary', gold: 'default',
};
const TIER_ICONS: Record<string, typeof Award> = {
  bronze: Award, silver: Star, gold: Award,
};

// Humanized wallet-ledger labels (2026-08-25). Keys are the raw `kind`
// values giftCardService writes; anything unknown falls back to the raw
// key so a future ledger reason is never rendered as a blank row.
const WALLET_REASON_LABELS: Record<string, string> = {
  order_payment: 'Order payment',
  shortfall: 'Shortfall due',
  membership_refund: 'Membership refund',
  topup: 'Top-up',
  redeem: 'Redeemed',
  manual_adjust: 'Manual adjustment',
  gift_card_load: 'Gift card load',
};

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-800',
  ready: 'bg-blue-100 text-blue-800',
  collected: 'bg-emerald-100 text-emerald-800',
  cancelled: 'bg-red-100 text-red-700',
};

// ── Drawer ────────────────────────────────────────────────────────────────

export function CustomerDetailDrawer({
  customer,
  onClose,
}: {
  customer: CustomerListRow;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  // 'add' = sell a plan, 'cancel' = refund flow, null = no dialog open.
  const [membershipDialog, setMembershipDialog] = useState<'add' | 'cancel' | null>(null);

  const { data, isLoading, error } = useQuery<HistoryProfile | null>({
    queryKey: ['customer-history', customer.phone],
    queryFn: async () => {
      const b = getBusinessCache();
      try {
        const r = await api.get(
          `/businesses/${b.id}/customer-history/${encodeURIComponent(customer.phone)}`,
        );
        return r.data as HistoryProfile;
      } catch (e) {
        // 404 = the phone has no CRM row yet (shouldn't normally happen
        // from this page since the row came FROM the customers table,
        // but a just-deleted customer could race us). Treat as "no
        // history" rather than an error toast.
        if (axios.isAxiosError(e) && e.response?.status === 404) return null;
        throw e;
      }
    },
    retry: false,
  });

  // Wallet card (2026-08-25, founder: wallet visibility on the customer
  // screen). 402 = the plan doesn't include the wallet feature → return
  // null and hide the whole section instead of erroring.
  const {
    data: wallet,
    isLoading: walletLoading,
    error: walletError,
  } = useQuery<WalletData | null>({
    queryKey: ['customer-wallet', customer.id],
    queryFn: async () => {
      const b = getBusinessCache();
      try {
        const r = await api.get(
          `/businesses/${b.id}/customers/${customer.id}/wallet`,
        );
        return r.data as WalletData;
      } catch (e) {
        if (axios.isAxiosError(e) && e.response?.status === 402) return null;
        throw e;
      }
    },
    retry: false,
  });

  // Everything money-related in the drawer can change after a membership
  // sale/cancel (wallet ledger, walletInr on the profile, activeMembership),
  // so refresh them together. The lookup key backs the cancel dialog's
  // subscription-id fetch (see CancelMembershipDialog).
  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ['customer-history', customer.phone] });
    qc.invalidateQueries({ queryKey: ['customer-wallet', customer.id] });
    qc.invalidateQueries({ queryKey: ['customer-active-subscription', customer.phone] });
  };

  // Surface real failures (network / 5xx) but keep the drawer open with
  // the list-row fallback data so the page isn't a dead end.
  useEffect(() => {
    if (error) toast.error(apiError(error));
  }, [error]);

  // Close on Escape — a hand-rolled panel doesn't get this for free the
  // way the shadcn Dialog does. While a membership dialog is open, Escape
  // belongs to the dialog (Radix closes it) — don't ALSO close the drawer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !membershipDialog) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, membershipDialog]);

  const prof = data?.customer;
  const TierIcon = TIER_ICONS[prof?.tier ?? customer.tier] || Award;
  const tier = prof?.tier ?? customer.tier;

  return (
    <div className="fixed inset-0 z-50">
      {/* Overlay — click to dismiss */}
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Right-side panel */}
      <aside
        role="dialog"
        aria-label="Customer details"
        className="absolute right-0 top-0 h-full w-full max-w-md bg-background border-l shadow-xl flex flex-col"
      >
        {/* Header */}
        <div className="flex items-start justify-between border-b p-4">
          <div>
            <h2 className="text-lg font-bold">
              {prof?.name || customer.name || customer.phone}
            </h2>
            <p className="text-sm text-muted-foreground">{customer.phone}</p>
            {prof?.emailMasked && (
              <p className="text-xs text-muted-foreground">{prof.emailMasked}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={TIER_COLORS[tier]} className="capitalize">
              <TierIcon className="mr-1 h-3 w-3" /> {tier}
            </Badge>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          {isLoading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading profile…
            </div>
          ) : (
            <>
              {/* Stats — fall back to the list-row values on 404/error so
                  the drawer always shows SOMETHING truthful. */}
              <div className="grid grid-cols-3 gap-2">
                <Stat label="Total spent"
                      value={formatINR(prof?.totalSpent ?? customer.totalSpent)} />
                <Stat label="Visits"
                      value={String(prof?.totalOrders ?? customer.visitCount)} />
                <Stat label="Points"
                      value={String(prof?.pointsBalance ?? customer.pointsBalance)} />
              </div>
              {/* Wallet — hidden entirely when the backend answers 402
                  (feature not on the business plan → wallet === null). */}
              {wallet !== null && (
                <section>
                  <SectionTitle icon={Wallet} text="Wallet" />
                  {walletLoading ? (
                    <div className="flex items-center py-2 text-sm text-muted-foreground">
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading wallet…
                    </div>
                  ) : walletError ? (
                    <p className="text-sm text-muted-foreground">Couldn't load wallet.</p>
                  ) : wallet ? (
                    <div className="rounded-md border">
                      <div className="flex items-center justify-between p-3">
                        <span className="text-sm text-muted-foreground">Balance</span>
                        <div className="text-right">
                          <div className={`text-base font-bold ${wallet.balanceInr < 0 ? 'text-red-600' : ''}`}>
                            {formatINR(wallet.balanceInr, { decimals: true })}
                          </div>
                          {/* Negative wallet = recorded shortfall debt
                              ("customer underpaid, owes us"). */}
                          {wallet.balanceInr < 0 && (
                            <div className="text-[11px] text-red-600">
                              Customer owes this amount
                            </div>
                          )}
                        </div>
                      </div>
                      {wallet.transactions.length > 0 && (
                        <ul className="divide-y border-t">
                          {wallet.transactions.slice(0, 10).map((t) => (
                            <li key={t.id} className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                              <div className="min-w-0">
                                <div className="font-medium">
                                  {WALLET_REASON_LABELS[t.reason] ?? t.reason}
                                </div>
                                {t.note && (
                                  <div className="truncate text-muted-foreground">{t.note}</div>
                                )}
                                <div className="text-muted-foreground">
                                  {formatDateTime(t.createdAt)}
                                </div>
                              </div>
                              <span className={`shrink-0 font-semibold ${t.amountInr < 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                                {t.amountInr < 0 ? '−' : '+'}
                                {formatINR(Math.abs(t.amountInr), { decimals: true })}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ) : null}
                </section>
              )}

              {/* Membership */}
              <section>
                <SectionTitle icon={CreditCard} text="Membership" />
                {data?.activeMembership ? (
                  <div className="rounded-md border p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{data.activeMembership.name}</span>
                      <Badge variant="secondary">
                        Valid till {formatDate(data.activeMembership.expires_at)}
                      </Badge>
                    </div>
                    {Array.isArray(data.activeMembership.remaining) &&
                      data.activeMembership.remaining.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {/* WHY generic label (2026-08-25): remaining entries
                            only carry menuItemId; mobile resolves names via
                            its MenuProvider cache which the dashboard lacks
                            on this page — showing the count is still useful
                            ("12× left" on the bundle). */}
                        {data.activeMembership.remaining.map((r, i) => (
                          <Badge key={r.menuItemId ?? i} variant="muted">
                            {r.qty}× bundle item left
                          </Badge>
                        ))}
                      </div>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full text-destructive"
                      onClick={() => setMembershipDialog('cancel')}
                    >
                      <Ban className="mr-1 h-3.5 w-3.5" /> Cancel membership
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">No active membership.</p>
                    {/* Selling needs the profile row (customer id is on the
                        list row, so only require the history load to have
                        settled — a 404'd profile can still be sold to). */}
                    {!isLoading && (
                      <Button size="sm" onClick={() => setMembershipDialog('add')}>
                        <Plus className="mr-1 h-3.5 w-3.5" /> Add membership
                      </Button>
                    )}
                  </div>
                )}
              </section>

              {/* Favourites */}
              <section>
                <SectionTitle icon={Heart} text="Usually orders" />
                {data?.favourites?.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {data.favourites.map((f) => (
                      <Badge key={`${f.menu_item_id}-${f.name}`} variant="secondary">
                        {f.name} ×{f.qty_total}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No favourite items yet.</p>
                )}
              </section>

              {/* Order history */}
              <section>
                <SectionTitle icon={Receipt} text="Order history" />
                {data?.recentOrders?.length ? (
                  <div className="space-y-2">
                    {data.recentOrders.map((o) => (
                      <OrderRow key={o.id} order={o} />
                    ))}
                    <p className="text-xs text-muted-foreground pt-1">
                      Showing the {data.recentOrders.length} most recent orders.
                    </p>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No orders yet. Orders appear here once this phone number is
                    used at checkout.
                  </p>
                )}
              </section>
            </>
          )}
        </div>
      </aside>

      {/* Membership sell / cancel dialogs (Radix portals to <body>, so
          they stack above this hand-rolled z-50 panel). */}
      {membershipDialog === 'add' && (
        <AddMembershipDialog
          customerId={customer.id}
          walletBalanceInr={wallet ? wallet.balanceInr : null}
          onClose={() => setMembershipDialog(null)}
          onDone={() => { refreshAll(); setMembershipDialog(null); }}
        />
      )}
      {membershipDialog === 'cancel' && data?.activeMembership && (
        <CancelMembershipDialog
          customerPhone={customer.phone}
          membershipName={data.activeMembership.name}
          onClose={() => setMembershipDialog(null)}
          onDone={() => { refreshAll(); setMembershipDialog(null); }}
        />
      )}
    </div>
  );
}

// ── Membership dialogs (2026-08-25, founder: sell/cancel with payment) ────

/**
 * Sell a plan to this customer. POST /memberships/subscribe records the
 * sale with a real tender (cash/upi/card/wallet) so it lands in revenue
 * reporting (membership_subscriptions.amount_paid_paise + payment_method
 * → income statement "Membership sales").
 */
function AddMembershipDialog({
  customerId,
  walletBalanceInr,
  onClose,
  onDone,
}: {
  customerId: string;
  /** null when the wallet section is hidden (402 / not loaded). */
  walletBalanceInr: number | null;
  onClose: () => void;
  onDone: () => void;
}) {
  // Reuse the MembershipsPage query key so the plan list is shared with
  // (and warmed by) that page's cache.
  const { data: plans = [], isLoading, error } = useQuery<MembershipPlan[]>({
    queryKey: ['memberships'],
    queryFn: ffApi.listMemberships,
  });
  const [planId, setPlanId] = useState('');
  const [method, setMethod] = useState<'cash' | 'upi' | 'card' | 'wallet'>('cash');

  const plan = plans.find((p) => p.id === planId);
  const priceInr = plan ? plan.price_paise / 100 : 0;
  // Wallet tender is only offered when the balance covers the full price —
  // the backend debits atomically and would 400 on insufficient funds, so
  // don't present a tender we know will fail.
  const walletOk = walletBalanceInr != null && plan != null && walletBalanceInr >= priceInr;
  // Guard against a stale 'wallet' selection after switching to a plan the
  // balance can't cover (state persists across plan changes).
  const effectiveMethod = method === 'wallet' && !walletOk ? 'cash' : method;

  const subscribe = useMutation({
    mutationFn: async () => {
      const b = getBusinessCache();
      const r = await api.post(`/businesses/${b.id}/memberships/subscribe`, {
        customerId,
        membershipId: planId,
        paymentMethod: effectiveMethod,
      });
      return r.data.subscription;
    },
    onSuccess: () => {
      toast.success(
        `${plan?.name ?? 'Membership'} sold — ${formatINR(priceInr, { decimals: true })} by ${effectiveMethod === 'upi' ? 'UPI' : effectiveMethod}`,
      );
      onDone();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const methods: Array<{ key: typeof method; label: string; disabled: boolean; hint?: string }> = [
    { key: 'cash', label: 'Cash', disabled: false },
    { key: 'upi', label: 'UPI', disabled: false },
    { key: 'card', label: 'Card', disabled: false },
    {
      key: 'wallet',
      label: 'Wallet',
      disabled: !walletOk,
      hint: walletBalanceInr == null
        ? undefined
        : `${formatINR(walletBalanceInr, { decimals: true })} available`,
    },
  ];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add membership</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Plan *</Label>
            {isLoading ? (
              <div className="flex items-center py-2 text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading plans…
              </div>
            ) : error ? (
              <p className="py-1 text-sm text-muted-foreground">Couldn't load plans.</p>
            ) : plans.length === 0 ? (
              <p className="py-1 text-sm text-muted-foreground">
                No membership plans yet — create one on the Memberships page first.
              </p>
            ) : (
              <select
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={planId}
                onChange={(e) => setPlanId(e.target.value)}
              >
                <option value="">Select plan…</option>
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {formatINR(p.price_paise / 100, { decimals: true })}
                  </option>
                ))}
              </select>
            )}
            {plan && (
              <p className="mt-1 text-xs text-muted-foreground">
                Valid {plan.validity_days} days · charges{' '}
                {formatINR(priceInr, { decimals: true })} now.
              </p>
            )}
          </div>

          <div>
            <Label>Payment method</Label>
            <div className="mt-1 grid grid-cols-4 gap-2">
              {methods.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  disabled={m.disabled}
                  onClick={() => setMethod(m.key)}
                  className={`rounded-md border px-2 py-2 text-sm font-medium ${
                    effectiveMethod === m.key
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'bg-background'
                  } ${m.disabled ? 'cursor-not-allowed opacity-40' : 'hover:bg-muted/50'}`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            {walletBalanceInr != null && (
              <p className="mt-1 text-xs text-muted-foreground">
                Wallet balance {formatINR(walletBalanceInr, { decimals: true })}
                {plan && !walletOk ? " — not enough for this plan's price." : ''}
              </p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={() => subscribe.mutate()}
            disabled={!planId || subscribe.isPending}
          >
            {subscribe.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {plan
              ? `Charge ${formatINR(priceInr, { decimals: true })}`
              : 'Sell membership'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Cancel the active subscription with a refund of the unused share.
 * The refund maths (bundle- vs time-based) lives server-side, so the
 * dialog only collects inputs and shows the returned summary.
 */
function CancelMembershipDialog({
  customerPhone,
  membershipName,
  onClose,
  onDone,
}: {
  customerPhone: string;
  membershipName: string;
  onClose: () => void;
  onDone: () => void;
}) {
  // WHY lookup here (2026-08-25): the customer-history payload's
  // activeMembership has NO subscription id (customerHistoryService only
  // selects m.name, ms.expires_at, m.benefits, ms.remaining) and the
  // backend is frozen for this change. GET /customers/lookup?phone= DOES
  // return it (membershipService.activeForCustomer → subscription_id),
  // and ffApi.lookupCustomer already binds it — so we fetch the id from
  // there when the dialog opens.
  const { data: sub, isLoading, error } = useQuery<ActiveSubscription | null>({
    queryKey: ['customer-active-subscription', customerPhone],
    queryFn: async () => {
      const r = await ffApi.lookupCustomer(customerPhone);
      return (r.membership ?? null) as ActiveSubscription | null;
    },
    retry: false,
  });

  // Keep the raw string so the field can be cleared while typing; parse
  // on use. Backend clamps to 0–100 anyway; we pre-validate for UX.
  const [pctRaw, setPctRaw] = useState('10');
  const [mode, setMode] = useState<'wallet' | 'cash' | 'upi'>('wallet');
  const pct = Number(pctRaw);
  const pctValid = pctRaw.trim() !== '' && Number.isFinite(pct) && pct >= 0 && pct <= 100;

  const cancel = useMutation({
    mutationFn: async () => {
      const b = getBusinessCache();
      const r = await api.post(
        `/businesses/${b.id}/customer-memberships/${sub!.subscription_id}/cancel`,
        { mode, cancellationPct: pct },
      );
      return r.data.refund as CancelRefund;
    },
    onSuccess: (refund) => {
      const amt = formatINR(refund.refundInr, { decimals: true });
      const fee = formatINR(refund.cancellationFeeInr, { decimals: true });
      // e.g. "₹180 credited to wallet after ₹20 fee"
      toast.success(
        refund.mode === 'wallet'
          ? `${amt} credited to wallet after ${fee} fee`
          : `${amt} to pay out by ${refund.mode === 'upi' ? 'UPI' : 'cash'} after ${fee} fee`,
      );
      onDone();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const modes: Array<{ key: typeof mode; label: string }> = [
    { key: 'wallet', label: 'Wallet credit (recommended)' },
    { key: 'cash', label: 'Cash' },
    { key: 'upi', label: 'UPI' },
  ];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel membership</DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center py-4 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading subscription…
          </div>
        ) : error || !sub ? (
          // No id → nothing to cancel against (race: it expired / was
          // cancelled elsewhere between drawer load and this click).
          <p className="py-2 text-sm text-muted-foreground">
            Couldn't find an active subscription for this customer — it may
            have just expired or been cancelled. Close and reopen the
            customer to refresh.
          </p>
        ) : (
          <div className="space-y-3">
            <p className="text-sm">
              Cancelling <strong>{sub.name || membershipName}</strong>.
            </p>

            <div>
              <Label>Cancellation charge (%)</Label>
              <Input
                type="number"
                min={0}
                max={100}
                value={pctRaw}
                onChange={(e) => setPctRaw(e.target.value)}
              />
              {!pctValid && (
                <p className="mt-1 text-xs text-red-600">Enter a value between 0 and 100.</p>
              )}
            </div>

            <div>
              <Label>Refund payout</Label>
              <div className="mt-1 space-y-1.5">
                {modes.map((m) => (
                  <label key={m.key} className="flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="refund-mode"
                      checked={mode === m.key}
                      onChange={() => setMode(m.key)}
                    />
                    {m.label}
                  </label>
                ))}
              </div>
            </div>

            {/* The exact ₹ figures depend on the unused bundle/time share
                which only the backend knows — so we state the rule, not a
                number, and show the real summary in the success toast. */}
            <div className="flex items-start gap-2 rounded-md bg-amber-50 p-3 text-xs text-amber-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Remaining value minus {pctValid ? pct : '—'}% cancellation
                charge will be refunded. The final amount is computed on
                confirm from the unused part of the plan.
              </span>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Keep membership</Button>
          <Button
            variant="destructive"
            onClick={() => cancel.mutate()}
            disabled={!sub || !pctValid || cancel.isPending}
          >
            {cancel.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Cancel &amp; refund
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Pieces ────────────────────────────────────────────────────────────────

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-primary/5 p-3 text-center">
      <div className="text-base font-bold">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function SectionTitle({ icon: Icon, text }: { icon: typeof Heart; text: string }) {
  return (
    <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
      <Icon className="h-4 w-4 text-primary" /> {text}
    </h3>
  );
}

/**
 * One order in the history list. The customer-history payload has no
 * per-order items (2026-08-25: verified in customerHistoryService.js —
 * it selects id/order_no/created_at/total/status only), so we fetch
 * GET /orders/:orderId lazily when the row is expanded. That keeps the
 * drawer open snappy (1 request) instead of N+1 on every click.
 */
function OrderRow({
  order,
}: {
  order: HistoryProfile['recentOrders'][number];
}) {
  const [expanded, setExpanded] = useState(false);

  const { data: detail, isLoading, error } = useQuery<OrderDetail>({
    queryKey: ['customer-order-detail', order.id],
    queryFn: async () => {
      const b = getBusinessCache();
      const r = await api.get(`/businesses/${b.id}/orders/${order.id}`);
      return r.data.order as OrderDetail;
    },
    enabled: expanded,
    staleTime: 5 * 60 * 1000, // order lines are immutable once placed
    retry: false,
  });

  useEffect(() => {
    if (error) toast.error(apiError(error));
  }, [error]);

  return (
    <div className="rounded-md border">
      <button
        type="button"
        className="flex w-full items-center gap-2 p-3 text-left hover:bg-muted/50"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm">Order #{order.order_no}</span>
            <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium capitalize ${STATUS_STYLES[order.status] || 'bg-muted text-muted-foreground'}`}>
              {order.status}
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            {formatDateTime(order.created_at)}
          </div>
        </div>
        {/* pg numeric arrives as a string — parse before formatting */}
        <span className="font-bold text-sm">
          {formatINR(parseFloat(order.total) || 0, { decimals: true })}
        </span>
        {expanded
          ? <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" />
          : <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />}
      </button>

      {expanded && (
        <div className="border-t px-3 py-2">
          {isLoading && (
            <div className="flex items-center py-2 text-xs text-muted-foreground">
              <Loader2 className="mr-2 h-3 w-3 animate-spin" /> Loading items…
            </div>
          )}
          {!isLoading && detail && (
            detail.items.length ? (
              <ul className="space-y-1 py-1">
                {detail.items.map((it) => (
                  <li key={it.id} className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate">
                      {it.qty}× {it.name}
                      {it.variantLabel && (
                        <span className="text-muted-foreground"> ({it.variantLabel})</span>
                      )}
                      {it.note && (
                        <span className="block text-xs text-muted-foreground italic truncate">
                          “{it.note}”
                        </span>
                      )}
                    </span>
                    <span className="text-muted-foreground shrink-0">
                      {formatINR(it.price * it.qty, { decimals: true })}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-1 text-xs text-muted-foreground">No line items on this order.</p>
            )
          )}
          {!isLoading && !detail && !!error && (
            <p className="py-1 text-xs text-muted-foreground">Couldn't load items.</p>
          )}
        </div>
      )}
    </div>
  );
}
