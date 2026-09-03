import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowLeft, Pause, Play, UserCheck, Calendar, ArrowUpRight, Pin, Trash2, FileText,
  Upload, Download,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { adminApi } from '@/api/admin';
import { apiError } from '@/api/client';
import { formatINR, formatDate, formatDateTime } from '@/lib/utils';
// FF-402 — reuse the visual chips from the CRM page so the tenant
// list, drilldown, and CRM tab all render lifecycle/health consistently.
import { HealthPill, LifecycleBadge } from './CrmPage';

// FF-402 — 'crm' tab groups the activity feed + tenant tasks + health.
const TABS = ['overview', 'crm', 'addons', 'menu', 'orders', 'staff', 'invoices', 'notes', 'audit'] as const;
type Tab = typeof TABS[number];

// Push 20c — CSV writer shared by orders/invoices/payments export buttons.
// Quotes fields that contain commas/quotes/newlines and doubles internal
// quotes per RFC-4180. Triggers a client-side download.
function downloadCsv(filename: string, headers: string[], rows: any[][]) {
  const esc = (v: any) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  a.click(); URL.revokeObjectURL(url);
}

export function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('overview');
  const [extending, setExtending] = useState(false);
  const [changingPlan, setChangingPlan] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['drilldown', id],
    queryFn: () => adminApi.drilldown(id!),
    enabled: !!id,
  });

  const suspend = useMutation({
    mutationFn: () => adminApi.suspend(id!),
    onSuccess: () => { toast.success('Suspended'); qc.invalidateQueries({ queryKey: ['drilldown', id] }); },
    onError: (e) => toast.error(apiError(e)),
  });
  const restore = useMutation({
    mutationFn: () => adminApi.restore(id!),
    onSuccess: () => { toast.success('Restored'); qc.invalidateQueries({ queryKey: ['drilldown', id] }); },
    onError: (e) => toast.error(apiError(e)),
  });
  // NP-126 (2026-09-03): the raw impersonation JWT no longer travels through
  // the `#imp=` URL hash (it landed in proxy logs / browser history on any
  // hiccup) and is NEVER written to the clipboard. We fetch a one-time
  // short-lived CODE instead and open `${dash}/#impc=<code>`; the dashboard's
  // bootstrapAuth exchanges it via POST /v1/auth/impersonation-exchange.
  // The tab is pre-opened SYNCHRONOUSLY in startImpersonation (window.open
  // after the await would be popup-blocked) and navigated on success.
  const impersonate = useMutation({
    mutationFn: async ({ w, dash }: { w: Window | null; dash: string }) => {
      const { code } = await adminApi.impersonationCode(id!);
      return { w, dash, code };
    },
    onSuccess: ({ w, dash, code }) => {
      const url = `${dash}/#impc=${encodeURIComponent(code)}`;
      if (w) {
        w.opener = null; // sever the reverse-tabnabbing handle before navigating
        w.location.href = url;
      } else {
        window.open(url, '_blank', 'noopener'); // popups hard-blocked — best effort
      }
      toast.success('Opening the tenant dashboard as this customer…');
    },
    onError: (e, { w }) => {
      try { w?.close(); } catch { /* already gone */ }
      toast.error(apiError(e));
    },
  });
  const startImpersonation = () => {
    const dash = (import.meta.env.VITE_DASHBOARD_URL as string | undefined)?.replace(/\/$/, '');
    if (!dash) {
      // No clipboard fallback by design — a copied code/token is a leak.
      toast.error('VITE_DASHBOARD_URL is not configured — set it to the tenant dashboard origin to enable impersonation.');
      return;
    }
    // Open the tab NOW, inside the click gesture, so it isn't popup-blocked.
    const w = window.open('', '_blank');
    impersonate.mutate({ w, dash });
  };

  if (isLoading || !data) return <div className="text-muted-foreground">Loading…</div>;

  // Defensive defaults — if the drilldown API ever returns a partial response
  // (e.g. one of its sub-queries fails server-side), we render an empty state
  // for that section instead of crashing the whole page on `.length` / `.map`.
  const {
    business: b,
    subscription: s,
    menu = [],
    orders = [],
    staff = [],
    invoices = [],
    payments = [],
    notes = [],
  } = data;

  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
        <ArrowLeft className="mr-2 h-4 w-4" /> Back to customers
      </Button>

      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{b.name}</h1>
          <p className="text-muted-foreground">{b.email} · {b.phone || 'no phone'}</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button variant="outline" onClick={() => setExtending(true)}>
            <Calendar className="mr-2 h-4 w-4" /> Extend trial
          </Button>
          <Button variant="outline" onClick={() => setChangingPlan(true)}>
            <ArrowUpRight className="mr-2 h-4 w-4" /> Change plan
          </Button>
          <Button variant="outline" onClick={startImpersonation} disabled={impersonate.isPending}>
            <UserCheck className="mr-2 h-4 w-4" /> Impersonate
          </Button>
          {s?.status === 'paused' ? (
            <Button variant="secondary" onClick={() => restore.mutate()} disabled={restore.isPending}>
              <Play className="mr-2 h-4 w-4" /> Restore
            </Button>
          ) : (
            <Button variant="destructive" onClick={() => suspend.mutate()} disabled={suspend.isPending}>
              <Pause className="mr-2 h-4 w-4" /> Suspend
            </Button>
          )}
        </div>
      </div>

      <div className="flex gap-1 border-b overflow-x-auto">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 capitalize transition-colors whitespace-nowrap ${
              tab === t ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}>
            {t} {t === 'menu' && `(${menu.length})`}
            {t === 'orders' && `(${orders.length})`}
            {t === 'staff' && `(${staff.length})`}
            {t === 'invoices' && `(${invoices.length})`}
            {t === 'notes' && `(${notes.length})`}
          </button>
        ))}
      </div>

      {tab === 'overview' && <OverviewTab business={b} subscription={s} payments={payments} />}
      {tab === 'crm' && <CrmTab businessId={id!} business={b} />}
      {tab === 'addons' && <AddonsTab businessId={id!} />}
      {tab === 'menu' && <MenuTab menu={menu} businessId={id!} />}
      {tab === 'orders' && <OrdersTab orders={orders} />}
      {tab === 'staff' && <StaffTab staff={staff} />}
      {tab === 'invoices' && <InvoicesTab invoices={invoices} businessId={id!} />}
      {tab === 'notes' && <NotesTab notes={notes} businessId={id!} />}
      {tab === 'audit' && <AuditTab businessId={id!} />}

      <ExtendTrialDialog open={extending} onClose={() => setExtending(false)} businessId={id!} />
      <ChangePlanDialog open={changingPlan} onClose={() => setChangingPlan(false)} businessId={id!}
                        current={s?.tier} />
    </div>
  );
}

// ── FF-402 CRM tab — activity feed + tasks + health ─────────────────
function CrmTab({ businessId, business }: { businessId: string; business: any }) {
  const qc = useQueryClient();
  const activitiesQ = useQuery({
    queryKey: ['crm-act', businessId],
    queryFn:  () => adminApi.crmActivities(businessId),
  });
  const tasksQ = useQuery({
    queryKey: ['crm-tasks-tenant', businessId],
    queryFn:  () => adminApi.crmListTasks({ businessId, openOnly: false }),
  });

  const recompute = useMutation({
    mutationFn: () => adminApi.crmRecomputeHealth(businessId),
    onSuccess: (h) => {
      toast.success(`Health ${h.score} · ${h.stage}`);
      qc.invalidateQueries({ queryKey: ['drilldown', businessId] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const [note, setNote] = useState({ title: '', body: '', kind: 'note' });
  const addAct = useMutation({
    mutationFn: () => adminApi.crmAddActivity(businessId, note),
    onSuccess: () => {
      setNote({ title: '', body: '', kind: 'note' });
      qc.invalidateQueries({ queryKey: ['crm-act', businessId] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const [task, setTask] = useState({ title: '', notes: '', ownerEmail: '', dueAt: '' });
  const addTask = useMutation({
    mutationFn: () => adminApi.crmCreateTask({
      businessId, title: task.title, notes: task.notes || undefined,
      ownerEmail: task.ownerEmail || undefined,
      dueAt: task.dueAt ? new Date(task.dueAt).toISOString() : undefined,
    }),
    onSuccess: () => {
      setTask({ title: '', notes: '', ownerEmail: '', dueAt: '' });
      qc.invalidateQueries({ queryKey: ['crm-tasks-tenant', businessId] });
      qc.invalidateQueries({ queryKey: ['crm-act', businessId] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const completeT = useMutation({
    mutationFn: (id: string) => adminApi.crmCompleteTask(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['crm-tasks-tenant', businessId] });
      qc.invalidateQueries({ queryKey: ['crm-act', businessId] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Left: Health + lifecycle */}
      <Card className="lg:col-span-1">
        <CardHeader>
          <CardTitle>Health</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Stage</span>
            <span className="font-medium">{business.lifecycle_stage || '—'}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Score</span>
            <span className="font-mono font-bold text-lg">
              <HealthPill score={business.health_score ?? null} />
            </span>
          </div>
          {business.lifecycle_stage && (
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Lifecycle</span>
              <LifecycleBadge stage={business.lifecycle_stage} />
            </div>
          )}
          <div className="text-xs text-muted-foreground">
            Recomputes nightly. Last: {business.health_computed_at ? formatDateTime(business.health_computed_at) : 'never'}.
          </div>
          <Button size="sm" variant="outline" className="w-full"
            onClick={() => recompute.mutate()} disabled={recompute.isPending}>
            Recompute now
          </Button>
        </CardContent>
      </Card>

      {/* Middle: Tasks */}
      <Card className="lg:col-span-1">
        <CardHeader><CardTitle>Follow-ups ({(tasksQ.data || []).filter((t: any) => !t.doneAt).length} open)</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            <Input placeholder="Task title" value={task.title}
              onChange={(e) => setTask({ ...task, title: e.target.value })} />
            <div className="grid grid-cols-2 gap-2">
              <Input type="email" placeholder="Owner email" value={task.ownerEmail}
                onChange={(e) => setTask({ ...task, ownerEmail: e.target.value })} />
              <Input type="datetime-local" value={task.dueAt}
                onChange={(e) => setTask({ ...task, dueAt: e.target.value })} />
            </div>
            <Button size="sm" className="w-full" onClick={() => addTask.mutate()}
              disabled={!task.title || addTask.isPending}>Add task</Button>
          </div>
          <ul className="divide-y">
            {(tasksQ.data || []).map((t: any) => (
              <li key={t.id} className="py-2 flex items-start gap-2">
                <button onClick={() => !t.doneAt && completeT.mutate(t.id)}
                  className={`mt-0.5 ${t.doneAt ? 'text-emerald-600' : 'text-muted-foreground hover:text-emerald-600'}`}>
                  <span className="inline-block w-4 h-4 border rounded">
                    {t.doneAt && '✓'}
                  </span>
                </button>
                <div className="flex-1 min-w-0">
                  <div className={`text-sm ${t.doneAt ? 'line-through text-muted-foreground' : ''}`}>{t.title}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {t.ownerEmail || 'unassigned'}
                    {t.dueAt && ` · due ${new Date(t.dueAt).toLocaleDateString()}`}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* Right: Activity feed */}
      <Card className="lg:col-span-1">
        <CardHeader><CardTitle>Activity</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            <Input placeholder="Quick note title" value={note.title}
              onChange={(e) => setNote({ ...note, title: e.target.value })} />
            <textarea placeholder="Body (optional)" value={note.body}
              onChange={(e) => setNote({ ...note, body: e.target.value })}
              className="w-full h-16 rounded-md border border-input bg-background px-3 py-1.5 text-sm" />
            <div className="flex gap-2">
              <select value={note.kind} onChange={(e) => setNote({ ...note, kind: e.target.value })}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm flex-1">
                <option value="note">Note</option>
                <option value="call">Call</option>
                <option value="email">Email</option>
                <option value="wa_sent">WhatsApp</option>
              </select>
              <Button size="sm" onClick={() => addAct.mutate()}
                disabled={!note.title || addAct.isPending}>Log</Button>
            </div>
          </div>
          <ul className="divide-y max-h-96 overflow-y-auto">
            {(activitiesQ.data || []).map((a: any) => (
              <li key={a.id} className="py-2">
                <div className="flex items-center gap-2 text-xs">
                  <span className="uppercase text-[9px] px-1.5 py-0.5 rounded bg-muted">{a.kind}</span>
                  <span className="text-muted-foreground">
                    {formatDateTime(a.createdAt)}
                    {a.actorEmail && ` · ${a.actorEmail}`}
                  </span>
                </div>
                <div className="text-sm mt-0.5">{a.title}</div>
                {a.body && <div className="text-xs text-muted-foreground mt-0.5">{a.body}</div>}
              </li>
            ))}
            {activitiesQ.data?.length === 0 && (
              <li className="py-6 text-center text-sm text-muted-foreground">
                No activity yet.
              </li>
            )}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

function OverviewTab({ business, subscription, payments }: any) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Card>
        <CardHeader><CardTitle>Subscription</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <Row label="Plan" value={subscription?.plan_name || '—'} />
          <Row label="Status" value={<Badge>{subscription?.status}</Badge>} />
          {/* FF-402f — smarter labels. Once the sub is active the trial
              is already OVER, so calling the row "Trial ends" implies a
              future date that isn't. Also flag `current_period_end` when
              it's in the past on an active sub — that's the "manual plan
              set without rolling forward" bug we saw in support. */}
          <Row
            label={subscription?.status === 'trialing' ? 'Trial ends' : 'Trial ended'}
            value={subscription?.trial_ends_at ? formatDate(subscription.trial_ends_at) : '—'}
          />
          <Row
            label="Period ends"
            value={(() => {
              if (!subscription?.current_period_end) return '—';
              const end = new Date(subscription.current_period_end);
              const overdue = subscription.status === 'active' && end.getTime() < Date.now();
              const s = formatDate(subscription.current_period_end);
              return overdue ? `${s} ⚠ overdue` : s;
            })()}
          />
          <Row label="Cancel scheduled" value={subscription?.cancel_at_period_end ? 'Yes' : 'No'} />
          <Row label="Price" value={subscription?.price_inr_paise ? formatINR(subscription.price_inr_paise / 100) : 'Free'} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Business details</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <Row label="Phone" value={business.phone} />
          <Row label="City" value={business.city} />
          <Row label="Category" value={business.category} />
          <Row label="GSTIN" value={business.gstin} />
          <Row label="Address" value={business.address} />
          <Row label="UPI" value={business.upi_id} />
          <Row label="Onboarded" value={business.onboarded ? 'Yes' : 'No'} />
          {/* FF-402 — CRM lifecycle + health cached on businesses. */}
          <Row label="Lifecycle" value={business.lifecycle_stage || '—'} />
          <Row label="Health score" value={business.health_score ?? '—'} />
          {/* FF-252 — surface the tenant's chosen service style so support
              knows why a customer isn't getting "ready to collect" WA
              (dine-in mode suppresses it on purpose). */}
          <Row
            label="Service style"
            value={
              business.default_service_mode === 'dine_in'    ? 'Dine-in (waiter serves)' :
              business.default_service_mode === 'self_pickup' ? 'Self-pickup (guest collects)' :
              'Hybrid (per-table)'
            }
          />
          <Row label="Created" value={formatDate(business.created_at)} />
        </CardContent>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle>Recent payments</CardTitle>
          <Button
            size="sm"
            variant="outline"
            disabled={payments.length === 0}
            onClick={() =>
              downloadCsv(
                `payments-${new Date().toISOString().slice(0, 10)}.csv`,
                ['Date', 'Method', 'Status', 'Razorpay ID', 'Amount (INR)'],
                payments.map((p: any) => [
                  p.created_at, p.method || '', p.status,
                  p.razorpay_payment_id || '', (p.amount_paise / 100).toFixed(2),
                ])
              )
            }
          >
            <Download className="h-4 w-4 mr-2" /> Export CSV
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Date</TableHead><TableHead>Method</TableHead><TableHead>Status</TableHead>
              <TableHead>Razorpay ID</TableHead><TableHead className="text-right">Amount</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {payments.length === 0 && <TableRow><TableCell colSpan={5} className="text-center py-6 text-muted-foreground">No payments yet</TableCell></TableRow>}
              {payments.map((p: any) => (
                <TableRow key={p.id}>
                  <TableCell>{formatDateTime(p.created_at)}</TableCell>
                  <TableCell className="capitalize">{p.method || '—'}</TableCell>
                  <TableCell><Badge variant={p.status === 'captured' ? 'success' : 'destructive'}>{p.status}</Badge></TableCell>
                  <TableCell className="text-xs font-mono">{p.razorpay_payment_id || '—'}</TableCell>
                  <TableCell className="text-right font-medium">{formatINR(p.amount_paise / 100, { decimals: true })}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function AddonsTab({ businessId }: { businessId: string }) {
  const qc = useQueryClient();
  const { data: addons = [] } = useQuery({
    queryKey: ['customer-addons', businessId],
    queryFn: () => adminApi.customerAddons(businessId),
  });
  // Push 19b — full addon catalog so super-admin can attach any addon
  // that isn't already active on the customer.
  const { data: catalog = [] } = useQuery({
    queryKey: ['addons-catalog'],
    queryFn: adminApi.listAddons,
    staleTime: 60_000,
  });

  const attach = useMutation({
    mutationFn: (slug: string) => adminApi.attachAddonToCustomer(businessId, slug),
    onSuccess: () => { toast.success('Addon attached'); qc.invalidateQueries({ queryKey: ['customer-addons', businessId] }); },
    onError: (e) => toast.error(apiError(e)),
  });
  const detach = useMutation({
    mutationFn: (slug: string) => adminApi.detachAddonFromCustomer(businessId, slug),
    onSuccess: () => { toast.success('Addon detached'); qc.invalidateQueries({ queryKey: ['customer-addons', businessId] }); },
    onError: (e) => toast.error(apiError(e)),
  });

  const activeSlugs = new Set(addons
    .filter((a: any) => ['active', 'trialing'].includes(a.status))
    .map((a: any) => a.addon?.slug));
  const available = catalog.filter((c: any) => c.isActive && !activeSlugs.has(c.slug));

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Attach add-on</CardTitle>
          <CardDescription>
            Auto-activates immediately (no Razorpay since Push 16g).
            Audit logged.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {available.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              Customer already has every available add-on attached.
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {available.map((c: any) => (
                <Button
                  key={c.slug}
                  size="sm"
                  variant="outline"
                  disabled={attach.isPending}
                  onClick={() => attach.mutate(c.slug)}
                >
                  + {c.name}
                </Button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {addons.length === 0 ? (
            <div className="py-10 text-center text-muted-foreground">
              No add-ons attached. Use the picker above to add one.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Addon</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Period ends</TableHead>
                  <TableHead>Cancellation</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {addons.map((a: any) => {
                  const isActive = ['active', 'trialing'].includes(a.status);
                  return (
                    <TableRow key={a.id}>
                      <TableCell className="font-medium">{a.addon?.name || a.addon?.slug || '—'}</TableCell>
                      <TableCell>
                        <Badge variant={a.status === 'active' ? 'success' : a.status === 'trialing' ? 'secondary' : 'muted'}>
                          {a.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">
                        {a.currentPeriodEnd ? formatDate(a.currentPeriodEnd) : '—'}
                      </TableCell>
                      <TableCell className="text-sm">
                        {a.cancelAtPeriodEnd ? 'Will cancel at period end' : 'Auto-renews'}
                      </TableCell>
                      <TableCell className="text-right">
                        {isActive && (
                          <Button
                            size="sm" variant="ghost"
                            className="text-destructive"
                            disabled={detach.isPending || !a.addon?.slug}
                            onClick={() => {
                              // Defensive: skip detach if the catalog row is
                              // missing — otherwise we'd POST to /addons/undefined/detach
                              // and toast a misleading "Detached" on a 404.
                              if (!a.addon?.slug) {
                                toast.error('Cannot detach: addon catalog entry is missing');
                                return;
                              }
                              if (confirm(`Detach ${a.addon?.name || a.addon?.slug}? Customer loses access immediately.`)) {
                                detach.mutate(a.addon.slug);
                              }
                            }}
                          >
                            Detach
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// Push 20b — bulk menu importer. Parses a CSV file client-side, posts the
// rows as JSON to the admin bulk-import endpoint, and surfaces per-row
// errors so the operator can fix and re-upload.
function MenuTab({ menu, businessId }: any) {
  const qc = useQueryClient();
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ inserted: number; skipped: number; errors: any[] } | null>(null);

  const handleFile = async (file: File) => {
    setImporting(true);
    setResult(null);
    try {
      const text = await file.text();
      const items = parseCsv(text);
      if (items.length === 0) {
        toast.error('CSV looks empty — need a header row + at least one data row');
        setImporting(false);
        return;
      }
      const r = await adminApi.bulkImportMenu(businessId, items);
      setResult(r);
      toast.success(`${r.inserted} imported · ${r.skipped} skipped`);
      // Bug fix: query key used by the page is `['drilldown', id]`, not
      // 'customer-detail'. Without this, the menu table never refreshes after
      // bulk import — operator imports 200 items, sees 0 until manual reload.
      qc.invalidateQueries({ queryKey: ['drilldown', businessId] });
    } catch (e) {
      toast.error(apiError(e));
    } finally {
      setImporting(false);
    }
  };

  const downloadTemplate = () => {
    const csv = [
      'name,price,category,description,sku,unit,stock,gst_pct,hsn_code,is_veg,is_active',
      'Masala Dosa,120,Food,Crispy dosa with potato filling,DOSA-001,piece,50,5,210690,true,true',
      'Cold Coffee,90,Beverage,,COFF-002,piece,100,5,,true,true',
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'menu-template.csv';
    a.click(); URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between space-y-0">
          <div>
            <CardTitle className="text-base">Bulk import from CSV</CardTitle>
            <CardDescription>
              Upload a CSV with columns: name, price, category, description, sku, unit,
              stock, gst_pct, hsn_code, is_veg, is_active. Name &amp; price are required.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={downloadTemplate}>
            <Download className="h-4 w-4 mr-2" /> Template
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="flex items-center gap-3">
            <input
              type="file"
              accept=".csv,text/csv"
              disabled={importing}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
                e.currentTarget.value = '';
              }}
            />
            <Button asChild variant="default" disabled={importing}>
              <span className="cursor-pointer">
                <Upload className="h-4 w-4 mr-2" />
                {importing ? 'Importing…' : 'Choose CSV file'}
              </span>
            </Button>
            <span className="text-xs text-muted-foreground">
              {importing ? 'Processing rows…' : 'Each row becomes one menu item.'}
            </span>
          </label>
          {result && (
            <div className="rounded-md border p-3 text-sm space-y-1">
              <div>
                <strong className="text-emerald-700">{result.inserted}</strong> inserted ·{' '}
                <strong className="text-amber-700">{result.skipped}</strong> skipped
              </div>
              {result.errors.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-destructive">
                    {result.errors.length} row{result.errors.length === 1 ? '' : 's'} had errors
                  </summary>
                  <ul className="mt-2 space-y-1 max-h-40 overflow-auto pl-4 list-disc">
                    {result.errors.slice(0, 50).map((e: any, i: number) => (
                      <li key={i}>
                        Row {e.row}{e.name ? ` (${e.name})` : ''}: {e.message}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card><CardContent className="p-0"><Table>
        <TableHeader><TableRow>
          <TableHead>Item</TableHead><TableHead>Category</TableHead>
          <TableHead className="text-right">Price</TableHead>
          <TableHead className="text-right">Stock</TableHead>
          <TableHead>Status</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {menu.length === 0 && <TableRow><TableCell colSpan={5} className="text-center py-6 text-muted-foreground">No menu items</TableCell></TableRow>}
          {menu.map((m: any) => (
            <TableRow key={m.id}>
              <TableCell className="font-medium">{m.name}</TableCell>
              <TableCell>{m.category}</TableCell>
              <TableCell className="text-right">{formatINR(parseFloat(m.price))}</TableCell>
              <TableCell className="text-right">{m.stock}</TableCell>
              <TableCell>{m.is_active ? <Badge variant="success">Active</Badge> : <Badge variant="muted">Hidden</Badge>}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table></CardContent></Card>
    </div>
  );
}

// Minimal RFC-4180-ish CSV parser: handles quoted fields, escaped quotes,
// and commas inside quotes. Returns array of objects keyed by the header row.
function parseCsv(text: string): any[] {
  // Normalise line endings up-front so Windows (\r\n) and old-Mac (\r) CSVs
  // produce the same row boundaries as Unix.
  text = text.replace(/\r\n?/g, '\n');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1)
    .filter((r) => r.some((c) => c && c.trim() !== ''))
    .map((r) => {
      const obj: any = {};
      header.forEach((h, idx) => { obj[h] = (r[idx] ?? '').trim(); });
      return obj;
    });
}

function OrdersTab({ orders }: any) {
  const exportOrders = () =>
    downloadCsv(
      `orders-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Order #', 'Date', 'Status', 'Source', 'Total (INR)'],
      orders.map((o: any) => [o.order_no, o.created_at, o.status, o.source, parseFloat(o.total)])
    );
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" variant="outline" disabled={orders.length === 0} onClick={exportOrders}>
          <Download className="h-4 w-4 mr-2" /> Export CSV
        </Button>
      </div>
      <Card><CardContent className="p-0"><Table>
        <TableHeader><TableRow>
          <TableHead>Order #</TableHead><TableHead>Date</TableHead>
          <TableHead>Status</TableHead><TableHead>Source</TableHead>
          <TableHead className="text-right">Total</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {orders.length === 0 && <TableRow><TableCell colSpan={5} className="text-center py-6 text-muted-foreground">No orders</TableCell></TableRow>}
          {orders.map((o: any) => (
            <TableRow key={o.id}>
              <TableCell className="font-medium">#{o.order_no}</TableCell>
              <TableCell>{formatDateTime(o.created_at)}</TableCell>
              <TableCell><Badge variant={o.status === 'collected' ? 'success' : o.status === 'cancelled' ? 'destructive' : 'warning'}>{o.status}</Badge></TableCell>
              <TableCell className="capitalize">{o.source}</TableCell>
              <TableCell className="text-right font-medium">{formatINR(parseFloat(o.total))}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table></CardContent></Card>
    </div>
  );
}

function StaffTab({ staff }: any) {
  return (
    <Card><CardContent className="p-0"><Table>
      <TableHeader><TableRow>
        <TableHead>Name</TableHead><TableHead>Email</TableHead>
        <TableHead>Role</TableHead><TableHead>Joined</TableHead>
      </TableRow></TableHeader>
      <TableBody>
        {staff.length === 0 && <TableRow><TableCell colSpan={4} className="text-center py-6 text-muted-foreground">No staff</TableCell></TableRow>}
        {staff.map((s: any) => (
          <TableRow key={s.userId}>
            <TableCell className="font-medium">{s.displayName || '—'}</TableCell>
            <TableCell>{s.email}</TableCell>
            <TableCell><Badge variant="muted" className="capitalize">{s.role.replace('_', ' ')}</Badge></TableCell>
            <TableCell>{formatDate(s.joinedAt)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table></CardContent></Card>
  );
}

function InvoicesTab({ invoices, businessId }: any) {
  // 2026-08-26 — we now generate our OWN GST-compliant invoice PDF on demand
  // (no dependence on Razorpay hosting one). Fetch it as an authenticated blob
  // and open it in a new tab.
  const openPdf = async (inv: any) => {
    // NP-133 follow-up: open the tab SYNCHRONOUSLY inside the click gesture —
    // an await before window.open gets popup-blocked and silently no-ops.
    const w = window.open('', '_blank');
    try {
      const blob = await adminApi.invoicePdf(businessId, inv.id);
      const url = URL.createObjectURL(blob);
      if (w) { w.location.href = url; } else { window.open(url, '_blank'); }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      w?.close();
      toast.error(apiError(e));
    }
  };
  // Push 20c — CSV export of the invoice ledger for the customer.
  const exportInvoices = () =>
    downloadCsv(
      `invoices-${new Date().toISOString().slice(0, 10)}.csv`,
      ['Number', 'Date', 'Period Start', 'Period End', 'Status', 'Amount (INR)'],
      invoices.map((i: any) => [
        i.number || i.id, i.created_at,
        i.period_start || '', i.period_end || '',
        i.status, (i.amount_paise / 100).toFixed(2),
      ])
    );
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" variant="outline" disabled={invoices.length === 0} onClick={exportInvoices}>
          <Download className="h-4 w-4 mr-2" /> Export CSV
        </Button>
      </div>
      <Card><CardContent className="p-0"><Table>
      <TableHeader><TableRow>
        <TableHead>Number</TableHead><TableHead>Date</TableHead>
        <TableHead>Period</TableHead>
        <TableHead>Status</TableHead>
        <TableHead className="text-right">Amount</TableHead>
        <TableHead></TableHead>
      </TableRow></TableHeader>
      <TableBody>
        {invoices.length === 0 && <TableRow><TableCell colSpan={6} className="text-center py-6 text-muted-foreground">No invoices</TableCell></TableRow>}
        {invoices.map((i: any) => (
          <TableRow key={i.id}>
            <TableCell className="font-mono text-xs">{i.number || i.id.slice(0, 8)}</TableCell>
            <TableCell>{formatDate(i.created_at)}</TableCell>
            <TableCell className="text-xs text-muted-foreground">
              {i.period_start && i.period_end
                ? `${formatDate(i.period_start)} → ${formatDate(i.period_end)}`
                : '—'}
            </TableCell>
            <TableCell><Badge variant={i.status === 'paid' ? 'success' : i.status === 'open' ? 'warning' : 'muted'}>{i.status}</Badge></TableCell>
            <TableCell className="text-right font-medium">{formatINR(i.amount_paise / 100, { decimals: true })}</TableCell>
            <TableCell className="text-right">
              <Button size="sm" variant="ghost" onClick={() => openPdf(i)}>
                <FileText className="h-4 w-4" />
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table></CardContent></Card>
    </div>
  );
}

function NotesTab({ notes, businessId }: any) {
  const qc = useQueryClient();
  const [body, setBody] = useState('');
  const [pinned, setPinned] = useState(false);
  const add = useMutation({
    mutationFn: () => adminApi.addNote(businessId, body, pinned),
    onSuccess: () => {
      toast.success('Note added');
      setBody(''); setPinned(false);
      qc.invalidateQueries({ queryKey: ['drilldown', businessId] });
    },
    onError: (e) => toast.error(apiError(e)),
  });
  const remove = useMutation({
    mutationFn: (noteId: string) => adminApi.deleteNote(businessId, noteId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['drilldown', businessId] }),
  });

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="pt-6 space-y-3">
          <Input placeholder="Add a note for the team…" value={body}
                 onChange={(e) => setBody(e.target.value)} />
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
              <Pin className="h-3 w-3" /> Pin to top
            </label>
            <Button size="sm" onClick={() => add.mutate()} disabled={!body || add.isPending}>
              Add note
            </Button>
          </div>
        </CardContent>
      </Card>
      {notes.map((n: any) => (
        <Card key={n.id} className={n.pinned ? 'border-primary' : ''}>
          <CardContent className="pt-4">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                {n.pinned && <Pin className="inline h-3 w-3 mr-1 text-primary" />}
                <span className="text-sm">{n.body}</span>
                <div className="text-xs text-muted-foreground mt-1">
                  {n.adminEmail} · {formatDateTime(n.createdAt)}
                </div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => remove.mutate(n.id)}>
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function Row({ label, value }: { label: string; value: any }) {
  return (
    <div className="flex border-b pb-2 last:border-0">
      <div className="w-32 text-muted-foreground">{label}</div>
      <div className="flex-1">{value ?? <span className="text-muted-foreground">—</span>}</div>
    </div>
  );
}

function ExtendTrialDialog({ open, onClose, businessId }: any) {
  const qc = useQueryClient();
  const [days, setDays] = useState(7);
  const m = useMutation({
    mutationFn: () => adminApi.extendTrial(businessId, days),
    onSuccess: () => { toast.success(`Trial extended by ${days} days`); qc.invalidateQueries({ queryKey: ['drilldown', businessId] }); onClose(); },
    onError: (e) => toast.error(apiError(e)),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Extend trial</DialogTitle></DialogHeader>
        <div>
          <Label>Additional days</Label>
          <Input type="number" value={days} onChange={(e) => setDays(+e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending}>Extend</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChangePlanDialog({ open, onClose, businessId, current }: any) {
  const qc = useQueryClient();
  // Push 19a — fetch live plan catalog instead of hardcoding Free/Basic/Pro.
  const { data: plans = [] } = useQuery({
    queryKey: ['plans-admin'],
    queryFn: adminApi.listPlans,
    staleTime: 60_000,
  });
  const [tier, setTier] = useState(current || '');
  // FF-402c — cadence chosen separately from the plan. Default to
  // yearly so support is nudged to the recommended pick; per-plan
  // yearly availability is checked from the plan row.
  const [cadence, setCadence] = useState<'monthly' | 'yearly'>('yearly');
  useEffect(() => {
    if (!tier && plans.length > 0) {
      const seed = current || [...plans].sort((a, b) => (a.priceInr || 0) - (b.priceInr || 0))[0]?.tier;
      if (seed) setTier(seed);
    }
  }, [plans, current, tier]);
  const selectedPlan = plans.find((p) => p.tier === tier);
  const yearlyOffered = !!(selectedPlan && selectedPlan.priceYearlyInr != null);
  useEffect(() => {
    // If admin picks a plan that doesn't offer yearly, force monthly.
    if (!yearlyOffered && cadence === 'yearly') setCadence('monthly');
  }, [yearlyOffered, cadence]);
  const m = useMutation({
    mutationFn: () => adminApi.setPlan(businessId, tier, yearlyOffered ? cadence : 'monthly'),
    onSuccess: () => { toast.success(`Plan set to ${tier} (${cadence})`); qc.invalidateQueries({ queryKey: ['drilldown', businessId] }); onClose(); },
    onError: (e) => toast.error(apiError(e)),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Change plan (manual)</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">
          Skips Razorpay billing. Use this for comps, manual upgrades, or fix-ups.
        </p>
        <div>
          <Label>Plan</Label>
          <select value={tier} onChange={(e) => setTier(e.target.value)}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
            {plans.length === 0 && <option value="">Loading…</option>}
            {/* FF-402c — ONE row per plan tier. Yearly vs monthly is now
                a separate cadence toggle below, not a duplicate plan row. */}
            {[...plans]
              .sort((a, b) => (a.priceInr || 0) - (b.priceInr || 0))
              .map((p) => (
                <option key={p.tier} value={p.tier}>
                  {p.name}
                  {p.priceInr ? ` — ${formatINR(p.priceInr)}/mo` : ' — free'}
                  {p.priceYearlyInr != null && p.priceInr > 0 ? ` · ${formatINR(p.priceYearlyInr)}/yr` : ''}
                  {p.tier === current ? '  (current)' : ''}
                </option>
              ))}
          </select>
        </div>
        {/* FF-402c — cadence toggle. Yearly disabled when the selected
            plan doesn't offer a yearly price. Yearly is pre-selected
            (recommended) whenever available. */}
        {selectedPlan && selectedPlan.priceInr > 0 && (
          <div className="mt-3">
            <Label>Billing cadence</Label>
            <div className="flex gap-2 mt-1">
              <button type="button" onClick={() => setCadence('monthly')}
                className={`flex-1 px-3 py-2 rounded border text-sm ${cadence === 'monthly' ? 'border-primary bg-primary/10 font-semibold' : 'border-input'}`}>
                Monthly — {formatINR(selectedPlan.priceInr)}
              </button>
              <button type="button" onClick={() => yearlyOffered && setCadence('yearly')}
                disabled={!yearlyOffered}
                className={`flex-1 px-3 py-2 rounded border text-sm relative ${cadence === 'yearly' ? 'border-primary bg-primary/10 font-semibold' : 'border-input'} ${!yearlyOffered ? 'opacity-40 cursor-not-allowed' : ''}`}>
                {/* Hardcode-audit fix (2026-08-24): no client-side ×10 pricing
                    rule — the backend plan record is the source of truth. */}
                Yearly — {selectedPlan.priceYearlyInr != null ? formatINR(selectedPlan.priceYearlyInr) : 'n/a'}
                {yearlyOffered && (
                  <span className="absolute -top-2 -right-2 text-[9px] uppercase tracking-wider bg-amber-500 text-white px-1.5 py-0.5 rounded font-bold">
                    Recommended
                  </span>
                )}
              </button>
            </div>
            {!yearlyOffered && (
              <p className="text-[11px] text-muted-foreground mt-1">
                This plan doesn't offer yearly. Edit the plan to add a yearly price.
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending || !tier}>Apply</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Tenant audit trail — owner/staff money mutations (refunds, plan changes …).
function AuditTab({ businessId }: { businessId: string }) {
  const { data: events = [], isLoading } = useQuery({
    queryKey: ['tenant-audit', businessId],
    queryFn: () => adminApi.tenantAudit(businessId),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Audit trail</CardTitle>
        <CardDescription>Owner/staff money actions on this tenant (refunds, plan changes, etc.).</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="p-6 text-muted-foreground text-sm">Loading…</div>
        ) : events.length === 0 ? (
          <div className="p-6 text-muted-foreground text-sm">No audited actions yet.</div>
        ) : (
          <div className="divide-y">
            {events.map((e: any) => (
              <div key={e.id} className="p-3 flex items-start justify-between gap-3 text-sm">
                <div className="min-w-0">
                  <div className="font-medium">
                    {e.module}: {e.action}
                    {e.entityId ? <span className="text-muted-foreground font-normal"> · {String(e.entityId).slice(0, 8)}</span> : null}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {e.actorName || e.actorEmail || 'unknown'}{e.ipAddress ? ` · ${e.ipAddress}` : ''}
                  </div>
                </div>
                <div className="text-xs text-muted-foreground whitespace-nowrap">{formatDateTime(e.createdAt)}</div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
