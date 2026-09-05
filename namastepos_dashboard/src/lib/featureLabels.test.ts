import { describe, it, expect } from 'vitest';
import { REGISTRY_LABELS, featureLabel, humaniseKey, serverLabelsFor } from './featureLabels';

describe('featureLabels — D-18', () => {
  it('mirrors all 52 registry keys (no more 45-entry drift)', () => {
    expect(Object.keys(REGISTRY_LABELS)).toHaveLength(52);
    // The seven keys the review found missing from the old BillingPage map.
    for (const k of ['auto_whatsapp_order', 'custom_branding', 'dashboard_access', 'inventory_tracking', 'pnl_statement', 'registers', 'tax_invoices']) {
      expect(REGISTRY_LABELS[k]).toBeTruthy();
    }
    expect(featureLabel('pnl_statement')).toBe('P&L statement');
  });

  it('prefers server-sent labels over the local mirror', () => {
    const plan = { featureLabels: { kds: 'Kitchen screen (server)' }, features: {} };
    const labels = serverLabelsFor(plan);
    expect(featureLabel('kds', labels)).toBe('Kitchen screen (server)');
    expect(featureLabel('orders', labels)).toBe(REGISTRY_LABELS.orders);
  });

  it('accepts features: [{ key, label }] and ignores the legacy features: {} object', () => {
    expect(serverLabelsFor({ features: [{ key: 'kds', label: 'K' }] })).toEqual({ kds: 'K' });
    expect(serverLabelsFor({ features: { staff: 3 } })).toEqual({});
    expect(serverLabelsFor(null)).toEqual({});
  });

  it('humanises unknown keys instead of showing them raw', () => {
    expect(humaniseKey('some_new_thing')).toBe('Some new thing');
    expect(featureLabel('some_new_thing')).toBe('Some new thing');
  });
});
