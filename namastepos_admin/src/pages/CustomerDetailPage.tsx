import { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowLeft, Pause, Play, UserCheck, Calendar, ArrowUpRight, Pin, Trash2, FileText,
  Upload, Download, ShieldAlert, RefreshCw,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTierKinds } from '@/hooks/useTierKinds';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  adminApi, FeatureOverride, FeatureCatalogEntry, CustomPlanLimits, Plan,
  OrderStats, OutletSibling, SupportOrder,
} from '@/api/admin';
import { apiError } from '@/api/client';
import { formatINR, formatDate, formatDateTime } from '@/lib/utils';
import { useCan } from '@/lib/rbac';
import { planOffersYearly, assignablePlans, subscriptionStatusVariant } from '@/lib/plans';
import { FeaturePicker, EnforcementChip } from '@/components/FeaturePicker';
import { useFeatureCatalog, groupCatalog } from '@/lib/featureCatalog';
// 2026-09-03 — reuse the usage card and the dunning timeline rather than
// duplicating them here; both are exported from their own pages.
import { CustomerUsageCard } from './UsagePage';
import { DunningTimeline } from './BillingOpsPage';
// FF-402 — reuse the visual chips from the CRM page so the tenant
// list, drilldown, and CRM tab all render lifecycle/health consistently.
import { HealthPill, LifecycleBadge } from './CrmPage';

// FF-402 — 'crm' tab groups the activity feed + tenant tasks + health.
// Plans-addons migration — 'plan & features' tab: per-customer custom plan
// editor + feature overrides.
// 2026-09-03 — three tabs added for the SaaS control plane:
//   'lifecycle' → account ownership/tags + every lifecycle action (cancel,
//                 owner email, MPIN reset, resend welcome, DPDP erasure)
//                 plus this tenant's dunning history.
//   'usage'     → consumption vs plan caps.
//   'messages'  → what the platform has emailed this tenant, and whether it
//                 actually landed.
// TENANT PRIVACY (2026-09-03): the 'orders' tab is gone. It used to list the
// restaurant's own bills, which NamastePOS staff have no business browsing.
// It is replaced by 'volume' — aggregates the server now returns as
// `orderStats`. Do not re-add an order table here; the API no longer sends
// order rows, and the redaction is enforced server-side either way (see the
// policy block in customerAdminService.drilldown).
const TABS = ['overview', 'crm', 'lifecycle', 'plan & features', 'addons', 'usage', 'menu', 'volume', 'staff', 'invoices', 'messages', 'notes', 'audit'] as const;
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
  // F-10 — mirror the route permissions (admin.routes.js) so a support/finance
  // admin is not shown a button that 403s. Backend stays authoritative.
  const { can } = useCan();

  const { data, isLoading, isError, error, refetch } = useQuery({
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

  // A 404/403/5xx used to fall through the `!data` guard and render "Loading…"
  // forever. Show the real reason with a retry instead.
  if (isError || (!isLoading && !data)) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Back
        </Button>
        <Card>
          <CardHeader>
            <CardTitle>Couldn't load this customer</CardTitle>
            <CardDescription>
              {isError ? apiError(error) : 'The customer drilldown returned no data.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" size="sm" onClick={() => refetch()}>Retry</Button>
          </CardContent>
        </Card>
      </div>
    );
  }
  if (isLoading || !data) return <div className="text-muted-foreground">Loading…</div>;

  // Defensive defaults — if the drilldown API ever returns a partial response
  // (e.g. one of its sub-queries fails server-side), we render an empty state
  // for that section instead of crashing the whole page on `.length` / `.map`.
  const {
    business: b,
    subscription: s,
    menu = [],
    // TENANT PRIVACY: `orderStats` replaced the removed `orders` array.
    orderStats = null,
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
          <h1 className="text-2xl font-bold tracking-tight">
            {b.name}
            {b.outlet?.label && (
              <span className="ml-2 text-base font-normal text-muted-foreground">
                · {b.outlet.label}
              </span>
            )}
          </h1>
          <p className="text-muted-foreground">{b.email} · {b.phone || 'no phone'}</p>
          <OutletBanner outlet={b.outlet} siblings={b.outletSiblings || []} />
        </div>
        <div className="flex gap-2 flex-wrap">
          {can('customers.write') && (
            <Button variant="outline" onClick={() => setExtending(true)}>
              <Calendar className="mr-2 h-4 w-4" /> Extend trial
            </Button>
          )}
          {can('plans.change') && (
            <Button variant="outline" onClick={() => setChangingPlan(true)}>
              <ArrowUpRight className="mr-2 h-4 w-4" /> Change plan
            </Button>
          )}
          {can('customers.impersonate') && (
            <Button variant="outline" onClick={startImpersonation} disabled={impersonate.isPending}>
              <UserCheck className="mr-2 h-4 w-4" /> Impersonate
            </Button>
          )}
          {/* 2026-09-06: `suspended` is a real subscriptions.status now (the
              mandate is cancelled at cycle end); it restores the same way. */}
          {can('customers.write') && (
            s?.status === 'paused' || s?.status === 'suspended' ? (
              <Button variant="secondary" onClick={() => restore.mutate()} disabled={restore.isPending}>
                <Play className="mr-2 h-4 w-4" /> Restore
              </Button>
            ) : (
              <Button variant="destructive" onClick={() => suspend.mutate()} disabled={suspend.isPending}>
                <Pause className="mr-2 h-4 w-4" /> Suspend
              </Button>
            )
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
            {t === 'staff' && `(${staff.length})`}
            {t === 'invoices' && `(${invoices.length})`}
            {t === 'notes' && `(${notes.length})`}
          </button>
        ))}
      </div>

      {tab === 'overview' && <OverviewTab business={b} subscription={s} payments={payments} />}
      {tab === 'crm' && <CrmTab businessId={id!} business={b} />}
      {tab === 'lifecycle' && <LifecycleTab businessId={id!} business={b} subscription={s} />}
      {tab === 'plan & features' && <PlanFeaturesTab businessId={id!} />}
      {tab === 'addons' && <AddonsTab businessId={id!} />}
      {tab === 'usage' && <CustomerUsageCard businessId={id!} />}
      {tab === 'menu' && <MenuTab menu={menu} businessId={id!} />}
      {tab === 'volume' && <VolumeTab stats={orderStats} businessId={id!} />}
      {tab === 'staff' && <StaffTab staff={staff} />}
      {tab === 'invoices' && <InvoicesTab invoices={invoices} businessId={id!} />}
      {tab === 'messages' && <MessagesTab businessId={id!} />}
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
        <CardHeader><CardTitle>
          Follow-ups ({tasksQ.isError ? '—' : `${(tasksQ.data || []).filter((t: any) => !t.doneAt).length} open`})
        </CardTitle></CardHeader>
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
            {activitiesQ.isError && (
              <li className="py-6 text-center">
                <div className="text-sm text-destructive">Couldn't load the activity feed — {apiError(activitiesQ.error)}</div>
                <Button variant="outline" size="sm" className="mt-2" onClick={() => activitiesQ.refetch()}>Retry</Button>
              </li>
            )}
            {!activitiesQ.isError && activitiesQ.data?.length === 0 && (
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
          <Row label="Status" value={
            <Badge variant={subscriptionStatusVariant(subscription?.status)}>{subscription?.status || '—'}</Badge>
          } />
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
  const { can } = useCan();
  const canWrite = can('customers.write'); // attach/detach are customers.write
  const { data: addons = [], isError: addonsErr, error: addonsErrObj, refetch: refetchAddons } = useQuery({
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
    onSuccess: () => {
      toast.success('Addon attached');
      qc.invalidateQueries({ queryKey: ['customer-addons', businessId] });
      qc.invalidateQueries({ queryKey: ['effective-features', businessId] });
    },
    onError: (e) => toast.error(apiError(e)),
  });
  const detach = useMutation({
    mutationFn: (slug: string) => adminApi.detachAddonFromCustomer(businessId, slug),
    onSuccess: () => {
      toast.success('Addon detached');
      qc.invalidateQueries({ queryKey: ['customer-addons', businessId] });
      qc.invalidateQueries({ queryKey: ['effective-features', businessId] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const activeSlugs = new Set(addons
    .filter((a: any) => ['active', 'trialing'].includes(a.status))
    .map((a: any) => a.addon?.slug));
  const available = catalog.filter((c: any) => c.isActive && !activeSlugs.has(c.slug));

  return (
    <div className="space-y-4">
      {canWrite && <Card>
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
      </Card>}

      <Card>
        <CardContent className="p-0">
          {addonsErr ? (
            // Billing-relevant: "no add-ons attached" must not mask a read failure.
            <div className="py-10 text-center">
              <div className="text-sm text-destructive">Couldn't load this customer's add-ons — {apiError(addonsErrObj)}</div>
              <Button variant="outline" size="sm" className="mt-2" onClick={() => refetchAddons()}>Retry</Button>
            </div>
          ) : addons.length === 0 ? (
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
                        {isActive && canWrite && (
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

// ── Plans-addons migration — per-customer custom plan + feature overrides ──
// F-06 (2026-09-06): `businesses` (outlets) added. It was missing, so a
// STANDALONE custom plan sent no outlet cap and `enforceLimit` treated the
// undefined key as unlimited outlets.
const CUSTOM_PLAN_LIMIT_KEYS: (keyof CustomPlanLimits)[] =
  ['staff', 'tables', 'floors', 'menu_items', 'monthly_orders', 'businesses'];
// 2026-09-04 — the tier-kind ladder is served by the backend (single source
// of truth: namastepos_backend/src/services/planTiers.js). This page used to
// declare `['starter','pro','enterprise']`, which had drifted from the live
// five-kind ladder — so a STANDALONE custom plan (no base plan) could not be
// created at Pro or Advanced level: the select had no option for either, and
// the backend's Joi schema rejected both. Do NOT re-add a local list.

function PlanFeaturesTab({ businessId }: { businessId: string }) {
  // F-04 — one registry catalog for every picker on this tab (and the addon
  // editor). Labels, sections, enforcement chips and the ungated warning are
  // all the backend registry's, rendered by the shared <FeaturePicker>.
  const { catalog, groups } = useFeatureCatalog();
  return (
    <div className="space-y-6">
      <EffectiveFeaturesCard businessId={businessId} />
      <CustomPlanCard businessId={businessId} catalog={catalog} groups={groups} />
      <FeatureOverridesCard businessId={businessId} catalog={catalog} groups={groups} />
    </div>
  );
}

// F-03 (2026-09-06) — what the tenant ACTUALLY has right now. Before this the
// founder had to impersonate to answer "does this restaurant have loyalty?":
// the overrides card listed overrides, the custom-plan card its extras, the
// addons tab its activations — nothing showed plan ∪ addons ∪ overrides.
// Source: GET /admin/customers/:id/effective-features (CONTRACTS_round2 §5).
function SourceChip({ source }: { source: string }) {
  const cls = source === 'plan' ? 'bg-slate-100 text-slate-700 border-slate-200'
    : source.startsWith('addon:') ? 'bg-sky-50 text-sky-700 border-sky-200'
    : source === 'override:enable' ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
    : 'bg-red-50 text-red-700 border-red-200';
  const text = source === 'plan' ? 'plan'
    : source.startsWith('addon:') ? `addon · ${source.slice('addon:'.length)}`
    : source === 'override:enable' ? 'override'
    : source === 'override:disable' ? 'disabled by override'
    : source;
  return (
    <span className={`inline-block rounded border px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide ${cls}`}>
      {text}
    </span>
  );
}

function EffectiveFeaturesCard({ businessId }: { businessId: string }) {
  const q = useQuery({
    queryKey: ['effective-features', businessId],
    queryFn: () => adminApi.effectiveFeatures(businessId),
  });
  const { catalog } = useFeatureCatalog();
  const enforcementOf = useMemo(
    () => new Map(catalog.map((c) => [c.key, c.enforcement])), [catalog]);
  const data = q.data;
  const sections = useMemo(() => {
    if (!data) return [];
    // Group in registry order; the endpoint sends `group` per key, so reuse the
    // picker's grouping to keep the section names identical to the editors.
    const order = [...new Set(catalog.map((c) => c.group))];
    return groupCatalog(data.features, order);
  }, [data, catalog]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Effective features</CardTitle>
          <CardDescription>
            What this tenant can use RIGHT NOW — plan ∪ add-on grants ∪ enable-overrides, minus
            disable-overrides. Each chip says where the key comes from.
          </CardDescription>
        </div>
        <Button size="sm" variant="ghost" onClick={() => q.refetch()} disabled={q.isFetching} title="Refresh">
          <RefreshCw className={`h-4 w-4 ${q.isFetching ? 'animate-spin' : ''}`} />
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {q.isLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : q.isError ? (
          // Billing-relevant: never render "no features" over a read failure.
          <div>
            <div className="text-sm text-destructive">Couldn't load effective features — {apiError(q.error)}</div>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => q.refetch()}>Retry</Button>
          </div>
        ) : data ? (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">Plan</span>
              <span className="font-medium">{data.plan?.name ?? 'none'}</span>
              {data.plan && (
                <span className="text-xs text-muted-foreground font-mono">
                  db tier: {data.plan.code}{data.plan.tierKind ? ` · kind: ${data.plan.tierKind}` : ''}
                </span>
              )}
              <span className="text-xs text-muted-foreground">
                · plan version <span className="font-mono">{String(data.planVersion ?? '—')}</span>
              </span>
              <span className="text-xs text-muted-foreground">
                · {data.features.length} feature{data.features.length === 1 ? '' : 's'} on
                {data.disabled.length > 0 ? ` · ${data.disabled.length} disabled` : ''}
              </span>
            </div>
            {data.features.length === 0 && (
              <div className="text-sm text-muted-foreground">No gated features are enabled for this tenant.</div>
            )}
            {sections.map(([groupName, feats]) => (
              <div key={groupName}>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                  {groupName}
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-1">
                  {feats.map((f) => (
                    <div key={f.key} className="flex items-center gap-2 px-2 py-1 rounded text-sm">
                      <span className="flex-1 min-w-0">
                        <span className="block truncate">{f.label || f.key}</span>
                        <span className="block font-mono text-[11px] text-muted-foreground truncate">{f.key}</span>
                      </span>
                      <span className="flex flex-wrap gap-1 justify-end">
                        {f.sources.map((src) => <SourceChip key={src} source={src} />)}
                        <EnforcementChip enforcement={enforcementOf.get(f.key)} />
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {data.disabled.length > 0 && (
              <div className="border-t pt-3">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-red-700 mb-1">
                  Disabled by override
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-1">
                  {data.disabled.map((f) => (
                    <div key={f.key} className="flex items-center gap-2 px-2 py-1 rounded text-sm opacity-80">
                      <span className="flex-1 min-w-0">
                        <span className="block truncate line-through">{f.label || f.key}</span>
                        <span className="block font-mono text-[11px] text-muted-foreground truncate">{f.key}</span>
                      </span>
                      <SourceChip source={f.source} />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function CustomPlanCard({ businessId, catalog, groups }: {
  businessId: string; catalog: FeatureCatalogEntry[]; groups: string[];
}) {
  const qc = useQueryClient();
  const { can, isSuperAdmin } = useCan();
  const canChange = can('plans.change'); // PUT/DELETE custom-plan are plans.change
  const [showAllBases, setShowAllBases] = useState(false);
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['custom-plan', businessId],
    queryFn: () => adminApi.getCustomPlan(businessId),
  });
  const plan = data?.plan ?? null;

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  // Prices are edited in RUPEES; converted to paise on save.
  const [priceMonthly, setPriceMonthly] = useState('');
  const [priceYearly, setPriceYearly] = useState('');
  const tierKinds = useTierKinds();
  // Empty until the plan or the base plan supplies one; the select falls back
  // to the first PAID rung of the ladder rather than a hardcoded 'pro' (which
  // is Growth's KIND and Enterprise's CODE).
  const [tierKind, setTierKind] = useState<string>('');
  // Fall back to the first PAID rung of the ladder while nothing has supplied
  // a kind (a standalone custom plan must send one — the backend requires it).
  const effectiveTierKind = tierKind || tierKinds[1]?.kind || tierKinds[0]?.kind || '';
  const [limits, setLimits] = useState<Record<string, string>>(
    Object.fromEntries(CUSTOM_PLAN_LIMIT_KEYS.map((k) => [k, '-1'])));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // 2026-09-03 — a custom plan EXTENDS a public plan ("Growth + 2 extras").
  const [basePlanTier, setBasePlanTier] = useState<string>('');

  // Public plans available as a base (F-07: public + active + not another
  // tenant's private plan; super-admin may lift the filter).
  const { data: allPlans } = useQuery({
    queryKey: ['plans-admin'],
    queryFn: adminApi.listPlans,
    staleTime: 60_000,
  });
  const bases = assignablePlans(allPlans ?? [], showAllBases)
    .filter((p) => !String(p.tier).startsWith('custom-'));
  const base = bases.find((p) => p.tier === basePlanTier) || null;
  // F-06 — a STANDALONE custom plan with a missing limit gets the cheapest
  // public plan's value from the backend (customPlanService). Show those
  // defaults instead of "-1" so the admin sees what will actually apply.
  const cheapestPublic = useMemo(() => {
    const pub = assignablePlans(allPlans ?? []);
    return [...pub].sort((a, b) => (a.priceInrPaise || 0) - (b.priceInrPaise || 0))[0] ?? null;
  }, [allPlans]);
  const defaultLimitsFor = (from: Plan | null): Record<string, string> =>
    Object.fromEntries(CUSTOM_PLAN_LIMIT_KEYS.map((k) => [k, String(from?.limits?.[k] ?? -1)]));
  // Keys the base plan already grants — shown checked + locked.
  const inherited = new Set<string>(plan?.inheritedFeatureKeys ?? []);

  // Seed the form from the server copy ONCE per loaded plan identity. This used
  // to depend on `[data]` unconditionally, so any background invalidate (e.g.
  // the drilldown refetch triggered by another card) re-seeded mid-typing and
  // silently discarded the admin's unsaved edits.
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (!data?.plan) return;
    const p = data.plan;
    const identity = String((p as any).id ?? (p as any).tier ?? businessId);
    if (seededFor.current === identity) return;
    seededFor.current = identity;
    setName(p.name || '');
    setPriceMonthly(String((p.priceInrPaise ?? 0) / 100));
    setPriceYearly(p.priceYearlyPaise != null ? String(p.priceYearlyPaise / 100) : '');
    setTierKind(p.tierKind || '');
    setBasePlanTier(p.basePlanTier || '');
    setLimits(Object.fromEntries(
      CUSTOM_PLAN_LIMIT_KEYS.map((k) => [k, String(p.limits?.[k] ?? cheapestPublic?.limits?.[k] ?? -1)])));
    // FIX: the endpoint returns { plan } — extras live on the plan itself, so
    // `data.featureKeys` was always undefined and the picker rendered empty.
    setSelected(new Set(p.extraFeatureKeys ?? p.featureKeys ?? []));
    setEditing(true);
  }, [data, businessId, cheapestPublic]);

  // Picking a base pre-fills price/limits/tier from it (editable afterwards).
  // Picking "standalone" seeds the limits the backend would default to (F-06).
  const applyBase = (tier: string) => {
    setBasePlanTier(tier);
    const b = bases.find((p) => p.tier === tier);
    if (!b) { setLimits(defaultLimitsFor(cheapestPublic)); return; }
    if (!name.trim()) setName(`${b.name} + extras`);
    setPriceMonthly(String((b.priceInrPaise ?? 0) / 100));
    // F-02: only carry a yearly price over when the base actually offers one.
    setPriceYearly(planOffersYearly(b) && b.priceYearlyInrPaise != null ? String(b.priceYearlyInrPaise / 100) : '');
    if (b.tierKind) setTierKind(b.tierKind);
    setLimits(defaultLimitsFor(b));
  };
  // First-time "Create custom plan" (standalone) → show backend defaults.
  const startCreate = () => {
    setLimits(defaultLimitsFor(cheapestPublic));
    setEditing(true);
  };

  const buildBody = (assign: boolean) => ({
    name: name.trim(),
    basePlanTier: basePlanTier || null,
    priceInrPaise: Math.round(Number(priceMonthly || 0) * 100),
    priceYearlyPaise: priceYearly.trim() === '' ? null : Math.round(Number(priceYearly) * 100),
    limits: Object.fromEntries(
      CUSTOM_PLAN_LIMIT_KEYS.map((k) => [k, Number(limits[k] ?? -1)])) as unknown as CustomPlanLimits,
    // Only the EXTRAS travel — the backend unions them with the base plan's.
    extraFeatureKeys: Array.from(selected).filter((k) => !inherited.has(k)),
    tierKind: effectiveTierKind,
    assign,
  });
  const save = useMutation({
    // "Save" keeps the current assignment; "Save & assign" forces it on.
    mutationFn: (assign: boolean) => adminApi.saveCustomPlan(businessId, buildBody(assign)),
    onSuccess: (_r, assign) => {
      toast.success(assign ? 'Custom plan saved & assigned' : 'Custom plan saved');
      qc.invalidateQueries({ queryKey: ['custom-plan', businessId] });
      qc.invalidateQueries({ queryKey: ['drilldown', businessId] });
      qc.invalidateQueries({ queryKey: ['effective-features', businessId] });
    },
    onError: (e) => toast.error(apiError(e)),
  });
  const remove = useMutation({
    // force=true moves the customer back to the base plan (or free) first, so
    // removal is one click even while the custom plan is assigned.
    mutationFn: (force: boolean) => adminApi.deleteCustomPlan(businessId, force),
    onSuccess: () => {
      toast.success('Custom plan deleted');
      seededFor.current = null; // let a freshly created plan seed the form again
      setEditing(false);
      setName(''); setPriceMonthly(''); setPriceYearly('');
      setSelected(new Set());
      setLimits(Object.fromEntries(CUSTOM_PLAN_LIMIT_KEYS.map((k) => [k, '-1'])));
      qc.invalidateQueries({ queryKey: ['custom-plan', businessId] });
      qc.invalidateQueries({ queryKey: ['drilldown', businessId] });
    },
    onError: (e) => toast.error(apiError(e)), // 409 when assigned — backend guards too
  });

  const toggle = (k: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  };
  const busy = save.isPending || remove.isPending;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Custom plan</CardTitle>
          <CardDescription>
            A private plan for this customer only — its own price, limits and feature set.
            {plan?.assigned && <span className="ml-1 font-medium text-emerald-700">Currently assigned.</span>}
          </CardDescription>
        </div>
        {plan && canChange && (
          <Button size="sm" variant="outline" className="text-destructive border-destructive/40"
            disabled={busy}
            onClick={() => {
              // F-08 — name the destination plan, never its tier code.
              const fallbackPlan = (allPlans ?? []).find((p) => p.tier === plan.basePlanTier) ?? cheapestPublic;
              const fallback = fallbackPlan ? `${fallbackPlan.name}` : (plan.basePlanTier || 'the free plan');
              const msg = plan.assigned
                ? `Remove the custom plan "${plan.name}"?\n\nThis customer will be moved to ${fallback}.`
                : `Remove the custom plan "${plan.name}"?`;
              if (confirm(msg)) remove.mutate(!!plan.assigned);
            }}>
            <Trash2 className="h-4 w-4 mr-1" />
            {remove.isPending ? 'Removing…' : 'Remove custom plan'}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : isError ? (
          // Without this, a failed fetch rendered the "Create custom plan"
          // button — inviting the admin to overwrite a plan we never read.
          <div className="space-y-2">
            <div className="text-sm text-destructive">Couldn't load the custom plan — {apiError(error)}</div>
            <Button variant="outline" size="sm" onClick={() => refetch()}>Retry</Button>
          </div>
        ) : !plan && !editing ? (
          canChange ? (
            <Button variant="outline" onClick={startCreate}>
              Create custom plan
            </Button>
          ) : (
            <div className="text-sm text-muted-foreground">No custom plan. (Creating one needs the plans.change permission.)</div>
          )
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <Label>Name</Label>
                <Input value={name} placeholder="e.g. Sharma Dhaba Custom"
                  onChange={(e) => setName(e.target.value)} />
              </div>
              <div>
                <Label>Monthly price (₹)</Label>
                <Input type="number" min={0} value={priceMonthly}
                  onChange={(e) => setPriceMonthly(e.target.value)} />
              </div>
              <div>
                <Label>Yearly price (₹, optional)</Label>
                <Input type="number" min={0} value={priceYearly}
                  placeholder="10× monthly default"
                  onChange={(e) => setPriceYearly(e.target.value)} />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label>Base plan</Label>
                <select value={basePlanTier} onChange={(e) => applyBase(e.target.value)}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                  <option value="">None — standalone plan</option>
                  {/* A base the filter hides (inactive / private) stays visible so the
                      saved plan never renders blank. */}
                  {basePlanTier && !bases.some((p) => p.tier === basePlanTier) && (
                    <option value={basePlanTier}>{basePlanTier} (hidden by filter)</option>
                  )}
                  {bases.map((p) => (
                    <option key={p.tier} value={p.tier}>
                      {p.name} (₹{p.priceInr}/mo){p.isActive === false ? ' · inactive' : ''}{p.isPublic === false ? ' · private' : ''}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground mt-1">
                  {base
                    ? `Inherits everything in ${base.name} — tick only the EXTRA features below. Later changes to ${base.name} flow through automatically.`
                    : `Pick the plan the customer wanted (e.g. Growth), then add the extras they need.${cheapestPublic ? ` Standalone limits default to ${cheapestPublic.name}'s.` : ''}`}
                </p>
                {isSuperAdmin && (
                  <label className="text-[11px] text-muted-foreground flex items-center gap-1 mt-1 cursor-pointer">
                    <input type="checkbox" checked={showAllBases} onChange={(e) => setShowAllBases(e.target.checked)} />
                    Show all plans (inactive + private)
                  </label>
                )}
              </div>
              <div>
                <Label>Tier kind</Label>
                <select value={effectiveTierKind} onChange={(e) => setTierKind(e.target.value)}
                  className="h-10 w-full md:w-56 rounded-md border border-input bg-background px-3 text-sm">
                  {/* A kind the ladder does not contain would render blank —
                      exactly how the old hardcoded list hid Pro/Advanced.
                      Keep it visible and flagged instead. */}
                  {effectiveTierKind
                    && !tierKinds.some((t) => t.kind === effectiveTierKind) && (
                    <option value={effectiveTierKind}>
                      {effectiveTierKind} (not on the ladder)
                    </option>
                  )}
                  {tierKinds.map((t) => (
                    <option key={t.kind} value={t.kind}>{t.label} ({t.kind})</option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground mt-1">
                  Drives upgrade CTAs + addon eligibility. Inherited from the base plan.
                </p>
              </div>
            </div>
            <div>
              <div className="text-sm font-semibold mb-2">
                Limits <span className="text-xs font-normal text-muted-foreground">(-1 = unlimited)</span>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
                {CUSTOM_PLAN_LIMIT_KEYS.map((k) => (
                  <div key={k}>
                    <Label className="text-xs">{k === 'businesses' ? 'outlets (businesses)' : k.replace(/_/g, ' ')}</Label>
                    <Input type="number" value={limits[k] ?? '-1'}
                      onChange={(e) => setLimits((prev) => ({ ...prev, [k]: e.target.value }))} />
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="text-sm font-semibold mb-2">
                {base ? 'Extra features' : 'Features'}{' '}
                <span className="text-xs font-normal text-muted-foreground">
                  ({Array.from(selected).filter((k) => !inherited.has(k)).length} extra
                  {base ? ` · ${inherited.size} inherited from ${base.name}` : ''})
                </span>
              </div>
              <FeaturePicker
                catalog={catalog} groups={groups}
                selected={selected} onToggle={toggle}
                locked={inherited} lockedBadge="base"
                lockedTitle={() => `Granted by ${base?.name ?? 'the base plan'} — included automatically`}
                columns={3} maxHeightClass="max-h-72" />
            </div>
            {canChange && (
              <div className="flex gap-2 flex-wrap">
                <Button variant="outline" disabled={busy || !name.trim()}
                  onClick={() => save.mutate(plan?.assigned ?? false)}>
                  {save.isPending ? 'Saving…' : 'Save'}
                </Button>
                <Button disabled={busy || !name.trim()} onClick={() => save.mutate(true)}>
                  {save.isPending ? 'Saving…' : 'Save & assign to this customer'}
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function FeatureOverridesCard({ businessId, catalog, groups }: {
  businessId: string; catalog: FeatureCatalogEntry[]; groups: string[];
}) {
  const qc = useQueryClient();
  const { can } = useCan();
  const canWrite = can('customers.write'); // PUT/DELETE feature-overrides
  const { data: overrides = [], isLoading, isError, error, refetch } = useQuery({
    queryKey: ['feature-overrides', businessId],
    queryFn: () => adminApi.getFeatureOverrides(businessId),
  });
  const [addKey, setAddKey] = useState('');
  const [addMode, setAddMode] = useState<'enable' | 'disable'>('enable');

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['feature-overrides', businessId] });
    qc.invalidateQueries({ queryKey: ['effective-features', businessId] });
  };
  // PUT replaces the whole set — used to add rows / flip a row's mode.
  const saveSet = useMutation({
    mutationFn: (next: FeatureOverride[]) => adminApi.setFeatureOverrides(businessId, next),
    onSuccess: () => { toast.success('Overrides saved'); setAddKey(''); invalidate(); },
    onError: (e) => toast.error(apiError(e)),
  });
  const removeOne = useMutation({
    mutationFn: (featureKey: string) => adminApi.deleteFeatureOverride(businessId, featureKey),
    onSuccess: () => { toast.success('Override removed'); invalidate(); },
    onError: (e) => toast.error(apiError(e)),
  });

  const existing = useMemo(() => new Set(overrides.map((o) => o.featureKey)), [overrides]);
  const labelOf = useMemo(() => new Map(catalog.map((c) => [c.key, c])), [catalog]);
  const busy = saveSet.isPending || removeOne.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Feature overrides</CardTitle>
        <CardDescription>
          Overrides win over plan and addons; use sparingly.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : isError ? (
          // "No overrides" on a failed fetch would hide a live entitlement grant.
          <div>
            <div className="text-sm text-destructive">Couldn't load feature overrides — {apiError(error)}</div>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => refetch()}>Retry</Button>
          </div>
        ) : overrides.length === 0 ? (
          <div className="text-sm text-muted-foreground">No overrides on this customer.</div>
        ) : (
          <Table>
            <TableHeader><TableRow>
              <TableHead>Feature key</TableHead>
              <TableHead>Mode</TableHead>
              <TableHead></TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {overrides.map((o) => (
                <TableRow key={o.featureKey}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="min-w-0">
                        <span className="block text-sm truncate">{labelOf.get(o.featureKey)?.label ?? o.featureKey}</span>
                        <span className="block font-mono text-[11px] text-muted-foreground">{o.featureKey}</span>
                      </span>
                      <EnforcementChip enforcement={labelOf.get(o.featureKey)?.enforcement ?? 'unregistered'} />
                    </div>
                  </TableCell>
                  <TableCell>
                    <button type="button" disabled={busy || !canWrite}
                      title="Click to flip enable/disable"
                      onClick={() => saveSet.mutate(overrides.map((x) =>
                        x.featureKey === o.featureKey
                          ? { ...x, mode: x.mode === 'enable' ? 'disable' : 'enable' }
                          : x))}>
                      <Badge variant={o.mode === 'enable' ? 'success' : 'destructive'}>
                        {o.mode}
                      </Badge>
                    </button>
                  </TableCell>
                  <TableCell className="text-right">
                    {canWrite && (
                      <Button size="sm" variant="ghost" disabled={busy}
                        onClick={() => removeOne.mutate(o.featureKey)}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {canWrite && (
          <div className="space-y-3 border-t pt-4">
            <div>
              <Label className="text-xs">Feature</Label>
              {/* F-04 — the same grouped picker as the plan editor (radio mode), so
                  the ungated / unregistered warning and the `why` tooltip show
                  here too. Keys that already have an override are hidden. */}
              <FeaturePicker
                catalog={catalog} groups={groups}
                selected={addKey ? new Set([addKey]) : new Set()}
                onToggle={(k) => setAddKey(k)}
                exclude={existing} single columns={3} maxHeightClass="max-h-56" />
            </div>
            <div className="flex gap-2 items-end flex-wrap">
              <div>
                <Label className="text-xs">Mode</Label>
                <div className="flex gap-1">
                  {(['enable', 'disable'] as const).map((m) => (
                    <button key={m} type="button" onClick={() => setAddMode(m)}
                      className={`px-3 h-9 rounded border text-sm capitalize ${
                        addMode === m ? 'border-primary bg-primary/10 font-semibold' : 'border-input'}`}>
                      {m}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex-1 text-xs text-muted-foreground self-center">
                {addKey
                  ? <>Selected: <span className="font-mono">{addKey}</span>{labelOf.get(addKey)?.why ? ` — ${labelOf.get(addKey)!.why}` : ''}</>
                  : 'Pick a feature above.'}
              </div>
              <Button size="sm" disabled={!addKey || busy}
                onClick={() => saveSet.mutate([...overrides, { featureKey: addKey, mode: addMode }])}>
                {saveSet.isPending ? 'Saving…' : 'Add override'}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Push 20b — bulk menu importer. Parses a CSV file client-side, posts the
// rows as JSON to the admin bulk-import endpoint, and surfaces per-row
// errors so the operator can fix and re-upload.
function MenuTab({ menu, businessId }: any) {
  const qc = useQueryClient();
  const { can } = useCan();
  const canImport = can('customers.write'); // POST menu/bulk
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
      {canImport && <Card>
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
      </Card>}

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

// ── Outlet banner (2026-09-03) ──────────────────────────────────────────
// Every outlet is its own tenant row, so without this the operator has no way
// to tell an HQ from one of its branches. HQ → lists its outlets; outlet →
// links back to the HQ.
function OutletBanner({ outlet, siblings }: { outlet: any; siblings: OutletSibling[] }) {
  const navigate = useNavigate();
  if (!outlet) return null;

  // For an outlet, "siblings" means the other BRANCHES — the HQ is already
  // named in the sentence above, so listing it again reads as a duplicate.
  const branches = siblings.filter((sib) => !sib.isParent);

  const linkTo = (bid: string) => (
    <button type="button" className="underline font-medium hover:opacity-80"
            onClick={() => navigate(`/customers/${bid}`)}>
      {outlet.parentName || 'the HQ account'}
    </button>
  );

  return (
    <div className="mt-3 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
      {outlet.isParent ? (
        <>
          <div className="font-medium">
            HQ of {outlet.siblingCount} outlet{outlet.siblingCount === 1 ? '' : 's'}
            {outlet.groupName ? ` — ${outlet.groupName} group` : ''}
          </div>
          {siblings.length > 0 && (
            <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
              {siblings.map((sib) => (
                <li key={sib.id}>
                  <button type="button" className="underline hover:opacity-80"
                          onClick={() => navigate(`/customers/${sib.id}`)}>
                    {sib.label || sib.name}
                  </button>
                  {sib.city ? <span className="text-muted-foreground"> · {sib.city}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          <div>
            Part of{' '}
            {outlet.parentBusinessId
              ? linkTo(outlet.parentBusinessId)
              : <span className="font-medium">{outlet.groupName || 'an outlet group'}</span>}
            {' '}group — <span className="font-medium">this is an outlet</span>
            {outlet.label ? ` (${outlet.label})` : ''}.
          </div>
          {branches.length > 0 && (
            <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
              <li className="text-muted-foreground">Sibling outlets:</li>
              {branches.map((sib) => (
                <li key={sib.id}>
                  <button type="button" className="underline hover:opacity-80"
                          onClick={() => navigate(`/customers/${sib.id}`)}>
                    {sib.label || sib.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

// ── Volume tab (replaces the removed order ledger) ──────────────────────
//
// TENANT PRIVACY (2026-09-03, founder-driven): NamastePOS staff must not be
// able to browse a restaurant's own sales. The old table of the tenant's last
// 50 bills is gone — the server no longer returns order rows at all. What
// remains is what support and billing actually need: is this tenant using the
// product, how big are they, and when did they last transact.
//
// If you are here because a ticket needs ONE specific order, use the
// super-admin-only lookup below (GET /admin/customers/:id/order/:orderId).
// It masks the diner's name and phone and writes an audit row. Do not
// re-introduce a list or an export of tenant orders.
function VolumeTab({ stats, businessId }: { stats: OrderStats | null; businessId: string }) {
  if (!stats) {
    return (
      <Card><CardContent className="py-10 text-center text-muted-foreground">
        Order volume is unavailable for this customer.
      </CardContent></Card>
    );
  }
  const months = stats.revenueByMonth || [];
  const peak = months.reduce((m, x) => Math.max(m, x.revenueInr || 0), 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Orders (lifetime)" value={(stats.orderCount || 0).toLocaleString('en-IN')}
                  sub={`${(stats.cancelledCount || 0).toLocaleString('en-IN')} cancelled`} />
        <StatCard label="Gross volume" value={formatINR(stats.grossVolumeInr || 0)}
                  sub="Tenant's own sales — aggregate only" />
        <StatCard label="Average ticket" value={formatINR(stats.avgTicketInr || 0)} />
        <StatCard label="Last order"
                  value={stats.lastOrderAt ? formatDate(stats.lastOrderAt) : 'never'}
                  sub={stats.firstOrderAt ? `first ${formatDate(stats.firstOrderAt)}` : undefined} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Volume by month</CardTitle>
          <CardDescription>
            Last 12 months. Aggregates only — individual bills, line items and
            diner details are not available to platform staff by policy.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Month</TableHead>
              <TableHead className="text-right">Orders</TableHead>
              <TableHead className="text-right">Revenue</TableHead>
              <TableHead className="w-1/3"></TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {months.length === 0 && (
                <TableRow><TableCell colSpan={4} className="text-center py-6 text-muted-foreground">
                  No orders in the last 12 months
                </TableCell></TableRow>
              )}
              {months.map((m) => (
                <TableRow key={m.month}>
                  <TableCell className="font-medium">{m.month}</TableCell>
                  <TableCell className="text-right">{m.orders.toLocaleString('en-IN')}</TableCell>
                  <TableCell className="text-right font-medium">{formatINR(m.revenueInr)}</TableCell>
                  <TableCell>
                    <div className="h-2 rounded bg-primary/20">
                      <div className="h-2 rounded bg-primary"
                           style={{ width: peak > 0 ? `${Math.round((m.revenueInr / peak) * 100)}%` : '0%' }} />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <SupportOrderLookup businessId={businessId} />
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="text-2xl font-bold mt-1">{value}</div>
        {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
      </CardContent>
    </Card>
  );
}

// Single-order lookup for "my order vanished" tickets. Super-admin only —
// anyone else gets a 403 from the server, which we surface as-is rather than
// hiding the control (hiding it would suggest the data is merely unavailable
// in the UI, when it is actually forbidden). Diner name/phone arrive already
// masked; the request is written to the audit log server-side.
function SupportOrderLookup({ businessId }: { businessId: string }) {
  const [orderId, setOrderId] = useState('');
  const [reason, setReason] = useState('');
  const [order, setOrder] = useState<SupportOrder | null>(null);

  const lookup = useMutation({
    mutationFn: () => adminApi.customerOrder(businessId, orderId.trim(), reason.trim() || undefined),
    onSuccess: (o) => setOrder(o),
    onError: (e) => { setOrder(null); toast.error(apiError(e)); },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-amber-600" /> Single-order lookup
        </CardTitle>
        <CardDescription>
          Super-admin only. For a ticket that names one order. Diner name and
          phone are masked, and every lookup is recorded in the audit log.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="md:col-span-2">
            <Label className="text-xs">Order ID (UUID, from the ticket)</Label>
            <Input value={orderId} placeholder="e.g. 5f1c…" onChange={(e) => setOrderId(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">Reason / ticket ref</Label>
            <Input value={reason} placeholder="TKT-1234" onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>
        <Button size="sm" disabled={!orderId.trim() || lookup.isPending}
                onClick={() => lookup.mutate()}>
          {lookup.isPending ? 'Looking up…' : 'Look up order'}
        </Button>

        {order && (
          <div className="rounded-md border p-3 text-sm space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">#{order.orderNo}</span>
              <Badge variant={order.status === 'cancelled' ? 'destructive' : 'muted'}>
                {order.status}
              </Badge>
              <span className="capitalize text-muted-foreground">{order.source}</span>
              <span className="text-muted-foreground">{formatDateTime(order.createdAt)}</span>
            </div>
            <div className="text-xs text-muted-foreground">
              Diner: {order.diner?.initials || '—'} · {order.diner?.phoneLast4 || '—'} (masked)
            </div>
            <Table>
              <TableHeader><TableRow>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Price</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {order.items.length === 0 && (
                  <TableRow><TableCell colSpan={3} className="text-center py-4 text-muted-foreground">
                    No line items
                  </TableCell></TableRow>
                )}
                {order.items.map((it, i) => (
                  <TableRow key={`${it.name}-${i}`}>
                    <TableCell>{it.name}{it.note ? ` (${it.note})` : ''}</TableCell>
                    <TableCell className="text-right">{it.qty}</TableCell>
                    <TableCell className="text-right">
                      {it.price == null ? '—' : formatINR(it.price, { decimals: true })}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="flex justify-end gap-4 text-sm">
              <span className="text-muted-foreground">
                {order.paymentMethod ? `paid by ${order.paymentMethod}` : 'payment mode unknown'}
              </span>
              <span className="font-semibold">
                {order.total == null ? '—' : formatINR(order.total, { decimals: true })}
              </span>
            </div>
            <div className="text-[11px] text-muted-foreground">{order.privacyNotice}</div>
          </div>
        )}
      </CardContent>
    </Card>
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
  const { can } = useCan();
  const canWrite = can('notes.write'); // POST/DELETE notes
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
      {canWrite && <Card>
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
      </Card>}
      {notes.length === 0 && (
        <div className="text-sm text-muted-foreground">No notes yet.</div>
      )}
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
              {canWrite && (
                <Button size="sm" variant="ghost" onClick={() => remove.mutate(n.id)}>
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              )}
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
  const { isSuperAdmin } = useCan();
  const [showAll, setShowAll] = useState(false);
  // Push 19a — fetch live plan catalog instead of hardcoding Free/Basic/Pro.
  const { data: allPlans = [] } = useQuery({
    queryKey: ['plans-admin'],
    queryFn: adminApi.listPlans,
    staleTime: 60_000,
  });
  // F-07 — public + active + not another tenant's private plan. The customer's
  // CURRENT plan always stays listed (it may be their own custom plan).
  const plans = useMemo(() => {
    const base = assignablePlans(allPlans, showAll);
    const cur = allPlans.find((p) => p.tier === current);
    return cur && !base.some((p) => p.tier === cur.tier) ? [...base, cur] : base;
  }, [allPlans, showAll, current]);
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
  // F-02 — `offersYearly`, not the defaulted price, decides the cadence guard.
  const yearlyOffered = !!(selectedPlan && selectedPlan.priceInr > 0 && planOffersYearly(selectedPlan));
  useEffect(() => {
    // If admin picks a plan that doesn't offer yearly, force monthly.
    if (!yearlyOffered && cadence === 'yearly') setCadence('monthly');
  }, [yearlyOffered, cadence]);
  const m = useMutation({
    mutationFn: () => adminApi.setPlan(businessId, tier, yearlyOffered ? cadence : 'monthly'),
    // F-08 — say the plan NAME, not its tier code (code 'pro' is Enterprise).
    onSuccess: () => {
      toast.success(`Plan set to ${selectedPlan?.name ?? tier} (${yearlyOffered ? cadence : 'monthly'})`);
      qc.invalidateQueries({ queryKey: ['drilldown', businessId] });
      qc.invalidateQueries({ queryKey: ['effective-features', businessId] });
      onClose();
    },
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
                  {planOffersYearly(p) && p.priceYearlyInr != null && p.priceInr > 0 ? ` · ${formatINR(p.priceYearlyInr)}/yr` : ''}
                  {p.isActive === false ? ' · inactive' : ''}{p.isPublic === false || p.businessId ? ' · private' : ''}
                  {p.tier === current ? '  (current)' : ''}
                </option>
              ))}
          </select>
          {isSuperAdmin && (
            <label className="text-[11px] text-muted-foreground flex items-center gap-1 mt-1 cursor-pointer">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
              Show all plans (inactive + other tenants' custom plans)
            </label>
          )}
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
                Yearly — {yearlyOffered && selectedPlan.priceYearlyInr != null ? formatINR(selectedPlan.priceYearlyInr) : 'n/a'}
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
  const { data: events = [], isLoading, isError, error, refetch } = useQuery({
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
        ) : isError ? (
          <div className="p-6">
            <div className="text-sm text-destructive">Couldn't load the audit trail — {apiError(error)}</div>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => refetch()}>Retry</Button>
          </div>
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

// ── Lifecycle tab (2026-09-03) ─────────────────────────────────────────
//
// Everything that changes the STATE of the account rather than its data:
// who owns it internally, what segment it's in, and the six lifecycle
// actions. Suspend / restore / extend trial / change plan stay in the page
// header where they already were — this tab holds what had no home.
//
// Each destructive action states plainly what it does BEFORE it's clicked;
// the DPDP erasure additionally requires typing the tenant name, because an
// accidental click there is unrecoverable.
function LifecycleTab({ businessId, business, subscription }: {
  businessId: string; business: any; subscription: any;
}) {
  const qc = useQueryClient();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['drilldown', businessId] });
    qc.invalidateQueries({ queryKey: ['overview'] });
  };
  // F-10 — route permissions (admin.routes.js): account/owner-email/MPIN/
  // welcome are customers.write; cancel-subscription is revenue.write
  // (finance-grade); soft-delete is customers.write; anonymise is
  // settings.write (super_admin). Cards a role cannot act on are hidden.
  const { can, me } = useCan();
  const canCustomers = can('customers.write');
  const canRevenue = can('revenue.write');
  const canErase = can('settings.write');
  const noActions = !canCustomers && !canRevenue && !canErase;

  return (
    <div className="space-y-4">
      {noActions && (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">
            Your role ({me?.role ?? '—'}) has read-only access here — lifecycle actions need
            customers.write, revenue.write or settings.write.
          </CardContent>
        </Card>
      )}
      {canCustomers && (
        <AccountOwnershipCard businessId={businessId} business={business} onSaved={refresh} />
      )}

      {canCustomers && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Owner access</CardTitle>
            <CardDescription>
              Login identity and device credentials for this tenant's owner.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <OwnerEmailRow businessId={businessId} current={business.email} onSaved={refresh} />
            <ResetCredentialsRow businessId={businessId} />
            <ResendWelcomeRow businessId={businessId} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Subscription</CardTitle>
          <CardDescription>
            Current status: <strong>{subscription?.status || 'none'}</strong>
            {subscription?.cancel_at_period_end ? ' · cancels at period end' : ''}
            {subscription?.status === 'suspended' && subscription?.suspended_at
              ? ` · suspended ${formatDate(subscription.suspended_at)}` : ''}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {canRevenue ? (
            <CancelSubscriptionRow businessId={businessId} subscription={subscription} onDone={refresh} />
          ) : (
            <p className="text-xs text-muted-foreground">Cancelling a subscription is a finance action (revenue.write).</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Payment recovery history</CardTitle>
          <CardDescription>Every failed charge, nudge, waiver and recovery.</CardDescription>
        </CardHeader>
        <CardContent>
          <DunningTimeline businessId={businessId} />
        </CardContent>
      </Card>

      {(canCustomers || canErase) && (
        <DangerZoneCard businessId={businessId} business={business} canDelete={canCustomers} canErase={canErase} />
      )}
    </div>
  );
}

function AccountOwnershipCard({ businessId, business, onSaved }: {
  businessId: string; business: any; onSaved: () => void;
}) {
  const [owner, setOwner] = useState<string>(business.account_owner_email || '');
  const [tagText, setTagText] = useState<string>((business.tags || []).join(', '));

  const save = useMutation({
    mutationFn: () => adminApi.setAccountFields(businessId, {
      accountOwnerEmail: owner.trim() || null,
      tags: tagText.split(',').map((t) => t.trim()).filter(Boolean),
    }),
    onSuccess: () => { toast.success('Account details saved'); onSaved(); },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Account ownership</CardTitle>
        <CardDescription>
          Who on our side owns this relationship, and how it's segmented.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label className="text-sm">Account owner (internal email)</Label>
            <Input value={owner} onChange={(e) => setOwner(e.target.value)}
                   placeholder="ae@namastepos.in" />
          </div>
          <div>
            <Label className="text-sm">Tags (comma separated)</Label>
            <Input value={tagText} onChange={(e) => setTagText(e.target.value)}
                   placeholder="chain, high-touch, pilot" />
          </div>
        </div>
        {(business.tags || []).length > 0 && (
          <div className="flex flex-wrap gap-1">
            {(business.tags || []).map((t: string) => (
              <Badge key={t} variant="muted" className="text-[10px]">{t}</Badge>
            ))}
          </div>
        )}
        <div className="flex justify-end">
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save account details'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function OwnerEmailRow({ businessId, current, onSaved }: {
  businessId: string; current: string; onSaved: () => void;
}) {
  const [email, setEmail] = useState('');
  const m = useMutation({
    mutationFn: () => adminApi.changeOwnerEmail(businessId, email.trim()),
    onSuccess: () => {
      toast.success('Owner email changed — live sessions revoked');
      setEmail(''); onSaved();
    },
    onError: (e) => toast.error(apiError(e)),
  });
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">Change owner email</div>
      <p className="text-xs text-muted-foreground">
        Updates the business record and the owner's user row, then revokes every live
        session — the login identity itself has changed. Current: <strong>{current}</strong>
      </p>
      <div className="flex items-end gap-2">
        <div className="flex-1 max-w-sm">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                 placeholder="new-owner@restaurant.com" />
        </div>
        <Button variant="outline" onClick={() => m.mutate()}
                disabled={m.isPending || !email.includes('@')}>
          {m.isPending ? 'Changing…' : 'Change email'}
        </Button>
      </div>
    </div>
  );
}

function ResetCredentialsRow({ businessId }: { businessId: string }) {
  const m = useMutation({
    mutationFn: () => adminApi.resetOwnerCredentials(businessId),
    onSuccess: (r) => toast.success(
      `MPIN cleared · ${r.sessionsRevoked} session(s) revoked. The owner signs in with Google and sets a new MPIN.`),
    onError: (e) => toast.error(apiError(e)),
  });
  return (
    <div className="space-y-2 border-t pt-4">
      <div className="text-sm font-medium">Reset owner MPIN</div>
      <p className="text-xs text-muted-foreground">
        NamastePOS has no password to reset — owners sign in with Google and unlock the
        app with an MPIN. This clears that MPIN plus any brute-force lockout and revokes
        live sessions. Staff PINs are not touched.
      </p>
      <Button variant="outline" onClick={() => m.mutate()} disabled={m.isPending}>
        {m.isPending ? 'Resetting…' : 'Reset MPIN & revoke sessions'}
      </Button>
    </div>
  );
}

function ResendWelcomeRow({ businessId }: { businessId: string }) {
  const m = useMutation({
    mutationFn: () => adminApi.resendWelcome(businessId),
    onSuccess: (r) => toast.success(`Welcome email re-sent to ${r.recipient} (${r.status})`),
    onError: (e) => toast.error(apiError(e)),
  });
  return (
    <div className="space-y-2 border-t pt-4">
      <div className="text-sm font-medium">Re-send welcome email</div>
      <p className="text-xs text-muted-foreground">
        Sends the day-0 onboarding email again. It's logged separately from the original
        so the Messages tab shows both.
      </p>
      <Button variant="outline" onClick={() => m.mutate()} disabled={m.isPending}>
        {m.isPending ? 'Sending…' : 'Re-send welcome email'}
      </Button>
    </div>
  );
}

function CancelSubscriptionRow({ businessId, subscription, onDone }: {
  businessId: string; subscription: any; onDone: () => void;
}) {
  const [immediate, setImmediate] = useState(false);
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => adminApi.cancelSubscription(businessId, {
      immediate, reason: reason.trim() || undefined,
    }),
    onSuccess: () => {
      toast.success(immediate
        ? 'Subscription cancelled immediately'
        : 'Cancelling at period end — the gateway mandate is stopped');
      setReason(''); setImmediate(false); onDone();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const alreadyCancelled = subscription?.status === 'cancelled';

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Cancels the Razorpay mandate so nothing is auto-charged again. By default service
        continues until the paid period ends — cutting off a period the customer already
        paid for invites a chargeback.
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={immediate}
               onChange={(e) => setImmediate(e.target.checked)} />
        Cancel immediately (fraud / never paid / explicit customer demand)
      </label>
      <div className="max-w-sm">
        <Label className="text-sm">Reason (optional, goes on the CRM timeline)</Label>
        <Input value={reason} onChange={(e) => setReason(e.target.value)}
               placeholder="e.g. closing the restaurant" />
      </div>
      <Button variant={immediate ? 'destructive' : 'outline'}
              onClick={() => m.mutate()} disabled={m.isPending || alreadyCancelled}>
        {alreadyCancelled ? 'Already cancelled'
          : m.isPending ? 'Cancelling…'
          : immediate ? 'Cancel now' : 'Cancel at period end'}
      </Button>
    </div>
  );
}

function DangerZoneCard({ businessId, business, canDelete, canErase }: {
  businessId: string; business: any; canDelete: boolean; canErase: boolean;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [confirmName, setConfirmName] = useState('');
  const [reason, setReason] = useState('');

  const softDelete = useMutation({
    mutationFn: () => adminApi.deleteCustomer(businessId),
    onSuccess: () => {
      toast.success('Customer soft-deleted — financial history retained');
      qc.invalidateQueries({ queryKey: ['customers'] });
      navigate('/customers');
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const anonymise = useMutation({
    mutationFn: () => adminApi.anonymiseCustomer(businessId, reason.trim()),
    onSuccess: (r: any) => {
      toast.success(`DPDP erasure complete — ${r.usersErased} user(s) anonymised`);
      qc.invalidateQueries({ queryKey: ['customers'] });
      navigate('/customers');
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const nameMatches = confirmName.trim() === (business.name || '').trim();

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="text-base text-destructive">Danger zone</CardTitle>
        <CardDescription>
          Both actions below hide the tenant from every read path. Neither drops orders,
          invoices or payments — we still owe GST returns on historical revenue, and DPDP
          allows retaining transaction records after erasing identifiers.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {canDelete && <div className="space-y-2">
          <div className="text-sm font-medium">Soft-delete</div>
          <p className="text-xs text-muted-foreground">
            Marks the business deleted and cancels its subscription. Personal data is kept,
            so this is reversible by a DBA if it was a mistake.
          </p>
          <Button variant="outline" onClick={() => softDelete.mutate()}
                  disabled={softDelete.isPending || !!business.deleted_at}>
            {business.deleted_at ? 'Already deleted'
              : softDelete.isPending ? 'Deleting…' : 'Soft-delete customer'}
          </Button>
        </div>}

        {canErase && <div className={`space-y-3 ${canDelete ? 'border-t pt-4' : ''}`}>
          <div className="text-sm font-medium text-destructive">
            DPDP erasure (irreversible)
          </div>
          <p className="text-xs text-muted-foreground">
            Anonymises every user attached to this tenant (identifiers replaced with hashed
            tokens, marketing consent withdrawn, a completed DSR recorded for each), scrubs
            the business's own identifiers, and soft-deletes it. Use this only for a genuine
            erasure request. <strong>This cannot be undone.</strong>
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <Label className="text-sm">Reason (recorded on the DSR trail)</Label>
              <Input value={reason} onChange={(e) => setReason(e.target.value)}
                     placeholder="e.g. DSR-2026-014 erasure request" />
            </div>
            <div>
              <Label className="text-sm">
                Type <span className="font-mono">{business.name}</span> to confirm
              </Label>
              <Input value={confirmName} onChange={(e) => setConfirmName(e.target.value)}
                     placeholder={business.name} />
            </div>
          </div>
          <Button variant="destructive" onClick={() => anonymise.mutate()}
                  disabled={anonymise.isPending || !nameMatches || reason.trim().length < 3}>
            <Trash2 className="mr-2 h-4 w-4" />
            {anonymise.isPending ? 'Erasing…' : 'Anonymise & erase personal data'}
          </Button>
        </div>}
      </CardContent>
    </Card>
  );
}

// ── Messages tab (2026-09-03) ──────────────────────────────────────────
//
// Sourced from email_dispatch_log, which is the ONLY platform→tenant
// dispatch log that exists. Push notifications and WhatsApp sends are not
// logged anywhere per-message, so they can't be shown here — see the note
// in the empty/footer state rather than implying we know.
function MessagesTab({ businessId }: { businessId: string }) {
  const [status, setStatus] = useState('');
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['customer-notifications', businessId, status],
    queryFn: () => adminApi.customerNotifications(businessId, {
      limit: 100, status: status || undefined,
    }),
  });

  const rows = data?.rows || [];
  const variant = (s: string) => (s === 'sent' ? 'success'
    : s === 'failed' ? 'destructive'
    : s === 'suppressed' ? 'muted' : 'warning');

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <CardTitle className="text-base">Emails sent to this tenant</CardTitle>
            <CardDescription>
              {isLoading ? 'Loading…'
                : isError ? 'Couldn’t load the email log'
                : `${data?.total ?? 0} recorded dispatches`}
            </CardDescription>
          </div>
          <select value={status} onChange={(e) => setStatus(e.target.value)}
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm">
            <option value="">All statuses</option>
            <option value="sent">Sent</option>
            <option value="failed">Failed</option>
            <option value="queued">Queued</option>
            <option value="suppressed">Suppressed</option>
          </select>
        </div>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Template</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead>Recipient</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Sent</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow><TableCell colSpan={5} className="text-muted-foreground">Loading…</TableCell></TableRow>
            )}
            {isError && (
              // "No emails recorded" on a 500 reads as good news. Say it failed.
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center">
                  <div className="text-sm text-destructive">Couldn't load the email log — {apiError(error)}</div>
                  <Button variant="outline" size="sm" className="mt-2" onClick={() => refetch()}>Retry</Button>
                </TableCell>
              </TableRow>
            )}
            {!isLoading && !isError && rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  No emails recorded for this tenant.
                </TableCell>
              </TableRow>
            )}
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono text-xs">{r.template}</TableCell>
                <TableCell className="max-w-xs truncate text-sm">{r.subject}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{r.recipient}</TableCell>
                <TableCell>
                  <Badge variant={variant(r.status) as any} className="text-[10px]">{r.status}</Badge>
                  {r.error && (
                    <div className="mt-0.5 max-w-xs truncate text-[10px] text-destructive"
                         title={r.error}>{r.error}</div>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {r.sentAt ? formatDateTime(r.sentAt) : formatDateTime(r.createdAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="mt-4 text-xs text-muted-foreground">
          Email only. Push notifications and WhatsApp messages are sent without a
          per-message dispatch log, so they cannot be shown here yet.
        </p>
      </CardContent>
    </Card>
  );
}
