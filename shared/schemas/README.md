# agromarket-schemas

Общие ESM-схемы Zod для backend и React проекта «АгроМаркет».
Пакет пока подготовлен локально и не подключён к приложениям.
`private: true` защищает от случайной публикации.

Экспорты: `registerSchema`, `loginSchema`, `productSchema`,
`productUpdateSchema`, `idParam`, `orderStatusSchema`.

```js
import { registerSchema } from 'agromarket-schemas';

const result = registerSchema.safeParse(input);
```

Схемы отбрасывают неизвестные поля, нормализуют email и проверяют цену
до преобразования строк. Пароли регистрации ограничены 72 UTF-8 байтами;
подсчёт через `TextEncoder` работает в Node.js 22 и современных браузерах.
Авторизация, bcrypt и проверки БД остаются обязанностью сервера.

После разрешения на установку зависимости выполнить из этой папки:

```sh
npm install
npm test
```

Тесты используют встроенный `node:test`, не обращаются к сети или БД.
Сборка пакета не требуется. Клиентская валидация не заменяет серверную.
