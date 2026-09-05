// NamastePOS dashboard — route-level feature gate (D-10, 2026-09-05).
//
// Until today the sidebar lock icon was the ONLY client-side gate: every
// route rendered for every plan, and a locked page either 402'd into an
// empty table or (for the registry's `clients:['dashboard']` keys, which no
// server route enforces) simply worked when reached by URL. This wrapper
// closes that:
//
//   <Route path="kds" element={<RequireFeature feature="kds"><KdsPage /></RequireFeature>} />
//
// Behaviour — fail-closed, driven only by /auth/me (never a hardcoded list):
//   • plan not loaded yet  → spinner (no page, no lock flash)
//   • loaded && has(key)   → children (or <Outlet/> when used as a layout route)
//   • loaded && !has(key)  → compact upgrade card linking to /billing
//
// The "required tier" on the card is computed from the live /plans feed
// (lowest ladder rung whose featureKeys include the key), so it follows
// whatever the super-admin configured. When no public plan carries the key
// (custom plan / registry drift) the card says so honestly instead of
// guessing.

import { Link, Outlet } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { usePlan } from '@/hooks/usePlan';
import { useRequiredTierFor } from '@/hooks/useRequiredTier';

export function FeatureUpgradeCard({
  feature, title, compact = false,
}: { feature: string; title?: string; compact?: boolean }) {
  const required = useRequiredTierFor(feature);
  const plan = usePlan();
  const heading = title || 'This feature is not in your plan';
  const line = required.label
    ? `This feature is in the ${required.label} plan${plan.tierLabel ? ` — you are on ${plan.tierLabel}` : ''}.`
    : (required.isLoading
      ? 'Checking which plan includes this…'
      : 'This feature is not included in your current plan.');
  return (
    <Card className={compact ? 'max-w-xl' : 'max-w-xl mx-auto mt-10'} data-testid="feature-upgrade-card">
      <CardContent className="p-6 space-y-3">
        <div className="flex items-center gap-2 font-semibold">
          <Lock className="h-4 w-4 text-muted-foreground" /> {heading}
        </div>
        <p className="text-sm text-muted-foreground">{line}</p>
        <Button asChild size="sm">
          <Link to="/billing">View plans</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

export function RequireFeature({
  feature, children,
}: { feature: string; children?: React.ReactNode }) {
  const plan = usePlan();
  // Spinner only while the FIRST /auth/me is in flight. If it answered
  // without a plan block (server could not compute a summary) we fall
  // through to has() === false → upgrade card, never an endless spinner.
  if (plan.isLoading) {
    return (
      <div className="flex items-center justify-center py-24" role="status" aria-live="polite">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-primary" />
        <span className="sr-only">Loading…</span>
      </div>
    );
  }
  if (!plan.has(feature)) return <FeatureUpgradeCard feature={feature} />;
  return children !== undefined ? <>{children}</> : <Outlet />;
}
