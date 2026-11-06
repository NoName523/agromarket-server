import pg from 'pg';

// Keep PostgreSQL DATE values as calendar strings without timezone conversion.
pg.types.setTypeParser(1082, (value) => value);

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

// Never log the driver error: connection details may contain credentials.
pool.on('error', () => {
  console.error('Unexpected PostgreSQL pool error.');
});
