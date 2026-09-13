#!/usr/bin/env node
/**
 * test-webhook.js — Simula un webhook intent.succeeded de Recurrente (Svix)
 * 
 * Uso:
 *   node scripts/test-webhook.js <order_id>
 * 
 * Ejemplo:
 *   node scripts/test-webhook.js 550e8400-e29b-41d4-a716-446655440000
 *
 * Requiere: npm install svix (ya debería estar)
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { WebhookUnbranded } = require('svix');
const crypto = require('crypto');

const ORDER_ID = process.argv[2];
const PORT     = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.RECURRENTE_WEBHOOK_SECRET;

if (!ORDER_ID) {
  console.error('Uso: node scripts/test-webhook.js <order_id>');
  process.exit(1);
}
if (!WEBHOOK_SECRET) {
  console.error('RECURRENTE_WEBHOOK_SECRET no configurado en .env');
  process.exit(1);
}

// Payload que enviaría Recurrente en un intent.succeeded
const payload = {
  type: 'intent.succeeded',
  data: {
    id: `pi_test_${crypto.randomBytes(8).toString('hex')}`,
    status: 'succeeded',
    metadata: {
      order_id: ORDER_ID,
    },
    amount: 15000,
    currency: 'GTQ',
  },
};

const body = JSON.stringify(payload);
const svixId = `msg_test_${crypto.randomBytes(12).toString('hex')}`;
const svixTimestamp = Math.floor(Date.now() / 1000).toString();

// Firmar igual que Svix: "<svix-id>.<svix-timestamp>.<body>"
// whsec_ prefix → base64 decode el resto
const secretBytes = Buffer.from(WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
const toSign = `${svixId}.${svixTimestamp}.${body}`;
const signature = crypto.createHmac('sha256', secretBytes).update(toSign).digest('base64');
const svixSignature = `v1,${signature}`;

const url = `http://localhost:${PORT}/api/webhooks/recurrente`;

console.log('\n🔔 Enviando webhook simulado a:', url);
console.log('   order_id:', ORDER_ID);
console.log('   svix-id: ', svixId);
console.log('   evento:   intent.succeeded\n');

fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type':   'application/json',
    'svix-id':        svixId,
    'svix-timestamp': svixTimestamp,
    'svix-signature': svixSignature,
  },
  body,
}).then(async res => {
  const text = await res.text().catch(() => '');
  if (res.ok) {
    console.log('✅ Webhook aceptado (HTTP', res.status + ')');
    console.log('   Respuesta:', text);
  } else {
    console.error('❌ Webhook rechazado (HTTP', res.status + ')');
    console.error('   Respuesta:', text);
  }
}).catch(err => {
  console.error('❌ Error de conexión:', err.message);
  console.error('   ¿Está corriendo el servidor en localhost:' + PORT + '?');
});
