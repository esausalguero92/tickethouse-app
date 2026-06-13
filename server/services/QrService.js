'use strict';
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const env = require('../config/env');

/**
 * Genera N JWT tokens para N tickets de una orden.
 * Cada token tiene jti único para evitar replay attacks.
 * Expira 48h después de la fecha del evento (o 60 días si no hay fecha).
 *
 * @param {Object} opts
 * @param {string}   opts.orderId
 * @param {string}   opts.eventId
 * @param {string}   opts.buyerId
 * @param {number}   opts.quantity          — número de tokens a generar
 * @param {string[]?} opts.correlativeCodes — opcional, legacy
 * @param {string?}  opts.eventDate
 */
function generateTicketTokens({ orderId, eventId, buyerId, quantity, correlativeCodes, eventDate }) {
  const now = Math.floor(Date.now() / 1000);
  let exp = now + 60 * 60 * 24 * 60;  // 60 días default
  if (eventDate) {
    const t = new Date(eventDate).getTime();
    if (!isNaN(t)) exp = Math.floor(t / 1000) + 60 * 60 * 48;
  }

  // Derivar cantidad: usar correlativeCodes.length si se pasó array (legacy), sino quantity
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
 * Expira en 24h y contiene el order_id para validación server-side.
 */
function generateDownloadToken(orderId) {
  return jwt.sign(
    { t: 'ph.download', oid: orderId },
    env.JWT_SECRET,
    { expiresIn: '24h', algorithm: 'HS256' }
  );
}

/**
 * Verifica un token genérico (QR o download).
 */
function verifyToken(token) {
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

module.exports = { generateTicketTokens, generateDownloadToken, verifyToken, generateQrBuffer };
