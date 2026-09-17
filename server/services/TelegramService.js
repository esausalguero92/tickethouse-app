'use strict';
const env = require('../config/env');

async function telegramPost(method, body) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('telegram_not_configured');
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.description || `telegram_${method}_failed`);
  return j.result;
}

/**
 * Notifica al admin cuando se confirma un nuevo pago con Recurrente.
 * Non-blocking: el caller no debe awaitar.
 */
async function notifyNewOrder({ buyerName, quantity, eventName, orderId, publicCodes, totalSold }) {
  const chatId = env.ORDER_NOTIFY_ID || env.ADMIN_TELEGRAM_IDS[0] || '';
  if (!env.TELEGRAM_BOT_TOKEN || !chatId) {
    console.warn('[telegram] Sin destino — configura ORDER_NOTIFY_ID o ADMIN_TELEGRAM_IDS.');
    return;
  }

  const codesText = publicCodes && publicCodes.length
    ? publicCodes.join(', ')
    : '—';

  const totalLine = totalSold != null
    ? `📊 Total vendidas: ${totalSold} entradas`
    : null;

  const lines = [
    '✅ Nuevo pago confirmado',
    '',
    `👤 ${buyerName}`,
    `🎟 ${quantity} ${quantity === 1 ? 'entrada' : 'entradas'}`,
    `🎉 ${eventName}`,
    `🔑 ${codesText}`,
    ...(totalLine ? ['', totalLine] : []),
    '',
    `🔗 ${env.PUBLIC_BASE_URL}/admin.html`,
  ];

  const text = lines.join('\n');

  try {
    await telegramPost('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
    console.log('[telegram] Notificación enviada → ' + chatId);
  } catch (e) {
    console.error('[telegram.notify]', e.message || e);
  }
}

/**
 * @deprecated Usar notifyNewOrder. Mantenido para compatibilidad con código legado.
 */
async function notifyNewTransfer(opts) {
  return notifyNewOrder({
    buyerName:  opts.buyerName,
    quantity:   opts.quantity,
    eventName:  opts.eventName,
    orderId:    opts.orderId,
    publicCodes: [],
  });
}

module.exports = { notifyNewOrder, notifyNewTransfer, telegramPost };
