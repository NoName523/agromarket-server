import { execSync } from 'node:child_process';
import dotenv from 'dotenv';
import pg from 'pg';
import { assertTestInitConfiguration, assertTestInitTarget } from '../db/test-init-guard.js';

export default async function globalSetup() {
  const loaded = dotenv.config({ path: '.env.test', override: true, quiet: true });
  if (loaded.error && loaded.error.code !== 'ENOENT') {
    throw new Error('Unable to load the test environment file; database access was stopped.');
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('Tests require a valid DATABASE_URL for agromarket_test.');
  }
  assertTestInitConfiguration({ databaseUrl: process.env.DATABASE_URL, nodeEnv: process.env.NODE_ENV });

  const check = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  try {
    await check.connect();
    await assertTestInitTarget(check);
  } finally {
    await check.end().catch(() => {});
  }

  execSync('npm run db:init', { stdio: 'inherit' });
  execSync('npm run db', { stdio: 'inherit' });
}
