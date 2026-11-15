import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertTestInitConfiguration,
  assertTestInitTarget,
  dropTestSchemaSafely,
} from '../db/test-init-guard.js';

const localTarget = {
  database_name: 'agromarket_test',
  server_address: '192.168.174.10',
  server_port: 5432,
};

function mockClient(target = localTarget) {
  const statements = [];
  return {
    statements,
    async query(sql) {
      statements.push(sql);
      if (sql.startsWith('SELECT')) return { rows: [target] };
      return { rows: [], rowCount: 0 };
    },
  };
}

const localOptions = {
  databaseUrl: 'postgresql://192.168.174.10:5432/agromarket_test',
  nodeEnv: 'test',
  ci: 'false',
};

const ciOptions = {
  databaseUrl: 'postgresql://postgres:postgres@localhost:5432/agromarket_test',
  nodeEnv: 'test',
  ci: 'true',
  testDatabasePort: '5432',
};

describe('db:init target guard', () => {
  it('keeps local mode restricted to the VMware test database', () => {
    assert.doesNotThrow(() => assertTestInitConfiguration(localOptions));
    assert.throws(() => assertTestInitConfiguration({
      ...localOptions,
      databaseUrl: 'postgresql://localhost:5432/agromarket_test',
    }), /Local db:init requires/);
  });

  it('accepts the explicit CI service only on localhost with explicit port 5432', () => {
    assert.doesNotThrow(() => assertTestInitConfiguration(ciOptions));
  });

  it('rejects CI if its port is missing, implicit, or differs from 5432', () => {
    for (const options of [
      { ...ciOptions, testDatabasePort: '' },
      { ...ciOptions, databaseUrl: 'postgresql://localhost/agromarket_test' },
      { ...ciOptions, databaseUrl: 'postgresql://localhost:5433/agromarket_test' },
      { ...ciOptions, testDatabasePort: '5433' },
    ]) {
      assert.throws(() => assertTestInitConfiguration(options), /CI db:init requires/);
    }
  });

  it('rejects Neon and all non-local CI URLs before connecting', () => {
    for (const host of [
      'ep-example.neon.tech',
      '198.51.100.20',
      '192.168.174.10',
    ]) {
      assert.throws(() => assertTestInitConfiguration({
        ...ciOptions,
        databaseUrl: `postgresql://${host}:5432/agromarket_test`,
      }), /CI db:init requires/);
    }
  });

  it('rejects production mode before connecting in either mode', () => {
    const client = mockClient();
    assert.throws(() => assertTestInitConfiguration({
      ...localOptions,
      nodeEnv: 'production',
    }), /NODE_ENV=test/);
    assert.throws(() => assertTestInitConfiguration({
      ...ciOptions,
      nodeEnv: 'production',
    }), /NODE_ENV=test/);
    assert.deepEqual(client.statements, []);
  });

  it('never issues DROP when NODE_ENV is not test', async () => {
    const client = mockClient();
    await assert.rejects(dropTestSchemaSafely(client, { nodeEnv: 'production', ci: 'false' }), /NODE_ENV=test/);
    assert.deepEqual(client.statements, []);
  });

  it('rejects wrong local actual targets before issuing DROP', async (t) => {
    const wrongTargets = [
      { ...localTarget, database_name: 'production' },
      { ...localTarget, server_address: '192.168.174.11' },
      { ...localTarget, server_port: 5433 },
    ];

    for (const target of wrongTargets) {
      await t.test(`local target ${target.database_name}/${target.server_address}:${target.server_port}`, async () => {
        const client = mockClient(target);
        await assert.rejects(dropTestSchemaSafely(client, { nodeEnv: 'test', ci: 'false' }), /not the allowed VM/);
        assert.deepEqual(client.statements, [targetCheckSql]);
        assert.equal(client.statements.some((sql) => /DROP\s+SCHEMA/i.test(sql)), false);
      });
    }
  });

  it('accepts only loopback/private service addresses in CI and still checks DB and port', async () => {
    for (const serverAddress of ['127.0.0.1', '::1', '172.18.0.2', '10.0.0.5', '192.168.1.5', 'fd00::1']) {
      await assert.doesNotReject(assertTestInitTarget(mockClient({
        database_name: 'agromarket_test', server_address: serverAddress, server_port: 5432,
      }), { nodeEnv: 'test', ci: 'true', testDatabasePort: '5432' }));
    }

    for (const target of [
      { database_name: 'production', server_address: '172.18.0.2', server_port: 5432 },
      { database_name: 'agromarket_test', server_address: '8.8.8.8', server_port: 5432 },
      { database_name: 'agromarket_test', server_address: '172.18.0.2', server_port: 5433 },
    ]) {
      await assert.rejects(assertTestInitTarget(mockClient(target), {
        nodeEnv: 'test', ci: 'true', testDatabasePort: '5432',
      }), /not the allowed CI/);
    }
  });

  it('never issues DROP when CI resolves to an external PostgreSQL address', async () => {
    const client = mockClient({
      database_name: 'agromarket_test', server_address: '203.0.113.10', server_port: 5432,
    });
    await assert.rejects(dropTestSchemaSafely(client, {
      nodeEnv: 'test', ci: 'true', testDatabasePort: '5432',
    }), /not the allowed CI/);
    assert.deepEqual(client.statements, [targetCheckSql]);
    assert.equal(client.statements.some((sql) => /DROP\s+SCHEMA/i.test(sql)), false);
  });

  it('does not issue DROP when the target verification query fails', async () => {
    const client = mockClient();
    client.query = async (sql) => {
      client.statements.push(sql);
      throw new Error('mocked verification failure');
    };

    await assert.rejects(dropTestSchemaSafely(client, { nodeEnv: 'test', ci: 'false' }), /mocked verification failure/);
    assert.equal(client.statements.some((sql) => /DROP\s+SCHEMA/i.test(sql)), false);
  });

  it('issues DROP only after the exact local target has been verified', async () => {
    const client = mockClient();
    await dropTestSchemaSafely(client, { nodeEnv: 'test', ci: 'false' });
    assert.deepEqual(client.statements, [targetCheckSql, 'DROP SCHEMA public CASCADE']);
  });

  it('issues DROP in CI only after the local PostgreSQL service is verified', async () => {
    const client = mockClient({
      database_name: 'agromarket_test', server_address: '172.18.0.2', server_port: 5432,
    });
    await dropTestSchemaSafely(client, { nodeEnv: 'test', ci: 'true', testDatabasePort: '5432' });
    assert.deepEqual(client.statements, [targetCheckSql, 'DROP SCHEMA public CASCADE']);
  });
});

const targetCheckSql = `SELECT
    current_database() AS database_name,
    host(inet_server_addr()) AS server_address,
    inet_server_port() AS server_port`;
