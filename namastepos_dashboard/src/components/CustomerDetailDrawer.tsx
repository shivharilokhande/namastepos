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
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import axios from 'axios';
import {
  X, Receipt, Heart, CreditCard, Award, Star, Wallet,
  ChevronDown, ChevronUp, Loader2,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
// WHY `api` directly (2026-08-25): ffApi has no customer-history or
// single-order binding and the api files are out of scope for this fix,
// so we call the endpoints with the shared axios instance + cached
// business id, exactly like ffApi's own helpers do internally.
import { api, apiError, getBusinessCache } from '@/api/client';
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

  // Surface real failures (network / 5xx) but keep the drawer open with
  // the list-row fallback data so the page isn't a dead end.
  useEffect(() => {
    if (error) toast.error(apiError(error));
  }, [error]);

  // Close on Escape — a hand-rolled panel doesn't get this for free the
  // way the shadcn Dialog does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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
              {(prof?.walletInr ?? 0) > 0 && (
                <div className="flex items-center gap-2 rounded-md bg-primary/5 px-3 py-2 text-sm">
                  <Wallet className="h-4 w-4 text-primary" />
                  Wallet balance: <strong>{formatINR(prof!.walletInr, { decimals: true })}</strong>
                </div>
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
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No active membership.</p>
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
    </div>
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
