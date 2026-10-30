import { describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { uniqueEmail } from './helpers.js';

describe('POST /api/auth/register', () => {
  it('registers a user and returns a token without the password hash', async () => {
    const response = await request(app).post('/api/auth/register').send({
      name: 'Test Buyer', email: uniqueEmail(), password: 'qwerty123',
    });
    expect(response.status).toBe(201);
    expect(response.body.token).toBeTruthy();
    expect(response.body.user.role).toBe('user');
    expect(response.body.user).not.toHaveProperty('password_hash');
  });

  it('does not allow role escalation through registration data', async () => {
    const response = await request(app).post('/api/auth/register').send({
      name: 'Test Buyer', email: uniqueEmail(), password: 'qwerty123', role: 'admin',
    });
    expect(response.status).toBe(201);
    expect(response.body.user.role).toBe('user');
  });

  it('returns 409 when the email is already registered', async () => {
    const user = { name: 'Test Buyer', email: uniqueEmail(), password: 'qwerty123' };
    expect((await request(app).post('/api/auth/register').send(user)).status).toBe(201);
    expect((await request(app).post('/api/auth/register').send(user)).status).toBe(409);
  });

  it('rejects a short password with HTTP 400', async () => {
    const response = await request(app).post('/api/auth/register').send({
      name: 'Test Buyer', email: uniqueEmail(), password: '123',
    });
    expect(response.status).toBe(400);
  });

  it('normalizes email addresses to lowercase', async () => {
    const email = `Test-${crypto.randomUUID()}@Mail.Invalid`;
    const response = await request(app).post('/api/auth/register').send({
      name: 'Test Buyer', email, password: 'qwerty123',
    });
    expect(response.status).toBe(201);
    expect(response.body.user.email).toBe(email.toLowerCase());
  });
});

describe('POST /api/auth/login and GET /api/auth/me', () => {
  it('allows the seeded administrator to log in with a JWT', async () => {
    const response = await request(app).post('/api/auth/login').send({
      email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD,
    });
    expect(response.status).toBe(200);
    expect(response.body.token.split('.')).toHaveLength(3);
    expect(response.body.user.role).toBe('admin');
  });

  it('returns the same unauthorized response for incorrect credentials', async () => {
    const badPassword = await request(app).post('/api/auth/login').send({
      email: process.env.ADMIN_EMAIL, password: 'incorrect-password',
    });
    const unknownEmail = await request(app).post('/api/auth/login').send({
      email: uniqueEmail('missing'), password: 'incorrect-password',
    });
    expect(badPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(badPassword.body).toEqual(unknownEmail.body);
  });

  it('requires a JWT to read the current user', async () => {
    const response = await request(app).get('/api/auth/me');
    expect(response.status).toBe(401);
  });

  it('returns the authenticated user without a password hash', async () => {
    const registration = await request(app).post('/api/auth/register').send({
      name: 'Current User', email: uniqueEmail(), password: 'qwerty123',
    });
    const response = await request(app).get('/api/auth/me')
      .set('Authorization', `Bearer ${registration.body.token}`);
    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty('password_hash');
  });
});
