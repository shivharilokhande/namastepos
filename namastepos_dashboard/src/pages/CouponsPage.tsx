// Food-order coupons (FF-1701)
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Ticket } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ffApi } from '@/api/namastepos';
import { formatINR } from '@/lib/utils';

export function CouponsPage() {
  const { data: coupons = [] } = useQuery({ queryKey: ['food-coupons'], queryFn: ffApi.listFoodCoupons });
  const [test, setTest] = useState({ code: '', subtotal: 100 });
  const [result, setResult] = useState<any>(null);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Ticket className="h-6 w-6 text-primary" /> Food coupons
        </h1>
        <p className="text-muted-foreground text-sm">Promo codes customers can apply to restaurant bills.</p>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Try a coupon</CardTitle></CardHeader>
        <CardContent className="flex gap-2 items-end">
          <div><label className="text-sm">Code</label>
            <Input value={test.code} onChange={(e) => setTest({ ...test, code: e.target.value })} /></div>
          <div><label className="text-sm">Subtotal (₹)</label>
            <Input type="number" value={test.subtotal} onChange={(e) => setTest({ ...test, subtotal: +e.target.value })} /></div>
          <Button onClick={async () => {
            try {
              const r = await ffApi.applyFoodCoupon(test);
              setResult(r);
            } catch (e: any) { setResult({ error: e.message }); }
          }}>Try</Button>
          {result && (
            <div className="text-sm">
              {result.error ? <span className="text-red-700">{result.error}</span>
                : <span className="text-emerald-700">Discount: {formatINR(result.discountInr)}</span>}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Active coupons</CardTitle></CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground border-b">
              <tr><th className="p-3">Code</th><th>Type</th><th>Value</th><th>Used</th><th>Expires</th></tr>
            </thead>
            <tbody>
              {coupons.length === 0 && <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">No food coupons yet.</td></tr>}
              {coupons.map((c: any) => (
                <tr key={c.id} className="border-b">
                  <td className="p-3 font-mono font-bold">{c.code}</td>
                  <td><Badge variant="muted">{c.type}</Badge></td>
                  <td>{c.type === 'percent' ? `${c.value}%` : formatINR(c.value)}</td>
                  <td>{c.redemption_count} / {c.max_redemptions || '∞'}</td>
                  <td className="text-xs">{c.expires_at ? new Date(c.expires_at).toLocaleDateString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
