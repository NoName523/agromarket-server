import jwt from 'jsonwebtoken';

const jwtSecret = process.env.JWT_SECRET;

if (!jwtSecret || jwtSecret.length < 32 || jwtSecret.startsWith('replace-with-')) {
  throw new Error('JWT_SECRET (at least 32 characters) is required');
}

export function requireAuth(req, res, next) {
  const authorization = req.get('authorization');
  const match = typeof authorization === 'string'
    ? /^Bearer ([^\s]+)$/i.exec(authorization)
    : null;
  if (!match) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }

  let payload;
  try {
    payload = jwt.verify(match[1], jwtSecret, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: 'Недействительный токен' });
  }

  const id = typeof payload === 'object' && payload !== null &&
    typeof payload.sub === 'string' ? Number(payload.sub) : NaN;
  if (!Number.isInteger(id) || id < 1 || id > 2147483647 ||
      !['user', 'admin'].includes(payload.role)) {
    return res.status(401).json({ error: 'Недействительный токен' });
  }
  req.user = { id, role: payload.role };
  next();
}

// Anonymous orders remain possible; a supplied invalid token is never ignored.
export function optionalAuth(req, res, next) {
  if (req.headers.authorization === undefined) return next();
  return requireAuth(req, res, next);
}

export function requireRole(role) {
  return (req, res, next) => {
    if (req.user?.role !== role) {
      return res.status(403).json({ error: 'Недостаточно прав' });
    }
    next();
  };
}
