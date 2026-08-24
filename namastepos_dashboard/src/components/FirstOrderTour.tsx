// NamastePOS — First-order spotlight tour (FF-316).
//
// Fires once, right after the setup wizard finishes. Reads a
// localStorage flag so returning users never see it. Three tooltips
// walking the owner from Overview → POS → Add item → Review & Pay.
// Absolutely no third-party lib — just a fixed-position overlay + a
// pointer arrow. Skips if the required target isn't in the DOM (e.g.
// on a route that doesn't have POS).

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';

const STORAGE_KEY = 'ff_seen_first_order_tour_v1';
type Step = 0 | 1 | 2 | 3;

const STEPS: Array<{
  target: string;
  title: string;
  body: string;
  action?: string;
  navTo?: string;
}> = [
  { target: 'nav-orders', title: 'Take your first order',
    body: "Tap POS from the sidebar (or Menu on mobile). You'll add items to a cart, then Review & Pay.",
    action: 'Show me',   navTo: '/orders' },
  { target: 'take-order-btn', title: '"Take order" is your POS',
    body: "Every walk-in, phone order, or QR order lands here. Zomato and Swiggy orders show up automatically once you plug in the credentials.",
    action: 'Next' },
  { target: 'action-center-nav', title: 'Watch the Action Center',
    body: "Anything that needs your attention — refunds, low stock, cancellations — shows up in one place. Check it once a day.",
    action: 'Got it' },
];

export function FirstOrderTour() {
  const nav = useNavigate();
  const [step, setStep] = useState<Step>(0);
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    if (localStorage.getItem(STORAGE_KEY)) return;
    // Wait a beat so the layout has laid out targets. If the target
    // still isn't present we bail — no point pointing at a ghost.
    const t = window.setTimeout(() => setHidden(false), 800);
    return () => window.clearTimeout(t);
  }, []);

  if (hidden) return null;
  const s = STEPS[step];
  const finish = () => {
    localStorage.setItem(STORAGE_KEY, '1');
    setHidden(true);
  };
  const next = () => {
    if (s.navTo) nav(s.navTo);
    if (step >= 2) return finish();
    setStep((step + 1) as Step);
  };

  return (
    <div className="fixed inset-0 z-50 pointer-events-auto flex items-center justify-center p-6"
         style={{ background: 'rgba(15,15,15,0.55)' }}
         onClick={finish}>
      <div className="max-w-sm bg-white dark:bg-neutral-900 rounded-xl shadow-xl p-5 relative"
           onClick={(e) => e.stopPropagation()}>
        <button onClick={finish}
                aria-label="Close tour"
                className="absolute top-3 right-3 text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
        <div className="text-xs uppercase tracking-wider text-primary mb-1">Quick tour · {step + 1} of {STEPS.length}</div>
        <h3 className="text-lg font-bold mb-2">{s.title}</h3>
        <p className="text-sm text-muted-foreground leading-relaxed mb-4">{s.body}</p>
        <div className="flex justify-between items-center">
          <button onClick={finish}
                  className="text-xs text-muted-foreground hover:underline">Skip tour</button>
          <button onClick={next}
                  className="px-3 py-1.5 rounded-md bg-primary text-white text-sm font-medium">
            {s.action || 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}
