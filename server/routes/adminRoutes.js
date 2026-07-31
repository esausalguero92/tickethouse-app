'use strict';

const { Router } = require('express');
const { body, param } = require('express-validator');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getSupabase } = require('../db/supabase');
const { requireAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { validateRequest, authLimiter } = require('../middleware/security');
const { issueTickets } = require('../services/TicketService');
const { sendTestEmail } = require('../services/EmailService');
const env = require('../config/env');

const router = Router();

async function getActiveEvent(supabase) {
  const { data } = await supabase
    .from('events')
    .select('id, name, event_date, venue, capacity, tickets_sold, price_usd, active')
    .eq('active', true)
    .order('event_date', { ascending: true })
    .limit(1)
    .maybeSingle();
  return data;
}

router.post('/login',
  authLimiter,
  body('password').notEmpty().withMessage('Contrasena requerida'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { password, user } = req.body;

    let query = supabase
      .from('app_users')
      .select('id, full_name, email, role, active, password_hash')
      .in('role', ['admin', 'master_owner'])
      .eq('active', true);

    if (user && String(user).trim()) {
      // Solo interpolamos si user es estrictamente alfanumérico + caracteres de email/nombre
      // Cualquier otra cosa se ignora y se revisan todos los admins activos
      const safeUser = String(user).trim();
      if (/^[a-zA-Z0-9@._\- ]{1,120}$/.test(safeUser)) {
        query = query.or(`email.eq.${safeUser},full_name.eq.${safeUser}`);
      }
    }

    const { data: users, error } = await query;
    if (error) return res.status(500).json({ error: 'db_error' });

    let matched = null;
    for (const u of (users || [])) {
      if (u.password_hash && await bcrypt.compare(password, u.password_hash)) {
        matched = u;
        break;
      }
    }

    if (!matched && env.ADMIN_PASSWORD_HASH) {
      try {
        const ok = await bcrypt.compare(password, env.ADMIN_PASSWORD_HASH);
        if (ok) {
          matched = (users || [])[0] || { id: 'env-admin', full_name: env.ADMIN_USERNAME || 'Admin', role: 'admin' };
        }
      } catch (e) {}
    }

    if (!matched) return res.status(401).json({ error: 'credenciales_invalidas' });

    const token = jwt.sign(
      { sid: matched.id, role: matched.role, name: matched.full_name },
      env.JWT_SECRET,
      { expiresIn: '12h', algorithm: 'HS256' }
    );

    return res.json({ token, admin: { id: matched.id, name: matched.full_name, role: matched.role } });
  })
);

router.get('/orders',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { data: orders, error } = await supabase
      .from('orders')
      .select('id, payment_method, payment_status, amount_usd, quantity, buyer_name, buyer_email, transfer_reference, created_at, paid_at, event:events(id, name, event_date)')
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) return res.status(500).json({ error: error.message });

    const orderIds = (orders || []).map(function(o) { return o.id; });
    let ticketsByOrder = {};
    if (orderIds.length) {
      const { data: tks } = await supabase
        .from('tickets').select('order_id, correlative_code, status').in('order_id', orderIds);
      (tks || []).forEach(function(t) {
        if (!ticketsByOrder[t.order_id]) ticketsByOrder[t.order_id] = [];
        ticketsByOrder[t.order_id].push(t);
      });
    }

    const enriched = (orders || []).map(function(o) {
      return Object.assign({}, o, { correlative_codes: (ticketsByOrder[o.id] || []).map(function(t) { return t.correlative_code; }) });
    });

    return res.json({ orders: enriched });
  })
);

router.get('/tickets',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { data: tickets, error } = await supabase
      .from('tickets')
      .select('id, correlative_code, correlative_num, status, created_at, redeemed_at, order_id, order:orders(buyer_name, buyer_email), event:events(id, name, event_date)')
      .order('correlative_num', { ascending: true })
      .limit(1000);

    if (error) return res.status(500).json({ error: error.message });

    const flat = (tickets || []).map(function(t) {
      return Object.assign({}, t, {
        buyer_name:  t.order && t.order.buyer_name  ? t.order.buyer_name  : null,
        buyer_email: t.order && t.order.buyer_email ? t.order.buyer_email : null,
      });
    });

    return res.json({ tickets: flat });
  })
);

router.get('/pending-transfers',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('orders')
      .select('id, payment_status, amount_usd, quantity, buyer_name, buyer_email, transfer_reference, transfer_receipt_url, created_at, event:events(id, name, event_date)')
      .in('payment_status', ['pending_transfer', 'awaiting_review', 'pending'])
      .not('transfer_receipt_url', 'is', null)
      .order('created_at', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ transfers: data || [] });
  })
);

router.post('/confirm-transfer',
  requireAdmin,
  body('order_id').matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).withMessage('order_id UUID invalido'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { order_id } = req.body;

    const { data: order, error: upErr } = await supabase
      .from('orders')
      .update({ payment_status: 'paid', paid_at: new Date().toISOString(), reviewed_by: (req.admin && req.admin.sid) || null, reviewed_at: new Date().toISOString() })
      .in('payment_status', ['pending_transfer', 'awaiting_review', 'pending'])
      .eq('id', order_id)
      .select('id, event_id, buyer_id, buyer_name, buyer_email, quantity')
      .maybeSingle();

    if (upErr || !order) return res.status(404).json({ error: 'order_not_found_or_not_pending' });

    const { data: event } = await supabase.from('events').select('name, event_date, venue').eq('id', order.event_id).maybeSingle();

    let result;
    try {
      result = await issueTickets({
        orderId: order.id, eventId: order.event_id, buyerId: order.buyer_id,
        buyerName: order.buyer_name, buyerEmail: order.buyer_email, quantity: order.quantity,
        eventName: event && event.name ? event.name : 'Party House',
        eventDate: event && event.event_date ? event.event_date : null,
        eventVenue: event && event.venue ? event.venue : '',
      });
    } catch (e) {
      console.error('[admin.confirm-transfer]', e.message);
      return res.status(500).json({ error: 'ticket_issue_failed', detail: e.message });
    }

    return res.json({ ok: true, correlative_codes: result.correlativeCodes, quantity: result.quantity, download_token: result.downloadToken });
  })
);

router.post('/reject-transfer',
  requireAdmin,
  body('order_id').matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).withMessage('order_id UUID invalido'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { order_id, reason } = req.body;
    const safeReason = String(reason || '').slice(0, 200);

    const { data, error } = await supabase
      .from('orders')
      .update({ payment_status: 'rejected', reviewed_by: (req.admin && req.admin.sid) || null, reviewed_at: new Date().toISOString() })
      .in('payment_status', ['pending_transfer', 'awaiting_review', 'pending'])
      .eq('id', order_id).select('id').maybeSingle();

    if (error || !data) return res.status(404).json({ error: 'order_not_found_or_not_pending' });

    if (safeReason) {
      supabase.from('activity_log').insert({
        actor_id: (req.admin && req.admin.sid) || null,
        action: 'transfer_rejected', entity: 'orders', entity_id: order_id,
        payload: { reason: safeReason },
      }).then(function() {}, function() {});
    }

    return res.json({ ok: true });
  })
);

router.get('/event-summary',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const event = await getActiveEvent(supabase);
    if (!event) return res.json({ event_id: null, event_name: null, max_capacity: 0, tickets_sold: 0, paid_orders: 0, pending_transfers: 0, redeemed_tickets: 0, redeemed_today: 0 });

    try {
      const { data: rpcData, error: rpcErr } = await supabase.rpc('rpc_event_summary_v2', { p_event_id: event.id });
      if (!rpcErr && rpcData && !rpcData.error) {
        return res.json(Object.assign({}, rpcData, { event_name: event.name, max_capacity: event.capacity }));
      }
    } catch (e) {}

    const results = await Promise.all([
      supabase.from('orders').select('*', { count: 'exact', head: true }).eq('event_id', event.id).eq('payment_status', 'paid'),
      supabase.from('orders').select('*', { count: 'exact', head: true }).eq('event_id', event.id).in('payment_status', ['pending_transfer', 'awaiting_review']),
      supabase.from('tickets').select('*', { count: 'exact', head: true }).eq('event_id', event.id).eq('status', 'redeemed'),
    ]);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const { count: redeemedToday } = await supabase
      .from('tickets').select('*', { count: 'exact', head: true })
      .eq('event_id', event.id).eq('status', 'redeemed').gte('redeemed_at', todayStart.toISOString());

    return res.json({
      event_id: event.id, event_name: event.name,
      max_capacity: event.capacity || 0, tickets_sold: event.tickets_sold || 0,
      paid_orders: results[0].count || 0, pending_transfers: results[1].count || 0,
      redeemed_tickets: results[2].count || 0, redeemed_today: redeemedToday || 0,
    });
  })
);

router.post('/test-email',
  requireAdmin,
  body('to').isEmail().withMessage('Email invalido'),
  validateRequest,
  asyncHandler(async (req, res) => {
    try {
      const result = await sendTestEmail(req.body.to);
      return res.json({ ok: true, messageId: result.messageId });
    } catch (e) {
      return res.status(503).json({ ok: false, error: e.message });
    }
  })
);

// ── GET /api/admin/cortesia ───────────────────────────────────────
// Lista todos los invitados de cortesía del evento activo
router.get('/cortesia',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { generateDownloadToken } = require('../services/QrService');

    const event = await getActiveEvent(supabase);
    if (!event) return res.json({ event: null, guests: [] });

    const { data: codes, error } = await supabase
      .from('access_codes')
      .select('id, code, status, created_at, guest:guests(first_name, last_name, email), orders(id, payment_status)')
      .eq('event_id', event.id)
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    const guests = (codes || []).map(function(c) {
      const orders = Array.isArray(c.orders) ? c.orders : (c.orders ? [c.orders] : []);
      const paidOrder = orders.find(function(o) { return o.payment_status === 'paid'; });
      return {
        id:             c.id,
        code:           c.code,
        status:         c.status,
        created_at:     c.created_at,
        guest_name:     c.guest ? (c.guest.first_name + ' ' + c.guest.last_name).trim() : '—',
        guest_email:    c.guest ? c.guest.email : null,
        ticket_issued:  !!paidOrder,
        download_token: paidOrder ? generateDownloadToken(paidOrder.id) : null,
      };
    });

    return res.json({ event: { id: event.id, name: event.name }, guests });
  })
);

// ── POST /api/admin/cortesia/bulk ─────────────────────────────────
// Crea invitados de cortesía en lote y emite sus tickets
router.post('/cortesia/bulk',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { generateDownloadToken } = require('../services/QrService');

    const event = await getActiveEvent(supabase);
    if (!event) return res.status(400).json({ error: 'no_active_event' });

    // Acepta array de strings o string con saltos de línea
    let rawNames = req.body.names || [];
    if (typeof rawNames === 'string') {
      rawNames = rawNames.split('\n');
    }

    const names = rawNames
      .map(function(n) { return String(n || '').trim(); })
      .filter(function(n) { return n.length > 0; });

    if (!names.length) return res.status(400).json({ error: 'names_required' });

    function cleanStr(s) {
      return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z]/g, '').toUpperCase();
    }

    function generateCode(firstName, lastName) {
      const a = cleanStr(firstName).charAt(0) || 'G';
      const b = cleanStr(lastName).charAt(0)  || 'X';
      const d = String(Math.floor(Math.random() * 900) + 100);
      return a + b + d;
    }

    const results = [];

    for (const fullName of names) {
      const parts     = fullName.trim().split(/\s+/);
      const firstName = parts[0]  || fullName;
      const lastName  = parts.slice(1).join(' ') || '';

      try {
        // 1. Insertar guest
        const { data: guest, error: gErr } = await supabase
          .from('guests')
          .insert({ first_name: firstName, last_name: lastName })
          .select('id')
          .single();

        if (gErr) { results.push({ name: fullName, ok: false, error: gErr.message }); continue; }

        // 2. Generar código único (reintentar si colisiona)
        let code = '';
        for (let i = 0; i < 5; i++) {
          const candidate = generateCode(firstName, lastName);
          const { data: existing } = await supabase.from('access_codes').select('id').eq('code', candidate).maybeSingle();
          if (!existing) { code = candidate; break; }
        }
        if (!code) { results.push({ name: fullName, ok: false, error: 'code_collision' }); continue; }

        // 3. Insertar access_code
        const { error: cErr } = await supabase
          .from('access_codes')
          .insert({ code, event_id: event.id, guest_id: guest.id, status: 'active' });

        if (cErr) { results.push({ name: fullName, ok: false, error: cErr.message }); continue; }

        // 4. Crear orden complimentary y emitir ticket
        const { data: rpcData, error: rpcErr } = await supabase.rpc('rpc_create_complimentary_order', { p_code: code });
        if (rpcErr || !rpcData || rpcData.error) {
          results.push({ name: fullName, ok: false, error: (rpcData && rpcData.error) || 'order_failed' }); continue;
        }

        const ticketResult = await issueTickets({
          orderId:    rpcData.order_id,
          eventId:    event.id,
          buyerId:    null,
          buyerName:  fullName,
          buyerEmail: null,
          quantity:   1,
          eventName:  event.name  || 'Party House',
          eventDate:  event.event_date || null,
          eventVenue: event.venue || '',
        });

        results.push({
          name:           fullName,
          ok:             true,
          code,
          download_token: generateDownloadToken(rpcData.order_id),
          correlative:    ticketResult.correlativeCodes && ticketResult.correlativeCodes[0] || null,
        });

      } catch (e) {
        results.push({ name: fullName, ok: false, error: e.message });
      }
    }

    return res.json({ ok: true, event: { id: event.id, name: event.name }, results });
  })
);

router.post('/complimentary/:code',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const code = String(req.params.code || '').toUpperCase().trim();

    const { data: ctx } = await supabase
      .from('access_codes')
      .select('id, code, status, event_id, guest_id, event:events(*), guest:guests(*)')
      .eq('code', code).maybeSingle();

    if (!ctx || ctx.status !== 'active') return res.status(404).json({ error: 'code_not_found_or_inactive' });

    const { data: existing } = await supabase
      .from('orders').select('id, payment_status').eq('code_id', ctx.id).eq('payment_status', 'paid').maybeSingle();
    if (existing) return res.json({ ok: true, skipped: true, reason: 'already_issued' });

    const { data: rpcData, error: rpcErr } = await supabase.rpc('rpc_create_complimentary_order', { p_code: ctx.code });
    if (rpcErr || !rpcData || rpcData.error) return res.status(500).json({ error: (rpcData && rpcData.error) || 'db_order_failed' });

    const guestName = ((ctx.guest && ctx.guest.first_name) || '' + ' ' + (ctx.guest && ctx.guest.last_name) || '').trim();
    try {
      const result = await issueTickets({
        orderId: rpcData.order_id, eventId: ctx.event_id, buyerId: null,
        buyerName: guestName || 'Invitado/a', buyerEmail: (ctx.guest && ctx.guest.email) || null, quantity: 1,
        eventName: (ctx.event && ctx.event.name) || 'Party House',
        eventDate: (ctx.event && ctx.event.event_date) || null,
        eventVenue: (ctx.event && ctx.event.venue) || '',
      });
      return res.json({ ok: true, code: ctx.code, guest: guestName, correlative_codes: result.correlativeCodes });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  })
);

// ─── Discount Codes ───────────────────────────────────────────────

// GET /api/admin/discount-codes
router.get('/discount-codes',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('discount_codes')
      .select('id, code, description, discount_type, discount_value, max_uses, uses_count, active, expires_at, event_id, created_at, event:events(name)')
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ discount_codes: data || [] });
  })
);

// POST /api/admin/discount-codes
router.post('/discount-codes',
  requireAdmin,
  body('code').trim().toUpperCase().isLength({ min: 2, max: 50 }).withMessage('code requerido (2-50 chars)'),
  body('discount_type').isIn(['percent', 'fixed']).withMessage('discount_type debe ser percent o fixed'),
  body('discount_value').isFloat({ gt: 0 }).withMessage('discount_value debe ser > 0'),
  body('max_uses').optional({ nullable: true }).isInt({ min: 1 }).withMessage('max_uses debe ser entero positivo'),
  body('expires_at').optional({ nullable: true }).isISO8601().withMessage('expires_at debe ser fecha ISO'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { code, description, discount_type, discount_value, max_uses, expires_at, event_id } = req.body;

    const insert = {
      code:           code.trim().toUpperCase(),
      description:    description || null,
      discount_type,
      discount_value: parseFloat(discount_value),
      max_uses:       max_uses ? parseInt(max_uses, 10) : null,
      expires_at:     expires_at || null,
      event_id:       event_id || null,
      active:         true,
    };

    const { data, error } = await supabase.from('discount_codes').insert(insert).select().single();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'code_already_exists' });
      return res.status(500).json({ error: error.message });
    }
    return res.status(201).json({ ok: true, discount_code: data });
  })
);

// PATCH /api/admin/discount-codes/:id/toggle
router.patch('/discount-codes/:id/toggle',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { id } = req.params;

    const { data: current, error: fetchErr } = await supabase
      .from('discount_codes').select('id, active').eq('id', id).maybeSingle();
    if (fetchErr || !current) return res.status(404).json({ error: 'not_found' });

    const { data, error } = await supabase
      .from('discount_codes').update({ active: !current.active }).eq('id', id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true, discount_code: data });
  })
);

// DELETE /api/admin/discount-codes/:id
router.delete('/discount-codes/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { id } = req.params;

    const { error } = await supabase.from('discount_codes').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true });
  })
);

module.exports = router;
