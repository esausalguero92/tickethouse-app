/**
 * Party House — Servidor Node.js (Express) — backend completo
 *
 * Responsabilidades:
 *   1. Servir la landing estática (html/css/js).
 *   2. Flujo PayPal end-to-end: create-order, capture-order, firma JWT del QR,
 *      inserta orden + ticket en Supabase.
 *   3. Flujo transferencia manual: submit (crea orden awaiting_review) + panel
 *      admin para confirmar/rechazar y emitir el ticket.
 *   4. Login de staff (PIN) y validación de QR en puerta.
 *   5. Descarga del QR como PNG.
 *
 * N8N ya NO interviene en pagos: solo se encarga del bot admin de Telegram
 * (crear invitados y generar códigos con IA) escribiendo directamente a Supabase.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const multer = require('multer');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-dev-secret';
const STAFF_PIN = process.env.STAFF_PIN || '1234';

const PAYPAL_BASE = process.env.PAYPAL_BASE || 'https://api-m.sandbox.paypal.com';
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';

const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER || '';
const BANK_DETAILS = process.env.BANK_DETAILS || 'Banco Ejemplo · Cuenta: 0000-0000-0000 · Titular: Party House SA';

// Notificaciones Telegram al admin cuando hay nueva transferencia
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ADMIN_TELEGRAM_IDS = (process.env.ADMIN_TELEGRAM_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// Email con el QR (SMTP propio — Roundcube/hosting)
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'true').toLowerCase() === 'true';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const MAIL_FROM = process.env.MAIL_FROM || (SMTP_USER ? `Party House <${SMTP_USER}>` : '');

// URL pública (para armar links en emails y Telegram)
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

// Storage
const RECEIPTS_BUCKET = process.env.RECEIPTS_BUCKET || 'receipts';
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5MB

// ---------- Warnings ----------
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('[warn] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY no configurados.');
}
if (JWT_SECRET === 'change-me-dev-secret') {
  console.warn('[warn] JWT_SECRET no configurado — usando secreto de desarrollo.');
}
if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
  console.warn('[warn] PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET no configurados — /api/paypal/* devolverá error.');
}
if (!TELEGRAM_BOT_TOKEN || ADMIN_TELEGRAM_IDS.length === 0) {
  console.warn('[warn] TELEGRAM_BOT_TOKEN / ADMIN_TELEGRAM_IDS no configurados — el admin no recibirá notificaciones de transferencias.');
}
if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
  console.warn('[warn] SMTP_HOST / SMTP_USER / SMTP_PASS incompletos — no se enviará email con el QR al confirmar transferencias.');
}

const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;

// Transporter SMTP (reutilizable; pool de conexiones para no re-auth cada vez).
const mailTransport = (SMTP_HOST && SMTP_USER && SMTP_PASS)
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE, // true=puerto 465 (SSL), false=puerto 587 (STARTTLS)
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      pool: true,
      maxConnections: 3,
      maxMessages: 50,
      // Aceptar certificados self-signed/shared-hosting (muchos hostings los usan)
      tls: { rejectUnauthorized: false }
    })
  : null;

// Verificar conexión SMTP al arrancar (no bloquea boot).
if (mailTransport) {
  mailTransport.verify()
    .then(() => console.log(`[mail] SMTP listo en ${SMTP_HOST}:${SMTP_PORT} (secure=${SMTP_SECURE})`))
    .catch(err => console.warn('[mail] SMTP verify falló:', err.message || err));
}

// Multer: memoria, 5MB, imágenes/pdf
const uploadReceipt = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    const ok = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/.test(file.mimetype);
    if (!ok) return cb(new Error('file_type_not_allowed'));
    cb(null, true);
  }
});

// ---------- App ----------
const app = express();
app.use(cors());
app.use(express.json({ limit: '512kb' }));
app.use(express.static(path.join(__dirname, '..', 'landing')));

// ---------- Helpers ----------
function signJwt(payload, opts = {}) {
  return jwt.sign(payload, JWT_SECRET, opts);
}
function verifyJwt(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

// Middleware genérico para rutas staff
function requireStaff(req, res, next) {
  const token = req.header('x-staff-token');
  const p = verifyJwt(token);
  if (!p || p.role !== 'staff') return res.status(401).json({ error: 'sesión inválida' });
  req.staff = p;
  next();
}

// Middleware para rutas admin
function requireAdmin(req, res, next) {
  const token = req.header('x-admin-token');
  const p = verifyJwt(token);
  if (!p || (p.role !== 'admin' && p.role !== 'master_owner')) {
    return res.status(401).json({ error: 'sesión admin inválida' });
  }
  req.admin = p;
  next();
}

async function paypalAccessToken() {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) throw new Error('paypal_not_configured');
  const basic = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + basic,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error_description || 'paypal_auth_failed');
  return body.access_token;
}

// Busca código + evento + guest. Devuelve null si el código no sirve.
async function loadCodeContext(code) {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('access_codes')
    .select('id, code, status, event_id, guest_id, event:events(*), guest:guests(*)')
    .eq('code', String(code || '').toUpperCase().trim())
    .maybeSingle();
  if (error || !data) return null;
  if (data.status !== 'active') return null;
  return data;
}

// Firma el JWT del ticket y lo inserta vía RPC.
async function createTicketForOrder({ orderId, eventId, guestId, code, eventDate }) {
  // Expira 48h después del evento (o 60 días si no hay event_date parseable)
  const now = Math.floor(Date.now() / 1000);
  let exp = now + 60 * 60 * 24 * 60;
  if (eventDate) {
    const t = new Date(eventDate).getTime();
    if (!isNaN(t)) exp = Math.floor(t / 1000) + 60 * 60 * 48;
  }
  const qrToken = jwt.sign(
    { t: 'ph.ticket', oid: orderId, eid: eventId, gid: guestId, code, iat: now, exp },
    JWT_SECRET
  );
  const { error } = await supabase.rpc('rpc_issue_ticket', {
    p_order_id: orderId,
    p_qr_token: qrToken,
    p_payload: { code, event_id: eventId, guest_id: guestId }
  });
  if (error) throw new Error(error.message || 'issue_ticket_failed');
  return qrToken;
}

// ---------- Telegram helpers ----------
async function telegramCall(method, body) {
  if (!TELEGRAM_BOT_TOKEN) throw new Error('telegram_not_configured');
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.description || `telegram_${method}_failed`);
  return j.result;
}

// Manda la foto con caption a cada admin. Non-blocking: captura errores.
async function notifyAdminsNewTransfer({ photoUrl, guestName, code, eventName, amountUsd, reference, orderId }) {
  if (!TELEGRAM_BOT_TOKEN || ADMIN_TELEGRAM_IDS.length === 0) return;
  const lines = [
    'Nueva transferencia pendiente',
    '',
    `Invitado: ${guestName}`,
    `Código: ${code}`,
    `Evento: ${eventName}`,
    `Monto: USD ${Number(amountUsd).toFixed(2)}`,
    reference ? `Folio: ${reference}` : 'Folio: (sin folio)',
    '',
    `Revisar en: ${PUBLIC_BASE_URL}/admin.html`,
    `Order: ${orderId}`
  ];
  const caption = lines.join('\n');

  for (const chatId of ADMIN_TELEGRAM_IDS) {
    try {
      if (photoUrl) {
        await telegramCall('sendPhoto', { chat_id: chatId, photo: photoUrl, caption });
      } else {
        await telegramCall('sendMessage', { chat_id: chatId, text: caption });
      }
    } catch (e) {
      console.error(`[telegram.notify ${chatId}]`, e.message || e);
    }
  }
}

// ---------- Email helper (SMTP / nodemailer) ----------
async function sendTicketEmail({ toEmail, guestName, eventName, code, qrToken }) {
  if (!mailTransport) return { skipped: true };
  if (!toEmail) return { skipped: true, reason: 'no_email' };
  const png = await QRCode.toBuffer(qrToken, { width: 512, margin: 2 });
  const ticketUrl = `${PUBLIC_BASE_URL}/ticket.html?code=${encodeURIComponent(code)}`;
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:auto;padding:24px;background:#0b0815;color:#f5f3fa;">
      <h1 style="color:#ff3cf0;margin:0 0 8px 0;">Party House</h1>
      <p style="color:#9f98b3;margin:0 0 24px 0;">Tu entrada está lista.</p>
      <p>Hola ${guestName},</p>
      <p>Se confirmó tu transferencia para <strong>${eventName}</strong>. Tu código de acceso es <strong>${code}</strong>.</p>
      <p>En el archivo adjunto está el QR que vas a mostrar en la puerta. Si lo preferís, también podés descargarlo desde la web:</p>
      <p><a href="${ticketUrl}" style="display:inline-block;background:linear-gradient(90deg,#ff3cf0,#00f0ff);color:#0b0815;font-weight:700;text-decoration:none;padding:12px 20px;border-radius:8px;">Ver y descargar mi QR</a></p>
      <p style="color:#9f98b3;font-size:12px;margin-top:24px;">Si no reconocés esta compra, ignorá este email.</p>
    </div>
  `;
  const text =
    `Party House — Tu entrada está lista.\n\n` +
    `Hola ${guestName},\n\n` +
    `Se confirmó tu transferencia para ${eventName}. Tu código de acceso es ${code}.\n\n` +
    `En el archivo adjunto va el QR. También podés descargarlo desde: ${ticketUrl}\n`;
  const info = await mailTransport.sendMail({
    from: MAIL_FROM,
    to: toEmail,
    subject: `🎟 Tu entrada para ${eventName}`,
    html,
    text,
    attachments: [
      { filename: `party-house-${code}.png`, content: png, contentType: 'image/png' }
    ]
  });
  return { id: info.messageId };
}

// =====================================================
// A) FLUJO INVITADO — PAYPAL
// =====================================================

// Crea una orden en PayPal y devuelve el id para que el SDK lo consuma.
app.post('/api/paypal/create-order', async (req, res) => {
  try {
    if (!supabase) return res.status(503).json({ error: 'supabase_not_configured' });
    const code = String(req.body.code || '');
    const ctx = await loadCodeContext(code);
    if (!ctx) return res.status(400).json({ error: 'code_invalid' });

    // No permitir si ya tiene orden pagada
    const { data: existing } = await supabase
      .from('orders')
      .select('id, payment_status')
      .eq('code_id', ctx.id)
      .in('payment_status', ['paid', 'awaiting_review']);
    if (existing && existing.length) {
      return res.status(409).json({ error: 'order_exists' });
    }

    const accessToken = await paypalAccessToken();
    const r = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: ctx.code,
          description: `${ctx.event.name} · ${ctx.guest.first_name} ${ctx.guest.last_name}`,
          amount: { currency_code: 'USD', value: Number(ctx.event.price_usd).toFixed(2) }
        }]
      })
    });
    const body = await r.json();
    if (!r.ok) {
      console.error('[paypal.create]', body);
      return res.status(502).json({ error: 'paypal_create_failed', detail: body });
    }
    return res.json({ id: body.id });
  } catch (e) {
    console.error('[create-order]', e);
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// Captura la orden y emite el ticket.
app.post('/api/paypal/capture-order', async (req, res) => {
  try {
    if (!supabase) return res.status(503).json({ error: 'supabase_not_configured' });
    const code = String(req.body.code || '');
    const paypalOrderId = String(req.body.paypal_order_id || '');
    if (!paypalOrderId) return res.status(400).json({ error: 'paypal_order_id_required' });

    const ctx = await loadCodeContext(code);
    if (!ctx) return res.status(400).json({ error: 'code_invalid' });

    const accessToken = await paypalAccessToken();
    const r = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${paypalOrderId}/capture`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': 'application/json'
      }
    });
    const body = await r.json();
    if (!r.ok || body.status !== 'COMPLETED') {
      console.error('[paypal.capture]', body);
      return res.status(502).json({ error: 'paypal_capture_failed', detail: body });
    }

    // Crear la orden en Supabase con la RPC existente
    const { data: rpcData, error: rpcErr } = await supabase.rpc('rpc_create_paypal_order', {
      p_code: ctx.code,
      p_amount_usd: Number(ctx.event.price_usd),
      p_paypal_order_id: paypalOrderId
    });
    if (rpcErr || (rpcData && rpcData.error)) {
      console.error('[rpc_create_paypal_order]', rpcErr, rpcData);
      return res.status(500).json({ error: 'db_order_failed' });
    }

    // Emitir ticket
    const qrToken = await createTicketForOrder({
      orderId: rpcData.order_id,
      eventId: ctx.event_id,
      guestId: ctx.guest_id,
      code: ctx.code,
      eventDate: ctx.event.event_date
    });

    return res.json({ ok: true, qr_token: qrToken, ticket_url: './ticket.html' });
  } catch (e) {
    console.error('[capture-order]', e);
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// =====================================================
// B) FLUJO INVITADO — TRANSFERENCIA MANUAL
// =====================================================

// Config pública que la landing necesita para mostrar datos bancarios y
// el número de WhatsApp al que hay que enviar el comprobante.
app.get('/api/transfer/info', (_req, res) => {
  res.json({
    whatsapp: WHATSAPP_NUMBER,
    bank_details: BANK_DETAILS
  });
});

// El invitado sube la imagen/PDF del comprobante. La guardamos en el bucket
// privado `receipts` de Supabase Storage, firmamos una URL y registramos la
// orden awaiting_review. Después avisamos al admin por Telegram con la foto.
app.post('/api/transfer/submit', (req, res, next) => {
  uploadReceipt.single('proof')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'file_too_large' });
    if (err.message === 'file_type_not_allowed') return res.status(415).json({ error: 'file_type_not_allowed' });
    console.error('[multer]', err);
    return res.status(400).json({ error: 'upload_failed' });
  });
}, async (req, res) => {
  try {
    if (!supabase) return res.status(503).json({ error: 'supabase_not_configured' });

    const code = String(req.body.code || '');
    const reference = String(req.body.reference || '').trim().slice(0, 120);
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'proof_required' });

    const ctx = await loadCodeContext(code);
    if (!ctx) return res.status(400).json({ error: 'code_invalid' });

    // No permitir duplicados
    const { data: existing } = await supabase
      .from('orders')
      .select('id, payment_status')
      .eq('code_id', ctx.id)
      .in('payment_status', ['paid', 'awaiting_review']);
    if (existing && existing.length) {
      return res.status(409).json({ error: 'order_exists' });
    }

    // Subir archivo al bucket privado
    const ext = (file.mimetype.split('/')[1] || 'bin').replace('jpeg', 'jpg');
    const objectPath = `${ctx.code}/${Date.now()}.${ext}`;
    const up = await supabase.storage
      .from(RECEIPTS_BUCKET)
      .upload(objectPath, file.buffer, { contentType: file.mimetype, upsert: false });
    if (up.error) {
      console.error('[storage.upload]', up.error);
      return res.status(500).json({ error: 'storage_upload_failed' });
    }

    // URL firmada (1 año) — se guarda en orders.transfer_receipt_url
    const signed = await supabase.storage
      .from(RECEIPTS_BUCKET)
      .createSignedUrl(objectPath, 60 * 60 * 24 * 365);
    if (signed.error || !signed.data?.signedUrl) {
      console.error('[storage.sign]', signed.error);
      return res.status(500).json({ error: 'storage_sign_failed' });
    }
    const receiptUrl = signed.data.signedUrl;

    const { data, error } = await supabase.rpc('rpc_create_transfer_order', {
      p_code: ctx.code,
      p_amount_usd: Number(ctx.event.price_usd),
      p_reference: reference || null,
      p_receipt_url: receiptUrl
    });
    if (error || (data && data.error)) {
      console.error('[rpc_create_transfer_order]', error, data);
      return res.status(500).json({ error: 'db_transfer_failed' });
    }

    // Notificar al admin (non-blocking: no romper la respuesta si falla Telegram)
    notifyAdminsNewTransfer({
      photoUrl: file.mimetype.startsWith('image/') ? receiptUrl : null,
      guestName: `${ctx.guest.first_name} ${ctx.guest.last_name || ''}`.trim(),
      code: ctx.code,
      eventName: ctx.event.name,
      amountUsd: ctx.event.price_usd,
      reference: reference || '',
      orderId: data.order_id
    }).catch(e => console.error('[notify]', e.message || e));

    return res.json({
      ok: true,
      order_id: data.order_id,
      email: ctx.guest.email || null
    });
  } catch (e) {
    console.error('[transfer.submit]', e);
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// =====================================================
// C) ADMIN PANEL (web) — login + transferencias
// =====================================================

app.post('/api/admin/login', async (req, res) => {
  try {
    if (!supabase) return res.status(503).json({ error: 'supabase_not_configured' });
    const user = String(req.body.user || '').trim();
    const password = String(req.body.password || '');
    if (!user || !password) return res.status(400).json({ error: 'user_password_required' });

    // Buscamos por email o full_name
    const { data: u, error } = await supabase
      .from('app_users')
      .select('id, full_name, email, role, active, password_hash')
      .or(`email.eq.${user},full_name.eq.${user}`)
      .in('role', ['admin', 'master_owner'])
      .maybeSingle();
    if (error || !u || !u.active || !u.password_hash) {
      return res.status(401).json({ error: 'credenciales_invalidas' });
    }
    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return res.status(401).json({ error: 'credenciales_invalidas' });

    const token = signJwt({ sid: u.id, role: u.role, name: u.full_name }, { expiresIn: '12h' });
    return res.json({ token, admin: { id: u.id, name: u.full_name, role: u.role } });
  } catch (e) {
    console.error('[admin.login]', e);
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// Lista transferencias pendientes (awaiting_review) con datos del invitado
app.get('/api/admin/transfers/pending', requireAdmin, async (_req, res) => {
  try {
    if (!supabase) return res.status(503).json({ error: 'supabase_not_configured' });
    const { data, error } = await supabase
      .from('orders')
      .select(`
        id, amount_usd, transfer_reference, created_at,
        guest:guests(first_name, last_name, email, phone),
        event:events(id, name, event_date),
        code:access_codes(code)
      `)
      .eq('payment_status', 'awaiting_review')
      .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ transfers: data || [] });
  } catch (e) {
    console.error('[admin.pending]', e);
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// Confirma una transferencia → emite ticket y devuelve el qr_token al admin.
app.post('/api/admin/transfers/:id/confirm', requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(503).json({ error: 'supabase_not_configured' });
    const orderId = req.params.id;

    // 1) Marcar la orden como paid
    const { data: order, error: upErr } = await supabase
      .from('orders')
      .update({
        payment_status: 'paid',
        paid_at: new Date().toISOString(),
        reviewed_by: req.admin.sid,
        reviewed_at: new Date().toISOString()
      })
      .eq('id', orderId)
      .eq('payment_status', 'awaiting_review')
      .select('id, event_id, guest_id, code_id')
      .maybeSingle();
    if (upErr || !order) {
      return res.status(404).json({ error: 'order_not_found_or_not_pending' });
    }

    // 2) Cargar datos para el ticket + email
    const { data: extras } = await supabase
      .from('access_codes')
      .select('code, event:events(name, event_date), guest:guests(first_name, last_name, email)')
      .eq('id', order.code_id)
      .maybeSingle();

    // 3) Emitir ticket
    const qrToken = await createTicketForOrder({
      orderId: order.id,
      eventId: order.event_id,
      guestId: order.guest_id,
      code: extras?.code || '',
      eventDate: extras?.event?.event_date
    });

    // 4) Mandar email con el QR (non-blocking)
    const guestEmail = extras?.guest?.email;
    const guestName = `${extras?.guest?.first_name || ''} ${extras?.guest?.last_name || ''}`.trim();
    let emailStatus = 'skipped';
    if (guestEmail && mailTransport) {
      try {
        const r = await sendTicketEmail({
          toEmail: guestEmail,
          guestName: guestName || 'Invitado/a',
          eventName: extras?.event?.name || 'Party House',
          code: extras?.code || '',
          qrToken
        });
        emailStatus = r?.id ? 'sent' : 'skipped';
      } catch (e) {
        console.error('[email.ticket]', e.message || e);
        emailStatus = 'failed';
      }
    }

    return res.json({ ok: true, qr_token: qrToken, code: extras?.code || null, email_status: emailStatus });
  } catch (e) {
    console.error('[admin.confirm]', e);
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// Rechaza una transferencia
app.post('/api/admin/transfers/:id/reject', requireAdmin, async (req, res) => {
  try {
    if (!supabase) return res.status(503).json({ error: 'supabase_not_configured' });
    const orderId = req.params.id;
    const reason = String(req.body.reason || '').slice(0, 200);
    const { data, error } = await supabase
      .from('orders')
      .update({
        payment_status: 'rejected',
        reviewed_by: req.admin.sid,
        reviewed_at: new Date().toISOString()
      })
      .eq('id', orderId)
      .eq('payment_status', 'awaiting_review')
      .select('id')
      .maybeSingle();
    if (error || !data) return res.status(404).json({ error: 'order_not_found_or_not_pending' });
    if (reason) {
      await supabase.from('activity_log').insert({
        actor_id: req.admin.sid,
        action: 'transfer_rejected',
        entity: 'orders',
        entity_id: orderId,
        payload: { reason }
      });
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error('[admin.reject]', e);
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// =====================================================
// D) DESCARGA DEL QR (PNG)
// =====================================================
// El invitado lo pide desde ticket.html; no requiere auth porque el código
// ya es el secreto (solo el invitado lo conoce). Devuelve 404 si no hay ticket.
app.get('/api/qr/:code/download', async (req, res) => {
  try {
    if (!supabase) return res.status(503).send('supabase_not_configured');
    const code = String(req.params.code || '').toUpperCase().trim();
    const { data, error } = await supabase.rpc('rpc_get_my_ticket', { p_code: code });
    if (error || !data || data.error) return res.status(404).send('ticket_no_encontrado');
    const token = data.ticket?.qr_token;
    if (!token) return res.status(404).send('sin_qr_token');

    const png = await QRCode.toBuffer(token, { width: 512, margin: 2 });
    res.set('Content-Type', 'image/png');
    res.set('Content-Disposition', `attachment; filename="party-house-${code}.png"`);
    return res.send(png);
  } catch (e) {
    console.error('[qr.download]', e);
    return res.status(500).send(String(e.message || e));
  }
});

// =====================================================
// E) STAFF (puerta) — login + validación
// =====================================================

app.post('/api/staff/login', async (req, res) => {
  try {
    const { user, pin } = req.body || {};
    if (!user || !pin) return res.status(400).json({ error: 'user_pin_required' });

    let authed = false;
    if (supabase) {
      const { data } = await supabase
        .from('app_users')
        .select('id, pin, active, role, full_name')
        .eq('role', 'staff')
        .eq('active', true)
        .eq('pin', String(pin))
        .maybeSingle();
      if (data) authed = true;
    }
    // Fallback: PIN compartido por env var (útil en dev)
    if (!authed && String(pin) === String(STAFF_PIN)) authed = true;

    if (!authed) return res.status(401).json({ error: 'credenciales_invalidas' });

    const token = signJwt({ sid: String(user), role: 'staff' }, { expiresIn: '12h' });
    return res.json({ token, staff: { id: String(user), role: 'staff' } });
  } catch (e) {
    console.error('[staff.login]', e);
    return res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/tickets/validate', requireStaff, async (req, res) => {
  try {
    if (!supabase) return res.status(503).json({ error: 'supabase_not_configured' });
    const qr = String(req.body.qr || '');
    const payload = verifyJwt(qr);

    if (!payload) {
      await supabase.from('validation_log').insert({ qr_scanned: qr, result: 'invalid' });
      return res.json({ result: 'invalid' });
    }

    const { data: ticket } = await supabase
      .from('tickets')
      .select('*, guest:guests(*), event:events(*)')
      .eq('qr_token', qr)
      .maybeSingle();

    if (!ticket) {
      await supabase.from('validation_log').insert({ qr_scanned: qr, result: 'invalid' });
      return res.json({ result: 'invalid' });
    }

    if (ticket.status === 'redeemed') {
      await supabase.from('validation_log').insert({
        ticket_id: ticket.id, qr_scanned: qr, result: 'already_used'
      });
      return res.json({ result: 'already_used', guest: ticket.guest, event: ticket.event });
    }

    await supabase.from('tickets')
      .update({ status: 'redeemed', redeemed_at: new Date().toISOString() })
      .eq('id', ticket.id);
    await supabase.from('validation_log').insert({
      ticket_id: ticket.id, qr_scanned: qr, result: 'valid'
    });
    return res.json({ result: 'valid', guest: ticket.guest, event: ticket.event });
  } catch (e) {
    console.error('[tickets.validate]', e);
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// Health check
app.get('/api/health', (_, res) => res.json({ ok: true, version: '0.4.0' }));

// Config pública expuesta al frontend (evita hardcodear PayPal client id en js/config.js)
app.get('/api/public-config', (_req, res) => {
  res.json({
    paypal_client_id: PAYPAL_CLIENT_ID || '',
    paypal_currency: 'USD',
    whatsapp: WHATSAPP_NUMBER
  });
});

// --------- boot ----------
app.listen(PORT, () => {
  console.log(`Party House server v0.4.0 escuchando en :${PORT}`);
});
