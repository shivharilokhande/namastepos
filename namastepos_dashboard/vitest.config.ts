// NamastePOS dashboard — unit tests (vitest + jsdom + Testing Library).
//
// 2026-09-06 (round 2): first unit-test runner for this package. Kept
// SEPARATE from vite.config.ts on purpose: the app config loads the Reticle
// dev plugin and the manualChunks build tuning, neither of which belongs in
// a test run. Only `@` aliasing and the React plugin are shared.
//
//   npm test        → vitest run (CI)
//   npx vitest      → watch mode
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  test: {
    environment: 'jsdom',
    globals: false,
    // A shell with NODE_ENV=production exported (the founder's Mac has one)
    // made React resolve its production build, where act() is unsupported and
    // every component test failed. Tests always run as 'test'.
    env: { NODE_ENV: 'test' },
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // Playwright specs live in tests/e2e and are NOT vitest tests.
    exclude: ['node_modules', 'dist', 'tests/**', 'testsprite_tests/**'],
    css: false,
  },
});
