// NamastePOS — First-login feature tour (FF-316, expanded 2026-08-25).
//
// A complete walkthrough of the dashboard's important features, shown
// ONCE after the user's first login/registration. Each step navigates
// to the page it describes so the user sees the real thing, not a
// screenshot. localStorage-gated so returning users never see it again;
// "Skip tour" bails at any point. No third-party tour lib.
//
// v2 fixes (2026-08-25): the old 3-step tour was mounted globally, so
// it could fire on the login/register screens before a session even
// existed. It now renders only when a session token is present and the
// current route is inside the app shell.

import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import { getToken } from '@/api/client';

const STORAGE_KEY = 'ff_seen_feature_tour_v2';

const STEPS: Array<{
  title: string;
  body: string;
  navTo?: string;
}> = [
  { navTo: '/',
    title: 'Welcome to NamastePOS 🎉',
    body: 'This quick tour shows you everything important — it takes under a minute. This is your Overview: today\'s sales, orders, and what needs attention, all at a glance.' },
  { navTo: '/orders',
    title: 'Orders — your POS',
    body: 'Every order lives here. Tap "Take order" for walk-ins, phone orders, or dine-in. QR orders from customer phones and Zomato/Swiggy orders appear here automatically.' },
  { navTo: '/menu',
    title: 'Your Menu',
    body: 'Add items, set prices, mark veg/non-veg, and toggle out-of-stock in one tap. You can also bulk-import your whole menu from a CSV.' },
  { navTo: '/tables',
    title: 'Tables & floor plan',
    body: 'Lay out your floors and tables. Each table gets its own QR code — customers scan, browse the menu, and order from their phone.' },
  { navTo: '/kot',
    title: 'Kitchen tickets (KOT)',
    body: 'Every order fires a kitchen ticket here. Your kitchen sees what to cook, marks items ready, and waiters know when to serve.' },
  { navTo: '/customers',
    title: 'Customers & CRM',
    body: 'Every customer is remembered automatically — order history, favourites, visit counts. Build loyalty with memberships and win-back campaigns.' },
  { navTo: '/reports',
    title: 'Reports',
    body: 'Daily sales, best sellers, GST summaries, expense tracking — everything you need at tax time and for spotting what\'s working.' },
  { navTo: '/billing',
    title: 'Your plan & billing',
    body: 'You\'re on the free Starter plan. Upgrade anytime for aggregator integrations, WhatsApp ordering, CRM and more.' },
  { navTo: '/settings',
    title: 'Settings — make it yours',
    body: 'GST details, receipt template, staff PINs, printers, integrations. That\'s the tour — go take your first order! You can revisit any page from the sidebar.' },
];

// Routes where the tour must never appear (no session/app shell).
const EXCLUDED_PREFIXES = ['/login', '/register', '/onboarding', '/qr/', '/track/', '/legal/', '/guest'];

export function FirstOrderTour() {
  const nav = useNavigate();
  const location = useLocation();
  const [step, setStep] = useState(0);
  const [hidden, setHidden] = useState(true);

  const excluded = EXCLUDED_PREFIXES.some((p) => location.pathname.startsWith(p));

  useEffect(() => {
    if (localStorage.getItem(STORAGE_KEY)) return;
    if (excluded || !getToken()) { setHidden(true); return; }
    // Wait a beat so the layout has painted before the overlay drops in.
    const t = window.setTimeout(() => setHidden(false), 900);
    return () => window.clearTimeout(t);
    // Re-evaluate when the route changes (e.g. right after login lands on "/").
  }, [excluded, location.pathname]);

  if (hidden || excluded) return null;
  const s = STEPS[step];
  const finish = () => {
    localStorage.setItem(STORAGE_KEY, '1');
    setHidden(true);
  };
  const next = () => {
    if (step >= STEPS.length - 1) return finish();
    const n = step + 1;
    const target = STEPS[n];
    if (target.navTo) nav(target.navTo);
    setStep(n);
  };
  const back = () => {
    if (step === 0) return;
    const n = step - 1;
    const target = STEPS[n];
    if (target.navTo) nav(target.navTo);
    setStep(n);
  };

  return (
    <div className="fixed inset-0 z-50 pointer-events-none flex items-end justify-center p-6 pb-10">
      <div className="pointer-events-auto max-w-md w-full bg-white dark:bg-neutral-900 border rounded-xl shadow-2xl p-5 relative">
        <button onClick={finish}
                aria-label="Close tour"
                className="absolute top-3 right-3 text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
        <div className="text-xs uppercase tracking-wider text-primary mb-1">
          Feature tour · {step + 1} of {STEPS.length}
        </div>
        <h3 className="text-lg font-bold mb-2">{s.title}</h3>
        <p className="text-sm text-muted-foreground leading-relaxed mb-4">{s.body}</p>
        <div className="flex justify-between items-center">
          <button onClick={finish}
                  className="text-xs text-muted-foreground hover:underline">Skip tour</button>
          <div className="flex gap-2">
            {step > 0 && (
              <button onClick={back}
                      className="px-3 py-1.5 rounded-md border text-sm font-medium">
                Back
              </button>
            )}
            <button onClick={next}
                    className="px-3 py-1.5 rounded-md bg-primary text-white text-sm font-medium">
              {step >= STEPS.length - 1 ? 'Finish' : 'Next'}
            </button>
          </div>
        </div>
        {/* progress dots */}
        <div className="flex gap-1.5 justify-center mt-4">
          {STEPS.map((_, i) => (
            <span key={i}
                  className={`h-1.5 rounded-full transition-all ${i === step ? 'w-5 bg-primary' : 'w-1.5 bg-border'}`} />
          ))}
        </div>
      </div>
    </div>
  );
}
