'use strict';
/**
 * Limpieza de datos de prueba en Supabase.
 * Borra: orders, tickets, validation_log, buyers
 * Conserva: events, app_users, user_profiles, access_codes, guests
 *
 * Uso: node scripts/clean-db.js
 */

require('../server/node_modules/dotenv').config({ path: require('path').join(__dirname, '../server/.env') });
const { createClient } = require('../server/node_modules/@supabase/supabase-js');
const readline = require('readline');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function clean() {
  // Confirmación
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise(resolve => rl.question(
    '⚠️  Esto borrará TODOS los pedidos, entradas y logs. ¿Continuar? (s/N): ',
    ans => { rl.close(); if (ans.toLowerCase() !== 's') { console.log('Cancelado.'); process.exit(0); } resolve(); }
  ));

  console.log('\n🗑️  Limpiando...\n');

  // Orden importa: tickets → orders → buyers (FK constraints)
  const steps = [
    { label: 'validation_log', fn: () => supabase.from('validation_log').delete().neq('id', '00000000-0000-0000-0000-000000000000') },
    { label: 'tickets',        fn: () => supabase.from('tickets').delete().neq('id', '00000000-0000-0000-0000-000000000000') },
    { label: 'orders',         fn: () => supabase.from('orders').delete().neq('id', '00000000-0000-0000-0000-000000000000') },
    { label: 'buyers',         fn: () => supabase.from('buyers').delete().neq('id', '00000000-0000-0000-0000-000000000000') },
  ];

  for (const step of steps) {
    const { error } = await step.fn();
    if (error) console.warn(`  ⚠️  ${step.label}: ${error.message}`);
    else       console.log(`  ✓  ${step.label}: borrado`);
  }

  // Resetear secuencia de correlativos
  const { error: seqErr } = await supabase.rpc('rpc_reset_correlative_seq').catch(() => ({ error: { message: 'RPC no existe — resetea manualmente si es necesario' } }));
  if (seqErr) console.warn(`  ⚠️  secuencia: ${seqErr.message}`);
  else        console.log('  ✓  secuencia de correlativos reseteada');

  console.log('\n✅ Base de datos limpia. Conservados: events, app_users, user_profiles, access_codes, guests.');
}

clean().catch(e => { console.error('Error:', e.message); process.exit(1); });
