const PG_CLIENT_ERRORS = new Map([
  ['22P02', 'Неверный формат значения'],
  ['23502', 'Не заполнено обязательное поле'],
  ['23503', 'Связанная запись не найдена'],
  ['23514', 'Значение не проходит проверку в БД'],
]);

// Четыре аргумента обязательны для error middleware Express.
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err?.code === '23505') {
    return res.status(409).json({ error: 'Запись с таким значением уже существует' });
  }

  const message = PG_CLIENT_ERRORS.get(err?.code);
  if (message) return res.status(400).json({ error: message });

  // Ошибки JSON-парсера также относятся к неверным данным клиента.
  if (err?.type === 'entity.parse.failed' && err.status === 400) {
    return res.status(400).json({ error: 'Некорректный JSON в теле запроса' });
  }

  if (err?.type === 'entity.too.large' && err.status === 413) {
    return res.status(413).json({ error: 'Слишком большое тело запроса' });
  }

  // Не выводим err, message, detail или стек: в них могут быть секреты.
  console.error('Неожиданная ошибка сервера');
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
}
