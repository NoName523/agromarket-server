import { execFileSync } from 'node:child_process';
import dotenv from 'dotenv';

const loaded = dotenv.config({ path: '.env.test', override: true, quiet: true });
if (loaded.error && loaded.error.code !== 'ENOENT') {
  console.error('Unable to load the test environment file.');
  process.exit(1);
}

function assertTestDatabase() {
  let url;
  try {
    if (!process.env.DATABASE_URL) throw new Error();
    url = new URL(process.env.DATABASE_URL);
  } catch {
    throw new Error('Tests require DATABASE_URL in .env.test for agromarket_test.');
  }
  const database = decodeURIComponent(url.pathname.slice(1));
  const vmHost = url.hostname === '192.168.174.10';
  const ciLoopback = process.env.CI === 'true' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (database !== 'agromarket_test' || !(vmHost || ciLoopback)) {
    throw new Error('Tests are restricted to agromarket_test on VM 192.168.174.10 (CI may use its isolated local PostgreSQL service).');
  }
}

try {
  assertTestDatabase();
  process.env.NODE_ENV = 'test';
  execFileSync(process.execPath, ['--test',
    'tests/admin-rotation.test.js',
    'tests/auth-boundaries.test.js',
    'tests/db-migration-target.test.js',
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
