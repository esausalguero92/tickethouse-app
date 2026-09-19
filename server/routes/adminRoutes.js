'use strict';

const path    = require('path');
const multer  = require('multer');
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

// ── Multer (memoria RAM — archivos van directo a Supabase Storage) ────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter(req, file, cb) {
    const ok = /image\/(jpeg|png|webp|gif)/.test(file.mimetype);
    cb(ok ? null : new Error('Solo se permiten imágenes JPG, PNG, WebP o GIF'), ok);
  },
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Decodifica entidades HTML que sanitizeInputs inyecta en campos tipo URL
function decodeHtmlEntities(s) {
  if (!s || typeof s !== 'string') return s;
  return s
    .replace(/&amp;/g,  '&')
    .replace(/&#x2F;/g, '/')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/gi,    (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

async function getActiveEvent(supabase) {
  const { data } = await supabase
    .from('events')
    .select('id, name, event_date, venue, capacity, tickets_sold, price_gtq, active, code_prefix')
    .eq('active', true)
    .order('event_date', { ascending: true })
    .limit(1)
    .maybeSingle();
  return data;
}

// ── POST /api/login ───────────────────────────────────────────────
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

// ── GET /api/admin/orders ─────────────────────────────────────────
router.get('/orders',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { data: orders, error } = await supabase
      .from('orders')
      .select('id, payment_method, payment_status, amount_gtq, quantity, buyer_name, buyer_email, created_at, paid_at, event:events(id, name, event_date)')
      .order('created_at', { ascending: false })
      .limit(500);

    if (error) return res.status(500).json({ error: error.message });

    const orderIds = (orders || []).map(function(o) { return o.id; });
    let ticketsByOrder = {};
    if (orderIds.length) {
      const { data: tks } = await supabase
        .from('tickets')
        .select('order_id, correlative_code, public_code, status')
        .in('order_id', orderIds);
      (tks || []).forEach(function(t) {
        if (!ticketsByOrder[t.order_id]) ticketsByOrder[t.order_id] = [];
        ticketsByOrder[t.order_id].push(t);
      });
    }

    const enriched = (orders || []).map(function(o) {
      const tickets = ticketsByOrder[o.id] || [];
      return Object.assign({}, o, {
        correlative_codes: tickets.map(function(t) { return t.correlative_code; }),
        public_codes:      tickets.map(function(t) { return t.public_code; }).filter(Boolean),
      });
    });

    return res.json({ orders: enriched });
  })
);

// ── GET /api/admin/tickets ────────────────────────────────────────
router.get('/tickets',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { data: tickets, error } = await supabase
      .from('tickets')
      .select('id, correlative_code, public_code, correlative_num, status, created_at, redeemed_at, order_id, order:orders(buyer_name, buyer_email), event:events(id, name, event_date)')
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

// ── GET /api/admin/event-summary ──────────────────────────────────
router.get('/event-summary',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const event = await getActiveEvent(supabase);
    if (!event) return res.json({ event_id: null, event_name: null, max_capacity: 0, tickets_sold: 0, paid_orders: 0, redeemed_tickets: 0, redeemed_today: 0 });

    try {
      const { data: rpcData, error: rpcErr } = await supabase.rpc('rpc_event_summary_v2', { p_event_id: event.id });
      if (!rpcErr && rpcData && !rpcData.error) {
        return res.json(Object.assign({}, rpcData, { event_name: event.name, max_capacity: event.capacity }));
      }
    } catch (e) {}

    const results = await Promise.all([
      supabase.from('orders').select('*', { count: 'exact', head: true }).eq('event_id', event.id).eq('payment_status', 'paid'),
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
      paid_orders: results[0].count || 0, redeemed_tickets: results[1].count || 0,
      redeemed_today: redeemedToday || 0,
    });
  })
);

// ════════════════════════════════════════════════════════════════════
// EVENTOS — CRUD completo
// ════════════════════════════════════════════════════════════════════

// GET /api/admin/events
router.get('/events',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('events')
      .select('id, name, event_date, venue, capacity, tickets_sold, price_gtq, active, code_prefix, image_url, images, location_url, created_at')
      .order('event_date', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ events: data || [] });
  })
);

// POST /api/admin/events
router.post('/events',
  requireAdmin,
  body('name').trim().isLength({ min: 2, max: 200 }).withMessage('Nombre requerido (2-200 chars)'),
  body('event_date').isISO8601().withMessage('event_date debe ser fecha ISO'),
  body('venue').trim().isLength({ min: 2, max: 300 }).withMessage('venue requerido'),
  body('capacity').isInt({ min: 1 }).withMessage('capacity debe ser entero > 0'),
  body('price_gtq').isFloat({ gt: 0 }).withMessage('price_gtq debe ser > 0'),
  body('max_per_order').optional().isInt({ min: 1, max: 10 }).withMessage('max_per_order 1-10'),
  body('code_prefix').optional().trim().isLength({ min: 2, max: 4 }).withMessage('code_prefix 2-4 chars'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { name, event_date, venue, capacity, price_gtq, max_per_order, code_prefix, description, image_url, location_url } = req.body;

    // Generar prefix automático si no se envía
    const prefix = code_prefix
      ? String(code_prefix).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4)
      : name.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4) || 'EVT';

    const insert = {
      name:          name.trim(),
      event_date,
      venue:         venue.trim(),
      capacity:      parseInt(capacity, 10),
      price_gtq:     parseFloat(price_gtq),
      max_per_order: max_per_order ? parseInt(max_per_order, 10) : 10,
      code_prefix:   prefix,
      active:        false, // inactivo por defecto hasta que el admin lo active
      tickets_sold:  0,
    };

    if (description)  insert.description  = String(description).slice(0, 1000);
    if (image_url)    insert.image_url    = String(image_url).slice(0, 500);
    if (location_url) insert.location_url = decodeHtmlEntities(String(location_url)).slice(0, 500);

    const { data, error } = await supabase.from('events').insert(insert).select().single();
    if (error) {
      console.error('[admin.events.create]', error);
      return res.status(500).json({ error: error.message });
    }

    // Auto-crear event_code con el code_prefix del evento
    const { error: ecErr } = await supabase.from('event_codes').insert({
      event_id: data.id,
      code:     data.code_prefix,
      active:   false, // se activa cuando el evento se publica
    });
    if (ecErr) console.warn('[admin.events.create] event_code no creado:', ecErr.message);

    return res.status(201).json({ ok: true, event: data });
  })
);

// PATCH /api/admin/events/:id
router.patch('/events/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id_invalido' });

    const allowed = ['name', 'event_date', 'venue', 'capacity', 'price_gtq', 'max_per_order', 'code_prefix', 'description', 'image_url', 'images', 'location_url'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        updates[key] = req.body[key];
      }
    }

    if (updates.code_prefix) {
      updates.code_prefix = String(updates.code_prefix).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    }
    if (updates.max_per_order) {
      updates.max_per_order = Math.min(10, Math.max(1, parseInt(updates.max_per_order, 10)));
    }
    if (updates.location_url !== undefined) {
      updates.location_url = updates.location_url
        ? decodeHtmlEntities(String(updates.location_url)).slice(0, 500)
        : null;
    }

    if (!Object.keys(updates).length) return res.status(400).json({ error: 'no_fields_to_update' });

    const { data, error } = await supabase.from('events').update(updates).eq('id', id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    if (!data)  return res.status(404).json({ error: 'event_not_found' });
    return res.json({ ok: true, event: data });
  })
);

// PATCH /api/admin/events/:id/status  — activar / desactivar
router.patch('/events/:id/status',
  requireAdmin,
  body('active').isBoolean().withMessage('active debe ser boolean'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id_invalido' });

    const active = req.body.active === true || req.body.active === 'true';
    // status sincronizado con active: published ↔ draft
    const status = active ? 'published' : 'draft';

    // Antes de publicar: verificar que el evento tiene code_prefix
    if (active) {
      const { data: evCheck } = await supabase
        .from('events')
        .select('code_prefix')
        .eq('id', id)
        .single();
      if (!evCheck || !evCheck.code_prefix || !evCheck.code_prefix.trim()) {
        return res.status(400).json({
          error: 'missing_code_prefix',
          message: 'El evento debe tener un prefijo (code_prefix) antes de publicarse.',
        });
      }
    }

    const { data, error } = await supabase
      .from('events')
      .update({ active, status })
      .eq('id', id)
      .select('id, name, active, status, code_prefix')
      .single();

    if (error) return res.status(500).json({ error: error.message });
    if (!data)  return res.status(404).json({ error: 'event_not_found' });

    // Sincronizar event_code.active con el evento
    await supabase
      .from('event_codes')
      .update({ active })
      .eq('event_id', id);

    // Si se activa y no existe event_code, crearlo ahora
    if (active) {
      const { data: existingEc } = await supabase
        .from('event_codes')
        .select('id')
        .eq('event_id', id)
        .maybeSingle();
      if (!existingEc) {
        const { error: ecErr } = await supabase.from('event_codes').insert({
          event_id: data.id,
          code:     data.code_prefix,
          active:   true,
        });
        if (ecErr) {
          // Revertir: despublicar el evento si no se pudo crear el event_code
          await supabase.from('events').update({ active: false, status: 'draft' }).eq('id', id);
          return res.status(500).json({
            error: 'event_code_creation_failed',
            message: 'No se pudo crear el código de evento. El evento fue regresado a borrador.',
          });
        }
      }
    }

    return res.json({ ok: true, event: data });
  })
);

// PATCH /api/admin/events/:id/archive — desactiva el evento (soft delete)
// Úsalo cuando el evento tiene órdenes reales que no deben borrarse.
router.patch('/events/:id/archive',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id_invalido' });

    const { error } = await supabase
      .from('events')
      .update({ active: false })
      .eq('id', id);

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true, archived: true });
  })
);

// DELETE /api/admin/events/:id
// Bloquea si tiene órdenes PAGADAS (registros financieros reales).
// Si solo tiene órdenes pendientes/canceladas, borra en cascada limpiamente.
router.delete('/events/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id_invalido' });

    // 1. Bloquear si hay órdenes pagadas (no borrar registros financieros)
    const { count: paidCount } = await supabase
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .eq('event_id', id)
      .eq('status', 'paid');

    if (paidCount && paidCount > 0) {
      return res.status(409).json({
        error: 'event_has_paid_orders',
        message: 'Este evento tiene órdenes pagadas. Usa "Archivar" en su lugar para ocultarlo sin perder los registros.',
        paid_orders: paidCount,
      });
    }

    // 2. Cascada: borrar registros dependientes sin pagos reales
    await supabase.from('tickets').delete().eq('event_id', id);
    await supabase.from('orders').delete().eq('event_id', id);
    await supabase.from('event_codes').delete().eq('event_id', id);
    await supabase.from('event_artists').delete().eq('event_id', id);

    // 3. Borrar el evento
    const { error } = await supabase.from('events').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true });
  })
);

// ── GET /api/admin/test-email ─────────────────────────────────────
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
router.get('/cortesia',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { generateDownloadToken } = require('../services/QrService');

    // Si viene event_id en query, usar ese evento; si no, el activo
    let event;
    if (req.query.event_id) {
      const { data } = await supabase
        .from('events')
        .select('id, name, event_date, venue, capacity, tickets_sold, price_gtq, active, code_prefix')
        .eq('id', req.query.event_id)
        .maybeSingle();
      event = data;
    } else {
      event = await getActiveEvent(supabase);
    }
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
router.post('/cortesia/bulk',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { generateDownloadToken } = require('../services/QrService');
    const crypto = require('crypto');

    // Si viene event_id en el body, usar ese evento; si no, el activo
    let event;
    if (req.body.event_id) {
      const { data } = await supabase
        .from('events')
        .select('id, name, event_date, venue, capacity, tickets_sold, price_gtq, active, code_prefix')
        .eq('id', req.body.event_id)
        .maybeSingle();
      event = data;
    } else {
      event = await getActiveEvent(supabase);
    }
    if (!event) return res.status(400).json({ error: 'no_active_event' });

    let rawNames = req.body.names || [];
    if (typeof rawNames === 'string') rawNames = rawNames.split('\n');
    const names = rawNames.map(function(n) { return String(n || '').trim(); }).filter(function(n) { return n.length > 0; });
    if (!names.length) return res.status(400).json({ error: 'names_required' });

    function cleanStr(s) {
      return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z]/g, '').toUpperCase();
    }
    function generateCode(firstName, lastName) {
      const a = cleanStr(firstName).charAt(0) || 'G';
      const b = cleanStr(lastName).charAt(0)  || 'X';
      const d = String(crypto.randomInt(100, 1000)); // crypto, no Math.random
      return a + b + d;
    }

    const results = [];
    for (const fullName of names) {
      const parts     = fullName.trim().split(/\s+/);
      const firstName = parts[0]  || fullName;
      const lastName  = parts.slice(1).join(' ') || '';
      try {
        const { data: guest, error: gErr } = await supabase
          .from('guests').insert({ first_name: firstName, last_name: lastName }).select('id').single();
        if (gErr) { results.push({ name: fullName, ok: false, error: gErr.message }); continue; }

        let code = '';
        for (let i = 0; i < 5; i++) {
          const candidate = generateCode(firstName, lastName);
          const { data: existing } = await supabase.from('access_codes').select('id').eq('code', candidate).maybeSingle();
          if (!existing) { code = candidate; break; }
        }
        if (!code) { results.push({ name: fullName, ok: false, error: 'code_collision' }); continue; }

        const { error: cErr } = await supabase.from('access_codes')
          .insert({ code, event_id: event.id, guest_id: guest.id, status: 'active' });
        if (cErr) { results.push({ name: fullName, ok: false, error: cErr.message }); continue; }

        const { data: rpcData, error: rpcErr } = await supabase.rpc('rpc_create_complimentary_order', { p_code: code });
        if (rpcErr || !rpcData || rpcData.error) {
          results.push({ name: fullName, ok: false, error: (rpcData && rpcData.error) || 'order_failed' }); continue;
        }

        const ticketResult = await issueTickets({
          orderId:     rpcData.order_id, eventId: event.id, buyerId: null,
          buyerName:   fullName, buyerEmail: null, quantity: 1,
          eventName:   event.name || 'TicketHouse', eventDate: event.event_date || null,
          eventVenue:  event.venue || '', eventPrefix: event.code_prefix || 'TH',
        });

        results.push({ name: fullName, ok: true, code, download_token: generateDownloadToken(rpcData.order_id), correlative: ticketResult.correlativeCodes && ticketResult.correlativeCodes[0] || null, public_code: ticketResult.publicCodes && ticketResult.publicCodes[0] || null });
      } catch (e) {
        results.push({ name: fullName, ok: false, error: e.message });
      }
    }
    return res.json({ ok: true, event: { id: event.id, name: event.name }, results });
  })
);

// ── POST /api/admin/complimentary/:code ───────────────────────────
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

    const guestName = [ctx.guest && ctx.guest.first_name, ctx.guest && ctx.guest.last_name].filter(Boolean).join(' ').trim() || 'Invitado/a';
    try {
      const result = await issueTickets({
        orderId: rpcData.order_id, eventId: ctx.event_id, buyerId: null,
        buyerName: guestName, buyerEmail: (ctx.guest && ctx.guest.email) || null, quantity: 1,
        eventName: (ctx.event && ctx.event.name) || 'TicketHouse',
        eventDate: (ctx.event && ctx.event.event_date) || null,
        eventVenue: (ctx.event && ctx.event.venue) || '',
        eventPrefix: (ctx.event && ctx.event.code_prefix) || 'TH',
      });
      return res.json({ ok: true, code: ctx.code, guest: guestName, correlative_codes: result.correlativeCodes, public_codes: result.publicCodes });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  })
);

// ═══════════════ Discount Codes ═══════════════════════════════════

router.get('/discount-codes', requireAdmin, asyncHandler(async (req, res) => {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('discount_codes')
    .select('id, code, description, discount_type, discount_value, max_uses, uses_count, active, expires_at, event_id, created_at, event:events(name)')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ discount_codes: data || [] });
}));

router.post('/discount-codes',
  requireAdmin,
  body('code').trim().toUpperCase().isLength({ min: 2, max: 50 }).withMessage('code requerido'),
  body('discount_type').isIn(['percent', 'fixed']).withMessage('percent o fixed'),
  body('discount_value').isFloat({ gt: 0 }).withMessage('discount_value > 0'),
  body('max_uses').optional({ nullable: true }).isInt({ min: 1 }),
  body('expires_at').optional({ nullable: true }).isISO8601(),
  validateRequest,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { code, description, discount_type, discount_value, max_uses, expires_at, event_id } = req.body;
    const insert = {
      code: code.trim().toUpperCase(), description: description || null,
      discount_type, discount_value: parseFloat(discount_value),
      max_uses: max_uses ? parseInt(max_uses, 10) : null,
      expires_at: expires_at || null, event_id: event_id || null, active: true,
    };
    const { data, error } = await supabase.from('discount_codes').insert(insert).select().single();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'code_already_exists' });
      return res.status(500).json({ error: error.message });
    }
    return res.status(201).json({ ok: true, discount_code: data });
  })
);

router.patch('/discount-codes/:id/toggle', requireAdmin, asyncHandler(async (req, res) => {
  const supabase = getSupabase();
  const { data: current, error: fetchErr } = await supabase.from('discount_codes').select('id, active').eq('id', req.params.id).maybeSingle();
  if (fetchErr || !current) return res.status(404).json({ error: 'not_found' });
  const { data, error } = await supabase.from('discount_codes').update({ active: !current.active }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true, discount_code: data });
}));

router.delete('/discount-codes/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { error } = await getSupabase().from('discount_codes').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
}));


// ── POST /api/admin/events/:id/images — sube imagen a Supabase Storage ──
router.post('/events/:id/images',
  requireAdmin,
  upload.single('image'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return res.status(400).json({ error: 'id_invalido' });
    }
    if (!req.file) return res.status(400).json({ error: 'no_file' });

    const supabase = getSupabase();
    const ext  = req.file.mimetype.split('/')[1].replace('jpeg', 'jpg');
    const name = `${id}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    // Subir a Storage
    const { error: uploadErr } = await supabase.storage
      .from('event-images')
      .upload(name, req.file.buffer, {
        contentType:  req.file.mimetype,
        cacheControl: '3600',
        upsert:       false,
      });

    if (uploadErr) {
      console.error('[admin.images.upload]', uploadErr);
      return res.status(500).json({ error: uploadErr.message });
    }

    // Obtener URL pública
    const { data: { publicUrl } } = supabase.storage
      .from('event-images')
      .getPublicUrl(name);

    // Agregar URL al array images[] en el evento
    const { data: ev, error: fetchErr } = await supabase
      .from('events').select('images, image_url').eq('id', id).single();
    if (fetchErr) return res.status(404).json({ error: 'event_not_found' });

    const currentImages = Array.isArray(ev.images) ? ev.images : [];
    const newImages = [...currentImages, publicUrl];

    await supabase.from('events').update({
      images:    newImages,
      image_url: newImages[0], // primera imagen = imagen principal
    }).eq('id', id);

    return res.json({ ok: true, url: publicUrl, images: newImages });
  })
);

// DELETE /api/admin/events/:id/images — elimina imagen del array y del Storage
router.delete('/events/:id/images',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { url } = req.body;
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url_requerido' });

    const supabase = getSupabase();

    // Extraer path relativo dentro del bucket
    // publicUrl: https://{project}.supabase.co/storage/v1/object/public/event-images/{path}
    const marker = '/event-images/';
    const markerIdx = url.indexOf(marker);
    if (markerIdx !== -1) {
      const storagePath = url.slice(markerIdx + marker.length);
      await supabase.storage.from('event-images').remove([storagePath]);
    }

    // Quitar del array
    const { data: ev } = await supabase.from('events').select('images').eq('id', id).single();
    const newImages = (Array.isArray(ev?.images) ? ev.images : []).filter(u => u !== url);

    await supabase.from('events').update({
      images:    newImages,
      image_url: newImages[0] || null,
    }).eq('id', id);

    return res.json({ ok: true, images: newImages });
  })
);


// ════════════════════════════════════════════════════════════════════
// ARTISTS — CRUD + photo upload + event assignment
// ════════════════════════════════════════════════════════════════════

// GET /api/admin/artists
router.get('/artists',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('artists')
      .select('id, name, bio, genres, photo_url, instagram, created_at')
      .order('name', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ artists: data || [] });
  })
);

// POST /api/admin/artists  (multipart/form-data — photo opcional)
router.post('/artists',
  requireAdmin,
  upload.single('photo'),
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { name, bio, genres, instagram } = req.body;
    if (!name || String(name).trim().length < 1) {
      return res.status(400).json({ error: 'name_required' });
    }

    let photo_url = null;
    if (req.file) {
      const ext  = req.file.mimetype.split('/')[1].replace('jpeg', 'jpg');
      const path = `artists/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from('event-images')
        .upload(path, req.file.buffer, { contentType: req.file.mimetype, cacheControl: '3600' });
      if (!upErr) {
        const { data: { publicUrl } } = supabase.storage.from('event-images').getPublicUrl(path);
        photo_url = publicUrl;
      }
    }

    let parsedGenres = [];
    if (genres) {
      try { parsedGenres = typeof genres === 'string' ? JSON.parse(genres) : genres; }
      catch { parsedGenres = String(genres).split(',').map(g => g.trim()).filter(Boolean); }
    }

    const insert = {
      name:      String(name).trim().slice(0, 200),
      bio:       bio ? String(bio).trim().slice(0, 1000) : null,
      genres:    Array.isArray(parsedGenres) ? parsedGenres.slice(0, 10) : [],
      instagram: instagram ? String(instagram).trim().slice(0, 100) : null,
      photo_url,
    };

    const { data, error } = await supabase.from('artists').insert(insert).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ ok: true, artist: data });
  })
);

// PATCH /api/admin/artists/:id
router.patch('/artists/:id',
  requireAdmin,
  upload.single('photo'),
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id_invalido' });

    const updates = {};
    if (req.body.name)      updates.name      = String(req.body.name).trim().slice(0, 200);
    if (req.body.bio !== undefined) updates.bio = req.body.bio ? String(req.body.bio).trim().slice(0, 1000) : null;
    if (req.body.instagram !== undefined) updates.instagram = req.body.instagram ? String(req.body.instagram).trim().slice(0, 100) : null;
    if (req.body.genres !== undefined) {
      try { updates.genres = typeof req.body.genres === 'string' ? JSON.parse(req.body.genres) : req.body.genres; }
      catch { updates.genres = String(req.body.genres).split(',').map(g => g.trim()).filter(Boolean); }
    }

    if (req.file) {
      const ext  = req.file.mimetype.split('/')[1].replace('jpeg', 'jpg');
      const path = `artists/${id}-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from('event-images')
        .upload(path, req.file.buffer, { contentType: req.file.mimetype, cacheControl: '3600', upsert: true });
      if (!upErr) {
        const { data: { publicUrl } } = supabase.storage.from('event-images').getPublicUrl(path);
        updates.photo_url = publicUrl;
      }
    }

    if (!Object.keys(updates).length) return res.status(400).json({ error: 'no_fields' });

    const { data, error } = await supabase.from('artists').update(updates).eq('id', id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    if (!data)  return res.status(404).json({ error: 'artist_not_found' });
    return res.json({ ok: true, artist: data });
  })
);

// DELETE /api/admin/artists/:id
router.delete('/artists/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id_invalido' });
    // CASCADE in event_artists removes assignments automatically
    const { error } = await supabase.from('artists').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true });
  })
);

// GET /api/admin/events/:id/artists — list assigned artists for an event
router.get('/events/:id/artists',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id_invalido' });
    const { data, error } = await supabase
      .from('event_artists')
      .select('role, sort_order, artist:artists(id, name, bio, genres, photo_url, instagram)')
      .eq('event_id', id)
      .order('sort_order', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ artists: (data || []).map(row => ({ ...row.artist, role: row.role, sort_order: row.sort_order })) });
  })
);

// POST /api/admin/events/:id/artists — assign artist to event
router.post('/events/:id/artists',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id_invalido' });
    const { artist_id, role, sort_order } = req.body;
    if (!artist_id || !UUID_RE.test(artist_id)) return res.status(400).json({ error: 'artist_id_invalido' });
    const { error } = await supabase.from('event_artists').upsert({
      event_id:   id,
      artist_id,
      role:       role || 'performer',
      sort_order: sort_order != null ? parseInt(sort_order, 10) : 0,
    }, { onConflict: 'event_id,artist_id' });
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true });
  })
);

// DELETE /api/admin/events/:id/artists/:artistId — remove artist from event
router.delete('/events/:id/artists/:artistId',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { id, artistId } = req.params;
    if (!UUID_RE.test(id) || !UUID_RE.test(artistId)) return res.status(400).json({ error: 'id_invalido' });
    const { error } = await supabase.from('event_artists')
      .delete().eq('event_id', id).eq('artist_id', artistId);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true });
  })
);


// ── POST /api/admin/orders/:id/reissue ───────────────────────────────────────
// Re-emite tickets para una orden que ya fue pagada pero cuyo webhook falló.
// Solo ejecuta si el payment_status es 'paid' (no modifica nada del cobro).
// Útil cuando Recurrente cobró pero el webhook no llegó correctamente.
router.post('/orders/:id/reissue',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id_invalido' });

    // Buscar la orden con datos del evento
    const { data: order, error: oErr } = await supabase
      .from('orders')
      .select('id, event_id, buyer_id, buyer_name, buyer_email, quantity, payment_status, event:events(name, event_date, venue, code_prefix)')
      .eq('id', id)
      .maybeSingle();

    if (oErr || !order) return res.status(404).json({ error: 'orden_no_encontrada' });

    // Solo permitir re-emisión si el pago ya está confirmado
    if (order.payment_status !== 'paid') {
      return res.status(409).json({
        error: 'orden_no_pagada',
        payment_status: order.payment_status,
        message: 'Solo se pueden re-emitir órdenes con payment_status=paid',
      });
    }

    // Verificar que no tenga tickets ya emitidos
    const { data: existingTickets } = await supabase
      .from('tickets')
      .select('id, correlative_code')
      .eq('order_id', id);

    if (existingTickets && existingTickets.length > 0) {
      return res.status(409).json({
        error: 'tickets_ya_emitidos',
        tickets: existingTickets.map(t => t.correlative_code),
        message: 'Esta orden ya tiene tickets emitidos.',
      });
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
        eventName:   (order.event && order.event.name)        || 'TicketHouse',
        eventDate:   (order.event && order.event.event_date)  || null,
        eventVenue:  (order.event && order.event.venue)       || '',
        eventPrefix: (order.event && order.event.code_prefix) || 'TH',
      });
    } catch (e) {
      console.error('[admin.reissue] Error emitiendo tickets:', e.message);
      return res.status(500).json({ error: 'ticket_issue_failed', detail: e.message });
    }

    console.log('[admin.reissue] Tickets re-emitidos para orden:', id, '→', result.publicCodes);
    return res.json({
      ok: true,
      orderId: id,
      correlativeCodes: result.correlativeCodes,
      publicCodes:      result.publicCodes,
      emailSentTo:      order.buyer_email,
    });
  })
);

module.exports = router;
