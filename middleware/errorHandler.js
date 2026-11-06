const PG_CLIENT_ERRORS = new Map([
  ['22P02', 'Неверный формат значения'],
  ['23502', 'Не заполнено обязательное поле'],
  ['23503', 'Связанная запись не найдена'],
  ['23514', 'Значение не проходит проверку в БД'],
]);

export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err?.code === '23505') return res.status(409).json({ error: 'Запись с таким значением уже существует' });
  const pgMessage = PG_CLIENT_ERRORS.get(err?.code);
  if (pgMessage) return res.status(400).json({ error: pgMessage });
  if (err?.type === 'entity.parse.failed' && err.status === 400) {
    return res.status(400).json({ error: 'Некорректный JSON в теле запроса' });
  }
  if (err?.type === 'entity.too.large' && err.status === 413) {
    return res.status(413).json({ error: 'Слишком большое тело запроса' });
  }
  const status = Number(err?.status ?? err?.statusCode);
  if (status >= 400 && status < 500) {
    return res.status(status).json({ error: err.message || 'Некорректный запрос' });
  }
  console.error('Неожиданная ошибка сервера');
  return res.status(status >= 500 ? status : 500).json({ error: 'Внутренняя ошибка сервера' });
}
