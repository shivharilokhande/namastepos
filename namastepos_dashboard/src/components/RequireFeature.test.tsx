// RequireFeature — spinner while loading, upgrade card when the key is
// absent, children when present (D-10).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/hooks/usePlan', () => ({ usePlan: vi.fn() }));
vi.mock('@/hooks/useRequiredTier', () => ({ useRequiredTierFor: vi.fn() }));

import { usePlan } from '@/hooks/usePlan';
import { useRequiredTierFor } from '@/hooks/useRequiredTier';
import { RequireFeature } from './RequireFeature';

const planMock = usePlan as unknown as ReturnType<typeof vi.fn>;
const tierMock = useRequiredTierFor as unknown as ReturnType<typeof vi.fn>;

function planState(over: Partial<{ isLoading: boolean; loaded: boolean; features: string[]; tierLabel: string }>) {
  const features = new Set(over.features ?? []);
  const loaded = over.loaded ?? true;
  return {
    tierKind: 'starter', tierLabel: over.tierLabel ?? 'Starter', nextTierLabel: 'Growth',
    features: [...features],
    has: (k: string) => loaded && features.has(k),
    atLeast: () => false, isStarter: loaded, isPro: false, isEnterprise: false,
    isLoading: over.isLoading ?? false, loaded,
    planVersion: 1, role: 'business_owner', permissions: null,
  };
}

const ui = (feature: string) => render(
  <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
    <RequireFeature feature={feature}><div data-testid="page">the page</div></RequireFeature>
  </MemoryRouter>,
);

describe('RequireFeature', () => {
  beforeEach(() => {
    planMock.mockReset();
    tierMock.mockReset();
    tierMock.mockReturnValue({ label: 'Pro', isLoading: false });
  });

  it('renders the upgrade card (not the page) when the key is absent', () => {
    planMock.mockReturnValue(planState({ features: ['orders'] }));
    ui('recurring_invoices');
    expect(screen.getByTestId('feature-upgrade-card')).toBeInTheDocument();
    expect(screen.queryByTestId('page')).not.toBeInTheDocument();
    expect(screen.getByText(/in the Pro plan/)).toBeInTheDocument();
    expect(screen.getByText(/you are on Starter/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /view plans/i })).toHaveAttribute('href', '/billing');
  });

  it('renders the page when the key is present', () => {
    planMock.mockReturnValue(planState({ features: ['recurring_invoices'] }));
    ui('recurring_invoices');
    expect(screen.getByTestId('page')).toBeInTheDocument();
    expect(screen.queryByTestId('feature-upgrade-card')).not.toBeInTheDocument();
  });

  it('shows a spinner (never the page, never a lock) while /auth/me is in flight', () => {
    planMock.mockReturnValue(planState({ isLoading: true, loaded: false }));
    ui('recurring_invoices');
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByTestId('page')).not.toBeInTheDocument();
    expect(screen.queryByTestId('feature-upgrade-card')).not.toBeInTheDocument();
  });

  it('falls through to the upgrade card when the server returned plan: null', () => {
    planMock.mockReturnValue(planState({ isLoading: false, loaded: false }));
    ui('kds');
    expect(screen.getByTestId('feature-upgrade-card')).toBeInTheDocument();
  });

  it('says so honestly when no public plan carries the key', () => {
    planMock.mockReturnValue(planState({ features: [] }));
    tierMock.mockReturnValue({ label: null, isLoading: false });
    ui('white_label');
    expect(screen.getByText(/not included in your current plan/)).toBeInTheDocument();
  });
});
