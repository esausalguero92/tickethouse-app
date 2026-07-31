'use strict';

const { Router } = require('express');
const { body }   = require('express-validator');
const { getSupabase }  = require('../db/supabase');
const { asyncHandler } = require('../middleware/errorHandler');
const { validateRequest, purchaseLimiter } = require('../middleware/security');

const router = Router();

// POST /api/discount/validate
// Valida un código de descuento y devuelve el monto descontado.
// No requiere auth — es llamado desde el frontend público.
router.post('/discount/validate',
  purchaseLimiter,
  body('code').trim().notEmpty().withMessage('code requerido'),
  body('event_id').isUUID().withMessage('event_id inválido'),
  body('amount_usd').isFloat({ gt: 0 }).withMessage('amount_usd debe ser mayor a 0'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { code, event_id, amount_usd } = req.body;

    const { data, error } = await supabase.rpc('rpc_validate_discount_code', {
      p_code:       code,
      p_event_id:   event_id,
      p_amount_usd: parseFloat(amount_usd),
    });

    if (error) {
      console.error('[discount.validate]', error);
      return res.status(500).json({ error: 'db_error' });
    }

    if (!data || !data.valid) {
      const msgMap = {
        code_not_found: 'Código de descuento inválido.',
        code_expired:   'Este código de descuento ha vencido.',
        code_exhausted: 'Este código ya alcanzó el límite de usos.',
      };
      const errKey = data && data.error ? data.error : 'code_not_found';
      return res.status(400).json({ valid: false, error: errKey, message: msgMap[errKey] || 'Código inválido.' });
    }

    return res.json(data);
  })
);

module.exports = router;
