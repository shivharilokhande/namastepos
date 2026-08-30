import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

import { reticle } from '@reticlehq/vite-plugin';
export default defineConfig({
  plugins: [reticle({ captureNetworkBodies: true }),react()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  // Vendor code-splitting (2026-08-25): pair with App.tsx's React.lazy so the
  // heavy third-party libs land in their own long-lived chunks instead of the
  // page/main bundle. recharts (only Reports/HeatMap/Forecast need it) and
  // sentry are the big ones; react/router stay together as the shared runtime.
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-recharts': ['recharts'],
          'vendor-sentry': ['@sentry/react'],
        },
      },
    },
  },
  server: {
    port: 5174,
    proxy: {
      '/v1': {
        target: process.env.VITE_API_URL || 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
});
