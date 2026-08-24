import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Globe, ExternalLink, Save } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ffApi } from '@/api/namastepos';
import { api, apiError } from '@/api/client';

// Hardcode-audit fix (2026-08-24): brand-site domain is env-driven
// (VITE_SITE_DOMAIN) so the pending product/domain rename doesn't require
// a code change here.
const siteDomain = (import.meta.env.VITE_SITE_DOMAIN as string | undefined) || 'namastepos.in';

export function OnlineSitePage() {
  const qc = useQueryClient();
  const { data: site } = useQuery({ queryKey: ['site'], queryFn: ffApi.getSite });
  const [f, setF] = useState<any>(null);

  useEffect(() => {
    if (site && !f) {
      setF({
        brandSlug: site.brand_slug || '',
        heroImageUrl: site.hero_image_url || '',
        primaryColor: site.primary_color || '#FF6B35',
        brandStory: site.brand_story || '',
        contactEmail: site.contact_email || '',
        contactPhone: site.contact_phone || '',
        address: site.address || '',
        deliveryRadiusKm: site.delivery_radius_km || 5,
        minOrderInr: (site.min_order_paise || 0) / 100,
        deliveryFeeInr: (site.delivery_fee_paise || 0) / 100,
        isPublished: site.is_published === true,
      });
    }
  }, [site, f]);

  const save = useMutation({
    mutationFn: () => ffApi.updateSite(f),
    onSuccess: () => { toast.success('Site saved'); qc.invalidateQueries({ queryKey: ['site'] }); },
    onError: (e) => toast.error(apiError(e)),
  });

  if (!f) return <div className="p-10 text-center text-muted-foreground">Loading…</div>;
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Globe className="h-6 w-6 text-primary" /> Online ordering site
          </h1>
          <p className="text-muted-foreground text-sm">
            Your own brand page. Skip Zomato &amp; Swiggy commissions on direct orders.
          </p>
        </div>
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          <Save className="mr-2 h-4 w-4" /> Save
        </Button>
      </div>

      {f.brandSlug && f.isPublished && (
        <Card className="border-emerald-300 bg-emerald-50">
          <CardContent className="p-4 text-sm">
            {/* Hardcode-audit fix (2026-08-24): domain + API base were
                hardcoded here (missed in the 2026-08-23 ReservationWidgetPage
                sweep). Both are env-driven now. */}
            🎉 Live at <code>{f.brandSlug}.{siteDomain}</code>{' '}
            <a href={`${api.defaults.baseURL}/site/${f.brandSlug}`} target="_blank" rel="noreferrer" className="underline text-emerald-800">
              preview <ExternalLink className="inline h-3 w-3" />
            </a>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Brand</CardTitle>
          <CardDescription>What customers see at your URL.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div><Label>Brand slug</Label>
            <Input value={f.brandSlug} onChange={(e) => set('brandSlug', e.target.value.toLowerCase())} placeholder="mycafe" />
            <div className="text-xs text-muted-foreground mt-1">Becomes <code>{f.brandSlug || 'yourname'}.{siteDomain}</code></div>
          </div>
          <div><Label>Primary color</Label><Input type="color" value={f.primaryColor} onChange={(e) => set('primaryColor', e.target.value)} /></div>
          <div className="md:col-span-2"><Label>Hero image URL</Label><Input value={f.heroImageUrl} onChange={(e) => set('heroImageUrl', e.target.value)} /></div>
          <div className="md:col-span-2"><Label>Brand story</Label>
            <textarea value={f.brandStory} onChange={(e) => set('brandStory', e.target.value)}
              rows={3} className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Contact &amp; delivery</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div><Label>Contact email</Label><Input value={f.contactEmail} onChange={(e) => set('contactEmail', e.target.value)} /></div>
          <div><Label>Contact phone</Label><Input value={f.contactPhone} onChange={(e) => set('contactPhone', e.target.value)} /></div>
          <div className="md:col-span-2"><Label>Address</Label><Input value={f.address} onChange={(e) => set('address', e.target.value)} /></div>
          <div><Label>Delivery radius (km)</Label><Input type="number" value={f.deliveryRadiusKm} onChange={(e) => set('deliveryRadiusKm', +e.target.value)} /></div>
          <div><Label>Min order (₹)</Label><Input type="number" value={f.minOrderInr} onChange={(e) => set('minOrderInr', +e.target.value)} /></div>
          <div><Label>Delivery fee (₹)</Label><Input type="number" value={f.deliveryFeeInr} onChange={(e) => set('deliveryFeeInr', +e.target.value)} /></div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 flex items-center justify-between">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={f.isPublished} onChange={(e) => set('isPublished', e.target.checked)} />
            <span className="font-semibold">Publish site live</span>
          </label>
        </CardContent>
      </Card>
    </div>
  );
}
