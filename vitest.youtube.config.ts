import { defineConfig } from 'vitest/config';

// Runs the opt-in YouTube integration tests in isolation.
export default defineConfig({
  test: {
    fileParallelism: false,
    include: ['test/live/**/*.test.ts'],
    testTimeout: 300_000,
  },
});
