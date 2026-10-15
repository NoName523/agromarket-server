-- ЛР №6, часть 2. Файл сохранён в UTF-8. Только для базы agromarket.
-- Перед выполнением сверить четыре исходных товара с data/db.json.
-- Проверить отсутствие products.id = -6001, orders.id = -6001 и products.id = 9999.
-- Тестовый ID задан явно: ROLLBACK не откатывает nextval у SERIAL.
-- UPDATE и DELETE затрагивают только запись, созданную в той же транзакции.
-- Блоки с ожидаемой ошибкой выполняйте отдельными командами:
-- BEGIN, затем INSERT, после ошибки обязательно ROLLBACK.
-- Не отправляйте весь файл одним запросом: ошибка остановит такой запрос.
-- Метки @test задают блок и ожидаемый SQLSTATE для проверяющего Node.js-кода.

-- @test select OK
-- Все товары.
SELECT * FROM public.products ORDER BY id;

-- @test where_order OK
-- Фильтрация и сортировка: товары дешевле 1000, начиная с самого дорогого.
SELECT name, price FROM public.products WHERE price < 1000 ORDER BY price DESC, id;

-- @test ilike OK
-- Поиск подстроки без учёта регистра.
SELECT name FROM public.products WHERE name ILIKE '%мол%' ORDER BY id;

-- @test group_by OK
-- Число товаров и округлённая средняя цена по категориям.
SELECT category, COUNT(*) AS cnt, ROUND(AVG(price)) AS avg_price
FROM public.products GROUP BY category ORDER BY category NULLS LAST;

-- @test most_expensive OK
-- Один самый дорогой товар. При равной цене выбирается меньший ID.
SELECT id, name, price FROM public.products ORDER BY price DESC, id LIMIT 1;

-- @test crud OK
-- Создание, изменение и удаление исключительно тестовой записи.
BEGIN;
INSERT INTO public.products (id, name, price)
VALUES (-6001, 'Тестовый товар ЛР6', 100) RETURNING id, name, price;
UPDATE public.products SET price = 150
WHERE id = -6001 AND name = 'Тестовый товар ЛР6' RETURNING id, name, price;
DELETE FROM public.products
WHERE id = -6001 AND name = 'Тестовый товар ЛР6' RETURNING id, name, price;
ROLLBACK;

-- @test check_price 23514
-- Отрицательная цена нарушает CHECK (price >= 0), ожидается SQLSTATE 23514.
BEGIN;
INSERT INTO public.products (id, name, price) VALUES (-6001, 'Брак', -5);
ROLLBACK;

-- @test not_null 23502
-- Отсутствует обязательное name, ожидается SQLSTATE 23502.
BEGIN;
INSERT INTO public.products (id, price) VALUES (-6001, 100);
ROLLBACK;

-- @test foreign_key 23503
-- Несуществующий product_id нарушает внешний ключ, ожидается SQLSTATE 23503.
BEGIN;
INSERT INTO public.orders (id, product_id, name, email, quantity)
VALUES (-6001, 9999, 'Тест', 't@t.kz', 20);
ROLLBACK;

-- @test final_select OK
-- После отката должны остаться четыре исходных товара без тестовой записи.
SELECT id, name, price, unit, category, image FROM public.products ORDER BY id;
