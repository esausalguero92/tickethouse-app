'use strict';
/**
 * Rutas públicas (sin autenticación).
 * GET  /api/event/:code     → Info del evento por código general (PH787)
 * GET  /api/public-config   → PayPal client_id, moneda
 * GET  /api/transfer/info   → Datos bancarios para transferencia
 * GET  /api/health          → Health check
 * POST /api/code/redeem     → Canjear código de invitado especial
 */

const { Router } = require('express');
const { param, body } = require('express-validator');
const { getSupabase } = require('../db/supabase');
const { asyncHandler } = require('../middleware/errorHandler');
const { validateRequest, authLimiter } = require('../middleware/security');
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

    const { tickets_sold: _ts, capacity: _cap, available: _av, ...publicData } = data;

    // Buscar event_code_id para el flujo de pago (igual que GET /api/events/:id)
    const eventId = publicData.id || (publicData.event && publicData.event.id);
    let eventCodeId = null;
    if (eventId) {
      const { data: ecData } = await supabase
        .from('event_codes')
        .select('id')
        .eq('event_id', eventId)
        .eq('active', true)
        .limit(1)
        .maybeSingle();
      eventCodeId = ecData ? ecData.id : null;
    }

    return res.json({ ...publicData, event_code_id: eventCodeId });
  })
);

// ── GET /api/public-config ────────────────────────────────────────
router.get('/public-config', (_, res) => {
  res.json({
    payment_gateway: 'recurrente',
  });
});



// ── GET /api/health ───────────────────────────────────────────────
router.get('/health', (_, res) => {
  res.json({
    ok:      true,
    version: '2.0.0',
    ts:      new Date().toISOString(),
  });
});

// ── GET /api/code/check/:code ─────────────────────────────────────
// Valida si un codigo de invitado es activo, SIN emitir ticket.
// Usado por index.html para detectar access_codes antes de redirigir.
router.get('/code/check/:code',
  authLimiter,
  param('code').trim().isLength({ min: 3, max: 40 }),
  validateRequest,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const code = String(req.params.code).trim().toUpperCase();
    const { data, error } = await supabase.rpc('rpc_validate_code', { p_code: code });
    if (error || !data || data.error) {
      return res.status(404).json({ error: 'code_invalid' });
    }
    return res.json({ valid: true });
  })
);

// ── POST /api/code/redeem ─────────────────────────────────────────
// Canjea un codigo de invitado especial.
// Si el ticket ya fue emitido, devuelve el download token existente.
// Si no, crea la orden complimentary y emite el ticket en el acto.
router.post('/code/redeem',
  authLimiter,
  body('code').trim().toUpperCase().isLength({ min: 3, max: 40 }).withMessage('Codigo requerido'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const code = String(req.body.code || '').trim().toUpperCase();

    // 1. Validar el codigo contra access_codes
    const { data: codeData, error: codeErr } = await supabase.rpc('rpc_validate_code', { p_code: code });
    if (codeErr) {
      console.error('[code/redeem] rpc_validate_code error:', codeErr);
      return res.status(500).json({ error: 'db_error' });
    }
    if (!codeData || codeData.error) {
      return res.status(404).json({ error: 'code_invalid', message: 'Codigo no valido o inactivo.' });
    }

    const { code_id, event, guest, has_ticket } = codeData;

    // 2. Si el ticket ya existe, devolver download token del orden existente
    if (has_ticket) {
      const { data: order } = await supabase
        .from('orders')
        .select('id')
        .eq('code_id', code_id)
        .maybeSingle();
      if (!order) return res.status(404).json({ error: 'order_not_found' });
      const { generateDownloadToken } = require('../services/QrService');
      return res.json({ ok: true, token: generateDownloadToken(order.id) });
    }

    // 3. Crear orden complimentary y emitir ticket
    const { data: rpcData, error: rpcErr } = await supabase.rpc('rpc_create_complimentary_order', { p_code: code });
    if (rpcErr || !rpcData || rpcData.error) {
      console.error('[code/redeem] rpc_create_complimentary_order:', rpcErr || rpcData);
      return res.status(500).json({ error: (rpcData && rpcData.error) || 'order_failed' });
    }

    const guestName = [guest && guest.first_name, guest && guest.last_name].filter(Boolean).join(' ') || 'Invitado/a';
    const { issueTickets } = require('../services/TicketService');
    const result = await issueTickets({
      orderId:    rpcData.order_id,
      eventId:    event && event.id,
      buyerId:    null,
      buyerName:  guestName,
      buyerEmail: guest && guest.email || null,
      quantity:   1,
      eventName:  event && event.name  || 'Party House',
      eventDate:  event && event.event_date || null,
      eventVenue: event && event.venue || '',
    });

    return res.json({ ok: true, token: result.downloadToken });
  })
);

// ── GET /api/events/active ───────────────────────────────────────
// Lista eventos activos para la landing pública (index.html)
router.get('/events/active',
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('events')
      .select('id, name, event_date, venue, capacity, tickets_sold, price_gtq, image_url, images, description, ticket_tiers(id, capacity, tickets_sold)')
      .eq('active', true)
      .order('event_date', { ascending: true });

    if (error) return res.status(500).json({ error: 'db_error' });

    // Añadir has_tiers y calcular disponibilidad real
    const events = (data || []).map(ev => {
      const tiers = ev.ticket_tiers || [];
      const hasTiers = tiers.length > 0;
      const { ticket_tiers: _, ...evData } = ev;
      return { ...evData, has_tiers: hasTiers };
    });

    return res.json({ events });
  })
);

// ── GET /api/events/:id ─────────────────────────────────────────
router.get('/events/:id',
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('events')
      .select('id, name, event_date, venue, capacity, tickets_sold, price_gtq, image_url, images, description, code_prefix')
      .eq('id', req.params.id)
      .eq('active', true)
      .single();

    if (error || !data) return res.status(404).json({ message: 'Evento no encontrado' });

    // Buscar event_code asociado para el flujo de pago
    const { data: ecData } = await supabase
      .from('event_codes')
      .select('id')
      .eq('event_id', data.id)
      .eq('active', true)
      .limit(1)
      .maybeSingle();

    // Fetch artists assigned to this event
    const { data: artistsData } = await supabase
      .from('event_artists')
      .select('role, sort_order, artist:artists(id, name, bio, genres, photo_url, instagram)')
      .eq('event_id', data.id)
      .order('sort_order', { ascending: true });

    const artists = (artistsData || []).map(row => ({
      ...row.artist,
      role: row.role,
      sort_order: row.sort_order,
    }));

    return res.json({ event: data, event_code_id: ecData ? ecData.id : null, artists });
  })
);


// ── GET /api/order-status/:orderId ─────────────────────────────────
// Polling endpoint — ticket.html uses this after Recurrente checkout.
// Returns { status } always; adds download_token only when order is paid.
// UUID is 128-bit random — safe to expose token on match.
router.get('/order-status/:orderId',
  asyncHandler(async (req, res) => {
    const { orderId } = req.params;

    // Basic UUID format guard
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)) {
      return res.status(400).json({ error: 'invalid_id' });
    }

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('orders')
      .select('id, payment_status')
      .eq('id', orderId)
      .single();

    if (error || !data) return res.status(404).json({ error: 'not_found' });

    if (data.payment_status === 'paid') {
      const { generateDownloadToken } = require('../services/QrService');
      const download_token = generateDownloadToken(orderId);
      return res.json({ status: 'paid', download_token });
    }

    return res.json({ status: data.payment_status });
  })
);

module.exports = router;
