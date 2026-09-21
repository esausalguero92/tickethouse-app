'use strict';
/**
 * TicketService — Emite tickets tras confirmar pago.
 *
 * Pasos:
 *   1. Generar N códigos públicos (TH-BLG-482719) criptográficamente seguros
 *   2. Generar N JWT tokens QR (uno por ticket)
 *   3. Llamar rpc_issue_tickets_bulk (atómico — correlativos en PostgreSQL)
 *   4. Persistir public_code en cada ticket
 *   5. Generar N PDFs (uno por ticket)
 *   6. Enviar email con todos los PDFs adjuntos
 *   7. Retornar download token + public_codes
 */

const { getSupabase } = require('../db/supabase');
const { generateTicketTokens, generateDownloadToken } = require('./QrService');
const { generateTicketPdf } = require('./PdfService');
const { sendConfirmationEmail } = require('./EmailService');
const { generateUniqueCodes } = require('./TicketCodeService');
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
 * @param {string} [opts.eventPrefix]  Prefijo para códigos públicos (ej. "BLG")
 */
async function issueTickets({ orderId, eventId, buyerId, buyerName, buyerEmail, quantity, eventName, eventDate, eventVenue, eventPrefix }) {
  const supabase = getSupabase();

  // 1. Generar códigos públicos únicos (TH-BLG-482719)
  const prefix = (eventPrefix || 'TH').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4) || 'TH';
  const publicCodes = await generateUniqueCodes(prefix, quantity);

  // 2. Generar N JWT tokens QR
  const qrTokens = generateTicketTokens({
    orderId, eventId, buyerId,
    quantity,
    eventDate,
  });

  // 3. Persistir tickets en Supabase (atómico, asigna correlativos legacy)
  const { data: issueData, error: issueErr } = await supabase.rpc('rpc_issue_tickets_bulk', {
    p_order_id:  orderId,
    p_qr_tokens: qrTokens,
  });

  if (issueErr || !issueData || issueData.error) {
    throw new Error('Error al emitir tickets: ' + (
      issueErr && issueErr.message ? issueErr.message :
      (issueData && issueData.error ? issueData.error : 'desconocido')
    ));
  }

  const correlativeCodes = issueData.correlative_codes;
  const ticketIds = issueData.ticket_ids || [];

  // 4. Persistir public_code en cada ticket (batch update)
  if (ticketIds.length > 0) {
    // Actualizar por correlative_code (siempre disponible)
    const updates = correlativeCodes.map(function(corr, i) {
      return supabase
        .from('tickets')
        .update({ public_code: publicCodes[i] })
        .eq('correlative_code', corr)
        .eq('order_id', orderId);
    });
    const results = await Promise.all(updates);
    results.forEach(function(r, i) {
      if (r.error) console.error('[TicketService] Error guardando public_code[' + i + ']:', r.error.message);
    });
  } else {
    // Fallback: actualizar por correlative_code
    const updates = correlativeCodes.map(function(corr, i) {
      return supabase
        .from('tickets')
        .update({ public_code: publicCodes[i] })
        .eq('correlative_code', corr)
        .eq('order_id', orderId);
    });
    await Promise.all(updates);
  }

  // 5. Generar PDFs en paralelo
  const pdfBuffers = await Promise.all(
    publicCodes.map((publicCode, i) =>
      generateTicketPdf({
        publicCode,
        correlativeCode: correlativeCodes[i],
        qrToken:    qrTokens[i],
        eventName,
        eventDate,
        eventVenue,
        buyerName,
      })
    )
  );

  // 6. Generar download token (para /ticket.html?ot=...)
  const downloadToken = generateDownloadToken(orderId);

  // 7. Enviar email (non-blocking — no fallar si el email falla)
  if (buyerEmail) {
    const ticketsForEmail = publicCodes.map((publicCode, i) => ({
      publicCode,
      correlativeCode: correlativeCodes[i],
      qrToken:    qrTokens[i],
      pdfBuffer:  pdfBuffers[i],
    }));

    sendConfirmationEmail({
      toEmail: buyerEmail,
      buyerName: buyerName || 'Invitado/a',
      eventName,
      eventDate,
      eventVenue,
      tickets:     ticketsForEmail,
      downloadUrl: env.PUBLIC_BASE_URL + '/ticket.html?ot=' + downloadToken,
    })
      .then(function(r) { console.log('[tickets] Email enviado a ' + buyerEmail + ' — id: ' + (r && r.id ? r.id : 'skipped')); })
      .catch(function(e) { console.error('[tickets] Email fallo (no critico):', e.message); });
  }

  return {
    correlativeCodes,
    publicCodes,
    downloadToken,
    quantity,
  };
}


/**
 * Flujo completo post-pago para órdenes de localidades (tier orders).
 * @param {Object} opts
 * @param {string}   opts.orderId
 * @param {string}   opts.eventId
 * @param {string}   opts.buyerId
 * @param {string}   opts.buyerName
 * @param {string}   opts.buyerEmail
 * @param {Array}    opts.tierItems  — [{tier_id, tier_name, quantity, ...}]
 * @param {string}   opts.eventName
 * @param {string}   opts.eventDate
 * @param {string}   opts.eventVenue
 * @param {string}   [opts.eventPrefix]
 */
async function issueTicketsTiers({ orderId, eventId, buyerId, buyerName, buyerEmail, tierItems, eventName, eventDate, eventVenue, eventPrefix }) {
  const supabase = getSupabase();

  // 1. Calcular cantidad total
  const totalQty = tierItems.reduce(function(sum, t) { return sum + (parseInt(t.quantity, 10) || 0); }, 0);
  if (totalQty === 0) throw new Error('tier_items vacíos');

  // 2. Generar códigos públicos únicos
  const prefix = (eventPrefix || 'TH').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4) || 'TH';
  const publicCodes = await generateUniqueCodes(prefix, totalQty);

  // 3. Generar N JWT tokens QR (uno por ticket)
  const qrTokens = generateTicketTokens({
    orderId, eventId, buyerId,
    quantity: totalQty,
    eventDate,
  });

  // 4. Construir p_tickets_json: [{qr_token, tier_id, tier_name}] — uno por ticket
  var ticketsJson = [];
  var idx = 0;
  tierItems.forEach(function(item) {
    var qty = parseInt(item.quantity, 10) || 0;
    for (var i = 0; i < qty; i++) {
      ticketsJson.push({
        qr_token:  qrTokens[idx],
        tier_id:   item.tier_id,
        tier_name: item.tier_name || '',
      });
      idx++;
    }
  });

  // 5. Persistir tickets en Supabase (atómico, asigna correlativos)
  const { data: issueData, error: issueErr } = await supabase.rpc('rpc_issue_tickets_bulk_v2', {
    p_order_id:     orderId,
    p_tickets_json: ticketsJson,
  });

  if (issueErr || !issueData || issueData.error) {
    throw new Error('Error al emitir tickets: ' + (
      issueErr && issueErr.message ? issueErr.message :
      (issueData && issueData.error ? issueData.error : 'desconocido')
    ));
  }

  const correlativeCodes = issueData.correlative_codes;
  const ticketIds = issueData.ticket_ids || [];

  // 6. Persistir public_code en cada ticket (batch update por correlative_code)
  const updates = correlativeCodes.map(function(corr, i) {
    return supabase
      .from('tickets')
      .update({ public_code: publicCodes[i] })
      .eq('correlative_code', corr)
      .eq('order_id', orderId);
  });
  const results = await Promise.all(updates);
  results.forEach(function(r, i) {
    if (r.error) console.error('[TicketService.tiers] Error guardando public_code[' + i + ']:', r.error.message);
  });

  // 7. Generar PDFs en paralelo
  const pdfBuffers = await Promise.all(
    publicCodes.map(function(publicCode, i) {
      return generateTicketPdf({
        publicCode,
        correlativeCode: correlativeCodes[i],
        qrToken:    ticketsJson[i].qr_token,
        eventName,
        eventDate,
        eventVenue,
        buyerName,
      });
    })
  );

  // 8. Generar download token
  const downloadToken = generateDownloadToken(orderId);

  // 9. Enviar email (non-blocking)
  if (buyerEmail) {
    const ticketsForEmail = publicCodes.map(function(publicCode, i) {
      return {
        publicCode,
        correlativeCode: correlativeCodes[i],
        qrToken:    ticketsJson[i].qr_token,
        pdfBuffer:  pdfBuffers[i],
      };
    });

    sendConfirmationEmail({
      toEmail: buyerEmail,
      buyerName: buyerName || 'Invitado/a',
      eventName,
      eventDate,
      eventVenue,
      tickets:     ticketsForEmail,
      downloadUrl: env.PUBLIC_BASE_URL + '/ticket.html?ot=' + downloadToken,
    })
      .then(function(r) { console.log('[tickets.tiers] Email enviado a ' + buyerEmail + ' — id: ' + (r && r.id ? r.id : 'skipped')); })
      .catch(function(e) { console.error('[tickets.tiers] Email falló (no crítico):', e.message); });
  }

  return {
    correlativeCodes,
    publicCodes,
    downloadToken,
    quantity: totalQty,
  };
}

module.exports = { issueTickets, issueTicketsTiers };
