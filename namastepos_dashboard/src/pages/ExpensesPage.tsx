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

// Founder bug #4 (2026-08-25): restaurants book salaries, gas, electricity
// etc. — value/label pairs because snake_case values (chef_salary) render
// badly with the old capitalize-the-raw-string approach. Keep in sync with
// the backend whitelist (expenseController) + expense_category enum (058).
const CATEGORIES: { value: string; label: string }[] = [
  { value: 'ingredients', label: 'Ingredients' },
  { value: 'fuel', label: 'Fuel' },
  { value: 'labor', label: 'Labor' },
  { value: 'rent', label: 'Rent' },
  { value: 'utilities', label: 'Utilities' },
  { value: 'packaging', label: 'Packaging' },
  { value: 'marketing', label: 'Marketing' },
  { value: 'maintenance', label: 'Maintenance' },
  { value: 'chef_salary', label: 'Chef Salary' },
  { value: 'helper_salary', label: 'Helper Salary' },
  { value: 'staff_salary', label: 'Staff Salary' },
  { value: 'gas', label: 'Gas' },
  { value: 'electricity', label: 'Electricity' },
  { value: 'water', label: 'Water' },
  { value: 'transport', label: 'Transport' },
  { value: 'equipment', label: 'Equipment' },
  { value: 'cleaning', label: 'Cleaning' },
  { value: 'license_fees', label: 'License Fees' },
  { value: 'other', label: 'Other' },
];

// Table rows can also carry backend-generated categories (wastage,
// refund_cogs) that aren't user-pickable — fall back to the raw value.
function categoryLabel(value: string): string {
  return CATEGORIES.find((c) => c.value === value)?.label || value;
}

export function ExpensesPage() {
  const qc = useQueryClient();
  // NP-128 (2026-09-03): was an UNBOUNDED fetch of the full expense history.
  // Server-side pagination now, same pager as OrdersPage (50/page).
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;
  const { data: pageData } = useQuery({
    queryKey: ['expenses', page],
    queryFn: () => ffApi.listExpensesPaged({ limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
  });
  const expenses = pageData?.expenses ?? [];
  const total = pageData?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
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
          <p className="text-muted-foreground">{total} entries</p>
        </div>
        <Button onClick={() => setAdding(true)}><Plus className="mr-2 h-4 w-4" /> New expense</Button>
      </div>

      {adding && (
        <Card>
          <CardHeader><CardTitle>New expense</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <Label>Category</Label>
              <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                      value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
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
                  <TableCell>{categoryLabel(e.category)}</TableCell>
                  <TableCell>{e.description || '—'}</TableCell>
                  <TableCell className="text-right font-medium">{formatINR(e.amount, { decimals: true })}</TableCell>
                  <TableCell><Button variant="ghost" size="sm" onClick={() => remove.mutate(e.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {/* NP-128 — same pager as OrdersPage: bounded fetch, one page at a time. */}
          {total > PAGE_SIZE && (
            <div className="flex items-center justify-between border-t px-4 py-3">
              <div className="text-xs text-muted-foreground">
                {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline"
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}>
                  Previous
                </Button>
                <span className="text-xs text-muted-foreground tabular-nums">
                  Page {page + 1} / {pageCount}
                </span>
                <Button size="sm" variant="outline"
                  disabled={page + 1 >= pageCount}
                  onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}>
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
