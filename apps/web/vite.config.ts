import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  // Browser e2e against the real server (playwright.live.config.ts): same-origin proxy.
  server: process.env.LIVE_API_TARGET
    ? {
        proxy: {
          // changeOrigin must stay false: the server compares Origin with Host.
          '/api': { target: process.env.LIVE_API_TARGET, changeOrigin: false },
          '/ws': {
            target: process.env.LIVE_API_TARGET,
            changeOrigin: false,
            ws: true,
          },
        },
      }
    : undefined,
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    exclude: [
      'e2e/**',
      'e2e-live/**',
      'e2e-adventure/**',
      'dist/**',
      'node_modules/**',
    ],
  },
});
