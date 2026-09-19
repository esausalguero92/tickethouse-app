'use strict';
/**
 * PdfService — Ticket PDF TicketHouse
 * Tipografía: Bebas Neue (títulos) + Space Grotesk (cuerpo)
 * Fondo negro, diseño unificado para cortesías y entradas de venta.
 */

const PDFDocument = require('pdfkit');
const path        = require('path');
const { generateQrBuffer } = require('./QrService');

const FONTS_DIR = path.join(__dirname, '..', 'fonts');

const C = {
  bg:      '#000000',
  surface: '#111111',
  accent:  '#4F7CFF',
  text:    '#FFFFFF',
  muted:   '#888888',
  dim:     '#222222',
  line:    '#2A2A2A',
};

const W = 420;

// Decodifica entidades HTML que sanitizeInputs inyecta en campos tipo URL
function decodeHtmlEntities(s) {
  if (!s || typeof s !== 'string') return s;
  return s
    .replace(/&amp;/g,  '&')
    .replace(/&#x2F;/g, '/')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/gi,    (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/**
 * @param {Object} opts
 * @param {string}  opts.publicCode
 * @param {string}  [opts.correlativeCode]
 * @param {string}  opts.qrToken
 * @param {string}  opts.eventName
 * @param {string}  [opts.eventDate]
 * @param {string}  [opts.eventVenue]
 * @param {string}  [opts.buyerName]
 * @param {string}  [opts.locationUrl]
 */
async function generateTicketPdf({ publicCode, correlativeCode, qrToken, eventName, eventDate, eventVenue, buyerName, locationUrl }) {
  const qrPng = await generateQrBuffer(qrToken, 480);

  // Decodificar URL en caso de que venga con entidades HTML del middleware sanitizador
  const cleanLocationUrl = locationUrl ? decodeHtmlEntities(locationUrl) : null;

  const displayCode = publicCode || correlativeCode || '—';

  const eventDateStr = eventDate
    ? new Date(eventDate).toLocaleString('es', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZone: 'America/Guatemala',
      })
    : '';

  // ── Paso 1: medir altura del nombre para calcular H exacto ───────
  // Se usa un doc temporal solo para medición (output descartado).
  let nameHeightEst = 42; // fallback conservador (~1 línea Bebas 36)
  try {
    const tmpDoc = new PDFDocument({ size: [W, 1000], margin: 0 });
    tmpDoc.registerFont('Bebas', path.join(FONTS_DIR, 'BebasNeue-Regular.ttf'));
    nameHeightEst = tmpDoc.heightOfString(eventName.toUpperCase(), {
      font: 'Bebas', fontSize: 36, width: W - 48, characterSpacing: 2, lineGap: 2,
    });
    tmpDoc.end(); // descartar output
  } catch (_) {}

  // Calcular punto de referencia y del code box (mismo flujo que el renderizado)
  const yCodeRef = 38 + nameHeightEst + 8  // nombre del evento
                 + 10                        // gap tras separador
                 + (eventDateStr ? 16 : 0)
                 + (eventVenue   ? 18 : 0)
                 + (buyerName    ? 18 : 0)
                 + 26                        // separador inferior
                 + 210 + 24                  // QR (210px) + gap (24px)
                 + 18;                       // texto instrucción

  // Fondo del contenido + gap + footer
  const contentBottom = cleanLocationUrl ? yCodeRef + 84 : yCodeRef + 40;
  const H = cleanLocationUrl
    ? contentBottom + 22 + 26   // 22px gap + 26px footer (altura ajustada con ubicación)
    : 570;                      // altura original para entradas sin ubicación

  const doc = new PDFDocument({
    size: [W, H],
    margin: 0,
    info: {
      Title:   eventName + ' — ' + displayCode,
      Author:  'TicketHouse',
      Subject: 'Entrada para ' + eventName,
    },
  });

  // Registrar fuentes
  try {
    doc.registerFont('Bebas',   path.join(FONTS_DIR, 'BebasNeue-Regular.ttf'));
    doc.registerFont('Grotesk', path.join(FONTS_DIR, 'SpaceGrotesk-Regular.ttf'));
    doc.registerFont('Grotesk-Bold', path.join(FONTS_DIR, 'SpaceGrotesk-Bold.ttf'));
  } catch (_) {
    // Fallback si las fuentes no están disponibles
  }

  const chunks = [];
  doc.on('data', c => chunks.push(c));

  return new Promise((resolve, reject) => {
    doc.on('end',   () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── Fondo negro total ─────────────────────────────────────────
    doc.rect(0, 0, W, H).fill(C.bg);

    // ── Banda superior accent ─────────────────────────────────────
    doc.rect(0, 0, W, 5).fill(C.accent);

    // ── Logo "TICKET HOUSE" arriba ────────────────────────────────
    doc.font('Bebas')
       .fontSize(13)
       .fillColor(C.accent)
       .text('TICKET HOUSE', 0, 14, { align: 'center', width: W, characterSpacing: 4 });

    // ── Línea decorativa ──────────────────────────────────────────
    doc.rect(40, 30, W - 80, 0.5).fill(C.line);

    // ── Nombre del evento (Bebas Neue grande) ─────────────────────
    const eventLines = eventName.toUpperCase();
    doc.font('Bebas')
       .fontSize(36)
       .fillColor(C.text)
       .text(eventLines, 24, 38, {
         align: 'center',
         width: W - 48,
         characterSpacing: 2,
         lineGap: 2,
       });

    // Calcular Y dinámico según cuántas líneas ocupa el nombre
    const nameHeight = doc.heightOfString(eventLines, {
      font: 'Bebas', fontSize: 36, width: W - 48, characterSpacing: 2, lineGap: 2,
    });
    let y = 38 + nameHeight + 8;

    // ── Línea separadora ──────────────────────────────────────────
    doc.rect(40, y, W - 80, 0.5).fill(C.accent).opacity(0.4);
    doc.opacity(1);
    y += 10;

    // ── Fecha ─────────────────────────────────────────────────────
    if (eventDateStr) {
      doc.font('Grotesk')
         .fontSize(9)
         .fillColor(C.muted)
         .text(eventDateStr, 0, y, { align: 'center', width: W, characterSpacing: 0.5 });
      y += 16;
    }

    // ── Venue ─────────────────────────────────────────────────────
    if (eventVenue) {
      doc.font('Grotesk-Bold')
         .fontSize(11)
         .fillColor(C.accent)
         .text(eventVenue.toUpperCase(), 0, y, { align: 'center', width: W, characterSpacing: 1 });
      y += 18;
    }

    // ── Nombre del comprador ──────────────────────────────────────
    if (buyerName) {
      doc.font('Grotesk-Bold')
         .fontSize(11)
         .fillColor(C.text)
         .text(buyerName.toUpperCase(), 0, y, { align: 'center', width: W, characterSpacing: 0.5 });
      y += 18;
    }

    // ── Línea separadora ──────────────────────────────────────────
    doc.rect(40, y, W - 80, 0.5).fill(C.line);
    y += 26;

    // ── QR ────────────────────────────────────────────────────────
    const qrSize = 210;
    const qrX    = (W - qrSize) / 2;
    const qrY    = y;

    // Marco del QR
    doc.rect(qrX - 14, qrY - 14, qrSize + 28, qrSize + 28)
       .fill(C.surface);

    // Esquinas decorativas accent
    const cs = 14;
    [
      [qrX - 14, qrY - 14],
      [qrX + qrSize + 14 - cs, qrY - 14],
      [qrX - 14, qrY + qrSize + 14 - cs],
      [qrX + qrSize + 14 - cs, qrY + qrSize + 14 - cs],
    ].forEach(([cx, cy]) => {
      doc.rect(cx, cy, cs, 2).fill(C.accent);
      doc.rect(cx, cy, 2, cs).fill(C.accent);
    });

    doc.image(qrPng, qrX, qrY, { width: qrSize, height: qrSize });

    y = qrY + qrSize + 24;

    // ── Instrucción ───────────────────────────────────────────────
    doc.font('Grotesk')
       .fontSize(8)
       .fillColor(C.muted)
       .text('PRESENTA ESTE QR EN LA ENTRADA', 0, y, {
         align: 'center', width: W, characterSpacing: 2,
       });
    y += 18;

    // ── Código de acceso ──────────────────────────────────────────
    const codeBoxH = 46;
    doc.rect(44, y - 6, W - 88, codeBoxH).fill(C.surface);

    // Bordes accent
    doc.rect(44, y - 6, W - 88, 1).fill(C.accent);
    doc.rect(44, y - 6 + codeBoxH - 1, W - 88, 1).fill(C.accent);

    doc.font('Grotesk')
       .fontSize(7)
       .fillColor(C.muted)
       .text('CÓDIGO DE ACCESO', 0, y, { align: 'center', width: W, characterSpacing: 2.5 });

    doc.font('Bebas')
       .fontSize(28)
       .fillColor(C.accent)
       .text(displayCode, 0, y + 11, { align: 'center', width: W, characterSpacing: 2 });

    // ── Ubicación (opcional) ──────────────────────────────────────
    if (cleanLocationUrl) {
      const locY    = y + 46; // debajo del code box (acaba en y+40) + 6 gap
      const locBoxH = 38;

      // Fondo oscuro igual al code box
      doc.rect(44, locY, W - 88, locBoxH).fill(C.surface);

      // Bordes accent arriba y abajo
      doc.rect(44, locY,                  W - 88, 1).fill(C.accent);
      doc.rect(44, locY + locBoxH - 1,    W - 88, 1).fill(C.accent);

      // Label pequeño
      doc.font('Grotesk')
         .fontSize(7)
         .fillColor(C.muted)
         .text('UBICACIÓN DEL EVENTO', 0, locY + 6, {
           align: 'center', width: W, characterSpacing: 2,
         });

      // Texto principal clickeable
      doc.font('Grotesk-Bold')
         .fontSize(10)
         .fillColor(C.accent)
         .text('VER UBICACION EN MAPA', 0, locY + 18, {
           align: 'center', width: W, characterSpacing: 1,
         });

      // Hacer el bloque completo clickeable (URL ya decodificada)
      doc.link(44, locY, W - 88, locBoxH, cleanLocationUrl);
    }

    // ── Footer ────────────────────────────────────────────────────
    doc.rect(0, H - 26, W, 26).fill(C.surface);

    doc.font('Grotesk')
       .fontSize(7)
       .fillColor(C.muted)
       .text('tickethouse.site  ·  Entrada válida para una persona  ·  No reembolsable', 0, H - 16, {
         align: 'center', width: W, characterSpacing: 0.5,
       });

    // Banda inferior accent
    doc.rect(0, H - 4, W, 4).fill(C.accent);

    doc.end();
  });
}

module.exports = { generateTicketPdf };
