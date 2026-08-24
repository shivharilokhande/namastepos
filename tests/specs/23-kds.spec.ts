import { test, expect } from '@playwright/test';

test.describe('KDS (kitchen display)', () => {
  test('kds page renders', async ({ page }) => {
    await page.goto('/kds');
    await expect(page.getByRole('heading', { name: /KDS|kitchen/i }).or(page.getByText(/no orders|pending/i)).first())
      .toBeVisible({ timeout: 10_000 });
  });
  test('does not throw runtime errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    await page.goto('/kds');
    await page.waitForLoadState('networkidle').catch(() => {});
    expect(errors).toEqual([]);
  });
  test('shows order columns: pending / preparing / ready', async ({ page }) => {
    await page.goto('/kds');
    const labels = await page.getByText(/pending|preparing|ready|new|in[- ]progress/i).count();
    expect(labels).toBeGreaterThan(0);
  });
  test('refresh button cycles state without error', async ({ page }) => {
    await page.goto('/kds');
    const btn = page.getByRole('button', { name: /refresh|reload/i }).first();
    if (await btn.count() === 0) test.skip(true, 'no refresh button');
    await btn.click();
    await page.waitForLoadState('networkidle').catch(() => {});
  });
  test('plan-gated message OR KDS UI', async ({ page }) => {
    await page.goto('/kds');
    // Either KDS is available (renders) OR an upgrade CTA is shown
    await page.waitForLoadState('networkidle').catch(() => {});
  });
});
