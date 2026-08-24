// NamastePOS — Crisp support chat widget (FF-301).
//
// Reads VITE_CRISP_WEBSITE_ID from build env; if unset, renders nothing
// so dev environments stay clean. In prod the widget lazy-loads Crisp's
// snippet after the app mounts (so it never blocks first paint).
//
// Signed-in owners are auto-identified so support can see who they are
// without asking every time. Nothing PII-sensitive goes to Crisp:
// email + business name only, no phone or address.

import { useEffect } from 'react';
import { getBusinessCache } from '@/api/client';

declare global {
  interface Window {
    $crisp?: unknown[];
    CRISP_WEBSITE_ID?: string;
    CRISP_RUNTIME_CONFIG?: { locale?: string };
  }
}

export function CrispChat() {
  useEffect(() => {
    const id = (import.meta.env.VITE_CRISP_WEBSITE_ID as string) || '';
    if (!id) return;
    if (document.getElementById('crisp-loader')) return;   // idempotent

    // 1. Initialize globals BEFORE the script tag runs (Crisp's protocol).
    window.$crisp = [];
    window.CRISP_WEBSITE_ID = id;
    window.CRISP_RUNTIME_CONFIG = { locale: navigator.language.split('-')[0] || 'en' };

    // 2. Push identity hints so agents see who's chatting.
    try {
      const biz = getBusinessCache();
      if (biz?.name) window.$crisp.push(['set', 'user:company', [biz.name]]);
      const me = localStorage.getItem('ff_user_email');
      if (me) window.$crisp.push(['set', 'user:email', [me]]);
    } catch { /* biz cache not ready yet — Crisp still works, just anonymous */ }

    // 3. Inject the script tag. `async` so it never blocks page render.
    const s = document.createElement('script');
    s.id = 'crisp-loader';
    s.async = true;
    s.src = 'https://client.crisp.chat/l.js';
    document.head.appendChild(s);
  }, []);
  return null;
}
