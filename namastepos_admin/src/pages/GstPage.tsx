import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, FileText } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from 'sonner';
import { adminApi } from '@/api/admin';
import { formatINR, formatDate } from '@/lib/utils';
import { apiError } from '@/api/client';

export function GstPage() {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  // Every panel here is filing data. A failed fetch must never render as
  // "₹0 / no invoices for this month" — that is a filing-grade lie.
  const { data: summary, isError: summaryErr, error: summaryErrObj, refetch: refetchSummary } = useQuery({
    queryKey: ['gst-summary', month], queryFn: () => adminApi.gstSummary(month),
  });
  const { data: gstr3b, isError: gstr3bErr, error: gstr3bErrObj, refetch: refetchGstr3b } = useQuery({
    queryKey: ['gstr3b', month], queryFn: () => adminApi.gstr3b(month),
  });
  // Push 19d — HSN summary (GSTR-1 Table 12) + B2B/B2C split
  const { data: hsn, isError: hsnErr, error: hsnErrObj, refetch: refetchHsn } = useQuery({
    queryKey: ['gst-hsn', month], queryFn: () => adminApi.gstHsn(month),
  });
  const { data: split, isError: splitErr, error: splitErrObj, refetch: refetchSplit } = useQuery({
    queryKey: ['gst-b2b-b2c', month], queryFn: () => adminApi.gstB2bB2c(month),
  });

  const downloadCsv = async () => {
    // NP-107: go through the shared axios instance — in cookie mode
    // getAdminToken() is null, so the old raw fetch sent no credentials
    // and (with no res.ok check) saved the 401 JSON as a .csv. Axios
    // attaches the cookie/CSRF (or Bearer fallback) and rejects on
    // non-2xx, so an error becomes a toast, never a file.
    try {
      const blob = await adminApi.gstr1Csv(month);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `gstr1-${month}.csv`;
      a.click(); URL.revokeObjectURL(url);
    } catch (e) { toast.error(apiError(e)); }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">GST & Tax</h1>
        <p className="text-muted-foreground">
          GSTR-1 / GSTR-3B summaries and CSV exports. Hand these to your CA or upload to gst.gov.in.
        </p>
      </div>

      <div className="flex items-end gap-3">
        <div>
          <Label>Month</Label>
          <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-44" />
        </div>
        <Button onClick={downloadCsv} variant="outline">
          <Download className="mr-2 h-4 w-4" /> Download GSTR-1 CSV
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>GSTR-3B summary</CardTitle>
            <CardDescription>Total tax payable for the month</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {gstr3bErr && (
              <div className="pb-1">
                <div className="text-sm text-destructive">Couldn't load the GSTR-3B summary — {apiError(gstr3bErrObj)}</div>
                <Button variant="outline" size="sm" className="mt-2" onClick={() => refetchGstr3b()}>Retry</Button>
              </div>
            )}
            <Row label="Platform GSTIN" value={gstr3bErr ? '—' : gstr3b?.platformGstin || <em className="text-destructive">Set in Settings → Platform settings</em>} />
            <Row label="Invoices" value={gstr3bErr ? '—' : String(gstr3b?.totalInvoices || 0)} />
            <Row label="Total taxable value" value={gstr3bErr ? '—' : formatINR(gstr3b?.totalTaxableValueInr || 0, { decimals: true })} bold />
            <Row label="IGST" value={gstr3bErr ? '—' : formatINR(gstr3b?.totalIgstInr || 0, { decimals: true })} />
            <Row label="CGST" value={gstr3bErr ? '—' : formatINR(gstr3b?.totalCgstInr || 0, { decimals: true })} />
            <Row label="SGST" value={gstr3bErr ? '—' : formatINR(gstr3b?.totalSgstInr || 0, { decimals: true })} />
            <div className="border-t pt-2 mt-2">
              <Row label="Grand total" value={gstr3bErr ? '—' : formatINR(gstr3b?.grandTotalInr || 0, { decimals: true })} bold />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>What's filed where</CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-3">
            <div>
              <div className="font-semibold flex items-center gap-2"><FileText className="h-4 w-4" /> GSTR-1</div>
              <p className="text-muted-foreground">Detailed outward supplies invoice-by-invoice. Filed monthly by the 11th.</p>
            </div>
            <div>
              <div className="font-semibold flex items-center gap-2"><FileText className="h-4 w-4" /> GSTR-3B</div>
              <p className="text-muted-foreground">Summary returns + tax payment. Filed monthly by the 20th.</p>
            </div>
            <div className="text-xs text-muted-foreground border-t pt-3">
              NamastePOS SaaS billing falls under HSN/SAC <code>998314</code> at 18% GST.
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Push 19d — B2B vs B2C split (GSTR-1 Tables 4/5/7) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>B2B (Table 4)</CardTitle>
            <CardDescription>Customers with a GSTIN. Eligible for ITC by buyer.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {splitErr && (
              <div className="pb-1">
                <div className="text-sm text-destructive">Couldn't load the B2B/B2C split — {apiError(splitErrObj)}</div>
                <Button variant="outline" size="sm" className="mt-2" onClick={() => refetchSplit()}>Retry</Button>
              </div>
            )}
            <Row label="Invoices" value={splitErr ? '—' : String(split?.b2b?.invoices || 0)} />
            <Row label="Taxable value" value={splitErr ? '—' : formatINR(split?.b2b?.taxable || 0, { decimals: true })} />
            <Row label="Tax" value={splitErr ? '—' : formatINR(split?.b2b?.tax || 0, { decimals: true })} />
            <Row label="Total" value={splitErr ? '—' : formatINR(split?.b2b?.total || 0, { decimals: true })} bold />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>B2C (Tables 5 + 7)</CardTitle>
            <CardDescription>Walk-in customers without a GSTIN.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <Row label="Invoices" value={splitErr ? '—' : String(split?.b2c?.invoices || 0)} />
            <Row label="Taxable value" value={splitErr ? '—' : formatINR(split?.b2c?.taxable || 0, { decimals: true })} />
            <Row label="Tax" value={splitErr ? '—' : formatINR(split?.b2c?.tax || 0, { decimals: true })} />
            <Row label="Total" value={splitErr ? '—' : formatINR(split?.b2c?.total || 0, { decimals: true })} bold />
          </CardContent>
        </Card>
      </div>

      {/* Push 19d — HSN-wise summary (GSTR-1 Table 12) */}
      <Card>
        <CardHeader>
          <CardTitle>HSN-wise summary (Table 12)</CardTitle>
          <CardDescription>One row per HSN/SAC code, aggregating taxable value + tax.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>HSN/SAC</TableHead>
                <TableHead>Rate %</TableHead>
                <TableHead>UQC</TableHead>
                <TableHead className="text-right">Taxable</TableHead>
                <TableHead className="text-right">IGST</TableHead>
                <TableHead className="text-right">CGST</TableHead>
                <TableHead className="text-right">SGST</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {hsnErr && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8">
                    <div className="text-sm text-destructive">Couldn't load the HSN summary — {apiError(hsnErrObj)}</div>
                    <Button variant="outline" size="sm" className="mt-2" onClick={() => refetchHsn()}>Retry</Button>
                  </TableCell>
                </TableRow>
              )}
              {!hsnErr && (!hsn?.hsn || hsn.hsn.length === 0) && (
                <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">No data for {month}.</TableCell></TableRow>
              )}
              {hsn?.hsn?.map((h: any) => (
                <TableRow key={h.hsn_code}>
                  <TableCell className="font-mono">{h.hsn_code}</TableCell>
                  <TableCell>{h.rate_pct}%</TableCell>
                  <TableCell className="text-xs">{h.uqc}</TableCell>
                  <TableCell className="text-right">{formatINR(h.taxable_value, { decimals: true })}</TableCell>
                  <TableCell className="text-right">{formatINR(h.igst, { decimals: true })}</TableCell>
                  <TableCell className="text-right">{formatINR(h.cgst, { decimals: true })}</TableCell>
                  <TableCell className="text-right">{formatINR(h.sgst, { decimals: true })}</TableCell>
                  <TableCell className="text-right font-medium">{formatINR(h.total, { decimals: true })}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>GSTR-1 line items</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Invoice #</TableHead><TableHead>Date</TableHead>
              <TableHead>Business</TableHead><TableHead>Cust. GSTIN</TableHead>
              <TableHead>State</TableHead>
              <TableHead className="text-right">Subtotal</TableHead>
              <TableHead className="text-right">Tax</TableHead>
              <TableHead className="text-right">Total</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {summaryErr && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-10">
                    <div className="text-sm text-destructive">Couldn't load the GSTR-1 line items — {apiError(summaryErrObj)}</div>
                    <Button variant="outline" size="sm" className="mt-2" onClick={() => refetchSummary()}>Retry</Button>
                  </TableCell>
                </TableRow>
              )}
              {!summaryErr && (summary?.rows || []).length === 0 && (
                <TableRow><TableCell colSpan={8} className="text-center py-10 text-muted-foreground">No paid invoices for {month}.</TableCell></TableRow>
              )}
              {summary?.rows.map((r: any, i: number) => (
                <TableRow key={i}>
                  <TableCell className="font-mono text-xs">{r.invoice_number}</TableCell>
                  <TableCell>{r.invoice_date}</TableCell>
                  <TableCell>{r.business}</TableCell>
                  <TableCell className="font-mono text-xs">{r.customer_gstin || '—'}</TableCell>
                  <TableCell className="text-xs">{r.place_of_supply}</TableCell>
                  <TableCell className="text-right">{formatINR(r.subtotal_inr, { decimals: true })}</TableCell>
                  <TableCell className="text-right">{formatINR(r.igst_inr + r.cgst_inr + r.sgst_inr, { decimals: true })}</TableCell>
                  <TableCell className="text-right font-medium">{formatINR(r.total_inr, { decimals: true })}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: any; bold?: boolean }) {
  return (
    <div className={`flex justify-between py-1 ${bold ? 'font-bold' : ''}`}>
      <span className="text-muted-foreground">{label}</span>
      <span>{value}</span>
    </div>
  );
}
