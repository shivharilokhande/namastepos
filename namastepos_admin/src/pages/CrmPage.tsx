// NamastePOS admin — CRM cross-tenant view (FF-402).
//
// One page for the support team to run their week:
//   1. Follow-ups pane — open tasks across all tenants, sorted by due date
//   2. Renewals pane   — trials + subscriptions ending in the next 7 days
//   3. Refresh button  — kick the health-score recompute for every tenant
//                        (nightly cron does this automatically, this is
//                         for on-demand "did that call move the needle?")
//
// Per-tenant activity feed + tasks live on CustomerDetailPage, not here.

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { adminApi } from '@/api/admin';
import { apiError } from '@/api/client';
import { Plus, RefreshCw, CheckCircle2, Clock, AlertTriangle } from 'lucide-react';

export function CrmPage() {
  const qc = useQueryClient();
  const [ownerFilter, setOwnerFilter] = useState('');
  const [renewalDays, setRenewalDays] = useState(7);

  const tasksQ = useQuery({
    queryKey: ['crm-tasks', ownerFilter],
    queryFn:  () => adminApi.crmListTasks({ ownerEmail: ownerFilter || undefined, openOnly: true }),
  });
  const renewalsQ = useQuery({
    queryKey: ['crm-renewals', renewalDays],
    queryFn:  () => adminApi.crmRenewals(renewalDays),
  });

  const completeT = useMutation({
    mutationFn: (id: string) => adminApi.crmCompleteTask(id),
    onSuccess: () => { toast.success('Done'); qc.invalidateQueries({ queryKey: ['crm-tasks'] }); },
    onError:   (e) => toast.error(apiError(e)),
  });
  const refreshAll = useMutation({
    mutationFn: () => adminApi.crmRecomputeAllHealth(),
    onSuccess: (r) => toast.success(`Recomputed health for ${r.count} tenants`),
    onError:   (e) => toast.error(apiError(e)),
  });

  const overdueCount = (tasksQ.data || []).filter(
    (t) => t.dueAt && new Date(t.dueAt) < new Date()
  ).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">CRM</h1>
          <p className="text-sm text-muted-foreground">Follow-ups and renewals across every tenant.</p>
        </div>
        <Button variant="outline" onClick={() => refreshAll.mutate()} disabled={refreshAll.isPending}>
          <RefreshCw className={`w-4 h-4 mr-2 ${refreshAll.isPending ? 'animate-spin' : ''}`} />
          Recompute health
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Follow-ups — the "call list" for this week */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div className="space-y-1">
              <CardTitle>Follow-ups {overdueCount > 0 && (
                <Badge variant="destructive" className="ml-2">{overdueCount} overdue</Badge>
              )}</CardTitle>
              <p className="text-xs text-muted-foreground">Open tasks, oldest due date first.</p>
            </div>
            <NewTaskDialog />
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Label className="text-xs">Filter by owner email</Label>
              <Input placeholder="me@namastepos.in"
                value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)} />
            </div>
            {tasksQ.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
            {tasksQ.data?.length === 0 && (
              <p className="text-sm text-muted-foreground py-6 text-center">
                No open follow-ups. Nice.
              </p>
            )}
            <ul className="divide-y">
              {(tasksQ.data || []).map((t: any) => {
                const overdue = t.dueAt && new Date(t.dueAt) < new Date();
                return (
                  <li key={t.id} className="py-3 flex items-start gap-3">
                    <button
                      onClick={() => completeT.mutate(t.id)}
                      className="mt-0.5 text-muted-foreground hover:text-emerald-600"
                      title="Mark done">
                      <CheckCircle2 className="w-5 h-5" />
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm">{t.title}</div>
                      {t.notes && <div className="text-xs text-muted-foreground mt-0.5">{t.notes}</div>}
                      <div className="text-xs text-muted-foreground mt-1 flex items-center gap-2 flex-wrap">
                        {t.businessId && (
                          <Link to={`/customers/${t.businessId}`} className="underline">
                            {t.businessName || 'business'}
                          </Link>
                        )}
                        {t.ownerEmail && <span>· {t.ownerEmail}</span>}
                        {t.dueAt && (
                          <span className={overdue ? 'text-destructive font-medium' : ''}>
                            <Clock className="w-3 h-3 inline mr-1" />
                            {new Date(t.dueAt).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>

        {/* Renewals — trials + subs ending soon */}
        <Card>
          <CardHeader>
            <CardTitle>Renewals ({renewalDays} days)</CardTitle>
            <div className="flex gap-1 pt-1">
              {[7, 14, 30].map((d) => (
                <button key={d} onClick={() => setRenewalDays(d)}
                  className={`text-xs px-2 py-1 rounded border ${renewalDays === d ? 'bg-primary text-primary-foreground' : ''}`}>
                  {d}d
                </button>
              ))}
            </div>
          </CardHeader>
          <CardContent>
            {renewalsQ.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
            {renewalsQ.data?.length === 0 && (
              <p className="text-sm text-muted-foreground py-6 text-center">
                Nothing renewing in the next {renewalDays} days.
              </p>
            )}
            <ul className="divide-y">
              {(renewalsQ.data || []).map((r: any) => (
                <li key={`${r.businessId}-${r.endsAt}`} className="py-3 flex items-start gap-3">
                  {r.kind === 'trial_ending'
                    ? <AlertTriangle className="w-5 h-5 mt-0.5 text-amber-600" />
                    : <Clock className="w-5 h-5 mt-0.5 text-muted-foreground" />}
                  <div className="flex-1 min-w-0">
                    <Link to={`/customers/${r.businessId}`} className="font-medium text-sm underline">
                      {r.businessName}
                    </Link>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {r.kind === 'trial_ending' ? 'Trial ends' : 'Renews'} —{' '}
                      {new Date(r.endsAt).toLocaleDateString()} ·{' '}
                      {r.plan.name || r.plan.tier || 'no plan'}
                      {r.plan.billingPeriod && ` (${r.plan.billingPeriod})`}
                    </div>
                    {r.lifecycleStage && (
                      <LifecycleBadge stage={r.lifecycleStage} className="mt-1" />
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export function LifecycleBadge({ stage, className }: { stage: string | null; className?: string }) {
  if (!stage) return null;
  const map: Record<string, { label: string; color: string }> = {
    trial:    { label: 'Trial',   color: 'bg-blue-100 text-blue-800' },
    active:   { label: 'Active',  color: 'bg-emerald-100 text-emerald-800' },
    at_risk:  { label: 'At-risk', color: 'bg-amber-100 text-amber-800' },
    churned:  { label: 'Churned', color: 'bg-red-100 text-red-800' },
  };
  const m = map[stage] || { label: stage, color: 'bg-muted' };
  return <span className={`inline-block text-[10px] px-2 py-0.5 rounded ${m.color} ${className || ''}`}>{m.label}</span>;
}

export function HealthPill({ score }: { score: number | null }) {
  if (score == null) return <span className="text-xs text-muted-foreground">—</span>;
  const color = score >= 60 ? 'bg-emerald-500' : score >= 30 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <span className="inline-flex items-center gap-1 text-xs">
      <span className={`inline-block w-2 h-2 rounded-full ${color}`} />
      {score}
    </span>
  );
}

function NewTaskDialog() {
  // Kept inline (rather than a shadcn Dialog import) so the CRM page has
  // zero extra dependency lift. Click reveals a compact form.
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ title: '', notes: '', ownerEmail: '', dueAt: '', businessId: '' });
  const mut = useMutation({
    mutationFn: () => adminApi.crmCreateTask({
      title: f.title, notes: f.notes || undefined,
      ownerEmail: f.ownerEmail || undefined,
      dueAt: f.dueAt ? new Date(f.dueAt).toISOString() : undefined,
      businessId: f.businessId || null,
    }),
    onSuccess: () => {
      toast.success('Task added');
      setF({ title: '', notes: '', ownerEmail: '', dueAt: '', businessId: '' });
      setOpen(false);
      qc.invalidateQueries({ queryKey: ['crm-tasks'] });
    },
    onError: (e) => toast.error(apiError(e)),
  });
  return (
    <>
      <Button size="sm" onClick={() => setOpen(!open)}>
        <Plus className="w-3.5 h-3.5 mr-1" /> New task
      </Button>
      {open && (
        <div className="absolute right-4 mt-24 z-10 bg-background border rounded-md shadow-lg p-3 space-y-2 w-80">
          <Input placeholder="Task title" value={f.title}
            onChange={(e) => setF({ ...f, title: e.target.value })} />
          <textarea placeholder="Notes (optional)" value={f.notes}
            onChange={(e) => setF({ ...f, notes: e.target.value })}
            className="w-full h-16 rounded-md border border-input bg-background px-3 py-1.5 text-sm" />
          <div className="grid grid-cols-2 gap-2">
            <Input type="email" placeholder="Owner email" value={f.ownerEmail}
              onChange={(e) => setF({ ...f, ownerEmail: e.target.value })} />
            <Input type="datetime-local" value={f.dueAt}
              onChange={(e) => setF({ ...f, dueAt: e.target.value })} />
          </div>
          <Input placeholder="Business ID (optional)" value={f.businessId}
            onChange={(e) => setF({ ...f, businessId: e.target.value })} />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={() => mut.mutate()} disabled={!f.title || mut.isPending}>Save</Button>
          </div>
        </div>
      )}
    </>
  );
}
