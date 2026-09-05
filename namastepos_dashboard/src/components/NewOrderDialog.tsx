// NamastePOS dashboard — walk-in / counter POS dialog.
//
// Features wired:
//   • Source picker (Dine-in / Takeaway) + table chooser
//   • Item variants (Half/Full/Medium chips below the parent)
//   • Modifier groups — tap an item with modifiers → modal picker
//     (Spice level, +Extra cheese ₹30, etc.) before adding to cart
//   • Cart with per-line variant + modifier capture (so 2× "no onion" and
//     1× "extra cheese" coexist as separate lines)
//   • Upsell suggestions strip — "Customers also ordered…"
//   • Voice command — "two paneer tikka one naan" → parses into cart
//   • Customer phone autocomplete + auto-apply active membership discount
//   • Returning-customer name autofill + "N visits" hint (Bug #3a, 2026-08-25)
//   • Per-line order notes — "No onions, less spicy…" (Bug #3b, 2026-08-25)
//   • Save KOT (postpaid, dine-in only) vs Pay & place (immediate)
//   • Pay-step rework (2026-08-25, founder): discount capped at subtotal,
//     points balance chip + "Redeem N pts" toggle (pointsToRedeem),
//     membership offer card (sell cheapest plan inline), and split payments
//     (2-3 legs incl. wallet-as-tender with live balance + remaining meter)
//   • GST (2026-09-05, review P0): NO manual tax input. The estimate shown
//     (CGST + SGST) is computed from each cart line's `gstPct` (lib/gstEstimate,
//     a port of the server's computeGstBreakdown) and `tax` is OMITTED from the
//     create body so the server computes and persists GST from
//     menu_items.gst_pct. Composition-scheme businesses see no GST rows.
//   • Round 3 (2026-09-06, founder Bug 1/1b/2): the request body is built by
//     the pure, unit-tested `buildOrderBody` (lib/checkout). The wallet row
//     is shown in the totals (due = total − points − wallet) with an optional
//     cap (`walletCapInr`); when the balance is short the cashier gets
//     "Cover shortfall" (explicit wallet + tender legs) and "Top up wallet";
//     a used-up membership shows a Renew card (MembershipOfferCard).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Plus, Minus, Search, Trash2, ShoppingCart, Sparkles, Crown, StickyNote, History,
  Coins,
} from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { ffApi } from '@/api/namastepos';
import { api, apiError, getBusinessCache } from '@/api/client';
import { trackFirstKot, trackFirstBill } from '@/lib/activation';
import { formatINR } from '@/lib/utils';
import { VoiceCommand, parseSpokenOrder } from '@/components/VoiceCommand';
import { usePlan, useMe } from '@/hooks/usePlan';
import { estimateGst, schemeChargesNoGst } from '@/lib/gstEstimate';
import { buildOrderBody, planWallet } from '@/lib/checkout';
import { WalletTopUpDialog } from '@/components/WalletTopUpDialog';
import { MembershipOfferCard } from '@/components/MembershipOfferCard';

// ── Pay-step endpoints without ffApi bindings (2026-08-25, founder) ──────
// This dialog is currently their only dashboard consumer, so they live
// local to the file — same pattern as TablesPage's joinTableApi.
// Wallet read: {balanceInr, transactions}. The loyalty addon gate can 402
// this — the caller treats ANY error as "hide the wallet tender".
function customerWalletApi(customerId: string) {
  const b = getBusinessCache();
  return api
    .get(`/businesses/${b.id}/customers/${customerId}/wallet`)
    .then((r) => r.data as { balanceInr: number; transactions: any[] });
}
// Round 3 (2026-09-06): the inline cheapest-plan sell card + its
// subscribeMembershipApi moved into the shared MembershipOfferCard (which
// also handles the used-up → Renew case for Bug 2).

// One split-payment leg. amountInr stays a STRING while typing so the
// cashier can clear the field / type "12.5" without the input snapping —
// parsed only for math + submit.
type PayLeg = {
  method: 'cash' | 'upi' | 'card' | 'online' | 'wallet';
  amountInr: string;
};
const SPLIT_METHODS = ['cash', 'upi', 'card', 'online'] as const;

type ModLine = { modifierId: string; name: string; priceDeltaInr: number; qty: number };
type CartLine = {
  lineKey: string;          // unique row id (multiple modifier combos per item)
  menuItemId: string;
  name: string;
  price: number;            // already includes variant + modifier deltas per unit
  qty: number;
  // 2026-09-05: the menu item's GST slab (menu_items.gst_pct via the API's
  // `gstPct`). Variants share the parent's slab — the server applies
  // `mi.gst_pct` to the variant+modifier line price, so a variant line must
  // carry the PARENT's pct. null/undefined → 0% (matches server parseFloat(gst_pct||0)).
  gstPct?: number | null;
  variantId?: string | null;
  variantLabel?: string | null;
  modifierLines?: ModLine[];
  note?: string;
};

type PreviousLine = { name: string; qty: number; price: number; lineTotal: number };

// ── NP-205 sold-out rules (migration 084) ───────────────────────────────
// `trackStock` is what makes a count mean anything: OFF = unlimited (the
// number in `stock` is ignored by the order path, so it must never read as
// sold out — that ambiguity is why an untracked menu at 0 used to look
// entirely unavailable), ON = finite, and empty means the server will reject
// the sale with 400 OUT_OF_STOCK. Mirror that here so the cashier is stopped
// at the tile instead of at the failed bill.
const variantSoldOut = (v: any) => v.trackStock === true && Number(v.stock ?? 0) <= 0;
// A dish with sizes is only unsellable when EVERY size is gone — one empty
// size must not hide the ones still in the kitchen.
const itemSoldOut = (m: any) => {
  const vs = Array.isArray(m.variants) ? m.variants : [];
  if (vs.length > 0) return vs.every(variantSoldOut);
  return m.trackStock === true && Number(m.stock ?? 0) <= 0;
};

type Props = {
  onClose: () => void;
  existingSession?: { id: string; tableId: string; tableLabel?: string;
                      customerPhone?: string; customerName?: string } | null;
  previousItems?: PreviousLine[];
  previousSubtotalInr?: number;
};

export function NewOrderDialog({
  onClose, existingSession = null,
  previousItems = [], previousSubtotalInr = 0,
}: Props) {
  const qc = useQueryClient();
  // D-06 (2026-09-05): `voice_pos` is a plan feature (registry: client-gated).
  // Speech recognition runs on-device so there is no route for the server to
  // 402 — this check IS the gate on web. Fail-closed: no mic until /auth/me
  // says the plan includes it.
  const plan = usePlan();
  // GST scheme (2026-09-05, migration 092): from the shared /auth/me query,
  // falling back to the business cache (same payload, persisted) so the
  // first render after a reload does not flash GST rows at a composition
  // dealer. Unknown/null → 'regular', exactly what the server assumes.
  const { data: me } = useMe();
  const gstScheme: string =
    me?.business?.gstScheme ?? getBusinessCache()?.gstScheme ?? 'regular';
  const billsWithoutGst = schemeChargesNoGst(gstScheme);

  // ── State ──────────────────────────────────────────────────────────────
  const [source, setSource] = useState<'dineIn' | 'takeaway'>('dineIn');
  const [tableNo, setTableNo] = useState(existingSession?.tableLabel || '');
  const [tableId, setTableId] = useState(existingSession?.tableId || '');
  const [customerPhone, setCustomerPhone] = useState(existingSession?.customerPhone || '');
  const [customerName, setCustomerName] = useState(existingSession?.customerName || '');
  // Bug #3a (2026-08-25): true once the cashier types in the name box.
  // Autofill from the phone lookup must never clobber a manually typed name
  // (e.g. staff correcting a misspelled name on file), so we gate on this.
  const [nameEditedByUser, setNameEditedByUser] = useState(false);
  // Bug #3b (2026-08-25): which cart lines have their note input expanded.
  // Keyed by lineKey (not menuItemId) so two lines of the same item can carry
  // different notes — matches the mobile app's per-line note model.
  const [noteOpen, setNoteOpen] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  // 2026-09-05: the manual `tax` state is gone — see header. GST is derived
  // from the cart (`gst` memo below) and never sent to the server.
  const [discount, setDiscount] = useState(0);
  const [discountIsPreTax, setDiscountIsPreTax] = useState(true);
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'upi' | 'card' | 'unpaid'>(
    existingSession ? 'unpaid' : 'cash'
  );
  // ── Pay-step rework state (2026-08-25, founder) ───────────────────────
  // Points redemption is an explicit opt-in toggle (never auto-applied —
  // customers often want to save points), split mode keeps single-method
  // untouched when off, and the membership offer is dismissible because
  // it must never block a busy cashier.
  const [redeemPoints, setRedeemPoints] = useState(false);
  const [splitOn, setSplitOn] = useState(false);
  const [legs, setLegs] = useState<PayLeg[]>([
    { method: 'cash', amountInr: '' }, { method: 'upi', amountInr: '' },
  ]);
  // Round 3 (2026-09-06, Bug 1/1b): optional cap on the wallet draw
  // (string while typing; '' = no cap → server uses min(due, balance)),
  // "Cover shortfall" mode (explicit wallet + tender legs) and the top-up
  // dialog. Gated on the `loyalty` key ("Loyalty points & wallet").
  const [walletCapInput, setWalletCapInput] = useState('');
  const [coverShortfall, setCoverShortfall] = useState(false);
  const [topUpOpen, setTopUpOpen] = useState(false);
  // Modifier picker state
  const [configuring, setConfiguring] = useState<any | null>(null);
  // Last added item — used to fetch upsell suggestions
  const [lastAddedItemId, setLastAddedItemId] = useState<string | null>(null);

  // ── Data ──────────────────────────────────────────────────────────────
  // NP-205 — `withVariants` so `item.variants` is actually populated. This
  // component has always branched on `item.variants` to decide whether to
  // open the size/add-on picker, but GET /menu never returned that key: a
  // dish with sizes was silently added to the cart at the PARENT price and
  // the picker below was unreachable. Key stays prefixed ['menu', …] so the
  // existing `invalidateQueries(['menu'])` calls after a menu edit still
  // refresh it.
  const { data: menu = [] } = useQuery({
    queryKey: ['menu', 'withVariants'],
    queryFn: () => ffApi.listMenuWithVariants(),
  });
  const { data: tables = [] } = useQuery({ queryKey: ['ops-tables'], queryFn: () => ffApi.listOpsTables() });
  const { data: modGroups = [] } = useQuery({
    queryKey: ['modifier-groups'], queryFn: () => ffApi.listModifierGroups(),
  });
  const { data: upsell = [] } = useQuery({
    queryKey: ['upsell', lastAddedItemId],
    queryFn: () => lastAddedItemId ? ffApi.upsellFor(lastAddedItemId) : Promise.resolve([]),
    enabled: !!lastAddedItemId,
  });
  // Customer profile (loyalty + active membership) — auto-loaded once phone is typed
  const { data: customerProfile } = useQuery({
    queryKey: ['cust-profile', customerPhone],
    queryFn: () => ffApi.customerProfile(customerPhone),
    enabled: customerPhone.length >= 7,
    retry: false,
  });
  // Loyalty settings drive the redeem toggle: redemptionValueInr (₹ per
  // point), minRedemptionPoints (floor) and maxRedemptionPct (bill cap) —
  // same knobs loyaltyService.maxRedeemablePoints enforces server-side.
  // retry:false + error-as-hide: a 402 (loyalty addon missing) simply
  // removes the redemption UI instead of retry-spamming the gate.
  const { data: loyaltySettings } = useQuery({
    queryKey: ['loyalty-settings'],
    queryFn: () => ffApi.getLoyaltySettings(),
    retry: false,
  });
  // Membership plans for the "offer a membership" card. List endpoint
  // returns RAW rows (price_paise, is_active) — see MembershipsPage.
  const { data: membershipPlans = [] } = useQuery({
    queryKey: ['memberships'],
    queryFn: () => ffApi.listMemberships(),
    retry: false,
  });
  // Wallet balance — only once a real customer is matched (wallet-as-tender
  // is meaningless for anonymous walk-ins) and hidden entirely on error
  // (402 when the loyalty addon is missing).
  const customerId: string | undefined = customerProfile?.customer?.id;
  const { data: walletInfo, isError: walletError } = useQuery({
    queryKey: ['cust-wallet', customerId],
    queryFn: () => customerWalletApi(customerId!),
    enabled: !!customerId,
    retry: false,
  });

  // Auto-apply membership percentage discount.
  // Bug fix (2026-08-30): the old effect ran ONLY when customerProfile changed
  // and bailed if `discount` was already set. On the common flow the cashier
  // types the phone first (which loads the profile) while the cart is still
  // empty, so subtotal was 0 → discount 0, and it never recomputed as items
  // were added — the member silently paid full price. The backend does NOT
  // apply discount_pct on its own, so this is the only place it happens.
  // Now we recompute whenever the cart or profile changes, and only touch the
  // discount when the current value is our own last auto-applied figure (so a
  // manually typed discount is never clobbered).
  const memberDiscountRef = useRef(0);
  useEffect(() => {
    const mb = customerProfile?.activeMembership;
    const pct = Number(mb?.benefits?.discount_pct || 0);
    const subtotalNow = cart.reduce((s, l) => s + l.price * l.qty, 0);
    const auto = pct > 0 ? +(subtotalNow * pct / 100).toFixed(2) : 0;
    // Only manage the discount if it is untouched (0) or still equal to the
    // membership figure we last set — never override a manual entry.
    const isOursOrEmpty = discount === 0 || discount === memberDiscountRef.current;
    if (pct > 0 && isOursOrEmpty && auto !== discount) {
      if (auto > 0 && memberDiscountRef.current === 0) {
        toast.success(`Member discount ${pct}% applied (${formatINR(auto)})`);
      }
      setDiscount(auto);
      memberDiscountRef.current = auto;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerProfile, cart]);

  // Bug #3a (2026-08-25): auto-fill the customer's name once the phone lookup
  // matches. The profile was already fetched for loyalty/memberships — staff
  // were still retyping names we had on file. Fill only when the field is
  // empty or untouched, so manual typing always wins over the lookup.
  useEffect(() => {
    const known = customerProfile?.customer?.name;
    if (known && (!customerName.trim() || !nameEditedByUser)) {
      setCustomerName(known);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerProfile]);

  // ── Cart helpers ──────────────────────────────────────────────────────
  const _addLine = (line: Omit<CartLine, 'lineKey'>) => {
    const lineKey = [
      line.menuItemId, line.variantId || '',
      ...(line.modifierLines || []).map((m) => m.modifierId).sort(),
    ].join('|');
    setCart((c) => {
      const existing = c.find((x) => x.lineKey === lineKey);
      if (existing) {
        return c.map((x) => x.lineKey === lineKey ? { ...x, qty: x.qty + line.qty } : x);
      }
      return [...c, { ...line, lineKey }];
    });
    setLastAddedItemId(line.menuItemId);
  };

  const addItem = (item: any) => {
    const hasVariants = Array.isArray(item.variants) && item.variants.length > 0;
    const hasMods = Array.isArray(item.modifierGroupIds) && item.modifierGroupIds.length > 0;
    if (hasVariants || hasMods) {
      setConfiguring(item);
      return;
    }
    _addLine({
      menuItemId: item.id, name: item.name, price: parseFloat(item.price), qty: 1,
      gstPct: item.gstPct == null ? null : Number(item.gstPct),
    });
  };

  const bump = (lineKey: string, delta: number) => {
    setCart((c) => {
      return c.map((x) => x.lineKey === lineKey ? { ...x, qty: x.qty + delta } : x)
              .filter((x) => x.qty > 0);
    });
  };
  const remove = (lineKey: string) => setCart((c) => c.filter((x) => x.lineKey !== lineKey));

  // Bug #3b (2026-08-25): per-line kitchen note ("No onions"). Stored on the
  // cart line so the KOT prints it against the exact item, same as mobile.
  const setLineNote = (lineKey: string, note: string) => {
    setCart((c) => c.map((x) => (x.lineKey === lineKey ? { ...x, note } : x)));
  };
  const toggleNote = (lineKey: string) => {
    setNoteOpen((prev) => ({ ...prev, [lineKey]: !prev[lineKey] }));
  };

  // Subtotal from cart
  const subtotal = useMemo(() => cart.reduce((s, l) => s + l.price * l.qty, 0), [cart]);
  // GST estimate (2026-09-05): mirrors orderService — the server applies
  // menu_items.gst_pct to the RAW line amounts (before the cashier discount)
  // and, because `tax` is omitted from the body, adds that figure to
  // max(0, subtotal − discount). Composition scheme → all zeros. Rounding is
  // identical to computeGstBreakdown so split legs summed against this total
  // land within the server's ±₹0.01 tolerance.
  const gst = useMemo(
    () => estimateGst(
      cart.map((l) => ({ price: l.price, qty: l.qty, gstPct: l.gstPct })),
      gstScheme,
    ),
    [cart, gstScheme],
  );
  const tax = gst.totalGst;
  // `discountIsPreTax` no longer changes this number (GST is added on top
  // either way, exactly as the server does when `tax` is omitted); it is
  // still sent so the server's discount-eligibility check keeps its meaning.
  const total = Math.max(0, +(Math.max(0, subtotal - Number(discount)) + tax).toFixed(2));

  // ── Points redemption math (2026-08-25, founder) ──────────────────────
  // Client-side mirror of loyaltyService.maxRedeemablePoints: min(balance,
  // floor(bill × maxRedemptionPct% ÷ value-per-point)), gated on the
  // minRedemptionPoints floor. Display-only — the server re-caps on create,
  // so a stale balance can never over-redeem.
  const pointsBalance: number = customerProfile?.customer?.pointsBalance ?? 0;
  const redemption = useMemo(() => {
    if (!loyaltySettings?.isActive) return null;
    const valueInr = Number(loyaltySettings.redemptionValueInr) || 0;
    if (valueInr <= 0) return null;
    if (pointsBalance < (Number(loyaltySettings.minRedemptionPoints) || 0)) return null;
    const capInr = total * ((Number(loyaltySettings.maxRedemptionPct) || 0) / 100);
    const points = Math.min(pointsBalance, Math.floor(capInr / valueInr));
    if (points <= 0) return null;
    return { points, valueInr: +(points * valueInr).toFixed(2) };
  }, [loyaltySettings, pointsBalance, total]);
  const redeemValue = redeemPoints && redemption ? redemption.valueInr : 0;
  // What the customer actually pays. The backend deducts the redeemed
  // points from the order total BEFORE validating paymentBreakdown, so
  // split legs must sum to THIS number, not `total`.
  const payableTotal = Math.max(0, +(total - redeemValue).toFixed(2));

  // ── Split-payment math (2026-08-25, founder) ──────────────────────────
  // Round 3: prefer the lookup's `walletBalancePaise` (fresh with the
  // profile) and fall back to the /wallet read; either source counts as
  // "available". Both are invalidated after every order / top-up.
  const profileWalletPaise = customerProfile?.customer?.walletBalancePaise
    ?? customerProfile?.walletBalancePaise;
  const walletBalance: number = walletInfo?.balanceInr
    ?? (profileWalletPaise != null ? Number(profileWalletPaise) / 100 : 0);
  const walletAvailable = plan.has('loyalty') && !!customerId && !walletError
    && (!!walletInfo || profileWalletPaise != null);
  // Wallet-as-tender auto-apply (2026-08-30): pre-checked when a balance exists;
  // server sizes it against the true post-membership due. Off while a manual
  // split is being built.
  const [autoWalletOn, setAutoWalletOn] = useState(true);
  const legSum = legs.reduce((s, l) => s + (parseFloat(l.amountInr) || 0), 0);
  const splitRemaining = +(payableTotal - legSum).toFixed(2);
  const walletLegInr = legs
    .filter((l) => l.method === 'wallet')
    .reduce((s, l) => s + (parseFloat(l.amountInr) || 0), 0);
  // Client-side over-balance block mirrors the server's insufficient-wallet
  // 400 — catch it before the order round-trips and rolls back.
  const walletOver = walletLegInr > walletBalance + 0.001;
  // Backend Joi requires every leg amount to be POSITIVE and the sum to
  // match the total within ±₹0.01 — enforce both before enabling Place.
  const splitValid =
    Math.abs(splitRemaining) <= 0.01 && !walletOver &&
    legs.every((l) => (parseFloat(l.amountInr) || 0) > 0);
  const setLeg = (i: number, patch: Partial<PayLeg>) =>
    setLegs((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  // If the customer is cleared (or wallet 402s) while a wallet leg is
  // selected, silently fall that leg back to cash — a hidden option must
  // never stay selected or the order would 400 server-side.
  useEffect(() => {
    if (!walletAvailable) {
      setLegs((ls) => ls.some((l) => l.method === 'wallet')
        ? ls.map((l) => (l.method === 'wallet' ? { ...l, method: 'cash' as const } : l))
        : ls);
      setCoverShortfall(false);
    }
  }, [walletAvailable]);

  // ── Wallet draw on THIS order (round 3, 2026-09-06, Bug 1) ────────────
  // Mirror of the server's autoWallet sizing — min(due, balance, cap) — so
  // the totals show a "Wallet" line and the Pay button says what is really
  // collected in cash/UPI/card. `walletShort` = the balance alone cannot
  // cover the due (cap ignored) → offer Cover shortfall / Top up.
  const walletCap: number | null = walletCapInput.trim() === ''
    ? null : Math.max(0, parseFloat(walletCapInput) || 0);
  const walletTenderOn = !splitOn && paymentMethod !== 'unpaid'
    && walletAvailable && walletBalance > 0 && (autoWalletOn || coverShortfall);
  const walletPlan = planWallet(payableTotal, walletBalance, coverShortfall ? null : walletCap);
  const walletApplied = walletTenderOn ? walletPlan.walletInr : 0;
  const collectNow = Math.max(0, +(payableTotal - walletApplied).toFixed(2));
  const walletShort = planWallet(payableTotal, walletBalance, null);
  // Cover-shortfall only means something while the wallet is actually short;
  // if a top-up (or a smaller cart) fixes the gap, fall back to autoWallet.
  useEffect(() => {
    if (coverShortfall && !walletShort.shortfall) setCoverShortfall(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletShort.shortfall]);

  // Refetch everything money-related on the customer after a membership
  // sale/renewal so the new bundle/discount applies to THIS very order.
  const refetchCustomer = () => {
    qc.invalidateQueries({ queryKey: ['cust-profile', customerPhone] });
    qc.invalidateQueries({ queryKey: ['cust-wallet'] });
  };

  // ── Menu filter / categories ──────────────────────────────────────────
  const filteredMenu = useMemo(() => {
    const q = search.trim().toLowerCase();
    return menu
      .filter((m: any) => m.isActive !== false && !m.soldOutUntil)
      .filter((m: any) => !q || m.name.toLowerCase().includes(q));
  }, [menu, search]);

  const grouped = useMemo(() => {
    const g: Record<string, any[]> = {};
    for (const m of filteredMenu) (g[m.category || 'Other'] ||= []).push(m);
    return g;
  }, [filteredMenu]);

  // ── Voice command → parse + match menu items ─────────────────────────
  const onVoice = (text: string) => {
    const parsed = parseSpokenOrder(text);
    let matched = 0;
    for (const p of parsed) {
      const m = filteredMenu.find((it: any) =>
        it.name.toLowerCase().includes(p.name.toLowerCase()));
      if (m) {
        for (let i = 0; i < p.qty; i += 1) addItem(m);
        matched += p.qty;
      }
    }
    if (matched > 0) toast.success(`Added ${matched} item(s) from voice`);
    else toast.error(`Could not match: "${text}"`);
  };

  // ── Submit ────────────────────────────────────────────────────────────
  const create = useMutation({
    mutationFn: async (mode: 'pay' | 'kot') => {
      if (cart.length === 0) throw new Error('Add at least one item');
      if (source === 'dineIn' && !tableId && !existingSession) {
        throw new Error('Pick a table for dine-in');
      }
      // Split legs are validated client-side first so a mis-typed split
      // fails fast instead of a server 400 after the KOT round-trip.
      if (mode === 'pay' && splitOn && !splitValid) {
        throw new Error('Split payments must add up to the total (and stay within wallet balance)');
      }
      // Round 3 (2026-09-06): the body is assembled by the pure, unit-tested
      // buildOrderBody (lib/checkout). Rules it enforces — `tax` OMITTED so
      // the server computes GST from menu_items.gst_pct (review P0,
      // 2026-09-05); KOT = 'unpaid' with no points/wallet/legs; points only
      // with a customer phone; manual split → paymentBreakdown; Cover
      // shortfall → explicit [wallet, tender] legs; else the wallet toggle →
      // `autoWallet: true` (+ `walletCapInr`) and the server sizes the draw
      // as min(due, balance, cap) against the true post-membership due.
      const body = buildOrderBody({
        mode,
        source,
        tableNo,
        tableId,
        existingSessionId: existingSession?.id || null,
        cart,
        discount,
        discountIsPreTax,
        paymentMethod,
        customerPhone,
        customerName,
        redeemPoints,
        redemptionPoints: redemption?.points ?? null,
        splitOn,
        legs,
        autoWalletOn,
        walletAvailable,
        walletBalanceInr: walletBalance,
        walletCapInr: walletCap,
        coverShortfall,
        payableTotalInr: payableTotal,
        clientId: typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID() : undefined,
      });
      return ffApi.createOrder(body);
    },
    onSuccess: (o: any, mode) => {
      // ── Activation funnel ──────────────────────────────────────────────
      // first_kot: a 200 from POST /orders IS the KOT fire on web — the
      // tickets are generated inside the order transaction (orderService →
      // kotService.generateTickets) and queued to print in the same txn,
      // so there is no separate "fire" call to hook. Both modes count:
      // Save-KOT and Pay-&-place both put a ticket in front of the kitchen.
      trackFirstKot({ orderId: o?.id });
      // first_bill: only the pay path. A Save-KOT order is unpaid, so no
      // money has passed through NamastePOS yet. Both helpers are
      // first-time-only per business and cheap to call.
      if (mode === 'pay') {
        trackFirstBill({
          orderId: o?.id,
          amountInr: Number(o?.total ?? 0),
          // Server derives the primary method from the largest leg on a
          // split, so report the split explicitly instead.
          paymentMode: splitOn ? 'split' : (o?.paymentMethod || paymentMethod),
          // No receipt is produced by this dialog; OrdersPage's "Print
          // receipt" reports browser_print if the owner prints from there.
          receiptChannel: 'none',
          lines: cart.map((l) => ({ name: l.name, price: l.price })),
        });
      }
      // 2026-09-05: the SERVER's order is authoritative for money — it now
      // carries the persisted tax/cgst/sgst/total. Surface its total, and
      // flag the (rare) case where the client estimate the cashier collected
      // against differs from what was billed (menu edited mid-order, scheme
      // changed, server-side membership bundle) so they can reconcile the
      // drawer instead of trusting the pre-create number.
      const serverTotal = Number(o?.total);
      const estimated = existingSession ? previousSubtotalInr + payableTotal : payableTotal;
      // Round 3: say how much the wallet took — the founder's report was
      // "wallet not deducted" when the UI never told the cashier it was.
      const walletNote = mode === 'pay' && walletApplied > 0
        ? ` · ${formatINR(walletApplied, { decimals: true })} from wallet`
        : '';
      toast.success(mode === 'kot'
        ? `KOT #${o.orderNo} sent`
        : `Order #${o.orderNo} placed — ${formatINR(Number.isFinite(serverTotal) ? serverTotal : estimated)}${walletNote}`);
      if (mode === 'pay' && !existingSession && Number.isFinite(serverTotal)
          && Math.abs(serverTotal - payableTotal) > 0.01) {
        toast.warning(
          `Billed total is ${formatINR(serverTotal)} (estimate was ${formatINR(payableTotal)}) — collect the billed amount`,
        );
      }
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['ops-tables'] });
      // Wallet may have been debited (wallet split leg) and points redeemed.
      qc.invalidateQueries({ queryKey: ['cust-wallet'] });
      qc.invalidateQueries({ queryKey: ['cust-profile'] });
      if (existingSession) qc.invalidateQueries({ queryKey: ['session', existingSession.id] });
      onClose();
    },
    onError: (e: any) => toast.error(apiError(e) || e.message || 'Failed'),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-5xl w-[95vw] max-h-[92vh] overflow-hidden flex flex-col p-0">
        <DialogHeader className="px-6 py-4 border-b">
          <DialogTitle className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2"><ShoppingCart className="h-5 w-5 text-primary" /> Take new order</span>
            {plan.has('voice_pos') && <VoiceCommand onText={onVoice} />}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-hidden grid grid-cols-1 md:grid-cols-[1fr_360px]">
          {/* LEFT — menu picker */}
          <div className="overflow-y-auto p-6 space-y-4 border-r">
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => setSource('dineIn')}
                className={`p-3 rounded-lg border text-sm font-semibold transition-colors ${
                  source === 'dineIn' ? 'border-primary bg-primary/10 text-primary' : 'border-input hover:bg-accent'
                }`}>🍽️ Dine-in</button>
              <button onClick={() => setSource('takeaway')}
                className={`p-3 rounded-lg border text-sm font-semibold transition-colors ${
                  source === 'takeaway' ? 'border-primary bg-primary/10 text-primary' : 'border-input hover:bg-accent'
                }`}>🥡 Takeaway</button>
            </div>

            {source === 'dineIn' && !existingSession && (
              <div>
                <Label>Table</Label>
                <select value={tableId}
                  onChange={(e) => {
                    const t = tables.find((x: any) => x.id === e.target.value);
                    setTableId(e.target.value); setTableNo(t?.label || '');
                  }}
                  className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                  <option value="">— Pick a table —</option>
                  {tables.map((t: any) => (
                    <option key={t.id} value={t.id}>Table {t.label} ({t.seats} seats) — {t.status}</option>
                  ))}
                </select>
              </div>
            )}

            {existingSession && (
              <div className="rounded-lg border border-primary bg-primary/5 p-3 text-sm">
                <div className="font-semibold text-primary">
                  Adding to Table {existingSession.tableLabel || tableNo}'s bill
                </div>
                {previousSubtotalInr > 0 && (
                  <div className="text-xs text-muted-foreground mt-0.5">
                    So far: <strong>{formatINR(previousSubtotalInr)}</strong>
                  </div>
                )}
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>Customer phone <span className="text-muted-foreground text-xs">(loyalty + memberships)</span></Label>
                <Input value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)}
                  placeholder="9876543210" inputMode="numeric" className="mt-1" />
              </div>
              <div>
                <Label>Customer name</Label>
                <Input value={customerName}
                  onChange={(e) => {
                    setCustomerName(e.target.value);
                    // Manual typing locks out autofill for this dialog (Bug #3a)
                    setNameEditedByUser(true);
                  }}
                  placeholder="Walk-in" className="mt-1" />
              </div>
            </div>

            {/* Returning-customer hint (Bug #3a, 2026-08-25). visit count =
                customer.totalOrders from the customer-history endpoint —
                there is no separate visits column, orders are the proxy. */}
            {customerProfile?.customer && (
              <div className="text-xs text-muted-foreground flex items-center gap-1.5 -mt-2">
                <History className="h-3.5 w-3.5" />
                <span>
                  Returning customer · {customerProfile.customer.totalOrders ?? 0}
                  {' '}{(customerProfile.customer.totalOrders ?? 0) === 1 ? 'visit' : 'visits'}
                </span>
              </div>
            )}

            {/* Customer profile + active membership badge */}
            {customerProfile?.activeMembership && (
              <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 flex items-center gap-2">
                <Crown className="h-4 w-4" />
                <span>
                  <strong>{customerProfile.customer.name || customerPhone}</strong> is a member ·
                  {' '}{customerProfile.activeMembership.name} — discount auto-applied
                </span>
              </div>
            )}

            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input placeholder="Search menu…" className="pl-9"
                value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>

            {Object.entries(grouped).map(([cat, items]) => (
              <div key={cat}>
                <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">{cat}</div>
                <div className="grid grid-cols-2 gap-2">
                  {items.map((m: any) => {
                    // NP-205: nothing left of any size ⇒ not billable. The
                    // server refuses it anyway; refusing at the tile saves
                    // the cashier a rolled-back order in front of a queue.
                    const out = itemSoldOut(m);
                    return (
                      <button key={m.id} onClick={() => addItem(m)} disabled={out}
                        title={out ? 'Sold out — no stock left' : undefined}
                        className={`flex items-center justify-between p-3 rounded-lg border bg-card text-left transition-colors ${
                          out ? 'opacity-50 cursor-not-allowed' : 'hover:bg-accent'
                        }`}>
                        <div className="min-w-0">
                          <div className="font-medium truncate flex items-center gap-1">
                            {m.name}
                            {Array.isArray(m.variants) && m.variants.length > 0 && (
                              <span className="text-[9px] bg-blue-100 text-blue-700 px-1 rounded">VAR</span>
                            )}
                            {Array.isArray(m.modifierGroupIds) && m.modifierGroupIds.length > 0 && (
                              <span className="text-[9px] bg-purple-100 text-purple-700 px-1 rounded">MOD</span>
                            )}
                            {out && (
                              <span className="text-[9px] bg-red-100 text-red-700 px-1 rounded">SOLD OUT</span>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground">{formatINR(m.price)}</div>
                        </div>
                        <Plus className="h-4 w-4 text-primary shrink-0" />
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* RIGHT — cart */}
          <div className="flex flex-col bg-muted/30">
            <div className="px-5 py-3 border-b flex items-center justify-between">
              <div className="font-semibold">{existingSession ? 'Running bill' : 'Cart'}</div>
              <Badge variant="secondary">{cart.length} {cart.length === 1 ? 'line' : 'lines'}</Badge>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {existingSession && previousItems.length > 0 && (
                <div>
                  <div className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground mb-1.5">
                    Already sent ({previousItems.length})
                  </div>
                  <div className="bg-card/60 border rounded-lg divide-y">
                    {previousItems.map((p, i) => (
                      <div key={i} className="px-3 py-2 flex items-start justify-between gap-2 text-sm">
                        <div className="min-w-0 flex-1">
                          <div className="font-medium truncate">{p.name}</div>
                          <div className="text-xs text-muted-foreground">{p.qty} × {formatINR(p.price)}</div>
                        </div>
                        <div className="text-sm font-medium whitespace-nowrap text-muted-foreground">{formatINR(p.lineTotal)}</div>
                      </div>
                    ))}
                    <div className="px-3 py-1.5 flex justify-between text-xs bg-muted/50">
                      <span className="text-muted-foreground">Subtotal so far</span>
                      <strong>{formatINR(previousSubtotalInr)}</strong>
                    </div>
                  </div>
                </div>
              )}

              {cart.length === 0 && (
                <div className="text-center text-sm text-muted-foreground py-8">
                  Tap an item or use voice ("two paneer tikka").
                </div>
              )}
              {cart.map((l) => (
                <div key={l.lineKey} className="bg-card border rounded-lg p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-sm truncate">{l.name}</div>
                      {l.variantLabel && <div className="text-xs text-blue-700">· {l.variantLabel}</div>}
                      {Array.isArray(l.modifierLines) && l.modifierLines.length > 0 && (
                        <div className="text-xs text-purple-700">+ {l.modifierLines.map((m) => m.name).join(', ')}</div>
                      )}
                      <div className="text-xs text-muted-foreground">{formatINR(l.price)} each</div>
                    </div>
                    <div className="flex items-center gap-0.5">
                      {/* Bug #3b (2026-08-25): note toggle — amber when a
                          note is set so it stays discoverable when collapsed */}
                      <button onClick={() => toggleNote(l.lineKey)}
                        className="p-1 hover:bg-accent rounded" title="Kitchen note">
                        <StickyNote className={`h-3 w-3 ${l.note ? 'text-amber-600' : 'text-muted-foreground'}`} />
                      </button>
                      <button onClick={() => remove(l.lineKey)} className="p-1 hover:bg-accent rounded">
                        <Trash2 className="h-3 w-3 text-destructive" />
                      </button>
                    </div>
                  </div>
                  {noteOpen[l.lineKey] ? (
                    <Input value={l.note || ''} autoFocus maxLength={500}
                      onChange={(e) => setLineNote(l.lineKey, e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') toggleNote(l.lineKey); }}
                      placeholder="No onions, less spicy…"
                      className="mt-2 h-7 text-xs" />
                  ) : l.note ? (
                    // Collapsed preview — mirrors mobile's quoted-note row
                    <div className="mt-1 text-xs text-amber-700 italic truncate">"{l.note}"</div>
                  ) : null}
                  <div className="mt-2 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="outline" className="h-7 w-7 p-0" onClick={() => bump(l.lineKey, -1)}>
                        <Minus className="h-3 w-3" /></Button>
                      <span className="w-8 text-center font-semibold">{l.qty}</span>
                      <Button size="sm" variant="outline" className="h-7 w-7 p-0" onClick={() => bump(l.lineKey, 1)}>
                        <Plus className="h-3 w-3" /></Button>
                    </div>
                    <div className="font-semibold text-sm">{formatINR(l.price * l.qty)}</div>
                  </div>
                </div>
              ))}

              {/* Upsell strip */}
              {upsell.length > 0 && (
                <div className="border-t pt-3">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-1.5 flex items-center gap-1">
                    <Sparkles className="h-3 w-3" /> Often ordered together
                  </div>
                  <div className="space-y-1">
                    {upsell.slice(0, 3).map((s: any) => {
                      const m = menu.find((x: any) => x.id === s.suggested_item_id);
                      if (!m) return null;
                      return (
                        <button key={s.id} onClick={() => addItem(m)}
                          className="w-full flex justify-between items-center p-2 rounded-md border bg-card hover:bg-accent text-left text-xs">
                          <span>{s.suggested_name}</span>
                          <span className="text-muted-foreground">{formatINR(s.suggested_price)} ({Math.round(s.confidence)}%)</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            <div className="border-t bg-card p-4 space-y-3">
              {/* 2026-09-05 (review P0): the manual "Tax (₹)" input that
                  defaulted to 0 is gone — GST is computed from the menu's
                  slabs (rows below) and persisted by the server. */}
              <div className="grid grid-cols-2 gap-2">
                <div><Label className="text-xs">Discount (₹)</Label>
                  {/* 2026-08-25 (founder): capped at the subtotal so a fat-
                      fingered discount can't zero-out tax or go negative —
                      the value snaps down, typing stays free. */}
                  <Input type="number" min={0} max={subtotal} value={discount}
                    onChange={(e) => setDiscount(Math.min(Math.max(0, +e.target.value || 0), subtotal))}
                    className="h-8 mt-1" /></div>
                <div className="text-xs text-muted-foreground self-end pb-1.5">
                  {billsWithoutGst
                    ? 'Composition scheme — bill of supply, no GST'
                    : 'GST is added from each item’s slab'}
                </div>
              </div>
              {discount > 0 && (
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={discountIsPreTax} onChange={(e) => setDiscountIsPreTax(e.target.checked)} />
                  Discount before tax
                </label>
              )}

              {/* Points chip + redeem toggle (2026-08-25, founder): shown as
                  soon as a customer matches so the cashier can SAY the
                  balance out loud; the toggle only appears when the loyalty
                  settings actually allow a redemption right now. */}
              {customerProfile?.customer && (
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 font-semibold text-amber-800">
                    <Coins className="h-3 w-3" /> {pointsBalance} pts
                  </span>
                  {redemption && (
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input type="checkbox" checked={redeemPoints}
                        onChange={(e) => setRedeemPoints(e.target.checked)} />
                      Redeem {redemption.points} points (−{formatINR(redemption.valueInr)})
                    </label>
                  )}
                </div>
              )}

              {/* Membership card (2026-08-25 offer → round 3, 2026-09-06,
                  Bug 2): used-up/expired membership → "Renew ₹X" + other
                  plans; no membership → compact "Offer membership". Sale =
                  existing subscribe endpoint; then the profile refetches so
                  the new bundle/discount applies to THIS order. Gated on the
                  `memberships` key inside the card. */}
              {customerProfile?.customer && customerId && (
                <MembershipOfferCard
                  customerId={customerId}
                  customerLabel={customerProfile.customer.name || customerPhone}
                  activeMembership={customerProfile.activeMembership}
                  availableMemberships={customerProfile.availableMemberships}
                  rawPlans={membershipPlans as any[]}
                  walletBalanceInr={walletAvailable ? walletBalance : null}
                  onPurchased={refetchCustomer}
                />
              )}

              <div>
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Payment</Label>
                  {/* Split payments (2026-08-25, founder). Toggle keeps the
                      single-method grid untouched when off. */}
                  <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                    <input type="checkbox" checked={splitOn}
                      onChange={(e) => setSplitOn(e.target.checked)} />
                    Split payment
                  </label>
                </div>
                {!splitOn ? (
                  <>
                    <div className="grid grid-cols-4 gap-1 mt-1">
                      {(['cash', 'upi', 'card', 'unpaid'] as const).map((m) => (
                        <button key={m} onClick={() => setPaymentMethod(m)}
                          className={`h-8 rounded-md border text-xs font-semibold capitalize transition-colors ${
                            paymentMethod === m ? 'border-primary bg-primary/10 text-primary' : 'border-input hover:bg-accent'
                          }`}>{m}</button>
                      ))}
                    </div>
                    {/* Wallet tender (round 3, 2026-09-06, Bug 1/1b). The
                        toggle sends `autoWallet`; the cap sends `walletCapInr`;
                        the row below shows exactly what the wallet takes and
                        what is still collected. When the balance is short:
                        "Cover shortfall" (wallet + tender as explicit legs)
                        or "Top up wallet" (cash/UPI/card into the wallet
                        first). Hidden for 'unpaid' — no tender, no wallet. */}
                    {walletAvailable && paymentMethod !== 'unpaid' && (
                      <div className="mt-2 p-2 rounded-md bg-primary/5 space-y-1.5 text-xs" data-testid="wallet-tender">
                        {walletBalance > 0 ? (
                          <>
                            <label className="flex items-start gap-2 cursor-pointer">
                              <input type="checkbox" checked={autoWalletOn || coverShortfall} className="mt-0.5"
                                onChange={(e) => { setAutoWalletOn(e.target.checked); if (!e.target.checked) setCoverShortfall(false); }} />
                              <span>
                                Use wallet balance ({formatINR(walletBalance, { decimals: true })})
                                {walletTenderOn && walletApplied > 0 && (
                                  <> — <strong>{formatINR(walletApplied, { decimals: true })}</strong> from wallet
                                    {collectNow > 0
                                      ? <>, <strong>{formatINR(collectNow, { decimals: true })}</strong> via <span className="uppercase font-semibold">{paymentMethod}</span></>
                                      : <>, nothing more to collect</>}
                                  </>
                                )}
                              </span>
                            </label>
                            {(autoWalletOn || coverShortfall) && !coverShortfall && (
                              <div className="flex items-center gap-2 pl-5">
                                <Label className="text-[11px] text-muted-foreground whitespace-nowrap">Max from wallet (₹)</Label>
                                <Input type="number" min={0} step="0.01" value={walletCapInput}
                                  onChange={(e) => setWalletCapInput(e.target.value)}
                                  placeholder={payableTotal > 0 ? Math.min(walletBalance, payableTotal).toFixed(2) : '0.00'}
                                  className="h-7 w-24 text-xs" data-testid="wallet-cap" />
                              </div>
                            )}
                          </>
                        ) : (
                          <div className="text-muted-foreground">Wallet balance {formatINR(0, { decimals: true })}.</div>
                        )}
                        {walletShort.shortfall && payableTotal > 0 && (
                          <div className="pl-5 space-y-1" data-testid="wallet-shortfall">
                            <div className="text-amber-800">
                              Wallet is short by <strong>{formatINR(walletShort.shortByInr, { decimals: true })}</strong>.
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                              {walletBalance > 0 && (
                                <Button size="sm" variant={coverShortfall ? 'default' : 'outline'} className="h-7 text-xs"
                                  onClick={() => { setCoverShortfall((v) => !v); setAutoWalletOn(true); }}>
                                  {coverShortfall ? '✓ Covering shortfall' : 'Cover shortfall'} via {paymentMethod.toUpperCase()}
                                </Button>
                              )}
                              <Button size="sm" variant="outline" className="h-7 text-xs"
                                onClick={() => setTopUpOpen(true)}>
                                Top up wallet
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="mt-1 space-y-1.5">
                    {walletAvailable && walletBalance > 0 && (
                      <button type="button"
                        onClick={() => {
                          const apply = Math.min(walletBalance, payableTotal);
                          const rem = +(payableTotal - apply).toFixed(2);
                          const next: PayLeg[] = [{ method: 'wallet', amountInr: apply.toFixed(2) }];
                          if (rem > 0.001) next.push({ method: 'cash', amountInr: rem.toFixed(2) });
                          setLegs(next);
                        }}
                        className="text-xs text-primary font-semibold hover:underline">
                        Use wallet {formatINR(Math.min(walletBalance, payableTotal))}
                        {walletBalance < payableTotal ? ` + ${formatINR(payableTotal - walletBalance)} on another tender` : ''}
                      </button>
                    )}
                    {walletAvailable && walletShort.shortfall && payableTotal > 0 && (
                      <button type="button" onClick={() => setTopUpOpen(true)}
                        className="ml-3 text-xs text-primary font-semibold hover:underline">
                        Top up wallet
                      </button>
                    )}
                    {legs.map((leg, i) => (
                      <div key={i} className="flex items-center gap-1.5">
                        <select value={leg.method}
                          onChange={(e) => setLeg(i, { method: e.target.value as PayLeg['method'] })}
                          className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-xs capitalize">
                          {SPLIT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                          {/* Wallet appears ONLY for a matched customer; the
                              live balance rides on the option label. */}
                          {walletAvailable && (
                            <option value="wallet">wallet — {formatINR(walletBalance)}</option>
                          )}
                        </select>
                        <Input type="number" min={0} placeholder="0" value={leg.amountInr}
                          onChange={(e) => setLeg(i, { amountInr: e.target.value })}
                          className="h-8 w-24 text-xs" />
                        {legs.length > 2 && (
                          <button onClick={() => setLegs((ls) => ls.filter((_, j) => j !== i))}
                            className="p-1 hover:bg-accent rounded" title="Remove leg">
                            <Trash2 className="h-3 w-3 text-muted-foreground" />
                          </button>
                        )}
                      </div>
                    ))}
                    {/* Backend caps the breakdown at 3 legs */}
                    {legs.length < 3 && (
                      <button onClick={() => setLegs((ls) => [...ls, { method: 'cash', amountInr: '' }])}
                        className="text-xs text-primary font-semibold hover:underline">
                        + Add payment method
                      </button>
                    )}
                    <div className={`text-xs font-medium ${
                      Math.abs(splitRemaining) <= 0.01 ? 'text-emerald-700' : 'text-amber-700'
                    }`}>
                      {Math.abs(splitRemaining) <= 0.01
                        ? '✓ Fully covered'
                        : splitRemaining > 0
                          ? `${formatINR(splitRemaining)} remaining`
                          : `${formatINR(-splitRemaining)} over`}
                    </div>
                    {walletOver && (
                      <div className="text-xs text-destructive">
                        Wallet has only {formatINR(walletBalance)} — reduce the wallet amount.
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="border-t pt-2 text-sm space-y-1">
                <div className="flex justify-between"><span>Subtotal</span><span>{formatINR(subtotal)}</span></div>
                {discount > 0 && <div className="flex justify-between text-emerald-700"><span>Discount</span><span>− {formatINR(discount)}</span></div>}
                {/* GST estimate rows (2026-09-05). Intra-state CGST+SGST split
                    is the restaurant default (isInterState is never sent from
                    this dialog). "est." because the server's persisted figure
                    is authoritative — see onSuccess. Hidden entirely for a
                    composition dealer (gst = zeros). */}
                {tax > 0 && (
                  <>
                    <div className="flex justify-between text-muted-foreground">
                      <span>CGST <span className="text-[10px]">(est.)</span></span><span>+ {formatINR(gst.cgst)}</span>
                    </div>
                    <div className="flex justify-between text-muted-foreground">
                      <span>SGST <span className="text-[10px]">(est.)</span></span><span>+ {formatINR(gst.sgst)}</span>
                    </div>
                  </>
                )}
                {/* Points redemption line (2026-08-25) — mirrors the server-
                    side deduction so the printed total matches the charge. */}
                {redeemValue > 0 && (
                  <div className="flex justify-between text-emerald-700">
                    <span>Points ({redemption?.points} pts)</span><span>− {formatINR(redeemValue)}</span>
                  </div>
                )}
                {existingSession && previousSubtotalInr > 0 && (
                  <div className="flex justify-between text-muted-foreground text-xs pt-1">
                    <span>+ Already on bill</span><span>{formatINR(previousSubtotalInr)}</span>
                  </div>
                )}
                <div className="flex justify-between font-bold text-base pt-1 border-t mt-1">
                  <span>{existingSession ? 'New bill total' : 'Total'}</span>
                  <span>{formatINR(existingSession ? previousSubtotalInr + payableTotal : payableTotal)}</span>
                </div>
                {/* Wallet draw (round 3, 2026-09-06, Bug 1): the due the
                    cashier collects = total − points − wallet. Only on this
                    order's payable (an existing bill's earlier KOTs are
                    settled from the table dialog). */}
                {walletApplied > 0 && (
                  <>
                    <div className="flex justify-between text-emerald-700" data-testid="wallet-row">
                      <span>Wallet</span><span>− {formatINR(walletApplied, { decimals: true })}</span>
                    </div>
                    <div className="flex justify-between font-semibold" data-testid="collect-row">
                      <span>To collect via <span className="uppercase">{paymentMethod}</span></span>
                      <span>{formatINR(collectNow, { decimals: true })}</span>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="px-6 py-3 border-t flex-wrap gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          {source === 'dineIn' && (
            <Button variant="outline" onClick={() => create.mutate('kot')}
              disabled={create.isPending || cart.length === 0}>
              {create.isPending ? '…' : `${existingSession ? 'Send KOT' : 'Save KOT'} — ${formatINR(total)}`}
            </Button>
          )}
          {/* Split mode gates Place until the legs balance (2026-08-25) */}
          {/* Round 3: the button says what is COLLECTED now — the wallet part
              is shown separately so "₹84 due / ₹84 from wallet" never reads
              as "₹84 still to pay". */}
          <Button onClick={() => create.mutate('pay')}
            disabled={create.isPending || cart.length === 0 || (splitOn && !splitValid)}
            data-testid="pay-place">
            {create.isPending ? '…' : walletApplied > 0
              ? (collectNow > 0
                ? `Pay & place — ${formatINR(collectNow, { decimals: true })} ${paymentMethod.toUpperCase()} + ${formatINR(walletApplied, { decimals: true })} wallet`
                : `Pay & place — ${formatINR(walletApplied, { decimals: true })} from wallet`)
              // Only THIS order is charged by Pay & place (earlier KOTs on
              // the running bill are settled from the table dialog), so the
              // label must not add previousSubtotalInr — that read as
              // "pay the whole table again" (round 3).
              : `Pay & place — ${formatINR(payableTotal)}`}
          </Button>
        </DialogFooter>
      </DialogContent>

      {/* Wallet top-up (round 3, Bug 1b) — cash/UPI/card into the wallet,
          then the wallet pays the bill. Balance refetches via ['cust-wallet']. */}
      {topUpOpen && customerId && (
        <WalletTopUpDialog
          customerId={customerId}
          customerLabel={customerProfile?.customer?.name || customerPhone}
          currentBalanceInr={walletBalance}
          suggestedInr={walletShort.shortByInr}
          onClose={() => setTopUpOpen(false)}
          onDone={() => { setTopUpOpen(false); setAutoWalletOn(true); }}
        />
      )}

      {/* Variant + modifier picker — opens when needed */}
      {configuring && (
        <ItemConfigDialog
          item={configuring}
          modGroups={modGroups}
          onClose={() => setConfiguring(null)}
          onConfirm={(line) => { _addLine(line); setConfiguring(null); }}
        />
      )}
    </Dialog>
  );
}

// ── Variant + modifier picker ───────────────────────────────────────────
function ItemConfigDialog({
  item, modGroups, onClose, onConfirm,
}: { item: any; modGroups: any[]; onClose: () => void;
     onConfirm: (line: Omit<CartLine, 'lineKey'>) => void }) {
  // Variant: list from item.variants if present, otherwise treat the base
  // item as the only "variant"
  const variants = Array.isArray(item.variants) && item.variants.length > 0
    ? item.variants
    : [{ id: null, label: '', price: parseFloat(item.price) }];
  // NP-205 — a TRACKED size with nothing left is sold out (migration 084):
  // the server will 400 the order, so the picker must not offer it. Untracked
  // sizes are unlimited and always sellable, whatever number sits in `stock`
  // (which is exactly the distinction `trackStock` was added to make).
  const firstAvailable = variants.find((v: any) => !variantSoldOut(v)) || variants[0];
  const [variantId, setVariantId] = useState<string | null>(firstAvailable.id);

  // Attached modifier groups
  const attachedIds: string[] = item.modifierGroupIds || [];
  const groups = modGroups.filter((g: any) => attachedIds.includes(g.id));
  // selected[groupId] = Set<modifierId>
  const [selected, setSelected] = useState<Record<string, Set<string>>>(() => {
    const s: Record<string, Set<string>> = {};
    for (const g of groups) s[g.id] = new Set();
    return s;
  });

  const variant = variants.find((v: any) => v.id === variantId) || firstAvailable;
  let unitPrice = parseFloat(variant.price);
  const chosenMods: ModLine[] = [];
  for (const g of groups) {
    for (const mod of g.modifiers || []) {
      if (selected[g.id]?.has(mod.id)) {
        unitPrice += Number(mod.priceDeltaInr);
        chosenMods.push({ modifierId: mod.id, name: mod.name, priceDeltaInr: Number(mod.priceDeltaInr), qty: 1 });
      }
    }
  }

  const valid = groups.every((g: any) => {
    const n = selected[g.id]?.size || 0;
    return n >= g.minSelect && n <= g.maxSelect;
  });

  const toggle = (groupId: string, modId: string, kind: string) => {
    setSelected((prev) => {
      const next = { ...prev };
      const set = new Set(next[groupId]);
      if (kind === 'single_select') { set.clear(); set.add(modId); }
      else if (set.has(modId)) set.delete(modId); else set.add(modId);
      next[groupId] = set;
      return next;
    });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Customize {item.name}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          {variants.length > 1 && (
            <div>
              <div className="text-xs font-bold uppercase mb-2">Variant</div>
              <div className="flex flex-wrap gap-1">
                {variants.map((v: any) => {
                  const out = variantSoldOut(v);
                  return (
                    <button key={v.id || 'base'} onClick={() => setVariantId(v.id)}
                      disabled={out}
                      title={out ? 'Sold out — no stock left of this size' : undefined}
                      className={`px-3 py-1.5 rounded-md border text-sm ${
                        out ? 'border-input opacity-50 line-through cursor-not-allowed'
                          : variantId === v.id ? 'border-primary bg-primary/10 text-primary' : 'border-input'
                      }`}>
                      {v.label || 'Standard'} · {formatINR(v.price)}
                      {out && <span className="ml-1 text-[10px] font-bold text-destructive">SOLD OUT</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {groups.map((g: any) => (
            <div key={g.id}>
              <div className="text-xs font-bold uppercase mb-2 flex items-center gap-2">
                {g.name}
                {g.minSelect > 0 && <Badge variant="warning" className="text-[9px]">Required</Badge>}
                <span className="text-muted-foreground font-normal">
                  ({g.minSelect}–{g.maxSelect})
                </span>
              </div>
              <div className="space-y-1">
                {g.modifiers.map((mod: any) => (
                  <label key={mod.id} className="flex items-center justify-between p-2 rounded-md border cursor-pointer hover:bg-accent">
                    <span className="flex items-center gap-2 text-sm">
                      <input type={g.kind === 'single_select' ? 'radio' : 'checkbox'}
                        name={g.id}
                        checked={selected[g.id]?.has(mod.id) || false}
                        onChange={() => toggle(g.id, mod.id, g.kind)} />
                      {mod.name}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {mod.priceDeltaInr > 0 ? `+${formatINR(mod.priceDeltaInr)}` :
                       mod.priceDeltaInr < 0 ? `−${formatINR(Math.abs(mod.priceDeltaInr))}` : 'free'}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={!valid}
            onClick={() => onConfirm({
              menuItemId: item.id,
              name: item.name,
              price: +unitPrice.toFixed(2),
              qty: 1,
              // 2026-09-05: variants/modifiers inherit the PARENT item's slab
              // (server: `gstPct: parseFloat(mi.gst_pct)` on every line).
              gstPct: item.gstPct == null ? null : Number(item.gstPct),
              variantId: variant.id || null,
              variantLabel: variant.label || null,
              // Bug fix (2026-08-20): the caller types this field as
              // `ModLine[] | undefined`, so returning `null` when the
              // customer picked no modifiers tripped strict TS.
              modifierLines: chosenMods.length > 0 ? chosenMods : undefined,
            })}>
            Add — {formatINR(unitPrice)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
