import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GoogleOAuthProvider } from '@react-oauth/google';
import { Toaster } from 'sonner';

import App from './App';
import './index.css';
import { initSentry } from './lib/sentry';

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
