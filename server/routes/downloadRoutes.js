'use strict';
/**
 * Party House — Descarga segura de tickets
 *
 * GET /api/download/order/:token      → Info de la orden (tickets) por download token
 * GET /api/download/ticket/:token/:correlative → Descargar PDF de 1 ticket
 *
 * Los tokens son JWT firmados con exp de 24h.
 * Nunca exponer el order_id directamente en URLs predecibles.
 */

const { Router } = require('express');
const { param } = require('express-validator');
const { getSupabase } = require('../db/supabase');
const { verifyJwt, generateDownloadToken } = require('../services/QrService');
const { generateTicketPdf } = require('../services/PdfService');
const { asyncHandler } = require('../middleware/errorHandler');
const { downloadLimiter } = require('../middleware/security');

const router = Router();

// ── GET /api/download/order/:token ────────────────────────────────
// Retorna los tickets de una orden (para /ticket.html)
router.get('/order/:token',
  downloadLimiter,
  asyncHandler(async (req, res) => {
    const { verifyToken } = require('../services/QrService');
    const payload = verifyToken(req.params.token);
    if (!payload || payload.t !== 'ph.download' || !payload.oid) {
      return res.status(401).json({ error: 'token_invalid_or_expired' });
    }

    const supabase = getSupabase();
    const { data, error } = await supabase.rpc('rpc_get_order_tickets', {
      p_order_id: payload.oid,
      p_token: req.params.token,
    });

    if (error || !data || data.error) {
      return res.status(404).json({ error: data?.error || 'order_not_found' });
    }

    return res.json(data);
  })
);

// ── GET /api/download/ticket/:token/:correlative → PDF ────────────
// Descarga el PDF de un ticket individual.
// :token = download token JWT (verifica acceso a la orden)
// :correlative = TH-PH001 (qué ticket específico descargar)
router.get('/ticket/:token/:correlative',
  downloadLimiter,
  asyncHandler(async (req, res) => {
    const { verifyToken } = require('../services/QrService');
    const payload = verifyToken(req.params.token);
    if (!payload || payload.t !== 'ph.download' || !payload.oid) {
      return res.status(401).json({ error: 'token_invalid_or_expired' });
    }

    const correlative = req.params.correlative.toUpperCase().trim();
    if (!/^TH-PH\d+$/.test(correlative)) {
      return res.status(400).json({ error: 'correlative_invalid' });
    }

    const supabase = getSupabase();

    // Buscar el ticket (verificar que pertenece a la orden del token)
    const { data: ticket, error } = await supabase
      .from('tickets')
      .select('id, correlative_code, qr_token, status, order_id, event_id, event:events(name, event_date, venue), buyer:buyers(full_name)')
      .eq('correlative_code', correlative)
      .eq('order_id', payload.oid)
      .maybeSingle();

    if (error || !ticket) {
      return res.status(404).json({ error: 'ticket_not_found' });
    }
    if (ticket.status === 'revoked') {
      return res.status(410).json({ error: 'ticket_revoked' });
    }

    // Generar PDF
    const pdfBuffer = await generateTicketPdf({
      correlativeCode: ticket.correlative_code,
      qrToken:         ticket.qr_token,
      eventName:       ticket.event?.name || 'Party House',
      eventDate:       ticket.event?.event_date || null,
      eventVenue:      ticket.event?.venue || '',
      buyerName:       ticket.buyer?.full_name || '',
    });

    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="ticket-${correlative}.pdf"`);
    res.set('Cache-Control', 'private, max-age=3600');
    res.end(pdfBuffer);
  })
);

module.exports = router;
