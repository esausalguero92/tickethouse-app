'use strict';

const env = require('./config/env');

const express = require('express');
const cors    = require('cors');
const path    = require('path');

const { helmetMiddleware, globalLimiter, sanitizeInputs } = require('./middleware/security');
const { errorHandler, notFoundHandler }                   = require('./middleware/errorHandler');

const publicRoutes   = require('./routes/publicRoutes');
const paymentRoutes  = require('./routes/paymentRoutes');
const adminRoutes    = require('./routes/adminRoutes');
const staffRoutes    = require('./routes/staffRoutes');
const downloadRoutes = require('./routes/downloadRoutes');
const n8nRoutes      = require('./routes/n8nRoutes');
const discountRoutes = require('./routes/discountRoutes');
const pdfRoutes      = require('./routes/pdfRoutes');
// Dev-only routes (never loaded in production)
const devRoutes = env.isProd ? null : require('./routes/devRoutes');

const app = express();

app.set('trust proxy', 1);
app.use(helmetMiddleware);

const allowedOrigins = (env.isProd && env.CORS_ORIGINS)
  ? env.CORS_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
  : [];
app.use(cors({
  origin: allowedOrigins.length > 0
    ? function(origin, cb) {
        if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
        cb(new Error('CORS: origen no permitido'));
      }
    : true,
  credentials: false,
}));

app.use(globalLimiter);

// ── Webhook de Recurrente: necesita body crudo (Buffer) para verificar firma Svix ──
// express.raw() no setea req._body = true de forma confiable, por lo que express.json()
// (montado globalmente abajo) lo re-parsea y destruye el Buffer que Svix necesita.
// Solución: leer el stream manualmente y setear req._body = true explícitamente.
app.use('/api/webhooks/recurrente', function(req, res, next) {
  var chunks = [];
  req.on('data', function(chunk) { chunks.push(chunk); });
  req.on('end', function() {
    req.body  = Buffer.concat(chunks);
    req._body = true; // bloquea express.json() para que no re-parsee este body
    next();
  });
  req.on('error', next);
});

app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: false, limit: '512kb' }));
app.use(sanitizeInputs);

app.use(express.static(path.join(__dirname, '..', 'landing')));

app.use('/api', publicRoutes);
app.use('/api', paymentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api', staffRoutes);
app.use('/api/download', downloadRoutes);
app.use('/api/n8n', n8nRoutes);
app.use('/api', discountRoutes);
app.use('/pdf', pdfRoutes);

// Dev-only: simular webhook de Recurrente sin tunnel
if (devRoutes) {
  app.use('/api/dev', devRoutes);
  console.log('[dev] Rutas de desarrollo habilitadas en /api/dev/*');
}

app.use(notFoundHandler);
app.use(errorHandler);

app.listen(env.PORT, '0.0.0.0', () => {
  console.log('[boot] TicketHouseV2 server v3.0.0 - port ' + env.PORT + ' - ' + env.NODE_ENV);
});

module.exports = app;
