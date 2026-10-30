import { describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { requireAuth, requireRole } from '../middleware/auth.js';

function mockResponse() {
  const response = {};
  response.status = vi.fn(() => response);
  response.json = vi.fn(() => response);
  return response;
}

describe('requireRole', () => {
  it('continues when the user has the required role', () => {
    const next = vi.fn();
    const response = mockResponse();
    requireRole('admin')({ user: { id: 1, role: 'admin' } }, response, next);
    expect(next).toHaveBeenCalledOnce();
    expect(response.status).not.toHaveBeenCalled();
  });

  it('returns 403 and stops when the role does not match', () => {
    const next = vi.fn();
    const response = mockResponse();
    requireRole('admin')({ user: { id: 2, role: 'user' } }, response, next);
    expect(response.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requireAuth', () => {
  it('returns 401 when Authorization is missing', () => {
    const response = mockResponse();
    const next = vi.fn();
    requireAuth({ get: () => undefined }, response, next);
    expect(response.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('attaches the verified user to the request', () => {
    const token = jwt.sign({ role: 'user' }, process.env.JWT_SECRET, { subject: '7' });
    const req = { get: () => `Bearer ${token}` };
    const next = vi.fn();
    requireAuth(req, mockResponse(), next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toEqual({ id: 7, role: 'user' });
  });

  it('returns 401 for an expired token', () => {
    const token = jwt.sign({ role: 'user', exp: Math.floor(Date.now() / 1000) - 60 }, process.env.JWT_SECRET);
    const response = mockResponse();
    const next = vi.fn();
    requireAuth({ get: () => `Bearer ${token}` }, response, next);
    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json.mock.calls[0][0].error).toMatch(/истёк/i);
    expect(next).not.toHaveBeenCalled();
  });
});
