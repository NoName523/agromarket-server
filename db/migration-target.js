const PRODUCTION_CONFIRMATION = 'I_ACKNOWLEDGE_PRODUCTION_SCHEMA_MIGRATION';

export function assertSafeMigrationTarget({
  databaseUrl,
  nodeEnv = process.env.NODE_ENV,
  confirmation = process.env.CONFIRM_NEON_PRODUCTION_MIGRATION,
}) {
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');

  const url = new URL(databaseUrl);
  const database = decodeURIComponent(url.pathname.slice(1));
  const hostname = url.hostname.toLowerCase();

  if (nodeEnv === 'production') {
    const neonHost = hostname.endsWith('.neon.tech') && hostname.length > '.neon.tech'.length;
    if (!neonHost || confirmation !== PRODUCTION_CONFIRMATION) {
      throw new Error('Production migration requires a Neon host and CONFIRM_NEON_PRODUCTION_MIGRATION=I_ACKNOWLEDGE_PRODUCTION_SCHEMA_MIGRATION.');
    }
    return database;
  }

  if (confirmation) {
    throw new Error('CONFIRM_NEON_PRODUCTION_MIGRATION is only valid with NODE_ENV=production.');
  }

  const localHost = ['localhost', '127.0.0.1', '::1', '192.168.174.10'].includes(hostname);
  const testDatabase = database === 'agromarket_test';
  const vmDatabase = database === 'agromarket' && hostname === '192.168.174.10';
  if (!localHost || !(testDatabase || vmDatabase)) {
    throw new Error('db is restricted to agromarket_test or agromarket on PostgreSQL VM 192.168.174.10, outside production.');
  }
  return database;
}
