import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { productSchema } from '../middleware/schemas.js';
import { MockPostgres } from './helpers/mockLoginAttemptPostgres.js';

const originalEnv = {
  JWT_SECRET: process.env.JWT_SECRET,
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN,
  NODE_ENV: process.env.NODE_ENV,
  ENABLE_AUTH_RATE_LIMIT_TESTS: process.env.ENABLE_AUTH_RATE_LIMIT_TESTS,
};
process.env.JWT_SECRET = randomBytes(32).toString('hex');
process.env.JWT_EXPIRES_IN = '2h';
process.env.NODE_ENV = 'test';

const [{ default: app }, { pool }] = await Promise.all([
  import('../app.js'),
  import('../db/pool.js'),
]);

const adminToken = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET,
  { subject: '1', expiresIn: '2h' });
const adminAuth = `Bearer ${adminToken}`;
const userToken = jwt.sign({ role: 'user' }, process.env.JWT_SECRET,
  { subject: '2', expiresIn: '2h' });
const userAuth = `Bearer ${userToken}`;
const farmerToken = jwt.sign({ role: 'farmer' }, process.env.JWT_SECRET,
  { subject: '3', expiresIn: '2h' });
const farmerAuth = `Bearer ${farmerToken}`;
const allowedOrigin = 'https://agromarket-noname523.vercel.app';
let requestNumber = 0;
let originalQuery;
let originalConnect;
let registeredId = 1;
let adminPasswordHash;
let lastRegistrationValues;
let lastProductUpdate;

function remoteRequest(appRequest, ip) {
  requestNumber += 1;
  return appRequest.set('X-Forwarded-For', ip || `198.51.100.${requestNumber}`);
}

beforeAll(async () => {
  adminPasswordHash = await bcrypt.hash('security-test-password', 4);
  originalQuery = pool.query;
  originalConnect = pool.connect;
  const attemptsDb = new MockPostgres();
  pool.connect = attemptsDb.connect.bind(attemptsDb);
  pool.query = async (sql, values = []) => {
    if (sql.includes('SELECT id, name, email, role, created_at, password_hash')) {
      if (values[0] === 'admin@test.invalid') {
        return { rows: [{ id: 1, name: 'Test admin', email: values[0], role: 'admin',
          created_at: null, password_hash: adminPasswordHash }] };
      }
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO public.users')) {
      lastRegistrationValues = values;
      return { rows: [{ id: registeredId++, name: values[0], email: values[1], role: 'user',
        created_at: null }] };
    }
    if (sql.includes('INSERT INTO public.products')) {
      return { rows: [{ id: 1, name: values[0], category: values[1], price: values[2],
        unit: values[3], image: values[4] }] };
    }
    if (sql.includes('DELETE FROM public.products')) return { rowCount: 1 };
    if (sql.includes('SELECT o.*, p.name AS product_name')) return { rows: [] };
    if (sql.includes('UPDATE public.orders')) {
      return { rows: [{ id: values[1], status: values[0] }] };
    }
    if (sql.includes('UPDATE public.products')) {
      lastProductUpdate = { sql, values };
      return { rows: [{ id: 1, name: 'Updated product', price: 10 }] };
    }
    throw new Error('Unexpected database query in isolated security tests');
  };
});

afterAll(async () => {
  if (originalQuery) pool.query = originalQuery;
  if (originalConnect) pool.connect = originalConnect;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('request validation', () => {
  it('rejects an invalid email with structured details', async () => {
    const response = await remoteRequest(request(app).post('/api/auth/register'))
      .send({ name: 'Buyer', email: 'invalid', password: 'password123' });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/email/i);
    expect(response.body.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'email', message: expect.any(String) }),
    ]));
  });

  it('rejects a seven-character registration password', async () => {
    const response = await remoteRequest(request(app).post('/api/auth/register'))
      .send({ name: 'Buyer', email: 'buyer@test.invalid', password: '1234567' });
    expect(response.status).toBe(400);
    expect(response.body.details[0]).toMatchObject({ field: 'password' });
  });

  it('rejects a negative product price', async () => {
    const response = await remoteRequest(request(app).post('/api/products'))
      .set('Authorization', adminAuth)
      .send({ name: 'Honey', price: -1 });
    expect(response.status).toBe(400);
    expect(response.body.details).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'price' }),
    ]));
  });

  it.each([
    [100, true, 100],
    [-100, false],
    [1.5, false],
    ['1.5', false],
    ['1.00000000000000001', false],
    ['1e3', false],
    ['0x10', false],
    [2147483648, false],
  ])('validates price input %j before conversion', (price, accepted, parsedPrice) => {
    const result = productSchema.safeParse({ name: 'Honey', price });
    expect(result.success).toBe(accepted);
    if (accepted) expect(result.data.price).toBe(parsedPrice);
  });

  it('rejects invalid IDs and empty order PATCH bodies', async () => {
    const badId = await remoteRequest(request(app).get('/api/products/not-an-id'));
    expect(badId.status).toBe(400);
    expect(badId.body.details[0]).toMatchObject({ field: 'id' });

    const emptyPatch = await remoteRequest(request(app).patch('/api/orders/1'))
      .set('Authorization', adminAuth).send({});
    expect(emptyPatch.status).toBe(400);
    expect(emptyPatch.body.details[0]).toMatchObject({ field: 'status' });

    const emptyProductPatch = await remoteRequest(request(app).patch('/api/products/1'))
      .set('Authorization', adminAuth).send({});
    expect(emptyProductPatch.status).toBe(400);
    expect(emptyProductPatch.body.details[0]).toMatchObject({ field: 'body' });
  });

  it('rejects JSON bodies larger than 16kb with HTTP 413', async () => {
    const response = await remoteRequest(request(app).post('/api/orders'))
      .set('Content-Type', 'application/json')
      .send({ comment: 'x'.repeat(17 * 1024) });
    expect(response.status).toBe(413);
  });

  it('strips role mass assignment during registration', async () => {
    const response = await remoteRequest(request(app).post('/api/auth/register'))
      .send({ name: ' Buyer ', email: ' Mass-Assignment@Test.Invalid ',
        password: 'password123', role: 'admin' });
    expect(response.status).toBe(201);
    expect(response.body.user.role).toBe('user');
    expect(response.body.user.name).toBe('Buyer');
    expect(lastRegistrationValues[1]).toBe('mass-assignment@test.invalid');
  });

  it('does not allow public registration to assign the farmer role', async () => {
    const response = await remoteRequest(request(app).post('/api/auth/register'))
      .send({ name: 'Buyer', email: 'farmer-role@test.invalid',
        password: 'password123', role: 'farmer' });
    expect(response.status).toBe(201);
    expect(response.body.user.role).toBe('user');
  });

  it('updates only supplied product fields and ignores extra fields', async () => {
    const response = await remoteRequest(request(app).patch('/api/products/1'))
      .set('Authorization', adminAuth)
      .send({ name: ' New name ', role: 'admin' });
    expect(response.status).toBe(200);
    expect(lastProductUpdate.sql).toContain('SET name = $1');
    expect(lastProductUpdate.sql).not.toMatch(/role/i);
    expect(lastProductUpdate.values).toEqual(['New name', 1]);
  });
});

describe('farmer role access boundaries', () => {
  it('does not allow a regular user to create a product', async () => {
    const response = await remoteRequest(request(app).post('/api/products'))
      .set('Authorization', userAuth)
      .send({ name: 'User product', price: 100, unit: 'kg' });

    expect(response.status).toBe(403);
  });

  it('allows a farmer to create a product', async () => {
    const response = await remoteRequest(request(app).post('/api/products'))
      .set('Authorization', farmerAuth)
      .send({ name: 'Farmer product', price: 500, unit: 'kg' });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ id: 1, name: 'Farmer product', price: 500 });
  });

  it.each([
    ['PUT', '/api/products/1', { name: 'Changed product', price: 600, unit: 'kg' }],
    ['PATCH', '/api/products/1', { price: 600 }],
    ['DELETE', '/api/products/1'],
  ])('does not allow a farmer to %s a product', async (method, path, body) => {
    let productRequest = request(app)[method.toLowerCase()](path)
      .set('Authorization', farmerAuth);
    if (body) productRequest = productRequest.send(body);

    expect((await remoteRequest(productRequest)).status).toBe(403);
  });

  it('does not give a farmer administrative order permissions', async () => {
    const list = await remoteRequest(request(app).get('/api/orders'))
      .set('Authorization', farmerAuth);
    const update = await remoteRequest(request(app).patch('/api/orders/1'))
      .set('Authorization', farmerAuth)
      .send({ status: 'processing' });

    expect(list.status).toBe(403);
    expect(update.status).toBe(403);
  });

  it('preserves the existing administrator product and order permissions', async () => {
    const created = await remoteRequest(request(app).post('/api/products'))
      .set('Authorization', adminAuth)
      .send({ name: 'Admin product', price: 100, unit: 'kg' });
    const updated = await remoteRequest(request(app).put('/api/products/1'))
      .set('Authorization', adminAuth)
      .send({ name: 'Updated product', price: 200, unit: 'kg' });
    const patched = await remoteRequest(request(app).patch('/api/products/1'))
      .set('Authorization', adminAuth)
      .send({ price: 300 });
    const deleted = await remoteRequest(request(app).delete('/api/products/1'))
      .set('Authorization', adminAuth);
    const orders = await remoteRequest(request(app).get('/api/orders'))
      .set('Authorization', adminAuth);
    const updatedOrder = await remoteRequest(request(app).patch('/api/orders/1'))
      .set('Authorization', adminAuth)
      .send({ status: 'processing' });

    expect(created.status).toBe(201);
    expect(updated.status).toBe(200);
    expect(patched.status).toBe(200);
    expect(deleted.status).toBe(204);
    expect(orders.status).toBe(200);
    expect(updatedOrder.status).toBe(200);
  });
});

describe('CORS and security headers', () => {
  it('allows the production and local frontend Origins but withholds access for others', async () => {
    for (const origin of [allowedOrigin, 'http://localhost:5173']) {
      const response = await request(app).get('/').set('Origin', origin);
      expect(response.headers['access-control-allow-origin']).toBe(origin);
    }
    const denied = await request(app).get('/').set('Origin', 'https://untrusted.invalid');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    const noOrigin = await request(app).get('/');
    expect(noOrigin.status).toBe(200);
  });

  it('answers allowed preflight requests with the configured methods and headers', async () => {
    const response = await request(app).options('/api/products')
      .set('Origin', allowedOrigin)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,authorization');
    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(allowedOrigin);
    expect(response.headers['access-control-allow-methods']).toContain('PATCH');
    expect(response.headers['access-control-allow-headers']).toContain('Authorization');
  });

  it('retains Helmet security headers', async () => {
    const response = await request(app).get('/');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toBeTruthy();
  });
});

describe('authentication rate limits', () => {
  it('allows successful logins, then returns standard headers and Retry-After after 10 failures', async () => {
    const previous = process.env.ENABLE_AUTH_RATE_LIMIT_TESTS;
    process.env.ENABLE_AUTH_RATE_LIMIT_TESTS = 'true';
    const ip = '198.51.100.201';
    try {
      for (let attempt = 0; attempt < 11; attempt += 1) {
        const success = await remoteRequest(request(app).post('/api/auth/login'), ip)
          .send({ email: 'admin@test.invalid', password: 'security-test-password' });
        expect(success.status).toBe(200);
        expect(success.headers['ratelimit-policy'] || success.headers.ratelimit).toBeTruthy();
      }
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const failure = await remoteRequest(request(app).post('/api/auth/login'), ip)
          .send({ email: `ip-limit-${attempt}@test.invalid`, password: 'wrong-password' });
        expect(failure.status).toBe(401);
      }
      const limited = await remoteRequest(request(app).post('/api/auth/login'), ip)
        .send({ email: 'missing@test.invalid', password: 'wrong-password' });
      expect(limited.status).toBe(429);
      expect(limited.headers['ratelimit-policy'] || limited.headers.ratelimit).toBeTruthy();
      expect(limited.headers['retry-after']).toBeTruthy();
    } finally {
      if (previous === undefined) delete process.env.ENABLE_AUTH_RATE_LIMIT_TESTS;
      else process.env.ENABLE_AUTH_RATE_LIMIT_TESTS = previous;
    }
  });

  it('limits registration attempts to 10 in 15 minutes', async () => {
    const previous = process.env.ENABLE_AUTH_RATE_LIMIT_TESTS;
    process.env.ENABLE_AUTH_RATE_LIMIT_TESTS = 'true';
    const ip = '198.51.100.202';
    try {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const response = await remoteRequest(request(app).post('/api/auth/register'), ip)
          .send({ name: 'Buyer', email: 'invalid-email', password: 'password123' });
        expect(response.status).toBe(400);
      }
      const limited = await remoteRequest(request(app).post('/api/auth/register'), ip)
        .send({ name: 'Buyer', email: 'invalid-email', password: 'password123' });
      expect(limited.status).toBe(429);
      expect(limited.headers['content-type']).toMatch(/application\/json/);
      expect(limited.body.error).toEqual(expect.any(String));
      expect(limited.body.error.trim()).not.toBe('');
      expect(limited.body.error).toMatch(/регистрации/);
      expect(limited.headers.ratelimit).toBeTruthy();
      expect(limited.headers['ratelimit-policy']).toBeTruthy();
      expect(limited.headers['ratelimit-policy'] || limited.headers.ratelimit).toBeTruthy();
      expect(limited.headers['retry-after']).toBeTruthy();
    } finally {
      if (previous === undefined) delete process.env.ENABLE_AUTH_RATE_LIMIT_TESTS;
      else process.env.ENABLE_AUTH_RATE_LIMIT_TESTS = previous;
    }
  });
});
