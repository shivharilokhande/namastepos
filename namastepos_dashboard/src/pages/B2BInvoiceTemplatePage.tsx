// B2B invoice template (R20)
//
// History. D-04 (2026-09-05): this page used to READ and WRITE the thermal
// RECEIPT template (`/bill-template`): letterhead → logoUrl, terms →
// footerText, and signature / bank details / HSN / e-way were never sent
// anywhere. An Enterprise owner who pressed Save silently overwrote their
// receipt logo and footer; everyone else got a 402 (`PUT /bill-template` is
// requireFeature('custom_branding')). It was made read-only on 2026-09-05.
//
// 2026-09-06 (round 2, CONTRACTS §1): the B2B template now has its OWN store
// — `GET/PUT /businesses/:id/b2b-invoice-template` (b2b_invoice_templates,
// migration 095), gated server-side on `b2b_invoice` (Pro+) for BOTH view and
// save, owner or `bill_template` staff perm for PUT. Founder decision: NOT
// `custom_branding`. This page never touches `/bill-template` again — the
// receipt template lives at /bill-template. Route + nav are gated on
// `b2b_invoice` via lib/navConfig.ts (RequireFeature renders the upgrade
// card), so by the time this renders the plan has the key.
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { FileText, Info } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ffApi, type B2BInvoiceTemplate } from '@/api/namastepos';
import { apiError } from '@/api/client';

const EMPTY: B2BInvoiceTemplate = {
  letterhead: '', terms: '', signatureUrl: '', bankDetails: '', showHsn: true, showEway: false,
};

// Mirrors the server Joi (strings ≤ 4000, url ≤ 500) so the owner gets an
// instant message instead of a 400 round-trip. Server stays authoritative.
const TEXT_MAX = 4000;
const URL_MAX = 500;

export const B2B_TEMPLATE_QUERY_KEY = ['b2b-invoice-template'] as const;

export function B2BInvoiceTemplatePage() {
  const qc = useQueryClient();
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: B2B_TEMPLATE_QUERY_KEY,
    queryFn: ffApi.getB2BInvoiceTemplate,
    retry: false,
  });

  const [f, setF] = useState<B2BInvoiceTemplate>(EMPTY);
  const [dirty, setDirty] = useState(false);
  // Seed the form from the server once (and again after a save, when the
  // query refetches) — but never clobber unsaved edits.
  useEffect(() => {
    if (data && !dirty) setF({ ...EMPTY, ...data });
  }, [data, dirty]);

  const set = <K extends keyof B2BInvoiceTemplate>(k: K, v: B2BInvoiceTemplate[K]) => {
    setDirty(true);
    setF((p) => ({ ...p, [k]: v }));
  };

  const save = useMutation({
    mutationFn: () => ffApi.updateB2BInvoiceTemplate({
      letterhead: f.letterhead,
      terms: f.terms,
      signatureUrl: f.signatureUrl,
      bankDetails: f.bankDetails,
      showHsn: f.showHsn,
      showEway: f.showEway,
    }),
    onSuccess: (t) => {
      toast.success('B2B invoice template saved');
      setDirty(false);
      qc.setQueryData(B2B_TEMPLATE_QUERY_KEY, t);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const tooLong = (s: string, max: number) => (s || '').length > max;
  const invalid = tooLong(f.letterhead, TEXT_MAX) || tooLong(f.terms, TEXT_MAX)
    || tooLong(f.bankDetails, TEXT_MAX) || tooLong(f.signatureUrl, URL_MAX);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <FileText className="h-6 w-6 text-primary" /> B2B invoice template
          </h1>
          <p className="text-muted-foreground text-sm">
            Letterhead, bank details and terms printed on wholesale / B2B tax invoices.
            Separate from your thermal <Link to="/bill-template" className="underline">receipt template</Link>.
          </p>
        </div>
        <Button onClick={() => save.mutate()} disabled={save.isPending || isLoading || isError || invalid || !dirty}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>

      {isError && (
        <Card className="border-destructive/40">
          <CardContent className="p-4 text-sm flex items-center justify-between gap-3">
            <span className="text-destructive">{apiError(error)}</span>
            <Button size="sm" variant="outline" onClick={() => refetch()}>Retry</Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Letterhead &amp; signature</CardTitle>
          <CardDescription>Shown at the top and bottom of every B2B invoice PDF.</CardDescription>
        </CardHeader>
        <CardContent>
          <fieldset disabled={isLoading || isError} className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="md:col-span-2">
              <Label>Letterhead text</Label>
              <textarea value={f.letterhead} onChange={(e) => set('letterhead', e.target.value)}
                rows={3} maxLength={TEXT_MAX}
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                placeholder={'My Company Pvt Ltd\n12, MG Road, Bengaluru 560001\nGSTIN 29ABCDE1234F1Z5'} />
            </div>
            <div className="md:col-span-2">
              <Label>Signature image URL</Label>
              <Input value={f.signatureUrl} onChange={(e) => set('signatureUrl', e.target.value)}
                maxLength={URL_MAX} placeholder="https://…/signature.png" />
              <p className="text-xs text-muted-foreground mt-1">Optional. Printed under “Authorised signatory”.</p>
            </div>
            <div className="md:col-span-2">
              <Label>Bank details (printed on invoice)</Label>
              <textarea value={f.bankDetails} onChange={(e) => set('bankDetails', e.target.value)}
                rows={4} maxLength={TEXT_MAX}
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                placeholder={'A/c name: My Company\nA/c no: 1234567890\nIFSC: HDFC0001234\nBank: HDFC Bank'} />
            </div>
            <div className="md:col-span-2">
              <Label>Terms &amp; conditions</Label>
              <textarea value={f.terms} onChange={(e) => set('terms', e.target.value)}
                rows={4} maxLength={TEXT_MAX}
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                placeholder="Payment due within 15 days. Interest @18% p.a. on late payment. Subject to Bengaluru jurisdiction." />
            </div>
            <div className="md:col-span-2 flex flex-wrap gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="h-4 w-4 accent-primary" checked={f.showHsn}
                  onChange={(e) => set('showHsn', e.target.checked)} /> Show HSN / SAC codes per line
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="h-4 w-4 accent-primary" checked={f.showEway}
                  onChange={(e) => set('showEway', e.target.checked)} /> Show E-way bill reference field
              </label>
            </div>
          </fieldset>
          <p className="text-xs text-muted-foreground mt-3 flex items-center gap-1">
            <Info className="h-3 w-3" /> Your GSTIN, legal name and address come from Settings → Billing &amp; tax identity.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
