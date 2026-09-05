import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, RefreshCw, Edit2, Plus, Trash2, Sparkles } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { adminApi, Plan, TierKindOption } from '@/api/admin';
import { useTierKinds } from '@/hooks/useTierKinds';
import { apiError } from '@/api/client';
import { formatINR } from '@/lib/utils';

// 2026-09-04 — the tier_kind ladder is served by the backend, which owns the
// single source of truth (namastepos_backend/src/services/planTiers.js).
//
// This file used to declare `const TIER_KINDS = ['starter','pro','enterprise']`
// and a `TierKind` union from it. That list had gone stale against the live
// five-kind ladder, so the "Tier kind" select rendered BLANK for the Pro
// ('pro_plan') and Advanced ('advanced') plans and could not create a plan at
// either level. Do NOT re-introduce a local list — call useTierKinds()
// (src/hooks/useTierKinds.ts), which every admin page shares.

// Card accent, indexed by ladder RANK rather than by kind name, so a new
// rung styles itself instead of falling through to "no border".
const RANK_BORDER = [
  'border-emerald-500',
  'border-orange-500 shadow-lg',
  'border-sky-500',
  'border-indigo-500',
  'border-purple-600',
];
const RANK_BG = [
  'bg-emerald-500',
  'bg-orange-500',
  'bg-sky-500',
  'bg-indigo-500',
  'bg-purple-600',
];
function rankStyles(rank: number | undefined) {
  const i = rank === undefined || rank < 0 ? -1 : rank;
  return {
    border: i < 0 ? '' : (RANK_BORDER[i] ?? RANK_BORDER[RANK_BORDER.length - 1]),
    bg: i < 0 ? 'bg-muted-foreground' : (RANK_BG[i] ?? RANK_BG[RANK_BG.length - 1]),
  };
}

/** Select of every tier kind on the ladder, labelled ('pro_plan' -> 'Pro'). */
function TierKindSelect({
  value, onChange, options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: TierKindOption[];
}) {
  return (
    <>
      <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
          value={value} onChange={(e) => onChange(e.target.value)}>
        {/* A value the ladder does not contain would render blank, which is
            exactly how the old hardcoded list hid the Pro/Advanced plans.
            Keep it visible and flagged instead. */}
        {value && !options.some((o) => o.kind === value) && (
          <option value={value}>{value} (not on the ladder)</option>
        )}
        {options.map((o) => (
          <option key={o.kind} value={o.kind}>{o.label} ({o.kind})</option>
        ))}
      </select>
    </>
  );
}

export function PlansPage() {
  const qc = useQueryClient();
  const { data: plans } = useQuery({ queryKey: ['plans-admin'], queryFn: adminApi.listPlans });

  const [editing, setEditing] = useState<Plan | null>(null);
  const [creating, setCreating] = useState(false);
  // Push 18b — feature picker is now keyed by plan tier code, not tier_kind.
  // Holds the plan whose features are being edited.
  const [featurePicker, setFeaturePicker] = useState<Plan | null>(null);

  const sync = useMutation({
    mutationFn: adminApi.syncRazorpay,
    onSuccess: () => {
      toast.success('Razorpay plans synced');
      qc.invalidateQueries({ queryKey: ['plans-admin'] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const remove = useMutation({
    mutationFn: (tier: string) => adminApi.deletePlan(tier),
    onSuccess: () => {
      toast.success('Plan deleted');
      qc.invalidateQueries({ queryKey: ['plans-admin'] });
    },
    onError: (e) => toast.error(apiError(e)),
  });

  // Plans-addons migration — per-customer custom plans (is_public=false /
  // business-linked) MAY now appear in the admin list. Split them out of the
  // public grid defensively: if the backend keeps filtering them server-side,
  // customPlans is simply empty and only the one-line note renders.
  const publicPlans = (plans ?? []).filter(
    (p) => p.isPublic !== false && !(p as any).businessId && !(p as any).business_id);
  const customPlans = (plans ?? []).filter(
    (p) => p.isPublic === false || !!(p as any).businessId || !!(p as any).business_id);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Plans</h1>
          <p className="text-muted-foreground">
            Edit pricing, limits and which features each tier unlocks. Owner dashboard + mobile pick up
            changes within ~60s.
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => setCreating(true)} variant="outline">
            <Plus className="mr-2 h-4 w-4" />
            New plan
          </Button>
          <Button onClick={() => sync.mutate()} disabled={sync.isPending} variant="outline">
            <RefreshCw className={`mr-2 h-4 w-4 ${sync.isPending ? 'animate-spin' : ''}`} />
            Sync Razorpay plans
          </Button>
        </div>
      </div>

      {/* Push 18b — features are now per-plan, not per-tier_kind. Each
          plan card has its own "Edit features" button. The old "Feature
          matrix by tier" card is removed. */}
      <div>
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 px-1">
          Public plans
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {publicPlans.map((p) => (
            <PlanCard
              key={p.id}
              plan={p}
              onEdit={() => setEditing(p)}
              onEditFeatures={() => setFeaturePicker(p)}
              onDelete={() => {
                if (confirm(`Delete plan "${p.name}" (${p.tier})? Customers on this plan will block deletion until moved.`)) {
                  remove.mutate(p.tier);
                }
              }}
            />
          ))}
        </div>
      </div>

      {/* Plans-addons migration — per-customer custom plans, collapsed by
          default. Edited from the linked customer's "Plan & Features" tab,
          never from here. */}
      {customPlans.length > 0 ? (
        <details className="rounded-md border">
          <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">
            Custom plans (per-customer) — {customPlans.length}
          </summary>
          <div className="divide-y border-t">
            {customPlans.map((p) => {
              const bizId = p.businessId || (p as any).business_id || null;
              return (
                <div key={p.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                  <div className="min-w-0">
                    <span className="font-medium">{p.name}</span>
                    <span className="text-xs text-muted-foreground ml-2 font-mono">
                      {bizId ? `business ${bizId}` : 'no linked business'}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 whitespace-nowrap">
                    <span className="font-medium">
                      {formatINR(p.priceInr)}<span className="text-xs text-muted-foreground">/mo</span>
                    </span>
                    {bizId && (
                      <Link to={`/customers/${bizId}`} className="text-xs text-primary hover:underline">
                        Open customer →
                      </Link>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </details>
      ) : (
        <p className="text-xs text-muted-foreground px-1">
          Per-customer custom plans don't show here — manage them from the customer's
          "Plan &amp; Features" tab.
        </p>
      )}

      {editing && (
        <EditPlanDialog
          plan={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { qc.invalidateQueries({ queryKey: ['plans-admin'] }); setEditing(null); }}
        />
      )}
      {creating && (
        <CreatePlanDialog
          onClose={() => setCreating(false)}
          onSaved={() => { qc.invalidateQueries({ queryKey: ['plans-admin'] }); setCreating(false); }}
        />
      )}
      {featurePicker && (
        <TierFeaturePickerDialog
          plan={featurePicker}
          onClose={() => setFeaturePicker(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['tier-features'] });
            setFeaturePicker(null);
          }}
        />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Plan card (one per row in `plans` table)
// ──────────────────────────────────────────────────────────────────────
function PlanCard({
  plan, onEdit, onEditFeatures, onDelete,
}: {
  plan: Plan & { tierKind?: string; tier_kind?: string };
  onEdit: () => void;
  onEditFeatures: () => void;
  onDelete: () => void;
}) {
  // No code->kind guessing here any more. The old fallback map
  // (free->starter, basic->pro, pro->enterprise) was a second, WRONG copy of
  // the mapping: it had no entry for 'pro_plan'/'advanced' and silently
  // labelled both as Starter. The API always returns tierKind; if it somehow
  // does not, show that rather than inventing one.
  const tierKinds = useTierKinds();
  const tierKind = plan.tierKind || (plan as any).tier_kind || '';
  const rung = tierKinds.find((t) => t.kind === tierKind);
  // "Popular" = the first PAID rung of the ladder, not a hardcoded 'pro'
  // (which is Growth's kind, and was also Enterprise's tier code).
  const featured = rung?.rank === 1;
  const styles = rankStyles(rung?.rank);
  return (
    <Card className={`border-2 ${styles.border}`}>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-2xl">{plan.name}</CardTitle>
            {/* Bug fix (2026-08-20): CardDescription renders as <p>,
                and Badge renders a <div>. Nesting <div> inside <p> is
                invalid HTML and produces a validateDOMNesting warning
                every render. Swap to a <div> row so the badges are
                legal siblings. */}
            <div className="text-sm text-muted-foreground mt-1 flex flex-wrap items-center gap-2">
              <span className={`inline-block rounded px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-white ${styles.bg}`}>
                {rung?.label || tierKind || 'unknown tier kind'}
              </span>
              {featured && <Badge>Popular</Badge>}
              {/* FF-402c — plans now carry BOTH prices on one row.
                  If yearly is offered, badge it — else "monthly-only". */}
              {plan.priceInr > 0 && plan.priceYearlyInr != null && (
                <span className="inline-block rounded bg-amber-500 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-white">
                  Yearly recommended
                </span>
              )}
              {plan.priceInr > 0 && plan.priceYearlyInr == null && (
                <span className="inline-block rounded bg-muted px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-muted-foreground">
                  Monthly only
                </span>
              )}
              {!plan.isActive && <Badge variant="destructive">Inactive</Badge>}
              <span className="text-xs">db tier: {plan.tier}</span>
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Button size="sm" variant="ghost" onClick={onEdit} title="Edit"><Edit2 className="h-4 w-4" /></Button>
            <Button size="sm" variant="ghost" onClick={onDelete} title="Delete">
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          </div>
        </div>
        {/* FF-402c — show BOTH prices on the same plan card. Yearly line
            hidden when the plan doesn't offer yearly (priceYearlyInr = null). */}
        <div className="mt-3 space-y-1">
          <div className="flex items-baseline justify-between">
            <div>
              <span className="text-3xl font-bold">{formatINR(plan.priceInr)}</span>
              <span className="text-sm text-muted-foreground ml-1">/mo</span>
            </div>
            {plan.priceYearlyInr != null && plan.priceInr > 0 && (
              <div className="text-right">
                <div className="text-lg font-bold text-emerald-700">
                  {formatINR(plan.priceYearlyInr)}
                  <span className="text-xs text-muted-foreground ml-1">/yr</span>
                </div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700">
                  {(() => {
                    const save = plan.priceInr * 12 - plan.priceYearlyInr;
                    return save > 0 ? `Save ${formatINR(save)}` : 'Yearly';
                  })()}
                </div>
              </div>
            )}
          </div>
          {plan.priceYearlyInr == null && plan.priceInr > 0 && (
            <p className="text-[10px] text-muted-foreground italic">
              Yearly not offered · edit plan to enable
            </p>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <div className="text-xs font-semibold uppercase text-muted-foreground mb-2">Limits</div>
          <ul className="space-y-1.5 text-sm">
            {Object.entries(plan.limits).map(([k, v]) => (
              <li key={k} className="flex items-center gap-2">
                <Check className="h-4 w-4 text-emerald-600" />
                <span><strong>{v === -1 ? 'Unlimited' : v.toLocaleString('en-IN')}</strong>{' '}{k.replace(/_/g, ' ')}</span>
              </li>
            ))}
          </ul>
        </div>
        {/* Push 18b — per-plan feature picker. Replaces the old global
            "Feature matrix by tier" card so super-admin can edit each
            plan's feature set independently. */}
        <PlanFeatureSummary planTier={plan.tier} onEdit={onEditFeatures} />
      </CardContent>
    </Card>
  );
}

// Compact preview of the plan's currently-enabled features + an Edit button.
function PlanFeatureSummary({ planTier, onEdit }: { planTier: string; onEdit: () => void }) {
  const { data: features = [] } = useQuery({
    queryKey: ['tier-features', planTier],
    queryFn: () => adminApi.tierFeatures(planTier),
  });
  return (
    <div className="border rounded-md p-3 bg-muted/30">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-semibold uppercase text-muted-foreground">
          Features ({features.length})
        </div>
        <Button size="sm" variant="outline" onClick={onEdit}>
          <Sparkles className="mr-1 h-3.5 w-3.5" /> Edit
        </Button>
      </div>
      <div className="text-[11px] leading-5 text-foreground/80 line-clamp-3">
        {features.length === 0
          ? <span className="italic">No features assigned yet — click Edit to add some.</span>
          : features.map((f) => f.replace(/_/g, ' ')).join(', ')}
      </div>
    </div>
  );
}

// Push 18b — TierFeatureSummary removed; replaced by PlanFeatureSummary
// (above) which is rendered inside each PlanCard.
//
// Legacy stub kept commented in case anyone wants to reintroduce a
// global "matrix by tier_kind" overview later. Just unindent to use.
/*
function TierFeatureSummary({ tierKind, onEdit }: { tierKind: TierKind; onEdit: () => void }) {
  const { data: features = [] } = useQuery({
    queryKey: ['tier-features', tierKind],
    queryFn: () => adminApi.tierFeatures(tierKind),
  });
  const colorByTier: Record<TierKind, string> = {
    starter: 'border-emerald-300 bg-emerald-50',
    pro: 'border-orange-300 bg-orange-50',
    enterprise: 'border-purple-300 bg-purple-50',
  };
  return (
    <div className={`rounded-md border ${colorByTier[tierKind]} p-3`}>
      <div className="flex items-center justify-between mb-2">
        <div className="font-semibold capitalize">{tierKind}</div>
        <Button size="sm" variant="outline" onClick={onEdit}>
          <Sparkles className="mr-1 h-3.5 w-3.5" /> Edit features
        </Button>
      </div>
      <div className="text-xs text-muted-foreground mb-1">
        {features.length} feature{features.length === 1 ? '' : 's'}
      </div>
      <div className="text-[11px] leading-5 text-foreground/80 line-clamp-3">
        {features.length === 0
          ? <span className="italic">No features</span>
          : features.map((f) => f.replace(/_/g, ' ')).join(', ')}
      </div>
    </div>
  );
}
*/

// ──────────────────────────────────────────────────────────────────────
// Feature picker dialog — checkbox list of every known feature key.
// Source: GET /admin/feature-catalog (union of well-known + DB-distinct).
// ──────────────────────────────────────────────────────────────────────
function TierFeaturePickerDialog({
  plan, onClose, onSaved,
}: {
  plan: Plan;
  onClose: () => void;
  onSaved: () => void;
}) {
  // Push 18b — keyed by plan.tier (the plan's unique code) instead of
  // the abstract tier_kind concept. Each plan owns its own feature set.
  const planTier = plan.tier;
  // Labels, sections and the "nothing enforces this" warning all come from the
  // backend registry (src/config/featureRegistry.js) via /admin/feature-catalog.
  // This dialog used to own a hardcoded `buckets` map instead, which is why a
  // newly-shipped key silently landed in "Advanced" and rendered as raw
  // snake_case — and why nothing here could tell the founder that the key he
  // was about to grant is gated by nothing at all.
  const { data: cat } = useQuery({
    queryKey: ['feature-catalog-detailed'],
    queryFn: adminApi.featureCatalogDetailed,
  });
  const catalog = cat?.catalog ?? [];
  const { data: current = [], isLoading } = useQuery({
    queryKey: ['tier-features', planTier],
    queryFn: () => adminApi.tierFeatures(planTier),
  });
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const active = selected ?? new Set(current);

  const save = useMutation({
    mutationFn: () => adminApi.setTierFeatures(planTier, Array.from(active)),
    onSuccess: () => {
      toast.success(`Features saved for ${plan.name}`);
      onSaved();
    },
    onError: (e) => toast.error(apiError(e)),
  });

  // Sections, in the order the registry declares them. Anything whose group is
  // not in that order (an unregistered key still granted by an old plan) is
  // appended, so it stays visible and removable rather than disappearing.
  const groups = useMemo(() => {
    const order = cat?.groups ?? [];
    const buckets = new Map<string, typeof catalog>();
    for (const g of order) buckets.set(g, []);
    for (const entry of catalog) {
      if (!buckets.has(entry.group)) buckets.set(entry.group, []);
      buckets.get(entry.group)!.push(entry);
    }
    return [...buckets.entries()].filter(([, v]) => v.length > 0);
  }, [catalog, cat?.groups]);

  const toggle = (k: string) => {
    const next = new Set(active);
    if (next.has(k)) next.delete(k); else next.add(k);
    setSelected(next);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Features for {plan.name}
            <span className="text-xs font-normal text-muted-foreground ml-2">
              ({plan.tier})
            </span>
          </DialogTitle>
        </DialogHeader>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-4">
            <div className="text-xs text-muted-foreground">
              {active.size} of {catalog.length} selected. Owner dashboard + mobile see updates within ~60s.
            </div>
            {groups.map(([groupName, keys]) => (
              <div key={groupName}>
                <div className="text-xs font-semibold uppercase tracking-wider mb-2 text-muted-foreground">
                  {groupName}
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {keys.map((entry) => {
                    // "Nothing enforces this" is the warning worth surfacing:
                    // granting such a key charges the customer for a promise no
                    // gate keeps. That is exactly the 2026-09-05 Voice POS bug.
                    const toothless = entry.enforcement === 'ungated'
                      || entry.enforcement === 'unregistered';
                    return (
                      <label key={entry.key}
                          title={entry.why ?? entry.key}
                          className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/50 cursor-pointer text-sm">
                        <input type="checkbox"
                            checked={active.has(entry.key)}
                            onChange={() => toggle(entry.key)} />
                        <span className="flex-1 min-w-0">
                          <span className="block truncate">{entry.label}</span>
                          <span className="block font-mono text-[11px] text-muted-foreground truncate">
                            {entry.key}
                          </span>
                        </span>
                        {toothless && (
                          <span className="text-[10px] font-semibold uppercase text-amber-600 shrink-0"
                              title="No gate enforces this key — granting it promises something nothing checks.">
                            ungated
                          </span>
                        )}
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : `Save (${active.size})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Edit existing plan (limits + price)
// ──────────────────────────────────────────────────────────────────────
function EditPlanDialog({
  plan, onClose, onSaved,
}: {
  plan: Plan;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(plan.name);
  const tierKinds = useTierKinds();
  // Keep the plan's ACTUAL kind, whatever it is. This used to be typed to the
  // stale three-value union, so the Pro/Advanced plans arrived as values the
  // select had no <option> for and rendered blank.
  const [tierKind, setTierKind] = useState<string>(plan.tierKind || '');
  // FF-402c — edit BOTH prices on the same form (was: separate rows).
  const [priceMonthly, setPriceMonthly] = useState(plan.priceInr);
  const [priceYearly, setPriceYearly] = useState<string>(
    plan.priceYearlyInr != null ? String(plan.priceYearlyInr) : ''
  );
  const [offerYearly, setOfferYearly] = useState(plan.priceYearlyInr != null);
  const [isActive, setIsActive] = useState(plan.isActive);
  // FF-402e — the bottom rung of the ladder is trial-only, so it never
  // carries a yearly price. Read "bottom rung" off the ladder rather than
  // matching the literal 'starter'.
  const yearlyForbidden = (tierKinds[0] !== undefined && tierKind === tierKinds[0].kind)
    || priceMonthly === 0;
  const [limits, setLimits] = useState<Record<string, number>>({ ...plan.limits });
  const [newLimitKey, setNewLimitKey] = useState('');

  const save = useMutation({
    mutationFn: () => {
      const yearlyPaise = !offerYearly
        ? null
        : (priceYearly === '' ? priceMonthly * 100 * 10 : Math.round(Number(priceYearly) * 100));
      return adminApi.updatePlan(plan.tier, {
        name,
        tier_kind: tierKind,
        price_inr_paise: Math.round(priceMonthly * 100),
        price_yearly_paise: yearlyPaise,
        is_active: isActive,
        limits,
      });
    },
    onSuccess: () => { toast.success('Plan updated'); onSaved(); },
    onError: (e) => toast.error(apiError(e)),
  });

  const updateLimit = (k: string, v: any) =>
    setLimits({ ...limits, [k]: v === '' ? 0 : Number(v) });
  const removeLimit = (k: string) => {
    const next = { ...limits };
    delete next[k];
    setLimits(next);
  };
  const addLimit = () => {
    const k = newLimitKey.trim().replace(/\s+/g, '_').toLowerCase();
    if (!k) return;
    if (limits[k] !== undefined) {
      toast.error(`Limit "${k}" already exists`);
      return;
    }
    setLimits({ ...limits, [k]: 0 });
    setNewLimitKey('');
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Edit {plan.name} plan</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-4">
          <div><Label>Name</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div>
            <Label>Tier kind</Label>
            <TierKindSelect value={tierKind} onChange={setTierKind} options={tierKinds} />
          </div>
          <div>
            <Label>Monthly price (₹)</Label>
            <Input type="number" value={priceMonthly} min={0}
              onChange={(e) => setPriceMonthly(+e.target.value)} />
          </div>
          <div>
            <div className="flex items-center justify-between">
              <Label>Yearly price (₹)</Label>
              <label className={`text-[11px] flex items-center gap-1 ${yearlyForbidden ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
                <input type="checkbox"
                  checked={offerYearly && !yearlyForbidden}
                  disabled={yearlyForbidden}
                  onChange={(e) => setOfferYearly(e.target.checked)} />
                Offer yearly
              </label>
            </div>
            <Input type="number" value={yearlyForbidden ? '' : priceYearly}
              disabled={!offerYearly || yearlyForbidden}
              placeholder={yearlyForbidden
                ? 'Not available on trial / starter tier'
                : (offerYearly && priceMonthly > 0
                    ? `default ${(priceMonthly * 10).toLocaleString('en-IN')} (2 months free)`
                    : '')}
              onChange={(e) => setPriceYearly(e.target.value)} />
            {yearlyForbidden && (
              <p className="text-[11px] text-muted-foreground mt-1 italic">
                Starter tier is trial-only — yearly billing kicks in from Pro upwards.
              </p>
            )}
            {!yearlyForbidden && offerYearly && priceMonthly > 0 && (() => {
              const y = priceYearly === '' ? priceMonthly * 10 : Number(priceYearly);
              const save = priceMonthly * 12 - y;
              return (
                <p className="text-[11px] mt-1">
                  <span className="text-muted-foreground">
                    ≈ {formatINR(Math.round(y / 12))}/mo equivalent
                  </span>
                  {save > 0 && (
                    <span className="text-emerald-700 font-semibold ml-1">
                      · Save {formatINR(save)}/yr
                    </span>
                  )}
                </p>
              );
            })()}
          </div>
          <div className="col-span-2 flex items-end">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
              <span className="text-sm">Active (customers can subscribe)</span>
            </label>
          </div>
        </div>

        <div className="border-t pt-4">
          <div className="text-sm font-semibold mb-2">
            Limits <span className="text-xs font-normal text-muted-foreground">(use -1 for unlimited)</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {Object.entries(limits).map(([k, v]) => (
              <div key={k}>
                <div className="flex items-center justify-between">
                  <Label className="text-xs">{k.replace(/_/g, ' ')}</Label>
                  <button type="button" onClick={() => removeLimit(k)}
                      className="text-[10px] text-destructive hover:underline">remove</button>
                </div>
                <Input type="number" value={String(v)} onChange={(e) => updateLimit(k, e.target.value)} />
              </div>
            ))}
          </div>
          <div className="flex gap-2 mt-3">
            <Input placeholder="add new limit key (e.g. menu_items)"
                value={newLimitKey} onChange={(e) => setNewLimitKey(e.target.value)} />
            <Button variant="outline" onClick={addLimit}>Add</Button>
          </div>
        </div>

        <div className="border-t pt-4">
          <p className="text-xs text-muted-foreground">
            Features for this plan are edited via the "Edit features" button on
            the plan card. Each plan owns its own set.
          </p>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Create new plan
// ──────────────────────────────────────────────────────────────────────
function CreatePlanDialog({
  onClose, onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  // Push 18a — tier is now a free-form lowercase code (was locked to the
  // plan_tier enum). Anything matching /^[a-z0-9_]+$/ works.
  const [tier, setTier] = useState('');
  const tierKinds = useTierKinds();
  // Default to the first PAID rung of the ladder (was a hardcoded 'pro',
  // which is Growth's KIND and Enterprise's CODE - exactly the ambiguity
  // this page kept tripping over).
  const [tierKind, setTierKind] = useState<string>('');
  const effectiveTierKind = tierKind || tierKinds[1]?.kind || tierKinds[0]?.kind || '';
  const [name, setName] = useState('');
  // FF-402c — one plan carries BOTH prices. Monthly is required (or 0
  // for free tiers), yearly is optional and auto-fills to 10× monthly
  // (2 months free) when left blank.
  const [priceMonthly, setPriceMonthly] = useState(0);
  const [priceYearly, setPriceYearly] = useState<string>('');   // string so blank stays blank
  const [offerYearly, setOfferYearly] = useState(true);
  // FF-402e — starter is the trial tier by design; never let it carry
  // a yearly price. Force-off the checkbox when tierKind flips to
  // starter (or the admin sets monthly to 0).
  const yearlyForbidden = tierKinds[0] !== undefined
    ? (effectiveTierKind === tierKinds[0].kind || priceMonthly === 0)
    : priceMonthly === 0;
  const [limits, setLimits] = useState<Record<string, number>>({
    staff: 5, menu_items: 200, monthly_orders: 5000,
  });
  const [newLimitKey, setNewLimitKey] = useState('');

  const tierValid = /^[a-z0-9_]+$/.test(tier) && effectiveTierKind !== '';
  const create = useMutation({
    mutationFn: () => {
      // FF-402c — send both prices in one call. Blank yearly ⇒ auto
      // 10× monthly on the backend; "offer yearly" off ⇒ null,
      // which disables the yearly option for this plan.
      const yearlyPaise = !offerYearly
        ? null
        : (priceYearly === '' ? undefined : Math.round(Number(priceYearly) * 100));
      return adminApi.createPlan({
        tier, tier_kind: effectiveTierKind, name,
        price_inr_paise: Math.round(priceMonthly * 100),
        price_yearly_paise: yearlyPaise,
        is_active: true,
        limits,
      });
    },
    onSuccess: () => { toast.success('Plan created'); onSaved(); },
    onError: (e) => toast.error(apiError(e)),
  });

  const updateLimit = (k: string, v: any) =>
    setLimits({ ...limits, [k]: v === '' ? 0 : Number(v) });
  const removeLimit = (k: string) => {
    const next = { ...limits };
    delete next[k];
    setLimits(next);
  };
  const addLimit = () => {
    const k = newLimitKey.trim().replace(/\s+/g, '_').toLowerCase();
    if (!k) return;
    if (limits[k] !== undefined) {
      toast.error(`Limit "${k}" already exists`);
      return;
    }
    setLimits({ ...limits, [k]: 0 });
    setNewLimitKey('');
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Create plan</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label>Tier code *</Label>
            <Input
              value={tier}
              onChange={(e) => setTier(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
              placeholder="e.g. pro_lite"
            />
            <p className="text-[10px] text-muted-foreground mt-1">
              Lowercase letters / numbers / underscores. Must be unique. This is the
              code the rest of the system uses to reference the plan.
            </p>
            {tier && !tierValid && (
              <p className="text-[10px] text-destructive mt-1">Invalid characters.</p>
            )}
          </div>
          <div>
            <Label>Tier kind (upgrade ladder position)</Label>
            <TierKindSelect value={effectiveTierKind} onChange={setTierKind} options={tierKinds} />
          </div>
          <div className="col-span-2">
            <Label>Display name *</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Pro Lite" />
          </div>
          <div>
            <Label>Monthly price (₹)</Label>
            <Input type="number" value={priceMonthly} min={0}
              onChange={(e) => setPriceMonthly(+e.target.value)} />
            <p className="text-[11px] text-muted-foreground mt-1">
              Use 0 for a free / trial plan.
            </p>
          </div>
          <div>
            <div className="flex items-center justify-between">
              <Label>Yearly price (₹)</Label>
              <label className={`text-[11px] flex items-center gap-1 ${yearlyForbidden ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
                <input type="checkbox"
                  checked={offerYearly && !yearlyForbidden}
                  disabled={yearlyForbidden}
                  onChange={(e) => setOfferYearly(e.target.checked)} />
                Offer yearly
              </label>
            </div>
            <Input type="number" value={yearlyForbidden ? '' : priceYearly}
              disabled={!offerYearly || yearlyForbidden}
              placeholder={yearlyForbidden
                ? 'Not available on trial / starter tier'
                : (offerYearly && priceMonthly > 0
                    ? `default ${(priceMonthly * 10).toLocaleString('en-IN')} (2 months free)`
                    : '')}
              onChange={(e) => setPriceYearly(e.target.value)} />
            {/* FF-402e — explain WHY yearly is disabled so the admin
                doesn't file a bug. */}
            {yearlyForbidden && (
              <p className="text-[11px] text-muted-foreground mt-1 italic">
                Starter tier is trial-only — yearly billing kicks in from Pro upwards.
              </p>
            )}
            {!yearlyForbidden && offerYearly && priceMonthly > 0 && (() => {
              const y = priceYearly === '' ? priceMonthly * 10 : Number(priceYearly);
              const annualisedMonthly = priceMonthly * 12;
              const save = annualisedMonthly - y;
              return (
                <p className="text-[11px] mt-1">
                  <span className="text-muted-foreground">
                    ≈ {formatINR(Math.round(y / 12))}/mo equivalent
                  </span>
                  {save > 0 && (
                    <span className="text-emerald-700 font-semibold ml-1">
                      · Save {formatINR(save)}/yr
                    </span>
                  )}
                </p>
              );
            })()}
          </div>
        </div>

        <div className="border-t pt-4">
          <div className="text-sm font-semibold mb-2">
            Limits <span className="text-xs font-normal text-muted-foreground">(use -1 for unlimited)</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {Object.entries(limits).map(([k, v]) => (
              <div key={k}>
                <div className="flex items-center justify-between">
                  <Label className="text-xs">{k.replace(/_/g, ' ')}</Label>
                  <button type="button" onClick={() => removeLimit(k)}
                      className="text-[10px] text-destructive hover:underline">remove</button>
                </div>
                <Input type="number" value={String(v)} onChange={(e) => updateLimit(k, e.target.value)} />
              </div>
            ))}
          </div>
          <div className="flex gap-2 mt-3">
            <Input placeholder="add new limit key (e.g. menu_items)"
                value={newLimitKey} onChange={(e) => setNewLimitKey(e.target.value)} />
            <Button variant="outline" onClick={addLimit}>Add</Button>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => create.mutate()}
              disabled={create.isPending || !name.trim() || !tierValid}>
            {create.isPending ? 'Creating…' : 'Create plan'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
