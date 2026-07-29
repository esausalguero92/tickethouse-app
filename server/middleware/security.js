'use strict';

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { validationResult } = require('express-validator');
const env = require('../config/env');

const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'", "'unsafe-inline'",
        'https://www.paypal.com', 'https://*.paypal.com',
        'https://www.sandbox.paypal.com', 'https://*.sandbox.paypal.com',
        'https://www.paypalobjects.com',
        'https://fonts.googleapis.com', 'https://cdn.jsdelivr.net',
        'https://cdnjs.cloudflare.com',
        'https://www.googletagmanager.com',
      ],
      scriptSrcElem: [
        "'self'", "'unsafe-inline'",
        'https://www.paypal.com', 'https://*.paypal.com',
        'https://www.sandbox.paypal.com', 'https://*.sandbox.paypal.com',
        'https://www.paypalobjects.com',
        'https://fonts.googleapis.com', 'https://cdn.jsdelivr.net',
        'https://cdnjs.cloudflare.com',
        'https://www.googletagmanager.com',
      ],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https:', 'https://*.google-analytics.com', 'https://www.googletagmanager.com'],
      connectSrc: [
        "'self'",
        'https://api-m.paypal.com', 'https://api-m.sandbox.paypal.com',
        'https://*.paypal.com', 'https://*.sandbox.paypal.com',
        env.SUPABASE_URL || '',
        'https://*.google-analytics.com',
        'https://*.analytics.google.com',
        'https://www.googletagmanager.com',
      ],
      frameSrc: [
        'https://www.paypal.com', 'https://www.sandbox.paypal.com',
        'https://*.paypal.com', 'https://*.sandbox.paypal.com',
      ],
      objectSrc: ["'none'"],
      scriptSrcAttr: ["'unsafe-inline'"],
    },
  },
  hsts: env.NODE_ENV === 'production' ? { maxAge: 31536000, includeSubDomains: true } : false,
});

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests', message: 'Demasiadas solicitudes. Intenta mas tarde.' },
});

const paymentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 8,
  message: { error: 'payment_rate_limit', message: 'Demasiados intentos de pago.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'auth_rate_limit', message: 'Demasiados intentos de autenticacion.' },
});

const purchaseLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'purchase_rate_limit', message: 'Demasiados intentos de compra.' },
});

const downloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'download_rate_limit', message: 'Demasiadas descargas. Intenta en un momento.' },
});

function sanitizeString(val) {
  if (typeof val !== 'string') return val;
  return val
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;')
    .trim();
}

// Campos que NO se sanitizan: van a bcrypt/JWT, no a HTML ni queries SQL
const SKIP_SANITIZE_KEYS = new Set(['password', 'password_hash', 'pass', 'pwd', 'pin', 'secret']);

function deepSanitize(obj, parentKey) {
  if (typeof obj === 'string') return sanitizeString(obj);
  if (Array.isArray(obj)) return obj.map(function(item) { return deepSanitize(item, parentKey); });
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = SKIP_SANITIZE_KEYS.has(k.toLowerCase()) ? v : deepSanitize(v, k);
    }
    return out;
  }
  return obj;
}

function sanitizeInputs(req, _res, next) {
  if (req.body && typeof req.body === 'object') req.body = deepSanitize(req.body);
  if (req.query && typeof req.query === 'object') req.query = deepSanitize(req.query);
  next();
}

function validateRequest(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: 'validation_error',
      details: errors.array().map(function(e) { return { field: e.path, message: e.msg }; }),
    });
  }
  next();
}

module.exports = {
  helmetMiddleware,
  globalLimiter,
  paymentLimiter,
  authLimiter,
  purchaseLimiter,
  downloadLimiter,
  sanitizeInputs,
  validateRequest,
};
