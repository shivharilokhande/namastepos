import { useQuery } from '@tanstack/react-query';
import {
  TrendingUp, Receipt, Wallet, PieChart as PieIcon,
  Banknote, CreditCard, Smartphone, Wallet as WalletIcon,
  Bike, Truck, ShoppingBag, Store, QrCode,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ffApi } from '@/api/namastepos';
import { formatINR } from '@/lib/utils';

const today = new Date().toISOString().slice(0, 10);

// FF-242 — colours per order status. Same palette the Orders queue uses.
const STATUS_META: Record<string, { label: string; color: string }> = {
  pending:   { label: 'Pending',   color: 'bg-amber-500' },
  ready:     { label: 'Ready',     color: 'bg-blue-500' },
  collected: { label: 'Collected', color: 'bg-emerald-500' },
  cancelled: { label: 'Cancelled', color: 'bg-red-400' },
};

// FF-243 — channel tile metadata.
const CHANNEL_META: Record<string, { label: string; icon: any; color: string }> = {
  dineIn:   { label: 'Dine-in',    icon: Store,       color: 'text-amber-700 bg-amber-50' },
  takeaway: { label: 'Takeaway',   icon: ShoppingBag, color: 'text-emerald-700 bg-emerald-50' },
  delivery: { label: 'Delivery',   icon: Bike,        color: 'text-sky-700 bg-sky-50' },
  zomato:   { label: 'Zomato',     icon: Truck,       color: 'text-red-700 bg-red-50' },
  swiggy:   { label: 'Swiggy',     icon: Truck,       color: 'text-orange-700 bg-orange-50' },
  dunzo:    { label: 'Dunzo',      icon: Truck,       color: 'text-lime-700 bg-lime-50' },
  magicpin: { label: 'Magicpin',   icon: Truck,       color: 'text-purple-700 bg-purple-50' },
  qr:       { label: 'QR order',   icon: QrCode,      color: 'text-slate-700 bg-slate-50' },
};

const PAYMENT_META: Record<string, { label: string; icon: any; color: string }> = {
  cash:   { label: 'Cash',   icon: Banknote,    color: 'text-emerald-700 bg-emerald-50' },
  upi:    { label: 'UPI',    icon: Smartphone,  color: 'text-indigo-700 bg-indigo-50' },
  card:   { label: 'Card',   icon: CreditCard,  color: 'text-blue-700 bg-blue-50' },
  wallet: { label: 'Wallet', icon: WalletIcon,  color: 'text-purple-700 bg-purple-50' },
};

export function DashboardPage() {
  const { data: report } = useQuery({
    queryKey: ['daily-report', today],
    queryFn: () => ffApi.dailyReport(today),
  });
  const revenue  = report?.revenue?.total ?? 0;
  const expenses = report?.expenses?.total ?? 0;
  const profit   = report?.profit ?? 0;
  const margin   = report?.margin ?? 0;

  const payment  = report?.paymentBreakdown as Record<string, { count: number; amount: number }> | undefined;
  const statuses = report?.statusCounts    as Record<string, number> | undefined;
  const channels = report?.channelCounts   as Record<string, number> | undefined;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Today</h1>
        <p className="text-muted-foreground">Live performance for {new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' })}</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard icon={<TrendingUp className="h-5 w-5" />}   color="bg-emerald-100 text-emerald-700" label="Revenue"  value={formatINR(revenue)} />
        <KpiCard icon={<Receipt className="h-5 w-5" />}      color="bg-amber-100 text-amber-700"     label="Expenses" value={formatINR(expenses)} />
        <KpiCard icon={<Wallet className="h-5 w-5" />}       color={profit >= 0 ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"} label="Profit" value={formatINR(profit)} />
        <KpiCard icon={<PieIcon className="h-5 w-5" />}      color="bg-blue-100 text-blue-700"       label="Margin"   value={`${margin.toFixed(0)}%`} />
      </div>

      {/* FF-243 — channel tiles */}
      <ChannelTiles channels={channels} />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader><CardTitle>Revenue by source</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {Object.entries(report?.revenue || {})
              .filter(([k]) => k !== 'total')
              .map(([k, v]) => (
                <div key={k} className="flex justify-between py-1.5 border-b last:border-0 capitalize">
                  <span>{k}</span>
                  <strong>{formatINR(Number(v) || 0)}</strong>
                </div>
              ))}
            {Object.keys(report?.revenue || {}).filter((k) => k !== 'total').length === 0 && (
              <div className="py-6 text-center text-muted-foreground">No orders yet today.</div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Top items today</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {(report?.topItems || []).map((it: any, i: number) => (
              <div key={it.itemId || i} className="flex justify-between py-1.5 border-b last:border-0">
                <span><strong>{it.qty}</strong> × {it.name}</span>
                <span className="text-muted-foreground">{formatINR(it.revenue)}</span>
              </div>
            ))}
            {(report?.topItems || []).length === 0 && (
              <div className="py-6 text-center text-muted-foreground">No orders yet today.</div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* FF-241 payment breakdown + FF-242 order status donut */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <PaymentCard payment={payment} />
        <StatusCard statuses={statuses} />
      </div>
    </div>
  );
}

// ── FF-241 — Payment method breakdown ─────────────────────────────────
function PaymentCard({ payment }: { payment?: Record<string, { count: number; amount: number }> }) {
  const rows = Object.entries(payment || {})
    .sort(([, a], [, b]) => (b?.amount || 0) - (a?.amount || 0));
  const total = rows.reduce((s, [, v]) => s + (v?.amount || 0), 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Payment breakdown</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {rows.length === 0 && (
          <div className="py-6 text-center text-muted-foreground">
            No collected orders yet today.
          </div>
        )}
        {rows.map(([method, v]) => {
          const meta = PAYMENT_META[method] || {
            label: method, icon: Wallet, color: 'text-slate-700 bg-slate-50',
          };
          const pct = total > 0 ? (v.amount / total) * 100 : 0;
          const Icon = meta.icon;
          return (
            <div key={method} className="space-y-1">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={`inline-flex items-center justify-center w-6 h-6 rounded ${meta.color}`}>
                    <Icon className="w-3.5 h-3.5" />
                  </span>
                  <span className="font-medium">{meta.label}</span>
                  <span className="text-xs text-muted-foreground">
                    · {v.count} order{v.count === 1 ? '' : 's'}
                  </span>
                </div>
                <strong>{formatINR(v.amount)}</strong>
              </div>
              <div className="h-1.5 bg-muted rounded overflow-hidden">
                <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

// ── FF-242 — Order-status donut (CSS-only, no chart lib) ──────────────
function StatusCard({ statuses }: { statuses?: Record<string, number> }) {
  const entries = Object.entries(STATUS_META).map(([key, meta]) => ({
    key,
    label: meta.label,
    color: meta.color,
    count: statuses?.[key] || 0,
  }));
  const total = entries.reduce((s, e) => s + e.count, 0);

  // Build a conic-gradient string in order pending → ready → collected → cancelled.
  const stops: string[] = [];
  let acc = 0;
  const tailwindToCss: Record<string, string> = {
    'bg-amber-500': '#f59e0b',
    'bg-blue-500': '#3b82f6',
    'bg-emerald-500': '#10b981',
    'bg-red-400': '#f87171',
  };
  for (const e of entries) {
    if (e.count === 0) continue;
    const pct = (e.count / (total || 1)) * 100;
    const from = acc;
    const to = acc + pct;
    stops.push(`${tailwindToCss[e.color]} ${from}% ${to}%`);
    acc = to;
  }
  const donut = total > 0
    ? `conic-gradient(${stops.join(', ')})`
    : 'conic-gradient(#e5e7eb 0% 100%)';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Order status · today</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-4">
          <div className="relative w-32 h-32 rounded-full" style={{ background: donut }}>
            <div className="absolute inset-4 bg-background rounded-full grid place-items-center">
              <div className="text-center">
                <div className="text-2xl font-bold leading-none">{total}</div>
                <div className="text-[10px] uppercase text-muted-foreground">orders</div>
              </div>
            </div>
          </div>
          <div className="flex-1 space-y-1 text-sm">
            {entries.map((e) => (
              <div key={e.key} className="flex items-center justify-between py-0.5">
                <div className="flex items-center gap-2">
                  <span className={`inline-block w-2.5 h-2.5 rounded-sm ${e.color}`} />
                  <span>{e.label}</span>
                </div>
                <strong>{e.count}</strong>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── FF-243 — Channel tiles ─────────────────────────────────────────────
function ChannelTiles({ channels }: { channels?: Record<string, number> }) {
  // Only render tiles that actually have orders today OR are common
  // walk-in / dine-in defaults (so the row isn't empty for a fresh cafe).
  const shown = Object.entries(channels || {}).filter(([, n]) => n > 0);
  if (shown.length === 0) return null;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      {shown.map(([key, n]) => {
        const meta = CHANNEL_META[key] || {
          label: key, icon: ShoppingBag, color: 'text-slate-700 bg-slate-50',
        };
        const Icon = meta.icon;
        return (
          <Card key={key}>
            <CardContent className="p-3 flex items-center gap-2">
              <span className={`inline-flex items-center justify-center w-8 h-8 rounded ${meta.color}`}>
                <Icon className="w-4 h-4" />
              </span>
              <div className="min-w-0">
                <div className="text-lg font-bold leading-none">{n}</div>
                <div className="text-[10px] uppercase text-muted-foreground truncate">
                  {meta.label}
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function KpiCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color: string }) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className={`grid h-10 w-10 place-items-center rounded-lg ${color}`}>{icon}</div>
        <div className="mt-4 text-2xl font-bold tracking-tight">{value}</div>
        <div className="text-sm text-muted-foreground">{label}</div>
      </CardContent>
    </Card>
  );
}
