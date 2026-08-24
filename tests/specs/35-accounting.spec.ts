import { test, expect } from '@playwright/test';

test.describe('Accounting', () => {
  test('accounting page renders', async ({ page }) => {
    await page.goto('/accounting');
    await page.waitForLoadState('networkidle').catch(() => {});
  });
  test('does not throw runtime errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    await page.goto('/accounting');
    await page.waitForLoadState('networkidle').catch(() => {});
    expect(errors).toEqual([]);
  });
  test('accounting reports page renders', async ({ page }) => {
    await page.goto('/accounting-reports');
    await page.waitForLoadState('networkidle').catch(() => {});
  });
});

test.describe('Bank reconciliation', () => {
  test('bank-reconcile page renders without throwing', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    await page.goto('/bank-reconcile');
    await page.waitForLoadState('networkidle').catch(() => {});
    expect(errors).toEqual([]);
  });
});

test.describe('Daily closing', () => {
  test('daily-closing page renders', async ({ page }) => {
    await page.goto('/daily-closing');
    await page.waitForLoadState('networkidle').catch(() => {});
  });
});

test.describe('Wastage', () => {
  test('wastage page renders', async ({ page }) => {
    await page.goto('/wastage');
    await page.waitForLoadState('networkidle').catch(() => {});
  });
});

test.describe('Drivers', () => {
  test('drivers page renders', async ({ page }) => {
    await page.goto('/drivers');
    await page.waitForLoadState('networkidle').catch(() => {});
  });
});

test.describe('Surge pricing', () => {
  test('surge page renders', async ({ page }) => {
    await page.goto('/surge');
    await page.waitForLoadState('networkidle').catch(() => {});
  });
});

test.describe('Heat map', () => {
  test('heat-map page renders', async ({ page }) => {
    await page.goto('/heat-map');
    await page.waitForLoadState('networkidle').catch(() => {});
  });
});

test.describe('Forecast', () => {
  test('forecast page renders', async ({ page }) => {
    await page.goto('/forecast');
    await page.waitForLoadState('networkidle').catch(() => {});
  });
});

test.describe('Bulk import', () => {
  test('bulk-import page renders', async ({ page }) => {
    await page.goto('/bulk-import');
    await page.waitForLoadState('networkidle').catch(() => {});
  });
});

test.describe('Online site', () => {
  test('online-site page renders', async ({ page }) => {
    await page.goto('/online-site');
    await page.waitForLoadState('networkidle').catch(() => {});
  });
});
