// Settings → White label (2026-09-06, round 2, CONTRACTS §4).
//
// `GET/PUT /businesses/:id/white-label` → { enabled, brandName,
// hidePoweredBy, accentColor } (businesses.white_label JSONB, migration 098).
// Owner-only + requireFeature('white_label') server-side; mirrored here with
// the owner check and <RequireFeature> so a locked plan sees the upgrade card.
//
// Effect (server-side): the guest QR page, the public site and receipt /
// invoice PDF footers hide "Powered by NamastePOS" and use `brandName` when
// `enabled` AND the plan still carries the key — the key is re-checked at
// render time, so a downgrade turns it off without the owner doing anything.
// `custom_branding` (receipt template logo/footer) is a different capability
// and is NOT touched by this card.
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Palette } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ffApi, type WhiteLabel } from '@/api/namastepos';
import { apiError } from '@/api/client';
import { usePlan } from '@/hooks/usePlan';
import { RequireFeature } from '@/components/RequireFeature';

export const WHITE_LABEL_QUERY_KEY = ['white-label'] as const;
const EMPTY: WhiteLabel = { enabled: false, brandName: '', hidePoweredBy: false, accentColor: null };
const HEX = /^#[0-9a-fA-F]{6}$/;

export function WhiteLabelCard() {
  const plan = usePlan();
  if (plan.loaded && plan.role !== 'business_owner') return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Palette className="h-4 w-4" /> White label</CardTitle>
        <CardDescription>
          Put your own brand on the guest QR page, your online site and invoice footers — and hide “Powered by NamastePOS”.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <RequireFeature feature="white_label" compact title="White label is not in your plan">
          <WhiteLabelBody />
        </RequireFeature>
      </CardContent>
    </Card>
  );
}

function WhiteLabelBody() {
  const qc = useQueryClient();
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: WHITE_LABEL_QUERY_KEY,
    queryFn: ffApi.getWhiteLabel,
    retry: false,
  });
  const [f, setF] = useState<WhiteLabel>(EMPTY);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (data && !dirty) setF({ ...EMPTY, ...data });
  }, [data, dirty]);
  const set = <K extends keyof WhiteLabel>(k: K, v: WhiteLabel[K]) => { setDirty(true); setF((p) => ({ ...p, [k]: v })); };

  const save = useMutation({
    mutationFn: () => ffApi.updateWhiteLabel({
      enabled: f.enabled,
      brandName: f.brandName.trim(),
      hidePoweredBy: f.hidePoweredBy,
      accentColor: f.accentColor && HEX.test(f.accentColor) ? f.accentColor : null,
    }),
    onSuccess: (wl) => {
      toast.success(wl.enabled ? 'White label saved — live on your guest pages' : 'White label saved (disabled)');
      setDirty(false);
      qc.setQueryData(WHITE_LABEL_QUERY_KEY, wl);
      // The guest page / site read the business block; refresh it.
      qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const colourInvalid = !!f.accentColor && !HEX.test(f.accentColor);
  const nameMissing = f.enabled && !f.brandName.trim();

  return (
    <fieldset disabled={isLoading || isError} className="space-y-4">
      {isError && (
        <div className="text-sm flex items-center justify-between gap-3">
          <span className="text-destructive">{apiError(error)}</span>
          <Button size="sm" variant="outline" type="button" onClick={() => refetch()}>Retry</Button>
        </div>
      )}
      <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
        <input type="checkbox" className="h-4 w-4 accent-primary" checked={f.enabled}
          onChange={(e) => set('enabled', e.target.checked)} />
        Enable white label
      </label>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <Label>Brand name</Label>
          <Input value={f.brandName} onChange={(e) => set('brandName', e.target.value)} maxLength={80}
            placeholder="Shown instead of NamastePOS" />
          {nameMissing && <p className="text-xs text-destructive mt-1">Enter a brand name to enable white label.</p>}
        </div>
        <div>
          <Label>Accent colour <span className="text-muted-foreground">(optional)</span></Label>
          <div className="mt-1 flex items-center gap-2">
            <input
              type="color"
              aria-label="Pick accent colour"
              className="h-10 w-12 rounded border border-input bg-background p-1"
              value={f.accentColor && HEX.test(f.accentColor) ? f.accentColor : '#ff6b35'}
              onChange={(e) => set('accentColor', e.target.value)}
            />
            <Input value={f.accentColor || ''} onChange={(e) => set('accentColor', e.target.value || null)}
              placeholder="#FF6B35" maxLength={7} className="font-mono" />
          </div>
          {colourInvalid && <p className="text-xs text-destructive mt-1">Use a 6-digit hex colour like #1E88E5.</p>}
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
        <input type="checkbox" className="h-4 w-4 accent-primary" checked={f.hidePoweredBy}
          onChange={(e) => set('hidePoweredBy', e.target.checked)} />
        Hide “Powered by NamastePOS” on guest pages, site and invoice footers
      </label>
      <p className="text-xs text-muted-foreground">
        Applies only while your plan includes White label; if the plan changes, NamastePOS branding returns automatically.
      </p>
      <div className="flex justify-end">
        <Button type="button" onClick={() => save.mutate()}
          disabled={save.isPending || !dirty || colourInvalid || nameMissing}>
          {save.isPending ? 'Saving…' : 'Save white label'}
        </Button>
      </div>
    </fieldset>
  );
}
