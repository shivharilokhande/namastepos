import { defineConfig, devices } from '@playwright/test';

// NamastePOS super-admin panel E2E config.
//   npm exec playwright install
//   npm exec playwright test
//
// The admin is desktop-only; there's no mobile project.
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium-desktop', use: devices['Desktop Chrome'] },
  ],
});
