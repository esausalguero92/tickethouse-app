'use strict';
const env = require('../config/env');

/**
 * Error handler centralizado.
 * - Nunca expone stack traces en producción.
 * - Loguea con contexto (path, method, ip).
 */
function errorHandler(err, req, res, _next) {
  const status = err.status || err.statusCode || 500;
  const isProd = env.isProd;

  // Log estructurado
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'error',
    method: req.method,
    path: req.path,
    ip: req.ip,
    status,
    message: err.message,
    ...(isProd ? {} : { stack: err.stack }),
  }));

  // Multer file size
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'file_too_large', message: 'El archivo supera el límite de 5MB.' });
  }
  if (err.message === 'file_type_not_allowed') {
    return res.status(415).json({ error: 'file_type_not_allowed', message: 'Tipo de archivo no permitido.' });
  }

  // Response
  res.status(status).json({
    error: err.code || 'internal_error',
    message: isProd ? 'Error interno del servidor.' : (err.message || 'Error desconocido.'),
  });
}

/**
 * 404 handler — debe ir antes de errorHandler.
 */
function notFoundHandler(req, res) {
  res.status(404).json({ error: 'not_found', path: req.path });
}

/**
 * Wrapper async para rutas — elimina try/catch repetitivo.
 */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { errorHandler, notFoundHandler, asyncHandler };
