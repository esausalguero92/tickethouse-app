'use strict';
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const env = require('../config/env');

let _client = null;

function getSupabase() {
  if (_client) return _client;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase no configurado. Revisa SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.');
  }
  _client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
    realtime: { transport: ws },
  });
  return _client;
}

module.exports = { getSupabase };
