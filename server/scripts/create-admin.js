#!/usr/bin/env node
/**
 * create-admin.js — Crear o resetear un usuario admin / master_owner.
 *
 * Uso:
 *   node scripts/create-admin.js --email jsalguero@partyhouse.com \
 *                                --name "Jonathan Salguero" \
 *                                --password "MiPasswordNuevo" \
 *                                [--role admin]        # admin | master_owner (default: admin)
 *                                [--telegram 7360106479]  # opcional
 *                                [--dry-run]           # solo imprime el SQL, no toca la BD
 *
 * Requiere las vars del .env:  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 *
 * Lo que hace:
 *   1. Hashea el password con bcrypt (saltRounds=10).
 *   2. Hace upsert en public.app_users por email.
 *      - Si el email no existe → inserta.
 *      - Si ya existe → actualiza password_hash, role, active=true, full_name.
 *   3. Imprime el resultado (id, email, role).
 *
 * Es idempotente: correrlo dos veces no rompe nada, solo pisa el password.
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');

// ---- parse args ----
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) {
      const key = cur.slice(2);
      const next = arr[i + 1];
      if (!next || next.startsWith('--')) acc.push([key, true]);
      else acc.push([key, next]);
    }
    return acc;
  }, [])
);

const email    = args.email;
const name     = args.name;
const password = args.password;
const role     = (args.role || 'admin').toLowerCase();
const telegram = args.telegram ? Number(args.telegram) : null;
const dryRun   = Boolean(args['dry-run']);

if (!email || !name || !password) {
  console.error('\n❌ Faltan argumentos.\n');
  console.error('   node scripts/create-admin.js --email X --name "Nombre" --password "pass"');
  console.error('   Opcional: --role admin|master_owner  --telegram 123  --dry-run\n');
  process.exit(1);
}
if (!['admin', 'master_owner'].includes(role)) {
  console.error(`❌ role inválido: "${role}". Usá admin o master_owner.`);
  process.exit(1);
}
if (password.length < 6) {
  console.error('❌ el password tiene que tener al menos 6 caracteres.');
  process.exit(1);
}

// ---- hash ----
const hash = bcrypt.hashSync(password, 10);
console.log(`\n🔐 Hash bcrypt generado (largo ${hash.length}):`);
console.log(`   ${hash}\n`);

// ---- dry-run: imprimir SQL y salir ----
if (dryRun) {
  console.log('--- SQL equivalente (copiar a Supabase SQL Editor) ---');
  console.log(`insert into public.app_users (telegram_id, full_name, email, role, password_hash, active)
values (${telegram ?? 'NULL'}, '${name.replace(/'/g, "''")}', '${email}', '${role}', '${hash}', true)
on conflict (email) do update
  set full_name     = excluded.full_name,
      role          = excluded.role,
      password_hash = excluded.password_hash,
      telegram_id   = coalesce(excluded.telegram_id, public.app_users.telegram_id),
      active        = true;`);
  console.log('\n(dry-run — no se escribió nada en Supabase)\n');
  process.exit(0);
}

// ---- upsert real ----
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en el .env');
  console.error('   Tip: correlo con --dry-run para obtener solo el SQL y pegarlo a mano.');
  process.exit(1);
}

(async () => {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
  });

  const payload = {
    full_name: name,
    email,
    role,
    password_hash: hash,
    active: true
  };
  if (telegram) payload.telegram_id = telegram;

  // 1) buscar por email para decidir insert vs update (no dependemos de un
  //    unique constraint, así funciona aunque el schema viejo no tenga UNIQUE
  //    en email).
  const { data: existing, error: findErr } = await supabase
    .from('app_users')
    .select('id')
    .eq('email', email)
    .maybeSingle();

  if (findErr) {
    console.error('❌ Error consultando app_users:');
    console.error('  ', findErr.message || findErr);
    process.exit(1);
  }

  let data, error;
  if (existing) {
    ({ data, error } = await supabase
      .from('app_users')
      .update(payload)
      .eq('id', existing.id)
      .select('id, email, full_name, role, active')
      .single());
  } else {
    ({ data, error } = await supabase
      .from('app_users')
      .insert(payload)
      .select('id, email, full_name, role, active')
      .single());
  }

  if (error) {
    console.error('❌ Error al guardar en Supabase:');
    console.error('  ', error.message || error);
    process.exit(1);
  }

  console.log('✅ Usuario guardado:');
  console.log(`   id:    ${data.id}`);
  console.log(`   email: ${data.email}`);
  console.log(`   role:  ${data.role}`);
  console.log(`   name:  ${data.full_name}`);
  console.log(`\n   Login en: ${process.env.PUBLIC_BASE_URL || 'http://localhost:3000'}/admin.html`);
  console.log(`   Usuario:  ${email}  (o  ${name})`);
  console.log(`   Password: ${password}\n`);
})();
