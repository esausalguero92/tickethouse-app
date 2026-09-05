'use strict';
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const env = require('../config/env');

/**
 * Genera N JWT tokens para N tickets de una orden.
 * Cada token tiene jti unico para evitar replay attacks.
 * Expira 30 dias despues de la fecha del evento (o 365 dias si no hay fecha).
 * La DB es la fuente de verdad para saber si el ticket fue canjeado; el exp es solo
 * una capa adicional, no el control principal.
 *
 * @param {Object} opts
 * @param {string}   opts.orderId
 * @param {string}   opts.eventId
 * @param {string}   opts.buyerId
 * @param {number}   opts.quantity          - numero de tokens a generar
 * @param {string[]?} opts.correlativeCodes - opcional, legacy
 * @param {string?}  opts.eventDate
 */
function generateTicketTokens({ orderId, eventId, buyerId, quantity, correlativeCodes, eventDate }) {
  const now = Math.floor(Date.now() / 1000);
  let exp = now + 60 * 60 * 24 * 365; // 365 dias default
  if (eventDate) {
    const t = new Date(eventDate).getTime();
    if (!isNaN(t)) exp = Math.floor(t / 1000) + 60 * 60 * 24 * 30; // 30 dias post-evento
  }

  // Derivar cantidad: usar correlativeCodes.length si se paso array (legacy), sino quantity
  const count = Array.isArray(correlativeCodes) ? correlativeCodes.length : (quantity || 1);

  return Array.from({ length: count }, (_, idx) => {
    const jti = require('crypto').randomBytes(16).toString('hex');
    const payload = {
      t: 'ph.ticket.v2',
      jti,
      oid: orderId,
      eid: eventId,
      bid: buyerId,
      iat: now,
      exp,
    };
    // Embed correlative if available (for QR display purposes only; not used in validation lookup)
    if (Array.isArray(correlativeCodes) && correlativeCodes[idx]) {
      payload.cor = correlativeCodes[idx];
    }
    return jwt.sign(payload, env.JWT_SECRET, { algorithm: 'HS256' });
  });
}

/**
 * Genera un JWT de descarga segura (no es el token del QR).
 * Expira en 24h y contiene el order_id para validacion server-side.
 */
function generateDownloadToken(orderId) {
  return jwt.sign(
    { t: 'ph.download', oid: orderId },
    env.JWT_SECRET,
    { expiresIn: '24h', algorithm: 'HS256' }
  );
}

/**
 * Verifica un token de QR de entrada (ignora exp -- la DB controla si fue canjeado).
 * La firma sigue siendo verificada; solo se omite la validacion de fecha de expiracion.
 */
function verifyToken(token) {
  try {
    return jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'], ignoreExpiration: true });
  } catch {
    return null;
  }
}

/**
 * Verifica un token con expiracion estricta (para download tokens y login tokens).
 */
function verifyTokenStrict(token) {
  try {
    return jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return null;
  }
}

/**
 * Genera un Buffer PNG del QR a partir de un JWT string.
 */
async function generateQrBuffer(token, size = 480) {
  return QRCode.toBuffer(token, {
    width: size,
    margin: 2,
    color: { dark: '#000000', light: '#FFFFFF' },
    errorCorrectionLevel: 'M',
  });
}

module.exports = { generateTicketTokens, generateDownloadToken, verifyToken, verifyTokenStrict, generateQrBuffer };
