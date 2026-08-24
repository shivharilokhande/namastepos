// B2B invoice template (R20)
import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FileText, Save } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, getBusinessCache } from '@/api/client';
import { apiError } from '@/api/client';

// Lightweight: a second template alongside the bill template, for B2B
// invoices. Uses platform_settings KV for now.
export function B2BInvoiceTemplatePage() {
  const qc = useQueryClient();
  const [f, setF] = useState<any>({
    letterheadUrl: '', signatureUrl: '', termsText: '',
    bankDetails: '', footerText: '', showHsn: true, showEway: false,
  });
  // Use the existing platform_settings keyspace
  const { data: existing } = useQuery({
    queryKey: ['b2b-template'],
    queryFn: async () => {
      const b = getBusinessCache();
      const r = await api.get(`/businesses/${b.id}/bill-template`).catch(() => null);
      return r?.data?.template || null;
    },
  });
  useEffect(() => {
    if (existing) setF({
      letterheadUrl: existing.logoUrl || '',
      signatureUrl: '',
      termsText: existing.footerText || '',
      bankDetails: '',
      footerText: existing.footerText || '',
      showHsn: true, showEway: false,
    });
  }, [existing]);

  const save = useMutation({
    mutationFn: async () => {
      const b = getBusinessCache();
      return api.put(`/businesses/${b.id}/bill-template`, {
        logoUrl: f.letterheadUrl,
        footerText: f.termsText || f.footerText,
        showTaxBreakdown: true,
      });
    },
    onSuccess: () => { toast.success('Invoice template saved'); qc.invalidateQueries({ queryKey: ['b2b-template'] }); },
    onError: (e) => toast.error(apiError(e)),
  });
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <FileText className="h-6 w-6 text-primary" /> B2B invoice template
          </h1>
          <p className="text-muted-foreground text-sm">For wholesale / retail invoices (separate from restaurant receipts).</p>
        </div>
        <Button onClick={() => save.mutate()}><Save className="mr-2 h-4 w-4" /> Save</Button>
      </div>
      <Card>
        <CardHeader><CardTitle>Letterhead &amp; signature</CardTitle><CardDescription>Shown at top + bottom of every invoice.</CardDescription></CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div><Label>Letterhead image URL</Label><Input value={f.letterheadUrl} onChange={(e) => set('letterheadUrl', e.target.value)} /></div>
          <div><Label>Signature image URL</Label><Input value={f.signatureUrl} onChange={(e) => set('signatureUrl', e.target.value)} /></div>
          <div className="md:col-span-2"><Label>Bank details (printed on invoice)</Label>
            <textarea value={f.bankDetails} onChange={(e) => set('bankDetails', e.target.value)}
              rows={3} className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              placeholder={"A/c name: My Company\nA/c no: 1234567890\nIFSC: HDFC0001234\nBank: HDFC Bank"} />
          </div>
          <div className="md:col-span-2"><Label>Terms &amp; conditions</Label>
            <textarea value={f.termsText} onChange={(e) => set('termsText', e.target.value)}
              rows={4} className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
          </div>
          <div className="md:col-span-2 flex gap-4">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.showHsn} onChange={(e) => set('showHsn', e.target.checked)} /> Show HSN codes</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.showEway} onChange={(e) => set('showEway', e.target.checked)} /> Auto-generate E-way bill ref</label>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
