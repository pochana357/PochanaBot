import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Live tests contact external services and run only through their opt-in config.
    exclude: [...configDefaults.exclude, 'test/live/**'],
  },
});
