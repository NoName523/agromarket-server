# АгроМаркет API

## Запуск

```bash
npm install
npm run dev
```

Сервер: [http://localhost:3000](http://localhost:3000)

Frontend: [http://localhost:5173](http://localhost:5173)

## Структура проекта

```text
agromarket-server/
├── data/
│   ├── db.json
│   └── products.js
├── middleware/
│   ├── logger.js
│   └── validateOrder.js
├── routes/
│   ├── products.js
│   └── orders.js
├── screenshots/
├── server.js
├── package.json
└── README.md
```

## Эндпоинты

| Метод | Путь | Описание | Ответы |
| --- | --- | --- | --- |
| GET | / | проверочный текст | 200 |
| GET | /api/health | состояние API | 200 |
| GET | /api/about | информация о проекте | 200 |
| GET | /api/products | список товаров | 200 |
| GET | /api/products/:id | товар по id | 200, 404 |
| GET | /api/orders | список заявок | 200 |
| POST | /api/orders | создание заявки | 201, 400 |

Query-параметры `/api/products` можно использовать вместе:

- `?search=` — поиск по названию без учёта регистра.
- `?maxPrice=` — максимальная цена включительно.
- `?sort=price` — сортировка по возрастанию цены.
- `?sort=-price` — сортировка по убыванию цены.

Примеры:

- `/api/products?search=мол`
- `/api/products?maxPrice=1000`
- `/api/products?sort=price`
- `/api/products?search=мол&maxPrice=1000&sort=-price`

## Лабораторная 5 — ответы

### Content-Type у res.send и res.json

- `res.send()` со строкой возвращает текстовый Content-Type: `text/html; charset=utf-8`.
- `res.json()` возвращает `application/json`.

![Health Network](./screenshots/lab5-health-network.png)

### Что происходит без next()

Если middleware не вызывает `next()` и сам не отправляет ответ:

- middleware получает запрос, но не передаёт его дальше;
- маршрут не выполняется;
- клиент ждёт ответ.

### Что происходит, если logger подключён после маршрутов

- Обработанный маршрутом запрос до logger не доходит.
- Маршрут уже отправил ответ и не вызывает `next()`.

### Обработчик 404

До подключения middleware запрос `/abc` возвращал статус 404 и HTML-ответ.

![404 до middleware](./screenshots/lab5-abc-before-404-handler.png)

После подключения общего обработчика запрос `/abc` возвращает статус 404 и JSON: `{ "error": "Маршрут GET /abc не найден" }`.

![404 после middleware](./screenshots/lab5-abc-after-json-404.png)

### CORS

- React работает на `localhost:5173`.
- Express работает на `localhost:3000`.
- Разные порты означают разные origin.
- Без CORS браузер блокировал чтение ответа.

![CORS до исправления](./screenshots/lab5-cors-error-before-fix.png)

- После настройки CORS появился заголовок `Access-Control-Allow-Origin: http://localhost:5173`.

![CORS исправлен](./screenshots/lab5-cors-fixed.png)

### POST /api/orders

При успешной отправке формы сервер возвращает статус 201 и созданную заявку, а React показывает сообщение с её номером.

![Успешная заявка](./screenshots/lab5-order-success-alert.png)

Запрос `GET /api/orders` возвращает список сохранённых в памяти заявок.

![Список заявок](./screenshots/lab5-orders-list.png)

### Что происходит без express.json()

- JSON-тело POST-запроса не разбирается.
- `req.body` пустой или `undefined`.
- Сервер возвращает 400 из-за отсутствия обязательных полей.

![Без express.json](./screenshots/lab5-without-express-json.png)

### Серверная валидация

- Обязательны `name`, `email` и `quantity`.
- `quantity` меньше 10 приводит к 400.
- Проверка вынесена в [middleware/validateOrder.js](./middleware/validateOrder.js).

![Ошибка 400](./screenshots/lab5-order-validation-400.png)

### express.Router

- Маршруты товаров вынесены в [routes/products.js](./routes/products.js).
- Маршруты заявок вынесены в [routes/orders.js](./routes/orders.js).
- [server.js](./server.js) отвечает за сборку приложения и middleware.

### Бонусы

Реализовано:

- Фильтр `?maxPrice=`.
- Сортировка `?sort=price` и `?sort=-price`.
- Middleware `validateOrder`.
- Состояние `sending` у формы и блокировка кнопки во время отправки.

### Использование ИИ

ИИ использовался для пошагового сопровождения лабораторной работы, проверки структуры проекта, объяснения Express, middleware, CORS, Router и серверной валидации. Все ключевые результаты дополнительно проверялись вручную через браузер, DevTools и Network.

## Автор

Куанышулы Асылхан
