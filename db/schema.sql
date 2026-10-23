-- Первичная инициализация: существующие таблицы не удаляем.
-- Намеренно без DROP и IF NOT EXISTS: повторный запуск должен остановиться.
CREATE TABLE products (
  id         SERIAL PRIMARY KEY,
  name       TEXT    NOT NULL,
  category   TEXT,
  price      INTEGER NOT NULL CHECK (price >= 0),
  unit       TEXT    NOT NULL DEFAULT 'кг',
  image      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  name          TEXT        NOT NULL,
  email         TEXT        NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,
  role          TEXT        NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id            SERIAL PRIMARY KEY,
  product_id    INTEGER REFERENCES products(id) ON DELETE SET NULL,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name          TEXT    NOT NULL,
  email         TEXT    NOT NULL,
  phone         TEXT,
  quantity      INTEGER NOT NULL CHECK (quantity >= 10),
  delivery_date DATE,
  comment       TEXT,
  status        TEXT    NOT NULL DEFAULT 'new'
                CHECK (status IN ('new', 'processing', 'done', 'cancelled')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
