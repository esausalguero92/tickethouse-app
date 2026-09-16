'use strict';
/**
 * devRoutes.js — Rutas SOLO para desarrollo local.
 *
 * NUNCA se montan en producción (server.js verifica env.isProd).
 * Permiten simular el webhook de Recurrente sin necesidad de un tunnel.
 */

const { Router } = require('express');
const { getSupabase } = require('../db/supabase');
const { asyncHandler } = require('../middleware/errorHandler');
const { issueTickets } = require('../services/TicketService');
const { notifyNewOrder } = require('../services/TelegramService');

const router = Router();

// ── POST /api/dev/confirm-order/:orderId ─────────────────────────────────────
// Simula el webhook de Recurrente: marca la orden como pagada y emite tickets.
// Útil en desarrollo local donde Recurrente no puede alcanzar localhost.
// BLOQUEADO en producción — server.js solo monta este router cuando !isProd.
router.post('/confirm-order/:orderId', asyncHandler(async (req, res) => {
  const supabase = getSupabase();
  const { orderId } = req.params;

  // Validar UUID básico
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)) {
    return res.status(400).json({ error: 'orderId inválido' });
  }

  // Buscar orden
  const { data: order, error: oErr } = await supabase
    .from('orders')
    .select('id, event_id, buyer_id, buyer_name, buyer_email, quantity, payment_status, event:events(name, event_date, venue, code_prefix)')
    .eq('id', orderId)
    .maybeSingle();

  if (oErr || !order) {
    return res.status(404).json({ error: 'orden_no_encontrada' });
  }

  if (order.payment_status === 'paid') {
    return res.json({ ok: true, already_paid: true, message: 'La orden ya estaba pagada' });
  }

  if (order.payment_status !== 'pending') {
    return res.status(409).json({ error: 'estado_invalido', payment_status: order.payment_status });
  }

  // Marcar como pagada (igual que el webhook real)
  const { error: upErr } = await supabase
    .from('orders')
    .update({
      payment_status:       'paid',
      payment_method:       'recurrente_dev_sim',
      paid_at:              new Date().toISOString(),
      recurrente_intent_id: 'dev_simulated',
    })
    .eq('id', orderId)
    .eq('payment_status', 'pending');

  if (upErr) {
    console.error('[dev.confirm-order] Error actualizando orden:', upErr.message);
    return res.status(500).json({ error: 'db_update_failed' });
  }

  // Emitir tickets
  let result;
  try {
    result = await issueTickets({
      orderId:     order.id,
      eventId:     order.event_id,
      buyerId:     order.buyer_id,
      buyerName:   order.buyer_name,
      buyerEmail:  order.buyer_email,
      quantity:    order.quantity,
      eventName:   (order.event && order.event.name)       || 'TicketHouse',
      eventDate:   (order.event && order.event.event_date)  || null,
      eventVenue:  (order.event && order.event.venue)       || '',
      eventPrefix: (order.event && order.event.code_prefix) || 'TH',
    });
  } catch (e) {
    console.error('[dev.confirm-order] Error emitiendo tickets:', e.message);
    return res.status(500).json({ error: 'ticket_issue_failed', detail: e.message });
  }

  // Notificar Telegram (no-blocking, puede fallar en dev)
  notifyNewOrder({
    buyerName:   order.buyer_name,
    quantity:    order.quantity,
    eventName:   (order.event && order.event.name) || 'TicketHouse',
    orderId,
    publicCodes: result.publicCodes,
  }).catch(e => console.warn('[dev.telegram]', e.message));

  console.log('[DEV] Orden confirmada manualmente:', orderId, '→', result.publicCodes);
  return res.json({
    ok: true,
    simulated: true,
    orderId,
    publicCodes: result.publicCodes,
    message: 'Orden confirmada (simulación dev — no fue un pago real)',
  });
}));

module.exports = router;
