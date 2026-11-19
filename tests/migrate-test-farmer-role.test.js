import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import pg from 'pg';
import {
  assertTestFarmerMigrationConfiguration,
  assertTestFarmerMigrationTarget,
  runTestFarmerRoleMigration,
  testFarmerPoolConfiguration,
} from '../db/migrate-test-farmer-role.js';

const databaseUrl = 'postgresql://192.168.174.10:5432/agromarket_test';

describe('test farmer role migration safety', () => {
  it('refuses NODE_ENV values other than test', () => {
    assert.throws(() => assertTestFarmerMigrationConfiguration({
      databaseUrl,
      nodeEnv: 'development',
    }), /NODE_ENV=test/);
  });

  it('refuses a database name other than agromarket_test', () => {
    assert.throws(() => assertTestFarmerMigrationConfiguration({
      databaseUrl: 'postgresql://192.168.174.10:5432/agromarket',
      nodeEnv: 'test',
    }), /agromarket_test/);
  });

  it('refuses a configured host other than the local test PostgreSQL host', () => {
    assert.throws(() => assertTestFarmerMigrationConfiguration({
      databaseUrl: 'postgresql://db.example.invalid:5432/agromarket_test',
      nodeEnv: 'test',
    }), /192\.168\.174\.10:5432/);
  });

  it('refuses a configured PostgreSQL port other than 5432', () => {
    assert.throws(() => assertTestFarmerMigrationConfiguration({
      databaseUrl: 'postgresql://192.168.174.10:5433/agromarket_test',
      nodeEnv: 'test',
    }), /192\.168\.174\.10:5432/);
  });

  it('rejects host and port overrides in query parameters', () => {
    for (const query of ['?host=example.invalid', '?port=5433', '?host=::1&port=5433']) {
      assert.throws(() => testFarmerPoolConfiguration({
        databaseUrl: `${databaseUrl}${query}`, nodeEnv: 'test',
      }), /query parameters/);
    }
  });

  it('uses the checked target even with inherited PG connection variables', async () => {
    const keys = ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
      Object.assign(process.env, {
        PGHOST: 'example.invalid', PGPORT: '6543', PGDATABASE: 'other',
        PGUSER: 'other', PGPASSWORD: 'other',
      });
      const config = testFarmerPoolConfiguration({
        databaseUrl: 'postgresql://fixture:fixture@192.168.174.10:5432/agromarket_test',
        nodeEnv: 'test',
      });
      const client = new pg.Client(config);
      {
        const actual = client.connectionParameters;
        assert.equal(actual.host, '192.168.174.10');
        assert.equal(actual.port, 5432);
        assert.equal(actual.database, 'agromarket_test');
        assert.equal(actual.user, 'fixture');
        assert.equal(actual.password, 'fixture');
      }
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  });

  it('checks the connected database, host and port rather than trusting DATABASE_URL', async () => {
    for (const actualTarget of [
      { database_name: 'agromarket', server_address: '192.168.174.10', server_port: 5432 },
      { database_name: 'agromarket_test', server_address: '198.51.100.10', server_port: 5432 },
      { database_name: 'agromarket_test', server_address: '192.168.174.10', server_port: 5433 },
    ]) {
      const client = {
        async query(sql) {
          assert.match(sql, /SELECT\s+current_database\(\)/);
          return { rows: [actualTarget] };
        },
      };
      await assert.rejects(
        assertTestFarmerMigrationTarget(client, 'test'),
        /not the allowed VM test database/,
      );
    }
  });

  it('does not begin the migration when the connected target differs from the approved test database', async () => {
    const statements = [];
    const pool = {
      async connect() {
        return {
          async query(sql) {
            statements.push(sql.trim());
            return { rows: [{
              database_name: 'agromarket',
              server_address: '192.168.174.10',
              server_port: 5432,
            }] };
          },
          release() {},
        };
      },
    };

    await assert.rejects(
      runTestFarmerRoleMigration({ pool, databaseUrl, nodeEnv: 'test' }),
      /not the allowed VM test database/,
    );
    assert.equal(statements.length, 1);
    assert.match(statements[0], /current_database\(\)/);
  });

  it('updates the constraint once and safely accepts a repeated run', async () => {
    let farmerAllowed = false;
    const statements = [];
    const pool = {
      async connect() {
        return {
          async query(sql) {
            statements.push(sql.trim());
            if (/^SELECT\s+current_database\(\)/i.test(sql.trim())) {
              return { rows: [{
                database_name: 'agromarket_test',
                server_address: '192.168.174.10',
                server_port: 5432,
              }] };
            }
            if (/to_regclass\('public\.users'\)/.test(sql)) {
              return { rows: [{ users_table: 'users' }] };
            }
            if (/FROM pg_constraint/.test(sql)) {
              const roles = farmerAllowed
                ? "'user'::text, 'admin'::text, 'farmer'::text"
                : "'user'::text, 'admin'::text";
              return { rows: [{ definition: `CHECK ((role = ANY (ARRAY[${roles}])))` }] };
            }
            if (/ADD CONSTRAINT users_role_check/.test(sql)) farmerAllowed = true;
            return { rows: [] };
          },
          release() {},
        };
      },
    };

    const firstRun = await runTestFarmerRoleMigration({
      pool,
      databaseUrl,
      nodeEnv: 'test',
    });
    const secondRun = await runTestFarmerRoleMigration({
      pool,
      databaseUrl,
      nodeEnv: 'test',
    });

    assert.deepEqual(firstRun, { changed: true });
    assert.deepEqual(secondRun, { changed: false });
    assert.equal(statements.filter((sql) => /ALTER TABLE public\.users/.test(sql)).length, 2);
    assert.equal(statements.filter((sql) => sql === 'COMMIT').length, 2);
  });
});
