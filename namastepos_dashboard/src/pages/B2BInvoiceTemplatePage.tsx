// B2B invoice template (R20)
//
// D-04 (2026-09-05): this page used to READ and WRITE the thermal RECEIPT
// template (`/bill-template`): letterhead → logoUrl, terms → footerText,
// and signature / bank details / HSN / e-way were never sent anywhere. An
// Enterprise owner who pressed Save silently overwrote their receipt logo
// and footer with B2B letterhead and terms; everyone else got a 402
// (`PUT /bill-template` is requireFeature('custom_branding')).
//
// The backend has NO storage for a B2B template today — `bill_templates` is
// a fixed-column table and its Joi schema rejects unknown keys
// (validate.js: allowUnknown false), so a nested `b2b` object cannot be
// smuggled in. Until a `b2b_template` store exists server-side this page is
// READ-ONLY and says so plainly, instead of pretending to save. Viewing is
// gated on `b2b_invoice` by the route guard (App.tsx / nav table).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { FileText, Info } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { usePlan } from '@/hooks/usePlan';

export function B2BInvoiceTemplatePage() {
  const plan = usePlan();
  // Local draft only — nothing here is persisted yet (see header comment).
  const [f, setF] = useState<any>({
    letterheadUrl: '', signatureUrl: '', termsText: '',
    bankDetails: '', showHsn: true, showEway: false,
  });
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  const hasBranding = plan.has('custom_branding');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <FileText className="h-6 w-6 text-primary" /> B2B invoice template
          </h1>
          <p className="text-muted-foreground text-sm">For wholesale / retail invoices (separate from restaurant receipts).</p>
        </div>
      </div>

      <Card className="border-amber-300 bg-amber-50/60 dark:bg-amber-950/20">
        <CardContent className="p-4 text-sm space-y-2">
          <div className="flex items-center gap-2 font-semibold"><Info className="h-4 w-4" /> Saving a B2B template is not available yet</div>
          <p className="text-muted-foreground">
            NamastePOS does not yet store a separate B2B invoice template, so the fields below cannot be saved.
            This page is read-only until that ships — previously it overwrote your <em>receipt</em> template, which it must not do.
          </p>
          <p className="text-muted-foreground">
            Your printed receipt (logo, header lines, GSTIN, footer) is edited under{' '}
            <Link to="/bill-template" className="underline">Receipt template</Link>
            {hasBranding
              ? '.'
              : ' — editing it requires the Custom branding feature (Enterprise or the Custom-branding add-on); saving a B2B template will need it too.'}
          </p>
          {!hasBranding && plan.loaded && (
            <Button asChild size="sm" variant="outline"><Link to="/billing">View plans</Link></Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Letterhead &amp; signature</CardTitle><CardDescription>Preview of the fields the B2B template will hold. Read-only.</CardDescription></CardHeader>
        <CardContent>
          <fieldset disabled className="grid grid-cols-1 md:grid-cols-2 gap-3 opacity-70">
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
          </fieldset>
        </CardContent>
      </Card>
    </div>
  );
}
