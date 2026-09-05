// NamastePOS dashboard — owner-facing labels for plan feature KEYS.
//
// D-18 (2026-09-06). BillingPage used to carry its own 45-entry label map
// that had drifted from the backend registry (7 keys missing → "pnl
// statement"-style raw keys on the plan cards). The rule now:
//
//   1. If the plan object from the server carries labels — `featureLabels`
//      ({ key: label }) or `features` as [{ key, label }] — USE THEM. That is
//      the intended end state: `/plans` and `/public/plans` emitting
//      `featureLabels` from `featureRegistry.labelOf` (backend change, see the
//      round-2 report). Nothing here needs to change when that ships.
//   2. Otherwise fall back to REGISTRY_LABELS below — a verbatim mirror of
//      `namastepos_backend/src/config/featureRegistry.js` `label` fields for
//      all 52 keys as of 2026-09-06. Keep it in sync with the registry, not
//      with marketing copy; the drift test on the backend guards the key SET,
//      this file guards only the words.
//   3. Unknown key → humanised key ("dead_stock" → "Dead stock"), never blank.

export const REGISTRY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  // Core
  pos: 'POS / billing screen',
  orders: 'Orders',
  token_generation: 'Token / queue numbers',
  expenses: 'Expense book',
  staff_lite: 'Staff accounts',
  staff_unlimited: 'Unlimited staff accounts',
  dashboard_access: 'Web dashboard access',
  custom_branding: 'Custom bill branding',
  // Menu
  menu_basic: 'Menu management',
  menu_variants_modifiers: 'Variants & modifiers',
  inventory_tracking: 'Inventory tracking',
  recipe_costing: 'Recipe costing',
  wastage: 'Wastage log',
  dead_stock: 'Dead-stock report',
  bulk_import: 'Bulk menu import',
  // Floor
  tables_single_floor: 'Tables (single floor)',
  tables_multi_floor: 'Multiple floors',
  reservations: 'Reservations & wait-list',
  bill_split: 'Split bill / split payment',
  kds: 'Kitchen display (KDS/KOT)',
  captain_mode: 'Captain ordering',
  voice_pos: 'Voice POS (speak an order)',
  daily_closing: 'Day-end closing',
  surge_pricing: 'Surge / happy-hour pricing',
  // Delivery & online
  driver_mode: 'Driver app & assignments',
  aggregators: 'Aggregator orders (online)',
  qr_ordering: 'QR self-ordering',
  // Customers
  customers_basic: 'Customer directory',
  customers_crm: 'Customer CRM (segments, history)',
  loyalty: 'Loyalty points & wallet',
  memberships: 'Memberships / prepaid packs',
  reviews: 'Customer reviews',
  whatsapp_marketing: 'WhatsApp marketing',
  auto_whatsapp_order: 'Automatic WhatsApp order updates',
  // Reports
  reports_basic: 'Basic reports',
  registers: 'Registers (sales / cash / expense)',
  pnl_statement: 'P&L statement',
  heat_map: 'Sales heat-map',
  forecast: 'Sales forecast & upsell',
  // Billing & accounting
  invoice_basic: 'Basic invoices',
  tax_invoices: 'GST tax invoices',
  b2b_invoice: 'B2B invoices',
  einvoice_gst: 'GST e-invoice (GSP connection required)',
  recurring_invoices: 'Recurring invoices',
  accounting_pnl_bs: 'Accounting (P&L + balance sheet)',
  bank_reconcile: 'Bank reconciliation',
  tds_tcs: 'TDS / TCS',
  multi_currency_fx: 'Multi-currency / FX',
  // Advanced
  multi_outlet: 'Multi-outlet',
  marketplace_addons: 'Add-on marketplace',
  api_access: 'API access',
  white_label: 'White-label branding',
});

/** "dead_stock" → "Dead stock". Last resort only. */
export function humaniseKey(key: string): string {
  const s = String(key || '').replace(/_/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

/**
 * Labels the server attached to a plan, if any. Accepts either shape we might
 * reasonably emit — `featureLabels: { key: label }` or
 * `features: [{ key, label }]` — and ignores the legacy `features: {}`
 * limits/flags object that `serializePlan` sends today.
 */
export function serverLabelsFor(plan: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!plan || typeof plan !== 'object') return out;
  const p = plan as { featureLabels?: unknown; features?: unknown };
  if (p.featureLabels && typeof p.featureLabels === 'object') {
    for (const [k, v] of Object.entries(p.featureLabels as Record<string, unknown>)) {
      if (typeof v === 'string' && v) out[k] = v;
    }
  }
  if (Array.isArray(p.features)) {
    for (const f of p.features as unknown[]) {
      if (f && typeof f === 'object') {
        const { key, label } = f as { key?: unknown; label?: unknown };
        if (typeof key === 'string' && typeof label === 'string' && label) out[key] = label;
      }
    }
  }
  return out;
}

/** Owner-facing label for `key`: server label → registry mirror → humanised key. */
export function featureLabel(key: string, serverLabels?: Record<string, string> | null): string {
  return (serverLabels && serverLabels[key]) || REGISTRY_LABELS[key] || humaniseKey(key);
}
