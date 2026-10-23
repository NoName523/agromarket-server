import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool } from './pool.js';

try {
  if (process.argv[2] !== '--confirm') {
    throw new Error('Confirmation required');
  }
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || typeof password !== 'string' || password.length < 12 ||
      password.startsWith('replace-with-')) {
    throw new Error('Invalid admin configuration');
  }

  const database = await pool.query('SELECT current_database() AS name');
  if (database.rows[0]?.name !== 'agromarket') {
    throw new Error('Unexpected database');
  }
  const existing = await pool.query(
    `SELECT id, password_hash FROM public.users
     WHERE email = $1 AND role = 'admin'`, [email],
  );
  if (existing.rows.length !== 1) {
    throw new Error('Admin missing');
  }

  if (await bcrypt.compare(password, existing.rows[0].password_hash)) {
    console.log('Пароль администратора уже соответствует ADMIN_PASSWORD; изменений нет.');
  } else {
    const newHash = await bcrypt.hash(password, 10);
    const updated = await pool.query(
      `UPDATE public.users SET password_hash = $1
       WHERE id = $2 AND role = 'admin' AND password_hash = $3 RETURNING id`,
      [newHash, existing.rows[0].id, existing.rows[0].password_hash],
    );
    if (updated.rows.length !== 1) {
      throw new Error('Concurrent update');
    }
    console.log('Пароль администратора обновлён.');
  }
} catch {
  console.error('Ротация пароля не выполнена. Проверьте ADMIN_EMAIL, новый ADMIN_PASSWORD и доступ к БД.');
  process.exitCode = 1;
} finally {
  try {
    await pool.end();
  } catch {
    console.error('Не удалось закрыть соединение с БД.');
    process.exitCode = 1;
  }
}
