// NamastePOS dashboard — plan-limit + past-due banners.
//
// WHY THIS EXISTS
// Two ways a working restaurant used to break with no warning:
//
//  1. Plan caps. `POST /orders` 403s at `monthly_orders`, and on Starter that
//     cap is 200 bills a month — about 6.6 a day. The only "you are near your
//     limit" signal in the product lived in the SUPER-ADMIN console, where the
//     person who can act on it cannot see it. So an outlet stopped billing
//     mid-service and the owner learned about the cap from a failed bill.
//  2. A failed card. `past_due` used to strip features immediately.
//
// The rule this component enforces: it must be impossible to hit the wall
// without having been told. So:
//   • at >= 80% of any cap  → amber banner, dismissable for the session
//   • at >= 100% of any cap → red banner, NOT dismissable (dismissing the
//     last warning before the till stops would defeat the entire point)
//   • inside the past-due grace window → amber banner naming the amount and
//     the exact date access ends
//
// Mounted once in Layout, above the page content, so it is present on every
// screen rather than only on Billing (which is the one screen an owner about
// to hit a cap has no reason to open).
//
// Data comes from GET /businesses/:id/billing via the SAME react-query key
// BillingPage uses ('sub'), so this adds no extra request on that page and one
// cheap poll elsewhere.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle, CreditCard, X } from 'lucide-react';
import { ffApi } from '@/api/namastepos';
import type { PlanUsageMetric, Subscription } from '@/api/namastepos';
import { formatINR } from '@/lib/utils';

/** Session-scoped dismissal for WARN only — never for critical. */
const DISMISS_KEY = 'np_plan_warn_dismissed_v1';

function dismissedWarnings(): Set<string> {
  try {
    const raw = sessionStorage.getItem(DISMISS_KEY);
    return new Set<string>(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set<string>();
  }
}

/**
 * Dismissal is keyed by metric AND the bucket the count is in, so an owner who
 * dismisses "40 of 50 bills left" is warned again as the number keeps falling
 * instead of staying silent all the way to the wall.
 */
function warnKey(m: PlanUsageMetric) {
  return `${m.metric}:${Math.min(99, m.pct)}`;
}

export function PlanLimitBanner() {
  const [dismissed, setDismissed] = useState<Set<string>>(dismissedWarnings);

  const { data: sub } = useQuery<Subscription | null>({
    queryKey: ['sub'],
    queryFn: ffApi.subscription,
    // The counters move with every bill, so a stale meter is worse than no
    // meter. Same cadence as usePlan's plan-summary poll.
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    // A failed billing read must never block the app behind an error banner.
    retry: false,
  });

  const dismiss = (key: string) => {
    const next = new Set(dismissed);
    next.add(key);
    setDismissed(next);
    try { sessionStorage.setItem(DISMISS_KEY, JSON.stringify([...next])); }
    catch { /* storage disabled — banner simply reappears */ }
  };

  const metrics = sub?.usage?.metrics ?? [];
  // Worst first: if anything is at the wall, that is the message that matters.
  const critical = metrics.filter((m) => m.level === 'critical');
  const warnings = metrics
    .filter((m) => m.level === 'warn' && !dismissed.has(warnKey(m)))
    .sort((a, b) => b.pct - a.pct);
  const grace = sub?.grace ?? null;

  if (critical.length === 0 && warnings.length === 0 && !grace) return null;

  return (
    <div className="mb-4 space-y-2">
      {/* Past-due grace. Reassure first — everything still works — then say
          plainly when it stops and what it costs to stop that happening. */}
      {grace && (
        <div
          role="alert"
          className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900"
        >
          <div className="flex items-start gap-3">
            <CreditCard className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="flex-1 text-sm">
              <div className="font-semibold">
                {grace.amountInr != null
                  ? `${formatINR(grace.amountInr)} payment didn't go through`
                  : 'Your subscription payment didn\'t go through'}
                {' — nothing has stopped'}
              </div>
              <div className="mt-0.5">
                Everything keeps working until{' '}
                <strong>
                  {new Date(grace.graceEndsAt).toLocaleDateString('en-IN', {
                    day: '2-digit', month: 'short', year: 'numeric',
                  })}
                </strong>
                {' '}({grace.graceDaysLeft} day{grace.graceDaysLeft === 1 ? '' : 's'} left).
                Update your payment method before then and nothing changes.
              </div>
              <Link
                to="/billing"
                className="mt-2 inline-block rounded-md bg-amber-900 px-3 py-1.5 text-xs font-semibold text-amber-50 hover:bg-amber-800"
              >
                Update payment
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* AT the wall. Deliberately has no dismiss control. */}
      {critical.map((m) => (
        <div
          key={m.metric}
          role="alert"
          className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-red-900"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="flex-1 text-sm">
              <div className="font-semibold">
                You&apos;ve reached your plan limit for {m.label} ({m.current} of {m.limit})
              </div>
              <div className="mt-0.5">{m.message}</div>
              <Link
                to="/billing"
                className="mt-2 inline-block rounded-md bg-red-700 px-3 py-1.5 text-xs font-semibold text-red-50 hover:bg-red-800"
              >
                See plans &amp; upgrade
              </Link>
            </div>
          </div>
        </div>
      ))}

      {/* Approaching the wall. Dismissable per bucket. */}
      {warnings.map((m) => (
        <div
          key={m.metric}
          role="status"
          className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="flex-1 text-sm">
              <div className="font-semibold">
                {m.remaining} of your {m.limit} {m.label} left
                {sub?.usage?.planName ? ` on ${sub.usage.planName}` : ''}
              </div>
              <div className="mt-0.5">{m.message}</div>
              <Link
                to="/billing"
                className="mt-2 inline-block rounded-md bg-amber-900 px-3 py-1.5 text-xs font-semibold text-amber-50 hover:bg-amber-800"
              >
                See plans
              </Link>
            </div>
            <button
              type="button"
              onClick={() => dismiss(warnKey(m))}
              aria-label="Dismiss"
              className="grid h-6 w-6 shrink-0 place-items-center rounded hover:bg-amber-200"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
