# АгроМаркет API

Backend интернет-магазина «АгроМаркет». В лабораторной №5 API работал с локальными данными; в лабораторной №6 каталог и заявки переведены на PostgreSQL. Ниже сохранены материалы предыдущей лабораторной и добавлена актуальная документация проекта.

## Быстрый запуск проекта

Для лабораторной №6 требуется PostgreSQL и настроенная строка подключения в `.env` (см. раздел «Лабораторная работа №6»).

```bash
cd agromarket-server
npm install
npm run dev
```

React-приложение запускается отдельно из каталога `agromarket-react` командой `npm run dev`.

## Структура проекта

```text
agromarket-server/
├── data/
│   └── db.json                 # начальные данные для seed
├── db/
│   ├── schema.sql
│   ├── pool.js
│   ├── seed.js
│   └── lab6-queries.sql
├── middleware/
│   ├── logger.js
│   ├── validateOrder.js
│   └── errorHandler.js
├── routes/
│   ├── products.js
│   └── orders.js
├── postman/
│   └── agromarket.postman_collection.json
├── screenshots/
├── .env.example
├── server.js
├── package.json
└── README.md
```

## Лабораторная 5 — сохранённые материалы

Следующие заметки и скриншоты документируют выполненные ранее упражнения Express, middleware, CORS и работу формы. Описание хранения заявок в памяти относится к исходному этапу ЛР5; в текущей ЛР6 заявки сохраняются в PostgreSQL.

### Content-Type у res.send и res.json

- `res.send()` со строкой возвращает текстовый Content-Type: `text/html; charset=utf-8`.
- `res.json()` возвращает `application/json`.

![Health Network](./screenshots/lab5-health-network.png)

### Middleware и обработчик 404

- Middleware, который не вызывает `next()` и не отправляет ответ, останавливает обработку запроса.
- Если logger подключён после маршрутов, ответивший маршрут до него не доходит.
- После подключения обработчика 404 неизвестный адрес возвращает JSON-ошибку вместо HTML.

![404 до middleware](./screenshots/lab5-abc-before-404-handler.png)

![404 после middleware](./screenshots/lab5-abc-after-json-404.png)

### CORS

- React работает на `localhost:5173`, Express — на `localhost:3000`; это разные origin.
- CORS разрешает браузеру читать ответы API.

![CORS до исправления](./screenshots/lab5-cors-error-before-fix.png)

![CORS исправлен](./screenshots/lab5-cors-fixed.png)

### Форма заявки и валидация в ЛР5

- При успешной отправке форма получала HTTP 201 и показывала номер заявки.
- Валидация проверяет обязательные `name`, `email`, `quantity` и минимальный объём 10 кг.
- `express.json()` разбирает JSON-тело запроса.

![Успешная заявка](./screenshots/lab5-order-success-alert.png)

![Ошибка валидации](./screenshots/lab5-order-validation-400.png)

![Список заявок в исходной версии ЛР5](./screenshots/lab5-orders-list.png)

![Без express.json](./screenshots/lab5-without-express-json.png)

### Маршрутизаторы и бонусы ЛР5

- Маршруты товаров и заявок разделены между `routes/products.js` и `routes/orders.js`.
- В предыдущей версии выполнялись поиск `?search=`, фильтр `?maxPrice=`, сортировка `?sort=price` / `?sort=-price`, валидация заявки и блокировка кнопки формы на время отправки.

## Лабораторная работа №6 — PostgreSQL и CRUD API

### Цель и архитектура

Перевести хранение товаров и заявок из локальных структур в реляционную БД, реализовать SQL CRUD и связать каталог и форму React с API.

```text
React + Vite (localhost:5173)
          │ HTTP / JSON
          ▼
Express 5 API (localhost:3000)
          │ параметризованные SQL-запросы через pg
          ▼
PostgreSQL 18 (Ubuntu VMware)
```

В этой учебной конфигурации PostgreSQL запущен в Ubuntu VMware по адресу `192.168.174.10:5432`; база называется `agromarket`, пользователь — `agromarket_user`. Этот IP относится только к локальной виртуальной машине данного проекта. В другой сети, на другом компьютере или при использовании облачной БД значение `DATABASE_URL` необходимо настроить самостоятельно.

### Настройка и запуск

1. Запустить PostgreSQL в Ubuntu VMware и проверить, что кластер активен (например, `sudo systemctl start postgresql` и `pg_lsclusters`).
2. В каталоге `agromarket-server` создать `.env` на основе `.env.example`, затем указать актуальную строку подключения. Настоящий пароль хранить только в `.env`, не в README и не в Git.

   Пример формата (замените `<PASSWORD>` своим паролем локально):

   ```dotenv
   PORT=3000
   DATABASE_URL=postgresql://agromarket_user:<PASSWORD>@192.168.174.10:5432/agromarket
   CORS_ORIGIN=http://localhost:5173
   ```

   `.env` исключён из Git; `.env.example` содержит только пример настроек, без пароля.

3. Установить зависимости и запустить Express из `agromarket-server`:

   ```bash
   cd agromarket-server
   npm install
   npm run dev
   ```

   Альтернативная команда запуска: `npm start`. API доступен по адресу [http://localhost:3000](http://localhost:3000).

4. Запустить React в отдельном терминале:

   ```bash
   cd agromarket-react
   npm install
   npm run dev
   ```

   Vite обычно открывает frontend по адресу [http://localhost:5173](http://localhost:5173).

#### Первоначальная инициализация БД

Для пустой БД текущий `package.json` предоставляет команду:

```bash
npm run db:init
```

В методичке эта операция упоминается как `npm run db`, но в текущем проекте такой script **не определён**; фактическое имя — `db:init`. Команда запускает `db/seed.js`, создаёт таблицы и загружает исходные товары. Это только первоначальная инициализация пустой базы. Скрипт намеренно прекращает работу, если таблицы уже существуют; не запускайте его повторно на рабочей БД и не используйте как обычную команду старта сервера.

### Таблицы и ограничения

Схема находится в [`db/schema.sql`](./db/schema.sql).

| Таблица | Основные поля и ограничения |
| --- | --- |
| `products` | `id SERIAL PRIMARY KEY`, обязательные `name` и целочисленный `price`, `CHECK (price >= 0)`, `unit` со значением по умолчанию, необязательные `category` и `image`. |
| `orders` | `id SERIAL PRIMARY KEY`, необязательный `product_id` с внешним ключом на `products(id)` и `ON DELETE SET NULL`, обязательные `name`, `email`, `quantity`, `CHECK (quantity >= 10)`, необязательные телефон, дата доставки и комментарий, статус из `new`, `processing`, `done`, `cancelled`. |

Заявки сохраняют ссылку на товар, а `GET /api/orders` получает название через `LEFT JOIN`; заявки без связанного товара также остаются в выдаче.

### SQL и безопасность

В [`db/lab6-queries.sql`](./db/lab6-queries.sql) собраны примеры и упражнения:

- `SELECT` — чтение всех товаров и выбор отдельных полей;
- `WHERE` — фильтрация, в том числе вместе с условием цены;
- `ORDER BY` — сортировка результатов;
- `ILIKE` — поиск подстроки без учёта регистра;
- `GROUP BY`, `COUNT`, `AVG` — группировка и агрегаты;
- `INSERT`, `UPDATE`, `DELETE` — изменение данных с `RETURNING`.

В API значения пользователя передаются параметрами `pg` (`$1`, `$2` и т. д.), а не вставляются в SQL как текст. Для сортировки используется белый список колонок. SQL-файл содержит упражнения с транзакциями и `ROLLBACK`; их наличие не означает, что они были повторно запущены в ходе этой финальной проверки.

### API-маршруты

Успешные ответы со списками сохраняют массив JSON. Ошибки возвращаются объектом `{ "error": "..." }`.

| Метод | Путь | Назначение | Ответы |
| --- | --- | --- | --- |
| `GET` | `/` | Проверка доступности сервера | 200 |
| `GET` | `/api/health` | Проверка API и соединения с PostgreSQL | 200 |
| `GET` | `/api/about` | Информация о проекте | 200 |
| `GET` | `/api/products` | Список товаров с поиском, фильтром, сортировкой и пагинацией | 200, 400 |
| `GET` | `/api/products/:id` | Получить товар | 200, 400, 404 |
| `POST` | `/api/products` | Создать товар | 201, 400 |
| `PUT` | `/api/products/:id` | Полностью обновить товар | 200, 400, 404 |
| `DELETE` | `/api/products/:id` | Удалить товар | 204, 400, 404 |
| `GET` | `/api/orders` | Список заявок с `product_name` | 200, 400 |
| `POST` | `/api/orders` | Создать заявку | 201, 400 |
| `PATCH` | `/api/orders/:id` | Изменить статус заявки | 200, 400, 404 |

Примеры безопасных GET-запросов:

```text
GET http://localhost:3000/api/health
GET http://localhost:3000/api/products
GET http://localhost:3000/api/products?search=мол&maxPrice=1000&sort=-price&limit=2&offset=0
GET http://localhost:3000/api/products?sort=name
GET http://localhost:3000/api/orders
GET http://localhost:3000/api/orders?status=new
```

Допустимые параметры `GET /api/products`:

| Параметр | Поведение |
| --- | --- |
| `search` | Поиск названия без учёта регистра; специальные символы поиска обрабатываются как буквальный текст. |
| `maxPrice` | Максимальная цена включительно. |
| `sort` | `price`, `-price`, `name`, `-name`; неизвестное значение безопасно возвращает порядок `id ASC`. При равных ключах сортировки добавляется `id ASC`. |
| `limit` | Целое число от 1 до 100; по умолчанию `20`. |
| `offset` | Неотрицательное целое число; по умолчанию `0`. |

Для `GET /api/orders` необязательный `status` принимает только `new`, `processing`, `done` или `cancelled`. Без него возвращаются все заявки; неизвестное, пустое или повторяющееся значение даёт HTTP 400.

Создание заявки из формы React отправляет поля `name`, `email`, `phone`, `quantity`, `date`, `comment` и `product_id`. ID выбранного товара передаётся числом; если товар не выбран, передаётся `null`.

### Централизованная обработка ошибок

`middleware/errorHandler.js` подключён после маршрутов и 404 middleware. Он преобразует известные ошибки PostgreSQL (`22P02`, `23502`, `23503`, `23514`) и ошибки разбора JSON в JSON-ответ 400. Для остальных ошибок возвращается общее сообщение 500; детали и секреты клиенту не выдаются.

### Postman

Коллекция [`postman/agromarket.postman_collection.json`](./postman/agromarket.postman_collection.json) содержит **16 запросов и 48 проверок**. По результату предыдущего запуска коллекции все 48 проверок прошли, ошибок не было. Этот показатель относится к первоначальному набору Postman и **не включает отдельные проверки четырёх бонусов**.

Коллекция содержит изменяющие данные запросы (создание/обновление/удаление тестового товара и создание заявки). Запускайте её только на тестовой БД и учитывайте предупреждения/инструкции по очистке в описании коллекции. В API нет публичного маршрута удаления заявки.

### React и результаты проверок

React загружает каталог из `GET /api/products`, выполняет поиск в каталоге и отправляет форму в `POST /api/orders`. Форма позволяет выбрать товар; при получении заявки сервер объединяет данные товара по `product_id`.

Результаты проверок проекта:

- PostgreSQL доступен; безопасные `SELECT` подтвердили **4 товара и 0 заявок**.
- Отдельным `SELECT` подтверждено, что тестовая заявка с `id = 6` отсутствует.
- Проверки GET для health, каталога, поиска, сортировок, страниц и фильтра статуса прошли; ошибки валидации возвращаются в JSON.
- Ранее выполненный запуск Postman: 16 запросов, 48/48 проверок, 0 ошибок.
- Дополнительные проверки бонусов выполнялись отдельно и не включены в 48 тестов Postman.
- Для `agromarket-react` команды `npm run lint` и `npm run build` завершились успешно.

### Скриншоты лабораторной №6

Все ссылки ниже ведут на файлы в [`screenshots/`](./screenshots/).

| Доказательство | Скриншот |
| --- | --- |
| PostgreSQL cluster в Ubuntu | ![PostgreSQL cluster в Ubuntu](./screenshots/lab6-postgresql-cluster.png) |
| Порт PostgreSQL | ![Порт PostgreSQL 5432](./screenshots/lab6-postgresql-port-5432.png) |
| Таблицы и товары в PostgreSQL | ![Таблицы и товары PostgreSQL](./screenshots/lab6-postgresql-tables-products.png) |
| SQL: фильтр и сортировка | ![SQL WHERE и ORDER BY](./screenshots/lab6-sql-where-order-by.png) |
| SQL: поиск без учёта регистра | ![SQL ILIKE](./screenshots/lab6-sql-ilike.png) |
| Результаты SQL-упражнений | ![Результаты SQL-проверок](./screenshots/lab6-sql-tests-results.png) |
| API возвращает товары из PostgreSQL | ![API товаров из PostgreSQL](./screenshots/lab6-api-products-postgresql.png) |
| Postman: состав коллекции | ![Postman-коллекция](./screenshots/lab6-postman-collection.png) |
| Postman: успешные проверки | ![Postman: успешные тесты](./screenshots/lab6-postman-tests-success.png) |
| Postman: проверки ошибок и CRUD | ![Postman: ошибки и CRUD](./screenshots/lab6-postman-tests-errors-crud.png) |
| Бонус: сортировка и пагинация | ![Сортировка и пагинация](./screenshots/lab6-bonus-sort-pagination.png) |
| Бонус: выбор товара в форме | ![Выбор товара в React-форме](./screenshots/lab6-react-product-select.png) |

### Вывод

Каталог товаров и заявки хранятся в PostgreSQL; Express предоставляет параметризованный CRUD API и формирует JSON-ответы, React продолжает обращаться к API. Базовые и бонусные возможности проверены отдельно. На момент проверки в базе остаются четыре исходных товара и нет заявок.

### Использование ИИ

ИИ использовался для пошагового сопровождения лабораторных работ, проверки структуры проекта и объяснения Express, PostgreSQL, SQL, middleware, CORS и валидации. Ключевые результаты проверялись тестами, через API, браузер и Postman.

## Автор

Куанышулы Асылхан
