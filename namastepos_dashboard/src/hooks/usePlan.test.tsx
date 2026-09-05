// usePlan — FAIL-CLOSED (D-15). `has()` is false for every key until
// /auth/me has answered with a plan block, then true only for granted keys.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/api/namastepos', () => ({
  ffApi: { me: vi.fn() },
}));

import { ffApi } from '@/api/namastepos';
import { usePlan } from './usePlan';

const meMock = ffApi.me as unknown as ReturnType<typeof vi.fn>;

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const ME = {
  user: { id: 'u1' },
  business: { id: 'b1' },
  role: 'business_owner',
  memberships: [],
  permissions: null,
  plan: { tierKind: 'pro_plan', features: ['kds', 'orders'], planVersion: 7 },
};

describe('usePlan', () => {
  // Braces matter: a hook that RETURNS a value hands vitest a "cleanup"
  // callback — mockReset() returns the mock, which vitest would then call and
  // await (a never-resolving promise in the first test).
  beforeEach(() => { meMock.mockReset(); });

  it('denies every key before /auth/me resolves, grants only listed keys after', async () => {
    let resolveMe: (v: unknown) => void = () => {};
    meMock.mockImplementation(() => new Promise((res) => { resolveMe = res; }));

    const { result } = renderHook(() => usePlan(), { wrapper: wrapper() });

    // Before load: fail-closed.
    expect(result.current.isLoading).toBe(true);
    expect(result.current.loaded).toBe(false);
    expect(result.current.has('kds')).toBe(false);
    expect(result.current.has('orders')).toBe(false);
    expect(result.current.isStarter).toBe(false);
    expect(result.current.isEnterprise).toBe(false);
    expect(result.current.tierLabel).toBe('');

    resolveMe(ME);
    await waitFor(() => expect(result.current.loaded).toBe(true));

    expect(result.current.has('kds')).toBe(true);
    expect(result.current.has('orders')).toBe(true);
    expect(result.current.has('white_label')).toBe(false);
    expect(result.current.planVersion).toBe(7);
    expect(result.current.role).toBe('business_owner');
    expect(result.current.permissions).toBeNull();
  });

  it('stays fail-closed when the server answers with plan: null', async () => {
    meMock.mockResolvedValue({ ...ME, plan: null });
    const { result } = renderHook(() => usePlan(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.loaded).toBe(false);
    expect(result.current.has('kds')).toBe(false);
    expect(result.current.features).toEqual([]);
  });

  it('exposes staff role + permissions from /auth/me', async () => {
    meMock.mockResolvedValue({ ...ME, role: 'staff_kitchen', permissions: ['home', 'kds'] });
    const { result } = renderHook(() => usePlan(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.role).toBe('staff_kitchen');
    expect(result.current.permissions).toEqual(['home', 'kds']);
  });
});
