// Minimal i18n — no extra dependency. Reads locale from getBusinessCache()
// (set on login) + a localStorage override the user can flip via UI.

import en from './en.json';
import hi from './hi.json';

type Bundle = Record<string, any>;
const BUNDLES: Record<string, Bundle> = { 'en-IN': en, 'en': en, 'hi-IN': hi, 'hi': hi };
const LOCALE_KEY = 'ff_locale';

export function getLocale(): string {
  if (typeof window === 'undefined') return 'en-IN';
  const stored = localStorage.getItem(LOCALE_KEY);
  if (stored) return stored;
  return navigator.language?.toLowerCase().startsWith('hi') ? 'hi-IN' : 'en-IN';
}

export function setLocale(locale: string) {
  if (typeof window !== 'undefined') {
    localStorage.setItem(LOCALE_KEY, locale);
    window.dispatchEvent(new CustomEvent('locale-changed', { detail: locale }));
  }
}

export function t(path: string): string {
  const locale = getLocale();
  const bundle = BUNDLES[locale] || BUNDLES['en-IN'];
  const parts = path.split('.');
  let cur: any = bundle;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object') return path;
    cur = cur[p];
  }
  return typeof cur === 'string' ? cur : path;
}

export const LANGS = [
  { code: 'en-IN', name: 'English' },
  { code: 'hi-IN', name: 'हिन्दी' },
];
