const TEST_DATABASE = 'agromarket_test';
const VM_HOST = '192.168.174.10';
const TEST_PORT = 5432;
const CI_HOST = 'localhost';

function isPrivateIPv4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [first, second] = octets;
  return first === 10 || first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
}

function isLocalCiPostgresAddress(address) {
  if (typeof address !== 'string') return false;
  if (address === '::1' || address === '127.0.0.1') return true;
  if (address.startsWith('::ffff:')) return isPrivateIPv4(address.slice('::ffff:'.length));
  if (address.includes('.')) return isPrivateIPv4(address);
  return /^f[cd][0-9a-f:]*$/i.test(address);
}

function isCiMode(ci) {
  return ci === 'true';
}

function assertTestEnvironment(nodeEnv) {
  if (nodeEnv !== 'test') {
    throw new Error('db:init is restricted to NODE_ENV=test.');
  }
}

export function assertTestInitConfiguration({
  databaseUrl,
  nodeEnv,
  ci = process.env.CI,
  testDatabasePort = process.env.DB_TEST_PORT,
}) {
  assertTestEnvironment(nodeEnv);

  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('db:init requires the isolated test PostgreSQL target.');
  }

  let database;
  try {
    database = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new Error('db:init requires the isolated test PostgreSQL target.');
  }

  if (!['postgres:', 'postgresql:'].includes(url.protocol) || database !== TEST_DATABASE) {
    throw new Error('db:init requires the agromarket_test database.');
  }

  if (isCiMode(ci)) {
    if (url.hostname !== CI_HOST || url.port !== String(TEST_PORT) ||
        testDatabasePort !== String(TEST_PORT)) {
      throw new Error('CI db:init requires its localhost PostgreSQL service on the explicitly configured port 5432.');
    }
    return;
  }

  const configuredPort = Number(url.port || TEST_PORT);
  if (url.hostname !== VM_HOST || configuredPort !== TEST_PORT) {
    throw new Error('Local db:init requires agromarket_test on 192.168.174.10:5432.');
  }
}

export async function assertTestInitTarget(client, {
  nodeEnv = process.env.NODE_ENV,
  ci = process.env.CI,
  testDatabasePort = process.env.DB_TEST_PORT,
} = {}) {
  assertTestEnvironment(nodeEnv);
  const ciMode = isCiMode(ci);
  if (ciMode && testDatabasePort !== String(TEST_PORT)) {
    throw new Error('CI db:init requires DB_TEST_PORT=5432.');
  }

  const { rows } = await client.query(`SELECT
    current_database() AS database_name,
    host(inet_server_addr()) AS server_address,
    inet_server_port() AS server_port`);
  const target = rows[0];
  const addressAllowed = ciMode
    ? isLocalCiPostgresAddress(target?.server_address)
    : target?.server_address === VM_HOST;

  if (target?.database_name !== TEST_DATABASE || !addressAllowed || target.server_port !== TEST_PORT) {
    throw new Error(`db:init refused: connected PostgreSQL target is not the allowed ${ciMode ? 'CI' : 'VM'} test database.`);
  }
}

export async function dropTestSchemaSafely(client, options = {}) {
  await assertTestInitTarget(client, options);
  await client.query('DROP SCHEMA public CASCADE');
}
