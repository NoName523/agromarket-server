import { createHmac, randomUUID } from 'node:crypto';
import { pool as defaultPool } from '../db/pool.js';

export const LOGIN_ATTEMPT_POLICY = Object.freeze({
  limit: 10,
  windowSeconds: 15 * 60,
  blockSeconds: 60,
  leaseSeconds: 30,
  retentionSeconds: 16 * 60,
});

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

// The secret is validated only when a store is created. Importing never opens a connection.
export function createLoginAttemptStore({
  pool = defaultPool,
  secret = process.env.LOGIN_ATTEMPT_SECRET,
} = {}) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('LOGIN_ATTEMPT_SECRET must contain at least 32 UTF-8 bytes.');
  }

  function emailKey(email) {
    if (typeof email !== 'string' || !email.trim() || email.trim().length > 254) {
      throw new TypeError('A normalized email address is required.');
    }
    return createHmac('sha256', secret).update(email.trim().toLowerCase(), 'utf8').digest('hex');
  }

  function validateReservation(reservation) {
    if (!reservation || typeof reservation.emailKey !== 'string' ||
        reservation.emailKey.length !== 64 || !/^[a-f\d]+$/.test(reservation.emailKey) ||
        !UUID.test(reservation.generation) || !UUID.test(reservation.attemptId)) {
      throw new TypeError('A reservation returned by reserveAttempt is required.');
    }
  }

  async function transaction(work) {
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      // Bound time spent waiting for a hot email row and abandoned transactions.
      await client.query("SET LOCAL lock_timeout = '1s'");
      await client.query("SET LOCAL statement_timeout = '2s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '3s'");
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { broken = true; }
      throw error;
    } finally {
      client.release(broken);
    }
  }

  async function lockState(client, key, create) {
    if (create) {
      await client.query(`/* login-attempt:ensure */
        INSERT INTO public.login_attempts (email_key, generation)
        VALUES ($1, $2) ON CONFLICT (email_key)
        DO UPDATE SET email_key = EXCLUDED.email_key`, [key, randomUUID()]);
      // The no-op conflict UPDATE holds the row lock until COMMIT, so cleanup
      // cannot delete an existing expired row between ensure and lock below.
    }
    const { rows } = await client.query(`/* login-attempt:lock */
      SELECT generation, failed_count, window_started_at, blocked_until, expires_at
      FROM public.login_attempts WHERE email_key = $1 FOR UPDATE`, [key]);
    if (!rows.length) return null;
    // Read the DB clock AFTER obtaining the lock, not before waiting for another request.
    const clock = await client.query('/* login-attempt:clock */ SELECT clock_timestamp() AS now');
    return { ...rows[0], now: clock.rows[0].now };
  }

  function expired(state) {
    const now = new Date(state.now).getTime();
    if (new Date(state.expires_at).getTime() <= now) return true;
    if (state.blocked_until !== null) return new Date(state.blocked_until).getTime() <= now;
    return new Date(state.window_started_at).getTime() + LOGIN_ATTEMPT_POLICY.windowSeconds * 1000 <= now;
  }

  async function reset(client, key, now) {
    const generation = randomUUID();
    await client.query(`/* login-attempt:reset */
      UPDATE public.login_attempts
      SET generation = $2, failed_count = 0, window_started_at = $3,
          blocked_until = NULL, expires_at = $3::timestamptz + interval '16 minutes'
      WHERE email_key = $1`, [key, generation, now]);
    await client.query('/* login-attempt:clear */ DELETE FROM public.login_attempt_reservations WHERE email_key = $1', [key]);
    return generation;
  }

  async function reserveAttempt(email) {
    const key = emailKey(email);
    return transaction(async (client) => {
      const state = await lockState(client, key, true);
      let generation = state.generation;
      let failures = state.failed_count;
      const now = new Date(state.now).getTime();
      if (expired(state)) {
        generation = await reset(client, key, state.now);
        failures = 0;
      } else if (state.blocked_until !== null) {
        return { allowed: false, reason: 'blocked',
          retryAfterSeconds: Math.max(1, Math.ceil((new Date(state.blocked_until).getTime() - now) / 1000)) };
      }
      await client.query(`/* login-attempt:prune */
        DELETE FROM public.login_attempt_reservations
        WHERE email_key = $1 AND lease_expires_at <= $2`, [key, state.now]);
      const pending = await client.query(`/* login-attempt:pending */
        SELECT count(*)::int AS count, min(lease_expires_at) AS earliest
        FROM public.login_attempt_reservations WHERE email_key = $1`, [key]);
      // Reserve capacity before bcrypt. In-flight attempts count toward the ceiling,
      // but do not become failures or extend a block if a worker crashes.
      if (failures + pending.rows[0].count >= LOGIN_ATTEMPT_POLICY.limit) {
        return { allowed: false, reason: 'in-flight', retryAfterSeconds: Math.max(1,
          Math.ceil((new Date(pending.rows[0].earliest).getTime() - now) / 1000)) };
      }
      const attemptId = randomUUID();
      await client.query(`/* login-attempt:reserve */
        INSERT INTO public.login_attempt_reservations
          (email_key, attempt_id, generation, reserved_at, lease_expires_at)
        VALUES ($1, $2, $3, $4, $4::timestamptz + interval '30 seconds')`,
      [key, attemptId, generation, state.now]);
      await client.query(`/* login-attempt:touch */
        UPDATE public.login_attempts SET expires_at = $2::timestamptz + interval '16 minutes'
        WHERE email_key = $1`, [key, state.now]);
      return { allowed: true, emailKey: key, generation, attemptId };
    });
  }

  async function finish(reservation, success) {
    validateReservation(reservation);
    return transaction(async (client) => {
      const state = await lockState(client, reservation.emailKey, false);
      if (!state || state.generation !== reservation.generation || expired(state)) return { applied: false };
      const consumed = await client.query(`/* login-attempt:consume */
        DELETE FROM public.login_attempt_reservations
        WHERE email_key = $1 AND attempt_id = $2 AND generation = $3 AND lease_expires_at > $4
        RETURNING attempt_id`,
      [reservation.emailKey, reservation.attemptId, reservation.generation, state.now]);
      if (!consumed.rowCount) return { applied: false };
      if (success) {
        // Keep the parent row: deleting/recreating it could create an ABA race.
        // A new generation invalidates every older in-flight result.
        await reset(client, reservation.emailKey, state.now);
        return { applied: true };
      }
      const result = await client.query(`/* login-attempt:failure */
        UPDATE public.login_attempts
        SET failed_count = least(failed_count + 1, 10),
            blocked_until = CASE WHEN failed_count + 1 >= 10
              THEN coalesce(blocked_until, $2::timestamptz + interval '60 seconds') ELSE blocked_until END,
            expires_at = $2::timestamptz + interval '16 minutes'
        WHERE email_key = $1 RETURNING failed_count, blocked_until`, [reservation.emailKey, state.now]);
      return { applied: true, blocked: result.rows[0].blocked_until !== null };
    });
  }

  async function cleanupExpired({ limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('Cleanup limit must be between 1 and 1000.');
    const result = await pool.query(`/* login-attempt:cleanup */
      WITH expired AS (
        SELECT email_key FROM public.login_attempts
        WHERE expires_at <= clock_timestamp()
        ORDER BY expires_at, email_key LIMIT $1 FOR UPDATE SKIP LOCKED
      )
      DELETE FROM public.login_attempts a USING expired e WHERE a.email_key = e.email_key`, [limit]);
    return { deleted: result.rowCount };
  }

  // Caller must only authenticate when recordSuccess returns applied:true.
  // Expired/replayed/invalidated reservations must be retried with a fresh reservation.
  return Object.freeze({ reserveAttempt,
    recordFailure: (reservation) => finish(reservation, false),
    recordSuccess: (reservation) => finish(reservation, true), cleanupExpired });
}
