import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { adminApi } from '@/api/admin';
import { apiError } from '@/api/client';
import { formatINR, formatDateTime } from '@/lib/utils';
import { useCan } from '@/lib/rbac';

export function RefundsPage() {
  const { data: refunds = [], isError, error, refetch } = useQuery({ queryKey: ['refunds'], queryFn: () => adminApi.listRefunds() });
  const [initiating, setInitiating] = useState(false);
  const { can } = useCan(); // F-10 — POST /admin/refunds is refunds.write

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Refunds</h1>
          <p className="text-muted-foreground">
            {/* Finding-2 fix (2026-08-25): the old copy pointed to an
                Invoices tab that had no such control. Refunds are now
                initiated right here against a subscription payment. */}
            {isError ? '—' : `${refunds.length} refunds`}
          </p>
        </div>
        {can('refunds.write') && (
          <Button onClick={() => setInitiating(true)}>
            <Plus className="mr-2 h-4 w-4" /> Initiate refund
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Date</TableHead><TableHead>Business</TableHead>
              <TableHead>Reason</TableHead><TableHead>Status</TableHead>
              <TableHead>Initiated by</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {isError && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-10">
                    <div className="text-sm text-destructive">Couldn't load refunds — {apiError(error)}</div>
                    <Button variant="outline" size="sm" className="mt-2" onClick={() => refetch()}>Retry</Button>
                  </TableCell>
                </TableRow>
              )}
              {!isError && refunds.length === 0 && (
                <TableRow><TableCell colSpan={6} className="text-center py-10 text-muted-foreground">No refunds yet.</TableCell></TableRow>
              )}
              {refunds.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{formatDateTime(r.createdAt)}</TableCell>
                  <TableCell className="font-medium">{r.businessName || '—'}</TableCell>
                  <TableCell className="text-sm">{r.reason || '—'}</TableCell>
                  <TableCell>
                    <Badge variant={
                      r.status === 'processed' ? 'success' :
                      r.status === 'failed' ? 'destructive' :
                      r.status === 'cancelled' ? 'muted' : 'warning'
                    }>{r.status}</Badge>
                  </TableCell>
                  <TableCell className="text-xs">{r.adminEmail || '—'}</TableCell>
                  <TableCell className="text-right font-medium">{formatINR(r.amount, { decimals: true })}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {initiating && <InitiateRefundDialog onClose={() => setInitiating(false)} />}
    </div>
  );
}

function InitiateRefundDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    paymentId: '', amountInr: '', reason: '', businessId: '',
  });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const initiate = useMutation({
    mutationFn: () => adminApi.initiateRefund({
      paymentId: form.paymentId.trim(),
      // Backend takes paise; blank = full-payment refund.
      amountPaise: form.amountInr ? Math.round(parseFloat(form.amountInr) * 100) : undefined,
      reason: form.reason || undefined,
      businessId: form.businessId.trim() || undefined,
    }),
    onSuccess: () => {
      toast.success('Refund initiated');
      qc.invalidateQueries({ queryKey: ['refunds'] });
      onClose();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <Dialog open={true} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>Initiate refund</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Payment ID *</Label>
            <Input value={form.paymentId} placeholder="Subscription payment UUID"
                   onChange={(e) => set('paymentId', e.target.value)} />
            <p className="text-xs text-muted-foreground mt-1">
              The platform payment (from the customer's billing history) to refund.
            </p>
          </div>
          <div>
            <Label>Amount (₹)</Label>
            <Input type="number" min="0" step="0.01" value={form.amountInr}
                   placeholder="Leave blank to refund the full payment"
                   onChange={(e) => set('amountInr', e.target.value)} />
          </div>
          <div>
            <Label>Reason</Label>
            <Input value={form.reason} placeholder="e.g. duplicate charge"
                   onChange={(e) => set('reason', e.target.value)} />
          </div>
          <div>
            <Label>Business ID (optional)</Label>
            <Input value={form.businessId} placeholder="Log this refund on the tenant's CRM timeline"
                   onChange={(e) => set('businessId', e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => initiate.mutate()}
                  disabled={!form.paymentId.trim() || initiate.isPending}>
            {initiate.isPending ? 'Initiating…' : 'Initiate refund'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
