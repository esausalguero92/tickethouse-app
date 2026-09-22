'use strict';
/**
 * PdfService — Ticket PDF TicketHouse
 * Tipografía: Bebas Neue (títulos) + Space Grotesk (cuerpo)
 *
 * Estrategia two-pass:
 *   1) Render en página 2000px (descartado) → medir Y final del contenido
 *   2) Render final con H = contenido + footer
 *
 * Esto garantiza que H nunca sea incorrecto, sin importar cuántas líneas
 * tenga el nombre del evento ni qué campos opcionales vengan.
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

function registerFonts(doc) {
  try {
    doc.registerFont('Bebas',        path.join(FONTS_DIR, 'BebasNeue-Regular.ttf'));
    doc.registerFont('Grotesk',      path.join(FONTS_DIR, 'SpaceGrotesk-Regular.ttf'));
    doc.registerFont('Grotesk-Bold', path.join(FONTS_DIR, 'SpaceGrotesk-Bold.ttf'));
  } catch (_) {}
}

/**
 * Dibuja todo el contenido del ticket en `doc` (sin fondo negro, sin footer).
 * Retorna la coordenada Y del último pixel de contenido.
 *
 * Al llamarse con el mismo `doc` configurado igual en ambos passes,
 * el valor retornado es idéntico en ambos.
 */
function drawContent(doc, { displayCode, eventName, eventDateStr, eventVenue, buyerName, tierName, cleanLocationUrl, qrPng }) {
  // ── Banda accent superior ─────────────────────────────────────────
  doc.rect(0, 0, W, 5).fill(C.accent);

  // ── Logo ──────────────────────────────────────────────────────────
  doc.font('Bebas')
     .fontSize(13)
     .fillColor(C.accent)
     .text('TICKET HOUSE', 0, 14, { align: 'center', width: W, characterSpacing: 4 });

  // ── Línea decorativa ──────────────────────────────────────────────
  doc.rect(40, 30, W - 80, 0.5).fill(C.line);

  // ── Nombre del evento ─────────────────────────────────────────────
  doc.font('Bebas')
     .fontSize(36)
     .fillColor(C.text)
     .text(eventName.toUpperCase(), 24, 38, {
       align: 'center', width: W - 48, characterSpacing: 2, lineGap: 2,
     });

  // doc.y se actualiza automáticamente al fondo del texto renderizado
  let y = doc.y + 8;

  // ── Separador ─────────────────────────────────────────────────────
  doc.rect(40, y, W - 80, 0.5).fill(C.accent).opacity(0.4);
  doc.opacity(1);
  y += 10;

  // ── Fecha ─────────────────────────────────────────────────────────
  if (eventDateStr) {
    doc.font('Grotesk')
       .fontSize(9)
       .fillColor(C.muted)
       .text(eventDateStr, 0, y, { align: 'center', width: W, characterSpacing: 0.5 });
    y = doc.y; // captura Y real (maneja fechas largas)
  }

  // ── Venue ─────────────────────────────────────────────────────────
  if (eventVenue) {
    doc.font('Grotesk-Bold')
       .fontSize(11)
       .fillColor(C.accent)
       .text(eventVenue.toUpperCase(), 0, y, { align: 'center', width: W, characterSpacing: 1 });
    y = doc.y;
  }

  // ── Localidad (tier) ─────────────────────────────────────────────
  if (tierName) {
    const pillW = Math.min(W - 80, doc.font('Grotesk-Bold').fontSize(10).widthOfString(tierName.toUpperCase(), { characterSpacing: 1.5 }) + 40);
    const pillX = (W - pillW) / 2;
    const pillH = 22;
    const pillY = y + 4;
    doc.rect(pillX, pillY, pillW, pillH).fill(C.accent);
    doc.font('Grotesk-Bold')
       .fontSize(10)
       .fillColor(C.bg)
       .text(tierName.toUpperCase(), pillX, pillY + 5, {
         align: 'center', width: pillW, characterSpacing: 1.5,
       });
    y = pillY + pillH + 8;
  }

  // ── Separador ─────────────────────────────────────────────────────
  doc.rect(40, y, W - 80, 0.5).fill(C.line);
  y += 26;

  // ── QR ────────────────────────────────────────────────────────────
  const qrSize = 210;
  const qrX    = (W - qrSize) / 2;
  const qrY    = y;

  doc.rect(qrX - 14, qrY - 14, qrSize + 28, qrSize + 28).fill(C.surface);

  const cs = 14;
  [
    [qrX - 14,               qrY - 14],
    [qrX + qrSize + 14 - cs, qrY - 14],
    [qrX - 14,               qrY + qrSize + 14 - cs],
    [qrX + qrSize + 14 - cs, qrY + qrSize + 14 - cs],
  ].forEach(([cx, cy]) => {
    doc.rect(cx, cy, cs, 2).fill(C.accent);
    doc.rect(cx, cy, 2, cs).fill(C.accent);
  });

  doc.image(qrPng, qrX, qrY, { width: qrSize, height: qrSize });
  y = qrY + qrSize + 24;

  // ── Instrucción ───────────────────────────────────────────────────
  doc.font('Grotesk')
     .fontSize(8)
     .fillColor(C.muted)
     .text('PRESENTA ESTE QR EN LA ENTRADA', 0, y, {
       align: 'center', width: W, characterSpacing: 2,
     });
  y += 18;

  // ── Código de acceso ──────────────────────────────────────────────
  const codeBoxH = 46;
  const codeTop  = y - 6;
  const codeBot  = codeTop + codeBoxH; // = y + 40

  doc.rect(44, codeTop, W - 88, codeBoxH).fill(C.surface);
  doc.rect(44, codeTop,          W - 88, 1).fill(C.accent); // borde top
  doc.rect(44, codeBot - 1,      W - 88, 1).fill(C.accent); // borde bottom

  doc.font('Grotesk')
     .fontSize(7)
     .fillColor(C.muted)
     .text('CÓDIGO DE ACCESO', 0, y, { align: 'center', width: W, characterSpacing: 2.5 });

  doc.font('Bebas')
     .fontSize(28)
     .fillColor(C.accent)
     .text(displayCode, 0, y + 11, { align: 'center', width: W, characterSpacing: 2 });

  // ── Ubicación: texto clickeable debajo del código ─────────────────
  if (cleanLocationUrl) {
    const locY = codeBot + 12; // 12px de gap bajo el code box
    const locLabel = 'VER UBICACION DEL EVENTO EN MAPA';

    doc.font('Grotesk-Bold').fontSize(9);
    const textW  = doc.widthOfString(locLabel, { characterSpacing: 0.5 });
    const textX  = (W - textW) / 2; // centrado manual

    // Texto sin underline nativo (PDFKit lo extiende al ancho del bloque)
    doc.fillColor(C.accent)
       .text(locLabel, textX, locY, {
         characterSpacing: 0.5,
         link:             cleanLocationUrl,
         underline:        false,
       });

    // Subrayado manual — exactamente el ancho del texto
    const lineY = locY + doc.currentLineHeight(false) - 1;
    doc.moveTo(textX, lineY)
       .lineTo(textX + textW, lineY)
       .lineWidth(0.6)
       .strokeColor(C.accent)
       .stroke();

    return doc.y; // Y real al fondo del texto de ubicación
  }

  return codeBot; // Y al fondo del code box
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
 * @param {string}  [opts.tierName]
 */
async function generateTicketPdf({ publicCode, correlativeCode, qrToken, eventName, eventDate, eventVenue, buyerName, locationUrl, tierName }) {
  const qrPng = await generateQrBuffer(qrToken, 480);

  const cleanLocationUrl = locationUrl ? decodeHtmlEntities(locationUrl) : null;
  const displayCode      = publicCode || correlativeCode || '—';

  const eventDateStr = eventDate
    ? new Date(eventDate).toLocaleString('es', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZone: 'America/Guatemala',
      })
    : '';

  const contentArgs = { displayCode, eventName, eventDateStr, eventVenue, buyerName, tierName: tierName || null, cleanLocationUrl, qrPng };

  // ── PASS 1: medir Y final del contenido ───────────────────────────
  const TALL = 2000;
  const mDoc = new PDFDocument({ size: [W, TALL], margin: 0 });
  registerFonts(mDoc);
  mDoc.on('data', () => {}); // descartar output

  let contentEndY = 600; // fallback seguro
  await new Promise(resolve => {
    mDoc.on('end',   resolve);
    mDoc.on('error', () => resolve());
    try {
      contentEndY = drawContent(mDoc, contentArgs);
    } catch (e) {
      console.error('[PdfService] measure error:', e.message);
    }
    mDoc.end();
  });

  // ── Calcular H exacto ─────────────────────────────────────────────
  // 24 = gap entre contenido y footer  |  26 = footer surface  |  4 = banda accent inferior
  const H = Math.ceil(contentEndY) + 24 + 26 + 4;

  // ── PASS 2: render final ──────────────────────────────────────────
  const doc = new PDFDocument({
    size:   [W, H],
    margin: 0,
    info: {
      Title:   eventName + ' — ' + displayCode,
      Author:  'TicketHouse',
      Subject: 'Entrada para ' + eventName,
    },
  });
  registerFonts(doc);

  const chunks = [];
  doc.on('data', c => chunks.push(c));

  return new Promise((resolve, reject) => {
    doc.on('end',   () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Fondo negro (necesita H, se dibuja antes del contenido)
    doc.rect(0, 0, W, H).fill(C.bg);

    // Contenido
    drawContent(doc, contentArgs);

    // ── Footer (posición absoluta basada en H) ────────────────────
    doc.rect(0, H - 30, W, 26).fill(C.surface);
    doc.font('Grotesk')
       .fontSize(7)
       .fillColor(C.muted)
       .text('tickethouse.site  ·  Entrada válida para una persona  ·  No reembolsable',
             0, H - 20, { align: 'center', width: W, characterSpacing: 0.5 });
    doc.rect(0, H - 4, W, 4).fill(C.accent);

    doc.end();
  });
}

module.exports = { generateTicketPdf };
