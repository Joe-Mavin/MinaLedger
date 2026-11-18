export class AppError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  const pgCode = error.original?.code ?? error.parent?.code;
  const databaseErrors = {
    '23502': [400, 'INVALID_INPUT', 'A required value is missing.'],
    '23503': [400, 'INVALID_RELATIONSHIP', 'A referenced record is unavailable.'],
    '23505': [409, 'DUPLICATE_RECORD', 'A record with those unique values already exists.'],
    '23514': [400, 'INVALID_STATE', 'The requested change violates a data-integrity rule.'],
    '22P02': [400, 'INVALID_INPUT', 'A supplied value has an invalid format.'],
    '40001': [409, 'CONCURRENT_CONFLICT', 'The record changed concurrently; retry with current data.'],
    '40P01': [409, 'CONCURRENT_CONFLICT', 'The operation conflicted with another database transaction.'],
    '55000': [409, 'IMMUTABLE_RECORD', 'This record is append-only and cannot be rewritten.'],
  };
  const mapped = databaseErrors[pgCode];
  const status = Number.isInteger(error.status) ? error.status : (mapped?.[0] ?? 500);
  const code = error.code ?? mapped?.[1] ?? 'INTERNAL_ERROR';
  if (status >= 500) req.log?.error({ errorName: error.name, errorCode: error.original?.code ?? error.code, requestId: req.id }, 'request failed');
  else req.log?.warn({ code, requestId: req.id }, 'request rejected');
  return res.status(status).json({
    error: {
      code,
      message: status >= 500 ? 'The request could not be completed.' : (error.status ? error.message : mapped?.[2] ?? error.message),
      ...(error.details ? { details: error.details } : {}),
      requestId: req.id,
    },
  });
}

export function validateBody(schema) {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return next(new AppError(400, 'INVALID_INPUT', 'Request body is invalid.', parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message }))));
    }
    req.body = parsed.data;
    return next();
  };
}
