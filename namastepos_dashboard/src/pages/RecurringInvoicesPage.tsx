// Recurring invoices (R16)
//
// History. D-01 (2026-09-05): the original page was a placeholder that told
// owners to POST to `/retail/quotations` — no such API existed and the cron
// generated nothing. It was replaced with an honest "coming soon" card.
//
// 2026-09-06 (round 2, CONTRACTS §2): the feature is BUILT server-side —
// `GET/POST /recurring-invoices`, `PATCH/DELETE /:id`, `POST /:id/run-now`
// (routes/recurringInvoices.routes.js), generated on schedule by
// cronWorker.dueRecurringInvoices via taxInvoiceService. This page is the
// real CRUD UI: list, create/edit dialog (customer picker from the existing
// customers API, line items with HSN / qty / unit price / GST %), active
// toggle, run-now, delete.
//
// Money: the owner types RUPEES; the wire carries `unitPricePaise` integers
// (Math.round(inr * 100)) and every total we show is derived from paise.
// Route + nav are gated on `recurring_invoices` (lib/navConfig.ts →
// RequireFeature), and the server enforces the same key on every call.
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Repeat, Plus, Play, Pencil, Trash2, Search } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { DateInput } from '@/components/ui/date-input';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table';
import {
  ffApi, type RecurringSchedule, type RecurringScheduleBody, type RecurringFrequency,
} from '@/api/namastepos';
import { apiError } from '@/api/client';
import { useDebounce } from '@/hooks/useDebounce';
import { formatINR, formatDate } from '@/lib/utils';
import { inrToPaise, lineTotalPaise, paiseToInr } from '@/lib/paise';

// One row of GET /customers as this picker reads it.
type CustomerPick = { id: string; name?: string | null; phone?: string | null; gstin?: string | null };

const FREQUENCIES: { value: RecurringFrequency; label: string }[] = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'yearly', label: 'Yearly' },
];

// Mirrors the GST slabs the menu editor offers; the server validates gstPct
// as a number so anything typed is accepted, this is only the quick list.
const GST_SLABS = [0, 5, 12, 18, 28];

export const RECURRING_QUERY_KEY = ['recurring-invoices'] as const;

// Form row keeps the RUPEE string the owner typed so "12.50" is not
// re-rendered as "12.5" mid-keystroke; conversion happens on submit.
type ItemDraft = { name: string; hsn: string; qty: string; unitPriceInr: string; gstPct: string };
type Draft = {
  name: string;
  customerId: string;
  customerName: string;
  frequency: RecurringFrequency;
  startDate: string;
  endDate: string;
  notes: string;
  items: ItemDraft[];
};

const emptyItem = (): ItemDraft => ({ name: '', hsn: '', qty: '1', unitPriceInr: '', gstPct: '5' });
const todayISO = () => new Date().toISOString().slice(0, 10);
const emptyDraft = (): Draft => ({
  name: '', customerId: '', customerName: '', frequency: 'monthly',
  startDate: todayISO(), endDate: '', notes: '', items: [emptyItem()],
});

function draftFromSchedule(s: RecurringSchedule): Draft {
  return {
    name: s.name || '',
    customerId: s.customerId,
    customerName: s.customerName || '',
    frequency: s.frequency,
    startDate: s.nextRunAt ? s.nextRunAt.slice(0, 10) : todayISO(),
    endDate: s.endDate ? s.endDate.slice(0, 10) : '',
    notes: s.notes || '',
    items: (s.items || []).map((it) => ({
      name: it.name,
      hsn: it.hsn || '',
      qty: String(it.qty),
      unitPriceInr: paiseToInr(it.unitPricePaise).toFixed(2),
      gstPct: String(it.gstPct ?? 0),
    })),
  };
}

function bodyFromDraft(d: Draft): RecurringScheduleBody {
  return {
    name: d.name.trim(),
    customerId: d.customerId,
    frequency: d.frequency,
    startDate: d.startDate,
    endDate: d.endDate || null,
    notes: d.notes.trim() || null,
    items: d.items
      .filter((it) => it.name.trim())
      .map((it) => ({
        name: it.name.trim(),
        hsn: it.hsn.trim() || null,
        qty: Number(it.qty) || 0,
        unitPricePaise: inrToPaise(it.unitPriceInr),
        gstPct: Number(it.gstPct) || 0,
      })),
  };
}

export function RecurringInvoicesPage() {
  const qc = useQueryClient();
  const { data: schedules = [], isLoading, isError, error, refetch } = useQuery({
    queryKey: RECURRING_QUERY_KEY,
    queryFn: ffApi.listRecurringInvoices,
    retry: false,
  });

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<RecurringSchedule | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft());

  const openCreate = () => { setEditing(null); setDraft(emptyDraft()); setOpen(true); };
  const openEdit = (s: RecurringSchedule) => { setEditing(s); setDraft(draftFromSchedule(s)); setOpen(true); };
  const close = () => { setOpen(false); setEditing(null); };

  const invalidate = () => qc.invalidateQueries({ queryKey: RECURRING_QUERY_KEY });

  const create = useMutation({
    mutationFn: (body: RecurringScheduleBody) => ffApi.createRecurringInvoice(body),
    onSuccess: () => { toast.success('Schedule created'); close(); invalidate(); },
    onError: (e) => toast.error(apiError(e)),
  });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<RecurringScheduleBody> & { isActive?: boolean } }) =>
      ffApi.updateRecurringInvoice(id, patch),
    onSuccess: (_s, vars) => {
      toast.success(vars.patch.isActive === undefined ? 'Schedule updated'
        : vars.patch.isActive ? 'Schedule resumed' : 'Schedule paused');
      close(); invalidate();
    },
    onError: (e) => toast.error(apiError(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => ffApi.deleteRecurringInvoice(id),
    onSuccess: () => { toast.success('Schedule deleted'); invalidate(); },
    onError: (e) => toast.error(apiError(e)),
  });
  const runNow = useMutation({
    mutationFn: (id: string) => ffApi.runRecurringInvoiceNow(id),
    onSuccess: (r) => {
      toast.success(`Invoice ${r.invoice.invoiceNo} raised — ${formatINR(paiseToInr(r.invoice.totalPaise), { decimals: true })}`);
      invalidate();
      qc.invalidateQueries({ queryKey: ['invoices'] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  // ── Validation (client-side mirror; server is authoritative) ────────────
  const body = useMemo(() => bodyFromDraft(draft), [draft]);
  const problems: string[] = [];
  if (!body.name) problems.push('Give the schedule a name');
  if (!body.customerId) problems.push('Pick a customer');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.startDate)) problems.push('Start date is required');
  if (body.endDate && body.endDate < body.startDate) problems.push('End date must be after the start date');
  if (body.items.length === 0) problems.push('Add at least one line item');
  if (body.items.some((it) => it.qty <= 0)) problems.push('Every line needs a quantity above 0');
  if (body.items.some((it) => it.unitPricePaise <= 0)) problems.push('Every line needs a unit price above ₹0');
  const draftTotalPaise = body.items.reduce((s, it) => s + lineTotalPaise(it.qty, it.unitPricePaise, it.gstPct), 0);

  const submit = () => {
    if (problems.length) { toast.error(problems[0]); return; }
    if (editing) update.mutate({ id: editing.id, patch: body });
    else create.mutate(body);
  };

  const setItem = (i: number, patch: Partial<ItemDraft>) =>
    setDraft((d) => ({ ...d, items: d.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) }));
  const addItem = () => setDraft((d) => ({ ...d, items: [...d.items, emptyItem()] }));
  const removeItem = (i: number) =>
    setDraft((d) => ({ ...d, items: d.items.length > 1 ? d.items.filter((_, j) => j !== i) : d.items }));

  const busy = create.isPending || update.isPending;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Repeat className="h-6 w-6 text-primary" /> Recurring invoices
          </h1>
          <p className="text-muted-foreground text-sm">
            NamastePOS raises a GST tax invoice for these customers on schedule. B2B details come from the customer record.
          </p>
        </div>
        <Button onClick={openCreate}><Plus className="h-4 w-4 mr-1" /> New schedule</Button>
      </div>

      {isError && (
        <Card className="border-destructive/40">
          <CardContent className="p-4 text-sm flex items-center justify-between gap-3">
            <span className="text-destructive">{apiError(error)}</span>
            <Button size="sm" variant="outline" onClick={() => refetch()}>Retry</Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Schedules</CardTitle>
          <CardDescription>
            {schedules.length === 0 && !isLoading
              ? 'No schedules yet. Create one for a customer you bill every week, month, quarter or year.'
              : `${schedules.length} schedule${schedules.length === 1 ? '' : 's'} · totals include GST`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="py-10 text-center text-sm text-muted-foreground">Loading…</div>
          ) : schedules.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              Nothing scheduled. <button className="underline" onClick={openCreate}>Create your first schedule</button>.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Frequency</TableHead>
                  <TableHead>Next run</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {schedules.map((s) => (
                  <TableRow key={s.id} className={s.isActive ? '' : 'opacity-60'}>
                    <TableCell>
                      <div className="font-medium">{s.name || '—'}</div>
                      <div className="text-xs text-muted-foreground">
                        {s.runCount > 0
                          ? `Raised ${s.runCount}× · last ${s.lastRunAt ? formatDate(s.lastRunAt) : '—'}`
                          : 'Not raised yet'}
                      </div>
                    </TableCell>
                    <TableCell>{s.customerName || <span className="text-muted-foreground">Customer</span>}</TableCell>
                    <TableCell className="capitalize">{s.frequency}</TableCell>
                    <TableCell>
                      {s.nextRunAt ? formatDate(s.nextRunAt) : '—'}
                      {s.endDate && <div className="text-xs text-muted-foreground">until {formatDate(s.endDate)}</div>}
                    </TableCell>
                    <TableCell className="text-right font-medium">{formatINR(paiseToInr(s.totalPaise), { decimals: true })}</TableCell>
                    <TableCell>
                      <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-primary"
                          checked={s.isActive}
                          disabled={update.isPending}
                          onChange={(e) => update.mutate({ id: s.id, patch: { isActive: e.target.checked } })}
                          aria-label={s.isActive ? 'Pause schedule' : 'Resume schedule'}
                        />
                        <Badge variant={s.isActive ? 'success' : 'secondary'}>{s.isActive ? 'Active' : 'Paused'}</Badge>
                      </label>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="outline" title="Raise this invoice now"
                          disabled={runNow.isPending} onClick={() => runNow.mutate(s.id)}>
                          <Play className="h-3.5 w-3.5 mr-1" /> Run now
                        </Button>
                        <Button size="sm" variant="ghost" title="Edit" onClick={() => openEdit(s)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" title="Delete" className="text-destructive"
                          disabled={remove.isPending}
                          onClick={() => {
                            if (window.confirm(`Delete "${s.name || 'this schedule'}"? Invoices already raised are kept.`)) remove.mutate(s.id);
                          }}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* ── Create / edit dialog ─────────────────────────────────────────── */}
      <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit schedule' : 'New recurring invoice'}</DialogTitle>
            <DialogDescription>
              Prices are in rupees, per unit, before GST. The invoice is raised automatically on each run date.
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <Label>Schedule name</Label>
              <Input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                placeholder="Monthly canteen supply — Acme Ltd" maxLength={120} />
            </div>
            <div>
              <Label>Customer</Label>
              <CustomerPicker
                value={draft.customerId}
                valueLabel={draft.customerName}
                onPick={(id, name) => setDraft((d) => ({ ...d, customerId: id, customerName: name }))}
              />
            </div>
            <div>
              <Label>Frequency</Label>
              <select
                className="mt-1 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={draft.frequency}
                onChange={(e) => setDraft((d) => ({ ...d, frequency: e.target.value as RecurringFrequency }))}
              >
                {FREQUENCIES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>{editing ? 'Next run' : 'Start date'}</Label>
                <DateInput value={draft.startDate} onChange={(iso) => setDraft((d) => ({ ...d, startDate: iso }))} />
              </div>
              <div>
                <Label>End date <span className="text-muted-foreground">(optional)</span></Label>
                <DateInput value={draft.endDate} onChange={(iso) => setDraft((d) => ({ ...d, endDate: iso }))} />
              </div>
            </div>
          </div>

          <div className="mt-2">
            <div className="flex items-center justify-between mb-1">
              <Label>Line items</Label>
              <Button size="sm" variant="outline" onClick={addItem}><Plus className="h-3.5 w-3.5 mr-1" /> Add line</Button>
            </div>
            <div className="rounded-md border overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs text-muted-foreground">
                  <tr>
                    <th className="text-left px-2 py-1.5 font-medium min-w-[160px]">Item</th>
                    <th className="text-left px-2 py-1.5 font-medium w-24">HSN/SAC</th>
                    <th className="text-left px-2 py-1.5 font-medium w-20">Qty</th>
                    <th className="text-left px-2 py-1.5 font-medium w-28">Unit price ₹</th>
                    <th className="text-left px-2 py-1.5 font-medium w-24">GST %</th>
                    <th className="text-right px-2 py-1.5 font-medium w-28">Line total</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody>
                  {draft.items.map((it, i) => {
                    const lt = lineTotalPaise(Number(it.qty) || 0, inrToPaise(it.unitPriceInr), Number(it.gstPct) || 0);
                    return (
                      <tr key={i} className="border-t">
                        <td className="px-2 py-1"><Input value={it.name} onChange={(e) => setItem(i, { name: e.target.value })} placeholder="Description" maxLength={200} /></td>
                        <td className="px-2 py-1"><Input value={it.hsn} onChange={(e) => setItem(i, { hsn: e.target.value })} placeholder="9963" maxLength={10} /></td>
                        <td className="px-2 py-1"><Input type="number" min={0} step="1" inputMode="numeric" value={it.qty} onChange={(e) => setItem(i, { qty: e.target.value })} /></td>
                        <td className="px-2 py-1"><Input type="number" min={0} step="0.01" inputMode="decimal" value={it.unitPriceInr} onChange={(e) => setItem(i, { unitPriceInr: e.target.value })} placeholder="0.00" /></td>
                        <td className="px-2 py-1">
                          <select
                            className="flex h-10 w-full rounded-md border border-input bg-background px-2 py-2 text-sm"
                            value={GST_SLABS.includes(Number(it.gstPct)) ? it.gstPct : 'custom'}
                            onChange={(e) => { if (e.target.value !== 'custom') setItem(i, { gstPct: e.target.value }); }}
                          >
                            {GST_SLABS.map((p) => <option key={p} value={String(p)}>{p}%</option>)}
                            {!GST_SLABS.includes(Number(it.gstPct)) && <option value="custom">{it.gstPct}%</option>}
                          </select>
                        </td>
                        <td className="px-2 py-1 text-right font-medium whitespace-nowrap">{formatINR(paiseToInr(lt), { decimals: true })}</td>
                        <td className="px-1 py-1">
                          <button type="button" className="text-muted-foreground hover:text-destructive" title="Remove line"
                            onClick={() => removeItem(i)} disabled={draft.items.length === 1}>
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t bg-muted/30">
                    <td colSpan={5} className="px-2 py-2 text-right text-sm font-medium">Invoice total (incl. GST)</td>
                    <td className="px-2 py-2 text-right font-bold whitespace-nowrap">{formatINR(paiseToInr(draftTotalPaise), { decimals: true })}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          <div>
            <Label>Notes <span className="text-muted-foreground">(printed on the invoice, optional)</span></Label>
            <textarea value={draft.notes} onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
              rows={2} maxLength={2000}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              placeholder="PO reference, delivery terms…" />
          </div>

          {problems.length > 0 && (
            <p className="text-xs text-muted-foreground">{problems[0]}</p>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={close} disabled={busy}>Cancel</Button>
            <Button onClick={submit} disabled={busy || problems.length > 0}>
              {busy ? 'Saving…' : editing ? 'Save changes' : 'Create schedule'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Customer picker ──────────────────────────────────────────────────────
// Searches the EXISTING customers API (GET /customers?search=) — recurring
// invoices are always for a saved customer because the B2B recipient block
// (name, GSTIN, address) is read from that row when the invoice is raised.
function CustomerPicker({ value, valueLabel, onPick }: {
  value: string; valueLabel: string; onPick: (id: string, name: string) => void;
}) {
  const [q, setQ] = useState('');
  const [openList, setOpenList] = useState(false);
  const dq = useDebounce(q, 250);
  const { data, isLoading } = useQuery({
    queryKey: ['recurring-customer-pick', dq],
    queryFn: () => ffApi.listCustomers({ search: dq || undefined, limit: 8, offset: 0 }),
    enabled: openList,
    retry: false,
  });
  const rows: CustomerPick[] = data?.customers || [];
  // Close the list when a value is chosen from outside (edit mode seeds it).
  useEffect(() => { if (value) setOpenList(false); }, [value]);

  if (value && !openList) {
    return (
      <div className="mt-1 flex h-10 items-center justify-between rounded-md border border-input bg-background px-3 text-sm">
        <span className="truncate">{valueLabel || 'Selected customer'}</span>
        <button type="button" className="text-xs underline text-muted-foreground" onClick={() => { setQ(''); setOpenList(true); }}>
          Change
        </button>
      </div>
    );
  }
  return (
    <div className="relative mt-1">
      <div className="relative">
        <Search className="absolute left-2 top-3 h-4 w-4 text-muted-foreground" />
        <Input
          className="pl-8"
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpenList(true); }}
          onFocus={() => setOpenList(true)}
          placeholder="Search customers by name or phone"
          autoComplete="off"
        />
      </div>
      {openList && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-md max-h-56 overflow-auto text-sm">
          {isLoading && <div className="px-3 py-2 text-muted-foreground">Searching…</div>}
          {!isLoading && rows.length === 0 && (
            <div className="px-3 py-2 text-muted-foreground">
              No customers match. Add them under Customers first.
            </div>
          )}
          {rows.map((c) => (
            <button
              key={c.id}
              type="button"
              className="w-full text-left px-3 py-2 hover:bg-muted"
              onClick={() => { onPick(c.id, c.name || c.phone || 'Customer'); setOpenList(false); }}
            >
              <div className="font-medium">{c.name || c.phone}</div>
              <div className="text-xs text-muted-foreground">
                {c.phone}{c.gstin ? ` · GSTIN ${c.gstin}` : ''}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
