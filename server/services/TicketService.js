'use strict';
/**
 * Party House — Ticket Service
 * Orquesta la creación de tickets tras confirmar pago.
 * Pasos:
 *   1. Generar N JWT tokens (uno por ticket)
 *   2. Llamar rpc_issue_tickets_bulk (atómico — correlativos en PostgreSQL)
 *   3. Generar N PDFs (uno por ticket)
 *   4. Enviar email con todos los PDFs adjuntos
 *   5. Retornar download token para redirección a /ticket.html
 */

const { getSupabase } = require('../db/supabase');
const { generateTicketTokens, generateDownloadToken } = require('./QrService');
const { generateTicketPdf } = require('./PdfService');
const { sendConfirmationEmail } = require('./EmailService');
const env = require('../config/env');

/**
 * Flujo completo post-pago.
 * @param {Object} opts
 * @param {string} opts.orderId
 * @param {string} opts.eventId
 * @param {string} opts.buyerId
 * @param {string} opts.buyerName
 * @param {string} opts.buyerEmail
 * @param {number} opts.quantity
 * @param {string} opts.eventName
 * @param {string} opts.eventDate
 * @param {string} opts.eventVenue
 */
async function issueTickets({ orderId, eventId, buyerId, buyerName, buyerEmail, quantity, eventName, eventDate, eventVenue }) {
  const supabase = getSupabase();

  // 1. Generar N JWT tokens (correlativos los asigna la RPC con nextval())
  const qrTokens = generateTicketTokens({
    orderId, eventId, buyerId,
    quantity,
    eventDate,
  });

  // 2. Persistir tickets en Supabase — atómico, asigna correlativos
  const { data: issueData, error: issueErr } = await supabase.rpc('rpc_issue_tickets_bulk', {
    p_order_id:   orderId,
    p_qr_tokens:  qrTokens,
  });
  if (issueErr || !issueData || issueData.error) {
    throw new Error(`Error al emitir tickets: ${issueErr?.message || issueData?.error || 'desconocido'}`);
  }

  const correlativeCodes = issueData.correlative_codes; // asignados por PostgreSQL

  // Paso D: Generar PDFs en paralelo
  const pdfBuffers = await Promise.all(
    correlativeCodes.map((correlativeCode, i) =>
      generateTicketPdf({
        correlativeCode,
        qrToken: qrTokens[i],
        eventName,
        eventDate,
        eventVenue,
        buyerName,
      })
    )
  );

  // Paso E: Generar download token (para /ticket.html?ot=...)
  const downloadToken = generateDownloadToken(orderId);

  // Paso F: Enviar email (non-blocking — no fallar si el email falla)
  if (buyerEmail) {
    const ticketsForEmail = correlativeCodes.map((correlativeCode, i) => ({
      correlativeCode,
      qrToken: qrTokens[i],
      pdfBuffer: pdfBuffers[i],
    }));

    sendConfirmationEmail({
      toEmail: buyerEmail,
      buyerName: buyerName || 'Invitado/a',
      eventName,
      eventDate,
      eventVenue,
      tickets: ticketsForEmail,
      downloadUrl: `${env.PUBLIC_BASE_URL}/ticket.html?ot=${downloadToken}`,
    })
      .then(r => console.log(`[tickets] Email enviado a ${buyerEmail} — id: ${r?.id || 'skipped'}`))
      .catch(e => console.error('[tickets] Email falló (no crítico):', e.message));
  }

  return {
    correlativeCodes,
    downloadToken,
    quantity,
  };
}

module.exports = { issueTickets };
