// Public-facing order tracker (F16)
// Customer gets a /track/:token link. No auth.
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CheckCircle2, Clock, ChefHat, ShoppingBag } from 'lucide-react';
import { formatINR } from '@/lib/utils';
import { api } from '@/api/client';

const STAGES = [
  { key: 'pending',   label: 'Order placed', icon: Clock },
  { key: 'preparing', label: 'Preparing',    icon: ChefHat },
  { key: 'ready',     label: 'Ready',        icon: ShoppingBag },
  { key: 'collected', label: 'Done',         icon: CheckCircle2 },
];

export function PublicOrderTrackerPage() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    const fetchIt = async () => {
      try {
        // Hardcode-audit fix (2026-08-24): use the resolved API base
        // (VITE_API_URL) instead of a hardcoded relative /v1, which broke
        // whenever the API lives on another origin.
        const r = await fetch(`${api.defaults.baseURL}/site/order-status/${token}`);
        if (!r.ok) throw new Error('Not found');
        const j = await r.json();
        if (alive) setData(j.order);
      } catch (e: any) {
        if (alive) setErr(e.message);
      }
    };
    fetchIt();
    const t = setInterval(fetchIt, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [token]);

  if (err) return <div className="min-h-screen grid place-items-center text-muted-foreground">Order not found</div>;
  if (!data) return <div className="min-h-screen grid place-items-center text-muted-foreground">Loading…</div>;

  const currentIdx = STAGES.findIndex((s) => s.key === data.status);

  return (
    <div className="min-h-screen bg-muted/30 grid place-items-center px-4 py-8">
      <div className="bg-card rounded-lg shadow-xl p-6 max-w-md w-full">
        <div className="text-center mb-6">
          <div className="text-4xl font-extrabold">#{data.order_no}</div>
          <div className="text-muted-foreground">{data.source} · {formatINR(parseFloat(data.total))}</div>
        </div>

        <div className="space-y-3">
          {STAGES.map((s, idx) => {
            const Icon = s.icon;
            const done = idx <= currentIdx && data.status !== 'cancelled';
            const active = idx === currentIdx && data.status !== 'cancelled';
            return (
              <div key={s.key} className={`flex items-center gap-3 p-3 rounded-lg border ${
                active ? 'border-primary bg-primary/5'
                  : done ? 'border-emerald-300 bg-emerald-50'
                  : 'border-input bg-muted/30 opacity-50'
              }`}>
                <Icon className={`h-5 w-5 ${active ? 'text-primary' : done ? 'text-emerald-700' : 'text-muted-foreground'}`} />
                <div className="font-medium">{s.label}</div>
                {done && <CheckCircle2 className="ml-auto h-4 w-4 text-emerald-600" />}
              </div>
            );
          })}
        </div>

        {data.status === 'cancelled' && (
          <div className="mt-4 p-3 bg-red-50 border border-red-300 rounded text-red-800 text-center">
            Order was cancelled.
          </div>
        )}
      </div>
    </div>
  );
}
