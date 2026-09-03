import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Search, Plus } from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { adminApi, Customer } from '@/api/admin';
import { apiError } from '@/api/client';
import { formatINR, formatDate } from '@/lib/utils';
import { useDebounce } from '@/hooks/useDebounce';

export function CustomersPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [plan, setPlan] = useState('');
  const [creating, setCreating] = useState(false);
  const PAGE_SIZE = 50;
  const [page, setPage] = useState(0);
  // Push 19a — fetch the live plan catalog so the filter dropdown +
  // manual-create dialog reflect new tiers (Advanced etc.) instead of
  // the hardcoded free/basic/pro list.
  const { data: planCatalog = [] } = useQuery({
    queryKey: ['plans-admin'],
    queryFn: adminApi.listPlans,
    staleTime: 60_000,
  });

  // NP-129: the raw input used to go straight into the queryKey — one
  // request per keystroke. Only the ~300ms-debounced value hits the server.
  const debouncedSearch = useDebounce(search, 300);

  const { data, isLoading } = useQuery({
    queryKey: ['customers', debouncedSearch, plan, page],
    queryFn: () => adminApi.listCustomers({
      search: debouncedSearch || undefined, plan: plan || undefined,
      limit: PAGE_SIZE, offset: page * PAGE_SIZE,
    }),
  });
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // FF-402 — compact health dot: red < 30, amber 30-59, green ≥ 60.
  // Rendered inline on the customers list so we can eyeball who to call.
  const HealthDot = ({ score }: { score: number | null }) => {
    if (score == null) return <span className="inline-block w-2 h-2 rounded-full bg-muted" title="Health not yet computed" />;
    const c = score >= 60 ? 'bg-emerald-500' : score >= 30 ? 'bg-amber-500' : 'bg-red-500';
    return (
      <span className="flex items-center gap-1 text-xs" title={`Health score ${score}/100`}>
        <span className={`inline-block w-2 h-2 rounded-full ${c}`} />
        <span className="font-mono">{score}</span>
      </span>
    );
  };

  // 2026-09-03 — outlet visibility. Each outlet is its own tenant row, so
  // without this column an HQ and its five branches look like six unrelated
  // customers. "Outlet of X" links to the HQ's own detail page; stopPropagation
  // keeps the row's own navigate() from hijacking the click.
  const OutletCell = ({ c }: { c: Customer }) => {
    const o = c.outlet;
    if (!o) {
      return <span className="text-xs text-muted-foreground">Single outlet</span>;
    }
    if (o.isParent) {
      return (
        <div className="flex flex-col gap-0.5">
          <Badge variant="default" className="w-fit">
            HQ ({o.siblingCount} outlet{o.siblingCount === 1 ? '' : 's'})
          </Badge>
          {o.groupName && (
            <span className="text-[10px] text-muted-foreground">{o.groupName}</span>
          )}
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-0.5">
        <Badge variant="secondary" className="w-fit">Outlet</Badge>
        <span className="text-[10px] text-muted-foreground">
          {o.parentBusinessId ? (
            <>
              of{' '}
              <button
                type="button"
                className="underline hover:text-foreground"
                onClick={(e) => { e.stopPropagation(); navigate(`/customers/${o.parentBusinessId}`); }}
              >
                {o.parentName || 'HQ'}
              </button>
            </>
          ) : (
            <>in {o.groupName || 'group'}</>
          )}
          {o.label ? ` · ${o.label}` : ''}
        </span>
      </div>
    );
  };

  const statusVariant = (s: string) => {
    if (s === 'active') return 'success' as const;
    if (s === 'trialing') return 'secondary' as const;
    if (s === 'past_due') return 'warning' as const;
    if (s === 'cancelled' || s === 'paused') return 'destructive' as const;
    return 'muted' as const;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Customers</h1>
          <p className="text-muted-foreground">
            {data?.total ?? 0} signed-up businesses
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="mr-2 h-4 w-4" /> Add customer manually
        </Button>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col md:flex-row md:items-center gap-3">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input placeholder="Search by name, email, phone…" className="pl-9"
                     value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} />
            </div>
            <select value={plan} onChange={(e) => { setPlan(e.target.value); setPage(0); }}
                    className="h-10 rounded-md border border-input bg-background px-3 text-sm">
              <option value="">All plans</option>
              {planCatalog.map((p: any) => (
                <option key={p.tier} value={p.tier}>
                  {p.name} ({p.tier})
                </option>
              ))}
            </select>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Business</TableHead>
                {/* 2026-09-03 — HQ / outlet / standalone at a glance */}
                <TableHead>Outlet</TableHead>
                <TableHead>Plan</TableHead>
                <TableHead>Status</TableHead>
                {/* FF-402 — CRM lifecycle + health chip */}
                <TableHead>Health</TableHead>
                <TableHead>Staff</TableHead>
                <TableHead className="text-right">Orders</TableHead>
                <TableHead className="text-right">Revenue</TableHead>
                <TableHead>Joined</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={9} className="text-center py-10 text-muted-foreground">Loading…</TableCell></TableRow>
              )}
              {!isLoading && data?.customers.length === 0 && (
                <TableRow><TableCell colSpan={9} className="text-center py-10 text-muted-foreground">No customers yet.</TableCell></TableRow>
              )}
              {data?.customers.map((c) => (
                <TableRow key={c.id} className="cursor-pointer"
                          onClick={() => navigate(`/customers/${c.id}`)}>
                  <TableCell>
                    <div className="font-medium">{c.name}</div>
                    <div className="text-xs text-muted-foreground">{c.email}</div>
                  </TableCell>
                  <TableCell><OutletCell c={c} /></TableCell>
                  <TableCell>
                    {c.plan ? (
                      // Push 18a — `tier` is now free-text; bucket by `tierKind`
                      // (starter/pro/enterprise) for consistent visual scale.
                      // The Customer.plan type doesn't yet include tierKind, so
                      // cast through `any` until that interface is widened.
                      <Badge variant={
                        ((c.plan as any).tierKind) === 'enterprise' ? 'default'
                        : ((c.plan as any).tierKind) === 'pro' ? 'default'
                        : ((c.plan as any).tierKind) === 'starter' ? 'secondary'
                        : c.plan.tier === 'pro' ? 'default'
                        : c.plan.tier === 'basic' ? 'secondary'
                        : 'muted'
                      }>
                        {c.plan.name}
                      </Badge>
                    ) : <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(c.subscriptionStatus)}>{c.subscriptionStatus || 'unknown'}</Badge>
                  </TableCell>
                  {/* FF-402 — health chip: dot colour = risk band, number = score */}
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <HealthDot score={(c as any).healthScore ?? null} />
                      {(c as any).lifecycleStage && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted uppercase">
                          {(c as any).lifecycleStage}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>{c.staffCount}</TableCell>
                  <TableCell className="text-right">{c.totalOrders.toLocaleString('en-IN')}</TableCell>
                  <TableCell className="text-right font-medium">{formatINR(c.totalRevenue)}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{formatDate(c.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {total > PAGE_SIZE && (
            <div className="flex items-center justify-between pt-4 text-sm">
              <span className="text-muted-foreground">
                {total === 0 ? 0 : page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
              </span>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" disabled={page <= 0}
                        onClick={() => setPage((p) => Math.max(0, p - 1))}>Prev</Button>
                <span className="text-muted-foreground">Page {page + 1} / {pageCount}</span>
                <Button variant="outline" size="sm" disabled={page + 1 >= pageCount}
                        onClick={() => setPage((p) => p + 1)}>Next</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <CreateCustomerDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => { qc.invalidateQueries({ queryKey: ['customers'] }); navigate(`/customers/${id}`); }}
        plans={planCatalog}
      />
    </div>
  );
}

function CreateCustomerDialog({ open, onClose, onCreated, plans }: {
  open: boolean; onClose: () => void; onCreated: (id: string) => void;
  plans: any[];
}) {
  // Push 19a — default to whichever plan exists at the cheapest price
  // (typically Starter / Free). Falls back to 'free' if /plans hasn't
  // loaded yet so the form never breaks.
  const defaultTier = plans.length > 0
    ? [...plans].sort((a, b) => (a.priceInr || 0) - (b.priceInr || 0))[0].tier
    : 'free';
  const [form, setForm] = useState({
    email: '', name: '', ownerName: '', phone: '',
    city: '', category: '', planTier: defaultTier, trialDays: 14,
  });
  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));

  const create = useMutation({
    mutationFn: () => adminApi.createCustomer(form),
    onSuccess: (b) => { toast.success('Customer created'); onCreated(b.id); onClose(); },
    onError: (e) => toast.error(apiError(e)),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add a customer manually</DialogTitle>
          <DialogDescription>
            Use this when onboarding a business through sales. They'll Google-sign-in later
            and link to this account using the same email.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4">
          <div><Label>Business email *</Label><Input value={form.email} onChange={(e) => set('email', e.target.value)} /></div>
          <div><Label>Business name *</Label><Input value={form.name} onChange={(e) => set('name', e.target.value)} /></div>
          <div><Label>Owner name</Label><Input value={form.ownerName} onChange={(e) => set('ownerName', e.target.value)} /></div>
          <div><Label>Phone</Label><Input value={form.phone} onChange={(e) => set('phone', e.target.value)} /></div>
          <div><Label>City</Label><Input value={form.city} onChange={(e) => set('city', e.target.value)} /></div>
          <div><Label>Category</Label><Input value={form.category} onChange={(e) => set('category', e.target.value)} placeholder="tea-stall, dhaba…" /></div>
          <div>
            <Label>Plan</Label>
            <select value={form.planTier} onChange={(e) => set('planTier', e.target.value)}
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
              {plans.length === 0 && <option value="free">Free (loading…)</option>}
              {[...plans]
                .sort((a, b) => (a.priceInr || 0) - (b.priceInr || 0))
                .map((p) => (
                  <option key={p.tier} value={p.tier}>
                    {p.name}{p.priceInr ? ` — ${formatINR(p.priceInr)}/${p.billingPeriod || 'mo'}` : ' — free'}
                  </option>
                ))}
            </select>
          </div>
          <div><Label>Trial days</Label><Input type="number" value={form.trialDays} onChange={(e) => set('trialDays', +e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => create.mutate()} disabled={!form.email || !form.name || create.isPending}>
            {create.isPending ? 'Creating…' : 'Create customer'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
