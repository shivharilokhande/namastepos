// Bank reconciliation (R15)
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Landmark, Upload, Link as LinkIcon } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { ffApi } from '@/api/namastepos';
import { apiError } from '@/api/client';
import { formatINR } from '@/lib/utils';

export function BankReconcilePage() {
  const qc = useQueryClient();
  const [bankName, setBankName] = useState('');
  const [accountNo, setAccountNo] = useState('');
  const [csv, setCsv] = useState<any[]>([]);
  const { data: unmatched = [] } = useQuery({ queryKey: ['bank-unmatched'], queryFn: ffApi.unmatchedBank });

  const parseCsv = (text: string) => {
    const lines = text.split(/\r?\n/).filter(Boolean);
    const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());
    return lines.slice(1).map((l) => {
      const cells = l.split(',');
      const obj: any = {};
      headers.forEach((h, i) => { obj[h] = cells[i]?.trim(); });
      return {
        date: obj.date,
        reference: obj.reference,
        description: obj.description,
        debit: parseFloat(obj.debit || '0'),
        credit: parseFloat(obj.credit || '0'),
      };
    });
  };

  const importIt = useMutation({
    mutationFn: () => ffApi.importBank({ bankName, accountNo, rows: csv }),
    onSuccess: (r: any) => {
      toast.success(`Imported ${r.imported} rows`);
      setCsv([]);
      qc.invalidateQueries({ queryKey: ['bank-unmatched'] });
    },
    onError: (e) => toast.error(apiError(e)),
  });
  const match = useMutation({
    mutationFn: () => ffApi.autoMatchBank(),
    onSuccess: (r: any) => {
      toast.success(`Matched ${r.matched} of ${r.totalUnmatched}`);
      qc.invalidateQueries({ queryKey: ['bank-unmatched'] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Landmark className="h-6 w-6 text-primary" /> Bank reconciliation
        </h1>
        <p className="text-muted-foreground text-sm">Upload your bank statement → auto-match to orders.</p>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Import statement</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Bank name</Label><Input value={bankName} onChange={(e) => setBankName(e.target.value)} /></div>
            <div><Label>Account no</Label><Input value={accountNo} onChange={(e) => setAccountNo(e.target.value)} /></div>
          </div>
          <Input type="file" accept=".csv" onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            const r = new FileReader();
            r.onload = () => setCsv(parseCsv(r.result as string));
            r.readAsText(f);
          }} />
          <div className="text-xs text-muted-foreground">CSV columns: date, reference, description, debit, credit</div>
          {csv.length > 0 && (
            <>
              <div className="text-sm">Parsed {csv.length} rows.</div>
              <Button onClick={() => importIt.mutate()} disabled={!bankName || !accountNo || importIt.isPending}>
                <Upload className="mr-2 h-4 w-4" /> Import {csv.length} rows
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Unmatched ({unmatched.length})</span>
            <Button size="sm" onClick={() => match.mutate()} disabled={match.isPending}>
              <LinkIcon className="mr-1 h-3 w-3" /> Auto-match
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground border-b">
              <tr><th className="p-3">Date</th><th>Description</th><th>Debit</th><th>Credit</th></tr>
            </thead>
            <tbody>
              {unmatched.length === 0 && <tr><td colSpan={4} className="p-6 text-center text-muted-foreground">No unmatched lines.</td></tr>}
              {unmatched.map((r: any) => (
                <tr key={r.id} className="border-b">
                  <td className="p-3">{r.statement_date?.slice(0, 10)}</td>
                  <td className="text-xs">{r.description}</td>
                  <td className="text-red-700">{r.debit_paise > 0 ? formatINR(r.debit_paise / 100) : ''}</td>
                  <td className="text-emerald-700">{r.credit_paise > 0 ? formatINR(r.credit_paise / 100) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
