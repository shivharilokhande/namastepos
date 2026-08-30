// NamastePOS - Guest-facing menu (scanned via QR). PUBLIC route, mobile-first.

import { useState, useEffect, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ShoppingBag, Minus, Plus, Check, Clock, ChefHat, X, Search, Utensils, Receipt,
} from 'lucide-react';
import { guest, GuestMenu } from '@/api/guest';
import { formatINR } from '@/lib/utils';
import { GuestBillPanel } from '@/components/GuestBillPanel';

interface CartItem { id: string; name: string; price: number; qty: number; note?: string; }

export function GuestMenuPage() {
  const { token } = useParams<{ token: string }>();
  const { data, isLoading, error } = useQuery<GuestMenu>({
    queryKey: ['guest-menu', token], queryFn: () => guest.menu(token!), retry: false,
  });

  const [cart, setCart] = useState<CartItem[]>([]);
  const [showCart, setShowCart] = useState(false);
  const [category, setCategory] = useState<string>('All');
  const [search, setSearch] = useState('');
  const [placed, setPlaced] = useState<{ id: string; orderNo: number; total: number } | null>(null);
  const [showBill, setShowBill] = useState(false);

  // FF-251 — poll running session so the "View bill" button shows up once
  // any KOT has been placed on this table (guest or captain).
  const sessionQ = useQuery({
    queryKey: ['guest-session-badge', token],
    queryFn: () => guest.currentSession(token!),
    refetchInterval: 20000,
    enabled: !!token,
  });
  const runningTotal = sessionQ.data?.totals?.total ?? 0;
  const showBillFab = !!sessionQ.data && !sessionQ.data.paid && runningTotal > 0;

  const categories = useMemo(() => {
    if (!data) return [];
    const set = new Set<string>();
    data.items.forEach((i) => set.add(i.category));
    return ['All', ...Array.from(set).sort()];
  }, [data]);

  const visibleItems = useMemo(() => {
    if (!data) return [];
    return data.items.filter((it) => {
      if (category !== 'All' && it.category !== category) return false;
      if (search && !it.name.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [data, category, search]);

  const cartTotal = cart.reduce((sum, c) => sum + c.price * c.qty, 0);
  const cartCount = cart.reduce((sum, c) => sum + c.qty, 0);

  const addToCart = (item: any) => {
    setCart((prev) => {
      const idx = prev.findIndex((c) => c.id === item.id);
      if (idx >= 0) {
        const updated = [...prev];
        updated[idx] = { ...updated[idx], qty: updated[idx].qty + 1 };
        return updated;
      }
      return [...prev, { id: item.id, name: item.name, price: item.price, qty: 1 }];
    });
  };

  const updateCart = (id: string, delta: number) => {
    setCart((prev) => {
      const idx = prev.findIndex((c) => c.id === id);
      if (idx < 0) return prev;
      const next = [...prev];
      const newQty = next[idx].qty + delta;
      if (newQty <= 0) { next.splice(idx, 1); return next; }
      next[idx] = { ...next[idx], qty: newQty };
      return next;
    });
  };

  if (isLoading) {
    return (
      <div className="min-h-screen grid place-items-center bg-background">
        <div className="text-center">
          <div className="animate-spin h-10 w-10 border-4 border-primary border-t-transparent rounded-full mx-auto mb-3" />
          <p className="text-muted-foreground">Loading menu…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen grid place-items-center bg-background p-6">
        <div className="text-center max-w-md">
          <div className="text-6xl mb-4">😕</div>
          <h1 className="text-2xl font-bold mb-2">Can't load the menu</h1>
          <p className="text-muted-foreground">
            This QR code may be invalid or expired. Please ask a staff member for a new one.
          </p>
        </div>
      </div>
    );
  }

  if (!data) return null;
  const brand = data.settings.brandColor;

  if (placed) {
    return <OrderPlaced token={token!} order={placed} brand={brand} />;
  }

  return (
    <div className="min-h-screen bg-background" style={{ '--brand': brand } as any}>
      {/* Hero / business header */}
      <div className="px-4 pt-6 pb-4" style={{ background: `linear-gradient(135deg, ${brand} 0%, ${brand}cc 100%)` }}>
        <div className="flex items-center gap-3 mb-2 text-white">
          <div className="grid h-12 w-12 place-items-center rounded-xl bg-white/20 backdrop-blur">
            {data.business.logoUrl
              ? <img src={data.business.logoUrl} alt="" className="h-8 w-8 rounded-md" />
              : <Utensils className="h-6 w-6" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-lg font-bold truncate">{data.business.name}</div>
            <div className="text-xs opacity-90">Table {data.table.label}{data.table.floor ? ` · ${data.table.floor}` : ''}</div>
          </div>
        </div>
        <div className="text-white">
          <h1 className="text-xl font-bold">{data.settings.welcomeTitle}</h1>
          <p className="text-sm opacity-90">{data.settings.welcomeSubtitle}</p>
        </div>
      </div>

      {/* Search + categories sticky */}
      <div className="sticky top-0 bg-background z-10 border-b shadow-sm">
        <div className="p-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search…"
              className="w-full h-10 pl-9 pr-3 rounded-md border bg-background text-sm" />
          </div>
        </div>
        <div className="flex gap-2 px-3 pb-3 overflow-x-auto">
          {categories.map((c) => (
            <button key={c} onClick={() => setCategory(c)}
              className={`px-4 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${
                category === c
                  ? 'text-white'
                  : 'bg-muted text-foreground'
              }`}
              style={category === c ? { background: brand } : {}}
            >{c}</button>
          ))}
        </div>
      </div>

      {/* Items */}
      <div className="p-4 space-y-3 pb-32">
        {visibleItems.length === 0 && (
          <div className="text-center py-12 text-muted-foreground">No items found.</div>
        )}
        {visibleItems.map((it) => {
          const inCart = cart.find((c) => c.id === it.id);
          return (
            <div key={it.id} className="bg-card rounded-xl p-3 flex gap-3 shadow-sm border">
              <div className="flex-1 min-w-0">
                {data.settings.showVegBadge && (
                  <div className="inline-flex items-center justify-center h-4 w-4 border-2 rounded mb-1.5"
                       style={{ borderColor: it.isVeg ? '#10B981' : '#EF4444' }}>
                    <div className="h-1.5 w-1.5 rounded-full"
                         style={{ background: it.isVeg ? '#10B981' : '#EF4444' }} />
                  </div>
                )}
                <h3 className="font-semibold text-base">{it.name}</h3>
                {it.description && <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{it.description}</p>}
                {data.settings.showPrices && (
                  <p className="font-bold mt-1.5" style={{ color: brand }}>{formatINR(it.price)}</p>
                )}
              </div>
              <div className="flex flex-col items-end justify-between gap-2">
                {it.imageUrl && (
                  <img src={it.imageUrl} alt="" className="h-16 w-16 rounded-lg object-cover" />
                )}
                {inCart ? (
                  <div className="flex items-center gap-2">
                    <button onClick={() => updateCart(it.id, -1)}
                      className="h-7 w-7 rounded-md text-white grid place-items-center"
                      style={{ background: brand }}>
                      <Minus className="h-3 w-3" />
                    </button>
                    <span className="font-bold min-w-[20px] text-center">{inCart.qty}</span>
                    <button onClick={() => updateCart(it.id, +1)}
                      className="h-7 w-7 rounded-md text-white grid place-items-center"
                      style={{ background: brand }}>
                      <Plus className="h-3 w-3" />
                    </button>
                  </div>
                ) : (
                  <button onClick={() => addToCart(it)}
                    className="px-3 py-1 rounded-md text-white text-xs font-bold"
                    style={{ background: brand }}>ADD</button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* FF-251 — "View bill · pay" pill floats above the cart bar
          whenever this table has an open (unpaid) session. Kept small
          so it doesn't fight the primary "review cart" CTA. */}
      {showBillFab && !showBill && (
        <button
          onClick={() => setShowBill(true)}
          className={`fixed right-3 z-20 rounded-full shadow-lg text-white text-sm font-semibold px-4 h-10 flex items-center gap-2 ${
            cartCount > 0 ? 'bottom-24' : 'bottom-6'
          }`}
          style={{ background: brand }}>
          <Receipt className="h-4 w-4" />
          View bill · {formatINR(runningTotal)}
        </button>
      )}

      {/* Floating cart button */}
      {cartCount > 0 && (
        <div className="fixed bottom-0 left-0 right-0 p-3 bg-background border-t shadow-2xl">
          <button onClick={() => setShowCart(true)}
            className="w-full h-14 rounded-xl text-white font-bold flex items-center justify-between px-5 shadow-lg"
            style={{ background: brand }}>
            <span className="flex items-center gap-2">
              <ShoppingBag className="h-5 w-5" /> {cartCount} item{cartCount > 1 ? 's' : ''}
            </span>
            <span className="text-lg">{formatINR(cartTotal)} → Review</span>
          </button>
        </div>
      )}

      {/* Cart sheet */}
      {showCart && (
        <CartSheet
          cart={cart} brand={brand} setCart={setCart}
          requirePhone={data.settings.requirePhone}
          requireName={data.settings.requireName}
          token={token!}
          onClose={() => setShowCart(false)}
          onPlaced={(o: any) => { setPlaced(o); setCart([]); setShowCart(false); }}
        />
      )}

      {/* FF-251 — running-bill sheet */}
      {showBill && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-end" onClick={() => setShowBill(false)}>
          <div className="bg-background w-full rounded-t-2xl max-h-[90vh] overflow-y-auto"
               onClick={(e) => e.stopPropagation()}>
            <div className="sticky top-0 bg-background border-b p-4 flex items-center justify-between">
              <h2 className="text-lg font-bold">Bill</h2>
              <button onClick={() => setShowBill(false)}><X className="h-5 w-5" /></button>
            </div>
            <GuestBillPanel token={token!} brand={{ color: brand }} />
          </div>
        </div>
      )}
    </div>
  );
}

function CartSheet({ cart, brand, setCart, requirePhone, requireName, token, onClose, onPlaced }: any) {
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  // Guest membership-benefit OTP gate: if the entered phone owns a membership
  // benefit, we must verify ownership before honoring it (else a guest could
  // spend a member's bundle by typing their number).
  const [otpRequired, setOtpRequired] = useState(false);
  const [otpRequestId, setOtpRequestId] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [benefitToken, setBenefitToken] = useState<string | undefined>(undefined);
  const [checking, setChecking] = useState(false);
  const cartTotal = cart.reduce((s: number, c: CartItem) => s + c.price * c.qty, 0);

  const place = useMutation({
    // Accept the benefit token as an argument: after benefitVerify we call
    // place.mutate(freshToken) — reading `benefitToken` from state here would
    // be a stale closure (React hasn't re-rendered yet), so the just-verified
    // benefit would be dropped. Fall back to state for the normal path.
    mutationFn: (bt?: string) => guest.placeOrder(token, {
      items: cart.map((c: CartItem) => ({
        menuItemId: c.id, name: c.name, price: c.price, qty: c.qty,
      })),
      customerPhone: phone || undefined,
      customerName: name || undefined,
      benefitToken: bt ?? benefitToken,
    }),
    onSuccess: (r) => { toast.success('Order placed!'); onPlaced(r.order); },
    onError: (e: any) => toast.error(e.response?.data?.message || 'Could not place order'),
  });

  // Step 1: on submit, if a phone is present and we haven't yet resolved a
  // benefit token, ask the server whether this phone needs OTP verification.
  const submit = async () => {
    if (phone.length >= 10 && !benefitToken && !otpRequired) {
      try {
        setChecking(true);
        const r = await guest.benefitCheck(token, phone);
        if (r.otpRequired && r.requestId) {
          setOtpRequestId(r.requestId);
          setOtpRequired(true);
          toast.info('This number has a membership. Enter the OTP we sent to use it.');
          return; // wait for OTP
        }
      } catch { /* non-fatal — fall through and place without a benefit */ }
      finally { setChecking(false); }
    }
    place.mutate(undefined);
  };

  // Step 2: verify the OTP, capture the benefit token, then place the order.
  const [verifying, setVerifying] = useState(false);
  const verifyOtp = async () => {
    if (verifying || place.isPending) return; // guard double-tap
    try {
      setVerifying(true);
      const r = await guest.benefitVerify(token, { requestId: otpRequestId, code: otpCode, phone });
      setBenefitToken(r.benefitToken);
      setOtpRequired(false);
      // Pass the fresh token directly — state isn't updated yet this tick.
      place.mutate(r.benefitToken);
    } catch (e: any) {
      toast.error(e.response?.data?.message || 'Invalid OTP');
    } finally {
      setVerifying(false);
    }
  };

  const canSubmit = cart.length > 0
    && (!requirePhone || phone.length >= 10)
    && (!requireName || name.length >= 1);

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-end" onClick={onClose}>
      <div className="bg-background w-full rounded-t-2xl max-h-[90vh] overflow-y-auto"
           onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-background border-b p-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">Your order</h2>
          <button onClick={onClose}><X className="h-5 w-5" /></button>
        </div>
        <div className="p-4 space-y-2">
          {cart.map((c: CartItem) => (
            <div key={c.id} className="flex items-center gap-3 py-2 border-b">
              <div className="flex-1">
                <div className="font-medium">{c.name}</div>
                <div className="text-sm text-muted-foreground">{formatINR(c.price)} × {c.qty}</div>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => setCart((p: CartItem[]) => {
                  const idx = p.findIndex((x) => x.id === c.id);
                  if (idx < 0) return p;
                  const next = [...p];
                  if (next[idx].qty <= 1) next.splice(idx, 1);
                  else next[idx] = { ...next[idx], qty: next[idx].qty - 1 };
                  return next;
                })} className="h-7 w-7 grid place-items-center rounded text-white"
                  style={{ background: brand }}><Minus className="h-3 w-3" /></button>
                <span className="font-bold w-5 text-center">{c.qty}</span>
                <button onClick={() => setCart((p: CartItem[]) => {
                  const idx = p.findIndex((x) => x.id === c.id);
                  const next = [...p];
                  next[idx] = { ...next[idx], qty: next[idx].qty + 1 };
                  return next;
                })} className="h-7 w-7 grid place-items-center rounded text-white"
                  style={{ background: brand }}><Plus className="h-3 w-3" /></button>
              </div>
              <div className="font-bold w-20 text-right">{formatINR(c.price * c.qty)}</div>
            </div>
          ))}
          <div className="flex justify-between py-3 text-lg font-bold">
            <span>Total</span><span>{formatINR(cartTotal)}</span>
          </div>

          {requirePhone && (
            <div>
              <label className="text-sm font-medium">Phone</label>
              <input value={phone} onChange={(e) => setPhone(e.target.value.replace(/[^0-9]/g, ''))}
                maxLength={10} placeholder="9876543210"
                className="w-full h-10 px-3 rounded-md border bg-background mt-1" />
            </div>
          )}
          {requireName && (
            <div>
              <label className="text-sm font-medium">Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                className="w-full h-10 px-3 rounded-md border bg-background mt-1" />
            </div>
          )}

          {otpRequired && (
            <div className="mt-2 p-3 rounded-md border bg-muted/40">
              <label className="text-sm font-medium">Enter OTP to use your membership</label>
              <input value={otpCode} onChange={(e) => setOtpCode(e.target.value.replace(/[^0-9]/g, ''))}
                maxLength={6} placeholder="6-digit code" inputMode="numeric"
                className="w-full h-10 px-3 rounded-md border bg-background mt-1" />
              <button onClick={verifyOtp} disabled={otpCode.length < 4 || place.isPending || verifying}
                className="w-full h-11 rounded-lg text-white font-semibold mt-2 disabled:opacity-50"
                style={{ background: brand }}>
                {verifying || place.isPending ? 'Verifying…' : 'Verify & place order'}
              </button>
              <button onClick={() => { setOtpRequired(false); setBenefitToken(undefined); place.mutate(undefined); }}
                className="w-full h-9 text-sm text-muted-foreground mt-1">
                Skip — place without membership
              </button>
            </div>
          )}

          {!otpRequired && (
            <button onClick={submit} disabled={!canSubmit || place.isPending || checking}
              className="w-full h-14 rounded-xl text-white font-bold text-lg mt-4 disabled:opacity-50"
              style={{ background: brand }}>
              {place.isPending || checking ? 'Placing…' : `Place order · ${formatINR(cartTotal)}`}
            </button>
          )}
          <p className="text-xs text-center text-muted-foreground mt-2">
            Pay at the counter when your meal is served.
          </p>
        </div>
      </div>
    </div>
  );
}

function OrderPlaced({ token, order, brand }: { token: string; order: any; brand: string }) {
  const { data: status } = useQuery({
    queryKey: ['guest-status', order.id],
    queryFn: () => guest.orderStatus(token, order.id),
    refetchInterval: 5000,
  });

  const stage = status?.status || 'pending';
  // FF-252 — copy adapts to the resolved service mode. Dine-in guests
  // shouldn't be told to "collect" anything; self-pickup guests do
  // need the counter reminder.
  const mode: 'dine_in' | 'self_pickup' | 'takeaway' | 'delivery' =
    (status?.serviceMode as any) || 'dine_in';
  const readyLabel = mode === 'dine_in' ? 'Ready to serve' : 'Ready to collect';
  const collectedLabel = mode === 'dine_in' ? 'Served' : 'Collected';
  const footerCopy = mode === 'dine_in'
    ? 'A team member will bring your order to the table.'
    : 'Please collect your order at the counter when it\'s ready.';
  const stages = [
    { key: 'pending',   label: 'Received',   icon: Check },
    { key: 'ready',     label: readyLabel,   icon: ChefHat },
    { key: 'collected', label: collectedLabel, icon: Utensils },
  ];
  const currentIdx = stages.findIndex((s) => s.key === stage);

  return (
    <div className="min-h-screen bg-background p-6 flex flex-col items-center justify-center text-center">
      <div className="grid h-20 w-20 place-items-center rounded-full text-white mb-4"
           style={{ background: brand }}>
        <Check className="h-10 w-10" />
      </div>
      <h1 className="text-2xl font-bold mb-1">Order #{order.orderNo} confirmed!</h1>
      <p className="text-muted-foreground mb-1">{formatINR(order.total)}</p>
      <p className="text-sm text-muted-foreground mb-8">
        {footerCopy}
      </p>

      <div className="w-full max-w-sm">
        <div className="flex items-center">
          {stages.map((s, i) => (
            <div key={s.key} className="flex-1 flex flex-col items-center">
              <div className={`h-12 w-12 grid place-items-center rounded-full text-white ${i <= currentIdx ? '' : 'bg-muted text-muted-foreground'}`}
                style={i <= currentIdx ? { background: brand } : {}}>
                <s.icon className="h-5 w-5" />
              </div>
              <div className="text-xs mt-1.5">{s.label}</div>
              {i < stages.length - 1 && (
                <div className={`h-0.5 w-full -mt-7 ${i < currentIdx ? '' : 'bg-muted'}`}
                  style={i < currentIdx ? { background: brand } : {}} />
              )}
            </div>
          ))}
        </div>
      </div>

      <p className="text-xs text-muted-foreground mt-10">
        Page refreshes every 5s — keep this open to track your order.
      </p>
      <p className="text-xs text-muted-foreground mt-1">
        Want to order more? <a href="javascript:location.reload()" className="underline">Tap here</a>
      </p>
    </div>
  );
}
