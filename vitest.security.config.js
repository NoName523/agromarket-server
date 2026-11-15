import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/security.test.js'],
    setupFiles: ['./tests/setup.js'],
    fileParallelism: false,
  },
});
