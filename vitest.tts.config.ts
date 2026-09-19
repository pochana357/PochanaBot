import { defineConfig } from 'vitest/config';

// Runs the opt-in text-to-speech integration tests in isolation.
export default defineConfig({
  test: {
    fileParallelism: false,
    include: ['test/live/tts.test.ts'],
    testTimeout: 120_000,
  },
});
