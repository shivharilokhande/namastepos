// Food-order coupons (FF-1701)
// 2026-08-25 (founder #13): was a read-only list — owners had no way to
// create "10% off upto ₹50" style coupons themselves. Now full management:
// create (with percent cap), deactivate, and the original "try a code" tool.
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Ticket, Plus, Ban } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { DateInput } from '@/components/ui/date-input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { ffApi } from '@/api/namastepos';
import { api, getBusinessCache, apiError } from '@/api/client';
import { formatINR } from '@/lib/utils';

// pg NUMERIC columns arrive as strings — model them that way so we never
// forget to coerce before math/formatting.
interface Coupon {
  id: string;
  code: string;
  type: 'percent' | 'flat' | 'trial_extension';
  value: string;
  max_discount_inr: string | null;
  expires_at: string | null;
  max_redemptions: number | null;
  redemption_count: number;
  status: 'active' | 'inactive' | string;
  // NULL = platform-wide coupon (created by super admin) — visible here but
  // not deactivatable by the owner (backend enforces ownership too).
  business_id: string | null;
}

interface CreateForm {
  code: string;
  type: 'percent' | 'flat';
  value: string;
  maxDiscountInr: string;
  expiresAt: string;      // ISO yyyy-mm-dd from DateInput
  maxRedemptions: string;
}

const EMPTY_FORM: CreateForm = { code: '', type: 'percent', value: '', maxDiscountInr: '', expiresAt: '', maxRedemptions: '' };

// "10% up to ₹50" — the founder's exact ask; flat coupons are just ₹.
function couponValue(c: Coupon): string {
  if (c.type === 'percent') {
    const cap = c.max_discount_inr ? ` up to ${formatINR(+c.max_discount_inr)}` : '';
    return `${+c.value}%${cap}`;
  }
  return formatINR(+c.value);
}

export function CouponsPage() {
  const qc = useQueryClient();
  const businessId: string = getBusinessCache()?.id;

  // Not ffApi.listFoodCoupons: we need includeInactive so deactivated
  // coupons stay visible (they're soft-deleted to keep redemption history).
  const { data: coupons = [] } = useQuery<Coupon[]>({
    queryKey: ['food-coupons', 'all'],
    queryFn: () => api
      .get(`/businesses/${businessId}/food-coupons`, { params: { includeInactive: 'true' } })
      .then((r) => r.data.coupons),
  });

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<CreateForm>(EMPTY_FORM);
  const [test, setTest] = useState({ code: '', subtotal: 100 });
  const [result, setResult] = useState<{ discountInr?: number; error?: string } | null>(null);

  const create = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        code: form.code.trim().toUpperCase(),
        type: form.type,
        value: +form.value,
      };
      // Backend Joi forbids maxDiscountInr on flat coupons (a flat coupon
      // IS its own cap) — only attach it for percent.
      if (form.type === 'percent' && form.maxDiscountInr) body.maxDiscountInr = +form.maxDiscountInr;
      if (form.expiresAt) body.expiresAt = form.expiresAt;
      if (form.maxRedemptions) body.maxRedemptions = +form.maxRedemptions;
      return api.post(`/businesses/${businessId}/food-coupons`, body);
    },
    onSuccess: () => {
      toast.success('Coupon created');
      qc.invalidateQueries({ queryKey: ['food-coupons'] });
      setCreating(false);
      setForm(EMPTY_FORM);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const deactivate = useMutation({
    mutationFn: (id: string) => api.delete(`/businesses/${businessId}/food-coupons/${id}`),
    onSuccess: () => {
      toast.success('Coupon deactivated');
      qc.invalidateQueries({ queryKey: ['food-coupons'] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const canSave = form.code.trim().length >= 3 && +form.value > 0
    && (form.type !== 'percent' || +form.value <= 100);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Ticket className="h-6 w-6 text-primary" /> Food coupons
          </h1>
          <p className="text-muted-foreground text-sm">Promo codes customers can apply to restaurant bills.</p>
        </div>
        <Button onClick={() => setCreating(true)}><Plus className="mr-2 h-4 w-4" /> New coupon</Button>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Try a coupon</CardTitle></CardHeader>
        <CardContent className="flex gap-2 items-end flex-wrap">
          <div><Label className="text-sm">Code</Label>
            <Input value={test.code} onChange={(e) => setTest({ ...test, code: e.target.value })} /></div>
          <div><Label className="text-sm">Subtotal (₹)</Label>
            <Input type="number" value={test.subtotal} onChange={(e) => setTest({ ...test, subtotal: +e.target.value })} /></div>
          <Button onClick={async () => {
            try {
              const r = await ffApi.applyFoodCoupon(test);
              setResult(r);
            } catch (e) { setResult({ error: apiError(e) }); }
          }}>Try</Button>
          {result && (
            <div className="text-sm">
              {result.error ? <span className="text-red-700">{result.error}</span>
                : <span className="text-emerald-700">Discount: {formatINR(result.discountInr ?? 0)}</span>}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Coupons</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Used</TableHead>
                <TableHead>Status</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {coupons.length === 0 && (
                <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">No food coupons yet. Create one to offer discounts.</TableCell></TableRow>
              )}
              {coupons.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-mono font-bold">{c.code}</TableCell>
                  <TableCell><Badge variant="muted">{c.type}</Badge></TableCell>
                  <TableCell>{couponValue(c)}</TableCell>
                  <TableCell className="text-xs">{c.expires_at ? new Date(c.expires_at).toLocaleDateString('en-IN') : '—'}</TableCell>
                  <TableCell>{c.redemption_count} / {c.max_redemptions ?? '∞'}</TableCell>
                  <TableCell>
                    <Badge variant={c.status === 'active' ? 'success' : 'muted'}>{c.status}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {/* Platform-wide coupons (business_id null) aren't ours to
                        kill — the backend would 404 the delete anyway. */}
                    {c.business_id !== null && c.status === 'active' && (
                      <Button
                        variant="ghost" size="sm"
                        disabled={deactivate.isPending}
                        onClick={() => {
                          if (window.confirm(`Deactivate coupon ${c.code}? Customers will no longer be able to use it.`)) {
                            deactivate.mutate(c.id);
                          }
                        }}
                      >
                        <Ban className="h-4 w-4 text-destructive" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={creating} onOpenChange={(o) => { setCreating(o); if (!o) setForm(EMPTY_FORM); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New coupon</DialogTitle>
            <DialogDescription>e.g. 10% off up to ₹50 — set type Percent, value 10, max discount 50.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Code</Label>
              {/* Backend wants 3-30 alphanumeric; uppercase live so the owner
                  sees exactly what customers will type. */}
              <Input value={form.code} placeholder="DIWALI10"
                     onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 30) })} />
            </div>
            <div>
              <Label>Type</Label>
              <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                      value={form.type}
                      onChange={(e) => setForm({ ...form, type: e.target.value as CreateForm['type'], maxDiscountInr: '' })}>
                <option value="percent">Percent (%)</option>
                <option value="flat">Flat (₹)</option>
              </select>
            </div>
            <div>
              <Label>{form.type === 'percent' ? 'Value (%)' : 'Value (₹)'}</Label>
              <Input type="number" min="1" max={form.type === 'percent' ? 100 : undefined}
                     value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
            </div>
            {/* Cap only makes sense for percent — flat is already a fixed ₹. */}
            {form.type === 'percent' && (
              <div>
                <Label>Max discount ₹ (optional)</Label>
                <Input type="number" min="1" placeholder="50"
                       value={form.maxDiscountInr} onChange={(e) => setForm({ ...form, maxDiscountInr: e.target.value })} />
              </div>
            )}
            <div>
              <Label>Expiry date (optional)</Label>
              <DateInput value={form.expiresAt} onChange={(iso) => setForm({ ...form, expiresAt: iso })} />
            </div>
            <div>
              <Label>Max redemptions (optional)</Label>
              <Input type="number" min="1" placeholder="Unlimited"
                     value={form.maxRedemptions} onChange={(e) => setForm({ ...form, maxRedemptions: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
            <Button onClick={() => create.mutate()} disabled={!canSave || create.isPending}>
              {create.isPending ? 'Creating…' : 'Create coupon'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
