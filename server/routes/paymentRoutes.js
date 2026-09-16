'use strict';

const { Router } = require('express');
const { body } = require('express-validator');
const { getSupabase } = require('../db/supabase');
const { asyncHandler } = require('../middleware/errorHandler');
const { validateRequest, purchaseLimiter, paymentLimiter } = require('../middleware/security');
const { issueTickets } = require('../services/TicketService');
const { notifyNewOrder } = require('../services/TelegramService');
const { createCheckout, verifyWebhookSignature } = require('../services/RecurrenteService');
const env = require('../config/env');

const router = Router();

// ── POST /api/payment/intent ──────────────────────────────────────
// Crea la orden pendiente en BD (RPC atómica).
// El backend es la autoridad: precio, cantidad, descuento, evento.
// El frontend recibe order_id + total_gtq para mostrar checkout.
router.post('/payment/intent',
  purchaseLimiter,
  body('event_code_id').custom(v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)).withMessage('event_code_id invalido'),
  body('full_name').trim().isLength({ min: 2, max: 120 }).withMessage('Nombre requerido (2-120 chars)'),
  body('email').trim().isEmail().normalizeEmail().withMessage('Email invalido'),
  body('quantity').custom(v => {
    const n = parseInt(v, 10);
    if (isNaN(n) || n < 1 || n > 10) throw new Error('Cantidad invalida (1-10)');
    return true;
  }),
  body('age_verified').custom(v => {
    if (v === true || v === 'true') return true;
    throw new Error('Debes confirmar mayoria de edad');
  }),
  body('terms_accepted').custom(v => {
    if (v === true || v === 'true') return true;
    throw new Error('Debes aceptar los terminos');
  }),
  validateRequest,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { event_code_id, full_name, email, phone, quantity, age_verified, terms_accepted, discount_code } = req.body;
    const ip = (req.ip || '').replace('::ffff:', '');
    const ua = req.headers['user-agent'] || '';

    const { data, error } = await supabase.rpc('rpc_create_purchase_intent', {
      p_event_code_id:  event_code_id,
      p_full_name:      full_name,
      p_email:          email,
      p_phone:          phone || null,
      p_quantity:       parseInt(quantity, 10),
      p_age_verified:   age_verified === true || age_verified === 'true',
      p_terms_accepted: terms_accepted === true || terms_accepted === 'true',
      p_ip_address:     ip || null,
      p_user_agent:     ua || null,
      p_discount_code:  discount_code ? String(discount_code).trim().toUpperCase() : null,
    });

    if (error) { console.error('[payment.intent]', error); return res.status(500).json({ error: 'db_error' }); }
    console.log('[payment.intent] rpc result:', JSON.stringify(data));
    if (data && data.error) {
      const statusMap = {
        age_not_verified: 400, terms_not_accepted: 400, quantity_invalid: 400,
        name_required: 400, email_invalid: 400, event_code_invalid: 404,
        event_not_available: 410, quantity_exceeds_limit: 400, insufficient_capacity: 409,
      };
      return res.status(statusMap[data.error] || 400).json(data);
    }
    return res.json(data);
  })
);

// ── POST /api/payment/recurrente/checkout ─────────────────────────
// Crea el checkout en Recurrente y retorna checkout_url al frontend.
// El frontend embebe el checkout_url en un iframe (NO redirige).
// La clave RECURRENTE_SECRET_KEY NUNCA llega al cliente.
router.post('/payment/recurrente/checkout',
  paymentLimiter,
  body('order_id').isUUID().withMessage('order_id invalido'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { order_id } = req.body;

    // Verificar que la orden existe, está pendiente y obtener detalles
    const { data: order, error: oErr } = await supabase
      .from('orders')
      .select('id, event_id, payment_status, quantity, amount_usd, discount_amount_usd, buyer_name, buyer_email, event:events(name, code_prefix, price_gtq)')
      .eq('id', order_id)
      .eq('payment_status', 'pending')
      .maybeSingle();

    if (oErr || !order) {
      console.error('[payment.checkout] order lookup failed:', oErr?.message, 'order:', order);
      return res.status(404).json({ error: 'order_not_found_or_not_pending' });
    }

    // El backend calcula el precio — nunca confiar en el frontend
    const unitPriceGtq  = Math.round((order.event && order.event.price_gtq ? order.event.price_gtq : 0) * 100);
    const discountGtq   = Math.round((order.discount_amount_usd || 0) * 100);

    let checkoutId, checkoutUrl;
    try {
      ({ checkoutId, checkoutUrl } = await createCheckout({
        orderId:       order_id,
        eventId:       order.event_id,
        eventName:     (order.event && order.event.name) || 'TicketHouse',
        quantity:      order.quantity,
        unitPriceGtq,
        discountAmount: discountGtq,
        buyerEmail:    order.buyer_email,
        buyerName:     order.buyer_name,
      }));
    } catch (e) {
      console.error('[payment.recurrente.checkout]', e.message);
      return res.status(e.status || 502).json({ error: 'checkout_creation_failed', message: e.message });
    }

    // Guardar checkout_id en la orden para correlacionar con el webhook
    await supabase
      .from('orders')
      .update({ recurrente_checkout_id: checkoutId })
      .eq('id', order_id);

    // Solo retornar checkout_url — la clave secreta nunca sale al cliente
    return res.json({ checkout_url: checkoutUrl });
  })
);

// ── POST /api/webhooks/recurrente ─────────────────────────────────
// Endpoint de webhook de Recurrente (Svix HMAC-SHA256).
// Los tickets se emiten AQUÍ, no en el callback del iframe.
// CRÍTICO: verificar firma antes de cualquier acción.
router.post('/webhooks/recurrente',
  // Nota: este endpoint recibe body crudo (raw) — Express debe montarlo con
  // express.raw({ type: 'application/json' }) ANTES de este router.
  // Ver server.js: app.use('/api/webhooks/recurrente', express.raw(...), paymentRouter)
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();

    // 1. Verificar firma Svix (lanza si inválida)
    let payload;
    try {
      payload = verifyWebhookSignature(req.body, req.headers);
    } catch (e) {
      console.warn('[webhook.recurrente] Firma inválida:', e.message);
      return res.status(401).json({ error: 'invalid_signature' });
    }

    // 2. Idempotencia: ignorar eventos ya procesados
    const svixId = req.headers['svix-id'];
    if (svixId) {
      const { data: existing } = await supabase
        .from('webhook_events')
        .select('svix_id')
        .eq('svix_id', svixId)
        .maybeSingle();

      if (existing) {
        console.log('[webhook.recurrente] Evento duplicado, ignorando:', svixId);
        return res.json({ ok: true, duplicate: true });
      }

      // Registrar como procesado (antes de emitir tickets para mayor idempotencia)
      await supabase.from('webhook_events').insert({ svix_id: svixId });
    }

    // FIX: Recurrente usa `event_type` para el nombre del evento; `type` es el método de pago ("payment")
    const eventType = payload.event_type;

    // 3. Solo procesar pagos exitosos
    if (eventType !== 'intent.succeeded' && eventType !== 'payment_intent.succeeded') {
      console.log('[webhook.recurrente] Evento ignorado:', eventType);
      return res.json({ ok: true, ignored: eventType });
    }

    // 4. Extraer order_id desde metadata o (fallback) correlacionar por checkout.id
    const intentData = payload.data || payload;
    // FIX: metadata puede no venir en el payload de Recurrente; intentarlo primero y luego
    // buscar por recurrente_checkout_id usando payload.checkout.id como fallback.
    let orderId = intentData.metadata && intentData.metadata.order_id;
    const intentId = intentData.id || intentData.payment_intent_id;

    if (!orderId && payload.checkout && payload.checkout.id) {
      const { data: orderByCheckout } = await supabase
        .from('orders')
        .select('id')
        .eq('recurrente_checkout_id', payload.checkout.id)
        .maybeSingle();
      if (orderByCheckout) orderId = orderByCheckout.id;
    }

    if (!orderId) {
      console.error('[webhook.recurrente] No se pudo determinar order_id (svix_id:', svixId, 'checkout:', payload.checkout && payload.checkout.id, ')');
      return res.status(400).json({ error: 'missing_order_id' });
    }

    // 5. Obtener orden y verificar que está pendiente
    const { data: order, error: oErr } = await supabase
      .from('orders')
      .select('id, event_id, buyer_id, buyer_name, buyer_email, quantity, payment_status, event:events(name, event_date, venue, code_prefix)')
      .eq('id', orderId)
      .maybeSingle();

    if (oErr || !order) {
      console.error('[webhook.recurrente] Orden no encontrada:', orderId);
      return res.status(404).json({ error: 'order_not_found' });
    }

    // Si ya fue pagada (otro webhook duplicado llegó primero)
    if (order.payment_status === 'paid') {
      console.log('[webhook.recurrente] Orden ya pagada:', orderId);
      return res.json({ ok: true, already_paid: true });
    }

    // 6. Marcar orden como pagada con método recurrente
    const { error: upErr } = await supabase
      .from('orders')
      .update({
        payment_status:       'paid',
        payment_method:       'recurrente',
        paid_at:              new Date().toISOString(),
        recurrente_intent_id: intentId || null,
      })
      .eq('id', orderId)
      .eq('payment_status', 'pending');

    if (upErr) {
      console.error('[webhook.recurrente] Error actualizando orden:', upErr.message);
      return res.status(500).json({ error: 'db_update_failed' });
    }

    // 7. Emitir tickets (flujo completo: JWT + BD + PDF + email)
    let result;
    try {
      result = await issueTickets({
        orderId:    order.id,
        eventId:    order.event_id,
        buyerId:    order.buyer_id,
        buyerName:  order.buyer_name,
        buyerEmail: order.buyer_email,
        quantity:   order.quantity,
        eventName:  (order.event && order.event.name)      || 'TicketHouse',
        eventDate:  (order.event && order.event.event_date) || null,
        eventVenue: (order.event && order.event.venue)     || '',
        eventPrefix: (order.event && order.event.code_prefix) || 'TH',
      });
    } catch (e) {
      console.error('[webhook.recurrente] Error emitiendo tickets:', e.message);
      // El webhook ya confirmó pago — el admin puede re-emitir manualmente
      return res.status(500).json({ error: 'ticket_issue_failed', order_id: orderId });
    }

    // 8. Notificar al admin por Telegram (non-blocking)
    notifyNewOrder({
      buyerName:  order.buyer_name,
      quantity:   order.quantity,
      eventName:  (order.event && order.event.name) || 'TicketHouse',
      orderId,
      publicCodes: result.publicCodes,
    }).catch(function(e) { console.error('[webhook.telegram]', e.message); });

    console.log('[webhook.recurrente] Tickets emitidos para orden:', orderId, '→', result.publicCodes);
    return res.json({ ok: true });
  })
);

module.exports = router;
