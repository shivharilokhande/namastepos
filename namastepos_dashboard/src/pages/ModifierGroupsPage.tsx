// NamastePOS dashboard — Modifier groups management (Bug #2, 2026-08-25).
//
// Replaces the MenuPage "Create them under Catalog → Modifier groups (TBD)"
// dead-end with real CRUD, at parity with the mobile screen
// (namastepos_flutter/lib/screens/menu/modifier_groups_screen.dart).
//
// Backend contract (namastepos_backend/src/routes/sprint1Extras.routes.js +
// services/variantService.js):
//   GET /businesses/:id/modifier-groups        → { groups: ModifierGroup[] }
//   PUT /businesses/:id/modifier-groups        → upsert ONE group, returns
//                                                { groups } (the full fresh list)
// There is NO DELETE endpoint — listGroups filters is_active = TRUE, so
// "delete" here is a soft-deactivate via PUT { ..., isActive: false }.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { api, apiError, getBusinessCache } from '@/api/client';

// ── Server shapes (mirror variantService.serializeGroup) ────────────────────

type GroupKind = 'single_select' | 'multi_select';

interface ModifierOption {
  id: string;
  name: string;
  priceDeltaInr: number;
  isActive: boolean;
  displayOrder: number;
}

interface ModifierGroup {
  id: string;
  name: string;
  kind: GroupKind;
  minSelect: number;
  maxSelect: number;
  displayOrder: number;
  isActive: boolean;
  modifiers: ModifierOption[];
}

// ── Local form drafts ───────────────────────────────────────────────────────
// Numeric fields are kept as strings while editing so the user can clear the
// input mid-typing without React fighting them over NaN; parsed on save.

interface OptionDraft {
  id: string | null; // kept so the backend updates in-place (preserves FKs)
  name: string;
  priceDelta: string;
}

interface GroupForm {
  id: string | null; // null → create; the PUT endpoint upserts on id
  name: string;
  kind: GroupKind;
  minSelect: string;
  maxSelect: string;
  options: OptionDraft[];
}

const EMPTY_FORM: GroupForm = {
  id: null,
  name: '',
  kind: 'single_select',
  minSelect: '0',
  maxSelect: '1',
  // Start with one blank row — a group with zero options is useless at order
  // time, so nudge the user straight into filling one in.
  options: [{ id: null, name: '', priceDelta: '0' }],
};

function groupToForm(g: ModifierGroup): GroupForm {
  return {
    id: g.id,
    name: g.name,
    kind: g.kind,
    minSelect: String(g.minSelect),
    maxSelect: String(g.maxSelect),
    options: g.modifiers.map((m) => ({
      id: m.id,
      name: m.name,
      priceDelta: String(m.priceDeltaInr),
    })),
  };
}

// Upsert payload for PUT /modifier-groups. Options the caller omits get
// soft-deactivated server-side (keepIds diff), so we always send the full set.
function formToPayload(form: GroupForm, isActive: boolean) {
  return {
    ...(form.id ? { id: form.id } : {}),
    name: form.name.trim(),
    kind: form.kind,
    minSelect: parseInt(form.minSelect, 10) || 0,
    maxSelect: parseInt(form.maxSelect, 10) || 1,
    isActive,
    modifiers: form.options
      .filter((o) => o.name.trim() !== '') // drop rows added but never filled
      .map((o) => ({
        ...(o.id ? { id: o.id } : {}),
        name: o.name.trim(),
        priceDeltaInr: parseFloat(o.priceDelta) || 0,
      })),
  };
}

// Signed rupee delta for the option rows ("+₹20", "−₹10", "Free").
function formatDelta(d: number): string {
  if (d === 0) return 'Free';
  const abs = Math.abs(d).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  return d > 0 ? `+₹${abs}` : `−₹${abs}`;
}

export function ModifierGroupsPage() {
  const qc = useQueryClient();
  const businessId: string | undefined = getBusinessCache()?.id;

  const groupsQuery = useQuery<ModifierGroup[], unknown>({
    queryKey: ['modifier-groups'],
    queryFn: async () => {
      const r = await api.get(`/businesses/${businessId}/modifier-groups`);
      return (r.data.groups ?? []) as ModifierGroup[];
    },
    enabled: !!businessId,
  });
  const groups = groupsQuery.data ?? [];

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<GroupForm>(EMPTY_FORM);
  const [deleting, setDeleting] = useState<ModifierGroup | null>(null);

  // One mutation covers create + edit: the backend endpoint is a single
  // upsert (PUT), exactly like the mobile app uses. It returns the fresh
  // full list, so we seed the cache from the response instead of refetching.
  const save = useMutation({
    mutationFn: async (payload: ReturnType<typeof formToPayload>) => {
      const r = await api.put(`/businesses/${businessId}/modifier-groups`, payload);
      return (r.data.groups ?? []) as ModifierGroup[];
    },
    onSuccess: (fresh) => {
      qc.setQueryData(['modifier-groups'], fresh);
      toast.success(form.id ? 'Group updated' : 'Group created');
      setDialogOpen(false);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  // Soft delete: same PUT with isActive:false. We must resend the existing
  // options WITH their ids — Joi defaults `modifiers` to [] when omitted,
  // and the service deactivates every option missing from the array, so an
  // empty payload would wipe the group's options if it's ever reactivated.
  const remove = useMutation({
    mutationFn: async (g: ModifierGroup) => {
      const r = await api.put(`/businesses/${businessId}/modifier-groups`, {
        id: g.id,
        name: g.name,
        kind: g.kind,
        minSelect: g.minSelect,
        maxSelect: g.maxSelect,
        isActive: false,
        modifiers: g.modifiers.map((m) => ({
          id: m.id, name: m.name, priceDeltaInr: m.priceDeltaInr,
        })),
      });
      return (r.data.groups ?? []) as ModifierGroup[];
    },
    onSuccess: (fresh) => {
      qc.setQueryData(['modifier-groups'], fresh);
      toast.success('Group deleted');
      setDeleting(null);
    },
    onError: (e) => toast.error(apiError(e)),
  });

  const openCreate = () => { setForm(EMPTY_FORM); setDialogOpen(true); };
  const openEdit = (g: ModifierGroup) => { setForm(groupToForm(g)); setDialogOpen(true); };

  // "Required" is not a separate backend field — a group is required when the
  // customer must pick at least one option, i.e. minSelect >= 1. The checkbox
  // just drives minSelect so the two controls can never contradict.
  const isRequired = (parseInt(form.minSelect, 10) || 0) >= 1;
  const toggleRequired = (checked: boolean) =>
    setForm((f) => ({ ...f, minSelect: checked ? '1' : '0' }));

  const setKind = (kind: GroupKind) =>
    setForm((f) => ({
      ...f,
      kind,
      // Snap max down to 1 for single_select — mirrors the mobile app and the
      // save-time validation, so the user isn't surprised at submit.
      maxSelect: kind === 'single_select' ? '1' : f.maxSelect,
    }));

  const setOption = (i: number, patch: Partial<OptionDraft>) =>
    setForm((f) => ({
      ...f,
      options: f.options.map((o, idx) => (idx === i ? { ...o, ...patch } : o)),
    }));
  const addOption = () =>
    setForm((f) => ({ ...f, options: [...f.options, { id: null, name: '', priceDelta: '0' }] }));
  const removeOption = (i: number) =>
    setForm((f) => ({ ...f, options: f.options.filter((_, idx) => idx !== i) }));

  const submit = () => {
    // Same guardrails as the mobile screen — the backend doesn't enforce
    // min<=max or "single_select means max 1", but shipping a group that
    // violates them makes ordering UX incoherent.
    const min = parseInt(form.minSelect, 10) || 0;
    const max = parseInt(form.maxSelect, 10) || 0;
    if (!form.name.trim()) { toast.error('Group name is required'); return; }
    if (max < min) { toast.error('Max picks must be ≥ min picks'); return; }
    if (form.kind === 'single_select' && max > 1) {
      toast.error('Single-select groups can have max 1 pick'); return;
    }
    if (form.options.every((o) => o.name.trim() === '')) {
      toast.error('Add at least one option'); return;
    }
    save.mutate(formToPayload(form, true));
  };

  // 402 = plan gate (Starter). Distinguish it from a real failure so the
  // owner sees "upgrade" instead of a scary error — matches mobile behavior.
  const errStatus = (groupsQuery.error as { response?: { status?: number } } | null)
    ?.response?.status;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Modifier groups</h1>
          <p className="text-muted-foreground">
            Catalog-level option sets (Spice level, Toppings…) you can attach to menu items.
          </p>
        </div>
        <Button onClick={openCreate}><Plus className="mr-2 h-4 w-4" /> New group</Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {groupsQuery.isLoading ? (
            <div className="py-14 text-center text-muted-foreground">Loading modifier groups…</div>
          ) : groupsQuery.isError ? (
            <div className="py-14 text-center space-y-3">
              <p className="text-muted-foreground">
                {errStatus === 402
                  ? 'Modifier groups are a Pro feature. Upgrade your plan to manage them.'
                  : `Couldn't load modifier groups: ${apiError(groupsQuery.error)}`}
              </p>
              {errStatus !== 402 && (
                <Button variant="outline" onClick={() => groupsQuery.refetch()}>Retry</Button>
              )}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Rules</TableHead>
                  <TableHead className="text-right">Options</TableHead>
                  <TableHead className="w-24"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                      No modifier groups yet. Create one (e.g. "Spice level"), then attach it to
                      menu items from the Menu page.
                    </TableCell>
                  </TableRow>
                )}
                {groups.map((g) => (
                  <TableRow key={g.id}>
                    <TableCell className="font-medium">{g.name}</TableCell>
                    <TableCell>
                      <Badge variant={g.kind === 'multi_select' ? 'warning' : 'secondary'}>
                        {g.kind === 'multi_select' ? 'Pick many' : 'Pick 1'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      min {g.minSelect} · max {g.maxSelect}
                      {g.minSelect >= 1 && (
                        <Badge variant="destructive" className="ml-2">Required</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{g.modifiers.length}</TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openEdit(g)} title="Edit">
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setDeleting(g)} title="Delete">
                          <Trash2 className="h-4 w-4 text-destructive" />
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
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{form.id ? 'Edit modifier group' : 'New modifier group'}</DialogTitle>
            <DialogDescription>
              Options stack their price delta on the item price when picked.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <Label>Group name *</Label>
              <Input
                value={form.name}
                placeholder="Spice level, Toppings, Extras…"
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>Selection type</Label>
                {/* Native select — the ui kit has no shadcn Select; same
                    pattern ExpensesPage uses for its category picker. */}
                <select
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={form.kind}
                  onChange={(e) => setKind(e.target.value as GroupKind)}
                >
                  <option value="single_select">Pick 1</option>
                  <option value="multi_select">Pick many</option>
                </select>
              </div>
              <div>
                <Label>Min picks</Label>
                <Input
                  type="number" min={0}
                  value={form.minSelect}
                  onChange={(e) => setForm((f) => ({ ...f, minSelect: e.target.value }))}
                />
              </div>
              <div>
                <Label>Max picks</Label>
                <Input
                  type="number" min={0}
                  value={form.maxSelect}
                  disabled={form.kind === 'single_select'}
                  onChange={(e) => setForm((f) => ({ ...f, maxSelect: e.target.value }))}
                />
              </div>
            </div>

            {/* Native checkbox — no shadcn checkbox component in this repo,
                and pulling one in just for this would break the "one file"
                scope of the fix. */}
            <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-input accent-primary"
                checked={isRequired}
                onChange={(e) => toggleRequired(e.target.checked)}
              />
              <span>
                Required <span className="text-muted-foreground">
                  — customer must pick at least one option (sets min picks to 1)
                </span>
              </span>
            </label>

            <div className="space-y-2">
              <Label>Options</Label>
              {form.options.map((o, i) => (
                // Index keys are safe here: rows are only appended/removed via
                // controlled state and carry their full value as props.
                <div key={i} className="flex items-center gap-2">
                  <Input
                    className="flex-1"
                    placeholder="Option name (Mild, Hot…)"
                    value={o.name}
                    onChange={(e) => setOption(i, { name: e.target.value })}
                  />
                  <Input
                    className="w-28"
                    type="number" step="any"
                    placeholder="₹ delta"
                    title="Price delta in ₹ (0 if free, negative for discounts)"
                    value={o.priceDelta}
                    onChange={(e) => setOption(i, { priceDelta: e.target.value })}
                  />
                  <Button
                    variant="ghost" size="sm"
                    onClick={() => removeOption(i)}
                    // Keep one row so the form never renders option-less;
                    // save-time validation requires a named option anyway.
                    disabled={form.options.length === 1}
                    title="Remove option"
                  >
                    <X className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={addOption}>
                <Plus className="mr-1 h-4 w-4" /> Add option
              </Button>
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={save.isPending}>
              {save.isPending ? 'Saving…' : form.id ? 'Save changes' : 'Create group'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete confirm ───────────────────────────────────────────────── */}
      <Dialog open={deleting !== null} onOpenChange={(open) => { if (!open) setDeleting(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete "{deleting?.name}"?</DialogTitle>
            <DialogDescription>
              The group is deactivated and disappears from ordering and from items it's
              attached to. Past orders that used it are not affected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => deleting && remove.mutate(deleting)}
              disabled={remove.isPending}
            >
              {remove.isPending ? 'Deleting…' : 'Delete group'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
