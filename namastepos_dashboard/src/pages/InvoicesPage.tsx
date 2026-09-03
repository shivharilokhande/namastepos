// NamastePOS dashboard — Tax Invoices (Push 15c/e).
//
// GST tax invoices auto-issued from collected orders. Owners can list,
// search by date range, view detail, download as PDF or open a print
// preview, and cancel an issued invoice with a reason.

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, FileText, Printer, X, Search } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { ffApi } from '@/api/namastepos';
import { api, apiError, getBusinessCache } from '@/api/client';
import { formatINR } from '@/lib/utils';
import { escapeHtml, formatIstDateTime } from '@/lib/receiptPrint';

// WHY (2026-08-25): founder — "IRN generated · 580ce2… but where do those
// invoices go?" The IRN lives in einvoice_irns keyed by order_id;
// tax_invoices.irn is never written, so `invoice.irn` from the API is
// always null. We join IRNs onto invoices client-side via orderId using
// the new GET /businesses/:id/einvoice (ONE fetch, shared react-query
// cache with OrdersPage — never per-row).
type IrnRecord = {
  orderId: string | null;
  irn: string;
  ackNo?: string | null;
  ackDate?: string | null;
  status?: string | null;
  createdAt?: string | null;
};

// Invoice money is ALWAYS 2 decimals (2026-08-25 founder bug "invoices not
// proper format"). NP-131 (2026-09-03): formatINR({decimals:true}) now pins
// minimumFractionDigits to 2, so this is just a null-safe alias over the
// shared util — the duplicated Intl formatter (which also hardcoded en-IN/INR
// instead of honouring the business currency) is gone.
const inr2 = (n: number | null | undefined) => formatINR(Number(n ?? 0), { decimals: true });

// Item cell = name + variant when the line carries one (session invoices
// may add variantLabel later; render it the day it appears).
const itemLabel = (it: any) =>
  it.variantLabel || it.variant ? `${it.name} (${it.variantLabel || it.variant})` : it.name;

// ── Client-side A4 print preview ─────────────────────────────────────────
// WHY (2026-08-25): "Print" used to open the server-rendered PDF, which
// (a) formatted invoice_date with the SERVER's timezone — UTC on Render,
// so every printed time was 5h30 behind IST — and (b) had a cramped item
// grid. invoice_date is stored correctly (timestamptz NOW()); the bug was
// purely display-side, so we render the print view in the browser from
// the invoice JSON with explicit Asia/Kolkata formatting. Download PDF
// still streams the backend file.
function taxInvoiceHtml(inv: any): string {
  const itemRows = (inv.items || [])
    .map((it: any, i: number) => `
      <tr>
        <td class="c">${i + 1}</td>
        <td>${escapeHtml(itemLabel(it))}</td>
        <td class="mono">${escapeHtml(it.hsn || '')}</td>
        <td class="r">${escapeHtml(it.qty)}</td>
        <td class="r">${escapeHtml(inr2((it.unitPricePaise || 0) / 100))}</td>
        <td class="r">${escapeHtml(inr2((it.lineTaxablePaise || 0) / 100))}</td>
        <td class="r">${escapeHtml(it.gstPct || 0)}%</td>
        <td class="r">${escapeHtml(inr2((it.lineTotalPaise || 0) / 100))}</td>
      </tr>`)
    .join('');

  const gstRows = inv.isInterstate
    ? `<tr><td>IGST</td><td class="r">${escapeHtml(inr2(inv.igstInr))}</td></tr>`
    : `<tr><td>CGST</td><td class="r">${escapeHtml(inr2(inv.cgstInr))}</td></tr>
       <tr><td>SGST</td><td class="r">${escapeHtml(inr2(inv.sgstInr))}</td></tr>`;

  const hsnRows = (inv.hsnSummary || [])
    .map((h: any) => `
      <tr>
        <td class="mono">${escapeHtml(h.hsn)}</td>
        <td class="r">${escapeHtml(inr2(h.taxable / 100))}</td>
        <td class="r">${escapeHtml(inr2(h.cgst / 100))}</td>
        <td class="r">${escapeHtml(inr2(h.sgst / 100))}</td>
        <td class="r">${escapeHtml(inr2(h.igst / 100))}</td>
        <td class="r">${escapeHtml(inr2(h.total / 100))}</td>
      </tr>`)
    .join('');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Tax Invoice ${escapeHtml(inv.invoiceNo)}</title>
<style>
  @page { size: A4; margin: 12mm; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, Arial, sans-serif;
         color: #000; font-size: 12px; margin: 0 auto; max-width: 186mm; }
  h1 { font-size: 16px; text-align: center; margin: 0; letter-spacing: 1px; }
  .sub { text-align: center; font-size: 10px; margin-bottom: 10px; }
  .cancelled { text-align: center; font-weight: 800; color: #b91c1c;
               border: 2px dashed #b91c1c; padding: 4px; margin: 8px 0; letter-spacing: 3px; }
  .grid { display: flex; gap: 12px; border: 1px solid #000; padding: 8px; margin-bottom: 8px; }
  .grid > div { flex: 1; }
  .biz { font-size: 14px; font-weight: 700; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
  th, td { border: 1px solid #000; padding: 4px 6px; vertical-align: top; }
  th { background: #eee; text-align: left; font-size: 11px; }
  td.r, th.r { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  td.c { text-align: center; }
  .mono { font-family: ui-monospace, 'Courier New', monospace; font-size: 11px; }
  .totals { width: 60mm; margin-left: auto; }
  .totals td { border: none; border-bottom: 1px dotted #999; padding: 3px 4px; }
  .totals tr.tot td { border-top: 1px solid #000; border-bottom: none; font-weight: 800; font-size: 13px; }
  .words { font-style: italic; margin: 6px 0 10px; }
  .sec { font-weight: 700; margin: 8px 0 4px; }
  .noprint { text-align: center; margin: 16px 0; }
  .noprint button { padding: 8px 18px; font-weight: 700; cursor: pointer;
                    border: 1px solid #000; background: #fff; border-radius: 4px; }
  @media print { .noprint { display: none; } }
</style>
</head>
<body>
  <h1>TAX INVOICE</h1>
  <div class="sub">(Per Rule 46 of CGST Rules, 2017)</div>
  ${inv.status === 'cancelled' ? '<div class="cancelled">CANCELLED</div>' : ''}

  <div class="grid">
    <div>
      <div class="biz">${escapeHtml(inv.supplier?.name || '')}</div>
      ${inv.supplier?.address ? `<div>${escapeHtml(inv.supplier.address)}</div>` : ''}
      ${inv.supplier?.gstin ? `<div>GSTIN: <span class="mono">${escapeHtml(inv.supplier.gstin)}</span></div>` : ''}
      ${inv.supplier?.stateCode ? `<div>State code: ${escapeHtml(inv.supplier.stateCode)}</div>` : ''}
    </div>
    <div>
      <div>Invoice No: <b class="mono">${escapeHtml(inv.invoiceNo)}</b></div>
      <div>Date &amp; time: <b>${escapeHtml(formatIstDateTime(inv.invoiceDate))} IST</b></div>
      <div>FY: ${escapeHtml(inv.fy)}</div>
      <div>Place of supply: ${escapeHtml(inv.placeOfSupply)} ${inv.isInterstate ? '(interstate)' : '(intrastate)'}</div>
      <div>Reverse charge: ${inv.reverseCharge ? 'Yes' : 'No'}</div>
      <div>Payment: ${escapeHtml(inv.paymentMethod || '—')} (${escapeHtml(inv.paymentStatus || '')})</div>
      ${/* WHY (2026-08-25): when an IRN exists it MUST appear on the printed
            document (Rule 48(4) e-invoices are identified by IRN). The
            serializer already ships inv.irn; print() also back-fills it from
            einvoice_irns when the invoice row itself carries none. 64 hex
            chars — break-all so it wraps inside the meta column. */''}
      ${inv.irn ? `<div>IRN: <span class="mono" style="word-break:break-all">${escapeHtml(inv.irn)}</span></div>` : ''}
    </div>
  </div>

  <div class="grid">
    <div>
      <b>Recipient (Bill to / Ship to)</b>
      <div>${escapeHtml(inv.recipient?.name || '—')}</div>
      ${inv.recipient?.phone ? `<div>Phone: ${escapeHtml(inv.recipient.phone)}</div>` : ''}
      ${inv.recipient?.gstin ? `<div>GSTIN: <span class="mono">${escapeHtml(inv.recipient.gstin)}</span></div>` : ''}
      ${inv.recipient?.address ? `<div>${escapeHtml(inv.recipient.address)}</div>` : ''}
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width:6%">#</th>
        <th style="width:34%">Item</th>
        <th style="width:10%">HSN</th>
        <th class="r" style="width:7%">Qty</th>
        <th class="r" style="width:12%">Rate</th>
        <th class="r" style="width:12%">Taxable</th>
        <th class="r" style="width:7%">GST %</th>
        <th class="r" style="width:12%">Amount</th>
      </tr>
    </thead>
    <tbody>${itemRows}</tbody>
  </table>

  <table class="totals">
    <tr><td>Subtotal (taxable)</td><td class="r">${escapeHtml(inr2(inv.subtotalInr))}</td></tr>
    ${inv.discountInr > 0 ? `<tr><td>Discount</td><td class="r">-${escapeHtml(inr2(inv.discountInr))}</td></tr>` : ''}
    ${gstRows}
    ${inv.serviceChargeInr > 0 ? `<tr><td>Service charge</td><td class="r">${escapeHtml(inr2(inv.serviceChargeInr))}</td></tr>` : ''}
    <tr><td>Round-off</td><td class="r">${escapeHtml(inr2(inv.roundOffInr))}</td></tr>
    <tr class="tot"><td>Total</td><td class="r">${escapeHtml(inr2(inv.totalInr))}</td></tr>
  </table>
  <div class="words">${escapeHtml(inv.amountInWords || '')}</div>

  ${hsnRows ? `
  <div class="sec">HSN-wise summary</div>
  <table>
    <thead>
      <tr><th>HSN</th><th class="r">Taxable</th><th class="r">CGST</th>
          <th class="r">SGST</th><th class="r">IGST</th><th class="r">Total</th></tr>
    </thead>
    <tbody>${hsnRows}</tbody>
  </table>` : ''}

  <div class="noprint">
    <button onclick="window.print()">Print / Save as PDF</button>
  </div>
</body>
</html>`;
}

export function InvoicesPage() {
  const qc = useQueryClient();
  const firstOfMonth = new Date(); firstOfMonth.setDate(1);
  const [startDate, setStartDate] = useState(firstOfMonth.toISOString().slice(0, 10));
  const [endDate,   setEndDate]   = useState(new Date().toISOString().slice(0, 10));
  const [activeId,  setActiveId]  = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['tax-invoices', startDate, endDate],
    queryFn:  () => ffApi.listTaxInvoices({ startDate, endDate }),
  });

  const detail = useQuery({
    queryKey: ['tax-invoice', activeId],
    queryFn:  () => ffApi.getTaxInvoice(activeId!),
    enabled: !!activeId,
  });

  // ONE fetch of the business's IRNs, joined to invoices by orderId (see
  // IrnRecord note above). Same queryKey as OrdersPage so the cache is shared.
  const irnsQ = useQuery({
    queryKey: ['einvoice-irns'],
    queryFn: async () => {
      const b = getBusinessCache();
      const r = await api.get(`/businesses/${b.id}/einvoice`);
      return (r.data.irns || []) as IrnRecord[];
    },
    staleTime: 60 * 1000, // IRNs are immutable once generated
  });
  const irnByOrder = useMemo(() => {
    const m: Record<string, IrnRecord> = {};
    // API returns newest-first — keep the latest record per order.
    for (const r of irnsQ.data || []) if (r.orderId && !m[r.orderId]) m[r.orderId] = r;
    return m;
  }, [irnsQ.data]);
  // Invoice → IRN: the invoice row's own irn column wins if ever populated;
  // otherwise join through the order that the invoice was issued for.
  const irnForInvoice = (inv: any): IrnRecord | null => {
    if (!inv) return null;
    if (inv.irn) return { orderId: inv.orderId, irn: inv.irn };
    return (inv.orderId && irnByOrder[inv.orderId]) || null;
  };

  const cancel = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      ffApi.cancelTaxInvoice(id, reason),
    onSuccess: () => {
      toast.success('Invoice cancelled');
      qc.invalidateQueries({ queryKey: ['tax-invoices'] });
      qc.invalidateQueries({ queryKey: ['tax-invoice'] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  // Client-rendered print preview (see taxInvoiceHtml). Popup FIRST —
  // window.open only succeeds inside the live click gesture; opening it
  // after the awaited fetch is what popup blockers kill.
  const print = async (invoiceId: string) => {
    const w = window.open('', '_blank', 'width=900,height=1100');
    if (!w) { toast.error('Pop-up blocked — please allow pop-ups to print'); return; }
    try {
      // Reuse the already-loaded dialog data when printing the open invoice.
      const inv = (activeId === invoiceId && detail.data)
        ? detail.data
        : await ffApi.getTaxInvoice(invoiceId);
      // Back-fill the IRN from einvoice_irns (tax_invoices.irn is never
      // written — 2026-08-25) so a generated IRN prints on the document.
      w.document.open();
      w.document.write(taxInvoiceHtml({ ...inv, irn: irnForInvoice(inv)?.irn || null }));
      w.document.close();
      w.focus();
      w.print();
    } catch (e) {
      w.close();
      toast.error(apiError(e));
    }
  };

  const download = async (invoiceId: string, invoiceNo?: string) => {
    try { await ffApi.downloadTaxInvoicePdf(invoiceId, invoiceNo); }
    catch (e) { toast.error(apiError(e)); }
  };

  const invoices: any[] = list.data || [];
  const totalValue = invoices.reduce((s, i) => s + (i.totalInr || 0), 0);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Tax Invoices</h1>
          <p className="text-muted-foreground">
            GST Rule 46–compliant invoices, auto-issued when an order is collected.
            Numbering is sequential per financial year.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Filter</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div><Label>From</Label><Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></div>
            <div><Label>To</Label><Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></div>
            <Button variant="outline" onClick={() => list.refetch()}>
              <Search className="mr-2 h-4 w-4" /> Refresh
            </Button>
            <div className="flex-1" />
            <div className="text-right">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Total invoiced</div>
              <div className="text-xl font-bold tabular-nums">{inr2(totalValue)}</div>
              <div className="text-xs text-muted-foreground">{invoices.length} invoices</div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Invoices</CardTitle>
          <CardDescription>Click an invoice number to view + print.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {list.isLoading ? (
            <div className="py-8 text-center text-muted-foreground">Loading…</div>
          ) : invoices.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">
              No invoices in this range. Invoices are issued automatically when an order is marked collected.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice No</TableHead>
                  <TableHead>Date &amp; time</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>GSTIN</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Total (INR)</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoices.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell>
                      <button
                        onClick={() => setActiveId(i.id)}
                        className="font-mono text-primary hover:underline">{i.invoiceNo}</button>
                    </TableCell>
                    <TableCell className="text-sm">
                      {/* Explicit IST — browser/server TZ must never leak
                          onto a statutory document (founder bug 2026-08-25). */}
                      {formatIstDateTime(i.invoiceDate)}
                    </TableCell>
                    <TableCell>{i.recipient?.name || '—'}</TableCell>
                    <TableCell className="font-mono text-xs">{i.recipient?.gstin || '—'}</TableCell>
                    <TableCell>
                      <Badge variant={i.status === 'issued' ? 'success' : 'destructive'}>{i.status}</Badge>
                      {/* WHY (2026-08-25): founder lost track of generated
                          IRNs — flag e-invoiced rows right in the list. */}
                      {irnForInvoice(i) && (
                        <span
                          title="E-invoice IRN generated — open the invoice to view or copy it"
                          className="ml-1.5 inline-flex items-center rounded-full bg-emerald-100 text-emerald-700 px-2 py-0.5 text-[10px] font-semibold">
                          e-inv
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{inr2(i.totalInr)}</TableCell>
                    <TableCell className="text-right space-x-1">
                      <Button size="sm" variant="ghost" title="Print"
                          onClick={() => print(i.id)}>
                        <Printer className="h-4 w-4" />
                      </Button>
                      <Button size="sm" variant="ghost" title="Download PDF"
                          onClick={() => download(i.id, i.invoiceNo)}>
                        <FileText className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {activeId && (
        <InvoiceDialog
          invoice={detail.data}
          irnRec={irnForInvoice(detail.data)}
          onClose={() => setActiveId(null)}
          onPrint={() => print(activeId)}
          onDownload={() => download(activeId, detail.data?.invoiceNo)}
          onCancel={(reason) => cancel.mutate({ id: activeId, reason })}
          cancelling={cancel.isPending}
        />
      )}
    </div>
  );
}

function InvoiceDialog({
  invoice, irnRec, onClose, onPrint, onDownload, onCancel, cancelling,
}: {
  invoice: any | undefined;
  irnRec: IrnRecord | null;
  onClose: () => void;
  onPrint: () => void;
  onDownload: () => void;
  onCancel: (reason: string) => void;
  cancelling: boolean;
}) {
  const [cancelReason, setCancelReason] = useState('');
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  if (!invoice) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent><div className="py-8 text-center text-muted-foreground">Loading…</div></DialogContent>
      </Dialog>
    );
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Invoice <span className="font-mono">{invoice.invoiceNo}</span>
            {invoice.status === 'cancelled' && (
              <Badge variant="destructive" className="ml-2">cancelled</Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        {/* Letterhead block */}
        <div className="border rounded-md p-4 bg-muted/20">
          <div className="text-lg font-bold">{invoice.supplier.name}</div>
          {invoice.supplier.address && <div className="text-sm">{invoice.supplier.address}</div>}
          <div className="text-xs mt-1">
            {invoice.supplier.gstin && <>GSTIN: <span className="font-mono">{invoice.supplier.gstin}</span></>}
            {invoice.supplier.stateCode && <> · State: {invoice.supplier.stateCode}</>}
          </div>
        </div>

        {/* Meta */}
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div className="space-y-1">
            <div><span className="text-muted-foreground">Invoice No:</span> <span className="font-mono font-semibold">{invoice.invoiceNo}</span></div>
            {/* Explicit IST (2026-08-25) — never the browser/server TZ. */}
            <div><span className="text-muted-foreground">Date &amp; time:</span> {formatIstDateTime(invoice.invoiceDate)} IST</div>
            <div><span className="text-muted-foreground">FY:</span> {invoice.fy}</div>
            <div><span className="text-muted-foreground">Place of supply:</span> {invoice.placeOfSupply} {invoice.isInterstate ? '(interstate)' : '(intrastate)'}</div>
            <div><span className="text-muted-foreground">Reverse charge:</span> {invoice.reverseCharge ? 'Yes' : 'No'}</div>
            <div><span className="text-muted-foreground">Payment:</span> {invoice.paymentMethod || '—'} ({invoice.paymentStatus})</div>
          </div>
          <div className="space-y-1">
            <div className="font-semibold mb-1">Recipient</div>
            <div>{invoice.recipient.name || '—'}</div>
            {invoice.recipient.phone && <div>Phone: {invoice.recipient.phone}</div>}
            {invoice.recipient.gstin && <div>GSTIN: <span className="font-mono">{invoice.recipient.gstin}</span></div>}
            {invoice.recipient.address && <div>{invoice.recipient.address}</div>}
          </div>
        </div>

        {/* Line items — 2026-08-25 founder bug "not proper format when food
            items shows": the old 9-column grid had no width control (long
            dish names shoved the money columns off-grid) and rounded every
            amount to whole rupees. Now: fixed layout, name wraps inside its
            own column (+ variant inline), numeric columns right-aligned
            with paise-accurate ₹. GST amount folds under the GST % column
            so the row ends on the one number the founder reads: Amount. */}
        <div className="border rounded-md overflow-hidden">
          <table className="w-full table-fixed text-sm">
            <thead className="bg-muted/40">
              <tr>
                <th className="w-[5%] text-left py-2 px-2">#</th>
                <th className="w-[31%] text-left py-2 px-2">Item</th>
                <th className="w-[11%] text-left py-2 px-2">HSN</th>
                <th className="w-[7%] text-right py-2 px-2">Qty</th>
                <th className="w-[12%] text-right py-2 px-2">Rate</th>
                <th className="w-[13%] text-right py-2 px-2">Taxable</th>
                <th className="w-[8%] text-right py-2 px-2">GST %</th>
                <th className="w-[13%] text-right py-2 px-2">Amount</th>
              </tr>
            </thead>
            <tbody>
              {(invoice.items || []).map((it: any, i: number) => (
                <tr key={i} className="border-t align-top">
                  <td className="py-1.5 px-2">{i + 1}</td>
                  <td className="py-1.5 px-2 break-words">{itemLabel(it)}</td>
                  <td className="py-1.5 px-2 font-mono text-xs">{it.hsn}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums">{it.qty}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums">{inr2((it.unitPricePaise || 0) / 100)}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums">{inr2((it.lineTaxablePaise || 0) / 100)}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums">
                    {it.gstPct}%
                    <div className="text-[10px] text-muted-foreground">
                      {inr2((it.gstAmountPaise || 0) / 100)}
                    </div>
                  </td>
                  <td className="py-1.5 px-2 text-right tabular-nums font-semibold">{inr2((it.lineTotalPaise || 0) / 100)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Totals */}
        <div className="flex justify-end">
          <div className="w-72 space-y-1 text-sm">
            <Row label="Subtotal (taxable)" amt={invoice.subtotalInr} />
            {invoice.discountInr > 0 && <Row label="Discount" amt={-invoice.discountInr} />}
            {invoice.isInterstate
              ? <Row label="IGST" amt={invoice.igstInr} />
              : (<>
                <Row label="CGST" amt={invoice.cgstInr} />
                <Row label="SGST" amt={invoice.sgstInr} />
                </>)}
            {invoice.serviceChargeInr > 0 && <Row label="Service charge" amt={invoice.serviceChargeInr} />}
            <Row label="Round-off" amt={invoice.roundOffInr} />
            <div className="border-t pt-1.5 font-bold flex justify-between">
              <span>Total</span>
              <span className="tabular-nums">{inr2(invoice.totalInr)}</span>
            </div>
            <div className="text-xs text-muted-foreground italic mt-2">{invoice.amountInWords}</div>
          </div>
        </div>

        {/* HSN summary */}
        {invoice.hsnSummary?.length > 0 && (
          <div>
            <div className="text-sm font-semibold mb-1">HSN-wise summary</div>
            <table className="w-full text-xs">
              <thead className="bg-muted/40">
                <tr>
                  <th className="text-left py-1.5 px-3">HSN</th>
                  <th className="text-right py-1.5 px-3">Taxable</th>
                  <th className="text-right py-1.5 px-3">CGST</th>
                  <th className="text-right py-1.5 px-3">SGST</th>
                  <th className="text-right py-1.5 px-3">IGST</th>
                  <th className="text-right py-1.5 px-3">Total</th>
                </tr>
              </thead>
              <tbody>
                {invoice.hsnSummary.map((h: any) => (
                  <tr key={h.hsn} className="border-t">
                    <td className="py-1.5 px-3 font-mono">{h.hsn}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{inr2(h.taxable / 100)}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{inr2(h.cgst / 100)}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{inr2(h.sgst / 100)}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{inr2(h.igst / 100)}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{inr2(h.total / 100)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* E-invoice (2026-08-25): the IRN used to appear only in a toast
            and then vanish — this is its permanent home. Full IRN (64 hex
            chars, mono + break-all), one-tap copy for GST portal lookups,
            generated timestamp in IST, and stored status when present. */}
        {irnRec && (
          <div className="border rounded-md p-3 bg-muted/20 space-y-1.5">
            <div className="text-sm font-semibold">E-invoice</div>
            <div className="flex items-start gap-2">
              <div className="font-mono text-xs break-all flex-1">{irnRec.irn}</div>
              <Button
                size="sm" variant="outline" className="shrink-0"
                title="Copy IRN"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(irnRec.irn);
                    toast.success('IRN copied');
                  } catch {
                    toast.error('Could not copy — select the IRN text manually');
                  }
                }}
              >
                <Copy className="mr-1.5 h-3.5 w-3.5" /> Copy IRN
              </Button>
            </div>
            <div className="text-xs text-muted-foreground">
              {/* ackDate is when the IRP acknowledged; createdAt is our row
                  insert — same moment in the stubbed flow, ack wins if set. */}
              {(irnRec.ackDate || irnRec.createdAt) && (
                <>Generated: {formatIstDateTime(irnRec.ackDate || irnRec.createdAt!)} IST</>
              )}
              {irnRec.status && <> · Status: <span className="capitalize">{irnRec.status}</span></>}
              {irnRec.ackNo && <> · Ack no: <span className="font-mono">{irnRec.ackNo}</span></>}
            </div>
          </div>
        )}

        {invoice.status === 'cancelled' && invoice.cancellationReason && (
          <div className="text-sm border border-destructive/50 bg-destructive/5 rounded p-2">
            <span className="font-semibold">Cancellation reason:</span> {invoice.cancellationReason}
          </div>
        )}

        <DialogFooter className="flex-wrap gap-2">
          {invoice.status === 'issued' && !confirmingCancel && (
            <Button variant="ghost" className="text-destructive"
                onClick={() => setConfirmingCancel(true)}>
              <X className="mr-1.5 h-4 w-4" /> Cancel invoice
            </Button>
          )}
          {confirmingCancel && (
            <div className="flex gap-2 items-center flex-1">
              <Input placeholder="Cancellation reason (required)"
                  value={cancelReason}
                  onChange={(e) => setCancelReason(e.target.value)} />
              <Button variant="destructive" disabled={!cancelReason.trim() || cancelling}
                  onClick={() => onCancel(cancelReason.trim())}>
                {cancelling ? 'Cancelling…' : 'Confirm cancel'}
              </Button>
              <Button variant="ghost" onClick={() => setConfirmingCancel(false)}>Keep</Button>
            </div>
          )}
          <div className="flex-1" />
          <Button variant="outline" onClick={onDownload}>
            <FileText className="mr-1.5 h-4 w-4" /> Download PDF
          </Button>
          <Button onClick={onPrint}>
            <Printer className="mr-1.5 h-4 w-4" /> Print
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, amt }: { label: string; amt: number }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      {/* paise-accurate: a ₹0.40 round-off must not display as ₹0 */}
      <span className="tabular-nums">{inr2(amt)}</span>
    </div>
  );
}
