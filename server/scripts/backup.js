'use strict';
/**
 * Backup completo de la base de datos Supabase (Party House).
 * Exporta todas las tablas relevantes a JSON, una por archivo,
 * dentro de una carpeta con timestamp.
 *
 * Uso:
 *   cd server
 *   node scripts/backup.js
 *
 * Requiere SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en server/.env
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Todas las tablas del esquema que queremos respaldar.
// Agregar/quitar aqui si el esquema cambia.
const TABLES = [
  'events',
  'event_codes',
  'event_categories',
  'event_images',
  'event_rules',
  'amenities',
  'orders',
  'tickets',
  'buyers',
  'access_codes',
  'guests',
  'app_users',
  'user_profiles',
  'validation_log',
  'activity_log',
  '_backup_access_codes',
  '_backup_guests',
];

async function dumpTable(table) {
  const PAGE_SIZE = 1000;
  let all = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      // Tabla no existe o no accesible -- continuar con las demas.
      console.warn(`  [SKIP] ${table}: ${error.message}`);
      return null;
    }
    if (!data || data.length === 0) break;

    all = all.concat(data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return all;
}

async function main() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, '..', '..', 'backups', `backup_${ts}`);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`Backup -> ${outDir}\n`);

  const summary = {};

  for (const table of TABLES) {
    process.stdout.write(`Exportando ${table}... `);
    const rows = await dumpTable(table);
    if (rows === null) {
      summary[table] = 'error';
      continue;
    }
    fs.writeFileSync(
      path.join(outDir, `${table}.json`),
      JSON.stringify(rows, null, 2)
    );
    summary[table] = rows.length;
    console.log(`${rows.length} filas`);
  }

  fs.writeFileSync(
    path.join(outDir, '_summary.json'),
    JSON.stringify({ timestamp: ts, tables: summary }, null, 2)
  );

  console.log('\n=== RESUMEN ===');
  for (const [table, count] of Object.entries(summary)) {
    console.log(`  ${table}: ${count}`);
  }
  console.log(`\nBackup completo en: ${outDir}`);
}

main().catch((e) => {
  console.error('Error en backup:', e);
  process.exit(1);
});
