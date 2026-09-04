// NamastePOS dashboard — First-time setup wizard (FF-217).
//
// Shown automatically on `/onboarding` after a fresh signup. It runs
// through four short steps and calls the existing backend endpoints:
//
//   1. Business profile — POST /auth/me (name, phone, city, category)
//   2. Floor + tables   — POST /ops/floors, POST /ops/tables (×N)
//   3. Menu items       — POST /menu (×N) — quick "name + price" only
//   4. Done             — PATCH /auth/me {onboarded: true} + navigate home
//
// The wizard is skippable at any step (owner may prefer to configure
// individually later). Skip still flips onboarded=true so the wizard
// doesn't come back on every login.

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ChevronRight, Store, LayoutGrid, UtensilsCrossed, Sparkles, Plus, X, Check,
} from 'lucide-react';

import { ffApi } from '@/api/namastepos';
import { apiError } from '@/api/client';
import { trackMenuReadyFromServer } from '@/lib/activation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Step = 0 | 1 | 2 | 3;

interface DraftTable {
  label: string;
  seats: number;
}
interface DraftItem {
  name: string;
  price: string;   // string so the input stays controlled
}

const CATEGORIES = ['Café', 'Restaurant', 'QSR', 'Bar', 'Cloud kitchen', 'Bakery', 'Street food', 'Other'];

export function SetupWizardPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>(0);

  // ── Step 1 state ───────────────────────────────────────────────────
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [city, setCity] = useState('');
  const [category, setCategory] = useState('Café');
  // FF-252 — service model. Hybrid = per-table decides (safe default).
  const [serviceMode, setServiceMode] = useState<'hybrid' | 'dine_in' | 'self_pickup'>('hybrid');

  // ── Step 2 state ───────────────────────────────────────────────────
  const [floorName, setFloorName] = useState('Ground floor');
  const [tables, setTables] = useState<DraftTable[]>([
    { label: '1', seats: 4 },
    { label: '2', seats: 4 },
    { label: '3', seats: 2 },
  ]);

  // ── Step 3 state ───────────────────────────────────────────────────
  const [items, setItems] = useState<DraftItem[]>([
    { name: 'Masala Chai', price: '30' },
    { name: 'Butter Naan', price: '40' },
    { name: 'Paneer Tikka', price: '250' },
  ]);

  const [busy, setBusy] = useState(false);

  // ── Step 3, the wall (2026-09-05) ─────────────────────────────────────
  //
  // This step used to be three name+price boxes and a "you can bulk-import a
  // CSV later" tip. An owner with a 40-dish menu reads that as "type it all,
  // one box at a time", which is the 45-90 minute wall the activation audit
  // named as the top reason a trial dies on day one. Now the DEFAULT is a
  // starter menu for their format, and typing is the fallback.
  const [menuMode, setMenuMode] = useState<'template' | 'manual'>('template');
  const [templateSlug, setTemplateSlug] = useState<string | null>(null);
  const { data: menuTemplates = [] } = useQuery<any[]>({
    queryKey: ['menu-templates'],
    queryFn: ffApi.listMenuTemplates,
    staleTime: 60 * 60 * 1000,
  });

  // FF-217c helper: swallow "already exists" (409) so the wizard is
  // idempotent — the user can complete it even if some rows were
  // created out-of-band (e.g. their previous session's autosave).
  const swallowDup = async <T,>(p: Promise<T>): Promise<T | null> => {
    try { return await p; } catch (e: any) {
      const s = e?.response?.status;
      if (s === 409) return null;
      // Backend sometimes surfaces 400 for duplicate business names.
      // Detect by message so we don't hide real validation errors.
      const msg = String(e?.response?.data?.message || '').toLowerCase();
      if (s === 400 && (msg.includes('already') || msg.includes('duplicate') || msg.includes('exists'))) {
        return null;
      }
      throw e;
    }
  };

  const finish = useMutation({
    mutationFn: async () => {
      // 1. Profile — only send fields the user actually filled in so a
      // pre-existing business's name isn't clobbered by a blank input.
      const profilePatch: any = {};
      if (name.trim()) profilePatch.name = name.trim();
      if (phone.trim()) profilePatch.phone = phone.trim();
      if (city.trim()) profilePatch.city = city.trim();
      if (category) profilePatch.category = category;
      profilePatch.default_service_mode = serviceMode;   // FF-252
      if (Object.keys(profilePatch).length > 0) {
        await swallowDup(ffApi.patchMe(profilePatch));
      }

      // 2. Floor + tables — check what's already there first, so
      // re-running the wizard on a partially-set-up business doesn't
      // trip UNIQUE(business_id, name) constraints on floors/tables.
      const existingFloors = await ffApi.listFloors().catch(() => []);
      const existingTables = await ffApi.listOpsTables().catch(() => []);
      const floorNameNorm = (floorName || 'Ground floor').trim().toLowerCase();
      let floor: any = (existingFloors as any[])
        .find((f: any) => (f.name || '').toLowerCase() === floorNameNorm);
      if (!floor && tables.length > 0) {
        floor = await swallowDup(ffApi.createFloor({ name: floorName || 'Ground floor' }));
        if (!floor) floor = (existingFloors as any[])[0];  // fallback if it now exists
      }
      const existingLabels = new Set(
        (existingTables as any[]).map((t: any) => String(t.label).toLowerCase())
      );
      for (const t of tables) {
        if (!t.label.trim()) continue;
        if (existingLabels.has(t.label.toLowerCase())) continue;
        await swallowDup(ffApi.createOpsTable({
          label: t.label,
          seats: Number(t.seats) || 2,
          floorId: floor?.id,
        }));
      }

      // 3. Menu — a starter template if they picked one, otherwise the typed
      //    rows. The template path is idempotent server-side (it skips any
      //    name the business already has), so re-running the wizard is safe
      //    and cannot duplicate or re-price anything.
      let templateApplied = 0;
      if (menuMode === 'template' && templateSlug) {
        const r: any = await ffApi.applyMenuTemplate(templateSlug);
        templateApplied = r?.inserted ?? 0;
      } else {
        const existingMenu = await ffApi.listMenu().catch(() => []);
        const existingItemNames = new Set(
          (existingMenu as any[]).map((m: any) => (m.name || '').toLowerCase())
        );
        for (const it of items) {
          const n = it.name.trim();
          if (!n) continue;
          if (existingItemNames.has(n.toLowerCase())) continue;
          await swallowDup(ffApi.createMenuItem({
            name: n,
            price: Number(it.price) || 0,
          }));
        }
      }
      // 4. Mark onboarded — flips the gate so the wizard never returns.
      await ffApi.patchMe({ onboarded: true });
      return { templateApplied };
    },
    onSuccess: (r) => {
      qc.invalidateQueries();
      // Activation funnel — `menu_ready`. Reads the menu back from the server
      // so the count is the real total, and countOwnerAuthored() discards the
      // three untouched pre-fills above (Masala Chai 30 / Butter Naan 40 /
      // Paneer Tikka 250) — clicking "Finish setup" without editing anything
      // must not count as a ready menu.
      //
      // The SOURCE is 'template' when a starter menu did the work and
      // 'wizard' when the owner typed. Those are the two arms of the whole
      // experiment; collapsing them into one source would make the result
      // unreadable.
      trackMenuReadyFromServer(r?.templateApplied ? 'template' : 'wizard');
      toast.success('Setup complete! Welcome to NamastePOS.');
      nav('/', { replace: true });
    },
    onError: (e) => toast.error(apiError(e)),
    onSettled: () => setBusy(false),
  });

  const skip = useMutation({
    mutationFn: () => ffApi.patchMe({ onboarded: true }),
    onSuccess: () => { qc.invalidateQueries(); nav('/', { replace: true }); },
    onError: (e) => toast.error(apiError(e)),
  });

  const stepMeta = [
    { icon: Store,          title: 'Tell us about your business' },
    { icon: LayoutGrid,     title: 'Add your tables' },
    { icon: UtensilsCrossed,title: 'Add a few menu items' },
    { icon: Sparkles,       title: 'Ready to serve!' },
  ][step];

  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-50 via-white to-orange-50 flex items-center justify-center p-4">
      <Card className="w-full max-w-2xl shadow-lg border-orange-100">
        <CardHeader className="border-b">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary/10 grid place-items-center text-primary">
              <stepMeta.icon className="w-5 h-5" />
            </div>
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">
                Step {step + 1} of 4
              </div>
              <CardTitle>{stepMeta.title}</CardTitle>
            </div>
          </div>
          <div className="flex gap-1 mt-3">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className={`h-1 flex-1 rounded ${i <= step ? 'bg-primary' : 'bg-muted'}`} />
            ))}
          </div>
        </CardHeader>

        <CardContent className="p-6 space-y-4">
          {step === 0 && (
            <div className="space-y-3">
              <div>
                <Label>Business name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Cafe Sugar & Spice" autoFocus />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Phone</Label>
                  <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="9876543210" />
                </div>
                <div>
                  <Label>City</Label>
                  <Input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Mumbai" />
                </div>
              </div>
              <div>
                <Label>Category</Label>
                <select value={category} onChange={(e) => setCategory(e.target.value)}
                  className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm">
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              {/* FF-252 — service style. Drives what happens when the
                  kitchen marks an order ready: dine-in silences the
                  "come collect" WhatsApp (waiter delivers to the
                  table), self-pickup keeps it. Hybrid = per-table. */}
              <div>
                <Label>How do customers get their food?</Label>
                <div className="grid grid-cols-1 gap-2 mt-1">
                  {[
                    { v: 'dine_in',     t: 'Dine-in',      d: 'Waiter serves at the table (restaurants, sit-down cafés)' },
                    { v: 'self_pickup', t: 'Self-pickup',  d: 'Guests collect from the counter (street stalls, cloud kitchens, quick-serve)' },
                    { v: 'hybrid',      t: 'Both — depends on the table', d: 'Set service style per table later (mixed venues, food courts)' },
                  ].map((o) => (
                    <label key={o.v} className={`flex gap-2 p-3 border rounded-md cursor-pointer ${serviceMode === o.v ? 'border-primary bg-primary/5' : 'border-input'}`}>
                      <input type="radio" name="svcmode" value={o.v}
                        checked={serviceMode === o.v}
                        onChange={() => setServiceMode(o.v as any)}
                        className="mt-1" />
                      <div>
                        <div className="text-sm font-medium">{o.t}</div>
                        <div className="text-xs text-muted-foreground">{o.d}</div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-3">
              <div>
                <Label>Floor name</Label>
                <Input value={floorName} onChange={(e) => setFloorName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Tables ({tables.length})</Label>
                {tables.map((t, i) => (
                  <div key={i} className="flex gap-2 items-center">
                    <Input value={t.label} onChange={(e) => {
                      const next = [...tables]; next[i] = { ...t, label: e.target.value }; setTables(next);
                    }} placeholder="1" className="w-24" />
                    <Input type="number" value={t.seats} onChange={(e) => {
                      const next = [...tables]; next[i] = { ...t, seats: Number(e.target.value) || 0 }; setTables(next);
                    }} placeholder="seats" className="w-28" />
                    <span className="text-xs text-muted-foreground">seats</span>
                    <Button size="sm" variant="ghost" onClick={() => setTables(tables.filter((_, x) => x !== i))}>
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                ))}
                <Button size="sm" variant="outline" onClick={() =>
                  setTables([...tables, { label: String(tables.length + 1), seats: 4 }])
                }>
                  <Plus className="w-3.5 h-3.5 mr-1" /> Add table
                </Button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3">
              {/* Do not type your menu. That is the whole point of this step. */}
              <div className="flex gap-2">
                <button
                  onClick={() => setMenuMode('template')}
                  className={`flex-1 rounded-md border p-2 text-sm font-medium ${
                    menuMode === 'template' ? 'border-primary bg-primary/5 text-primary' : 'border-input'}`}
                >
                  Start with a ready menu
                </button>
                <button
                  onClick={() => setMenuMode('manual')}
                  className={`flex-1 rounded-md border p-2 text-sm font-medium ${
                    menuMode === 'manual' ? 'border-primary bg-primary/5 text-primary' : 'border-input'}`}
                >
                  I&apos;ll type a few items
                </button>
              </div>

              {menuMode === 'template' && (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    Pick the closest kind of kitchen. Items, categories and GST
                    come pre-filled — change any price later, in the middle of
                    the rush if you have to. Nothing you already added is touched.
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-72 overflow-y-auto">
                    {menuTemplates.map((t) => (
                      <button
                        key={t.slug}
                        onClick={() => setTemplateSlug(t.slug === templateSlug ? null : t.slug)}
                        className={`text-left rounded-md border p-2.5 ${
                          templateSlug === t.slug
                            ? 'border-primary bg-primary/5'
                            : 'border-input hover:bg-accent'}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium">{t.name}</span>
                          {templateSlug === t.slug
                            ? <Check className="w-4 h-4 text-primary shrink-0" />
                            : <span className="text-[10px] text-muted-foreground shrink-0">{t.itemCount} items</span>}
                        </div>
                        {t.tagline && (
                          <div className="text-[11px] text-muted-foreground mt-0.5">{t.tagline}</div>
                        )}
                      </button>
                    ))}
                    {menuTemplates.length === 0 && (
                      <div className="text-xs text-muted-foreground p-2 sm:col-span-2">
                        Couldn&apos;t load the ready menus. Type a few items instead —
                        you can load one any time from the Menu page.
                      </div>
                    )}
                  </div>
                  {!templateSlug && (
                    <div className="text-xs text-muted-foreground">
                      Nothing picked yet. Choose one, or switch to typing.
                    </div>
                  )}
                </div>
              )}

              {menuMode === 'manual' && (
                <div className="space-y-3">
                  <Label>Menu items ({items.length})</Label>
                  {items.map((it, i) => (
                    <div key={i} className="flex gap-2 items-center">
                      <Input value={it.name} onChange={(e) => {
                        const next = [...items]; next[i] = { ...it, name: e.target.value }; setItems(next);
                      }} placeholder="Item name" className="flex-1" />
                      <Input value={it.price} onChange={(e) => {
                        const next = [...items]; next[i] = { ...it, price: e.target.value }; setItems(next);
                      }} placeholder="₹" className="w-24" type="number" />
                      <Button size="sm" variant="ghost" onClick={() => setItems(items.filter((_, x) => x !== i))}>
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  ))}
                  <Button size="sm" variant="outline" onClick={() => setItems([...items, { name: '', price: '' }])}>
                    <Plus className="w-3.5 h-3.5 mr-1" /> Add item
                  </Button>
                  <div className="text-xs text-muted-foreground pt-1">
                    Three items is enough to print your first bill. The Menu page
                    can load a ready menu, take a pasted menu, or import a CSV
                    whenever you want the rest.
                  </div>
                </div>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="text-center py-6 space-y-3">
              <div className="text-3xl">🎉</div>
              <div className="text-lg font-semibold">Almost there, {name || 'friend'}!</div>
              <div className="text-sm text-muted-foreground max-w-md mx-auto">
                We&apos;ll create <strong>{tables.length}</strong> table{tables.length === 1 ? '' : 's'} on
                &nbsp;<strong>{floorName}</strong> and{' '}
                {menuMode === 'template' && templateSlug ? (
                  <>load the{' '}
                    <strong>
                      {menuTemplates.find((t) => t.slug === templateSlug)?.name || 'starter'}
                    </strong>{' '}
                    menu (
                    <strong>
                      {menuTemplates.find((t) => t.slug === templateSlug)?.itemCount ?? '—'}
                    </strong>{' '}
                    items)
                  </>
                ) : (
                  <>add <strong>{items.filter((i) => i.name.trim()).length}</strong> menu items</>
                )}.
                You can edit everything from the dashboard afterwards.
              </div>
            </div>
          )}
        </CardContent>

        <div className="flex justify-between items-center p-6 border-t bg-muted/30">
          <button
            onClick={() => skip.mutate()}
            className="text-xs text-muted-foreground hover:underline disabled:opacity-40"
            disabled={busy || skip.isPending}
          >
            Skip for now
          </button>
          <div className="flex gap-2">
            {step > 0 && (
              <Button variant="outline" onClick={() => setStep((s) => (s - 1) as Step)} disabled={busy}>
                Back
              </Button>
            )}
            {step < 3 ? (
              <Button onClick={() => setStep((s) => (s + 1) as Step)} disabled={busy}>
                Continue <ChevronRight className="ml-1 w-4 h-4" />
              </Button>
            ) : (
              <Button
                onClick={() => { setBusy(true); finish.mutate(); }}
                disabled={busy || finish.isPending}
              >
                {finish.isPending ? 'Setting up…' : 'Finish setup'}
              </Button>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
