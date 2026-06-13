'use strict';
/**
 * Party House — PDF Service
 * Genera PDFs con diseño de invitación premium.
 * NO es un boleto de transporte. NO es una factura.
 * Es una invitación digital de la experiencia PARTY HOUSE.
 *
 * Paleta Social Neon:
 *   Fondo:    #050505
 *   Azul:     #1D4FFF
 *   Púrpura:  #5D2D91
 *   Magenta:  #FF2E9A
 *   Texto:    #FFFFFF / #8B8A99
 */

const path = require('path');
const PDFDocument = require('pdfkit');
const { generateQrBuffer } = require('./QrService');

const FONT_BEBAS   = path.join(__dirname, '..', 'fonts', 'BebasNeue-Regular.ttf');
const FONT_DANCING = path.join(__dirname, '..', 'fonts', 'DancingScript-Bold.ttf');

const W = 400;   // ancho del ticket (pts)
const H = 630;   // alto del ticket (pts)

// Paleta
const C = {
  bg:      '#050505',
  surface: '#0A0A14',
  blue:    '#1D4FFF',
  purple:  '#5D2D91',
  magenta: '#FF2E9A',
  white:   '#FFFFFF',
  muted:   '#8B8A99',
  dim:     '#3A3850',
  border:  '#1A1A2E',
};

/** Helper: intentar fuente custom, caer a Helvetica */
function tryFont(doc, customFont, fallback) {
  try {
    doc.font(customFont);
  } catch {
    doc.font(fallback);
  }
}

/**
 * Genera el buffer PDF de UN ticket individual.
 * @param {Object} opts
 * @param {string} opts.correlativeCode   TH-PH001
 * @param {string} opts.qrToken           JWT firmado
 * @param {string} opts.eventName
 * @param {string} opts.eventDate         ISO string o null
 * @param {string} opts.eventVenue
 * @param {string} opts.buyerName
 */
async function generateTicketPdf({ correlativeCode, qrToken, eventName, eventDate, eventVenue, buyerName }) {
  const qrPng = await generateQrBuffer(qrToken, 520);

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
      Title: `Party House — ${correlativeCode}`,
      Author: 'Party House',
      Subject: `Entrada para ${eventName}`,
    },
  });

  const chunks = [];
  doc.on('data', c => chunks.push(c));

  return new Promise((resolve, reject) => {
    doc.on('end',   () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // ── Fondo completo ───────────────────────────────────────────────
    doc.rect(0, 0, W, H).fill(C.bg);

    // ── Banda superior triple (linea gráfica) ────────────────────────
    // Blue | Purple | Magenta — 3 segmentos proporcionales
    const barH = 6;
    const seg = Math.floor(W / 3);
    doc.rect(0, 0, seg, barH).fill(C.blue);
    doc.rect(seg, 0, seg, barH).fill(C.purple);
    doc.rect(seg * 2, 0, W - seg * 2, barH).fill(C.magenta);

    // Línea de brillo debajo de la banda
    doc.rect(0, barH, W, 1).fill(C.border).opacity(0.8);
    doc.opacity(1);

    // ── PARTY HOUSE ──────────────────────────────────────────────────
    tryFont(doc, FONT_BEBAS, 'Helvetica-Bold');
    doc.fontSize(60).fillColor(C.white)
       .text('PARTY HOUSE', 0, 16, { align: 'center', width: W, characterSpacing: 4 });

    // Subtítulo — línea gráfica Party House
    tryFont(doc, FONT_BEBAS, 'Helvetica');
    doc.fontSize(13).fillColor(C.purple)
       .text('FOR THOSE WHO KNOW', 0, 76, { align: 'center', width: W, characterSpacing: 6 });

    // ── Separador decorativo ─────────────────────────────────────────
    // Línea azul con puntos de color en los extremos
    const sep1Y = 100;
    doc.rect(32, sep1Y, W - 64, 1).fill(C.blue).opacity(0.3);
    doc.circle(32, sep1Y + 0.5, 2).fill(C.blue).opacity(0.6);
    doc.circle(W - 32, sep1Y + 0.5, 2).fill(C.magenta).opacity(0.6);
    doc.opacity(1);

    // ── Info del evento ───────────────────────────────────────────────
    let infoY = 112;

    if (eventDateStr) {
      doc.font('Helvetica').fontSize(8).fillColor(C.muted)
         .text(eventDateStr.toUpperCase(), 0, infoY, { align: 'center', width: W, characterSpacing: 0.5 });
      infoY += 16;
    }
    if (eventVenue) {
      tryFont(doc, FONT_BEBAS, 'Helvetica-Bold');
      doc.fontSize(12).fillColor(C.purple)
         .text(eventVenue.toUpperCase(), 0, infoY, { align: 'center', width: W, characterSpacing: 2 });
      infoY += 18;
    }
    if (buyerName) {
      doc.font('Helvetica-Bold').fontSize(12).fillColor(C.white)
         .text(buyerName.toUpperCase(), 0, infoY + 2, { align: 'center', width: W, characterSpacing: 1 });
      infoY += 20;
    }

    // ── Separador fino ────────────────────────────────────────────────
    const sep2Y = infoY + 6;
    doc.rect(48, sep2Y, W - 96, 1).fill(C.purple).opacity(0.2);
    doc.opacity(1);

    // ── QR (protagonista visual) ──────────────────────────────────────
    const qrSize = 252;
    const qrX    = (W - qrSize) / 2;
    const qrY    = sep2Y + 16;

    // Glow externo (capas de opacidad decreciente)
    doc.rect(qrX - 12, qrY - 12, qrSize + 24, qrSize + 24).fill(C.blue).opacity(0.06);
    doc.opacity(1);
    doc.rect(qrX - 8, qrY - 8, qrSize + 16, qrSize + 16).fill(C.surface);
    // Borde azul
    doc.rect(qrX - 8, qrY - 8, qrSize + 16, qrSize + 16)
       .stroke(C.blue).lineWidth(1.2).opacity(0.55);
    doc.opacity(1);
    // Esquinas de acento magenta
    const cornerSize = 10;
    const cx1 = qrX - 8, cy1 = qrY - 8;
    const cx2 = qrX + qrSize + 8 - cornerSize, cy2 = qrY + qrSize + 8 - cornerSize;
    // top-left
    doc.moveTo(cx1, cy1 + cornerSize).lineTo(cx1, cy1).lineTo(cx1 + cornerSize, cy1)
       .stroke(C.magenta).lineWidth(2).opacity(0.9);
    doc.opacity(1);
    // top-right
    doc.moveTo(cx2, cy1).lineTo(cx1 + qrSize + 16 - cornerSize, cy1)
       .moveTo(cx1 + qrSize + 16, cy1).lineTo(cx1 + qrSize + 16, cy1 + cornerSize)
       .stroke(C.magenta).lineWidth(2).opacity(0.9);
    doc.opacity(1);
    // bottom-left
    doc.moveTo(cx1, cy2).lineTo(cx1, cy1 + qrSize + 16 - cornerSize)
       .moveTo(cx1, cy1 + qrSize + 16).lineTo(cx1 + cornerSize, cy1 + qrSize + 16)
       .stroke(C.magenta).lineWidth(2).opacity(0.9);
    doc.opacity(1);
    // bottom-right
    doc.moveTo(cx2 + cornerSize, cy1 + qrSize + 16).lineTo(cx1 + qrSize + 16, cy1 + qrSize + 16)
       .lineTo(cx1 + qrSize + 16, cy2)
       .stroke(C.magenta).lineWidth(2).opacity(0.9);
    doc.opacity(1);

    doc.image(qrPng, qrX, qrY, { width: qrSize, height: qrSize });

    // Instrucción bajo QR
    const afterQr = qrY + qrSize + 12;
    tryFont(doc, FONT_BEBAS, 'Helvetica');
    doc.fontSize(9).fillColor(C.muted)
       .text('PRESENTA ESTE QR EN LA ENTRADA', 0, afterQr, { align: 'center', width: W, characterSpacing: 2 });

    // ── Código correlativo ────────────────────────────────────────────
    const corrY = afterQr + 18;

    tryFont(doc, FONT_BEBAS, 'Helvetica');
    doc.fontSize(10).fillColor(C.purple)
       .text('ACCESO', 0, corrY, { align: 'center', width: W, characterSpacing: 4 });

    tryFont(doc, FONT_BEBAS, 'Helvetica-Bold');
    doc.fontSize(26).fillColor(C.blue)
       .text(correlativeCode, 0, corrY + 12, { align: 'center', width: W, characterSpacing: 2 });

    // ── Separador ────────────────�