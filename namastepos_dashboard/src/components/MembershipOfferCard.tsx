// MembershipOfferCard — checkout-time membership renew / sell card.
//
// Round 3 (2026-09-06, founder Bug 2): when the attached customer's
// membership bundle is used up (remaining units 0) or expired, the cashier
// must see it at the moment of billing and be able to renew it — or sell a
// different plan — without leaving the order/settle dialog. Three states:
//
//   • usedUp   → "Membership <name> is used up — Renew ₹X" + the business's
//                other active plans as purchasable options
//   • none     → compact "Offer membership" control (collapsed by default;
//                expands to the plan list). Dismissible: it must never block
//                a busy counter.
//   • active   → renders nothing (the callers already show the member badge)
//
// Purchase = the EXISTING sale endpoint (POST /memberships/subscribe, same as
// CustomerDetailDrawer's AddMembershipDialog) — a real tender recorded against
// membership_subscriptions.amount_paid_paise. Renewal first tries
// POST /customer-memberships/:id/renew (round-3 contract); a 404 (route not
// shipped / subscription gone — nothing was charged either way) falls back to
// the same purchase for the same plan. After a sale the caller refetches the
// customer lookup so the new bundle applies to THIS bill.
//
// Gated on the `memberships` plan key (fail-closed via usePlan).

import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import axios from 'axios';
import { Crown, X, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, apiError, getBusinessCache } from '@/api/client';
import { formatINR } from '@/lib/utils';
import { usePlan } from '@/hooks/usePlan';
import {
  membershipOptions, membershipState, type MembershipOption,
} from '@/lib/checkout';

export type MembershipPayMethod = 'cash' | 'upi' | 'card' | 'online' | 'wallet';
const TENDERS: MembershipPayMethod[] = ['cash', 'upi', 'card', 'online'];

function subscribeApi(body: {
  customerId: string; membershipId: string; paymentMethod: string; clientKey: string;
}) {
  const b = getBusinessCache();
  return api.post(`/businesses/${b.id}/memberships/subscribe`, body).then((r) => r.data);
}
function renewApi(subscriptionId: string, body: { paymentMethod: string; clientKey: string }) {
  const b = getBusinessCache();
  return api.post(`/businesses/${b.id}/customer-memberships/${subscriptionId}/renew`, body)
    .then((r) => r.data);
}

const newKey = () => (typeof crypto !== 'undefined' && crypto.randomUUID
  ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

export function MembershipOfferCard({
  customerId, customerLabel, activeMembership, availableMemberships, rawPlans,
  walletBalanceInr, onPurchased, compact = false,
}: {
  customerId: string;
  customerLabel: string;
  /** Lookup's `activeMembership` (round-3 shape or legacy row), nullable. */
  activeMembership: any;
  /** Lookup's `availableMemberships` when the server sends it. */
  availableMemberships?: any[] | null;
  /** Fallback: raw GET /memberships rows (['memberships'] query). */
  rawPlans?: any[] | null;
  /** null = wallet unknown/hidden → no wallet tender. */
  walletBalanceInr?: number | null;
  onPurchased: () => void;
  /** Tighter paddings for the settle dialog. */
  compact?: boolean;
}) {
  const plan = usePlan();
  const state = useMemo(() => membershipState(activeMembership), [activeMembership]);
  const options = useMemo(
    () => membershipOptions(availableMemberships, rawPlans),
    [availableMemberships, rawPlans],
  );
  const [dismissed, setDismissed] = useState(false);
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState<MembershipOption | null>(null);
  const [isRenew, setIsRenew] = useState(false);
  const [method, setMethod] = useState<MembershipPayMethod>('cash');

  const buy = useMutation({
    mutationFn: async ({ opt, renew }: { opt: MembershipOption; renew: boolean }) => {
      const clientKey = newKey();
      const subId: string | null = renew ? (activeMembership?.id ?? activeMembership?.subscription_id ?? null) : null;
      if (renew && subId) {
        try {
          return await renewApi(subId, { paymentMethod: method, clientKey });
        } catch (e) {
          // 404 = renew route not deployed yet OR the subscription row is
          // gone. Neither charged anything, so a fresh purchase of the same
          // plan is the correct fallback. Anything else is a real error.
          if (!(axios.isAxiosError(e) && e.response?.status === 404)) throw e;
        }
      }
      return subscribeApi({
        customerId, membershipId: opt.id, paymentMethod: method, clientKey,
      });
    },
    onSuccess: (_d, { opt, renew }) => {
      toast.success(`${opt.name} ${renew ? 'renewed' : 'sold'} — ${formatINR(opt.pricePaise / 100, { decimals: true })} by ${method.toUpperCase()}. Benefits apply to this bill.`);
      setPicking(null);
      setOpen(false);
      setDismissed(true);
      onPurchased();
    },
    onError: (e: any) => toast.error(apiError(e) || 'Could not sell membership'),
  });

  if (!plan.has('memberships')) return null;
  if (dismissed) return null;
  if (state && !state.usedUp) return null;      // healthy member — nothing to pitch
  if (options.length === 0 && !(state?.usedUp && state.renewPricePaise)) return null;

  // The plan behind the used-up membership, for the Renew price/button.
  const renewOpt: MembershipOption | null = state?.usedUp
    ? (options.find((o) => o.id === state.membershipId)
      ?? (state.membershipId && state.renewPricePaise
        ? { id: state.membershipId, name: state.name, pricePaise: state.renewPricePaise }
        : null))
    : null;
  const others = options.filter((o) => o.id !== renewOpt?.id);
  const walletOk = (opt: MembershipOption) =>
    walletBalanceInr != null && walletBalanceInr >= opt.pricePaise / 100;
  const pad = compact ? 'px-2.5 py-1.5' : 'px-3 py-2';

  const tenderRow = (opt: MembershipOption, renew: boolean) => (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="membership-tender">
      <select value={method}
        onChange={(e) => setMethod(e.target.value as MembershipPayMethod)}
        className="h-7 rounded-md border border-input bg-background px-2 text-xs capitalize">
        {TENDERS.map((m) => <option key={m} value={m}>{m}</option>)}
        {walletOk(opt) && (
          <option value="wallet">wallet — {formatINR(walletBalanceInr!, { decimals: true })}</option>
        )}
      </select>
      <Button size="sm" className="h-7 text-xs"
        onClick={() => buy.mutate({ opt, renew })} disabled={buy.isPending}>
        {buy.isPending ? '…' : `Confirm ${formatINR(opt.pricePaise / 100, { decimals: true })}`}
      </Button>
      <Button size="sm" variant="ghost" className="h-7 text-xs"
        onClick={() => setPicking(null)} disabled={buy.isPending}>Back</Button>
    </div>
  );

  const optionRow = (opt: MembershipOption, renew: boolean) => (
    <div key={opt.id} className="flex items-center justify-between gap-2">
      <span className="min-w-0 truncate">
        <strong>{opt.name}</strong>
        {' '}· {formatINR(opt.pricePaise / 100, { decimals: true })}
        {opt.validityDays ? <span className="text-muted-foreground"> · {opt.validityDays}d</span> : null}
      </span>
      {picking?.id === opt.id && isRenew === renew ? null : (
        <Button size="sm" variant={renew ? 'default' : 'outline'} className="h-7 text-xs shrink-0"
          onClick={() => { setPicking(opt); setIsRenew(renew); setMethod(walletOk(opt) ? 'wallet' : 'cash'); }}>
          {renew ? <><RefreshCw className="mr-1 h-3 w-3" /> Renew</> : 'Buy'}
        </Button>
      )}
    </div>
  );

  // ── Used-up membership → renew card ───────────────────────────────────
  if (state?.usedUp) {
    return (
      <div className={`rounded-md border border-amber-300 bg-amber-50 ${pad} text-xs text-amber-900 space-y-2`}
        data-testid="membership-usedup-card">
        <div className="flex items-start justify-between gap-2">
          <span className="flex items-center gap-1.5">
            <Crown className="h-3.5 w-3.5 shrink-0" />
            <span>
              <strong>{customerLabel}</strong>'s membership <strong>{state.name}</strong> is{' '}
              {state.expired && !state.exhausted ? 'expired' : 'used up'}
              {renewOpt ? <> — renew for {formatINR(renewOpt.pricePaise / 100, { decimals: true })}</> : null}.
            </span>
          </span>
          <button onClick={() => setDismissed(true)} className="p-0.5 hover:bg-amber-100 rounded" title="Dismiss">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        {renewOpt && optionRow(renewOpt, true)}
        {picking && isRenew && tenderRow(picking, true)}
        {others.length > 0 && (
          <div className="border-t border-amber-200 pt-1.5 space-y-1">
            <div className="text-[10px] font-bold uppercase tracking-wide text-amber-800/80">Other plans</div>
            {others.map((o) => optionRow(o, false))}
            {picking && !isRenew && tenderRow(picking, false)}
          </div>
        )}
      </div>
    );
  }

  // ── No membership → compact "Offer membership" control ────────────────
  return (
    <div className={`rounded-md border border-violet-300 bg-violet-50 ${pad} text-xs text-violet-900 space-y-1.5`}
      data-testid="membership-offer-card">
      <div className="flex items-center justify-between gap-2">
        <button type="button" onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 font-semibold hover:underline">
          <Crown className="h-3.5 w-3.5 shrink-0" />
          Offer membership{options.length > 0 ? ` (from ${formatINR(Math.min(...options.map((o) => o.pricePaise)) / 100)})` : ''}
          <span className="text-violet-700/70">{open ? '▴' : '▾'}</span>
        </button>
        <button onClick={() => setDismissed(true)} className="p-0.5 hover:bg-violet-100 rounded" title="Dismiss">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {open && (
        <div className="space-y-1">
          {options.map((o) => optionRow(o, false))}
          {picking && tenderRow(picking, false)}
        </div>
      )}
    </div>
  );
}
