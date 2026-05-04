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
const PDFDocument = require('pdfkit');
const multer = require('multer');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

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
const BANK_DETAILS = process.env.BANK_DETAILS || 'Banco Ejemplo - Cuenta: 0000-0000-0000 - Titular: Party House SA';

// Notificaciones Telegram
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
// IDs autorizados para crear códigos en el bot admin (N8N usa esta lista)
const ADMIN_TELEGRAM_IDS = (process.env.ADMIN_TELEGRAM_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
// ID que recibe los avisos de depósito/transferencia (puede ser distinto a los admins)
const TRANSFER_NOTIFY_ID = process.env.TRANSFER_NOTIFY_ID || '';

// Email con el QR (SMTP propio — Roundcube/hosting)
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'true').toLowerCase() === 'true';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const MAIL_FROM = process.env.MAIL_FROM || (SMTP_USER ? `Party House <${SMTP_USER}>` : '');

// URL pública (para armar links en emails y Telegram)
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

// Secret compartido con N8N para el endpoint de invitados especiales
const N8N_WEBHOOK_SECRET = process.env.N8N_WEBHOOK_SECRET || '';

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
  console.warn('[warn] TELEGRAM_BOT_TOKEN / ADMIN_TELEGRAM_IDS no configurados — el bot admin no funcionará correctamente.');
}
if (!TRANSFER_NOTIFY_ID) {
  console.warn('[warn] TRANSFER_NOTIFY_ID no configurado — los avisos de transferencia no se enviarán.');
}
if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
  console.warn('[warn] SMTP_HOST / SMTP_USER / SMTP_PASS incompletos — no se enviará email con el QR al confirmar transferencias.');
}
if (!N8N_WEBHOOK_SECRET) {
  console.warn('[warn] N8N_WEBHOOK_SECRET no configurado — /api/n8n/complimentary-ticket estará desprotegido.');
}

const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
      realtime: { transport: ws }
    })
  : null;

// Transporter SMTP — sin pool para máxima compatibilidad con Hostinger.
// Pool reutiliza conexiones que el servidor cierra y falla silenciosamente.
const mailTransport = (SMTP_HOST && SMTP_USER && SMTP_PASS)
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE, // true=puerto 465 (SSL), false=puerto 587 (STARTTLS)
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      // NO pool — conexión fresca por cada email (más confiable con hosting compartido)
      tls: { rejectUnauthorized: false },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000
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

// Construye un body multipart/form-data usando Buffers puros (compatible Node 14+).
function buildTelegramMultipart(fields, fileBuffer, fileFieldName, fileName, mimeType) {
  const boundary = 'TGBoundary' + Date.now() + Math.random().toString(36).slice(2);
  const CRLF = '\r\n';
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}` +
      `${value}${CRLF}`
    ));
  }
  chunks.push(Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="${fileFieldName}"; filename="${fileName}"${CRLF}` +
    `Content-Type: ${mimeType}${CRLF}${CRLF}`
  ));
  chunks.push(fileBuffer);
  chunks.push(Buffer.from(`${CRLF}--${boundary}--${CRLF}`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

// Notifica al admin cuando llega una transferencia. Non-blocking.
// Usa TRANSFER_NOTIFY_ID si está seteado; si no, cae al primer ID de ADMIN_TELEGRAM_IDS.
async function notifyAdminsNewTransfer({ fileBuffer, fileName, mimeType, guestName, code, eventName, amountUsd, reference, orderId }) {
  const chatId = TRANSFER_NOTIFY_ID || ADMIN_TELEGRAM_IDS[0] || '';
  if (!TELEGRAM_BOT_TOKEN || !chatId) {
    console.warn('[telegram.notify] Sin destino: setea TRANSFER_NOTIFY_ID o ADMIN_TELEGRAM_IDS.');
    return;
  }
  const lines = [
    '🔔 Nueva transferencia pendiente',
    '',
    `👤 ${guestName}`,
    `🔑 Código: ${code}`,
    `🎉 ${eventName}`,
    `💵 USD ${Number(amountUsd).toFixed(2)} (~Q50)`,
    reference ? `📋 Folio: ${reference}` : '📋 Sin folio',
    '',
    `🔗 ${PUBLIC_BASE_URL}/admin.html`
  ];
  const caption = lines.join('\n');

  try {
    if (fileBuffer) {
      const isImage = mimeType && mimeType.startsWith('image/');
      const method = isImage ? 'sendPhoto' : 'sendDocument';
      const fieldName = isImage ? 'photo' : 'document';
      const safeFileName = fileName || (isImage ? 'comprobante.jpg' : 'comprobante.pdf');
      const { body, contentType } = buildTelegramMultipart(
        { chat_id: String(chatId), caption },
        fileBuffer, fieldName, safeFileName, mimeType || 'application/octet-stream'
      );
      const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        console.warn(`[telegram.notify] ${method} falló (${j.description}) — enviando solo texto`);
        await telegramCall('sendMessage', { chat_id: chatId, text: caption });
      } else {
        console.log(`[telegram.notify] ${method} enviado a ${chatId} OK`);
      }
    } else {
      await telegramCall('sendMessage', { chat_id: chatId, text: caption });
      console.log(`[telegram.notify] sendMessage enviado a ${chatId} OK`);
    }
  } catch (e) {
    console.error(`[telegram.notify.transfer ${chatId}]`, e.message || e);
  }
}

// ---------- Generador de PDF del boleto (reutilizable) ----------
// Devuelve un Buffer con el PDF completo. Se usa tanto en el endpoint de descarga
// como al adjuntar el boleto en el email de confirmación.
async function generateTicketPdfBuffer({ code, qrToken, eventName, eventDate, eventVenue, guestName }) {
  const qrPng = await QRCode.toBuffer(qrToken, {
    width: 480, margin: 2, color: { dark: '#000000', light: '#FFFFFF' }
  });

  const eventDateStr = eventDate
    ? new Date(eventDate).toLocaleString('es', { dateStyle: 'full', timeStyle: 'short' })
    : '';

  const W = 400, H = 720;
  const doc = new PDFDocument({ size: [W, H], margin: 0, info: {
    Title: `Entrada Party House — ${code}`,
    Author: 'Party House'
  }});

  const chunks = [];
  doc.on('data', c => chunks.push(c));

  return new Promise((resolve, reject) => {
    doc.on('end',   () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Fondo negro
    doc.rect(0, 0, W, H).fill('#000000');

    // "See you inside"
    doc.font('Helvetica-BoldOblique').fontSize(26).fillColor('#ffffff')
       .text('See you inside', 0, 22, { align: 'center', width: W });

    // Separador superior
    doc.rect(30, 62, W - 60, 1).fill('#333333');

    // Fecha
    let infoY = 74;
    if (eventDateStr) {
      doc.font('Helvetica').fontSize(10).fillColor('#9f98b3')
         .text(eventDateStr, 0, infoY, { align: 'center', width: W });
      infoY += 16;
    }

    // Venue
    if (eventVenue) {
      doc.font('Helvetica').fontSize(10).fillColor('#9f98b3')
         .text(eventVenue, 0, infoY, { align: 'center', width: W });
      infoY += 16;
    }

    // Invitado
    if (guestName) {
      doc.font('Helvetica').fontSize(11).fillColor('#c8c0e0')
         .text(`Invitado: ${guestName}`, 0, infoY + 4, { align: 'center', width: W });
      infoY += 22;
    }

    // Separador
    doc.rect(30, infoY + 8, W - 60, 1).fill('#333333');

    // Código de acceso
    doc.font('Helvetica').fontSize(8).fillColor('#9f98b3')
       .text('CÓDIGO DE ACCESO', 0, infoY + 18, { align: 'center', width: W, characterSpacing: 2 });
    doc.font('Helvetica-Bold').fontSize(40).fillColor('#00f0ff')
       .text(code, 0, infoY + 32, { align: 'center', width: W });

    // QR centrado
    const qrSize = 240;
    const qrX = (W - qrSize) / 2;
    const qrY = infoY + 88;
    doc.image(qrPng, qrX, qrY, { width: qrSize, height: qrSize });

    // Instrucción bajo el QR
    doc.font('Helvetica').fontSize(9).fillColor('#9f98b3')
       .text('Presenta este QR en la entrada', 0, qrY + qrSize + 10, { align: 'center', width: W });

    // Ubicación
    const locY = qrY + qrSize + 30;
    doc.rect(30, locY, W - 60, 1).fill('#222222');
    doc.font('Helvetica').fontSize(8).fillColor('#6e6b65')
       .text('UBICACIÓN', 0, locY + 10, { align: 'center', width: W, characterSpacing: 2 });
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#9f98b3')
       .text('Z11, Ciudad de Guatemala', 0, locY + 22, { align: 'center', width: W });

    // Botón clicable "Ver en Google Maps"
    const mapsUrl = 'https://maps.google.com/?q=14.592153,-90.567311';
    const btnW = 180, btnH = 24, btnX = (W - btnW) / 2, btnY = locY + 38;
    doc.roundedRect(btnX, btnY, btnW, btnH, 4).fill('#ffffff');
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#000000')
       .text('VER EN GOOGLE MAPS', btnX, btnY + 8,
             { width: btnW, align: 'center', link: mapsUrl, underline: false });

    // Banda inferior
    doc.rect(0, H - 28, W, 28).fill('#111111');
    doc.font('Helvetica').fontSize(8).fillColor('#4a4060')
       .text('(c) Party House - Entrada personal e intransferible', 0, H - 18, { align: 'center', width: W });

    doc.end();
  });
}

// ---------- Email helper (SMTP / nodemailer) ----------
async function sendTicketEmail({ toEmail, guestName, eventName, eventDate, eventVenue, code, qrToken }) {
  if (!mailTransport) {
    console.warn('[mail] sendTicketEmail omitido — mailTransport es null (revisar SMTP_HOST/SMTP_USER/SMTP_PASS)');
    return { skipped: true };
  }
  if (!toEmail) {
    console.warn('[mail] sendTicketEmail omitido — toEmail vacío');
    return { skipped: true, reason: 'no_email' };
  }
  console.log(`[mail] enviando ticket a ${toEmail} (code=${code})`);
  // QR PNG para mostrar en el cuerpo del email (si el cliente soporta imágenes inline en texto)
  const png = await QRCode.toBuffer(qrToken, { width: 512, margin: 2 });
  // PDF boleto — igual al descargable desde la web, con ubicación incluida
  const pdfBuffer = await generateTicketPdfBuffer({ code, qrToken, eventName, eventDate, eventVenue, guestName });
  const ticketUrl = `${PUBLIC_BASE_URL}/ticket.html?code=${encodeURIComponent(code)}`;

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Oswald:wght@400;600&display=swap" rel="stylesheet"/>
</head>
<body style="margin:0;padding:0;background:#0a0908;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0908;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:520px;background:#050505;border:1px solid #2a2622;">

        <!-- HEADER -->
        <tr>
          <td style="padding:28px 32px 20px;border-bottom:1px solid #2a2622;">
            <p style="margin:0;font-family:'Oswald',Arial,sans-serif;font-size:11px;letter-spacing:5px;text-transform:uppercase;color:#6e6b65;">◆ PARTY HOUSE</p>
            <h1 style="margin:10px 0 0;font-family:'Bebas Neue',Impact,Arial,sans-serif;font-size:48px;letter-spacing:4px;color:#F1EEE8;line-height:1;">TU ENTRADA<br>EST&Aacute; LISTA</h1>
          </td>
        </tr>

        <!-- GREETING -->
        <tr>
          <td style="padding:24px 32px 0;">
            <p style="margin:0;font-family:'Oswald',Arial,sans-serif;font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#6e6b65;">Hola,</p>
            <p style="margin:4px 0 0;font-family:'Bebas Neue',Impact,Arial,sans-serif;font-size:32px;letter-spacing:3px;color:#F1EEE8;">${guestName}</p>
          </td>
        </tr>

        <!-- DIVIDER -->
        <tr><td style="padding:20px 32px 0;"><hr style="border:none;border-top:1px solid #2a2622;margin:0;"/></td></tr>

        <!-- EVENT INFO -->
        <tr>
          <td style="padding:20px 32px;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="width:50%;vertical-align:top;">
                  <p style="margin:0;font-family:'Oswald',Arial,sans-serif;font-size:10px;letter-spacing:4px;text-transform:uppercase;color:#6e6b65;">Evento</p>
                  <p style="margin:4px 0 0;font-family:'Bebas Neue',Impact,Arial,sans-serif;font-size:22px;letter-spacing:2px;color:#F1EEE8;">${eventName}</p>
                </td>
                <td style="width:1px;background:#2a2622;">&nbsp;</td>
                <td style="width:50%;vertical-align:top;padding-left:20px;">
                  <p style="margin:0;font-family:'Oswald',Arial,sans-serif;font-size:10px;letter-spacing:4px;text-transform:uppercase;color:#6e6b65;">C&oacute;digo de acceso</p>
                  <p style="margin:4px 0 0;font-family:'Bebas Neue',Impact,Arial,sans-serif;font-size:22px;letter-spacing:4px;color:#F1EEE8;">${code}</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- DIVIDER -->
        <tr><td style="padding:0 32px;"><hr style="border:none;border-top:1px solid #2a2622;margin:0;"/></td></tr>

        <!-- QR NOTE -->
        <tr>
          <td align="center" style="padding:28px 32px;">
            <p style="margin:0 0 8px;font-family:'Oswald',Arial,sans-serif;font-size:10px;letter-spacing:4px;text-transform:uppercase;color:#6e6b65;">Tu QR va adjunto en este email</p>
            <p style="margin:0;font-family:'Oswald',Arial,sans-serif;font-size:10px;letter-spacing:2px;color:#6e6b65;">Tambi&eacute;n pod&eacute;s verlo y descargarlo desde la web</p>
          </td>
        </tr>

        <!-- DIVIDER -->
        <tr><td style="padding:0 32px;"><hr style="border:none;border-top:1px solid #2a2622;margin:0;"/></td></tr>

        <!-- CTA -->
        <tr>
          <td align="center" style="padding:28px 32px;">
            <a href="${ticketUrl}" style="display:inline-block;background:#F1EEE8;color:#050505;font-family:'Bebas Neue',Impact,Arial,sans-serif;font-size:18px;letter-spacing:4px;text-decoration:none;padding:16px 40px;">VER MI ENTRADA</a>
          </td>
        </tr>

        <!-- DIVIDER -->
        <tr><td style="padding:0 32px;"><hr style="border:none;border-top:1px solid #2a2622;margin:0;"/></td></tr>

        <!-- FOOTER -->
        <tr>
          <td style="padding:20px 32px 28px;">
            <p style="margin:0;font-family:'Oswald',Arial,sans-serif;font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#6e6b65;">&copy; Party House &middot; First Edition &middot; 16.05.2026</p>
            <p style="margin:6px 0 0;font-family:'Oswald',Arial,sans-serif;font-size:10px;color:#3a3835;">Si no reconoc&eacute;s esta compra, ignor&aacute; este email.</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text =
    `PARTY HOUSE — Tu entrada está lista\n\n` +
    `Hola ${guestName},\n\n` +
    `Tu entrada para ${eventName} está confirmada.\n` +
    `Código de acceso: ${code}\n\n` +
    `Ver tu entrada: ${ticketUrl}\n\n` +
    `El QR va adjunto en este email. Presentalo al staff en la entrada.\n\n` +
    `© Party House`;

  const info = await mailTransport.sendMail({
    from: MAIL_FROM,
    to: toEmail,
    subject: `🎟 Tu entrada para ${eventName}`,
    html,
    text,
    attachments: [
      { filename: `boleto-party-house-${code}.pdf`, content: pdfBuffer, contentType: 'application/pdf' },
      { filename: `qr-party-house-${code}.png`,     content: png,       contentType: 'image/png' }
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
          description: `${ctx.event.name} - ${ctx.guest.first_name} ${ctx.guest.last_name}`,
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
    const email = String(req.body.email || '').trim().toLowerCase();
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

    // Guardar email del invitado si fue proporcionado
    if (email) {
      await supabase.from('guests').update({ email }).eq('id', ctx.guest_id);
    }

    // Emitir ticket
    const qrToken = await createTicketForOrder({
      orderId: rpcData.order_id,
      eventId: ctx.event_id,
      guestId: ctx.guest_id,
      code: ctx.code,
      eventDate: ctx.event.event_date
    });

    // Enviar email con el QR al invitado
    const guestEmail = email || ctx.guest.email || null;
    const guestName = `${ctx.guest.first_name || ''} ${ctx.guest.last_name || ''}`.trim();
    if (guestEmail && mailTransport) {
      sendTicketEmail({
        toEmail: guestEmail,
        guestName: guestName || 'Invitado/a',
        eventName: ctx.event.name || 'Party House',
        eventDate: ctx.event.event_date || null,
        eventVenue: ctx.event.venue || '',
        code: ctx.code,
        qrToken
      })
        .then(r => console.log(`[email.paypal] enviado a ${guestEmail} — id: ${r?.id || 'skipped'}`))
        .catch(e => console.error('[email.paypal] falló:', e.message || e));
    } else {
      console.warn(`[email.paypal] sin email o sin SMTP — guestEmail=${guestEmail} mailTransport=${!!mailTransport}`);
    }

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
    const email = String(req.body.email || '').trim().toLowerCase();
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
      p_receipt_url: receiptUrl,
      p_guest_email: email || null   // guardar email directo en la orden
    });
    if (error || (data && data.error)) {
      console.error('[rpc_create_transfer_order]', error, data);
      return res.status(500).json({ error: 'db_transfer_failed' });
    }

    // Guardar email del invitado si fue proporcionado
    if (email) {
      await supabase.from('guests').update({ email }).eq('id', ctx.guest_id);
    }

    // Notificar al admin vía Telegram (non-blocking)
    // Se pasa el buffer directamente para evitar problemas con URLs firmadas de Supabase
    notifyAdminsNewTransfer({
      fileBuffer: file.buffer,
      fileName:   file.originalname || 'comprobante',
      mimeType:   file.mimetype,
      guestName:  `${ctx.guest.first_name} ${ctx.guest.last_name || ''}`.trim(),
      code:        ctx.code,
      eventName:   ctx.event.name,
      amountUsd:   ctx.event.price_usd,
      reference:   reference || '',
      orderId:     data.order_id
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
      .select('id, event_id, guest_id, code_id, guest_email')
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

    // 4) Mandar email con el QR
    // Fuente preferida: guest_email guardado en la orden al momento del submit.
    // Fallback: guests.email (por compatibilidad con órdenes antiguas).
    const guestEmail = order.guest_email || extras?.guest?.email || null;
    const guestName = `${extras?.guest?.first_name || ''} ${extras?.guest?.last_name || ''}`.trim();
    console.log(`[email.confirm] orderId=${orderId} guestEmail=${guestEmail} mailTransport=${!!mailTransport}`);
    let emailStatus = 'skipped';
    if (guestEmail && mailTransport) {
      try {
        const r = await sendTicketEmail({
          toEmail: guestEmail,
          guestName: guestName || 'Invitado/a',
          eventName: extras?.event?.name || 'Party House',
          eventDate: extras?.event?.event_date || null,
          eventVenue: extras?.event?.venue || '',
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

// ─── Test de email (solo admin) ──────────────────────────────────────────────
// POST /api/admin/test-email  body: { to: "correo@ejemplo.com" }
// Envía un email de prueba para verificar que SMTP funciona correctamente.
app.post('/api/admin/test-email', requireAdmin, async (req, res) => {
  if (!mailTransport) {
    return res.status(503).json({ ok: false, error: 'SMTP no configurado (SMTP_HOST/SMTP_USER/SMTP_PASS vacíos)' });
  }
  const to = String(req.body.to || '').trim();
  if (!to) return res.status(400).json({ ok: false, error: 'Campo "to" requerido' });
  try {
    const info = await mailTransport.sendMail({
      from: MAIL_FROM,
      to,
      subject: '✅ Party House — Test de email',
      text: `Este es un correo de prueba enviado desde Party House server.\nSMTP: ${SMTP_HOST}:${SMTP_PORT} secure=${SMTP_SECURE}\nFecha: ${new Date().toISOString()}`,
      html: `<p style="font-family:sans-serif;">✅ <strong>Party House — Test de email</strong><br/>SMTP: ${SMTP_HOST}:${SMTP_PORT} secure=${SMTP_SECURE}<br/>Fecha: ${new Date().toISOString()}</p>`
    });
    console.log(`[mail.test] enviado a ${to} — id: ${info.messageId}`);
    return res.json({ ok: true, messageId: info.messageId });
  } catch (e) {
    console.error('[mail.test] falló:', e.message || e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
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
// D) DESCARGA DEL QR (PDF — boleto completo)
// =====================================================
// Genera un PDF con el QR, datos del evento y "See you inside".
// No requiere auth porque el código ya es el secreto del invitado.
app.get('/api/qr/:code/download', async (req, res) => {
  try {
    if (!supabase) return res.status(503).send('supabase_not_configured');
    const code = String(req.params.code || '').toUpperCase().trim();
    const { data, error } = await supabase.rpc('rpc_get_my_ticket', { p_code: code });
    if (error || !data || data.error) return res.status(404).send('ticket_no_encontrado');
    const token = data.ticket?.qr_token;
    if (!token) return res.status(404).send('sin_qr_token');

    const eventName  = data.event?.name  || 'Party House';
    const eventVenue = data.event?.venue || '';
    const guestName  = `${data.guest?.first_name || ''} ${data.guest?.last_name || ''}`.trim();

    // Generar PDF usando la función compartida (incluye ubicación)
    const pdfBuffer = await generateTicketPdfBuffer({
      code, qrToken: token,
      eventName, eventDate: data.event?.event_date, eventVenue, guestName
    });

    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="party-house-${code}.pdf"`);
    res.end(pdfBuffer);
  } catch (e) {
    console.error('[qr.download]', e);
    if (!res.headersSent) return res.status(500).send(String(e.message || e));
  }
});

// =====================================================
// E) INVITADOS ESPECIALES — emitir ticket gratis (desde N8N)
// =====================================================
// N8N llama a este endpoint después de crear el access_code.
// Autenticación: header x-n8n-secret debe coincidir con N8N_WEBHOOK_SECRET.

app.post('/api/n8n/complimentary-ticket', async (req, res) => {
  try {
    // Verificar secret
    const incoming = req.header('x-n8n-secret') || '';
    if (N8N_WEBHOOK_SECRET && incoming !== N8N_WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    if (!supabase) return res.status(503).json({ error: 'supabase_not_configured' });

    const code = String(req.body.code || '').toUpperCase().trim();
    if (!code) return res.status(400).json({ error: 'code_required' });

    const payload = verifyJwt(code);

    if (!payload) {
      await supabase.from('validation_log').insert({ qr_scanned: code, result: 'invalid' });
      return res.json({ result: 'invalid' });
    }

    const { data: ticket } = await supabase
      .from('tickets')
      .select('*, guest:guests(*), event:events(*)')
      .eq('qr_token', code)
      .maybeSingle();

    if (!ticket) {
      await supabase.from('validation_log').insert({ qr_scanned: code, result: 'invalid' });
      return res.json({ result: 'invalid' });
    }

    if (ticket.status === 'redeemed') {
      return res.json({ result: 'already_used', guest: ticket.guest, event: ticket.event });
    }

    await supabase.from('tickets')
      .update({ status: 'redeemed', redeemed_at: new Date().toISOString() })
      .eq('id', ticket.id);
    await supabase.from('validation_log').insert({
      ticket_id: ticket.id, qr_scanned: code, result: 'valid'
    });
    return res.json({ result: 'valid', guest: ticket.guest, event: ticket.event });
  } catch (e) {
    console.error('[tickets.validate]', e);
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// Health check
app.get('/api/health', (_, res) => res.json({ ok: true, version: '0.4.0' }));

// Config pública expuesta al frontend
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
