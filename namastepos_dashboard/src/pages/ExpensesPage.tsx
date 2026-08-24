import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ffApi } from '@/api/namastepos';
import { apiError } from '@/api/client';
import { formatINR, formatDate } from '@/lib/utils';

const CATEGORIES = ['ingredients','fuel','labor','rent','utilities','packaging','marketing','maintenance','other'];

export function ExpensesPage() {
  const qc = useQueryClient();
  const { data: expenses = [] } = useQuery({ queryKey: ['expenses'], queryFn: ffApi.listExpenses });
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ category: 'ingredients', amount: '', description: '', date: new Date().toISOString().slice(0, 10) });

  const create = useMutation({
    mutationFn: () => ffApi.createExpense({ ...form, amount: +form.amount }),
    onSuccess: () => { toast.success('Added'); qc.invalidateQueries({ queryKey: ['expenses'] }); setAdding(false); },
    onError: (e) => toast.error(apiError(e)),
  });
  const remove = useMutation({
    mutationFn: ffApi.deleteExpense,
    onSuccess: () => { toast.success('Deleted'); qc.invalidateQueries({ queryKey: ['expenses'] }); },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Expenses</h1>
          <p className="text-muted-foreground">{expenses.length} entries</p>
        </div>
        <Button onClick={() => setAdding(true)}><Plus className="mr-2 h-4 w-4" /> New expense</Button>
      </div>

      {adding && (
        <Card>
          <CardHeader><CardTitle>New expense</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <Label>Category</Label>
              <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm capitalize"
                      value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                {CATEGORIES.map((c) => <option key={c} value={c} className="capitalize">{c}</option>)}
              </select>
            </div>
            <div><Label>Amount (₹)</Label><Input type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></div>
            <div><Label>Date</Label><Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></div>
            <div><Label>Description</Label><Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
            <div className="md:col-span-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
              <Button onClick={() => create.mutate()} disabled={!form.amount || create.isPending}>
                {create.isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {expenses.length === 0 && (
                <TableRow><TableCell colSpan={5} className="py-10 text-center text-muted-foreground">No expenses yet.</TableCell></TableRow>
              )}
              {expenses.map((e: any) => (
                <TableRow key={e.id}>
                  <TableCell>{formatDate(e.date)}</TableCell>
                  <TableCell className="capitalize">{e.category}</TableCell>
                  <TableCell>{e.description || '—'}</TableCell>
                  <TableCell className="text-right font-medium">{formatINR(e.amount, { decimals: true })}</TableCell>
                  <TableCell><Button variant="ghost" size="sm" onClick={() => remove.mutate(e.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
