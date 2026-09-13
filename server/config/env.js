'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const REQUIRED_IN_PROD = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'JWT_SECRET',
  'RECURRENTE_SECRET_KEY',
  'RECURRENTE_WEBHOOK_SECRET',
];

const isProd = process.env.NODE_ENV === 'production';

function require_env(key, defaultValue) {
  const val = process.env[key];
  if (val) return val;
  if (defaultValue !== undefined) {
    if (isProd && REQUIRED_IN_PROD.includes(key)) {
      console.error('[FATAL] Variable requerida en produccion: ' + key);
      process.exit(1);
    }
    if (defaultValue === '__WARN__') {
      console.warn('[warn] ' + key + ' no configurado.');
      return '';
    }
    return defaultValue;
  }
  if (isProd) {
    console.error('[FATAL] Variable requerida: ' + key);
    process.exit(1);
  }
  console.warn('[warn] ' + key + ' no configurado (dev mode).');
  return '';
}

const env = {
  NODE_ENV:   process.env.NODE_ENV || 'development',
  PORT:       parseInt(process.env.PORT || '3000', 10),

  SUPABASE_URL:              require_env('SUPABASE_URL', ''),
  SUPABASE_SERVICE_ROLE_KEY: require_env('SUPABASE_SERVICE_ROLE_KEY', ''),

  JWT_SECRET:         require_env('JWT_SECRET', 'dev-insecure-secret-CHANGE-ME'),
  STAFF_PIN:          process.env.STAFF_PIN || '1234',
  N8N_WEBHOOK_SECRET: process.env.N8N_WEBHOOK_SECRET || '',

  // Recurrente — gateway de pago (Guatemala)
  // NUNCA exponer estas claves al frontend.
  RECURRENTE_SECRET_KEY:    require_env('RECURRENTE_SECRET_KEY', '__WARN__'),
  RECURRENTE_WEBHOOK_SECRET: require_env('RECURRENTE_WEBHOOK_SECRET', '__WARN__'),

  ADMIN_PASSWORD_HASH: process.env.ADMIN_PASSWORD_HASH || '',

  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  ADMIN_TELEGRAM_IDS: (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(function(s) { return s.trim(); }).filter(Boolean),
  ORDER_NOTIFY_ID:    process.env.ORDER_NOTIFY_ID || process.env.TRANSFER_NOTIFY_ID || '',

  SMTP_HOST:   process.env.SMTP_HOST || '',
  SMTP_PORT:   parseInt(process.env.SMTP_PORT || '465', 10),
  SMTP_SECURE: String(process.env.SMTP_SECURE || 'true').toLowerCase() === 'true',
  SMTP_USER:   process.env.SMTP_USER || '',
  SMTP_PASS:   process.env.SMTP_PASS || '',
  get MAIL_FROM() {
    return process.env.MAIL_FROM || (this.SMTP_USER ? 'TicketHouse <' + this.SMTP_USER + '>' : '');
  },

  CORS_ORIGINS: process.env.CORS_ORIGINS || '',

  get PUBLIC_BASE_URL() {
    return (process.env.PUBLIC_BASE_URL || ('http://localhost:' + this.PORT)).replace(/\/$/, '');
  },

  get isProd()        { return this.NODE_ENV === 'production'; },
  get hasSMTP()       { return !!(this.SMTP_HOST && this.SMTP_USER && this.SMTP_PASS); },
  get hasTelegram()   { return !!(this.TELEGRAM_BOT_TOKEN); },
  get hasRecurrente() { return !!(this.RECURRENTE_SECRET_KEY && this.RECURRENTE_WEBHOOK_SECRET); },
};

if (!env.hasSMTP)       console.warn('[warn] SMTP no configurado.');
if (!env.hasTelegram)   console.warn('[warn] Telegram no configurado.');
if (!env.hasRecurrente) console.warn('[warn] Recurrente no configurado — pagos deshabilitados.');
if (!env.ORDER_NOTIFY_ID && env.ADMIN_TELEGRAM_IDS.length === 0)
  console.warn('[warn] Sin notificaciones Telegram configuradas.');
if (env.JWT_SECRET === 'dev-insecure-secret-CHANGE-ME' && env.isProd) {
  console.error('[FATAL] JWT_SECRET inseguro en produccion. Cambia la variable.');
  process.exit(1);
}

module.exports = env;
