'use strict';
/**
 * Party House — Email Service
 * SMTP propio (hosting/Roundcube/Postfix).
 * Sensación: "Tu acceso está confirmado" — no "Tu compra fue procesada".
 * Soporta múltiples PDFs adjuntos (1 por ticket).
 */

const nodemailer = require('nodemailer');
const env = require('../config/env');

let _transport = null;

function getTransport() {
  if (_transport) return _transport;
  if (!env.hasSMTP) return null;

  _transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    tls: { rejectUnauthorized: false },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });

  _transport.verify()
    .then(() => console.log(`[mail] SMTP listo — ${env.SMTP_HOST}:${env.SMTP_PORT}`))
    .catch(err => console.warn('[mail] SMTP verify falló:', err.message));

  return _transport;
}

/**
 * Envía email de confirmación con todos los tickets adjuntos.
 *
 * @param {Object} opts
 * @param {string}   opts.toEmail
 * @param {string}   opts.buyerName
 * @param {string}   opts.eventName
 * @param {string}   opts.eventDate
 * @param {string}   opts.eventVenue
 * @param {Array}    opts.tickets  — [{ correlativeCode, qrToken, pdfBuffer }]
 * @param {string}   opts.downloadUrl  — URL para ver las entradas en web
 */
async function sendConfirmationEmail({ toEmail, buyerName, eventName, eventDate, eventVenue, tickets, downloadUrl }) {
  const transport = getTransport();
  if (!transport) {
    console.warn('[mail] sendConfirmationEmail omitido — SMTP no configurado.');
    return { skipped: true };
  }
  if (!toEmail) {
    console.warn('[mail] sendConfirmationEmail omitido — toEmail vacío.');
    return { skipped: true, reason: 'no_email' };
  }

  const ticketCount = tickets.length;
  const ticketWord = ticketCount === 1 ? 'entrada' : 'entradas';
  const correlatives = tickets.map(t => t.correlativeCode).join(', ');

  const eventDateStr = eventDate
    ? new Date(eventDate).toLocaleString('es', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZone: 'America/Guatemala',
      })
    : '';

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600&display=swap" rel="stylesheet"/>
  <title>Acceso confirmado — Party House</title>
</head>
<body style="margin:0;padding:0;background:#050505;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#050505;padding:32px 16px;">
  <tr><td align="center">
    <table width="100%" style="max-width:520px;background:#080808;border:1px solid #1D4FFF22;">

      <!-- BANDA SUPERIOR -->
      <tr><td style="height:4px;background:linear-gradient(90deg,#1D4FFF,#5D2D91,#FF2E9A);"></td></tr>

      <!-- HEADER -->
      <tr>
        <td style="padding:32px 36px 24px;border-bottom:1px solid #1D4FFF18;">
          <p style="margin:0 0 8px;font-family:'Space Grotesk',Arial,sans-serif;font-size:10px;
                    letter-spacing:6px;text-transform:uppercase;color:#5D2D91;">✦ PARTY HOUSE</p>
          <h1 style="margin:0;font-family:Impact,'Arial Narrow',sans-serif;font-size:52px;
                     letter-spacing:3px;color:#FFFFFF;line-height:1.0;text-transform:uppercase;">
            ACCESO<br/>CONFIRMADO</h1>
        </td>
      </tr>

      <!-- SALUDO -->
      <tr>
        <td style="padding:28px 36px 0;">
          <p style="margin:0;font-family:'Space Grotesk',Arial,sans-serif;font-size:10px;
                    letter-spacing:4px;text-transform:uppercase;color:#5D2D91;">Para</p>
          <p style="margin:4px 0 0;font-family:Impact,'Arial Narrow',sans-serif;font-size:30px;
                    letter-spacing:2px;color:#FFFFFF;text-transform:uppercase;">${buyerName}</p>
        </td>
      </tr>

      <!-- SEPARADOR -->
      <tr><td style="padding:20px 36px 0;">
        <hr style="border:none;border-top:1px solid #1D4FFF22;margin:0;"/>
      </td></tr>

      <!-- INFO EVENTO -->
      <tr>
        <td style="padding:20px 36px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="width:50%;vertical-align:top;padding-right:12px;">
                <p style="margin:0;font-family:'Space Grotesk',Arial,sans-serif;font-size:9px;
                          letter-spacing:4px;text-transform:uppercase;color:#5D2D91;">Evento</p>
                <p style="margin:4px 0 0;font-family:Impact,'Arial Narrow',sans-serif;font-size:18px;
                          letter-spacing:1px;color:#FFFFFF;">${eventName}</p>
                ${eventDateStr ? `<p style="margin:4px 0 0;font-family:'Space Grotesk',Arial,sans-serif;font-size:11px;color:#8B8A99;">${eventDateStr}</p>` : ''}
                ${eventVenue ? `<p style="margin:4px 0 0;font-family:'Space Grotesk',Arial,sans-serif;font-size:11px;color:#8B8A99;">${eventVenue}</p>` : ''}
              </td>
              <td style="width:1px;background:#1D4FFF22;">&nbsp;</td>
              <td style="width:50%;vertical-align:top;padding-left:20px;">
                <p style="margin:0;font-family:'Space Grotesk',Arial,sans-serif;font-size:9px;
                          letter-spacing:4px;text-transform:uppercase;color:#5D2D91;">
                  ${ticketCount} ${ticketWord.toUpperCase()}</p>
                ${tickets.map(t => `
                <p style="margin:4px 0 0;font-family:'Courier New',monospace;font-size:15px;
                          color:#1D4FFF;letter-spacing:2px;">${t.correlativeCode}</p>`).join('')}
              </td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- SEPARADOR -->
      <tr><td style="padding:0 36px;">
        <hr style="border:none;border-top:1px solid #1D4FFF22;margin:0;"/>
      </td></tr>

      <!-- INSTRUCCIÓN PDF -->
      <tr>
        <td align="center" style="padding:28px 36px 20px;">
          <p style="margin:0 0 6px;font-family:'Space Grotesk',Arial,sans-serif;font-size:11px;
                    letter-spacing:2px;color:#8B8A99;text-align:center;">
            ${ticketCount > 1
              ? `Tus ${ticketCount} entradas van adjuntas en este email (${ticketCount} archivos PDF).`
              : 'Tu entrada va adjunta en este email (archivo PDF).'}
          </p>
          <p style="margin:0;font-family:'Space Grotesk',Arial,sans-serif;font-size:11px;
                    color:#5D2D91;text-align:center;">
            Cada entrada tiene su propio QR. Una por persona.
          </p>
        </td>
      </tr>

      <!-- SEPARADOR -->
      <tr><td style="padding:0 36px;">
        <hr style="border:none;border-top:1px solid #1D4FFF22;margin:0;"/>
      </td></tr>

      <!-- CTA -->
      <tr>
        <td align="center" style="padding:28px 36px;">
          <a href="${downloadUrl}"
             style="display:inline-block;background:transparent;border:1px solid #1D4FFF;
                    color:#FFFFFF;font-family:Impact,'Arial Narrow',sans-serif;
                    font-size:16px;letter-spacing:4px;text-decoration:none;
                    padding:16px 40px;text-transform:uppercase;">
            VER MIS ENTRADAS
          </a>
        </td>
      </tr>

      <!-- SEPARADOR -->
      <tr><td style="padding:0 36px;">
        <hr style="border:none;border-top:1px solid #1D4FFF18;margin:0;"/>
      </td></tr>

      <!-- FOOTER -->
      <tr>
        <td style="padding:20px 36px 28px;">
          <p style="margin:0;font-family:'Space Grotesk',Arial,sans-serif;font-size:9px;
                    letter-spacing:3px;text-transform:uppercase;color:#3A3850;">
            © PARTY HOUSE · ENTRADA PERSONAL E INTRANSFERIBLE</p>
          <p style="margin:6px 0 0;font-family:'Space Grotesk',Arial,sans-serif;font-size:10px;color:#2A2840;">
            Si no realizaste esta compra, ignora este correo.</p>
        </td>
      </tr>

      <!-- BANDA INFERIOR -->
      <tr><td style="height:3px;background:linear-gradient(90deg,#FF2E9A,#5D2D91,#1D4FFF);"></td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;

  const text =
    `PARTY HOUSE — Acceso confirmado\n\n` +
    `Hola ${buyerName},\n\n` +
    `Tu${ticketCount > 1 ? 's' : ''} ${ticketCount} ${ticketWord} para ${eventName} ${ticketCount > 1 ? 'están confirmadas' : 'está confirmada'}.\n` +
    `${ticketCount > 1 ? 'Códigos' : 'Código'}: ${correlatives}\n\n` +
    `Ver entradas: ${downloadUrl}\n\n` +
    `Tus entradas van adjuntas en este email. Presentá el QR de cada una al staff en la entrada.\n\n` +
    `© Party House`;

  // Construir adjuntos: 1 PDF por ticket
  const attachments = tickets.map(t => ({
    filename: `ticket-${t.correlativeCode}.pdf`,
    content: t.pdfBuffer,
    contentType: 'application/pdf',
  }));

  const subject = ticketCount > 1
    ? `✦ Tus ${ticketCount} entradas para ${eventName}`
    : `✦ Tu entrada para ${eventName}`;

  console.log(`[mail] Enviando a ${toEmail} (${ticketCount} ${ticketWord}, codes: ${correlatives})`);

  const info = await transport.sendMail({
    from: env.MAIL_FROM,
    to: toEmail,
    subject,
    html,
    text,
    attachments,
  });

  console.log(`[mail] Enviado — messageId: ${info.messageId}`);
  return { id: info.messageId };
}

/**
 * Envía un email de prueba (test-email desde panel admin).
 */
async function sendTestEmail(toEmail) {
  const transport = getTransport();
  if (!transport) throw new Error('SMTP no configurado');

  const info = await transport.sendMail({
    from: env.MAIL_FROM,
    to: toEmail,
    subject: '✅ Party House — Test de email',
    text: `Email de prueba. SMTP: ${env.SMTP_HOST}:${env.SMTP_PORT} secure=${env.SMTP_SECURE}\nFecha: ${new Date().toISOString()}`,
    html: `<p style="font-family:sans-serif;background:#050505;color:#fff;padding:24px;">
             ✅ <strong>Party House — Test de email</strong><br/>
             SMTP: ${env.SMTP_HOST}:${env.SMTP_PORT} secure=${env.SMTP_SECURE}<br/>
             Fecha: ${new Date().toISOString()}
           </p>`,
  });
  return { messageId: info.messageId };
}

module.exports = { sendConfirmationEmail, sendTestEmail };
