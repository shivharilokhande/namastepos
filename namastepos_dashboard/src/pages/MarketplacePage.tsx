import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Package, Check, Sparkles, X, Play } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ffApi } from '@/api/namastepos';
import { api, apiError, getBusinessCache } from '@/api/client';
import { formatINR, formatDate } from '@/lib/utils';

declare global { interface Window { Razorpay: any; } }

function loadRzp(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.Razorpay) return resolve();
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load Razorpay'));
    document.body.appendChild(s);
  });
}

export function MarketplacePage() {
  const qc = useQueryClient();
  const { data: catalog = [] } = useQuery({ queryKey: ['catalog-addons'], queryFn: ffApi.catalogAddons });
  const { data: mine } = useQuery({ queryKey: ['my-addons'], queryFn: ffApi.myAddons });

  const active = mine?.active || [];
  const activeSlugs = new Set(active.map((a: any) => a.addon.slug));

  const subscribe = useMutation({
    // 2026-08-25 (founder bug: addons subscribed without charging) — paid
    // addons no longer activate on POST /subscribe. The backend returns
    // { requiresPayment, razorpayOrder, keyId }; we open Razorpay Checkout
    // for that order and the addon only activates after the backend
    // verifies the payment signature in /confirm-payment. Dismissing the
    // checkout activates nothing.
    mutationFn: async (slug: string) => {
      const r = await ffApi.subscribeAddon(slug);
      if (r.activated) return { slug };

      if (!r.requiresPayment || !r.razorpayOrder?.id) {
        // Backend contract changed under us — fail loudly rather than
        // pretending the addon is on.
        throw new Error('Unexpected subscribe response — add-on not activated');
      }

      await loadRzp();
      const b = getBusinessCache();
      await new Promise<void>((resolve, reject) => {
        const rz = new window.Razorpay({
          key: r.keyId,
          order_id: r.razorpayOrder.id,
          amount: r.razorpayOrder.amount,
          currency: r.razorpayOrder.currency,
          name: 'NamastePOS',
          description: r.addon?.name ? `${r.addon.name} add-on` : 'Marketplace add-on',
          theme: { color: '#FF6B35' },
          handler: async (resp: any) => {
            // Confirm server-side: the backend re-verifies the HMAC
            // signature before activating, so a spoofed handler call
            // can't turn the addon on. Unlike the old webhook flow this
            // is synchronous — no 30s activation polling needed.
            try {
              await api.post(`/businesses/${b.id}/addons/${slug}/confirm-payment`, {
                razorpayPaymentId: resp.razorpay_payment_id,
                razorpayOrderId: resp.razorpay_order_id,
                razorpaySignature: resp.razorpay_signature,
              });
              resolve();
            } catch (err) {
              reject(err);
            }
          },
          modal: { ondismiss: () => reject(new Error('PAYMENT_CANCELLED')) },
        });
        rz.open();
      });
      return { slug };
    },
    onSuccess: () => {
      toast.success('Add-on activated');
      qc.invalidateQueries({ queryKey: ['my-addons'] });
      qc.invalidateQueries({ queryKey: ['me'] }); // D-19 (2026-09-05): plan lives under ['me'] now
    },
    onError: (e: any) => {
      if (e?.message === 'PAYMENT_CANCELLED') {
        toast.warning('Payment cancelled — add-on was not activated');
        return;
      }
      toast.error(apiError(e));
    },
  });

  const cancel = useMutation({
    mutationFn: ffApi.cancelAddon,
    // 2026-08-24: cancel now takes effect immediately (backend sets status
    // 'cancelled' + busts the feature cache), so refresh BOTH the addon list
    // and the plan/features query — otherwise the sidebar kept the feature
    // unlocked and the row kept its "active" badge until the next poll.
    onSuccess: () => {
      toast.success('Add-on cancelled');
      qc.invalidateQueries({ queryKey: ['my-addons'] });
      qc.invalidateQueries({ queryKey: ['me'] }); // D-19 (2026-09-05): plan lives under ['me'] now
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const resume = useMutation({
    mutationFn: ffApi.resumeAddon,
    onSuccess: () => {
      toast.success('Resumed');
      qc.invalidateQueries({ queryKey: ['my-addons'] });
      qc.invalidateQueries({ queryKey: ['me'] }); // D-19 (2026-09-05): plan lives under ['me'] now
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const grouped: Record<string, any[]> = {};
  for (const a of catalog) (grouped[a.category] ||= []).push(a);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Sparkles className="h-6 w-6 text-primary" /> Marketplace
        </h1>
        <p className="text-muted-foreground">
          Unlock more from NamastePOS. Add-ons bill separately and you can cancel any time.
        </p>
      </div>

      {/* Active subscriptions */}
      {active.length > 0 && (
        <Card className="border-primary">
          <CardHeader>
            <CardTitle>Your active add-ons ({active.length})</CardTitle>
            <CardDescription>Billed on top of your plan, separately for each.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {active.map((a: any) => (
              <div key={a.id} className="flex items-center justify-between border-b last:border-0 py-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <Package className="h-4 w-4 text-primary" />
                    <span className="font-medium">{a.addon.name}</span>
                    <Badge variant={a.status === 'active' ? 'success' : a.status === 'trialing' ? 'secondary' : 'warning'}>
                      {a.status}
                    </Badge>
                    {a.cancelAtPeriodEnd && <Badge variant="destructive">Will cancel</Badge>}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {a.addon.priceInr > 0 ? `${formatINR(a.addon.priceInr)}/mo` : 'Free'}
                    {' · '} renews {formatDate(a.currentPeriodEnd)}
                  </div>
                </div>
                {a.cancelAtPeriodEnd ? (
                  <Button size="sm" variant="outline" onClick={() => resume.mutate(a.addon.slug)}>
                    <Play className="mr-2 h-3 w-3" /> Resume
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => cancel.mutate(a.addon.slug)}>
                    <X className="mr-2 h-3 w-3" /> Cancel
                  </Button>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Browse catalog */}
      {Object.entries(grouped).map(([cat, items]) => (
        <div key={cat}>
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 px-1">
            {cat}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {items.map((a: any) => (
              <AddonCard
                key={a.id}
                addon={a}
                isActive={activeSlugs.has(a.slug)}
                onSubscribe={() => subscribe.mutate(a.slug)}
                loading={subscribe.isPending}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function AddonCard({ addon, isActive, onSubscribe, loading }:
  { addon: any; isActive: boolean; onSubscribe: () => void; loading: boolean }) {
  return (
    <Card className={isActive ? 'border-emerald-400 ring-1 ring-emerald-400/40' : ''}>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div className="grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary">
            <Package className="h-5 w-5" />
          </div>
          {isActive && <Badge variant="success">Active</Badge>}
        </div>
        <CardTitle className="mt-3">{addon.name}</CardTitle>
        <CardDescription>{addon.tagline}</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground line-clamp-3 mb-3">{addon.description}</p>
        {addon.features?.permissions && (
          <ul className="space-y-1 text-xs">
            {addon.features.permissions.slice(0, 4).map((p: string) => (
              <li key={p} className="flex items-center gap-2">
                <Check className="h-3 w-3 text-emerald-600" />
                <span className="capitalize">{p.replace(/_/g, ' ')}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <CardFooter className="flex items-center justify-between">
        <div>
          <div className="text-xl font-bold">
            {addon.priceInr === 0 ? 'Free' : formatINR(addon.priceInr)}
            {addon.priceInr > 0 && <span className="text-xs font-normal text-muted-foreground">/{addon.billingPeriod === 'yearly' ? 'yr' : 'mo'}</span>}
          </div>
          {addon.requiredPlanTier && (
            <div className="text-xs text-muted-foreground capitalize">Needs {addon.requiredPlanTier}+ plan</div>
          )}
        </div>
        <Button onClick={onSubscribe} disabled={isActive || loading} variant={isActive ? 'outline' : 'default'}>
          {isActive ? 'Subscribed' : addon.priceInr === 0 ? 'Enable' : 'Subscribe'}
        </Button>
      </CardFooter>
    </Card>
  );
}
