-- One atomic statement, usable both directly and inside test initialization.
DO $migration$
DECLARE
  legacy_columns CONSTANT text[] := ARRAY[
    'comment:text', 'created_at:timestamp with time zone', 'delivery_date:date',
    'email:text', 'id:integer', 'name:text', 'phone:text', 'product_id:integer',
    'quantity:integer', 'status:text', 'user_id:integer'
  ];
  actual_columns text[];
  previous_lock_timeout text := current_setting('lock_timeout');
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  PERFORM pg_advisory_xact_lock(130013);

  IF to_regclass('public.products') IS NULL OR to_regclass('public.users') IS NULL
      OR to_regclass('public.orders') IS NULL THEN
    RAISE EXCEPTION '013: expected public.products, public.users and public.orders';
  END IF;

  LOCK TABLE public.orders IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE public.products IN ACCESS EXCLUSIVE MODE;

  SELECT array_agg(attname || ':' || format_type(atttypid, atttypmod) ORDER BY attname COLLATE "C")
    INTO actual_columns
  FROM pg_catalog.pg_attribute
  WHERE attrelid = 'public.orders'::regclass AND attnum > 0 AND NOT attisdropped;
  IF actual_columns IS DISTINCT FROM legacy_columns THEN
    RAISE EXCEPTION '013: public.orders is not the expected legacy requests table';
  END IF;

  IF to_regclass('public.order_requests') IS NOT NULL THEN
    RAISE EXCEPTION '013: previous order_requests schema requires a separate data migration';
  END IF;

  IF to_regclass('public.purchase_orders') IS NOT NULL THEN
    IF to_regclass('public.order_items') IS NULL OR (
      SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE convalidated AND (
        (conrelid = 'public.products'::regclass AND conname IN
          ('products_stock_nonnegative', 'products_farmer_id_fkey')) OR
        (conrelid = 'public.purchase_orders'::regclass AND conname IN
          ('purchase_orders_pkey', 'purchase_orders_user_id_fkey', 'purchase_orders_status_check',
           'purchase_orders_total_price_check', 'purchase_orders_address_check')) OR
        (conrelid = to_regclass('public.order_items') AND conname IN
          ('order_items_pkey', 'order_items_order_id_fkey', 'order_items_product_id_fkey',
           'order_items_quantity_check', 'order_items_unit_price_check'))
      )
    ) <> 12 OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = 'public.products'::regclass AND a.attname = 'stock'
        AND a.atttypid = 'integer'::regtype AND a.attnotnull AND NOT a.attisdropped
        AND pg_get_expr(d.adbin, d.adrelid) = '0'
    ) OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute
      WHERE attrelid = 'public.purchase_orders'::regclass AND attname = 'address'
        AND atttypid = 'text'::regtype AND attnotnull AND NOT attisdropped
    ) OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.purchase_orders'::regclass
        AND conname = 'purchase_orders_address_check' AND contype = 'c' AND convalidated
        AND pg_get_constraintdef(oid) = 'CHECK (((char_length(btrim(address)) >= 5) AND (char_length(btrim(address)) <= 200)))'
    ) OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.purchase_orders'::regclass
        AND conname = 'purchase_orders_status_check' AND contype = 'c' AND convalidated
        AND pg_get_constraintdef(oid) = 'CHECK ((status = ANY (ARRAY[''new''::text, ''confirmed''::text, ''shipped''::text, ''cancelled''::text])))'
    ) OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = 'public.purchase_orders'::regclass AND a.attname = 'status'
        AND a.atttypid = 'text'::regtype AND a.attnotnull AND NOT a.attisdropped
        AND pg_get_expr(d.adbin, d.adrelid) = '''new''::text'
    ) OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.order_items'::regclass
        AND conname = 'order_items_order_id_fkey' AND confrelid = 'public.purchase_orders'::regclass
        AND contype = 'f' AND convalidated
    ) OR (
      SELECT count(*) FROM pg_catalog.pg_index WHERE indisvalid AND (
        (indrelid = 'public.products'::regclass AND indexrelid = to_regclass('public.products_farmer_id_idx')) OR
        (indrelid = 'public.purchase_orders'::regclass AND indexrelid = to_regclass('public.purchase_orders_user_created_idx')) OR
        (indrelid = to_regclass('public.order_items') AND indexrelid = to_regclass('public.order_items_product_id_idx'))
      )
    ) <> 3 THEN
      RAISE EXCEPTION '013: incomplete or conflicting order schema';
    END IF;
    PERFORM set_config('lock_timeout', previous_lock_timeout, true);
    RETURN;
  END IF;

  IF to_regclass('public.order_items') IS NOT NULL OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.products'::regclass AND attnum > 0 AND NOT attisdropped
      AND attname IN ('stock', 'farmer_id')
  ) THEN
    RAISE EXCEPTION '013: conflicting order items or product inventory columns';
  END IF;

  ALTER TABLE public.products
    ADD COLUMN stock INTEGER NOT NULL DEFAULT 0 CONSTRAINT products_stock_nonnegative CHECK (stock >= 0),
    ADD COLUMN farmer_id INTEGER CONSTRAINT products_farmer_id_fkey REFERENCES public.users(id) ON DELETE SET NULL;
  CREATE INDEX products_farmer_id_idx ON public.products (farmer_id);

  CREATE TABLE public.purchase_orders (
    id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES public.users(id),
    address TEXT NOT NULL CONSTRAINT purchase_orders_address_check CHECK (char_length(btrim(address)) BETWEEN 5 AND 200),
    status TEXT NOT NULL DEFAULT 'new' CONSTRAINT purchase_orders_status_check
      CHECK (status IN ('new', 'confirmed', 'shipped', 'cancelled')),
    total_price BIGINT NOT NULL CONSTRAINT purchase_orders_total_price_check CHECK (total_price >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX purchase_orders_user_created_idx ON public.purchase_orders (user_id, created_at DESC);

  CREATE TABLE public.order_items (
    order_id INTEGER NOT NULL REFERENCES public.purchase_orders(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES public.products(id),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price INTEGER NOT NULL CHECK (unit_price >= 0),
    PRIMARY KEY (order_id, product_id)
  );
  CREATE INDEX order_items_product_id_idx ON public.order_items (product_id);

  PERFORM set_config('lock_timeout', previous_lock_timeout, true);
END;
$migration$;
