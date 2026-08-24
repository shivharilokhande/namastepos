import { useQuery } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { adminApi } from '@/api/admin';
import { formatINR, formatDateTime } from '@/lib/utils';

export function RefundsPage() {
  const { data: refunds = [] } = useQuery({ queryKey: ['refunds'], queryFn: () => adminApi.listRefunds() });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Refunds</h1>
        <p className="text-muted-foreground">
          {refunds.length} refunds. Initiate new refunds from a customer's Invoices tab.
        </p>
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
              {refunds.length === 0 && (
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
    </div>
  );
}
