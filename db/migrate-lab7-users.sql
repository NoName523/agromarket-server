-- Apply once to an existing Lab 6 database. No existing rows are changed or removed.
BEGIN;

CREATE TABLE public.users (
  id            SERIAL PRIMARY KEY,
  name          TEXT        NOT NULL,
  email         TEXT        NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,
  role          TEXT        NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.orders
  ADD COLUMN user_id INTEGER REFERENCES public.users(id) ON DELETE SET NULL;

COMMIT;
