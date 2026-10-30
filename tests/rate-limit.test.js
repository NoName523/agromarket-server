import { describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../app.js';

describe('Login rate limit', () => {
  it('returns 429 and Retry-After on the sixth failed attempt', async () => {
    app.set('trust proxy', 1);
    const ip = '198.51.100.42';
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await request(app).post('/api/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email: 'nobody@test.invalid', password: 'incorrect' });
      expect(response.status).toBe(401);
    }
    const limited = await request(app).post('/api/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ email: 'nobody@test.invalid', password: 'incorrect' });
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeTruthy();
  });
});
