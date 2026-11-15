export function validate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.length > 0 ? issue.path.join('.') : source,
        message: issue.message,
      }));
      return res.status(400).json({
        error: details[0]?.message || 'Request validation failed',
        details,
      });
    }
    req[source] = result.data;
    next();
  };
}
