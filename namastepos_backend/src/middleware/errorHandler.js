// NamastePOS backend - global error handler

const logger = require('../config/logger');
const env = require('../config/env');
const { HttpError } = require('../utils/errors');

// 404 handler must be registered *after* all routes
function notFound(_req, _res, next) {
  next(new (require('../utils/errors').NotFound)('Route not found'));
}

function errorHandler(err, req, res, _next) {
  // Known typed error
  if (err instanceof HttpError) {
    const body = { error: err.code, message: err.message };
    if (err.details) body.details = err.details;
    return res.status(err.statusCode).json(body);
  }

  // pg unique violation
  if (err && err.code === '23505') {
    // S13 (security 2026-08-23): don't echo pg's err.detail to clients —
    // it leaks column values (e.g. "Key (email)=(x) already exists").
    return res.status(409).json({
      error: 'CONFLICT',
      message: 'Duplicate value',
      ...(env.isProd() ? {} : { details: err.detail }),
    });
  }

  // pg foreign-key violation
  if (err && err.code === '23503') {
    return res.status(400).json({
      error: 'FK_VIOLATION',
      message: 'Referenced row does not exist',
    });
  }

  // Unknown
  logger.error('Unhandled error', {
    err: err.message, stack: err.stack, path: req.path,
  });
  const body = { error: 'INTERNAL_ERROR', message: 'Something went wrong' };
  if (!env.isProd()) {
    // Push 15i — surface the real underlying error in non-prod so the
    // dashboard can show a useful message instead of "Something went
    // wrong". Without this, callers had no way to diagnose 500s without
    // server console access.
    body.message = err.message || 'Something went wrong';
    body.code = err.code || undefined;
    body.detail = err.detail || undefined;
    body.stack = err.stack;
  }
  return res.status(500).json(body);
}

module.exports = { notFound, errorHandler };
