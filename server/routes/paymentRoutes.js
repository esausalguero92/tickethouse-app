'use strict';

const { Router } = require('express');
const { body } = require('express-validator');
const { getSupabase } = require('../db/supabase');
const { asyncHandler } = require('../middleware/errorHandler');
const { validateRequest, purchaseLimiter, paymentLimiter } = require('../middleware/security');
const { issueTickets, issueTicketsTiers } = require('../services/TicketService');
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


// ── POST /api/payment/intent/tiers ───────────────────────────────
// Crea orden pendiente para compra de localidades (flujo tiers).
// El RPC valida capacidad, precios y retorna order_id + total_gtq.
router.post('/payment/intent/tiers',
  purchaseLimiter,
  body('event_id').isUUID().withMessage('event_id inválido'),
  body('full_name').trim().isLength({ min: 2, max: 120 }).withMessage('Nombre requerido (2-120 chars)'),
  body('email').trim().isEmail().normalizeEmail().withMessage('Email inválido'),
  body('tier_items').isArray({ min: 1 }).withMessage('tier_items debe ser un arreglo con al menos 1 localidad'),
  body('tier_items.*.tier_id').isUUID().withMessage('tier_id inválido'),
  body('tier_items.*.quantity').isInt({ min: 1 }).withMessage('quantity debe ser entero > 0'),
  body('age_verified').custom(v => {
    if (v === true || v === 'true') return true;
    throw new Error('Debes confirmar mayoría de edad');
  }),
  body('terms_accepted').custom(v => {
    if (v === true || v === 'true') return true;
    throw new Error('Debes aceptar los términos');
  }),
  validateRequest,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { event_id, full_name, email, tier_items } = req.body;
    const now = new Date();

    // 1. Cargar evento
    const { data: event, error: evErr } = await supabase
      .from('events')
      .select('id, name, tickets_sold, max_per_order')
      .eq('id', event_id)
      .maybeSingle();

    if (evErr || !event) return res.status(404).json({ error: 'Evento no encontrado' });

    // 2. Filtrar items con cantidad > 0
    const validItems = (tier_items || []).filter(i => parseInt(i.quantity, 10) > 0);
    if (validItems.length === 0) return res.status(400).json({ error: 'Debes seleccionar al menos una localidad' });

    const totalQty = validItems.reduce((s, i) => s + parseInt(i.quantity, 10), 0);

    if (event.max_per_order && totalQty > event.max_per_order) {
      return res.status(400).json({ error: `Máximo ${event.max_per_order} tickets por orden` });
    }
    // 3. Validar cada tier y su fase activa
    let total = 0;
    const tierItemsOut = [];

    for (const item of validItems) {
      const qty = parseInt(item.quantity, 10);

      // Cargar tier con sus fases
      const { data: tier, error: tErr } = await supabase
        .from('ticket_tiers')
        .select('id, name, capacity, tickets_sold, tier_phases(id, name, price_gtq, capacity, tickets_sold, bundle_qty, sort_order, is_active, starts_at, ends_at)')
        .eq('id', item.tier_id)
        .eq('event_id', event_id)
        .maybeSingle();

      if (tErr || !tier) return res.status(404).json({ error: 'Localidad no encontrada' });

      // Fase activa: is_active=TRUE, ends_at nulo o futuro (starts_at es solo informativo)
      const phase = (tier.tier_phases || [])
        .filter(p => p.is_active === true && (p.ends_at === null || new Date(p.ends_at) > now))
        .sort((a, b) => (a.sort_order - b.sort_order) || 0)[0] || null;

      if (!phase) return res.status(400).json({ error: `No hay precio activo para ${tier.name}` });

      const bundleQty = parseInt(phase.bundle_qty || 1, 10);
      if (bundleQty > 1 && qty % bundleQty !== 0) {
        return res.status(400).json({ error: `La cantidad para "${tier.name}" debe ser múltiplo de ${bundleQty}` });
      }
      if (phase.capacity != null && (phase.tickets_sold + qty) > phase.capacity) {
        return res.status(409).json({ error: `Agotada la fase actual de ${tier.name}` });
      }

      const packs    = qty / bundleQty;
      const subtotal = packs * parseFloat(phase.price_gtq);
      total += subtotal;

      tierItemsOut.push({
        tier_id:        tier.id,
        tier_name:      tier.name,
        phase_id:       phase.id,
        phase_name:     phase.name,
        quantity:       qty,
        bundle_qty:     bundleQty,
        unit_price_gtq: parseFloat(phase.price_gtq),
      });
    }

    if (total <= 0) return res.status(400).json({ error: 'Total inválido' });

    // 4. Insertar orden
    const { data: order, error: insErr } = await supabase
      .from('orders')
      .insert({
        event_id,
        buyer_name:     full_name,
        buyer_email:    email,
        quantity:       totalQty,
        amount_usd:     total,
        payment_method: 'recurrente',
        payment_status: 'pending',
        tier_items:     tierItemsOut,
      })
      .select('id')
      .single();

    if (insErr || !order) {
      console.error('[payment.intent.tiers] insert order:', insErr?.message);
      return res.status(500).json({ error: 'db_error' });
    }

    console.log('[payment.intent.tiers] orden creada:', order.id, 'total:', total);
    return res.json({
      order_id:   order.id,
      total_gtq:  total,
      quantity:   totalQty,
      tier_items: tierItemsOut,
    });
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
      .select('id, event_id, payment_status, quantity, amount_usd, discount_amount_usd, buyer_name, buyer_email, tier_items, event:events(name, code_prefix, price_gtq)')
      .eq('id', order_id)
      .eq('payment_status', 'pending')
      .maybeSingle();

    if (oErr || !order) {
      console.error('[payment.checkout] order lookup failed:', oErr?.message, 'order:', order);
      return res.status(404).json({ error: 'order_not_found_or_not_pending' });
    }

    // El backend calcula el precio — nunca confiar en el frontend
    const isTierOrder   = order.tier_items && Array.isArray(order.tier_items) && order.tier_items.length > 0;
    const discountGtq   = Math.round((order.discount_amount_usd || 0) * 100);
    // Para órdenes de tiers: el total ya está en amount_usd (calculado por el RPC)
    // Para órdenes estándar: price_gtq * quantity
    let unitPriceGtq, checkoutQty;
    if (isTierOrder) {
      unitPriceGtq  = Math.round((Number(order.amount_usd) || 0) * 100);
      checkoutQty   = 1; // Recurrente recibe total como 1 ítem
    } else {
      unitPriceGtq  = Math.round((order.event && order.event.price_gtq ? order.event.price_gtq : 0) * 100);
      checkoutQty   = order.quantity;
    }

    let checkoutId, checkoutUrl;
    try {
      ({ checkoutId, checkoutUrl } = await createCheckout({
        orderId:       order_id,
        eventId:       order.event_id,
        eventName:     (order.event && order.event.name) || 'TicketHouse',
        quantity:      checkoutQty,
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
    // req.rawBody es el Buffer crudo capturado por el verify callback de express.json()
    // antes de que sea parseado o sanitizado. Nunca usar req.body aquí.
    let payload;
    try {
      payload = verifyWebhookSignature(req.rawBody, req.headers);
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
      .select('id, event_id, buyer_id, buyer_name, buyer_email, quantity, tier_items, payment_status, event:events(name, event_date, venue, code_prefix, location_url)')
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
      const hasTierItems = order.tier_items && Array.isArray(order.tier_items) && order.tier_items.length > 0;
      if (hasTierItems) {
        result = await issueTicketsTiers({
          orderId:    order.id,
          eventId:    order.event_id,
          buyerId:    order.buyer_id,
          buyerName:  order.buyer_name,
          buyerEmail: order.buyer_email,
          tierItems:  order.tier_items,
          eventName:  (order.event && order.event.name)       || 'TicketHouse',
          eventDate:  (order.event && order.event.event_date)  || null,
          eventVenue: (order.event && order.event.venue)      || '',
          eventPrefix:   (order.event && order.event.code_prefix)   || 'TH',
          locationUrl:   (order.event && order.event.location_url)   || null,
        });
      } else {
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
          eventPrefix:   (order.event && order.event.code_prefix)   || 'TH',
          locationUrl:   (order.event && order.event.location_url)   || null,
        });
      }
    } catch (e) {
      console.error('[webhook.recurrente] Error emitiendo tickets:', e.message);
      // El webhook ya confirmó pago — el admin puede re-emitir manualmente
      return res.status(500).json({ error: 'ticket_issue_failed', order_id: orderId });
    }

    // 8. Notificar al admin por Telegram (non-blocking)
    // Consultar total de entradas vendidas para este evento
    supabase
      .from('orders')
      .select('quantity')
      .eq('event_id', order.event_id)
      .eq('payment_status', 'paid')
      .neq('payment_method', 'complimentary')
      .then(({ data: soldData }) => {
        const totalSold = (soldData || []).reduce((sum, r) => sum + (r.quantity || 0), 0);
        return notifyNewOrder({
          buyerName:   order.buyer_name,
          quantity:    order.quantity,
          eventName:   (order.event && order.event.name) || 'TicketHouse',
          orderId,
          publicCodes: result.publicCodes,
          totalSold,
        });
      })
      .catch(function(e) { console.error('[webhook.telegram]', e.message); });

    console.log('[webhook.recurrente] Tickets emitidos para orden:', orderId, '→', result.publicCodes);
    return res.json({ ok: true });
  })
);

// ── POST /api/sandbox/confirm-payment ────────────────────────────
// Solo disponible fuera de producción.
// Simula el webhook de Recurrente sin verificar firma.
if (process.env.NODE_ENV !== 'production') {
  router.post('/sandbox/confirm-payment',
    body('order_id').isUUID().withMessage('order_id invalido'),
    validateRequest,
    asyncHandler(async (req, res) => {
      const supabase = getSupabase();
      const { order_id: orderId } = req.body;

      const { data: order, error: oErr } = await supabase
        .from('orders')
        .select('id, event_id, buyer_id, buyer_name, buyer_email, quantity, payment_status, tier_items, event:events(name, event_date, venue, code_prefix, location_url)')
        .eq('id', orderId)
        .maybeSingle();

      if (oErr || !order) return res.status(404).json({ error: 'order_not_found' });
      if (order.payment_status === 'paid') return res.json({ ok: true, already_paid: true });

      const { error: upErr } = await supabase
        .from('orders')
        .update({ payment_status: 'paid', payment_method: 'recurrente', paid_at: new Date().toISOString() })
        .eq('id', orderId)
        .eq('payment_status', 'pending');

      if (upErr) return res.status(500).json({ error: 'db_update_failed' });

      let result;
      try {
        const hasTierItems = order.tier_items && Array.isArray(order.tier_items) && order.tier_items.length > 0;
        if (hasTierItems) {
          result = await issueTicketsTiers({
            orderId:     order.id,
            eventId:     order.event_id,
            buyerId:     order.buyer_id,
            buyerName:   order.buyer_name,
            buyerEmail:  order.buyer_email,
            tierItems:   order.tier_items,
            eventName:   (order.event && order.event.name)       || 'TicketHouse',
            eventDate:   (order.event && order.event.event_date)  || null,
            eventVenue:  (order.event && order.event.venue)      || '',
            eventPrefix:   (order.event && order.event.code_prefix)   || 'TH',
          locationUrl:   (order.event && order.event.location_url)   || null,
          });
        } else {
        result = await issueTickets({
          orderId,
          eventId:     order.event_id,
          buyerId:     order.buyer_id,
          buyerName:   order.buyer_name,
          buyerEmail:  order.buyer_email,
          quantity:    order.quantity,
          eventName:   (order.event && order.event.name)       || 'TicketHouse',
          eventDate:   (order.event && order.event.event_date)  || null,
          eventVenue:  (order.event && order.event.venue)      || '',
          eventPrefix:   (order.event && order.event.code_prefix)   || 'TH',
          locationUrl:   (order.event && order.event.location_url)   || null,
        });
        }
      } catch (e) {
        return res.status(500).json({ error: 'ticket_issue_failed', message: e.message });
      }

      supabase
        .from('orders').select('quantity')
        .eq('event_id', order.event_id).eq('payment_status', 'paid').neq('payment_method', 'complimentary')
        .then(({ data: soldData }) => {
          const totalSold = (soldData || []).reduce((s, r) => s + (r.quantity || 0), 0);
          return notifyNewOrder({ buyerName: order.buyer_name, quantity: order.quantity, eventName: (order.event && order.event.name) || 'TicketHouse', orderId, publicCodes: result.publicCodes, totalSold });
        })
        .catch(e => console.error('[sandbox.telegram]', e.message));

      console.log('[sandbox] Pago confirmado:', orderId, '→', result.publicCodes);
      return res.json({ ok: true, publicCodes: result.publicCodes });
    })
  );
}

// ── POST /api/sandbox/reissue-tickets ────────────────────────────
// Re-emite tickets para una orden 'paid' que no tiene tickets.
// Solo disponible fuera de producción.
if (process.env.NODE_ENV !== 'production') {
  router.post('/sandbox/reissue-tickets',
    body('order_id').isUUID().withMessage('order_id invalido'),
    validateRequest,
    asyncHandler(async (req, res) => {
      const supabase = getSupabase();
      const { order_id: orderId } = req.body;

      const { data: order, error: oErr } = await supabase
        .from('orders')
        .select('id, event_id, buyer_id, buyer_name, buyer_email, quantity, payment_status, tier_items, event:events(name, event_date, venue, code_prefix, location_url)')
        .eq('id', orderId)
        .maybeSingle();

      if (oErr || !order) return res.status(404).json({ error: 'order_not_found' });
      if (order.payment_status !== 'paid') return res.status(400).json({ error: 'order_not_paid', status: order.payment_status });

      // Verificar que no haya tickets ya emitidos
      const { data: existingTickets } = await supabase
        .from('tickets')
        .select('id')
        .eq('order_id', orderId)
        .neq('status', 'revoked');

      if (existingTickets && existingTickets.length > 0) {
        return res.status(400).json({ error: 'tickets_already_exist', count: existingTickets.length });
      }

      let result;
      try {
        const hasTierItems = order.tier_items && Array.isArray(order.tier_items) && order.tier_items.length > 0;
        if (hasTierItems) {
          result = await issueTicketsTiers({
            orderId:     order.id,
            eventId:     order.event_id,
            buyerId:     order.buyer_id,
            buyerName:   order.buyer_name,
            buyerEmail:  order.buyer_email,
            tierItems:   order.tier_items,
            eventName:   (order.event && order.event.name)       || 'TicketHouse',
            eventDate:   (order.event && order.event.event_date)  || null,
            eventVenue:  (order.event && order.event.venue)      || '',
            eventPrefix: (order.event && order.event.code_prefix) || 'TH',
            locationUrl: (order.event && order.event.location_url) || null,
          });
        } else {
          result = await issueTickets({
            orderId,
            eventId:     order.event_id,
            buyerId:     order.buyer_id,
            buyerName:   order.buyer_name,
            buyerEmail:  order.buyer_email,
            quantity:    order.quantity,
            eventName:   (order.event && order.event.name)       || 'TicketHouse',
            eventDate:   (order.event && order.event.event_date)  || null,
            eventVenue:  (order.event && order.event.venue)      || '',
            eventPrefix: (order.event && order.event.code_prefix) || 'TH',
            locationUrl: (order.event && order.event.location_url) || null,
          });
        }
      } catch (e) {
        return res.status(500).json({ error: 'ticket_issue_failed', message: e.message });
      }

      console.log('[sandbox.reissue] Tickets re-emitidos para', orderId, '→', result.publicCodes);
      return res.json({ ok: true, publicCodes: result.publicCodes, downloadToken: result.downloadToken });
    })
  );
}


// ── POST /api/sandbox/resend-email ───────────────────────────────
// Reenvía el correo de confirmación con los PDFs regenerados
// para una orden ya pagada con tickets existentes.
if (env.isDev) {
  router.post('/sandbox/resend-email',
    asyncHandler(async (req, res) => {
      const { order_id } = req.body;
      if (!order_id) return res.status(400).json({ error: 'order_id requerido' });

      const supabase = getSupabase();

      // Cargar la orden
      const { data: order, error: oErr } = await supabase
        .from('orders')
        .select('id, event_id, buyer_id, payment_status, buyers(full_name, email), events(name, event_date, venue, location_url, code_prefix)')
        .eq('id', order_id)
        .maybeSingle();

      if (oErr || !order) return res.status(404).json({ error: 'Orden no encontrada' });
      if (order.payment_status !== 'paid') return res.status(400).json({ error: 'Orden no pagada' });

      // Cargar los tickets existentes
      const { data: tickets, error: tErr } = await supabase
        .from('tickets')
        .select('id, public_code, correlative_code, qr_token, tier_name')
        .eq('order_id', order_id)
        .eq('status', 'issued');

      if (tErr || !tickets || tickets.length === 0)
        return res.status(404).json({ error: 'No hay tickets emitidos para esta orden' });

      const { generateTicketPdf } = require('../services/PdfService');
      const { sendConfirmationEmail } = require('../services/EmailService');
      const { generateDownloadToken } = require('../services/QrService');

      const ev = order.events;
      const buyer = order.buyers;

      // Regenerar PDFs con los datos actuales (incluyendo tier_name)
      const pdfBuffers = await Promise.all(
        tickets.map(t => generateTicketPdf({
          publicCode:      t.public_code,
          correlativeCode: t.correlative_code,
          qrToken:         t.qr_token,
          eventName:       ev.name,
          eventDate:       ev.event_date,
          eventVenue:      ev.venue,
          buyerName:       buyer.full_name,
          locationUrl:     ev.location_url,
          tierName:        t.tier_name || null,
        }))
      );

      const downloadToken = generateDownloadToken(order_id);

      await sendConfirmationEmail({
        toEmail:     buyer.email,
        buyerName:   buyer.full_name || 'Invitado/a',
        eventName:   ev.name,
        eventDate:   ev.event_date,
        eventVenue:  ev.venue,
        tickets: tickets.map((t, i) => ({
          correlativeCode: t.correlative_code,
          qrToken:         t.qr_token,
          pdfBuffer:       pdfBuffers[i],
        })),
        downloadUrl: env.PUBLIC_BASE_URL + '/ticket.html?ot=' + downloadToken,
      });

      return res.json({ ok: true, sent_to: buyer.email, tickets: tickets.length });
    })
  );
}

module.exports = router;
