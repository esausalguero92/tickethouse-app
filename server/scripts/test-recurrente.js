#!/usr/bin/env node
'use strict';
/**
 * test-recurrente.js — Verifica que la API key de Recurrente funciona
 * y muestra la respuesta exacta de la API.
 * 
 * Uso: node scripts/test-recurrente.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const env = require('../config/env');

async function main() {
  console.log('\n🔍 Verificando configuración Recurrente...');
  console.log('  KEY presente:', !!env.RECURRENTE_SECRET_KEY);
  console.log('  KEY prefijo: ', env.RECURRENTE_SECRET_KEY.slice(0, 12) + '...');
  console.log('  PUBLIC_BASE_URL:', env.PUBLIC_BASE_URL);

  const payload = {
    items: [
      {
        name: 'Test Entrada — Party House',
        price_in_cents: 5000, // Q50.00
        quantity: 1,
      },
    ],
    success_url: `${env.PUBLIC_BASE_URL}/ticket.html`,
    cancel_url:  `${env.PUBLIC_BASE_URL}/evento.html`,
    metadata: {
      order_id: '00000000-0000-0000-0000-000000000001',
    },
    customer: {
      email: 'test@test.com',
      name:  'Test User',
    },
  };

  console.log('\n📤 Enviando a Recurrente API...');
  console.log('Payload:', JSON.stringify(payload, null, 2));

  const response = await fetch('https://app.recurrente.com/api/checkouts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-SECRET-KEY': env.RECURRENTE_SECRET_KEY,
    },
    body: JSON.stringify(payload),
  });

  const body = await response.json().catch(e => ({ raw_error: e.message }));
  console.log('\n📥 Respuesta HTTP:', response.status, response.statusText);
  console.log('Body:', JSON.stringify(body, null, 2));

  if (response.ok) {
    console.log('\n✅ Checkout creado correctamente');
    console.log('  checkout_url:', body.checkout_url || body.url);
  } else {
    console.error('\n❌ Error de Recurrente — revisar body de arriba');
  }
}

main().catch(err => {
  console.error('\n💥 Error de conexión:', err.message);
  process.exit(1);
});
