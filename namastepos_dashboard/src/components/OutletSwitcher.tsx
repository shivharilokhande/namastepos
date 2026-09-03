// NamastePOS dashboard — outlet switcher + create-outlet dialog (2026-09-03).
//
// Founder placement: top-left of the shell, directly BELOW the business
// name. It lists every business the signed-in user is an active member of
// (GET /outlet-groups/my-outlets — NOT plan-gated, so a single-outlet
// tenant sees exactly one row and the control still reads correctly).
//
// Selecting another outlet runs the switch sequence in useOutletSwitch
// (new token → re-key business cache → queryClient.clear() → toast →
// navigate home). The control is disabled while that mutation is in
// flight so a second click can't leave a half-switched session.
//
// "+ Create new outlet" is owner-only in the UI and gated server-side on
// the `multi_outlet` feature. A 402 FEATURE_LOCKED opens the upsell
// dialog (Multi-outlet add-on / plan upgrade) instead of a red toast.

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Building2, Check, ChevronDown, Loader2, Plus } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from './ui/dialog';
import { ffApi, type MyOutlet } from '@/api/namastepos';
import { apiError, getBusinessCache } from '@/api/client';
import { cn } from '@/lib/utils';
import { MY_OUTLETS_KEY, featureLockedInfo, useMyOutlets, useOutletSwitch } from '@/hooks/useOutletSwitch';

// ── Upsell ───────────────────────────────────────────────────────────────
export function OutletUpsellDialog({
  open, onOpenChange, requiredTier,
}: { open: boolean; onOpenChange: (v: boolean) => void; requiredTier?: string }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Multi-outlet is a Pro feature</DialogTitle>
          <DialogDescription>
            Add the Multi-outlet add-on or upgrade
            {requiredTier ? ` to ${requiredTier}` : ' your plan'} to run more than
            one outlet from this account — each with its own menu, staff and
            reports, plus a consolidated revenue rollup across all of them.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button asChild variant="outline" onClick={() => onOpenChange(false)}>
            <Link to="/marketplace">Browse add-ons</Link>
          </Button>
          <Button asChild onClick={() => onOpenChange(false)}>
            <Link to="/billing">View plans</Link>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Create outlet ────────────────────────────────────────────────────────
export function CreateOutletDialog({
  open, onOpenChange, onLocked,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  // Called with the backend's requiredTier when the plan/addon doesn't
  // include multi_outlet, so the caller can raise the upsell.
  onLocked: (requiredTier?: string) => void;
}) {
  const queryClient = useQueryClient();
  const switcher = useOutletSwitch();
  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [city, setCity] = useState('');
  const [busy, setBusy] = useState(false);
  // Set after a successful create so we can offer "Switch to it now".
  const [created, setCreated] = useState<MyOutlet | null>(null);

  const reset = () => { setName(''); setLabel(''); setCity(''); setCreated(null); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { toast.error('Enter an outlet name'); return; }
    setBusy(true);
    try {
      const res = await ffApi.provisionOutlet({
        name: name.trim(),
        label: label.trim() || undefined,
        city: city.trim() || undefined,
      });
      queryClient.invalidateQueries({ queryKey: MY_OUTLETS_KEY });
      toast.success(`${res.outlet.name} created — it starts empty`);
      setCreated({
        businessId: res.outlet.id,
        name: res.outlet.name,
        outletLabel: res.outlet.outlet_label || res.outlet.name,
        city: res.outlet.city,
        groupId: res.groupId,
        groupName: null,
        isParent: false,
        role: 'business_owner',
        current: false,
      });
    } catch (err) {
      const locked = featureLockedInfo(err);
      if (locked) {
        onOpenChange(false);
        reset();
        onLocked(locked.requiredTier);
      } else {
        toast.error(apiError(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => { onOpenChange(v); if (!v) reset(); }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{created ? 'Outlet created' : 'Create a new outlet'}</DialogTitle>
          <DialogDescription>
            A new outlet starts <strong>completely empty</strong> — its own menu,
            tables, staff, orders, settings and reports. Nothing is shared with
            your other outlets except the group revenue rollup.
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { onOpenChange(false); reset(); }}>
              Stay here
            </Button>
            <Button
              disabled={switcher.isPending}
              onClick={() => { onOpenChange(false); switcher.mutate(created); }}
            >
              {switcher.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Switch to it now
            </Button>
          </DialogFooter>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <div>
              <Label>Outlet name *</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Chai Point — Koregaon Park"
                autoFocus
              />
            </div>
            <div>
              <Label>Short label</Label>
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Shown in the outlet switcher, e.g. Koregaon Park"
              />
            </div>
            <div>
              <Label>City</Label>
              <Input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Pune" />
            </div>
            <DialogFooter className="gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create outlet
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Switcher ─────────────────────────────────────────────────────────────
export function OutletSwitcher({ onNavigate }: { onNavigate?: () => void }) {
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [upsell, setUpsell] = useState<{ open: boolean; requiredTier?: string }>({ open: false });
  const wrapRef = useRef<HTMLDivElement>(null);
  const outletsQ = useMyOutlets();
  const switcher = useOutletSwitch();

  // Close on outside click / Escape — no dropdown primitive in ui/, so the
  // panel is a plain absolutely-positioned div (same approach as the
  // sidebar's other hand-rolled controls).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const outlets = outletsQ.data || [];
  const current = outlets.find((o) => o.current) || null;
  const currentLabel = current?.outletLabel || getBusinessCache()?.name || 'This outlet';
  const isOwner = (current?.role || getBusinessCache()?.role) === 'business_owner';
  const busy = switcher.isPending;

  const pick = (o: MyOutlet) => {
    setOpen(false);
    if (o.current) return;
    onNavigate?.();
    switcher.mutate(o);
  };

  return (
    <div className="px-3 mb-2" ref={wrapRef}>
      <div className="relative">
        <button
          type="button"
          disabled={busy}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label="Switch outlet"
          className="flex w-full items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-left text-xs hover:bg-accent disabled:opacity-60"
        >
          {busy
            ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
            : <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold leading-tight">{currentLabel}</span>
            <span className="block truncate text-[10px] text-muted-foreground">
              {busy ? 'Switching…' : (current?.groupName || 'Outlet')}
            </span>
          </span>
          <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-180')} />
        </button>

        {open && (
          <div className="absolute left-0 right-0 z-50 mt-1 overflow-hidden rounded-md border bg-card shadow-lg">
            <div className="max-h-64 overflow-y-auto py-1">
              {outletsQ.isLoading && (
                <div className="px-3 py-2 text-xs text-muted-foreground">Loading outlets…</div>
              )}
              {!outletsQ.isLoading && outlets.length === 0 && (
                <div className="px-3 py-2 text-xs text-muted-foreground">No outlets found.</div>
              )}
              {outlets.map((o) => (
                <button
                  key={o.businessId}
                  type="button"
                  disabled={busy}
                  onClick={() => pick(o)}
                  className="flex w-full items-start gap-2 px-3 py-2 text-left text-xs hover:bg-accent disabled:opacity-60"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate font-medium">{o.outletLabel || o.name}</span>
                      {o.isParent && (
                        <span className="rounded bg-primary/10 px-1 py-px text-[9px] font-bold uppercase tracking-wider text-primary">
                          HQ
                        </span>
                      )}
                    </span>
                    {o.city && <span className="block truncate text-[10px] text-muted-foreground">{o.city}</span>}
                  </span>
                  {o.current && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />}
                </button>
              ))}
            </div>
            {isOwner && (
              <button
                type="button"
                disabled={busy}
                onClick={() => { setOpen(false); setCreateOpen(true); }}
                className="flex w-full items-center gap-2 border-t px-3 py-2 text-left text-xs font-medium text-primary hover:bg-accent disabled:opacity-60"
              >
                <Plus className="h-3.5 w-3.5" /> Create new outlet
              </button>
            )}
          </div>
        )}
      </div>

      <CreateOutletDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onLocked={(requiredTier) => setUpsell({ open: true, requiredTier })}
      />
      <OutletUpsellDialog
        open={upsell.open}
        onOpenChange={(v) => setUpsell((u) => ({ ...u, open: v }))}
        requiredTier={upsell.requiredTier}
      />
    </div>
  );
}
