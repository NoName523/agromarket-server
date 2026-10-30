import { defineConfig } from 'vitest/config';
import dotenv from 'dotenv';

const { parsed } = dotenv.config({ path: '.env.test', override: true, quiet: true });

export default defineConfig({
  test: {
    include: [
      'tests/access.test.js',
      'tests/auth.test.js',
      'tests/health.test.js',
      'tests/middleware.test.js',
      'tests/orders-my.test.js',
      'tests/products.test.js',
      'tests/rate-limit.test.js',
    ],
    env: parsed,
    globalSetup: './tests/globalSetup.js',
    setupFiles: ['./tests/setup.js'],
    fileParallelism: false,
    coverage: { include: ['app.js', 'routes/**', 'middleware/**'] },
  },
});
