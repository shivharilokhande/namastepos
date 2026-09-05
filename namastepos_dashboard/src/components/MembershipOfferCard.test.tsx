// MembershipOfferCard — round 3 (2026-09-06, founder Bug 2): used-up
// membership → Renew card; none → compact Offer control; gated on
// `memberships`; purchase goes through POST /memberships/subscribe (renew
// tries /customer-memberships/:id/renew first, 404 → subscribe).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/hooks/usePlan', () => ({ usePlan: vi.fn() }));
vi.mock('@/api/client', () => ({
  api: { post: vi.fn() },
  apiError: (e: any) => e?.message || String(e),
  getBusinessCache: () => ({ id: 'biz-1' }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { usePlan } from '@/hooks/usePlan';
import { api } from '@/api/client';
import { MembershipOfferCard } from './MembershipOfferCard';

const planMock = usePlan as unknown as ReturnType<typeof vi.fn>;
const postMock = (api as any).post as ReturnType<typeof vi.fn>;

function plan(features: string[]) {
  const set = new Set(features);
  return { has: (k: string) => set.has(k), loaded: true, features } as any;
}

const usedUp = {
  id: 'sub-1', membershipId: 'm-1', name: 'Coffee 10', exhausted: true, expired: false,
  remaining: [{ menuItemId: 'mi-1', name: 'Cold coffee', qty: 0 }], renewPricePaise: 49900,
};
const available = [
  { id: 'm-1', name: 'Coffee 10', pricePaise: 49900, validityDays: 30, includes: [] },
  { id: 'm-2', name: 'Gold 10%', pricePaise: 99900, validityDays: 365, includes: [] },
];

const ui = (props: Partial<React.ComponentProps<typeof MembershipOfferCard>> = {}) => {
  const qc = new QueryClient();
  const onPurchased = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <MembershipOfferCard
        customerId="cust-1" customerLabel="Shiv"
        activeMembership={usedUp} availableMemberships={available}
        onPurchased={onPurchased} {...props}
      />
    </QueryClientProvider>,
  );
  return { onPurchased };
};

describe('MembershipOfferCard', () => {
  beforeEach(() => { planMock.mockReset(); postMock.mockReset(); });

  it('renders nothing without the memberships key (fail-closed)', () => {
    planMock.mockReturnValue(plan(['loyalty']));
    ui();
    expect(screen.queryByTestId('membership-usedup-card')).toBeNull();
    expect(screen.queryByTestId('membership-offer-card')).toBeNull();
  });

  it('used-up membership → "is used up — renew for ₹499" + other plans', () => {
    planMock.mockReturnValue(plan(['memberships']));
    ui();
    const card = screen.getByTestId('membership-usedup-card');
    expect(card.textContent).toMatch(/Coffee 10/);
    expect(card.textContent).toMatch(/used up/);
    expect(card.textContent).toMatch(/renew for/);
    expect(card.textContent).toMatch(/499/);
    expect(card.textContent).toMatch(/Gold 10%/);
    expect(screen.getByRole('button', { name: /Renew/ })).toBeTruthy();
  });

  it('healthy membership → renders nothing', () => {
    planMock.mockReturnValue(plan(['memberships']));
    ui({ activeMembership: { ...usedUp, exhausted: false, remaining: [{ qty: 3 }] } });
    expect(screen.queryByTestId('membership-usedup-card')).toBeNull();
    expect(screen.queryByTestId('membership-offer-card')).toBeNull();
  });

  it('no membership → compact Offer control, falls back to raw plan rows', () => {
    planMock.mockReturnValue(plan(['memberships']));
    ui({ activeMembership: null, availableMemberships: null,
      rawPlans: [{ id: 'r-1', name: 'Raw Plan', price_paise: 25000, is_active: true }] });
    const card = screen.getByTestId('membership-offer-card');
    expect(card.textContent).toMatch(/Offer membership/);
    fireEvent.click(screen.getByRole('button', { name: /Offer membership/ }));
    expect(card.textContent).toMatch(/Raw Plan/);
  });

  it('Renew → tries /renew, 404 → falls back to /memberships/subscribe, then refetches', async () => {
    planMock.mockReturnValue(plan(['memberships']));
    postMock
      .mockRejectedValueOnce(Object.assign(new Error('Not found'), {
        isAxiosError: true, response: { status: 404 }, toJSON: () => ({}),
      }))
      .mockResolvedValueOnce({ data: { subscription: { id: 'sub-2' } } });
    const { onPurchased } = ui();
    fireEvent.click(screen.getByRole('button', { name: /Renew/ }));
    fireEvent.click(screen.getByRole('button', { name: /Confirm/ }));
    await waitFor(() => expect(onPurchased).toHaveBeenCalledTimes(1));
    expect(postMock).toHaveBeenCalledTimes(2);
    expect(postMock.mock.calls[0][0]).toBe('/businesses/biz-1/customer-memberships/sub-1/renew');
    expect(postMock.mock.calls[0][1]).toMatchObject({ paymentMethod: 'cash' });
    expect(postMock.mock.calls[1][0]).toBe('/businesses/biz-1/memberships/subscribe');
    expect(postMock.mock.calls[1][1]).toMatchObject({
      customerId: 'cust-1', membershipId: 'm-1', paymentMethod: 'cash',
    });
  });

  it('Buy another plan → subscribe directly with the chosen tender', async () => {
    planMock.mockReturnValue(plan(['memberships']));
    postMock.mockResolvedValueOnce({ data: { subscription: { id: 'sub-3' } } });
    const { onPurchased } = ui({ walletBalanceInr: 2000 });
    fireEvent.click(screen.getByRole('button', { name: /^Buy$/ }));
    // wallet ≥ price → wallet is pre-selected; switch to UPI explicitly
    const select = screen.getByTestId('membership-tender').querySelector('select')!;
    expect(select.value).toBe('wallet');
    fireEvent.change(select, { target: { value: 'upi' } });
    fireEvent.click(screen.getByRole('button', { name: /Confirm/ }));
    await waitFor(() => expect(onPurchased).toHaveBeenCalledTimes(1));
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(postMock.mock.calls[0][0]).toBe('/businesses/biz-1/memberships/subscribe');
    expect(postMock.mock.calls[0][1]).toMatchObject({ membershipId: 'm-2', paymentMethod: 'upi' });
  });
});
