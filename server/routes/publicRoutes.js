'use strict';
/**
 * Rutas públicas (sin autenticación).
 * GET /api/event/:code     → Info del evento por código general (PH787)
 * GET /api/public-config   → PayPal client_id, moneda
 * GET /api/transfer/info   → Datos bancarios para transferencia
 * GET /api/health          → Health check
 */

const { Router } = require('express');
const { param } = require('express-validator');
const { getSupabase } = require('../db/supabase');
const { asyncHandler } = require('../middleware/errorHandler');
const { validateRequest } = require('../middleware/security');
const env = require('../config/env');

const router = Router();

// ── GET /api/event/:code ──────────────────────────────────────────
router.get('/event/:code',
  param('code').trim().isLength({ min: 2, max: 20 }).matches(/^[A-Z0-9a-z-]+$/),
  validateRequest,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const code = req.params.code.toUpperCase().trim();

    const { data, error } = await supabase.rpc('rpc_get_event_by_code', { p_code: code });

    if (error) {
      console.error('[publicRoutes.event]', error);
      return res.status(500).json({ error: 'db_error' });
    }
    if (data?.error) {
      const statusMap = {
        code_required: 400,
        code_not_found: 404,
        event_not_available: 410,
      };
      return res.status(statusMap[data.error] || 400).json({ error: data.error });
    }

    return res.json(data);
  })
);

// ── GET /api/public-config ────────────────────────────────────────
router.get('/public-config', (_, res) => {
  res.json({
    paypal_client_id: env.PAYPAL_CLIENT_ID || '',
    paypalClientId:   env.PAYPAL_CLIENT_ID || '',
    paypal_currency:  'USD',
  });
});

// ── GET /api/transfer/info ────────────────────────────────────────
// Devuelve campos individuales que evento.html muestra al comprador
router.get('/transfer/info', (_, res) => {
  // Soporte para BANK_DETAILS legacy "Banco · Cuenta"
  const raw = env.BANK_DETAILS || '';
  const parts = raw.split('·').map(s => s.trim());

  res.json({
    bank:         env.TRANSFER_BANK         || parts[0] || 'Consulta al organizador',
    account:      env.TRANSFER_ACCOUNT      || parts[1] || '—',
    name:         env.TRANSFER_ACCOUNT_NAME || 'Party House',
    concept:      'Party House — Entrada',
    bank_details: raw,
  });
});

// ── GET /api/health ───────────────────────────────────────────────
router.get('/health', (_, res) => {
  res.json({
    ok:      true,
    version: '2.0.0',
    env:     env.isProd ? 'production' : 'development',
    ts:      new Date().toISOString(),
  });
});

module.exports = router;
