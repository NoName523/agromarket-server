import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeMigrationTarget } from '../db/migration-target.js';

const neonUrl = 'postgresql://ep-example.us-east-2.aws.neon.tech/agromarket?sslmode=require';
const confirmation = 'I_ACKNOWLEDGE_PRODUCTION_SCHEMA_MIGRATION';

test('migration target guard permits Neon only with explicit production confirmation', () => {
  assert.equal(assertSafeMigrationTarget({
    databaseUrl: neonUrl,
    nodeEnv: 'production',
    command: 'db:migrate',
    confirmation,
  }), 'agromarket');
});

test('migration target guard rejects Neon without production confirmation', () => {
  assert.throws(() => assertSafeMigrationTarget({ databaseUrl: neonUrl, nodeEnv: 'production', command: 'db:migrate' }), /CONFIRM_NEON_PRODUCTION_MIGRATION/);
  assert.throws(() => assertSafeMigrationTarget({
    databaseUrl: neonUrl,
    nodeEnv: 'production',
    command: 'db:migrate',
    confirmation: 'true',
  }), /CONFIRM_NEON_PRODUCTION_MIGRATION/);
});

test('migration target guard keeps the generic db command blocked on Neon', () => {
  assert.throws(() => assertSafeMigrationTarget({
    databaseUrl: neonUrl,
    nodeEnv: 'production',
    command: 'db',
    confirmation,
  }), /npm run db:migrate/);
});

test('migration target guard never permits production migration to VMware', () => {
  assert.throws(() => assertSafeMigrationTarget({
    databaseUrl: 'postgresql://192.168.174.10:5432/agromarket',
    nodeEnv: 'production',
    command: 'db:migrate',
    confirmation,
  }), /Production Neon migrations/);
});

test('migration target guard preserves test and local VM targets outside production', () => {
  assert.equal(assertSafeMigrationTarget({
    databaseUrl: 'postgresql://192.168.174.10:5432/agromarket_test',
    nodeEnv: 'test',
  }), 'agromarket_test');
  assert.equal(assertSafeMigrationTarget({
    databaseUrl: 'postgresql://192.168.174.10:5432/agromarket',
    nodeEnv: 'development',
  }), 'agromarket');
});
