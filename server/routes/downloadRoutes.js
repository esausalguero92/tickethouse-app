'use strict';
/**
 * TicketHouseV2 — Descarga segura de tickets
 *
 * GET /api/download/order/:token             → Info de la orden (tickets) por download token
 * GET /api/download/ticket/:token/:code      → Descargar PDF de 1 ticket
 *
 * :code acepta AMBOS formatos:
 *   Legacy: TH-PH001
 *   Nuevo:  TH-BLG-482719
 *
 * Los tokens son JWT firmados con exp de 24h.
 * Nunca exponer el order_id directamente en URLs predecibles.
 */

const { Router } = require('express');
const { getSupabase } = require('../db/supabase');
const { generateTicketPdf } = require('../services/PdfService');
const { asyncHandler } = require('../middleware/errorHandler');
const { downloadLimiter } = require('../middleware/security');

const router = Router();

// Patrones de código válido (legacy + nuevo)
const LEGACY_CODE_RE = /^TH-PH\d+$/;
const NEW_CODE_RE    = /^TH-[A-Z]{2,4}-\d{6}$/;

function isValidTicketCode(code) {
  return LEGACY_CODE_RE.test(code) || NEW_CODE_RE.test(code);
}

// ── GET /api/download/order/:token ────────────────────────────────
router.get('/order/:token',
  downloadLimiter,
  asyncHandler(async (req, res) => {
    const { verifyTokenStrict: verifyToken } = require('../services/QrService');
    const payload = verifyToken(req.params.token);
    if (!payload || payload.t !== 'ph.download' || !payload.oid) {
      return res.status(401).json({ error: 'token_invalid_or_expired' });
    }

    const supabase = getSupabase();
    const { data, error } = await supabase.rpc('rpc_get_order_tickets', {
      p_order_id: payload.oid,
      p_token:    req.params.token,
    });

    if (error || !data || data.error) {
      return res.status(404).json({ error: data && data.error ? data.error : 'order_not_found' });
    }

    return res.json(data);
  })
);

// ── GET /api/download/ticket/:token/:code → PDF ───────────────────
// :code puede ser TH-PH001 (legacy) o TH-BLG-482719 (nuevo)
router.get('/ticket/:token/:code',
  downloadLimiter,
  asyncHandler(async (req, res) => {
    const { verifyTokenStrict: verifyToken } = require('../services/QrService');
    const payload = verifyToken(req.params.token);
    if (!payload || payload.t !== 'ph.download' || !payload.oid) {
      return res.status(401).json({ error: 'token_invalid_or_expired' });
    }

    const code = req.params.code.toUpperCase().trim();

    if (!isValidTicketCode(code)) {
      return res.status(400).json({ error: 'code_invalid' });
    }

    const supabase = getSupabase();

    // Buscar ticket por correlative_code (legacy) o public_code (nuevo)
    let ticketQuery;
    if (LEGACY_CODE_RE.test(code)) {
      ticketQuery = supabase
        .from('tickets')
        .select('id, correlative_code, public_code, qr_token, status, order_id, event_id, event:events(name, event_date, venue), buyer:buyers(full_name)')
        .eq('correlative_code', code)
        .eq('order_id', payload.oid)
        .maybeSingle();
    } else {
      ticketQuery = supabase
        .from('tickets')
        .select('id, correlative_code, public_code, qr_token, status, order_id, event_id, event:events(name, event_date, venue), buyer:buyers(full_name)')
        .eq('public_code', code)
        .eq('order_id', payload.oid)
        .maybeSingle();
    }

    const { data: ticket, error } = await ticketQuery;

    if (error || !ticket) {
      return res.status(404).json({ error: 'ticket_not_found' });
    }
    if (ticket.status === 'revoked') {
      return res.status(410).json({ error: 'ticket_revoked' });
    }

    // Código visible en el PDF: preferir public_code, caer a correlative_code
    const displayCode = ticket.public_code || ticket.correlative_code;

    const pdfBuffer = await generateTicketPdf({
      publicCode:      ticket.public_code,
      correlativeCode: ticket.correlative_code,
      qrToken:         ticket.qr_token,
      eventName:       ticket.event ? ticket.event.name       : 'TicketHouse',
      eventDate:       ticket.event ? ticket.event.event_date : null,
      eventVenue:      ticket.event ? ticket.event.venue      : '',
      buyerName:       ticket.buyer ? ticket.buyer.full_name  : '',
    });

    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="ticket-${displayCode}.pdf"`);
    res.set('Cache-Control', 'private, max-age=3600');
    res.end(pdfBuffer);
  })
);

module.exports = router;
