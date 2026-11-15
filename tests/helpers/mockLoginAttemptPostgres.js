import assert from 'node:assert/strict';

// Behavioral PostgreSQL mock. It models per-email exclusive locks and a DB clock,
// not PostgreSQL itself. SQL locking/constraints still need a separate integration test.
export class MockPostgres {
  now = Date.parse('2026-01-01T00:00:00Z');
  states = new Map();
  reservations = new Map();
  calls = [];
  clients = [];
  locks = new Map();
  failTag = null;

  advance(seconds) { this.now += seconds * 1000; }

  async connect() {
    let heldKey;
    let unlock;
    let snapshot;
    const client = { released: false, releaseArgument: undefined };
    this.clients.push(client);
    const lock = async (key) => {
      if (heldKey !== undefined) return;
      const previous = this.locks.get(key) || Promise.resolve();
      const gate = new Promise((resolve) => { unlock = resolve; });
      const tail = previous.then(() => gate);
      this.locks.set(key, tail);
      await previous;
      heldKey = key;
      snapshot = { state: structuredClone(this.states.get(key)),
        reservations: structuredClone([...this.reservations].filter(([, r]) => r.key === key)) };
    };
    client.query = async (sql, values = []) => {
      this.calls.push({ sql, values });
      const tag = /login-attempt:(\w+)/.exec(sql)?.[1];
      if (this.failTag === tag && tag !== undefined) throw new Error('Simulated database failure');
      const [key, second, third, fourth] = values;
      if (sql === 'BEGIN' || sql.startsWith('SET LOCAL')) return { rows: [], rowCount: 0 };
      if (sql === 'COMMIT' || sql === 'ROLLBACK') {
        if (sql === 'ROLLBACK' && heldKey !== undefined) {
          if (snapshot.state) this.states.set(heldKey, snapshot.state);
          else this.states.delete(heldKey);
          for (const [id, r] of this.reservations) if (r.key === heldKey) this.reservations.delete(id);
          for (const [id, r] of snapshot.reservations) this.reservations.set(id, r);
        }
        unlock?.();
        unlock = undefined;
        return { rows: [], rowCount: 0 };
      }
      if (tag === 'ensure') {
        assert.match(sql, /ON CONFLICT[\s\S]*DO UPDATE/);
        await lock(key);
        if (!this.states.has(key)) this.states.set(key, { generation: second, failed_count: 0,
          window_started_at: new Date(this.now), blocked_until: null, expires_at: new Date(this.now + 960000) });
      } else if (tag === 'lock') {
        assert.match(sql, /FOR UPDATE/);
        await lock(key);
        return { rows: this.states.has(key) ? [structuredClone(this.states.get(key))] : [] };
      } else if (tag === 'clock') {
        assert.notEqual(heldKey, undefined);
        return { rows: [{ now: new Date(this.now) }] };
      } else if (tag === 'reset') {
        Object.assign(this.states.get(key), { generation: second, failed_count: 0,
          window_started_at: third, blocked_until: null, expires_at: new Date(+third + 960000) });
      } else if (tag === 'clear') {
        for (const [id, r] of this.reservations) if (r.key === key) this.reservations.delete(id);
      } else if (tag === 'prune') {
        for (const [id, r] of this.reservations) {
          if (r.key === key && r.expires <= +second) this.reservations.delete(id);
        }
      } else if (tag === 'pending') {
        const rows = [...this.reservations.values()].filter((r) => r.key === key);
        return { rows: [{ count: rows.length,
          earliest: rows.length ? new Date(Math.min(...rows.map((r) => r.expires))) : null }] };
      } else if (tag === 'reserve') {
        this.reservations.set(second, { key, generation: third, expires: +fourth + 30000 });
      } else if (tag === 'touch') {
        this.states.get(key).expires_at = new Date(+second + 960000);
      } else if (tag === 'consume') {
        const r = this.reservations.get(second);
        if (!r || r.key !== key || r.generation !== third || r.expires <= +fourth) return { rows: [], rowCount: 0 };
        this.reservations.delete(second);
        return { rows: [{ attempt_id: second }], rowCount: 1 };
      } else if (tag === 'failure') {
        assert.match(sql, /coalesce\(blocked_until/);
        const state = this.states.get(key);
        state.failed_count = Math.min(10, state.failed_count + 1);
        if (state.failed_count === 10 && state.blocked_until === null) state.blocked_until = new Date(+second + 60000);
        state.expires_at = new Date(+second + 960000);
        return { rows: [structuredClone(state)], rowCount: 1 };
      } else throw new Error(`Unexpected SQL: ${sql}`);
      return { rows: [], rowCount: 1 };
    };
    client.release = (broken) => {
      assert.equal(unlock, undefined, 'transaction must finish before releasing a connection');
      client.released = true;
      client.releaseArgument = broken;
    };
    return client;
  }

  async query(sql, values) {
    this.calls.push({ sql, values });
    assert.match(sql, /FOR UPDATE SKIP LOCKED/);
    assert.match(sql, /clock_timestamp\(\)/);
    let count = 0;
    for (const [key, state] of this.states) {
      if (+state.expires_at <= this.now && count < values[0]) {
        this.states.delete(key);
        for (const [id, r] of this.reservations) if (r.key === key) this.reservations.delete(id);
        count++;
      }
    }
    return { rowCount: count };
  }
}
