'use strict';
/**
 * Rutas para Localidades (ticket_tiers) y Fases (tier_phases).
 *
 * Regla de capacidad:
 *   event.capacity  = SUM(ticket_tiers.capacity) para ese evento
 *   event.tickets_sold se incrementa automáticamente al confirmar compra.
 *
 * Todo montado en /api  (un solo mount en server.js):
 *   Públicas:
 *     GET  /api/events/:eventId/tiers
 *
 *   Admin (/api/admin/...):
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

/**
 * Recalcula event.capacity = SUM(ticket_tiers.capacity) para un evento.
 * Llamar después de crear, actualizar o eliminar cualquier tier.
 */
async function syncEventCapacity(supabase, eventId) {
  try {
    const { data: tiers } = await supabase
      .from('ticket_tiers')
      .select('capacity')
      .eq('event_id', eventId);

    if (!tiers || tiers.length === 0) return; // Sin tiers, no tocar

    const totalCapacity = tiers.reduce(
      (sum, t) => sum + (parseInt(t.capacity, 10) || 0), 0
    );

    if (totalCapacity > 0) {
      await supabase
        .from('events')
        .update({ capacity: totalCapacity })
        .eq('id', eventId);

      console.log(`[tierRoutes] syncEventCapacity eventId=${eventId} → capacity=${totalCapacity}`);
    }
  } catch (err) {
    console.error('[tierRoutes] syncEventCapacity error:', err.message);
  }
}

// ══════════════════════════════════════════════════════════════════
// RUTA PÚBLICA
// ══════════════════════════════════════════════════════════════════

router.get('/events/:eventId/tiers',
  uuidParam('eventId'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { eventId } = req.params;

    // Query directa en Node — sin RPC, sin SQL manual en Supabase.
    // Lógica de fase activa: is_active=TRUE y (ends_at nulo o en el futuro).
    // starts_at es sólo informativo; el admin activa/desactiva manualmente.
    const { data: tiersRaw, error } = await supabase
      .from('ticket_tiers')
      .select(`
        id, name, description, color, capacity, tickets_sold, sort_order,
        tier_phases(
          id, name, price_gtq, starts_at, ends_at,
          capacity, tickets_sold, bundle_qty, sort_order, is_active
        )
      `)
      .eq('event_id', eventId)
      .order('sort_order', { ascending: true });

    if (error) {
      console.error('[tierRoutes.public.tiers]', error);
      return res.status(500).json({ error: 'db_error' });
    }

    const now = new Date();

    const tiers = (tiersRaw || []).map(function(tier) {
      // Fase activa: is_active=TRUE, ends_at nulo o futuro
      const activePhase = (tier.tier_phases || [])
        .filter(function(p) {
          return p.is_active === true &&
                 (p.ends_at === null || new Date(p.ends_at) > now);
        })
        .sort(function(a, b) {
          if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
          return new Date(a.created_at || 0) - new Date(b.created_at || 0);
        })[0] || null;

      return {
        id:           tier.id,
        name:         tier.name,
        description:  tier.description,
        color:        tier.color,
        capacity:     tier.capacity,
        tickets_sold: tier.tickets_sold,
        sort_order:   tier.sort_order,
        active_phase: activePhase ? {
          id:           activePhase.id,
          name:         activePhase.name,
          price_gtq:    activePhase.price_gtq,
          starts_at:    activePhase.starts_at,
          ends_at:      activePhase.ends_at,
          capacity:     activePhase.capacity,
          tickets_sold: activePhase.tickets_sold,
          bundle_qty:   activePhase.bundle_qty,
        } : null,
      };
    });

    return res.json({ tiers });
  })
);

// ══════════════════════════════════════════════════════════════════
// RUTAS ADMIN
// ══════════════════════════════════════════════════════════════════

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
          starts_at, ends_at, is_active, bundle_qty, sort_order, created_at
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
 * Crea una localidad. Actualiza automáticamente event.capacity.
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

    // Auto-sync: event.capacity = suma de todos los tiers
    await syncEventCapacity(supabase, eventId);

    return res.status(201).json(tier);
  })
);

/**
 * PUT /api/admin/tiers/:tierId
 * Actualiza una localidad. Si cambia capacity, re-sincroniza event.capacity.
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
      .select('id, event_id, name, description, color, capacity, tickets_sold, sort_order')
      .maybeSingle();

    if (error) {
      console.error('[tierRoutes.admin.updateTier]', error);
      return res.status(500).json({ error: 'db_error' });
    }
    if (!tier) return res.status(404).json({ error: 'tier_not_found' });

    // Si se cambió la capacidad, re-sincronizar event.capacity
    if (updates.capacity !== undefined && tier.event_id) {
      await syncEventCapacity(supabase, tier.event_id);
    }

    return res.json(tier);
  })
);

/**
 * DELETE /api/admin/tiers/:tierId
 * Elimina la localidad y re-sincroniza event.capacity.
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
      .select('id, event_id, tickets_sold')
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

    // Re-sincronizar capacidad del evento tras eliminar tier
    if (tier.event_id) await syncEventCapacity(supabase, tier.event_id);

    return res.json({ ok: true });
  })
);

// ── PHASES ─────────────────────────────────────────────────────────

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
