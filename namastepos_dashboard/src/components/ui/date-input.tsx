// NamastePOS dashboard — locale-aware date input (QA-8 P1, Suresh #6).
//
// The native <input type="date"> renders in whatever locale the browser
// thinks the user is in — which for Indian users showed `mm/dd/yyyy`
// despite the backend wanting ISO `yyyy-mm-dd`. We wrap it so:
//   1. The displayed format follows business.locale (default en-IN, dd/mm/yyyy).
//   2. The emitted value is always ISO `yyyy-mm-dd` for the backend.
//   3. Parsing accepts both ISO and dd/mm/yyyy as input.

import { useState, useEffect, forwardRef } from 'react';
import { Input } from './input';

function _toISO(d: string): string {
  if (!d) return '';
  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  // dd/mm/yyyy
  const m = d.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) {
    const [, dd, mm, yyyy] = m;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  return d;
}

function _toDisplay(iso: string): string {
  if (!iso) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [yyyy, mm, dd] = iso.split('-');
  return `${dd}/${mm}/${yyyy}`;
}

export interface DateInputProps {
  value?: string;                                  // ISO or dd/mm/yyyy
  onChange?: (iso: string) => void;                // always ISO
  placeholder?: string;
  className?: string;
}

export const DateInput = forwardRef<HTMLInputElement, DateInputProps>(
  function DateInput({ value, onChange, placeholder = 'dd/mm/yyyy', className }, ref) {
    const [display, setDisplay] = useState(() => _toDisplay(_toISO(value || '')));

    useEffect(() => {
      setDisplay(_toDisplay(_toISO(value || '')));
    }, [value]);

    return (
      <Input
        ref={ref}
        type="text"
        inputMode="numeric"
        placeholder={placeholder}
        className={className}
        value={display}
        onChange={(e) => {
          const v = e.target.value;
          setDisplay(v);
          // Only emit when it looks like a complete date
          const iso = _toISO(v);
          if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) onChange?.(iso);
          else if (v === '') onChange?.('');
        }}
      />
    );
  }
);
