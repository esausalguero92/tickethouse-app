'use strict';

const { Router } = require('express');
const { body } = require('express-validator');
const jwt = require('jsonwebtoken');
const { getSupabase } = require('../db/supabase');
const { requireStaff, verifyJwt } = require('../middleware/auth');
const { verifyToken: verifyQrToken } = require('../services/QrService');
const { asyncHandler } = require('../middleware/errorHandler');
const { validateRequest, authLimiter } = require('../middleware/security');
const env = require('../config/env');

const router = Router();

// Patrones de códigos de ticket válidos:
//   Legacy:  TH-PH001   (correlativo secuencial)
//   Nuevo:   TH-BLG-482719 (prefijo de evento + 6 dígitos criptográficos)
const LEGACY_CODE_RE = /^TH-PH\d+$/;
const NEW_CODE_RE    = /^TH-[A-Z]{2,4}-\d{6}$/;

function isValidTicketCode(code) {
  return LEGACY_CODE_RE.test(code) || NEW_CODE_RE.test(code);
}

async function logValidation(supabase, params) {
  const { ticketId, qrScanned, result, ip } = params;
  try {
    await supabase.from('validation_log').insert({
      ticket_id:  ticketId || null,
      qr_scanned: (qrScanned || '').substring(0, 500),
      result,
      ip_address: ip || null,
    });
  } catch (_) {}
}

function ticketError(res, params) {
  const { status, error, correlativeCode, publicCode, buyerName, meta } = params;
  return res.status(status).json({
    error,
    correlative_code: correlativeCode || null,
    public_code:      publicCode      || null,
    buyer_name:       buyerName       || null,
    message:          meta            || null,
  });
}

router.post('/staff/login',
  authLimiter,
  body('pin').trim().isLength({ min: 4, max: 10 }).withMessage('PIN invalido'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const { pin, user } = req.body;
    if (String(pin).trim() !== String(env.STAFF_PIN).trim()) {
      return res.status(401).json({ error: 'credenciales_invalidas' });
    }

    let event = null;
    try {
      const supabase = getSupabase();
      const { data } = await supabase
        .from('events').select('id, name, event_date')
        .eq('active', true).order('event_date', { ascending: true }).limit(1).maybeSingle();
      event = data;
    } catch (e) {}

    const staffName = (user && String(user).trim()) ? String(user).trim() : 'Staff';
    const token = jwt.sign(
      { sid: staffName, role: 'staff', name: staffName },
      env.JWT_SECRET,
      { expiresIn: '12h', algorithm: 'HS256' }
    );

    return res.json({ ok: true, token, name: staffName, event: event || null });
  })
);

router.post('/tickets/validate',
  requireStaff,
  body('token').trim().isLength({ min: 10, max: 2000 }).withMessage('token requerido'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const tokenInput = req.body.token.trim();
    const ip = (req.ip || '').replace('::ffff:', '');

    let payload;
    payload = verifyQrToken(tokenInput);

    if (!payload) {
      await logValidation(supabase, { qrScanned: tokenInput, result: 'invalid', ip });
      return ticketError(res, { status: 401, error: 'token_invalid', meta: 'Firma JWT invalida o token expirado' });
    }

    if (payload.t !== 'ph.ticket.v2' && payload.t !== 'ph.ticket') {
      await logValidation(supabase, { qrScanned: tokenInput, result: 'invalid', ip });
      return ticketError(res, { status: 401, error: 'token_invalid', meta: 'Tipo de token incorrecto' });
    }

    const { data: ticket, error: tErr } = await supabase
      .from('tickets')
      .select('id, correlative_code, public_code, status, redeemed_at, order:orders(buyer_name, buyer_email, payment_method), event:events(id, name, event_date)')
      .eq('qr_token', tokenInput).maybeSingle();

    if (!tErr && ticket) {
      ticket.buyer_name     = ticket.order && ticket.order.buyer_name     ? ticket.order.buyer_name     : null;
      ticket.buyer_email    = ticket.order && ticket.order.buyer_email    ? ticket.order.buyer_email    : null;
      ticket.payment_method = ticket.order && ticket.order.payment_method ? ticket.order.payment_method : null;
    }

    if (tErr || !ticket) {
      if (payload.oid) {
        const { data: order } = await supabase
          .from('orders')
          .select('id, buyer_name, buyer_email, event:events(name, event_date)')
          .eq('id', payload.oid)
          .eq('payment_status', 'paid')
          .maybeSingle();

        if (order) {
          const qrKey = tokenInput.substring(0, 500);
          const { data: prevLog } = await supabase
            .from('validation_log')
            .select('id')
            .eq('qr_scanned', qrKey)
            .eq('result', 'valid')
            .limit(1)
            .maybeSingle();

          if (prevLog) {
            return ticketError(res, { status: 409, error: 'ticket_already_used', buyerName: order.buyer_name, meta: 'Entrada ya canjeada' });
          }

          await logValidation(supabase, { qrScanned: tokenInput, result: 'valid', ip });
          return res.json({
            ok: true,
            correlative_code: null,
            public_code:      null,
            buyer_name:       order.buyer_name || null,
            event_name:       order.event && order.event.name ? order.event.name : null,
            event_date:       order.event && order.event.event_date ? order.event.event_date : null,
          });
        }
      }

      await logValidation(supabase, { qrScanned: tokenInput, result: 'not_found', ip });
      return ticketError(res, { status: 404, error: 'ticket_not_found', meta: 'Entrada no encontrada' });
    }

    if (ticket.status === 'redeemed') {
      await logValidation(supabase, { ticketId: ticket.id, qrScanned: tokenInput, result: 'already_used', ip });
      return ticketError(res, { status: 409, error: 'ticket_already_used', correlativeCode: ticket.correlative_code, publicCode: ticket.public_code, buyerName: ticket.buyer_name, meta: ticket.redeemed_at });
    }

    if (ticket.status === 'revoked') {
      await logValidation(supabase, { ticketId: ticket.id, qrScanned: tokenInput, result: 'revoked', ip });
      return ticketError(res, { status: 410, error: 'ticket_revoked', correlativeCode: ticket.correlative_code, publicCode: ticket.public_code });
    }

    const { data: updated, error: updErr } = await supabase
      .from('tickets')
      .update({ status: 'redeemed', redeemed_at: new Date().toISOString() })
      .eq('id', ticket.id).in('status', ['issued', 'valid']).select('id').maybeSingle();

    if (updErr || !updated) {
      await logValidation(supabase, { ticketId: ticket.id, qrScanned: tokenInput, result: 'already_used', ip });
      return ticketError(res, { status: 409, error: 'ticket_already_used', correlativeCode: ticket.correlative_code, publicCode: ticket.public_code, buyerName: ticket.buyer_name, meta: 'Validado concurrentemente' });
    }

    await logValidation(supabase, { ticketId: ticket.id, qrScanned: tokenInput, result: 'valid', ip });

    return res.json({
      ok: true,
      correlative_code: ticket.correlative_code,
      public_code:      ticket.public_code,
      buyer_name:       ticket.buyer_name,
      event_name:       ticket.event && ticket.event.name       ? ticket.event.name       : null,
      event_date:       ticket.event && ticket.event.event_date ? ticket.event.event_date : null,
      payment_method:   ticket.payment_method || null,
    });
  })
);

// ── POST /api/tickets/validate-code ──────────────────────────────
// Validación manual por código impreso.
// Acepta AMBOS formatos: TH-PH001 (legacy) y TH-BLG-482719 (nuevo).
router.post('/tickets/validate-code',
  requireStaff,
  body('correlative_code').trim().isLength({ min: 3, max: 25 }).withMessage('Codigo requerido'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const code = req.body.correlative_code.toUpperCase().trim();
    const ip = (req.ip || '').replace('::ffff:', '');

    // Validar formato antes de ir a BD
    if (!isValidTicketCode(code)) {
      return ticketError(res, { status: 400, error: 'code_format_invalid', meta: 'Formato de código inválido' });
    }

    // Determinar si es legacy o nuevo formato
    if (LEGACY_CODE_RE.test(code)) {
      // --- Formato legacy: TH-PH001 → rpc_validate_by_correlative ---
      try {
        const { data: rpcData } = await supabase.rpc('rpc_validate_by_correlative', { p_correlative: code });
        if (rpcData) {
          if (rpcData.result === 'not_found' || rpcData.result === 'invalid') {
            return ticketError(res, { status: 404, error: 'ticket_not_found', meta: 'Codigo no encontrado' });
          }
          if (rpcData.result === 'already_used') {
            return ticketError(res, { status: 409, error: 'ticket_already_used', correlativeCode: rpcData.correlative || code, buyerName: rpcData.buyer_name || null, meta: rpcData.redeemed_at || null });
          }
          if (rpcData.result === 'revoked') {
            return ticketError(res, { status: 410, error: 'ticket_revoked', correlativeCode: code });
          }
          if (rpcData.result === 'valid') {
            return res.json({ ok: true, correlative_code: rpcData.correlative || code, public_code: null, buyer_name: rpcData.buyer_name, event_name: rpcData.event_name });
          }
        }
      } catch (e) { console.error('[validate-code legacy]', e.message); }

      // Fallback directo a BD para legacy
      const { data: ticket, error: tErr } = await supabase
        .from('tickets')
        .select('id, correlative_code, status, redeemed_at, order:orders(buyer_name), event:events(name)')
        .eq('correlative_code', code).maybeSingle();

      if (tErr || !ticket) {
        await logValidation(supabase, { qrScanned: code, result: 'not_found', ip });
        return ticketError(res, { status: 404, error: 'ticket_not_found', meta: 'Codigo no encontrado' });
      }

      const buyerName = ticket.order && ticket.order.buyer_name ? ticket.order.buyer_name : null;

      if (ticket.status === 'redeemed') {
        await logValidation(supabase, { ticketId: ticket.id, qrScanned: code, result: 'already_used', ip });
        return ticketError(res, { status: 409, error: 'ticket_already_used', correlativeCode: ticket.correlative_code, buyerName, meta: ticket.redeemed_at });
      }
      if (ticket.status === 'revoked') {
        return ticketError(res, { status: 410, error: 'ticket_revoked', correlativeCode: ticket.correlative_code });
      }

      const { data: updated, error: updErr } = await supabase
        .from('tickets')
        .update({ status: 'redeemed', redeemed_at: new Date().toISOString() })
        .eq('id', ticket.id).in('status', ['issued', 'valid']).select('id').maybeSingle();

      if (updErr || !updated) {
        return ticketError(res, { status: 409, error: 'ticket_already_used', correlativeCode: ticket.correlative_code, buyerName });
      }

      await logValidation(supabase, { ticketId: ticket.id, qrScanned: code, result: 'valid', ip });
      return res.json({ ok: true, correlative_code: ticket.correlative_code, public_code: null, buyer_name: buyerName, event_name: ticket.event && ticket.event.name ? ticket.event.name : null });

    } else {
      // --- Formato nuevo: TH-BLG-482719 → rpc_validate_by_public_code ---
      try {
        const { data: rpcData } = await supabase.rpc('rpc_validate_by_public_code', { p_code: code });
        if (rpcData) {
          if (rpcData.result === 'not_found') {
            return ticketError(res, { status: 404, error: 'ticket_not_found', meta: 'Codigo no encontrado' });
          }
          if (rpcData.result === 'already_used') {
            return ticketError(res, { status: 409, error: 'ticket_already_used', publicCode: rpcData.public_code || code, correlativeCode: rpcData.correlative || null, buyerName: rpcData.buyer_name || null, meta: rpcData.redeemed_at || null });
          }
          if (rpcData.result === 'revoked') {
            return ticketError(res, { status: 410, error: 'ticket_revoked', publicCode: code, correlativeCode: rpcData.correlative || null });
          }
          if (rpcData.result === 'valid') {
            return res.json({ ok: true, public_code: rpcData.public_code || code, correlative_code: rpcData.correlative || null, buyer_name: rpcData.buyer_name, event_name: rpcData.event_name });
          }
        }
      } catch (e) { console.error('[validate-code new]', e.message); }

      return ticketError(res, { status: 404, error: 'ticket_not_found', meta: 'Codigo no encontrado' });
    }
  })
);

module.exports = router;
