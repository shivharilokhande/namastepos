import { defineConfig, devices } from '@playwright/test';

// NamastePOS customer-dashboard E2E config.
//   pnpm exec playwright install
//   pnpm exec playwright test
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:5174',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium-desktop', use: devices['Desktop Chrome'] },
    { name: 'mobile-safari',    use: devices['iPhone 14'] },
  ],
});
