'use strict';
/**
 * Party House — Rutas Admin v2.0
 *
 * POST /api/admin/login
 * GET  /api/admin/orders               → lista de pedidos
 * GET  /api/admin/tickets              → lista de entradas emitidas
 * GET  /api/admin/pending-transfers    → transferencias pendientes
 * POST /api/admin/confirm-transfer     → confirmar { order_id }
 * POST /api/admin/reject-transfer      → rechazar { order_id, reason? }
 * GET  /api/admin/event-summary        → resumen evento activo
 * POST /api/admin/test-email
 * POST /api/admin/complimentary/:code  (v1 compat)
 */

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

// ── Helper: evento activo ─────────────────────────────────────────
async function getActiveEvent(supabase) {
  const { data } = await supabase
    .from('events')
    .select('id, name, event_date, venue, max_capacity, tickets_sold, price, active')
    .eq('active', true)
    .order('event_date', { ascending: true })
    .limit(1)
    .maybeSingle();
  return data;
}

// ══════════════════════════════════════════════════════════════════
// POST /api/admin/login
// Body: { password } — user es opcional
// ══════════════════════════════════════════════════════════════════
router.post('/login',
  authLimiter,
  body('password').notEmpty().withMessage('Contraseña requerida'),
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
      query = query.or(`email.eq.${String(user).trim()},full_name.eq.${String(user).trim()}`);
    }

    const { data: users, error } = await query;
    if (error) return res.status(500).json({ error: 'db_error' });

    // Buscar match de password en todos los admins
    let matched = null;
    for (const u of (users || [])) {
      if (u.password_hash && await bcrypt.compare(password, u.password_hash)) {
        matched = u;
        break;
      }
    }

    // Fallback: ADMIN_PASSWORD_HASH en env (funciona aunque no haya usuarios en DB)
    if (!matched && env.ADMIN_PASSWORD_HASH) {
      try {
        const ok = await bcrypt.compare(password, env.ADMIN_PASSWORD_HASH);
        if (ok) {
          matched = (users || [])[0] || {
            id: 'env-admin',
            full_name: env.ADMIN_USERNAME || 'Admin',
            role: 'admin',
          };
        }
      } catch { /* ignorar */ }
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

// ══════════════════════════════════════════════════════════════════
// GET /api/admin/orders — todos los pedidos con correlativos
// ══════════════════════════════════════════════════════════════════
router.get('/orders',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();

    const { data: orders, error } = await supabase
      .from('orders')
      .select(`
        id, payment_method, payment_status, amount_usd, quantity,
        buyer_name, buyer_email, transfer_reference,
        created_at, paid_at,
        event:events(id, name, event_date)
      `)
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) return res.status(500).json({ error: error.message });

    const orderIds = (orders || []).map(o => o.id);
    let ticketsByOrder = {};
    if (orderIds.length) {
      const { data: tks } = await supabase
        .from('tickets')
        .select('order_id, correlative_code, status')
        .in('order_id', orderIds);
      (tks || []).forEach(t => {
        if (!ticketsByOrder[t.order_id]) ticketsByOrder[t.order_id] = [];
        ticketsByOrder[t.order_id].push(t);
      });
    }

    const enriched = (orders || []).map(o => ({
      ...o,
      correlative_codes: (ticketsByOrder[o.id] || []).map(t => t.correlative_code),
    }));

    return res.json({ orders: enriched });
  })
);

// ══════════════════════════════════════════════════════════════════
// GET /api/admin/tickets — entradas emitidas con buyer y estado
// ══════════════════════════════════════════════════════════════════
router.get('/tickets',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();

    const { data: tickets, error } = await supabase
      .from('tickets')
      .select(`
        id, correlative_code, correlative_num, status,
        created_at, redeemed_at, order_id,
        order:orders(buyer_name, buyer_email),
        event:events(id, name, event_date)
      `)
      .order('correlative_num', { ascending: true })
      .limit(1000);

    if (error) return res.status(500).json({ error: error.message });

    // Aplanar buyer_name/buyer_email desde la relación order
    const flat = (tickets || []).map(t => ({
      ...t,
      buyer_name:  t.order?.buyer_name  || null,
      buyer_email: t.order?.buyer_email || null,
    }));

    return res.json({ tickets: flat });
  })
);

// ══════════════════════════════════════════════════════════════════
// GET /api/admin/pending-transfers
// ══════════════════════════════════════════════════════════════════
router.get('/pending-transfers',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('orders')
      .select(`
        id, payment_status, amount_usd, quantity,
        buyer_name, buyer_email, transfer_reference,
        transfer_receipt_url, created_at,
        event:events(id, name, event_date)
      `)
      .in('payment_status', ['pending_transfer', 'awaiting_review', 'pending'])
      .not('transfer_receipt_url', 'is', null)
      .order('created_at', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ transfers: data || [] });
  })
);

// ══════════════════════════════════════════════════════════════════
// POST /api/admin/confirm-transfer
// Body: { order_id }
// ══════════════════════════════════════════════════════════════════
router.post('/confirm-transfer',
  requireAdmin,
  body('order_id').matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).withMessage('order_id UUID inválido'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { order_id } = req.body;

    const { data: order, error: upErr } = await supabase
      .from('orders')
      .update({
        payment_status: 'paid',
        paid_at: new Date().toISOString(),
        reviewed_by: req.admin?.sid || null,
        reviewed_at: new Date().toISOString(),
      })
      .in('payment_status', ['pending_transfer', 'awaiting_review', 'pending'])
      .eq('id', order_id)
      .select('id, event_id, buyer_id, buyer_name, buyer_email, quantity')
      .maybeSingle();

    if (upErr || !order) {
      return res.status(404).json({ error: 'order_not_found_or_not_pending' });
    }

    const { data: event } = await supabase
      .from('events')
      .select('name, event_date, venue')
      .eq('id', order.event_id)
      .maybeSingle();

    let result;
    try {
      result = await issueTickets({
        orderId:    order.id,
        eventId:    order.event_id,
        buyerId:    order.buyer_id,
        buyerName:  order.buyer_name,
        buyerEmail: order.buyer_email,
        quantity:   order.quantity,
        eventName:  event?.name || 'Party House',
        eventDate:  event?.event_date || null,
        eventVenue: event?.venue || '',
      });
    } catch (e) {
      console.error('[admin.confirm-transfer]', e.message);
      return res.status(500).json({ error: 'ticket_issue_failed', detail: e.message });
    }

    return res.json({
      ok: true,
      correlative_codes: result.correlativeCodes,
      quantity: result.quantity,
      download_token: result.downloadToken,
    });
  })
);

// ══════════════════════════════════════════════════════════════════
// POST /api/admin/reject-transfer
// Body: { order_id, reason? }
// ══════════════════════════════════════════════════════════════════
router.post('/reject-transfer',
  requireAdmin,
  body('order_id').matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).withMessage('order_id UUID inválido'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { order_id, reason } = req.body;
    const safeReason = String(reason || '').slice(0, 200);

    const { data, error } = await supabase
      .from('orders')
      .update({
        payment_status: 'rejected',
        reviewed_by: req.admin?.sid || null,
        reviewed_at: new Date().toISOString(),
      })
      .in('payment_status', ['pending_transfer', 'awaiting_review', 'pending'])
      .eq('id', order_id)
      .select('id')
      .maybeSingle();

    if (error || !data) {
      return res.status(404).json({ error: 'order_not_found_or_not_pending' });
    }

    if (safeReason) {
      supabase.from('activity_log').insert({
        actor_id: req.admin?.sid || null,
        action: 'transfer_rejected',
        entity: 'orders',
        entity_id: order_id,
        payload: { reason: safeReason },
      }).then(() => {}, () => {}); // non-critical, ignorar errores
    }

    return res.json({ ok: true });
  })
);

// ══════════════════════════════════════════════════════════════════
// GET /api/admin/event-summary — resumen del evento activo
// ══════════════════════════════════════════════════════════════════
router.get('/event-summary',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();

    const event = await getActiveEvent(supabase);
    if (!event) return res.json({
      event_id: null, event_name: null, max_capacity: 0,
      tickets_sold: 0, paid_orders: 0, pending_transfers: 0,
      redeemed_tickets: 0, redeemed_today: 0,
    });

    // Intentar RPC primero
    try {
      const { data: rpcData, error: rpcErr } = await supabase.rpc('rpc_event_summary_v2', {
        p_event_id: event.id,
      });
      if (!rpcErr && rpcData && !rpcData.error) {
        return res.json({ ...rpcData, event_name: event.name, max_capacity: event.max_capacity });
      }
    } catch { /* fallback */ }

    // Fallback manual
    const [
      { count: paidOrders },
      { count: pendingTransfers },
      { count: redeemedTickets },
    ] = await Promise.all([
      supabase.from('orders').select('*', { count: 'exact', head: true }).eq('event_id', event.id).eq('payment_status', 'paid'),
      supabase.from('orders').select('*', { count: 'exact', head: true }).eq('event_id', event.id).in('payment_status', ['pending_transfer', 'awaiting_review']),
      supabase.from('tickets').select('*', { count: 'exact', head: true }).eq('event_id', event.id).eq('status', 'redeemed'),
    ]);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const { count: redeemedToday } = await supabase
      .from('tickets')
      .select('*', { count: 'exact', head: true })
      .eq('event_id', event.id)
      .eq('status', 'redeemed')
      .gte('redeemed_at', todayStart.toISOString());

    return res.json({
      event_id:          event.id,
      event_name:        event.name,
      max_capacity:      event.max_capacity || 0,
      tickets_sold:      event.tickets_sold || 0,
      paid_orders:       paidOrders || 0,
      pending_transfers: pendingTransfers || 0,
      redeemed_tickets:  redeemedTickets || 0,
      redeemed_today:    redeemedToday || 0,
    });
  })
);

// ══════════════════════════════════════════════════════════════════
// POST /api/admin/test-email
// ══════════════════════════════════════════════════════════════════
router.post('/test-email',
  requireAdmin,
  body('to').isEmail().withMessage('Email inválido'),
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

// ══════════════════════════════════════════════════════════════════
// POST /api/admin/complimentary/:code (v1 compat)
// ══════════════════════════════════════════════════════════════════
router.post('/complimentary/:code',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const code = String(req.params.code || '').toUpperCase().trim();

    const { data: ctx } = await supabase
      .from('access_codes')
      .select('id, code, status, event_id, guest_id, event:events(*), guest:guests(*)')
      .eq('code', code)
      .maybeSingle();

    if (!ctx || ctx.status !== 'active') {
      return res.status(404).json({ error: 'code_not_found_or_inactive' });
    }

    const { data: existing } = await supabase
      .from('orders').select('id, payment_status')
      .eq('code_id', ctx.id).eq('payment_status', 'paid').maybeSingle();
    if (existing) return res.json({ ok: true, skipped: true, reason: 'already_issued' });

    const { data: rpcData, error: rpcErr } = await supabase.rpc('rpc_create_complimentary_order', { p_code: ctx.code });
    if (rpcErr || !rpcData || rpcData.error) {
      return res.status(500).json({ error: rpcData?.error || 'db_order_failed' });
    }

    const guestName = `${ctx.guest?.fir