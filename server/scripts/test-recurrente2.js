#!/usr/bin/env node
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const key = process.env.RECURRENTE_SECRET_KEY;

async function test(label, payload) {
  console.log('\n--- ' + label + ' ---');
  const r = await fetch('https://app.recurrente.com/api/checkouts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-SECRET-KEY': key },
    body: JSON.stringify(payload),
  });
  const b = await r.json().catch(() => ({}));
  console.log('HTTP:', r.status);
  console.log('Body:', JSON.stringify(b, null, 2));
  return { status: r.status, body: b };
}

async function main() {
  // Format A: amount_in_cents top-level + currency
  const a = await test('Format A: amount_in_cents top-level', {
    amount_in_cents: 5000,
    currency: 'GTQ',
    description: 'Party House — 1 entrada',
    success_url: 'https://tickethouse.site/ticket.html',
    cancel_url:  'https://tickethouse.site/evento.html',
    metadata: { order_id: '00000000-0000-0000-0000-000000000001' },
    customer_email: 'test@test.com',
  });

  if (a.status === 200 || a.status === 201) return;

  // Format B: amount_in_cents + name at top level
  await test('Format B: amount_in_cents + name', {
    amount_in_cents: 5000,
    name: 'Party House — 1 entrada',
    success_url: 'https://tickethouse.site/ticket.html',
    cancel_url:  'https://tickethouse.site/evento.html',
    metadata: { order_id: '00000000-0000-0000-0000-000000000001' },
  });
}

main().catch(console.error);
