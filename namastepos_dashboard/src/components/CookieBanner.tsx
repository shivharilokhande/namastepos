// DPDP — cookie consent banner.
//
// Shown to anonymous visitors until they make an explicit choice:
//   - "Accept all"           — analytics + marketing cookies allowed
//   - "Reject non-essential" — only strictly-necessary cookies
//   - "Customize"            — per-category toggles
//
// The choice is sent to the backend via /v1/compliance/consent so
// there's a durable audit trail tied to a sessionId. Anonymous
// sessionId lives in localStorage and survives reloads.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '@/api/client';
import { refreshConsent } from '@/lib/analytics';

const SESSION_KEY = 'ff_anon_session_id';
const DECISION_KEY = 'ff_cookie_decision_v1';

function ensureSessionId(): string {
  let s = localStorage.getItem(SESSION_KEY);
  if (!s) {
    // Random 16-byte id — collision-safe for our use-case
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    s = Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(SESSION_KEY, s);
  }
  return s;
}

async function record(consentKey: string, granted: boolean) {
  try {
    await api.post('/compliance/consent', {
      sessionId:  ensureSessionId(),
      consentKey,
      granted,
      source:     'cookie_banner',
      policyVersion: 'privacy-2026-05-26',
    });
  } catch (_) {
    // Network or auth issue — banner stays visible so the user can retry.
  }
}

export function CookieBanner() {
  const [visible, setVisible] = useState(false);
  const [showCustomize, setShowCustomize] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [marketing, setMarketing] = useState(false);

  useEffect(() => {
    const made = localStorage.getItem(DECISION_KEY);
    if (!made) setVisible(true);
  }, []);

  if (!visible) return null;

  async function close(decision: 'accept-all' | 'reject' | 'custom') {
    let a = false; let m = false;
    if (decision === 'accept-all') { a = true; m = true; }
    else if (decision === 'custom') { a = analytics; m = marketing; }
    // 'reject' leaves both false.

    await Promise.all([
      record('cookies_analytics', a),
      record('cookies_marketing', m),
    ]);
    localStorage.setItem(DECISION_KEY, JSON.stringify({
      decision, analytics: a, marketing: m, at: new Date().toISOString(),
    }));
    // Activation funnel: lib/analytics.ts holds funnel events in memory
    // while this banner is open and sends nothing. Tell it the decision
    // landed so a granted consent flushes now instead of on next reload —
    // and so a refusal drops the held events immediately.
    refreshConsent();
    setVisible(false);
  }

  return (
    <div className="fixed bottom-0 inset-x-0 z-50 bg-card border-t shadow-lg p-4 sm:p-5">
      <div className="max-w-4xl mx-auto">
        {!showCustomize ? (
          <div className="flex flex-col md:flex-row md:items-center gap-3">
            <p className="text-sm flex-1">
              We use cookies to run NamastePOS. Analytics and marketing
              cookies are <strong>off by default</strong> — turn them on
              only if you want. See our{' '}
              <Link to="/legal/privacy" className="underline">
                Privacy Policy
              </Link>.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => close('reject')}
                className="px-3 py-1.5 text-sm border rounded hover:bg-muted">
                Reject non-essential
              </button>
              <button
                onClick={() => setShowCustomize(true)}
                className="px-3 py-1.5 text-sm border rounded hover:bg-muted">
                Customize
              </button>
              <button
                onClick={() => close('accept-all')}
                className="px-3 py-1.5 text-sm rounded bg-primary text-primary-foreground hover:opacity-90">
                Accept all
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <h3 className="font-semibold">Cookie preferences</h3>
            <div className="space-y-2 text-sm">
              <label className="flex items-start gap-2">
                <input type="checkbox" checked disabled className="mt-1" />
                <span>
                  <strong>Strictly necessary</strong> — required for the
                  service to work (login, session, security). Always on.
                </span>
              </label>
              <label className="flex items-start gap-2">
                <input type="checkbox" checked={analytics}
                  onChange={(e) => setAnalytics(e.target.checked)} className="mt-1" />
                <span>
                  <strong>Analytics</strong> — anonymous usage stats so we
                  know which features are useful.
                </span>
              </label>
              <label className="flex items-start gap-2">
                <input type="checkbox" checked={marketing}
                  onChange={(e) => setMarketing(e.target.checked)} className="mt-1" />
                <span>
                  <strong>Marketing</strong> — measure ad performance on
                  external networks. Off by default.
                </span>
              </label>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setShowCustomize(false)}
                className="px-3 py-1.5 text-sm border rounded">
                Back
              </button>
              <button
                onClick={() => close('custom')}
                className="px-3 py-1.5 text-sm rounded bg-primary text-primary-foreground">
                Save preferences
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
