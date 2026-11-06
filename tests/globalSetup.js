import { execSync } from 'node:child_process';
import dotenv from 'dotenv';
import pg from 'pg';

export default async function globalSetup() {
  const loaded = dotenv.config({ path: '.env.test', override: true, quiet: true });
  if (loaded.error && loaded.error.code !== 'ENOENT') {
    throw new Error('Unable to load the test environment file; database access was stopped.');
  }
  let configuredDatabase;
  let configuredHost;
  try {
    const url = new URL(process.env.DATABASE_URL);
    configuredDatabase = decodeURIComponent(url.pathname.slice(1));
    configuredHost = url.hostname;
  } catch {
    throw new Error('Tests require a valid DATABASE_URL for agromarket_test.');
  }
  if (configuredDatabase !== 'agromarket_test') {
    throw new Error('Tests may only initialize agromarket_test; no database changes were made.');
  }
  const vmHost = configuredHost === '192.168.174.10';
  const ciLoopback = process.env.CI === 'true' && ['localhost', '127.0.0.1', '::1'].includes(configuredHost);
  if (!vmHost && !ciLoopback) {
    throw new Error('Tests require PostgreSQL VM 192.168.174.10; no database connection was attempted.');
  }

  const check = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  try {
    await check.connect();
    const { rows } = await check.query('SELECT current_database() AS name');
    if (rows[0]?.name !== 'agromarket_test') {
      throw new Error('PostgreSQL connection did not select agromarket_test.');
    }
  } finally {
    await check.end().catch(() => {});
  }

  execSync('npm run db:init', { stdio: 'inherit' });
  execSync('npm run db', { stdio: 'inherit' });
}
