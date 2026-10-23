import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool } from './pool.js';

const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD;

try {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      typeof password !== 'string' || password.length < 8 ||
      password.startsWith('replace-with-')) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD (at least 8 characters) are required');
  }

  const database = await pool.query('SELECT current_database() AS name');
  if (database.rows[0]?.name !== 'agromarket') {
    throw new Error('Unexpected database');
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    `INSERT INTO public.users (name, email, password_hash, role)
     VALUES ('Администратор', $1, $2, 'admin')
     ON CONFLICT (email) DO NOTHING
     RETURNING id`,
    [email, passwordHash],
  );

  if (rows.length) {
    console.log('Администратор создан.');
  } else {
    const existing = await pool.query(
      'SELECT role FROM public.users WHERE email = $1', [email],
    );
    if (existing.rows[0]?.role !== 'admin') {
      throw new Error('ADMIN_EMAIL already belongs to a regular user');
    }
    console.log('Администратор уже существует; пароль не изменён.');
  }
} catch {
  console.error('Не удалось создать администратора. Проверьте конфигурацию, схему и доступ к базе.');
  process.exitCode = 1;
} finally {
  await pool.end();
}
