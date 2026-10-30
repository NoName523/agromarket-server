import { execSync } from 'node:child_process';
import pg from 'pg';

export default async function globalSetup() {
  let configuredDatabase;
  try {
    configuredDatabase = decodeURIComponent(new URL(process.env.DATABASE_URL).pathname.slice(1));
  } catch {
    throw new Error('Tests require a valid DATABASE_URL for agromarket_test.');
  }
  if (configuredDatabase !== 'agromarket_test') {
    throw new Error('Tests may only initialize agromarket_test; no database changes were made.');
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
}
