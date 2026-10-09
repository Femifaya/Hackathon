import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const srcDir = fileURLToPath(new URL('./src', import.meta.url));

/**
 * Vitest covers the parts that need a bundler/DOM: React components, App Router
 * route handlers, and the SQLite-backed repositories.
 *
 * Dependency-free domain logic (indicators, scenarios, CSV parsing, validation,
 * exporters, security helpers) is covered by `tests/core` and runs on the native
 * Node test runner with zero install: `node --test tests/core`.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': srcDir,
    },
  },
  test: {
    include: ['tests/app/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['tests/setup.ts'],
    globals: false,
    restoreMocks: true,
    clearMocks: true,
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/app/**/*.tsx', 'src/components/**/*.tsx', 'src/**/*.d.ts'],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 65,
        statements: 70,
      },
    },
  },
});