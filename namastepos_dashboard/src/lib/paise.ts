// NamastePOS dashboard — rupee ↔ paise at the form boundary (2026-09-06).
//
// New endpoints carry money as `*Paise` integers on the wire (CONTRACTS
// round 2). Owners type rupees; these helpers convert exactly once, on
// submit, so nothing downstream ever holds a float rupee amount.

/** Rupee string/number → integer paise. NaN / negative / blank → 0. */
export function inrToPaise(inr: string | number): number {
  const n = Number(inr);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}

/** Integer paise → rupees for display math (formatINR takes rupees). */
export function paiseToInr(paise: number | null | undefined): number {
  return (Number(paise) || 0) / 100;
}

/**
 * One invoice line incl. GST, in paise — the same arithmetic the server
 * applies per recurring-invoice item (base = qty × unit, GST rounded on the
 * base). Display only; the server's figure is authoritative.
 */
export function lineTotalPaise(qty: number, unitPricePaise: number, gstPct: number): number {
  const base = Math.round((Number(qty) || 0) * (Number(unitPricePaise) || 0));
  return base + Math.round(base * (Number(gstPct) || 0) / 100);
}
