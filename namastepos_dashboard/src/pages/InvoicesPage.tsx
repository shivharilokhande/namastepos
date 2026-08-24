// NamastePOS dashboard — Tax Invoices (Push 15c/e).
//
// GST tax invoices auto-issued from collected orders. Owners can list,
// search by date range, view detail, download as PDF or open a print
// preview, and cancel an issued invoice with a reason.

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FileText, Printer, X, Search } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { ffApi } from '@/api/namastepos';
import { apiError } from '@/api/client';
import { formatINR } from '@/lib/utils';

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

  const print = async (invoiceId: string) => {
    try {
      const url = await ffApi.taxInvoicePrintBlobUrl(invoiceId);
      const w = window.open(url, '_blank');
      if (!w) toast.error('Pop-up blocked — please allow pop-ups to print');
    } catch (e) { toast.error(apiError(e)); }
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
              <div className="text-xl font-bold tabular-nums">{formatINR(totalValue)}</div>
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
                      {new Date(i.invoiceDate).toLocaleString('en-IN')}
                    </TableCell>
                    <TableCell>{i.recipient?.name || '—'}</TableCell>
                    <TableCell className="font-mono text-xs">{i.recipient?.gstin || '—'}</TableCell>
                    <TableCell>
                      <Badge variant={i.status === 'issued' ? 'success' : 'destructive'}>{i.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatINR(i.totalInr)}</TableCell>
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
  invoice, onClose, onPrint, onDownload, onCancel, cancelling,
}: {
  invoice: any | undefined;
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
            <div><span className="text-muted-foreground">Date &amp; time:</span> {new Date(invoice.invoiceDate).toLocaleString('en-IN')}</div>
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

        {/* Line items */}
        <div className="border rounded-md overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr>
                <th className="text-left py-2 px-3">#</th>
                <th className="text-left py-2 px-3">Item</th>
                <th className="text-left py-2 px-3">HSN</th>
                <th className="text-right py-2 px-3">Qty</th>
                <th className="text-right py-2 px-3">Rate</th>
                <th className="text-right py-2 px-3">Taxable</th>
                <th className="text-right py-2 px-3">GST %</th>
                <th className="text-right py-2 px-3">GST Amt</th>
                <th className="text-right py-2 px-3">Total</th>
              </tr>
            </thead>
            <tbody>
              {(invoice.items || []).map((it: any, i: number) => (
                <tr key={i} className="border-t">
                  <td className="py-1.5 px-3">{i + 1}</td>
                  <td className="py-1.5 px-3">{it.name}</td>
                  <td className="py-1.5 px-3 font-mono text-xs">{it.hsn}</td>
                  <td className="py-1.5 px-3 text-right tabular-nums">{it.qty}</td>
                  <td className="py-1.5 px-3 text-right tabular-nums">{formatINR((it.unitPricePaise || 0) / 100)}</td>
                  <td className="py-1.5 px-3 text-right tabular-nums">{formatINR((it.lineTaxablePaise || 0) / 100)}</td>
                  <td className="py-1.5 px-3 text-right tabular-nums">{it.gstPct}%</td>
                  <td className="py-1.5 px-3 text-right tabular-nums">{formatINR((it.gstAmountPaise || 0) / 100)}</td>
                  <td className="py-1.5 px-3 text-right tabular-nums font-semibold">{formatINR((it.lineTotalPaise || 0) / 100)}</td>
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
              <span className="tabular-nums">{formatINR(invoice.totalInr)}</span>
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
                    <td className="py-1.5 px-3 text-right tabular-nums">{formatINR(h.taxable / 100)}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{formatINR(h.cgst / 100)}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{formatINR(h.sgst / 100)}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{formatINR(h.igst / 100)}</td>
                    <td className="py-1.5 px-3 text-right tabular-nums">{formatINR(h.total / 100)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
      <span className="tabular-nums">{formatINR(amt)}</span>
    </div>
  );
}
