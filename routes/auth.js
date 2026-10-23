import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { rateLimit } from 'express-rate-limit';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const jwtSecret = process.env.JWT_SECRET;
const jwtExpiresIn = process.env.JWT_EXPIRES_IN;

if (!jwtSecret || jwtSecret.length < 32 || jwtSecret.startsWith('replace-with-') ||
    jwtExpiresIn !== '2h') {
  throw new Error('JWT_SECRET (at least 32 characters) and JWT_EXPIRES_IN=2h are required');
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Слишком много попыток. Повторите позже.' },
});

function issueToken(user) {
  return jwt.sign({ role: user.role }, jwtSecret, {
    subject: String(user.id),
    expiresIn: jwtExpiresIn,
  });
}

function normalizedEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

router.post('/register', async (req, res) => {
  const { name, email, password } = req.body ?? {};
  const cleanName = typeof name === 'string' ? name.trim() : '';
  const cleanEmail = normalizedEmail(email);
  if (!cleanName || !cleanEmail || typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'Имя, email и пароль обязательны' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ error: 'Некорректный email' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Пароль должен содержать минимум 8 символов' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    `INSERT INTO public.users (name, email, password_hash, role)
     VALUES ($1, $2, $3, 'user')
     RETURNING id, name, email, role, created_at`,
    [cleanName, cleanEmail, passwordHash],
  );
  const user = rows[0];
  res.status(201).json({ user, token: issueToken(user) });
});

router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body ?? {};
  const cleanEmail = normalizedEmail(email);
  if (!cleanEmail || typeof password !== 'string') {
    return res.status(401).json({ error: 'Неверный email или пароль' });
  }

  const { rows } = await pool.query(
    `SELECT id, name, email, role, created_at, password_hash
     FROM public.users WHERE email = $1`,
    [cleanEmail],
  );
  const account = rows[0];
  if (!account || !(await bcrypt.compare(password, account.password_hash))) {
    return res.status(401).json({ error: 'Неверный email или пароль' });
  }

  const { password_hash: unused, ...user } = account;
  res.json({ user, token: issueToken(user) });
});

router.get('/me', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, email, role, created_at
     FROM public.users WHERE id = $1`,
    [req.user.id],
  );
  if (rows.length === 0) {
    return res.status(401).json({ error: 'Пользователь не найден' });
  }
  res.json(rows[0]);
});

router.patch('/password', requireAuth, async (req, res) => {
  const { oldPassword, newPassword } = req.body ?? {};
  if (typeof oldPassword !== 'string' || !oldPassword ||
      typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ error: 'Укажите старый и новый пароль (минимум 8 символов)' });
  }

  const { rows } = await pool.query(
    'SELECT password_hash FROM public.users WHERE id = $1', [req.user.id],
  );
  if (!rows[0] || !(await bcrypt.compare(oldPassword, rows[0].password_hash))) {
    return res.status(401).json({ error: 'Неверный старый пароль' });
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  const updated = await pool.query(
    `UPDATE public.users SET password_hash = $1
     WHERE id = $2 AND password_hash = $3 RETURNING id`,
    [passwordHash, req.user.id, rows[0].password_hash],
  );
  if (updated.rows.length === 0) {
    return res.status(409).json({ error: 'Пароль уже изменён. Повторите вход.' });
  }
  res.json({ message: 'Пароль изменён' });
});

export default router;
