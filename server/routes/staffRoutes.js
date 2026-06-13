'use strict';
/**
 * Party House — Rutas Staff (validador en puerta)
 *
 * POST /api/staff/login
 * POST /api/tickets/validate       — validar por JWT token (del QR)
 * POST /api/tickets/validate-code  — validar por correlativo manual (TH-PH001)
 *
 * Respuestas:
 *   200 → ticket válido (y lo marca como usado)
 *   409 → ticket ya usado
 *   404 → no encontrado / inválido
 *   401 → token JWT inválido o expirado
 */

const { Router } = require('express');
const { body } = require('express-validator');
const jwt = require('jsonwebtoken');
const { getSupabase } = require('../db/supabase');
const { requireStaff, verifyJwt } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { validateRequest, authLimiter } = require('../middleware/security');
const env = require('../config/env');

const router = Router();

// ── Helper: registrar validación ──────────────────────────────────
async function logValidation(supabase, { ticketId, qrScanned, result, ip }) {
  await supabase.from('validation_log').insert({
    ticket_id:  ticketId || null,
    qr_scanned: (qrScanned || '').substring(0, 500),
    result,
    ip_address: ip || null,
  }).catch(() => {}); // non-critical
}

// ── Helper: respuesta de error estandarizada ──────────────────────
function ticketError(res, { status, error, correlativeCode, buyerName, meta }) {
  return res.status(status).json({
    error,
    correlative_code: correlativeCode || null,
    buyer_name:       buyerName || null,
    message:          meta || null,
  });
}

// ══════════════════════════════════════════════════════════════════
// POST /api/staff/login
// Body: { pin }
// ══════════════════════════════════════════════════════════════════
router.post('/staff/login',
  authLimiter,
  body('pin').trim().isLength({ min: 4, max: 10 }).withMessage('PIN inválido'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { pin, user } = req.body;

    if (String(pin).trim() !== String(env.STAFF_PIN).trim()) {
      return res.status(401).json({ error: 'credenciales_invalidas' });
    }

    // Evento próximo (contexto para el validador)
    let event = null;
    try {
      const supabase = getSupabase();
      const { data } = await supabase
        .from('events')
        .select('id, name, event_date')
        .eq('active', true)
        .order('event_date', { ascending: true })
        .limit(1)
        .maybeSingle();
      event = data;
    } catch { /* non-critical */ }

    const staffName = (user && String(user).trim()) ? String(user).trim() : 'Staff';
    const token = jwt.sign(
      { sid: staffName, role: 'staff', name: staffName },
      env.JWT_SECRET,
      { expiresIn: '12h', algorithm: 'HS256' }
    );

    return res.json({ ok: true, token, name: staffName, event: event || null });
  })
);

// ══════════════════════════════════════════════════════════════════
// POST /api/tickets/validate — validar JWT del QR
// Body: { token }  ← campo "token", no "qr"
// Header: x-staff-token
// ══════════════════════════════════════════════════════════════════
router.post('/tickets/validate',
  requireStaff,
  body('token').trim().isLength({ min: 10, max: 2000 }).withMessage('token requerido'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const tokenInput = req.body.token.trim();
    const ip = (req.ip || '').replace('::ffff:', '');

    // 1. Verificar firma JWT
    let payload;
    try {
      payload = verifyJwt(tokenInput);
    } catch {
      payload = null;
    }

    if (!payload) {
      await logValidation(supabase, { qrScanned: tokenInput, result: 'invalid', ip });
      return ticketError(res, { status: 401, error: 'token_invalid', meta: 'Firma JWT inválida o token expirado' });
    }

    // 2. Verificar tipo del token
    if (payload.t !== 'ph.ticket.v2' && payload.t !== 'ph.ticket') {
      await logValidation(supabase, { qrScanned: tokenInput, result: 'invalid', ip });
      return ticketError(res, { status: 401, error: 'token_invalid', meta: 'Tipo de token incorrecto' });
    }

    // 3. Buscar ticket por qr_token (buyer info viene de orders, no de tickets)
    const { data: ticket, error: tErr } = await supabase
      .from('tickets')
      .select(`
        id, correlative_code, status, redeemed_at,
        order:orders(buyer_name, buyer_email),
        event:events(id, name, event_date)
      `)
      .eq('qr_token', tokenInput)
      .maybeSingle();

    if (!tErr && ticket) {
      ticket.buyer_name  = ticket.order?.buyer_name  || null;
      ticket.buyer_email = ticket.order?.buyer_email || null;
    }

    if (tErr || !ticket) {
      await logValidation(supabase, { qrScanned: tokenInput, result: 'not_found', ip });
      return ticketError(res, { status: 404, error: 'ticket_not_found', meta: 'Entrada no encontrada en la base de datos' });
    }

    // 4. ¿Ya fue usado?
    if (ticket.status === 'redeemed') {
      await logValidation(supabase, { ticketId: ticket.id, qrScanned: tokenInput, result: 'already_used', ip });
      return ticketError(res, {
        status: 409,
        error: 'ticket_already_used',
        correlativeCode: ticket.correlative_code,
        buyerName: ticket.buyer_name,
        meta: ticket.redeemed_at,
      });
    }

    // 5. ¿Revocado?
    if (ticket.status === 'revoked') {
      await logValidation(supabase, { ticketId: ticket.id, qrScanned: tokenInput, result: 'revoked', ip });
      return ticketError(res, { status: 410, error: 'ticket_revoked', correlativeCode: ticket.correlative_code });
    }

    // 6. Marcar como usado (atómico: solo si NO está ya redimido)
    // Los tickets se crean con status 'issued'; pueden activarse a 'valid' opcionalmente.
    const { data: updated, error: updErr } = await supabase
      .from('tickets')
      .update({ status: 'redeemed', redeemed_at: new Date().toISOString() })
      .eq('id', ticket.id)
      .in('status', ['issued', 'valid']) // guard race condition
      .select('id')
      .maybeSingle();

    if (updErr || !updated) {
      // Alguien más lo validó al mismo tiempo
      await logValidation(supabase, { ticketId: ticket.id, qrScanned: tokenInput, result: 'already_used', ip });
      return ticketError(res, {
        status: 409,
        error: 'ticket_already_used',
        correlativeCode: ticket.correlative_code,
        buyerName: ticket.buyer_name,
        meta: 'Validado concurrentemente',
      });
    }

    await logValidation(supabase, { ticketId: ticket.id, qrScanned: tokenInput, result: 'valid', ip });

    return res.json({
      ok: true,
      correlative_code: ticket.correlative_code,
      buyer_name:       ticket.buyer_name,
      event_name:       ticket.event?.name || null,
      event_date:       ticket.event?.event_date || null,
    });
  })
);

// ══════════════════════════════════════════════════════════════════
// POST /api/tickets/validate-code — correlativo manual
// Body: { correlative_code }  ← campo "correlative_code", no "code"
// Header: x-staff-token
// ══════════════════════════════════════════════════════════════════
router.post('/tickets/validate-code',
  requireStaff,
  body('correlative_code').trim().isLength({ min: 3, max: 20 }).withMessage('Código requerido'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const correlative = req.body.correlative_code.toUpperCase().trim();
    const ip = (req.ip || '').replace('::ffff:', '');

    // Intentar via RPC si existe
    try {
      const { data: rpcData } = await supabase.rpc('rpc_validate_by_correlative', {
        p_correlative: correlative,
      });
      if (rpcData) {
        // El RPC devuelve { result: 'valid'|'not_found'|'already_used'|'revoked'|'invalid' }
        if (rpcData.result === 'not_found' || rpcData.result === 'invalid') {
          return ticketError(res, { status: 404, error: 'ticket_not_found', meta: 'Código no encontrado' });
        }
        if (rpcData.result === 'already_used') {
          return ticketError(res, {
            status: 409,
            error: 'ticket_already_used',
            correlativeCode: rpcData.correlative || correlative,
            buyerName: rpcData.buyer_name || null,
            meta: rpcData.redeemed_at || null,
          });
        }
        if (rpcData.result === 'revoked') {
          return ticketError(res, { status: 410, error: 'ticket_revoked', correlativeCode: correlative });
        }
        if (rpcData.result === 'valid') {
          return res.json({
            ok: true,
            correlative_code: rpcData.correlative || correlative,
            buyer_name:       rpcData.buyer_name,
            event_name:       rpcData.event_name,
          });
        }
      }
    } catch { /* fallback directo */ }

    // Fallback: buscar directo en tabla (buyer info viene de orders)
    const { data: ticket, error: tErr } = await supabase
      .from('tickets')
      .select(`id, correlative_code, status, redeemed_at, order:orders(buyer_name), event:events(name)`)
      .eq('correlative_code', correlative)
      .maybeSingle();

    if (tErr || !ticket) {
      await logValidation(supabase, { qrScanned: correlative, result: 'not_found', ip });
      return ticketError(res, { status: 404, error: 'ticket_not_found', meta: 'Código no encontrado' });
    }

    const buyerName = ticket.order?.buyer_name || null;

    if (ticket.status === 'redeemed') {
      await logValidation(supabase, { ticketId: ticket.id, qrScanned: correlative, result: 'already_used', ip });
      return ticketError(res, {
        status: 409,
        error: 'ticket_already_used',
        correlativeCode: ticket.correlative_code,
        buyerName,
        meta: ticket.redeemed_at,
      });
    }

    if (ticket.status === 'revoked') {
      return ticketError(res, { status: 410, error: 'ticket_revoked', correlativeCode: ticket.correlative_code });
    }

    const { data: updated, error: updErr } = await supabase
      .from('tickets')
      .update({ status: 'redeemed', redeemed_at: new Date().toISOString() })
      .eq('id', ticket.id)
      .in('status', ['issued', 'valid']) // guard race condition
      .select('id')
      .maybeSingle();

    if (updErr || !updated) {
      return ticketError(res, {
        status: 409,
        error: 'ticket_already_used',
        correlativeCode: ticket.correlative_code,
        buyerName,
      });
    }

    await logValidation(supabase, { ticketId: ticket.id, qrScanned: correlative, result: 'valid', ip });

    return res.json({
      ok: true,
      correlative_code: ticket.correlative_code,
      buyer_name:       buyerName,
      event_name:       ticket.event?.name || null,
    });
  })
);

module.exports = router;
