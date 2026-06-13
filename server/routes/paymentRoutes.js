'use strict';
/**
 * Party House — Rutas de Pago v2.0
 *
 * POST /api/payment/intent         → Crear intención de compra
 * POST /api/paypal/create-order    → Crear orden PayPal
 * POST /api/paypal/capture-order   → Capturar pago + emitir tickets
 * POST /api/transfer/submit        → Subir comprobante de transferencia
 */

const { Router } = require('express');
const { body } = require('express-validator');
const multer = require('multer');
const { getSupabase } = require('../db/supabase');
const { asyncHandler } = require('../middleware/errorHandler');
const { validateRequest, purchaseLimiter, paymentLimiter } = require('../middleware/security');
const { issueTickets } = require('../services/TicketService');
const { notifyNewTransfer } = require('../services/TelegramService');
const env = require('../config/env');

const router = Router();

// ── Multer: acepta field 'comprobante' (v2) o 'proof' (legacy) ───
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    const ok = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/.test(file.mimetype);
    if (!ok) { const e = new Error('file_type_not_allowed'); e.code = 'FILE_TYPE'; return cb(e); }
    cb(null, true);
  },
});

const uploadReceipt = upload.fields([
  { name: 'comprobante', maxCount: 1 },
  { name: 'proof',       maxCount: 1 },
]);

// ── PayPal helper ────────────────────────────────────────────────
async function paypalToken() {
  if (!env.hasPayPal) throw Object.assign(new Error('PayPal no configurado.'), { status: 503 });
  const basic = Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(`${env.PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error_description || 'paypal_auth_failed');
  return j.access_token;
}

// ════════════════════════════════════════════════════════════════════
// POST /api/payment/intent — Crear intención de compra
// Body: { event_code_id, full_name, email, quantity, age_verified, terms_accepted }
// ════════════════════════════════════════════════════════════════════
router.post('/payment/intent',
  purchaseLimiter,
  body('event_code_id').custom(v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)).withMessage('event_code_id inválido'),
  body('full_name').trim().isLength({ min: 2, max: 120 }).withMessage('Nombre requerido (2–120 chars)'),
  body('email').trim().isEmail().normalizeEmail().withMessage('Email inválido'),
  body('quantity').custom(v => {
    const n = parseInt(v, 10);
    if (isNaN(n) || n < 1 || n > 20) throw new Error('Cantidad inválida (1–20)');
    return true;
  }),
  body('age_verified').custom(v => {
    if (v === true || v === 'true') return true;
    throw new Error('Debes confirmar mayoría de edad');
  }),
  body('terms_accepted').custom(v => {
    if (v === true || v === 'true') return true;
    throw new Error('Debes aceptar los términos');
  }),
  validateRequest,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { event_code_id, full_name, email, phone, quantity, age_verified, terms_accepted } = req.body;

    const ip = (req.ip || '').replace('::ffff:', '');
    const ua = req.headers['user-agent'] || '';

    const { data, error } = await supabase.rpc('rpc_create_purchase_intent', {
      p_event_code_id:  event_code_id,
      p_full_name:      full_name,
      p_email:          email,
      p_phone:          phone || null,
      p_quantity:       parseInt(quantity, 10),
      p_age_verified:   age_verified === true || age_verified === 'true',
      p_terms_accepted: terms_accepted === true || terms_accepted === 'true',
      p_ip_address:     ip || null,
      p_user_agent:     ua || null,
    });

    if (error) {
      console.error('[payment.intent]', error);
      return res.status(500).json({ error: 'db_error' });
    }
    if (data?.error) {
      const statusMap = {
        age_not_verified:       400,
        terms_not_accepted:     400,
        quantity_invalid:       400,
        name_required:          400,
        email_invalid:          400,
        event_code_invalid:     404,
        event_not_available:    410,
        quantity_exceeds_limit: 400,
        insufficient_capacity:  409,
      };
      return res.status(statusMap[data.error] || 400).json(data);
    }

    return res.json(data);
  })
);

// ════════════════════════════════════════════════════════════════════
// POST /api/paypal/create-order — Crear orden en PayPal
// Body: { order_id }
// ════════════════════════════════════════════════════════════════════
router.post('/paypal/create-order',
  paymentLimiter,
  body('order_id').isUUID().withMessage('order_id inválido'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { order_id } = req.body;

    const { data: order, error: oErr } = await supabase
      .from('orders')
      .select('id, event_id, quantity, amount_usd, payment_status, buyer_name, event:events(name)')
      .eq('id', order_id)
      .eq('payment_status', 'pending')
      .maybeSingle();

    if (oErr || !order) {
      return res.status(404).json({ error: 'order_not_found_or_not_pending' });
    }

    const accessToken = await paypalToken();
    const ppRes = await fetch(`${env.PAYPAL_BASE}/v2/checkout/orders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: order.id,
          description: `${order.event?.name || 'Party House'} — ${order.quantity} ${order.quantity === 1 ? 'entrada' : 'entradas'}`,
          amount: { currency_code: 'USD', value: Number(order.amount_usd).toFixed(2) },
        }],
      }),
    });

    const ppBody = await ppRes.json();
    if (!ppRes.ok) {
      console.error('[paypal.create]', ppBody);
      return res.status(502).json({ error: 'paypal_create_failed' });
    }

    return res.json({
      id:              ppBody.id,
      paypal_order_id: ppBody.id,   // alias para el SDK del frontend
      amount_usd:      order.amount_usd,
      quantity:        order.quantity,
    });
  })
);

// ════════════════════════════════════════════════════════════════════
// POST /api/paypal/capture-order — Capturar pago + emitir tickets
// Body: { order_id, paypal_order_id }
// ════════════════════════════════════════════════════════════════════
router.post('/paypal/capture-order',
  paymentLimiter,
  body('order_id').isUUID().withMessage('order_id inválido'),
  body('paypal_order_id').notEmpty().withMessage('paypal_order_id requerido'),
  validateRequest,
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { order_id, paypal_order_id } = req.body;

    const { data: order, error: oErr } = await supabase
      .from('orders')
      .select(`
        id, event_id, buyer_id, buyer_name, buyer_email,
        quantity, amount_usd, payment_status,
        event:events(name, event_date, venue)
      `)
      .eq('id', order_id)
      .maybeSingle();

    if (oErr || !order) return res.status(404).json({ error: 'order_not_found' });

    // Idempotencia: ya pagado
    if (order.payment_status === 'paid') {
      const { generateDownloadToken } = require('../services/QrService');
      return res.json({ ok: true, download_token: generateDownloadToken(order_id), already_paid: true });
    }

    if (order.payment_status !== 'pending') {
      return res.status(409).json({ error: 'order_not_pending', status: order.payment_status });
    }

    // Capturar en PayPal
    const accessToken = await paypalToken();
    const captureRes = await fetch(
      `${env.PAYPAL_BASE}/v2/checkout/orders/${paypal_order_id}/capture`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      }
    );
    const captureBody = await captureRes.json();
    if (!captureRes.ok || captureBody.status !== 'COMPLETED') {
      console.error('[paypal.capture]', captureBody);
      return res.status(502).json({ error: 'paypal_capture_failed' });
    }

    // Confirmar en Supabase
    const { data: confirmData, error: confirmErr } = await supabase.rpc('rpc_confirm_paypal_order', {
      p_order_id:        order_id,
      p_paypal_order_id: paypal_order_id,
      p_amount_usd:      Number(order.amount_usd),
    });
    if (confirmErr || confirmData?.error) {
      console.error('[paypal.confirm_db]', confirmErr, confirmData);
      return res.status(500).json({ error: 'db_confirm_failed' });
    }

    // Emitir tickets
    const result = await issueTickets({
      orderId:    order.id,
      eventId:    order.event_id,
      buyerId:    order.buyer_id,
      buyerName:  order.buyer_name,
      buyerEmail: order.buyer_email,
      quantity:   order.quantity,
      eventName:  order.event?.name || 'Party House',
      eventDate:  order.event?.event_date || null,
      eventVenue: order.event?.venue || '',
    });

    return res.json({
      ok:               true,
      download_token:   result.downloadToken,
      correlative_codes: result.correlativeCodes,
      quantity:         result.quantity,
    });
  })
);

// ════════════════════════════════════════════════════════════════════
// POST /api/transfer/submit — Subir comprobante de transferencia
// Multipart: fields comprobante|proof (file) + order_id + reference
// ════════════════════════════════════════════════════════════════════
router.post('/transfer/submit',
  purchaseLimiter,
  (req, res, next) => {
    uploadReceipt(req, res, err => {
      if (!err) {
        // Normalizar: req.file apunta al archivo sin importar qué field se usó
        req.file = req.files?.comprobante?.[0] || req.files?.proof?.[0] || null;
        return next();
      }
      if (err.code === 'LIMIT_FILE_SIZE')   return res.status(413).json({ error: 'file_too_large' });
      if (err.code === 'FILE_TYPE')         return res.status(415).json({ error: 'file_type_not_allowed' });
      next(err);
    });
  },
  asyncHandler(async (req, res) => {
    const supabase = getSupabase();
    const { order_id, reference } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ error: 'proof_required', message: 'Sube el comprobante de pago.' });
    }
    if (!order_id || !/^[0-9a-f-]{36}$/i.test(order_id)) {
      return res.status(400).json({ error: 'order_id_invalid' });
    }

    const safeRef = (reference || '').slice(0, 120).trim();

    // Cargar orden pending
    const { data: order, error: oErr } = await supabase
      .from('orders')
      .select(`
        id, payment_status, buyer_name, buyer_email, quantity, amount_usd,
        event:events(name),
        buyer:buyers(full_name, email)
      `)
      .eq('id', order_id)
      .eq('payment_status', 'pending')
      .maybeSingle();

    if (oErr || !order) return res.status(404).json({ error: 'order_not_found_or_not_pending' });

    // Subir a Supabase Storage
    const ext = (file.mimetype.split('/')[1] || 'bin').replace('jpeg', 'jpg');
    const objectPath = `${order_id}/${Date.now()}.${ext}`;

    const { error: upErr } = await supabase.storage
      .from(env.RECEIPTS_BUCKET)
      .upload(objectPath, file.buffer, { contentType: file.mimetype, upsert: false });

    if (upErr) {
      console.error('[transfer.storage]', upErr);
      return res.status(500).json({ error: 'storage_upload_failed' });
    }

    // URL firmada (1 año de validez)
    const { data: signedData, error: signErr } = await supabase.storage
      .from(env.RECEIPTS_BUCKET)
      .createSignedUrl(objectPath, 60 * 60 * 24 * 365);

    if (signErr || !signedData?.signedUrl) {
      return res.status(500).json({ error: 'storage_sign_failed' });
    }

    // Registrar en BD via RPC
    const { data: submitData, error: submitErr } = await supabase.rpc('rpc_submit_transfer_order', {
      p_order_id:    order_id,
      p_reference:   safeRef || null,
      p_receipt_url: signedData.signedUrl,
    });

    if (submitErr || submitData?.error) {
      console.error('[transfer.rpc]', submitErr, submitData);
      return res.status(500).json({ error: 'db_transfer_failed' });
    }

    // Notificar admin por Telegram (fire-and-forget)
    notifyNewTransfer({
      fileBuffer: file.buffer,
      fileName:   file.originalname || 'comprobante',
      mimeType:   file.mimetype,
      buyerName:  order.buyer_name || order.buyer?.full_name || 'Comprador',
      quantity:   order.quantity,
      eventName:  order.event?.name || 'Party House',
   