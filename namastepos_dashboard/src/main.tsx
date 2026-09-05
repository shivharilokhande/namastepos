import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GoogleOAuthProvider } from '@react-oauth/google';
import { Toaster } from 'sonner';

import App from './App';
import './index.css';
import { initSentry } from './lib/sentry';
import { initAnalytics, setIdentityProvider } from './lib/analytics';
import { getBusinessCache, onPlanVersionChange } from './api/client';

// FF-211: initialise Sentry before React mounts so unhandled errors
// during render are captured. No-op when VITE_SENTRY_DSN is unset.
initSentry();

// QA-9 perf #9: sensible defaults so navigation doesn't refetch on every
// click. 60s staleTime is short enough that stale data shows up rarely,
// long enough to make UI feel instant on back/forward.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 60_000,
      gcTime: 5 * 60_000,
    },
  },
});

// Activation funnel (2026-09-04). ONE wiring point: lib/analytics.ts must
// import nothing from the app (that is what keeps api/client.ts →
// analytics.ts a one-way dependency), so it pulls identity through this
// provider instead. `signupAt` is the EXISTING business.createdAt field —
// self-registration creates the business inline with the account, so
// business creation is signup; no new server field was added for this.
setIdentityProvider(() => {
  const b = getBusinessCache();
  if (!b?.id) return null;
  // D-19 (2026-09-05): ['me'] is now the ONLY /auth/me query key
  // (usePlan/useMe + Layout share it); the old ['plan-summary'] twin is gone.
  const me = queryClient.getQueryData<any>(['me']);
  return {
    businessId: String(b.id),
    signupAt: b.createdAt || null,
    planTier: me?.plan?.tierKind || null,
  };
});

// Entitlement sync (2026-09-05): when any API response reports a new
// X-Plan-Version, refetch /auth/me so nav locks, route guards and in-page
// gates follow an admin-side plan change within one request instead of
// waiting for the 60s poll. Add-ons live in the same version, so the
// marketplace state is refreshed too.
onPlanVersionChange(() => Promise.all([
  queryClient.invalidateQueries({ queryKey: ['me'] }),
  queryClient.invalidateQueries({ queryKey: ['my-addons'] }),
]));

// Lazy: schedules the gtag load on the first idle callback after paint, and
// only if VITE_GA4_ID is set AND analytics consent has been granted. Hard
// no-op otherwise — no network, no console output.
initAnalytics();

const GOOGLE_CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string) || '';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
          {/* QA-10 P2 (Suresh polish): top-center on mobile so toasts don't
              cover the action buttons in the bottom-right of forms. */}
          <Toaster richColors position="top-center" />
        </BrowserRouter>
      </QueryClientProvider>
    </GoogleOAuthProvider>
  </React.StrictMode>
);
