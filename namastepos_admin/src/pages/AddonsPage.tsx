import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, RefreshCw, Edit2, Package } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { adminApi, Addon } from '@/api/admin';
import { apiError } from '@/api/client';
import { formatINR } from '@/lib/utils';

const CATEGORIES = ['integrations', 'marketing', 'operations', 'reports'] as const;

export function AddonsPage() {
  const qc = useQueryClient();
  const { data: addons = [] } = useQuery({ queryKey: ['addons-admin'], queryFn: adminApi.listAddons });
  const [editing, setEditing] = useState<Addon | null>(null);
  const [creating, setCreating] = useState(false);

  const sync = useMutation({
    mutationFn: adminApi.syncAddonsRzp,
    onSuccess: (r) => {
      toast.success(`Synced ${r.synced?.filter((s: any) => s.ok).length || 0} addons to Razorpay`);
      qc.invalidateQueries({ queryKey: ['addons-admin'] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const grouped: Record<string, Addon[]> = {};
  for (const a of addons) (grouped[a.category] ||= []).push(a);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Add-ons</h1>
          <p className="text-muted-foreground">
            {addons.length} addons in the marketplace · sold separately on top of plans
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => sync.mutate()} disabled={sync.isPending} variant="outline">
            <RefreshCw className={`mr-2 h-4 w-4 ${sync.isPending ? 'animate-spin' : ''}`} />
            Sync to Razorpay
          </Button>
          <Button onClick={() => setCreating(true)}><Plus className="mr-2 h-4 w-4" /> New addon</Button>
        </div>
      </div>

      {Object.entries(grouped).map(([cat, items]) => (
        <div key={cat}>
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 px-1">
            {cat}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {items.map((a) => <AddonCard key={a.id} addon={a} onEdit={() => setEditing(a)} />)}
          </div>
        </div>
      ))}

      {editing && (
        <AddonDialog mode="edit" addon={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { qc.invalidateQueries({ queryKey: ['addons-admin'] }); setEditing(null); }} />
      )}
      {creating && (
        <AddonDialog mode="create"
          onClose={() => setCreating(false)}
          onSaved={() => { qc.invalidateQueries({ queryKey: ['addons-admin'] }); setCreating(false); }} />
      )}
    </div>
  );
}

function AddonCard({ addon, onEdit }: { addon: Addon; onEdit: () => void }) {
  return (
    <Card className={addon.isActive ? '' : 'opacity-60'}>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary">
              <Package className="h-5 w-5" />
            </div>
            <div>
              <CardTitle>{addon.name}</CardTitle>
              <CardDescription className="text-xs">{addon.tagline}</CardDescription>
            </div>
          </div>
          <Button size="sm" variant="ghost" onClick={onEdit}><Edit2 className="h-4 w-4" /></Button>
        </div>
        <div className="mt-3">
          <div className="text-xl font-bold">{formatINR(addon.priceInr)}<span className="text-sm font-normal text-muted-foreground">/{addon.billingPeriod === 'yearly' ? 'yr' : addon.billingPeriod === 'one_time' ? 'once' : 'mo'}</span></div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex gap-2 flex-wrap">
          {!addon.isActive && <Badge variant="destructive">Inactive</Badge>}
          {addon.requiredPlanTier && (
            <Badge variant="muted" className="capitalize">Needs {addon.requiredPlanTier}+</Badge>
          )}
          {addon.trialDays > 0 && (
            <Badge variant="secondary">{addon.trialDays}d trial</Badge>
          )}
          {addon.razorpayPlanId ? (
            <Badge variant="success">RZP synced</Badge>
          ) : (
            <Badge variant="warning">Not synced</Badge>
          )}
        </div>
        {addon.features.permissions && (
          <div className="text-xs text-muted-foreground border-t pt-2">
            Unlocks: <span className="font-medium">{addon.features.permissions.join(', ')}</span>
          </div>
        )}
        <code className="block text-[10px] text-muted-foreground">slug: {addon.slug}</code>
      </CardContent>
    </Card>
  );
}

function AddonDialog({ mode, addon, onClose, onSaved }:
  { mode: 'create' | 'edit'; addon?: Addon; onClose: () => void; onSaved: () => void }) {
  // Push 18a — plan tiers are no longer the legacy free/basic/pro triple.
  // Fetch the live catalog so super-admin can require any active paid plan.
  const { data: plans = [] } = useQuery({
    queryKey: ['plans-admin'],
    queryFn: adminApi.listPlans,
    staleTime: 60_000,
  });
  const [f, setF] = useState<any>(addon ? {
    slug: addon.slug, name: addon.name, tagline: addon.tagline || '',
    description: addon.description || '', icon: addon.icon, category: addon.category,
    price_inr_paise: addon.priceInrPaise, billing_period: addon.billingPeriod,
    required_plan_tier: addon.requiredPlanTier || '', trial_days: addon.trialDays,
    features: addon.features, is_active: addon.isActive, display_order: addon.displayOrder,
    partner_name: (addon as any).partnerName || '', revenue_share_pct: (addon as any).revenueSharePct || 0,
  } : {
    slug: '', name: '', tagline: '', description: '', icon: 'box',
    category: 'integrations', price_inr_paise: 9900, billing_period: 'monthly',
    required_plan_tier: '', trial_days: 0, features: { permissions: [] },
    is_active: true, display_order: 100, partner_name: '', revenue_share_pct: 0,
  });
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        ...f,
        required_plan_tier: f.required_plan_tier || null,
      };
      return mode === 'create'
        ? adminApi.createAddon(payload)
        : adminApi.updateAddon(f.slug, payload);
    },
    onSuccess: () => { toast.success(mode === 'create' ? 'Addon created' : 'Addon updated'); onSaved(); },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <Dialog open={true} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader><DialogTitle>{mode === 'create' ? 'New addon' : `Edit ${f.name}`}</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2 grid grid-cols-2 gap-4">
            <div>
              <Label>Slug *</Label>
              <Input value={f.slug} disabled={mode === 'edit'}
                     onChange={(e) => set('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} />
            </div>
            <div><Label>Name *</Label><Input value={f.name} onChange={(e) => set('name', e.target.value)} /></div>
          </div>
          <div className="col-span-2"><Label>Tagline (card subtitle)</Label><Input value={f.tagline} onChange={(e) => set('tagline', e.target.value)} /></div>
          <div className="col-span-2"><Label>Description</Label>
            <textarea className="w-full h-20 rounded-md border border-input bg-background px-3 py-2 text-sm"
                      value={f.description} onChange={(e) => set('description', e.target.value)} /></div>
          <div><Label>Icon (lucide name)</Label><Input value={f.icon} onChange={(e) => set('icon', e.target.value)} placeholder="shopping-bag" /></div>
          <div>
            <Label>Category</Label>
            <select value={f.category} onChange={(e) => set('category', e.target.value)}
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div><Label>Price (paise — e.g. 14900 = ₹149)</Label><Input type="number" value={f.price_inr_paise} onChange={(e) => set('price_inr_paise', +e.target.value)} /></div>
          <div>
            <Label>Billing period</Label>
            <select value={f.billing_period} onChange={(e) => set('billing_period', e.target.value)}
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
              <option value="one_time">One-time</option>
            </select>
          </div>
          <div>
            <Label>Requires plan</Label>
            <select value={f.required_plan_tier} onChange={(e) => set('required_plan_tier', e.target.value)}
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              <option value="">Any plan</option>
              {plans
                .filter((p: any) => (p.priceInr || 0) > 0)
                .map((p: any) => (
                  <option key={p.tier} value={p.tier}>{p.name} ({p.tier})</option>
                ))}
            </select>
          </div>
          <div><Label>Trial days</Label><Input type="number" value={f.trial_days} onChange={(e) => set('trial_days', +e.target.value)} /></div>
          {/* L5 — marketplace revenue share (partner attribution + payout %) */}
          <div><Label>Partner name (optional)</Label><Input value={f.partner_name} onChange={(e) => set('partner_name', e.target.value)} placeholder="3rd-party add-on partner" /></div>
          <div><Label>Revenue share % (partner payout)</Label><Input type="number" min="0" max="100" step="0.5" value={f.revenue_share_pct} onChange={(e) => set('revenue_share_pct', +e.target.value)} /></div>
          <div className="col-span-2">
            <Label>Unlocked permissions (comma-separated)</Label>
            <Input value={(f.features.permissions || []).join(', ')}
                   onChange={(e) => set('features', { ...f.features, permissions: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
                   placeholder="aggregator_integrations, push_notifications" />
          </div>
          <div className="col-span-2 flex items-center gap-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={f.is_active} onChange={(e) => set('is_active', e.target.checked)} />
              <span className="text-sm">Active (visible to customers)</span>
            </label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={!f.slug || !f.name || save.isPending}>
            {save.isPending ? 'Saving…' : (mode === 'create' ? 'Create addon' : 'Save changes')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
