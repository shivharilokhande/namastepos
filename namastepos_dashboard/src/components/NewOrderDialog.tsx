// NamastePOS dashboard — walk-in / counter POS dialog.
//
// Features wired:
//   • Source picker (Dine-in / Takeaway) + table chooser
//   • Item variants (Half/Full/Medium chips below the parent)
//   • Modifier groups — tap an item with modifiers → modal picker
//     (Spice level, +Extra cheese ₹30, etc.) before adding to cart
//   • Cart with per-line variant + modifier capture (so 2× "no onion" and
//     1× "extra cheese" coexist as separate lines)
//   • Upsell suggestions strip — "Customers also ordered…"
//   • Voice command — "two paneer tikka one naan" → parses into cart
//   • Customer phone autocomplete + auto-apply active membership discount
//   • Returning-customer name autofill + "N visits" hint (Bug #3a, 2026-08-25)
//   • Per-line order notes — "No onions, less spicy…" (Bug #3b, 2026-08-25)
//   • Save KOT (postpaid, dine-in only) vs Pay & place (immediate)

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Plus, Minus, Search, Trash2, ShoppingCart, Sparkles, Crown, StickyNote, History,
} from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { ffApi } from '@/api/namastepos';
import { apiError } from '@/api/client';
import { formatINR } from '@/lib/utils';
import { VoiceCommand, parseSpokenOrder } from '@/components/VoiceCommand';

type ModLine = { modifierId: string; name: string; priceDeltaInr: number; qty: number };
type CartLine = {
  lineKey: string;          // unique row id (multiple modifier combos per item)
  menuItemId: string;
  name: string;
  price: number;            // already includes variant + modifier deltas per unit
  qty: number;
  variantId?: string | null;
  variantLabel?: string | null;
  modifierLines?: ModLine[];
  note?: string;
};

type PreviousLine = { name: string; qty: number; price: number; lineTotal: number };

type Props = {
  onClose: () => void;
  existingSession?: { id: string; tableId: string; tableLabel?: string;
                      customerPhone?: string; customerName?: string } | null;
  previousItems?: PreviousLine[];
  previousSubtotalInr?: number;
};

export function NewOrderDialog({
  onClose, existingSession = null,
  previousItems = [], previousSubtotalInr = 0,
}: Props) {
  const qc = useQueryClient();

  // ── State ──────────────────────────────────────────────────────────────
  const [source, setSource] = useState<'dineIn' | 'takeaway'>('dineIn');
  const [tableNo, setTableNo] = useState(existingSession?.tableLabel || '');
  const [tableId, setTableId] = useState(existingSession?.tableId || '');
  const [customerPhone, setCustomerPhone] = useState(existingSession?.customerPhone || '');
  const [customerName, setCustomerName] = useState(existingSession?.customerName || '');
  // Bug #3a (2026-08-25): true once the cashier types in the name box.
  // Autofill from the phone lookup must never clobber a manually typed name
  // (e.g. staff correcting a misspelled name on file), so we gate on this.
  const [nameEditedByUser, setNameEditedByUser] = useState(false);
  // Bug #3b (2026-08-25): which cart lines have their note input expanded.
  // Keyed by lineKey (not menuItemId) so two lines of the same item can carry
  // different notes — matches the mobile app's per-line note model.
  const [noteOpen, setNoteOpen] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [tax, setTax] = useState(0);
  const [discount, setDiscount] = useState(0);
  const [discountIsPreTax, setDiscountIsPreTax] = useState(true);
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'upi' | 'card' | 'unpaid'>(
    existingSession ? 'unpaid' : 'cash'
  );
  // Modifier picker state
  const [configuring, setConfiguring] = useState<any | null>(null);
  // Last added item — used to fetch upsell suggestions
  const [lastAddedItemId, setLastAddedItemId] = useState<string | null>(null);

  // ── Data ──────────────────────────────────────────────────────────────
  const { data: menu = [] } = useQuery({ queryKey: ['menu'], queryFn: () => ffApi.listMenu() });
  const { data: tables = [] } = useQuery({ queryKey: ['ops-tables'], queryFn: () => ffApi.listOpsTables() });
  const { data: modGroups = [] } = useQuery({
    queryKey: ['modifier-groups'], queryFn: () => ffApi.listModifierGroups(),
  });
  const { data: upsell = [] } = useQuery({
    queryKey: ['upsell', lastAddedItemId],
    queryFn: () => lastAddedItemId ? ffApi.upsellFor(lastAddedItemId) : Promise.resolve([]),
    enabled: !!lastAddedItemId,
  });
  // Customer profile (loyalty + active membership) — auto-loaded once phone is typed
  const { data: customerProfile } = useQuery({
    queryKey: ['cust-profile', customerPhone],
    queryFn: () => ffApi.customerProfile(customerPhone),
    enabled: customerPhone.length >= 7,
    retry: false,
  });

  // Auto-apply membership discount when a member walks in
  useEffect(() => {
    const mb = customerProfile?.activeMembership;
    if (mb?.benefits?.discount_pct && !discount) {
      const subtotalNow = cart.reduce((s, l) => s + l.price * l.qty, 0);
      const pct = Number(mb.benefits.discount_pct);
      const d = +(subtotalNow * pct / 100).toFixed(2);
      if (d > 0) {
        setDiscount(d);
        toast.success(`Member discount ${pct}% applied (${formatINR(d)})`);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerProfile]);

  // Bug #3a (2026-08-25): auto-fill the customer's name once the phone lookup
  // matches. The profile was already fetched for loyalty/memberships — staff
  // were still retyping names we had on file. Fill only when the field is
  // empty or untouched, so manual typing always wins over the lookup.
  useEffect(() => {
    const known = customerProfile?.customer?.name;
    if (known && (!customerName.trim() || !nameEditedByUser)) {
      setCustomerName(known);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerProfile]);

  // ── Cart helpers ──────────────────────────────────────────────────────
  const _addLine = (line: Omit<CartLine, 'lineKey'>) => {
    const lineKey = [
      line.menuItemId, line.variantId || '',
      ...(line.modifierLines || []).map((m) => m.modifierId).sort(),
    ].join('|');
    setCart((c) => {
      const existing = c.find((x) => x.lineKey === lineKey);
      if (existing) {
        return c.map((x) => x.lineKey === lineKey ? { ...x, qty: x.qty + line.qty } : x);
      }
      return [...c, { ...line, lineKey }];
    });
    setLastAddedItemId(line.menuItemId);
  };

  const addItem = (item: any) => {
    const hasVariants = Array.isArray(item.variants) && item.variants.length > 0;
    const hasMods = Array.isArray(item.modifierGroupIds) && item.modifierGroupIds.length > 0;
    if (hasVariants || hasMods) {
      setConfiguring(item);
      return;
    }
    _addLine({ menuItemId: item.id, name: item.name, price: parseFloat(item.price), qty: 1 });
  };

  const bump = (lineKey: string, delta: number) => {
    setCart((c) => {
      return c.map((x) => x.lineKey === lineKey ? { ...x, qty: x.qty + delta } : x)
              .filter((x) => x.qty > 0);
    });
  };
  const remove = (lineKey: string) => setCart((c) => c.filter((x) => x.lineKey !== lineKey));

  // Bug #3b (2026-08-25): per-line kitchen note ("No onions"). Stored on the
  // cart line so the KOT prints it against the exact item, same as mobile.
  const setLineNote = (lineKey: string, note: string) => {
    setCart((c) => c.map((x) => (x.lineKey === lineKey ? { ...x, note } : x)));
  };
  const toggleNote = (lineKey: string) => {
    setNoteOpen((prev) => ({ ...prev, [lineKey]: !prev[lineKey] }));
  };

  // Subtotal from cart
  const subtotal = useMemo(() => cart.reduce((s, l) => s + l.price * l.qty, 0), [cart]);
  let total: number;
  if (discountIsPreTax) total = Math.max(0, subtotal - Number(discount) + Number(tax));
  else total = Math.max(0, subtotal + Number(tax) - Number(discount));

  // ── Menu filter / categories ──────────────────────────────────────────
  const filteredMenu = useMemo(() => {
    const q = search.trim().toLowerCase();
    return menu
      .filter((m: any) => m.isActive !== false && !m.soldOutUntil)
      .filter((m: any) => !q || m.name.toLowerCase().includes(q));
  }, [menu, search]);

  const grouped = useMemo(() => {
    const g: Record<string, any[]> = {};
    for (const m of filteredMenu) (g[m.category || 'Other'] ||= []).push(m);
    return g;
  }, [filteredMenu]);

  // ── Voice command → parse + match menu items ─────────────────────────
  const onVoice = (text: string) => {
    const parsed = parseSpokenOrder(text);
    let matched = 0;
    for (const p of parsed) {
      const m = filteredMenu.find((it: any) =>
        it.name.toLowerCase().includes(p.name.toLowerCase()));
      if (m) {
        for (let i = 0; i < p.qty; i += 1) addItem(m);
        matched += p.qty;
      }
    }
    if (matched > 0) toast.success(`Added ${matched} item(s) from voice`);
    else toast.error(`Could not match: "${text}"`);
  };

  // ── Submit ────────────────────────────────────────────────────────────
  const create = useMutation({
    mutationFn: async (mode: 'pay' | 'kot') => {
      if (cart.length === 0) throw new Error('Add at least one item');
      if (source === 'dineIn' && !tableId && !existingSession) {
        throw new Error('Pick a table for dine-in');
      }
      const body: any = {
        source,
        tableNo: source === 'dineIn' ? (tableNo || null) : null,
        tableId: source === 'dineIn' ? (tableId || null) : null,
        tableSessionId: existingSession?.id || null,
        items: cart.map((l) => ({
          menuItemId: l.menuItemId,
          name: l.name,
          price: l.price,
          qty: l.qty,
          variantId: l.variantId || null,
          variantLabel: l.variantLabel || null,
          modifierLines: l.modifierLines || null,
          // Bug #3b (2026-08-25): backend Joi item schema expects `note`
          // (singular, ≤500 chars, allows null) — same field mobile sends.
          note: l.note?.trim() || null,
        })),
        tax, discount,
        discountIsPreTax,
        paymentMethod: mode === 'kot' ? 'unpaid' : paymentMethod,
        clientId: typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID() : undefined,
      };
      if (customerPhone) {
        body.customerPhone = customerPhone;
        if (customerName) body.customerName = customerName;
      }
      return ffApi.createOrder(body);
    },
    onSuccess: (o: any, mode) => {
      toast.success(mode === 'kot' ? `KOT #${o.orderNo} sent` : `Order #${o.orderNo} placed`);
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['ops-tables'] });
      if (existingSession) qc.invalidateQueries({ queryKey: ['session', existingSession.id] });
      onClose();
    },
    onError: (e: any) => toast.error(apiError(e) || e.message || 'Failed'),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-5xl w-[95vw] max-h-[92vh] overflow-hidden flex flex-col p-0">
        <DialogHeader className="px-6 py-4 border-b">
          <DialogTitle className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2"><ShoppingCart className="h-5 w-5 text-primary" /> Take new order</span>
            <VoiceCommand onText={onVoice} />
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-hidden grid grid-cols-1 md:grid-cols-[1fr_360px]">
          {/* LEFT — menu picker */}
          <div className="overflow-y-auto p-6 space-y-4 border-r">
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => setSource('dineIn')}
                className={`p-3 rounded-lg border text-sm font-semibold transition-colors ${
                  source === 'dineIn' ? 'border-primary bg-primary/10 text-primary' : 'border-input hover:bg-accent'
                }`}>🍽️ Dine-in</button>
              <button onClick={() => setSource('takeaway')}
                className={`p-3 rounded-lg border text-sm font-semibold transition-colors ${
                  source === 'takeaway' ? 'border-primary bg-primary/10 text-primary' : 'border-input hover:bg-accent'
                }`}>🥡 Takeaway</button>
            </div>

            {source === 'dineIn' && !existingSession && (
              <div>
                <Label>Table</Label>
                <select value={tableId}
                  onChange={(e) => {
                    const t = tables.find((x: any) => x.id === e.target.value);
                    setTableId(e.target.value); setTableNo(t?.label || '');
                  }}
                  className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                  <option value="">— Pick a table —</option>
                  {tables.map((t: any) => (
                    <option key={t.id} value={t.id}>Table {t.label} ({t.seats} seats) — {t.status}</option>
                  ))}
                </select>
              </div>
            )}

            {existingSession && (
              <div className="rounded-lg border border-primary bg-primary/5 p-3 text-sm">
                <div className="font-semibold text-primary">
                  Adding to Table {existingSession.tableLabel || tableNo}'s bill
                </div>
                {previousSubtotalInr > 0 && (
                  <div className="text-xs text-muted-foreground mt-0.5">
                    So far: <strong>{formatINR(previousSubtotalInr)}</strong>
                  </div>
                )}
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label>Customer phone <span className="text-muted-foreground text-xs">(loyalty + memberships)</span></Label>
                <Input value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)}
                  placeholder="9876543210" inputMode="numeric" className="mt-1" />
              </div>
              <div>
                <Label>Customer name</Label>
                <Input value={customerName}
                  onChange={(e) => {
                    setCustomerName(e.target.value);
                    // Manual typing locks out autofill for this dialog (Bug #3a)
                    setNameEditedByUser(true);
                  }}
                  placeholder="Walk-in" className="mt-1" />
              </div>
            </div>

            {/* Returning-customer hint (Bug #3a, 2026-08-25). visit count =
                customer.totalOrders from the customer-history endpoint —
                there is no separate visits column, orders are the proxy. */}
            {customerProfile?.customer && (
              <div className="text-xs text-muted-foreground flex items-center gap-1.5 -mt-2">
                <History className="h-3.5 w-3.5" />
                <span>
                  Returning customer · {customerProfile.customer.totalOrders ?? 0}
                  {' '}{(customerProfile.customer.totalOrders ?? 0) === 1 ? 'visit' : 'visits'}
                </span>
              </div>
            )}

            {/* Customer profile + active membership badge */}
            {customerProfile?.activeMembership && (
              <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 flex items-center gap-2">
                <Crown className="h-4 w-4" />
                <span>
                  <strong>{customerProfile.customer.name || customerPhone}</strong> is a member ·
                  {' '}{customerProfile.activeMembership.name} — discount auto-applied
                </span>
              </div>
            )}

            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input placeholder="Search menu…" className="pl-9"
                value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>

            {Object.entries(grouped).map(([cat, items]) => (
              <div key={cat}>
                <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-2">{cat}</div>
                <div className="grid grid-cols-2 gap-2">
                  {items.map((m: any) => (
                    <button key={m.id} onClick={() => addItem(m)}
                      className="flex items-center justify-between p-3 rounded-lg border bg-card hover:bg-accent text-left transition-colors">
                      <div className="min-w-0">
                        <div className="font-medium truncate flex items-center gap-1">
                          {m.name}
                          {Array.isArray(m.variants) && m.variants.length > 0 && (
                            <span className="text-[9px] bg-blue-100 text-blue-700 px-1 rounded">VAR</span>
                          )}
                          {Array.isArray(m.modifierGroupIds) && m.modifierGroupIds.length > 0 && (
                            <span className="text-[9px] bg-purple-100 text-purple-700 px-1 rounded">MOD</span>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground">{formatINR(m.price)}</div>
                      </div>
                      <Plus className="h-4 w-4 text-primary shrink-0" />
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* RIGHT — cart */}
          <div className="flex flex-col bg-muted/30">
            <div className="px-5 py-3 border-b flex items-center justify-between">
              <div className="font-semibold">{existingSession ? 'Running bill' : 'Cart'}</div>
              <Badge variant="secondary">{cart.length} {cart.length === 1 ? 'line' : 'lines'}</Badge>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {existingSession && previousItems.length > 0 && (
                <div>
                  <div className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground mb-1.5">
                    Already sent ({previousItems.length})
                  </div>
                  <div className="bg-card/60 border rounded-lg divide-y">
                    {previousItems.map((p, i) => (
                      <div key={i} className="px-3 py-2 flex items-start justify-between gap-2 text-sm">
                        <div className="min-w-0 flex-1">
                          <div className="font-medium truncate">{p.name}</div>
                          <div className="text-xs text-muted-foreground">{p.qty} × {formatINR(p.price)}</div>
                        </div>
                        <div className="text-sm font-medium whitespace-nowrap text-muted-foreground">{formatINR(p.lineTotal)}</div>
                      </div>
                    ))}
                    <div className="px-3 py-1.5 flex justify-between text-xs bg-muted/50">
                      <span className="text-muted-foreground">Subtotal so far</span>
                      <strong>{formatINR(previousSubtotalInr)}</strong>
                    </div>
                  </div>
                </div>
              )}

              {cart.length === 0 && (
                <div className="text-center text-sm text-muted-foreground py-8">
                  Tap an item or use voice ("two paneer tikka").
                </div>
              )}
              {cart.map((l) => (
                <div key={l.lineKey} className="bg-card border rounded-lg p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-sm truncate">{l.name}</div>
                      {l.variantLabel && <div className="text-xs text-blue-700">· {l.variantLabel}</div>}
                      {Array.isArray(l.modifierLines) && l.modifierLines.length > 0 && (
                        <div className="text-xs text-purple-700">+ {l.modifierLines.map((m) => m.name).join(', ')}</div>
                      )}
                      <div className="text-xs text-muted-foreground">{formatINR(l.price)} each</div>
                    </div>
                    <div className="flex items-center gap-0.5">
                      {/* Bug #3b (2026-08-25): note toggle — amber when a
                          note is set so it stays discoverable when collapsed */}
                      <button onClick={() => toggleNote(l.lineKey)}
                        className="p-1 hover:bg-accent rounded" title="Kitchen note">
                        <StickyNote className={`h-3 w-3 ${l.note ? 'text-amber-600' : 'text-muted-foreground'}`} />
                      </button>
                      <button onClick={() => remove(l.lineKey)} className="p-1 hover:bg-accent rounded">
                        <Trash2 className="h-3 w-3 text-destructive" />
                      </button>
                    </div>
                  </div>
                  {noteOpen[l.lineKey] ? (
                    <Input value={l.note || ''} autoFocus maxLength={500}
                      onChange={(e) => setLineNote(l.lineKey, e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') toggleNote(l.lineKey); }}
                      placeholder="No onions, less spicy…"
                      className="mt-2 h-7 text-xs" />
                  ) : l.note ? (
                    // Collapsed preview — mirrors mobile's quoted-note row
                    <div className="mt-1 text-xs text-amber-700 italic truncate">"{l.note}"</div>
                  ) : null}
                  <div className="mt-2 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="outline" className="h-7 w-7 p-0" onClick={() => bump(l.lineKey, -1)}>
                        <Minus className="h-3 w-3" /></Button>
                      <span className="w-8 text-center font-semibold">{l.qty}</span>
                      <Button size="sm" variant="outline" className="h-7 w-7 p-0" onClick={() => bump(l.lineKey, 1)}>
                        <Plus className="h-3 w-3" /></Button>
                    </div>
                    <div className="font-semibold text-sm">{formatINR(l.price * l.qty)}</div>
                  </div>
                </div>
              ))}

              {/* Upsell strip */}
              {upsell.length > 0 && (
                <div className="border-t pt-3">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-1.5 flex items-center gap-1">
                    <Sparkles className="h-3 w-3" /> Often ordered together
                  </div>
                  <div className="space-y-1">
                    {upsell.slice(0, 3).map((s: any) => {
                      const m = menu.find((x: any) => x.id === s.suggested_item_id);
                      if (!m) return null;
                      return (
                        <button key={s.id} onClick={() => addItem(m)}
                          className="w-full flex justify-between items-center p-2 rounded-md border bg-card hover:bg-accent text-left text-xs">
                          <span>{s.suggested_name}</span>
                          <span className="text-muted-foreground">{formatINR(s.suggested_price)} ({Math.round(s.confidence)}%)</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            <div className="border-t bg-card p-4 space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div><Label className="text-xs">Tax (₹)</Label>
                  <Input type="number" value={tax} onChange={(e) => setTax(+e.target.value || 0)} className="h-8 mt-1" /></div>
                <div><Label className="text-xs">Discount (₹)</Label>
                  <Input type="number" value={discount} onChange={(e) => setDiscount(+e.target.value || 0)} className="h-8 mt-1" /></div>
              </div>
              {discount > 0 && (
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={discountIsPreTax} onChange={(e) => setDiscountIsPreTax(e.target.checked)} />
                  Discount before tax
                </label>
              )}

              <div>
                <Label className="text-xs">Payment</Label>
                <div className="grid grid-cols-4 gap-1 mt-1">
                  {(['cash', 'upi', 'card', 'unpaid'] as const).map((m) => (
                    <button key={m} onClick={() => setPaymentMethod(m)}
                      className={`h-8 rounded-md border text-xs font-semibold capitalize transition-colors ${
                        paymentMethod === m ? 'border-primary bg-primary/10 text-primary' : 'border-input hover:bg-accent'
                      }`}>{m}</button>
                  ))}
                </div>
              </div>

              <div className="border-t pt-2 text-sm space-y-1">
                <div className="flex justify-between"><span>Subtotal</span><span>{formatINR(subtotal)}</span></div>
                {tax > 0 && <div className="flex justify-between text-muted-foreground"><span>Tax</span><span>+ {formatINR(tax)}</span></div>}
                {discount > 0 && <div className="flex justify-between text-emerald-700"><span>Discount</span><span>− {formatINR(discount)}</span></div>}
                {existingSession && previousSubtotalInr > 0 && (
                  <div className="flex justify-between text-muted-foreground text-xs pt-1">
                    <span>+ Already on bill</span><span>{formatINR(previousSubtotalInr)}</span>
                  </div>
                )}
                <div className="flex justify-between font-bold text-base pt-1 border-t mt-1">
                  <span>{existingSession ? 'New bill total' : 'Total'}</span>
                  <span>{formatINR(existingSession ? previousSubtotalInr + total : total)}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="px-6 py-3 border-t flex-wrap gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          {source === 'dineIn' && (
            <Button variant="outline" onClick={() => create.mutate('kot')}
              disabled={create.isPending || cart.length === 0}>
              {create.isPending ? '…' : `${existingSession ? 'Send KOT' : 'Save KOT'} — ${formatINR(total)}`}
            </Button>
          )}
          <Button onClick={() => create.mutate('pay')}
            disabled={create.isPending || cart.length === 0}>
            {create.isPending ? '…' : `Pay & place — ${formatINR(existingSession ? previousSubtotalInr + total : total)}`}
          </Button>
        </DialogFooter>
      </DialogContent>

      {/* Variant + modifier picker — opens when needed */}
      {configuring && (
        <ItemConfigDialog
          item={configuring}
          modGroups={modGroups}
          onClose={() => setConfiguring(null)}
          onConfirm={(line) => { _addLine(line); setConfiguring(null); }}
        />
      )}
    </Dialog>
  );
}

// ── Variant + modifier picker ───────────────────────────────────────────
function ItemConfigDialog({
  item, modGroups, onClose, onConfirm,
}: { item: any; modGroups: any[]; onClose: () => void;
     onConfirm: (line: Omit<CartLine, 'lineKey'>) => void }) {
  // Variant: list from item.variants if present, otherwise treat the base
  // item as the only "variant"
  const variants = Array.isArray(item.variants) && item.variants.length > 0
    ? item.variants
    : [{ id: null, label: '', price: parseFloat(item.price) }];
  const [variantId, setVariantId] = useState<string | null>(variants[0].id);

  // Attached modifier groups
  const attachedIds: string[] = item.modifierGroupIds || [];
  const groups = modGroups.filter((g: any) => attachedIds.includes(g.id));
  // selected[groupId] = Set<modifierId>
  const [selected, setSelected] = useState<Record<string, Set<string>>>(() => {
    const s: Record<string, Set<string>> = {};
    for (const g of groups) s[g.id] = new Set();
    return s;
  });

  const variant = variants.find((v: any) => v.id === variantId) || variants[0];
  let unitPrice = parseFloat(variant.price);
  const chosenMods: ModLine[] = [];
  for (const g of groups) {
    for (const mod of g.modifiers || []) {
      if (selected[g.id]?.has(mod.id)) {
        unitPrice += Number(mod.priceDeltaInr);
        chosenMods.push({ modifierId: mod.id, name: mod.name, priceDeltaInr: Number(mod.priceDeltaInr), qty: 1 });
      }
    }
  }

  const valid = groups.every((g: any) => {
    const n = selected[g.id]?.size || 0;
    return n >= g.minSelect && n <= g.maxSelect;
  });

  const toggle = (groupId: string, modId: string, kind: string) => {
    setSelected((prev) => {
      const next = { ...prev };
      const set = new Set(next[groupId]);
      if (kind === 'single_select') { set.clear(); set.add(modId); }
      else if (set.has(modId)) set.delete(modId); else set.add(modId);
      next[groupId] = set;
      return next;
    });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Customize {item.name}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          {variants.length > 1 && (
            <div>
              <div className="text-xs font-bold uppercase mb-2">Variant</div>
              <div className="flex flex-wrap gap-1">
                {variants.map((v: any) => (
                  <button key={v.id || 'base'} onClick={() => setVariantId(v.id)}
                    className={`px-3 py-1.5 rounded-md border text-sm ${
                      variantId === v.id ? 'border-primary bg-primary/10 text-primary' : 'border-input'
                    }`}>
                    {v.label || 'Standard'} · {formatINR(v.price)}
                  </button>
                ))}
              </div>
            </div>
          )}
          {groups.map((g: any) => (
            <div key={g.id}>
              <div className="text-xs font-bold uppercase mb-2 flex items-center gap-2">
                {g.name}
                {g.minSelect > 0 && <Badge variant="warning" className="text-[9px]">Required</Badge>}
                <span className="text-muted-foreground font-normal">
                  ({g.minSelect}–{g.maxSelect})
                </span>
              </div>
              <div className="space-y-1">
                {g.modifiers.map((mod: any) => (
                  <label key={mod.id} className="flex items-center justify-between p-2 rounded-md border cursor-pointer hover:bg-accent">
                    <span className="flex items-center gap-2 text-sm">
                      <input type={g.kind === 'single_select' ? 'radio' : 'checkbox'}
                        name={g.id}
                        checked={selected[g.id]?.has(mod.id) || false}
                        onChange={() => toggle(g.id, mod.id, g.kind)} />
                      {mod.name}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {mod.priceDeltaInr > 0 ? `+${formatINR(mod.priceDeltaInr)}` :
                       mod.priceDeltaInr < 0 ? `−${formatINR(Math.abs(mod.priceDeltaInr))}` : 'free'}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={!valid}
            onClick={() => onConfirm({
              menuItemId: item.id,
              name: item.name,
              price: +unitPrice.toFixed(2),
              qty: 1,
              variantId: variant.id || null,
              variantLabel: variant.label || null,
              // Bug fix (2026-08-20): the caller types this field as
              // `ModLine[] | undefined`, so returning `null` when the
              // customer picked no modifiers tripped strict TS.
              modifierLines: chosenMods.length > 0 ? chosenMods : undefined,
            })}>
            Add — {formatINR(unitPrice)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
