import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Tag, Copy, Ban } from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { adminApi, Coupon } from '@/api/admin';
import { apiError } from '@/api/client';
import { formatDate, formatINR } from '@/lib/utils';

export function CouponsPage() {
  const qc = useQueryClient();
  const { data: coupons = [], isError, error, refetch } = useQuery({ queryKey: ['coupons'], queryFn: () => adminApi.listCoupons() });
  const [creating, setCreating] = useState(false);

  const disable = useMutation({
    mutationFn: (id: string) => adminApi.disableCoupon(id),
    onSuccess: () => { toast.success('Coupon disabled'); qc.invalidateQueries({ queryKey: ['coupons'] }); },
    onError: (e) => toast.error(apiError(e)),
  });

  const renderValue = (c: Coupon) =>
    c.type === 'percent' ? `${c.value}% off` :
    c.type === 'flat' ? `${formatINR(c.value)} off` :
    `${c.value} day extension`;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Coupons & promotions</h1>
          {/* Finding-3 (2026-08-25): this list is platform subscription coupons
              only. Per-restaurant food coupons are managed in each tenant's
              own dashboard and no longer appear here. */}
          <p className="text-muted-foreground">
            {isError ? '—' : `${coupons.length} platform subscription coupons`}
          </p>
        </div>
        <Button onClick={() => setCreating(true)}><Plus className="mr-2 h-4 w-4" /> New coupon</Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Code</TableHead><TableHead>Description</TableHead>
              <TableHead>Type</TableHead><TableHead>Applies to</TableHead>
              <TableHead>Used</TableHead><TableHead>Expires</TableHead>
              <TableHead>Status</TableHead><TableHead></TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {isError && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-10">
                    <div className="text-sm text-destructive">Couldn't load coupons — {apiError(error)}</div>
                    <Button variant="outline" size="sm" className="mt-2" onClick={() => refetch()}>Retry</Button>
                  </TableCell>
                </TableRow>
              )}
              {!isError && coupons.length === 0 && (
                <TableRow><TableCell colSpan={8} className="text-center py-10 text-muted-foreground">No coupons yet — create your first promo.</TableCell></TableRow>
              )}
              {coupons.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Tag className="h-4 w-4 text-muted-foreground" />
                      <code className="font-mono font-bold">{c.code}</code>
                      <Button size="sm" variant="ghost" onClick={() => { navigator.clipboard.writeText(c.code); toast.success('Copied'); }}>
                        <Copy className="h-3 w-3" />
                      </Button>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">{c.description || '—'}</TableCell>
                  <TableCell><Badge variant="muted">{renderValue(c)}</Badge></TableCell>
                  <TableCell className="capitalize text-sm">{c.appliesToPlan || 'Any plan'}</TableCell>
                  <TableCell>{c.redemptionCount}{c.maxRedemptions ? ` / ${c.maxRedemptions}` : ''}</TableCell>
                  <TableCell className="text-sm">{c.expiresAt ? formatDate(c.expiresAt) : 'Never'}</TableCell>
                  <TableCell>
                    <Badge variant={c.status === 'active' ? 'success' : 'muted'}>{c.status}</Badge>
                  </TableCell>
                  <TableCell>
                    {c.status === 'active' && (
                      <Button size="sm" variant="ghost" onClick={() => disable.mutate(c.id)}>
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

      {creating && <CreateCouponDialog onClose={() => setCreating(false)}
        onCreated={() => { qc.invalidateQueries({ queryKey: ['coupons'] }); setCreating(false); }} />}
    </div>
  );
}

function CreateCouponDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  // Push 18a — plan tiers are now arbitrary (starter/pro/enterprise + custom).
  // Source the dropdown from the live catalog instead of hardcoding.
  const { data: plans = [] } = useQuery({
    queryKey: ['plans-admin'],
    queryFn: adminApi.listPlans,
    staleTime: 60_000,
  });
  const [form, setForm] = useState({
    code: '', description: '', type: 'percent', value: 20,
    appliesToPlan: '', maxRedemptions: '', expiresAt: '',
  });
  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));

  const create = useMutation({
    mutationFn: () => adminApi.createCoupon({
      code: form.code, description: form.description || undefined,
      type: form.type, value: +form.value,
      appliesToPlan: form.appliesToPlan || null,
      maxRedemptions: form.maxRedemptions ? +form.maxRedemptions : null,
      expiresAt: form.expiresAt || null,
    }),
    onSuccess: () => { toast.success('Coupon created'); onCreated(); },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <Dialog open={true} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader><DialogTitle>Create coupon</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-4">
          <div><Label>Code *</Label><Input value={form.code} placeholder="LAUNCH50"
                onChange={(e) => set('code', e.target.value.toUpperCase())} /></div>
          <div>
            <Label>Type *</Label>
            <select value={form.type} onChange={(e) => set('type', e.target.value)}
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="percent">Percent (%)</option>
              <option value="flat">Flat amount (₹)</option>
              <option value="trial_extension">Trial extension (days)</option>
            </select>
          </div>
          <div><Label>Value *</Label><Input type="number" value={form.value} onChange={(e) => set('value', e.target.value)} /></div>
          <div>
            <Label>Applies to plan</Label>
            <select value={form.appliesToPlan} onChange={(e) => set('appliesToPlan', e.target.value)}
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="">Any paid plan</option>
              {plans
                .filter((p: any) => (p.priceInr || 0) > 0)
                .map((p: any) => (
                  <option key={p.tier} value={p.tier}>{p.name} only</option>
                ))}
            </select>
          </div>
          <div><Label>Max redemptions</Label><Input type="number" placeholder="unlimited" value={form.maxRedemptions} onChange={(e) => set('maxRedemptions', e.target.value)} /></div>
          <div><Label>Expires at</Label><Input type="date" value={form.expiresAt} onChange={(e) => set('expiresAt', e.target.value)} /></div>
          <div className="col-span-2"><Label>Description</Label><Input value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="Launch month promotion" /></div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => create.mutate()} disabled={!form.code || !form.value || create.isPending}>
            {create.isPending ? 'Creating…' : 'Create coupon'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
