import { describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../app.js';

describe('Login rate limit', () => {
  it('allows 10 failed attempts, then returns standard limit headers and Retry-After', async () => {
    app.set('trust proxy', 1);
    const previous = process.env.ENABLE_AUTH_RATE_LIMIT_TESTS;
    process.env.ENABLE_AUTH_RATE_LIMIT_TESTS = 'true';
    const ip = '198.51.100.42';
    try {
      for (let attempt = 1; attempt <= 10; attempt += 1) {
        const response = await request(app).post('/api/auth/login')
          .set('X-Forwarded-For', ip)
          .send({ email: `ip-limit-${attempt}-${crypto.randomUUID()}@test.invalid`, password: 'incorrect' });
        expect(response.status).toBe(401);
      }
      const limited = await request(app).post('/api/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email: 'nobody@test.invalid', password: 'incorrect' });
      expect(limited.status).toBe(429);
      expect(limited.headers['ratelimit-policy'] || limited.headers.ratelimit).toBeTruthy();
      expect(limited.headers['retry-after']).toBeTruthy();
    } finally {
      if (previous === undefined) delete process.env.ENABLE_AUTH_RATE_LIMIT_TESTS;
      else process.env.ENABLE_AUTH_RATE_LIMIT_TESTS = previous;
    }
  });
});
