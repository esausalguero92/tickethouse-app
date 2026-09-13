'use strict';
/**
 * TicketCodeService — Genera códigos públicos de ticket.
 *
 * Formato: TH-{PREFIX}-{NNNNNN}
 *   PREFIX: 2-4 letras mayúsculas derivadas del evento (ej. BLG, PH, GTM)
 *   NNNNNN: 6 dígitos criptográficamente seguros (NO Math.random)
 *
 * Ejemplo: TH-BLG-482719
 *
 * Seguridad:
 *   - Usa crypto.randomInt() de Node.js (CSPRNG) — nunca Math.random().
 *   - Verifica unicidad contra la BD antes de retornar.
 *   - Nunca expone secuencial visible; no depende de contador correlativo.
 */

const crypto = require('crypto');
const { getSupabase } = require('../db/supabase');

/**
 * Genera un código candidato (sin verificar unicidad).
 * @param {string} eventPrefix  Prefijo del evento (2-4 letras, ej. "BLG")
 * @returns {string}            "TH-BLG-482719"
 */
function generateCandidateCode(eventPrefix) {
  // crypto.randomInt(min, max) — excluye max, rango [100000, 999999]
  const digits = crypto.randomInt(100000, 1000000);
  const prefix = String(eventPrefix || 'TH').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4) || 'TH';
  return `TH-${prefix}-${digits}`;
}

/**
 * Genera N códigos únicos verificados en BD.
 * Reintenta en caso de colisión (probabilidad < 0.001% para eventos < 10k tickets).
 *
 * @param {string} eventPrefix  Prefijo del evento
 * @param {number} quantity     Cantidad de códigos a generar
 * @returns {Promise<string[]>} Array de códigos únicos
 */
async function generateUniqueCodes(eventPrefix, quantity) {
  const supabase = getSupabase();
  const codes = new Set();
  const MAX_ATTEMPTS = quantity * 10; // margen amplio para reintentos
  let attempts = 0;

  while (codes.size < quantity && attempts < MAX_ATTEMPTS) {
    attempts++;

    const candidate = generateCandidateCode(eventPrefix);
    if (codes.has(candidate)) continue;

    // Verificar en BD que no exista ya
    const { data: existing, error } = await supabase
      .from('tickets')
      .select('id')
      .eq('public_code', candidate)
      .maybeSingle();

    if (error) {
      console.error('[TicketCodeService] Error verificando unicidad:', error.message);
      throw new Error('code_uniqueness_check_failed');
    }

    if (!existing) {
      codes.add(candidate);
    }
  }

  if (codes.size < quantity) {
    throw new Error(`No se pudieron generar ${quantity} códigos únicos tras ${MAX_ATTEMPTS} intentos`);
  }

  return Array.from(codes);
}

module.exports = { generateCandidateCode, generateUniqueCodes };
