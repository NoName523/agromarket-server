import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool } from './pool.js';

try {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || typeof password !== 'string' || password.length < 12 ||
      password.startsWith('replace-with-')) {
    console.log('Проверка: некорректные ADMIN_EMAIL или ADMIN_PASSWORD.');
  } else {
    const database = await pool.query('SELECT current_database() AS name');
    if (database.rows[0]?.name !== 'agromarket') {
      console.log('Проверка: подключена другая база.');
    } else {
      const { rows } = await pool.query(
        'SELECT role, password_hash FROM public.users WHERE email = $1', [email],
      );
      if (rows.length !== 1) {
        console.log('Проверка: ADMIN_EMAIL не найден.');
      } else if (rows[0].role !== 'admin') {
        console.log('Проверка: email принадлежит обычному пользователю.');
      } else if (await bcrypt.compare(password, rows[0].password_hash)) {
        console.log('Проверка: пароль в .env уже совпадает с паролем администратора.');
      } else {
        console.log('Проверка: настройки и БД готовы к ротации.');
      }
    }
  }
} catch (error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9]{2,10}$/.test(error.code)
    ? error.code : 'unknown';
  console.error(`Проверка: нет доступа к БД или ошибка SELECT (код ${code}).`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
