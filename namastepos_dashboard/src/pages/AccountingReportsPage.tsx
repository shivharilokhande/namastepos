// P&L + Balance Sheet + Trial Balance (R19)
import { useEffect, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BookOpen, RefreshCw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ffApi } from '@/api/namastepos';
import { apiError } from '@/api/client';
import { formatINR } from '@/lib/utils';

export function AccountingReportsPage() {
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const [start, setStart] = useState(monthAgo);
  const [end, setEnd] = useState(today);
  const [tab, setTab] = useState<'pnl' | 'bs' | 'tb'>('pnl');

  const seed = useMutation({
    mutationFn: () => ffApi.seedCoa(),
    onSuccess: () => toast.success('Chart of accounts seeded'),
    onError: (e) => toast.error(apiError(e)),
  });
  const { data: pnl } = useQuery({ queryKey: ['pnl', start, end], queryFn: () => ffApi.profitAndLoss({ startDate: start, endDate: end }), enabled: tab === 'pnl' });
  const { data: bs }  = useQuery({ queryKey: ['bs', end], queryFn: () => ffApi.balanceSheet(end), enabled: tab === 'bs' });
  const { data: tb }  = useQuery({ queryKey: ['tb', end], queryFn: () => ffApi.trialBalance(end), enabled: tab === 'tb' });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <BookOpen className="h-6 w-6 text-primary" /> Accounting reports
          </h1>
          <p className="text-muted-foreground text-sm">Trial balance, P&amp;L, balance sheet — generated from journal entries.</p>
        </div>
        <Button variant="outline" onClick={() => seed.mutate()}>
          <RefreshCw className="mr-1 h-4 w-4" /> Seed chart of accounts
        </Button>
      </div>

      <Card>
        <CardContent className="p-3 flex gap-2 items-end">
          <div><Label>Start</Label><Input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></div>
          <div><Label>End / As of</Label><Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></div>
        </CardContent>
      </Card>

      <div className="flex gap-2 border-b">
        {(['pnl','bs','tb'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 ${tab===t ? 'border-primary text-primary' : 'border-transparent text-muted-foreground'}`}>
            {t === 'pnl' ? 'Profit & Loss' : t === 'bs' ? 'Balance Sheet' : 'Trial Balance'}
          </button>
        ))}
      </div>

      {tab === 'pnl' && pnl && (
        <Card>
          <CardHeader><CardTitle>Profit &amp; Loss · {start} → {end}</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            <div className="font-bold mt-2">Income</div>
            {pnl.income.map((x: any) => (
              <div key={x.code} className="flex justify-between"><span>{x.code} · {x.name}</span><span>{formatINR(x.amount_inr)}</span></div>
            ))}
            <div className="flex justify-between font-semibold border-t pt-1">
              <span>Total income</span><span>{formatINR(pnl.totalIncomeInr)}</span>
            </div>
            <div className="font-bold mt-3">Expense</div>
            {pnl.expense.map((x: any) => (
              <div key={x.code} className="flex justify-between"><span>{x.code} · {x.name}</span><span>{formatINR(x.amount_inr)}</span></div>
            ))}
            <div className="flex justify-between font-semibold border-t pt-1">
              <span>Total expense</span><span>{formatINR(pnl.totalExpenseInr)}</span>
            </div>
            <div className="flex justify-between font-extrabold text-lg border-t pt-2 mt-3">
              <span>Net profit</span>
              <span className={pnl.netProfitInr >= 0 ? 'text-emerald-700' : 'text-red-700'}>
                {formatINR(pnl.netProfitInr)}
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {tab === 'bs' && bs && (
        <Card>
          <CardHeader><CardTitle>Balance Sheet · as of {end}</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-6 text-sm">
            <div>
              <div className="font-bold mb-2">Assets</div>
              {bs.assets.map((x: any) => (
                <div key={x.code} className="flex justify-between"><span>{x.name}</span><span>{formatINR(x.balance_inr)}</span></div>
              ))}
              <div className="flex justify-between font-bold border-t pt-1 mt-1"><span>Total assets</span><span>{formatINR(bs.totalAssets)}</span></div>
            </div>
            <div>
              <div className="font-bold mb-2">Liabilities</div>
              {bs.liabilities.map((x: any) => (
                <div key={x.code} className="flex justify-between"><span>{x.name}</span><span>{formatINR(x.balance_inr)}</span></div>
              ))}
              <div className="font-bold mt-3 mb-2">Equity</div>
              {bs.equity.map((x: any) => (
                <div key={x.code} className="flex justify-between"><span>{x.name}</span><span>{formatINR(x.balance_inr)}</span></div>
              ))}
              <div className="flex justify-between font-bold border-t pt-1 mt-1">
                <span>Total liabilities + equity</span>
                <span>{formatINR(bs.totalLiabilities + bs.totalEquity)}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {tab === 'tb' && tb && (
        <Card>
          <CardHeader><CardTitle>Trial Balance · as of {end}</CardTitle></CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground border-b">
                <tr><th className="p-3">Account</th><th>Debit</th><th>Credit</th><th>Balance</th></tr>
              </thead>
              <tbody>
                {tb.lines.map((l: any) => (
                  <tr key={l.code} className="border-b">
                    <td className="p-3">{l.code} · {l.name}</td>
                    <td>{l.debit > 0 ? formatINR(l.debit/100) : ''}</td>
                    <td>{l.credit > 0 ? formatINR(l.credit/100) : ''}</td>
                    <td className="font-bold">{formatINR(l.balance_inr)}</td>
                  </tr>
                ))}
                <tr className="font-bold bg-muted/30">
                  <td className="p-3">Totals</td>
                  <td>{formatINR(tb.totalDebitInr)}</td>
                  <td>{formatINR(tb.totalCreditInr)}</td>
                  <td></td>
                </tr>
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
