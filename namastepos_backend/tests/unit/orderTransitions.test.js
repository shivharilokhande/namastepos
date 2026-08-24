// Unit test for the order-status transition matrix (P1 fix 2026-08-22).
// The matrix is the source of truth for what state changes are legal —
// this test locks the invariants that must never regress.

const { ORDER_TRANSITIONS } = require('../../src/services/orderService');

describe('ORDER_TRANSITIONS matrix', () => {
  test('exposes exactly the four canonical statuses as keys', () => {
    expect(Object.keys(ORDER_TRANSITIONS).sort()).toEqual(
      ['cancelled', 'collected', 'pending', 'ready'].sort()
    );
  });

  test('cancelled is a terminal state', () => {
    expect(ORDER_TRANSITIONS.cancelled).toEqual([]);
  });

  test('pending can fast-collect (skip ready) or cancel', () => {
    expect(ORDER_TRANSITIONS.pending).toEqual(
      expect.arrayContaining(['ready', 'collected', 'cancelled'])
    );
  });

  test('ready can only move forward (collect) or cancel', () => {
    expect(ORDER_TRANSITIONS.ready).toEqual(
      expect.arrayContaining(['collected', 'cancelled'])
    );
    expect(ORDER_TRANSITIONS.ready).not.toContain('pending');
  });

  test('collected can only be cancelled (refund path), never un-collected', () => {
    expect(ORDER_TRANSITIONS.collected).toEqual(['cancelled']);
    expect(ORDER_TRANSITIONS.collected).not.toContain('pending');
    expect(ORDER_TRANSITIONS.collected).not.toContain('ready');
  });

  test('no state can rewind to pending — the loyalty double-award bug', () => {
    // The regression that motivated the matrix: `collected → pending → collected`
    // re-awarded loyalty. Assert no non-terminal move lands in `pending`.
    for (const [from, targets] of Object.entries(ORDER_TRANSITIONS)) {
      if (from === 'pending') continue;
      expect(targets).not.toContain('pending');
    }
  });
});
