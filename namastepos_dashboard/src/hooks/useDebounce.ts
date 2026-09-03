import { useEffect, useState } from 'react';

/**
 * NP-129 — debounce a fast-changing value (e.g. a search input) before it
 * enters a react-query queryKey, so typing doesn't fire one request per
 * keystroke. Returns the trailing value after `delayMs` of quiet.
 */
export function useDebounce<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
