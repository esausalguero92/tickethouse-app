'use strict';
/**
 * Party House — Descarga / visualización del PDF de crew
 *
 * GET /api/pdf/crew   → Devuelve el PDF "PARTY HOUSE CREW.pdf" para visualizarlo inline
 */

const { Router } = require('express');
const path       = require('path');
const fs         = require('fs');
const { asyncHandler } = require('../middleware/errorHandler');

const router = Router();

const PDF_PATH = path.join(__dirname, '..', '..', 'pdf', 'PARTY HOUSE CREW.pdf');

// ── GET /api/pdf/crew ─────────────────────────────────────────────
router.get('/crew', asyncHandler(async (req, res) => {
  if (!fs.existsSync(PDF_PATH)) {
    return res.status(404).json({ error: 'pdf_not_found' });
  }

  const stat = fs.statSync(PDF_PATH);

  res.set('Content-Type', 'application/pdf');
  res.set('Content-Length', stat.size);
  res.set('Content-Disposition', 'inline; filename="PARTY HOUSE CREW.pdf"');
  res.set('Cache-Control', 'public, max-age=86400');

  fs.createReadStream(PDF_PATH).pipe(res);
}));

module.exports = router;
