import pg from 'pg';

// DATE остаётся календарной датой, без преобразования часового пояса.
pg.types.setTypeParser(1082, (value) => value);

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10000,
});

// Не печатаем исходную ошибку: она может содержать параметры подключения.
pool.on('error', () => {
  console.error('Ошибка фонового соединения PostgreSQL.');
});
