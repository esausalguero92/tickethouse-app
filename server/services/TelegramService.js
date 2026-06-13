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

function buildMultipart(fields, fileBuffer, fileField, fileName, mimeType) {
  const boundary = 'TGBound' + Date.now() + Math.random().toString(36).slice(2);
  const CRLF = '\r\n';
  const parts = [];
  for (const [name, val] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${val}${CRLF}`));
  }
  parts.push(Buffer.from(
    `--${boundary}${CRLF}Content-Disposition: form-data; name="${fileField}"; filename="${fileName}"${CRLF}Content-Type: ${mimeType}${CRLF}${CRLF}`
  ));
  parts.push(fileBuffer);
  parts.push(Buffer.from(`${CRLF}--${boundary}--${CRLF}`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * Notifica al admin cuando llega una transferencia pendiente.
 * Non-blocking: el caller no debe awaitar.
 */
async function notifyNewTransfer({ fileBuffer, fileName, mimeType, buyerName, quantity, eventName, amountUsd, reference, orderId }) {
  const chatId = env.TRANSFER_NOTIFY_ID || env.ADMIN_TELEGRAM_IDS[0] || '';
  if (!env.TELEGRAM_BOT_TOKEN || !chatId) {
    console.warn('[telegram] Sin destino — configura TRANSFER_NOTIFY_ID o ADMIN_TELEGRAM_IDS.');
    return;
  }

  const lines = [
    '🔔 Nueva transferencia pendiente',
    '',
    `👤 ${buyerName}`,
    `🎟 ${quantity} ${quantity === 1 ? 'entrada' : 'entradas'}`,
    `🎉 ${eventName}`,
    `💵 USD ${Number(amountUsd).toFixed(2)}`,
    reference ? `📋 Folio: ${reference}` : '📋 Sin folio',
    '',
    `🔗 ${env.PUBLIC_BASE_URL}/admin.html`,
  ];
  const caption = lines.join('\n');

  try {
    if (fileBuffer) {
      const isImage = mimeType && mimeType.startsWith('image/');
      const method = isImage ? 'sendPhoto' : 'sendDocument';
      const fieldName = isImage ? 'photo' : 'document';
      const safeFileName = fileName || (isImage ? 'comprobante.jpg' : 'comprobante.pdf');
      const { body, contentType } = buildMultipart(
        { chat_id: String(chatId), caption },
        fileBuffer, fieldName, safeFileName, mimeType || 'application/octet-stream'
      );
      const r = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
        { method: 'POST', headers: { 'Content-Type': contentType }, body }
      );
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        console.warn(`[telegram] ${method} falló (${j.description}) — enviando texto`);
        await telegramPost('sendMessage', { chat_id: chatId, text: caption });
      } else {
        console.log(`[telegram] ${method} OK → ${chatId}`);
      }
    } else {
      await telegramPost('sendMessage', { chat_id: chatId, text: caption });
    }
  } catch (e) {
    console.error('[telegram.notify]', e.message || e);
  }
}

module.exports = { notifyNewTransfer, telegramPost };
