-- Первичная инициализация: существующие таблицы не удаляем.
-- Намеренно без DROP и IF NOT EXISTS: повторный запуск должен остановиться.
CREATE TABLE public.login_attempts (
  email_key TEXT PRIMARY KEY CHECK (email_key ~ '^[0-9a-f]{64}$'),
  generation UUID NOT NULL,
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count BETWEEN 0 AND 10),
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  blocked_until TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (clock_timestamp() + interval '16 minutes'),
  CHECK (expires_at > window_started_at),
  CHECK (blocked_until IS NULL OR
    (failed_count = 10 AND blocked_until >= window_started_at AND blocked_until <= expires_at)),
  CHECK (failed_count < 10 OR blocked_until IS NOT NULL)
);

CREATE TABLE public.login_attempt_reservations (
  email_key TEXT NOT NULL REFERENCES public.login_attempts(email_key) ON DELETE CASCADE,
  attempt_id UUID NOT NULL,
  generation UUID NOT NULL,
  reserved_at TIMESTAMPTZ NOT NULL,
  lease_expires_at TIMESTAMPTZ NOT NULL CHECK (lease_expires_at > reserved_at),
  PRIMARY KEY (email_key, attempt_id)
);

CREATE INDEX login_attempts_expiry_idx ON public.login_attempts (expires_at, email_key);
CREATE INDEX login_attempt_reservations_lease_idx
  ON public.login_attempt_reservations (email_key, lease_expires_at);

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
  role          TEXT        NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin', 'farmer')),
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
