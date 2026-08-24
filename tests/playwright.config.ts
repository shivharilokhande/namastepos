import { defineConfig, devices } from '@playwright/test';
import path from 'path';

const FF_BASE_URL  = process.env.FF_BASE_URL  || 'http://localhost:5174'; // dashboard
const FF_ADMIN_URL = process.env.FF_ADMIN_URL || 'http://localhost:5173'; // super-admin

// storageState files written by specs/_auth.setup.ts. Defining the paths
// here directly (instead of importing the setup file) keeps config
// evaluation free of cross-imports.
const adminAuthFile = path.resolve(__dirname, '.auth', 'admin.json');
const ownerAuthFile = path.resolve(__dirname, '.auth', 'owner.json');

export default defineConfig({
  testDir: './specs',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  fullyParallel: false,            // shared DB → serialize to avoid races
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    // Setup project: logs admin in ONCE and persists storageState to disk.
    // The admin project depends on this so every admin spec reuses the
    // session — avoids tripping the backend's /admin/login rate limit
    // (20/min) when running all 18 admin specs.
    {
      name: 'setup',
      testMatch: /_auth\.setup\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: FF_ADMIN_URL },
    },
    // Owner dashboard tests: any spec NOT containing "admin-" in the name.
    // Pre-authenticated via storageState. The login spec opts out at file level.
    {
      name: 'dashboard',
      testMatch: /\d\d-(?!admin-).*\.spec\.ts/,
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        baseURL: FF_BASE_URL,
        storageState: ownerAuthFile,
      },
    },
    // Super-admin tests: any spec WITH "admin-" segment in the name.
    {
      name: 'admin',
      testMatch: /\d\d-admin-.*\.spec\.ts/,
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        baseURL: FF_ADMIN_URL,
        storageState: adminAuthFile,
      },
    },
  ],
});
