import { execFileSync } from 'node:child_process';
import dotenv from 'dotenv';
import { randomBytes } from 'node:crypto';
import { assertTestInitConfiguration } from '../db/test-init-guard.js';

const loaded = dotenv.config({ path: '.env.test', override: true, quiet: true });
if (loaded.error && loaded.error.code !== 'ENOENT') {
  console.error('Unable to load the test environment file.');
  process.exit(1);
}

function assertTestDatabase() {
  if (!process.env.DATABASE_URL) {
    throw new Error('Tests require DATABASE_URL in .env.test for agromarket_test.');
  }
  assertTestInitConfiguration({ databaseUrl: process.env.DATABASE_URL, nodeEnv: 'test' });
}

try {
  assertTestDatabase();
  process.env.NODE_ENV = 'test';
  process.env.LOGIN_ATTEMPT_SECRET = randomBytes(32).toString('hex');
  execFileSync(process.execPath, ['--test',
    'tests/admin-rotation.test.js',
    'tests/auth-boundaries.test.js',
    'tests/db-test-init-guard.test.js',
    'tests/db-migration-target.test.js',
    'tests/migrate-orders.test.js',
    'tests/smoke.test.js',
    'tests/lab7-bonuses.test.js'], { stdio: 'inherit', env: process.env });
  execFileSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run'], {
    stdio: 'inherit', env: process.env,
  });
} catch (error) {
  if (error.status !== undefined) process.exitCode = error.status ?? 1;
  else {
    console.error(error.message || 'Tests stopped before database access.');
    process.exitCode = 1;
  }
}
