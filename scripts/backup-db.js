'use strict';
/**
 * Backup de Supabase → archivo JSON local
 * Uso: node scripts/backup-db.js
 */

require('../server/node_modules/dotenv').config({ path: require('path').join(__dirname, '../server/.env') });
const { createClient } = require('../server/node_modules/@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const TABLES = [
  'events',
  'orders',
  'tickets',
  'buyers',
  'user_profiles',
  'app_users',
  'validation_log',
  'access_codes',
  'guests',
];

async function backup() {
  console.log('🔄 Iniciando backup...\n');
  const result = {};

  for (const table of TABLES) {
    const { data, error } = await supabase.from(table).select('*');
    if (error) {
      console.warn(`  ⚠️  ${table}: ${error.message}`);
      result[table] = [];
    } else {
      result[table] = data || [];
      console.log(`  ✓  ${table}: ${result[table].length} filas`);
    }
  }

  const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const outDir = path.join(__dirname, '../backups');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `backup_${timestamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2));

  console.log(`\n✅ Backup guardado en: backups/backup_${timestamp}.json`);
}

backup().catch(e => { console.error('Error:', e.message); process.exit(1); });
