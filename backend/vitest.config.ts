import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        // Runs ONLY against a deployed stack. Requires backend/e2e.config.json (created by scripts/deploy-backend.ps1).
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.test.ts'],
          environment: 'node',
          testTimeout: 240_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'text'],
    },
  },
});
