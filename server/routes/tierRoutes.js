'use strict';
/**
 * Rutas para Localidades (ticket_tiers) y Fases (tier_phases).
 *
 * Todo montado en /api  (un solo mount en server.js):
 *   Públicas:
 *     GET  /api/events/:eventId/tiers
 *
 *   Admin (/api/admin/... — el router usa /admin/ como prefijo interno):
 *     GET    /api/admin/events/:eventId/tiers
 *     POST   /api/admin/events/:eventId/tiers
 *     PUT    /api/admin/tiers/:tierId
 *     DELETE /api/admin/tiers/:tierId
 *     POST   /api/admin/tiers/:tierId/phases
 *     PUT    /api/admin/phases/:phaseId
 *     DELETE /api/admin/phases/:phaseId
 */

const { Router } = require('express');
const { body, param } = require('express-validator');
const { getSupabase } = require('../db/supabase');
const { asyncHandler } = require('../middleware/errorHandler');
const { validateRequest } = require('../middleware/security');
const { requireAdmin } = require('../middleware/auth');

const router = Router();

const uuidParam = (name) =>
  param(name).isUUID().withMessage(`${name} debe ser UUID válido`);

// ══════════════════════════════════════════════════════════════════
// RUTA PÚBLICA
// ══════════════════════════════════════════════════════════════════

/**
 * GET /api/events/:eventId/tiers
 * Devuelve las localidades con su fase activa (para evento.html).
 */
router.get('/events/:eventId/tiers',
  uuidParam('eventId'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { eventId } = req.params;

    const { data, error } = await supabase.rpc('rpc_get_event_tiers', {
      p_event_id: eventId,
    });

    if (error) {
      console.error('[tierRoutes.public.tiers]', error);
      return res.status(500).json({ error: 'db_error' });
    }

    // data es JSONB array desde el RPC; parsearlo si llega como string
    let tiers = data;
    if (typeof data === 'string') {
      try { tiers = JSON.parse(data); } catch (e) { tiers = []; }
    }

    return res.json({ tiers: Array.isArray(tiers) ? tiers : [] });
  })
);

// ══════════════════════════════════════════════════════════════════
// RUTAS ADMIN  (prefijo /admin/ dentro del router)
// ══════════════════════════════════════════════════════════════════

/**
 * GET /api/admin/events/:eventId/tiers
 * Lista completa de tiers + todas sus fases (panel admin).
 * Responde { tiers: [...] }
 */
router.get('/admin/events/:eventId/tiers',
  requireAdmin,
  uuidParam('eventId'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { eventId } = req.params;

    const { data: tiers, error } = await supabase
      .from('ticket_tiers')
      .select(`
        id, name, description, color, capacity, tickets_sold,
        sort_order, created_at,
        tier_phases(
          id, name, price_gtq, capacity, tickets_sold,
          starts_at, ends_at, is_active, sort_order, created_at
        )
      `)
      .eq('event_id', eventId)
      .order('sort_order', { ascending: true });

    if (error) {
      console.error('[tierRoutes.admin.list]', error);
      return res.status(500).json({ error: 'db_error' });
    }

    return res.json({ tiers: tiers || [] });
  })
);

/**
 * POST /api/admin/events/:eventId/tiers
 * Crea una nueva localidad para el evento.
 */
router.post('/admin/events/:eventId/tiers',
  requireAdmin,
  uuidParam('eventId'),
  body('name').trim().isLength({ min: 1, max: 80 }).withMessage('name requerido (1-80 chars)'),
  body('description').optional().trim().isLength({ max: 300 }),
  body('color').optional().trim().matches(/^#[0-9A-Fa-f]{6}$/).withMessage('color debe ser hex #RRGGBB'),
  body('capacity').isInt({ min: 1 }).withMessage('capacity debe ser entero > 0'),
  body('sort_order').optional().isInt({ min: 0 }),
  validateRequest,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { eventId } = req.params;
    const { name, description, color, capacity, sort_order } = req.body;

    const { data: event } = await supabase
      .from('events')
      .select('id')
      .eq('id', eventId)
      .maybeSingle();

    if (!event) return res.status(404).json({ error: 'event_not_found' });

    const { data: tier, error } = await supabase
      .from('ticket_tiers')
      .insert({
        event_id:    eventId,
        name:        name.trim(),
        description: description ? description.trim() : null,
        color:       color || '#6366f1',
        capacity:    parseInt(capacity, 10),
        sort_order:  sort_order !== undefined ? parseInt(sort_order, 10) : 0,
      })
      .select()
      .single();

    if (error) {
      console.error('[tierRoutes.admin.createTier]', error);
      return res.status(500).json({ error: 'db_error' });
    }

    return res.status(201).json(tier);
  })
);

/**
 * PUT /api/admin/tiers/:tierId
 * Actualiza nombre, color, capacidad o sort_order de una localidad.
 */
router.put('/admin/tiers/:tierId',
  requireAdmin,
  uuidParam('tierId'),
  body('name').optional().trim().isLength({ min: 1, max: 80 }),
  body('description').optional({ nullable: true }).trim().isLength({ max: 300 }),
  body('color').optional().trim().matches(/^#[0-9A-Fa-f]{6}$/),
  body('capacity').optional({ nullable: true }).isInt({ min: 1 }),
  body('sort_order').optional().isInt({ min: 0 }),
  validateRequest,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { tierId } = req.params;

    const allowed = ['name', 'description', 'color', 'capacity', 'sort_order'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'no_fields_to_update' });
    }

    const { data: tier, error } = await supabase
      .from('ticket_tiers')
      .update(updates)
      .eq('id', tierId)
      .select()
      .maybeSingle();

    if (error) {
      console.error('[tierRoutes.admin.updateTier]', error);
      return res.status(500).json({ error: 'db_error' });
    }
    if (!tier) return res.status(404).json({ error: 'tier_not_found' });

    return res.json(tier);
  })
);

/**
 * DELETE /api/admin/tiers/:tierId
 * Elimina la localidad si no tiene tickets vendidos.
 * Si tiene ventas, devuelve error (no se puede eliminar).
 */
router.delete('/admin/tiers/:tierId',
  requireAdmin,
  uuidParam('tierId'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { tierId } = req.params;

    const { data: tier } = await supabase
      .from('ticket_tiers')
      .select('id, tickets_sold')
      .eq('id', tierId)
      .maybeSingle();

    if (!tier) return res.status(404).json({ error: 'tier_not_found' });

    if (tier.tickets_sold > 0) {
      return res.status(409).json({
        error: 'tier_has_sales',
        message: 'No se puede eliminar una localidad con tickets vendidos',
      });
    }

    const { error } = await supabase
      .from('ticket_tiers')
      .delete()
      .eq('id', tierId);

    if (error) {
      console.error('[tierRoutes.admin.deleteTier]', error);
      return res.status(500).json({ error: 'db_error' });
    }

    return res.json({ ok: true });
  })
);

// ── PHASES ─────────────────────────────────────────────────────────

/**
 * POST /api/admin/tiers/:tierId/phases
 * Crea una fase de precio para una localidad.
 */
router.post('/admin/tiers/:tierId/phases',
  requireAdmin,
  uuidParam('tierId'),
  body('name').trim().isLength({ min: 1, max: 80 }).withMessage('name requerido'),
  body('price_gtq').isFloat({ gt: 0 }).withMessage('price_gtq debe ser > 0'),
  body('capacity').optional({ nullable: true }).isInt({ min: 1 }),
  body('starts_at').optional({ nullable: true }).isISO8601(),
  body('ends_at').optional({ nullable: true }).isISO8601(),
  body('is_active').optional().isBoolean(),
  body('bundle_qty').optional().isInt({ min: 1 }).withMessage('bundle_qty debe ser entero >= 1'),
  body('sort_order').optional().isInt({ min: 0 }),
  validateRequest,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { tierId } = req.params;
    const { name, price_gtq, capacity, starts_at, ends_at, is_active, bundle_qty, sort_order } = req.body;

    const { data: tier } = await supabase
      .from('ticket_tiers')
      .select('id')
      .eq('id', tierId)
      .maybeSingle();

    if (!tier) return res.status(404).json({ error: 'tier_not_found' });

    const { data: phase, error } = await supabase
      .from('tier_phases')
      .insert({
        tier_id:    tierId,
        name:       name.trim(),
        price_gtq:  parseFloat(price_gtq),
        capacity:   capacity ? parseInt(capacity, 10) : null,
        starts_at:  starts_at || null,
        ends_at:    ends_at || null,
        is_active:  is_active !== undefined ? Boolean(is_active) : true,
        bundle_qty: bundle_qty !== undefined ? parseInt(bundle_qty, 10) : 1,
        sort_order: sort_order !== undefined ? parseInt(sort_order, 10) : 0,
      })
      .select()
      .single();

    if (error) {
      console.error('[tierRoutes.admin.createPhase]', error);
      return res.status(500).json({ error: 'db_error' });
    }

    return res.status(201).json(phase);
  })
);

/**
 * PUT /api/admin/phases/:phaseId
 * Actualiza una fase (precio, fechas, is_active, etc.).
 */
router.put('/admin/phases/:phaseId',
  requireAdmin,
  uuidParam('phaseId'),
  body('name').optional().trim().isLength({ min: 1, max: 80 }),
  body('price_gtq').optional().isFloat({ gt: 0 }),
  body('capacity').optional({ nullable: true }).isInt({ min: 1 }),
  body('starts_at').optional({ nullable: true }).isISO8601(),
  body('ends_at').optional({ nullable: true }).isISO8601(),
  body('is_active').optional().isBoolean(),
  body('bundle_qty').optional().isInt({ min: 1 }).withMessage('bundle_qty debe ser entero >= 1'),
  body('sort_order').optional().isInt({ min: 0 }),
  validateRequest,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { phaseId } = req.params;

    const allowed = ['name', 'price_gtq', 'capacity', 'starts_at', 'ends_at', 'is_active', 'bundle_qty', 'sort_order'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'no_fields_to_update' });
    }

    const { data: phase, error } = await supabase
      .from('tier_phases')
      .update(updates)
      .eq('id', phaseId)
      .select()
      .maybeSingle();

    if (error) {
      console.error('[tierRoutes.admin.updatePhase]', error);
      return res.status(500).json({ error: 'db_error' });
    }
    if (!phase) return res.status(404).json({ error: 'phase_not_found' });

    return res.json(phase);
  })
);

/**
 * DELETE /api/admin/phases/:phaseId
 * Elimina una fase (hard-delete si sin ventas, desactiva si tiene ventas).
 */
router.delete('/admin/phases/:phaseId',
  requireAdmin,
  uuidParam('phaseId'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { phaseId } = req.params;

    const { data: phase } = await supabase
      .from('tier_phases')
      .select('id, tickets_sold')
      .eq('id', phaseId)
      .maybeSingle();

    if (!phase) return res.status(404).json({ error: 'phase_not_found' });

    if (phase.tickets_sold > 0) {
      // Tiene ventas: desactivar en lugar de eliminar
      const { data: deactivated, error: deErr } = await supabase
        .from('tier_phases')
        .update({ is_active: false })
        .eq('id', phaseId)
        .select()
        .maybeSingle();

      if (deErr) return res.status(500).json({ error: 'db_error' });
      return res.json({ ok: true, deactivated: true, phase: deactivated });
    }

    const { error } = await supabase
      .from('tier_phases')
      .delete()
      .eq('id', phaseId);

    if (error) {
      console.error('[tierRoutes.admin.deletePhase]', error);
      return res.status(500).json({ error: 'db_error' });
    }

    return res.json({ ok: true, deleted: true });
  })
);

module.exports = router;
