import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'dist/**', 'release/**', '.scratch/**', 'tests/e2e/**', '**/*.e2e.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    teardownTimeout: 10_000,
  },
});
