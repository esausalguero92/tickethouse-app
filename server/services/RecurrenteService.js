'use strict';
/**
 * RecurrenteService — Integración con Recurrente (gateway de pago Guatemala)
 *
 * Seguridad:
 *   - RECURRENTE_SECRET_KEY NUNCA sale al cliente. Solo se usa server-side.
 *   - Los tickets se emiten ÚNICAMENTE desde el webhook (intent.succeeded),
 *     nunca por el callback onSuccess del iframe (que puede ser falsificado).
 *   - La firma Svix se verifica con RECURRENTE_WEBHOOK_SECRET antes de
 *     procesar cualquier evento.
 *   - Idempotencia: se registra svix_id en webhook_events para evitar
 *     procesar el mismo evento dos veces.
 */

const { Webhook } = require('svix');
const env = require('../config/env');

const RECURRENTE_API = 'https://app.recurrente.com/api';

/**
 * Crea un checkout en Recurrente.
 * El checkout_url se devuelve al frontend para embeber en iframe.
 *
 * @param {Object} opts
 * @param {string} opts.orderId        UUID de la orden en nuestra BD
 * @param {string} opts.eventName      Nombre del evento
 * @param {number} opts.quantity       Cantidad de tickets
 * @param {number} opts.unitPriceGtq   Precio unitario en GTQ (centavos enteros)
 * @param {number} [opts.discountAmount] Descuento en GTQ (centavos) — opcional
 * @param {string} opts.buyerEmail     Email del comprador
 * @param {string} opts.buyerName      Nombre del comprador
 * @returns {Promise<{ checkoutId: string, checkoutUrl: string }>}
 */
async function createCheckout({ orderId, eventId, eventName, quantity, unitPriceGtq, discountAmount, buyerEmail, buyerName }) {
  if (!env.RECURRENTE_SECRET_KEY) {
    throw Object.assign(new Error('Recurrente no configurado (RECURRENTE_SECRET_KEY ausente)'), { status: 503 });
  }

  const totalGtq = Math.max(0, (unitPriceGtq * quantity) - (discountAmount || 0));

  const payload = {
    items: [
      {
        name:           `${eventName} — ${quantity} ${quantity === 1 ? 'entrada' : 'entradas'}`,
        amount_in_cents: unitPriceGtq,
        currency:       'GTQ',
        quantity,
      },
    ],
    // Redirect de vuelta a ticket.html en modo polling (el webhook ya marcó la orden)
    success_url: `${env.PUBLIC_BASE_URL}/ticket.html?estado=procesando&oid=${encodeURIComponent(orderId)}`,
    // Si cancela, vuelve al evento para que pueda reintentar
    cancel_url:  `${env.PUBLIC_BASE_URL}/evento.html?id=${encodeURIComponent(eventId || '')}&checkout=cancelled`,
    metadata: {
      order_id: orderId,         // Clave para lookup en el webhook
    },
    customer: {
      email: buyerEmail,
      name:  buyerName,
    },
  };

  // Aplicar descuento si existe
  if (discountAmount && discountAmount > 0) {
    payload.discounts = [
      {
        name: 'Descuento aplicado',
        amount_in_cents: discountAmount,
      },
    ];
  }

  const response = await fetch(`${RECURRENTE_API}/checkouts`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'X-SECRET-KEY':  env.RECURRENTE_SECRET_KEY,  // NUNCA al cliente
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    console.error('[RecurrenteService] createCheckout error:', response.status, body);
    throw Object.assign(
      new Error(body.message || body.error || 'recurrente_checkout_failed'),
      { status: 502 }
    );
  }

  const data = await response.json();

  return {
    checkoutId:  data.id || data.checkout_id,
    checkoutUrl: data.checkout_url || data.url,
  };
}

/**
 * Verifica la firma Svix de un webhook de Recurrente.
 * Lanza si la firma es inválida o el body fue manipulado.
 *
 * @param {Buffer|string} rawBody   Body crudo (sin parsear)
 * @param {Object}        headers   Headers de la petición Express
 * @returns {Object}                Payload del evento verificado
 */
function verifyWebhookSignature(rawBody, headers) {
  if (!env.RECURRENTE_WEBHOOK_SECRET) {
    throw Object.assign(new Error('RECURRENTE_WEBHOOK_SECRET no configurado'), { status: 503 });
  }

  const wh = new Webhook(env.RECURRENTE_WEBHOOK_SECRET);

  // Svix espera string o Buffer; headers deben incluir svix-id, svix-timestamp, svix-signature
  return wh.verify(rawBody, {
    'svix-id':        headers['svix-id'],
    'svix-timestamp': headers['svix-timestamp'],
    'svix-signature': headers['svix-signature'],
  });
}

module.exports = { createCheckout, verifyWebhookSignature };
