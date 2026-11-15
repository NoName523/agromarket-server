import { afterAll } from 'vitest';
import { pool } from '../db/pool.js';
import { randomBytes } from 'node:crypto';

// Ephemeral test key only; application startup never supplies a fallback.
if (process.env.NODE_ENV !== 'test') throw new Error('Test setup requires NODE_ENV=test');
process.env.LOGIN_ATTEMPT_SECRET ||= randomBytes(32).toString('hex');

afterAll(async () => {
  await pool.end();
});
