import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { pool } from './pool.js';

const force = process.argv.includes('--force');
let seedUrl;
try {
  seedUrl = new URL(process.env.DATABASE_URL);
} catch {
  console.error('Seed отклонён: укажите корректный DATABASE_URL.');
  process.exit(1);
}

const localHost = ['localhost', '127.0.0.1'].includes(seedUrl.hostname);
const neonHost = seedUrl.hostname.endsWith('.neon.tech') &&
  seedUrl.hostname.length > '.neon.tech'.length;
if (!localHost && !neonHost) {
  console.error('Seed отклонён: разрешены только localhost, 127.0.0.1 и *.neon.tech.');
  process.exit(1);
}

const requestedDatabase = decodeURIComponent(seedUrl.pathname.slice(1));
if (!requestedDatabase) {
  console.error('Seed отклонён: в DATABASE_URL не указана база данных.');
  process.exit(1);
}
if (localHost && requestedDatabase !== 'agromarket') {
  console.error('Seed отклонён: локальный запуск разрешён только для базы agromarket.');
  process.exit(1);
}
if (neonHost && (!force || requestedDatabase !== 'neondb')) {
  console.error('Seed отклонён: Neon разрешён только с --force и базой neondb.');
  process.exit(1);
}

let client;
let transactionStarted = false;
let failureMessage = 'Инициализация не выполнена. Проверьте настройки подключения и права доступа.';

try {
  if (!process.env.DATABASE_URL) {
    throw new Error('Missing configuration');
  }

  failureMessage = 'Ожидалось подключение к базе agromarket. Инициализация отменена.';

  failureMessage = 'Не удалось прочитать схему или исходные товары.';
  const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  const { products } = JSON.parse(
    readFileSync(new URL('../data/db.json', import.meta.url), 'utf8'),
  );

  failureMessage = 'Исходные товары некорректны: проверьте название, целую цену и единицу измерения.';
  if (!Array.isArray(products) || products.length === 0) {
    throw new Error('Invalid products');
  }

  // Проверяем все данные до подключения. Строковые id намеренно не переносим:
  // по методичке новые числовые идентификаторы назначает SERIAL.
  const preparedProducts = products.map((product) => {
    if (!product || typeof product.name !== 'string' || !product.name.trim()) {
      throw new Error('Invalid name');
    }

    const rawPrice = product.price;
    if (typeof rawPrice !== 'number' &&
        !(typeof rawPrice === 'string' && /^\d+$/.test(rawPrice))) {
      throw new Error('Invalid price');
    }
    const price = Number(rawPrice);
    if (!Number.isInteger(price) || price < 0 || price > 2147483647) {
      throw new Error('Price outside INTEGER range');
    }

    // В текущем JSON единица указана в конце названия: «..., 1 кг» / «..., 1 л».
    const inferredUnit = product.name.match(/,\s*\d+(?:[.,]\d+)?\s*(кг|л)\s*$/iu)?.[1].toLowerCase();
    const unit = product.unit ?? inferredUnit;
    if (typeof unit !== 'string' || !unit.trim() ||
        (inferredUnit && unit !== inferredUnit)) {
      throw new Error('Missing or conflicting unit');
    }

    for (const field of ['category', 'image']) {
      if (product[field] != null && typeof product[field] !== 'string') {
        throw new Error('Invalid optional field');
      }
    }
    return [product.name, product.category ?? null, price, unit, product.image ?? null];
  });

  failureMessage = 'Не удалось подключиться к PostgreSQL. Проверьте настройки и права доступа.';
  client = await pool.connect();
  const database = await client.query('SELECT current_database() AS name');
  failureMessage = 'Имя подключённой базы не совпадает с DATABASE_URL. Инициализация отменена.';
  if (database.rows[0].name !== requestedDatabase) {
    throw new Error('Unexpected database');
  }

  failureMessage = 'Не удалось начать инициализацию базы.';
  await client.query('BEGIN');
  transactionStarted = true;
  await client.query('SET LOCAL search_path TO public');

  const existing = await client.query(
    "SELECT to_regclass('public.products') AS products, to_regclass('public.orders') AS orders",
  );
  failureMessage = 'Таблица products или orders уже существует. Повторная инициализация запрещена; данные сохранены.';
  if (existing.rows[0].products !== null || existing.rows[0].orders !== null) {
    throw new Error('Existing tables');
  }

  // Даже при параллельном запуске CREATE без IF NOT EXISTS не позволит
  // продолжить загрузку в таблицы, созданные другим запуском.
  failureMessage = 'Ошибка создания таблиц или переноса товаров. Изменения транзакции отменяются.';
  await client.query(schema);
  for (const values of preparedProducts) {
    await client.query(
      `INSERT INTO products (name, category, price, unit, image)
       VALUES ($1, $2, $3, $4, $5)`,
      values,
    );
  }
  await client.query('COMMIT');
  transactionStarted = false;
  console.log(`Готово: таблицы созданы, товаров добавлено — ${preparedProducts.length}`);
} catch {
  if (transactionStarted && client) {
    try {
      await client.query('ROLLBACK');
    } catch {
      console.error('Не удалось подтвердить откат. Проверьте состояние базы перед повторным запуском.');
    }
  }
  console.error(failureMessage);
  process.exitCode = 1;
} finally {
  // Закрываем клиент и пул независимо от результата, без вывода секретов.
  try {
    if (client) client.release(true);
  } finally {
    try {
      await pool.end();
    } catch {
      console.error('Ошибка завершения соединений PostgreSQL.');
      process.exitCode = 1;
    }
  }
}
