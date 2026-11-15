import { defineConfig } from 'vitest/config';

// Route tests use PostgreSQL mocks and never load the destructive integration setup.
export default defineConfig({
  test: {
    include: ['tests/login-route.test.js'],
    setupFiles: ['./tests/setup.js'],
    fileParallelism: false,
  },
});
