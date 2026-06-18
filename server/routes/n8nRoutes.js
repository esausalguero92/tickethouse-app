'use strict';
/**
 * Rutas para integracion N8N.
 * Autenticadas con x-n8n-secret (env.N8N_WEBHOOK_SECRET).
 *
 * POST /api/n8n/complimentary-ticket
 *   Crea orden complimentary y emite el ticket para un invitado especial.
 *   N8N llama esto despues de insertar el guest y el access_code en Supabase.
 */

const { Router } = require('express');
const crypto = require('crypto');
const { getSupabase } = require('../db/supabase');
const { asyncHandler } = require('../middleware/errorHandler');
const { issueTickets } = require('../services/TicketService');
const env = require('../config/env');

const router = Router();

// Middleware: verificar secreto N8N
function requireN8nSecret(req, res, next) {
  const secret = req.header('x-n8n-secret') || req.header('authorization') || '';
  const expected = env.N8N_WEBHOOK_SECRET;
  if (!expected) {
    console.warn('[n8n] N8N_WEBHOOK_SECRET no configurado — ruta deshabilitada.');
    return res.status(503).json({ error: 'n8n_not_configured' });
  }
  const clean = secret.replace(/^Bearer\s+/i, '').trim();
  // Usar timingSafeEqual para evitar timing attacks
  const a = Buffer.from(clean);
  const b = Buffer.from(expected);
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!match) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// ── POST /api/n8n/complimentary-ticket ───────────────────────────
router.post('/complimentary-ticket',
  requireN8nSecret,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();

    // Aceptar code como campo principal (o alias comunes que N8N puede enviar)
    const code = String(
      req.body.code || req.body.codigo || req.body.access_code || ''
    ).trim().toUpperCase();

    if (!code) {
      return res.status(400).json({ error: 'code_required', message: 'Falta el campo "code".' });
    }

    // 1. Validar el código en access_codes
    const { data: codeData, error: codeErr } = await supabase.rpc('rpc_validate_code', { p_code: code });
    if (codeErr) {
      console.error('[n8n/complimentary-ticket] rpc_validate_code:', codeErr);
      return res.status(500).json({ error: 'db_error' });
    }
    if (!codeData || codeData.error) {
      return res.status(404).json({ error: 'code_invalid', message: 'Codigo no encontrado o inactivo.' });
    }

    const { code_id, event, guest, has_ticket } = codeData;

    // 2. Si el ticket ya fue emitido, devolver info sin re-emitir
    if (has_ticket) {
      const { data: order } = await supabase
        .from('orders')
        .select('id')
        .eq('code_id', code_id)
        .maybeSingle();
      console.log('[n8n/complimentary-ticket] Ticket ya existe para codigo', code);
      return res.json({
        ok: true,
        skipped: true,
        reason: 'already_issued',
        order_id: order && order.id || null,
      });
    }

    // 3. Crear orden complimentary
    const { data: rpcData, error: rpcErr } = await supabase.rpc('rpc_create_complimentary_order', { p_code: code });
    if (rpcErr || !rpcData || rpcData.error) {
      console.error('[n8n/complimentary-ticket] rpc_create_complimentary_order:', rpcErr || rpcData);
      return res.status(500).json({ error: (rpcData && rpcData.error) || 'order_failed' });
    }

    // 4. Emitir ticket + PDF + email
    const guestName = [guest && guest.first_name, guest && guest.last_name].filter(Boolean).join(' ') || 'Invitado/a';
    const result = await issueTickets({
      orderId:    rpcData.order_id,
      eventId:    event && event.id,
      buyerId:    null,
      buyerName:  guestName,
      buyerEmail: guest && guest.email || null,
      quantity:   1,
      eventName:  event && event.name       || 'Party House',
      eventDate:  event && event.event_date || null,
      eventVenue: event && event.venue      || '',
    });

    console.log('[n8n/complimentary-ticket] Ticket emitido:', result.correlativeCodes, 'para', guestName);

    return res.json({
      ok:           true,
      code:             code,
      guest_name:       guestName,
      correlative_codes: result.correlativeCodes,
      download_token:   result.downloadToken,
    });
  })
);

module.exports = router;
