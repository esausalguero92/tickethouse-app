'use strict';
/**
 * PdfService — Ticket PDF premium minimalista
 *
 * Diseño: limpio, oscuro elegante (navy/blanco).
 * Muestra public_code (TH-BLG-482719) como identificador principal.
 * NO hace referencia a "Party House"; marca como "TicketHouse".
 */

const PDFDocument = require('pdfkit');
const { generateQrBuffer } = require('./QrService');

const W = 400;
const H = 600;

const C = {
  bg:      '#0D0D1A',
  surface: '#141428',
  accent:  '#4F7CFF',
  text:    '#FFFFFF',
  muted:   '#8A8AAA',
  dim:     '#2A2A40',
  line:    '#232340',
  gold:    '#C8A951',
};

/**
 * @param {Object} opts
 * @param {string}  opts.publicCode       TH-BLG-482719  (identificador principal)
 * @param {string}  [opts.correlativeCode] TH-PH001       (legacy, se omite si no existe)
 * @param {string}  opts.qrToken
 * @param {string}  opts.eventName
 * @param {string}  [opts.eventDate]
 * @param {string}  [opts.eventVenue]
 * @param {string}  [opts.buyerName]
 */
async function generateTicketPdf({ publicCode, correlativeCode, qrToken, eventName, eventDate, eventVenue, buyerName }) {
  const qrPng = await generateQrBuffer(qrToken, 480);

  const displayCode = publicCode || correlativeCode || '—';

  const eventDateStr = eventDate
    ? new Date(eventDate).toLocaleString('es', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZone: 'America/Guatemala',
      })
    : '';

  const doc = new PDFDocument({
    size: [W, H],
    margin: 0,
    info: {
      Title:    eventName + ' — ' + displayCode,
      Author:   'TicketHouse',
      Subject:  'Entrada para ' + eventName,
    },
  });

  const chunks = [];
  doc.on('data', c => chunks.push(c));

  return new Promise((resolve, reject) => {
    doc.on('end',   () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── Fondo ──────────────────────────────────────────────────────
    doc.rect(0, 0, W, H).fill(C.bg);

    // ── Banda superior de acento ───────────────────────────────────
    doc.rect(0, 0, W, 4).fill(C.accent);

    // ── Nombre del evento ──────────────────────────────────────────
    doc.font('Helvetica-Bold')
       .fontSize(22)
       .fillColor(C.text)
       .text(eventName.toUpperCase(), 0, 18, { align: 'center', width: W, characterSpacing: 1.5 });

    // ── Subtítulo muted ────────────────────────────────────────────
    doc.font('Helvetica')
       .fontSize(8.5)
       .fillColor(C.muted)
       .text('ENTRADA PERSONAL E INTRANSFERIBLE', 0, 44, { align: 'center', width: W, characterSpacing: 1.5 });

    // ── Línea separadora ───────────────────────────────────────────
    doc.rect(32, 58, W - 64, 1).fill(C.line);

    // ── Fecha y Venue ──────────────────────────────────────────────
    let infoY = 68;

    if (eventDateStr) {
      doc.font('Helvetica')
         .fontSize(8)
         .fillColor(C.muted)
         .text(eventDateStr, 0, infoY, { align: 'center', width: W });
      infoY += 14;
    }

    if (eventVenue) {
      doc.font('Helvetica-Bold')
         .fontSize(10)
         .fillColor(C.accent)
         .text(eventVenue.toUpperCase(), 0, infoY, { align: 'center', width: W, characterSpacing: 0.8 });
      infoY += 16;
    }

    if (buyerName) {
      doc.font('Helvetica-Bold')
         .fontSize(11)
         .fillColor(C.text)
         .text(buyerName.toUpperCase(), 0, infoY, { align: 'center', width: W, characterSpacing: 0.5 });
      infoY += 16;
    }

    // ── Línea separadora ───────────────────────────────────────────
    doc.rect(32, infoY, W - 64, 1).fill(C.line);

    // ── QR ─────────────────────────────────────────────────────────
    const qrSize = 220;
    const qrX    = (W - qrSize) / 2;
    const qrY    = infoY + 14;

    // Contenedor QR
    doc.rect(qrX - 12, qrY - 12, qrSize + 24, qrSize + 24).fill(C.surface);
    doc.rect(qrX - 12, qrY - 12, qrSize + 24, qrSize + 24)
       .stroke(C.dim).lineWidth(1);

    // Esquinas de acento
    const cs = 12;
    [
      [qrX - 12, qrY - 12],
      [qrX + qrSize + 12 - cs, qrY - 12],
      [qrX - 12, qrY + qrSize + 12 - cs],
      [qrX + qrSize + 12 - cs, qrY + qrSize + 12 - cs],
    ].forEach(([cx, cy]) => {
      doc.rect(cx, cy, cs, 2).fill(C.accent).opacity(0.9);
      doc.rect(cx, cy, 2, cs).fill(C.accent).opacity(0.9);
      doc.opacity(1);
    });

    doc.image(qrPng, qrX, qrY, { width: qrSize, height: qrSize });

    // ── Instrucción ────────────────────────────────────────────────
    const afterQr = qrY + qrSize + 18;
    doc.font('Helvetica')
       .fontSize(8)
       .fillColor(C.muted)
       .text('PRESENTA ESTE QR EN LA ENTRADA', 0, afterQr, { align: 'center', width: W, characterSpacing: 1.5 });

    // ── Código principal ───────────────────────────────────────────
    const codeY = afterQr + 20;

    doc.rect(56, codeY - 4, W - 112, 38).fill(C.surface);
    doc.rect(56, codeY - 4, W - 112, 38).stroke(C.dim).lineWidth(0.8);

    doc.font('Helvetica')
       .fontSize(7.5)
       .fillColor(C.muted)
       .text('CÓDIGO DE ACCESO', 0, codeY, { align: 'center', width: W, characterSpacing: 2 });

    doc.font('Helvetica-Bold')
       .fontSize(20)
       .fillColor(C.accent)
       .text(displayCode, 0, codeY + 11, { align: 'center', width: W, characterSpacing: 1.5 });

    // ── Footer ─────────────────────────────────────────────────────
    const footY = H - 20;
    doc.rect(0, H - 24, W, 24).fill(C.surface);
    doc.font('Helvetica')
       .fontSize(6.5)
       .fillColor(C.dim)
       .text('tickethouse.gt  ·  Ticket válido para una persona  ·  No reembolsable', 0, footY - 4, { align: 'center', width: W, characterSpacing: 0.3 });

    // ── Banda inferior de acento ───────────────────────────────────
    doc.rect(0, H - 3, W, 3).fill(C.accent);

    doc.end();
  });
}

module.exports = { generateTicketPdf };
