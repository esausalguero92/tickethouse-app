'use strict';
/**
 * Party House — Validación centralizada de variables de entorno.
 * Falla en boot si faltan variables críticas (fail-fast pattern).
 * Nunca exponer este módulo al cliente.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const REQUIRED_IN_PROD = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'JWT_SECRET',
  'PAYPAL_CLIENT_ID',
  'PAYPAL_CLIENT_SECRET',
];

const isProd = process.env.NODE_ENV === 'production';

function require_env(key, defaultValue) {
  const val = process.env[key];
  if (val) return val;
  if (defaultValue !== undefined) {
    if (isProd && REQUIRED_IN_PROD.includes(key)) {
      console.error(`[FATAL] Variable de entorno requerida en producción: ${key}`);
      process.exit(1);
    }
    if (defaultValue === '__WARN__') {
      console.warn(`[warn] ${key} no configurado.`);
      return '';
    }
    return defaultValue;
  }
  if (isProd) {
    console.error(`[FATAL] Variable de entorno requerida: ${key}`);
    process.exit(1);
  }
  console.warn(`[warn] ${key} no configurado (dev mode).`);
  return '';
}

const env = {
  NODE_ENV:   process.env.NODE_ENV || 'development',
  PORT:       parseInt(process.env.PORT || '3000', 10),

  // Supabase
  SUPABASE_URL:              require_env('SUPABASE_URL', ''),
  SUPABASE_SERVICE_ROLE_KEY: require_env('SUPABASE_SERVICE_ROLE_KEY', ''),

  // Security
  JWT_SECRET:  require_env('JWT_SECRET', 'dev-insecure-secret-CHANGE-ME'),
  STAFF_PIN:   process.env.STAFF_PIN || '1234',
  N8N_WEBHOOK_SECRET: process.env.N8N_WEBHOOK_SECRET || '',

  // PayPal
  PAYPAL_BASE:          process.env.PAYPAL_BASE || 'https://api-m.sandbox.paypal.com',
  PAYPAL_CLIENT_ID:     require_env('PAYPAL_CLIENT_ID', '__WARN__'),
  PAYPAL_CLIENT_SECRET: require_env('PAYPAL_CLIENT_SECRET', '__WARN__'),

  // Payments / Transfer
  BANK_DETAILS:         process.env.BANK_DETAILS || 'Ver instrucciones de pago',
  TRANSFER_BANK:        process.env.TRANSFER_BANK || '',
  TRANSFER_ACCOUNT:     process.env.TRANSFER_ACCOUNT || '',
  TRANSFER_ACCOUNT_NAME: process.env.TRANSFER_ACCOUNT_NAME || 'Party House',
  RECEIPTS_BUCKET:      process.env.RECEIPTS_BUCKET || 'receipts',
  MAX_UPLOAD_BYTES:     5 * 1024 * 1024,

  // Admin
  ADMIN_PASSWORD_HASH: process.env.ADMIN_PASSWORD_HASH || '',

  // Telegram
  TELEGRAM_BOT_TOKEN:  process.env.TELEGRAM_BOT_TOKEN || '',
  ADMIN_TELEGRAM_IDS:  (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
  TRANSFER_NOTIFY_ID:  process.env.TRANSFER_NOTIFY_ID || '',

  // Email
  SMTP_HOST:   process.env.SMTP_HOST || '',
  SMTP_PORT:   parseInt(process.env.SMTP_PORT || '465', 10),
  SMTP_SECURE: String(process.env.SMTP_SECURE || 'true').toLowerCase() === 'true',
  SMTP_USER:   process.env.SMTP_USER || '',
  SMTP_PASS:   process.env.SMTP_PASS || '',
  get MAIL_FROM() {
    return process.env.MAIL_FROM || (this.SMTP_USER ? `Party House <${this.SMTP_USER}>` : '');
  },

  // Public
  get PUBLIC_BASE_URL() {
    return (process.env.PUBLIC_BASE_URL || `http://localhost:${this.PORT}`).replace(/\/$/, '');
  },

  // Helpers
  get isProd() { return this.NODE_ENV === 'production'; },
  get hasSMTP() { return !!(this.SMTP_HOST && this.SMTP_USER && this.SMTP_PASS); },
  get hasTelegram() { return !!(this.TELEGRAM_BOT_TOKEN); },
  get hasPayPal() { return !!(this.PAYPAL_CLIENT_ID && this.PAYPAL_CLIENT_SECRET); },
};

// Advertencias no-fatales
if (!env.hasSMTP)     console.warn('[warn] SMTP no configurado — no se enviarán emails.');
if (!env.hasTelegram) console.warn('[warn] Telegram no configurado — no se notificará al admin.');
if (!env.hasPayPal)   console.warn('[warn] PayPal no configurado — /api/paypal/* no funcionará.');
if (!env.TRANSFER_NOTIFY_ID && env.ADMIN_TELEGRAM_IDS.length === 0)
  console.warn('[warn] TRANSFER_NOTIFY_ID y ADMIN_TELEGRAM_IDS vacíos — sin notificaciones Telegram.');
if (env.JWT_SECRET === 'dev-insecure-secret-CHANGE-ME' && env.isProd) {
  console.error('[FATAL] JWT_SECRET inseguro en producción. Cambia la variable.');
  process.exit(1);
}

module.exports = env;
