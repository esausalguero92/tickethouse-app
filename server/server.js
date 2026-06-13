'use strict';
/**
 * Party House — Server v2.0.0
 * Entry point: carga config, aplica middleware y monta rutas.
 *
 * Arquitectura:
 *   config/env.js       → validación de variables de entorno
 *   db/supabase.js      → cliente Supabase (singleton)
 *   middleware/         → security, auth, errorHandler
 *   services/           → Ticket, Pdf, Qr, Email, Telegram
 *   routes/             → public, payment, admin, staff, download
 */

const env = require('./config/env');  // valida vars en boot (puede process.exit)

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

const app = express();

// ── Security middleware (orden importa) ─────────────────────────────
app.set('trust proxy', 1);                   // para req.ip correcto detrás de nginx/easypanel
app.use(helmetMiddleware);
app.use(cors({ origin: true, credentials: false }));
app.use(globalLimiter);
app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: false, limit: '512kb' }));
app.use(sanitizeInputs);

// ── Static (landing) ────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'landing')));

// ── API Routes ──────────────────────────────────────────────────────
app.use('/api', publicRoutes);
app.use('/api', paymentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api', staffRoutes);
app.use('/api/download', downloadRoutes);

// ── 404 + Error handler ─────────────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

// ── Boot ─────────────────────────────────────────────────────────────
app.listen(env.PORT, '0.0.0.0', () => {
  console.log(`[boot] Party House server v2.0.0 — p