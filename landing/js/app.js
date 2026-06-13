/**
 * Party House — App JS v2.0
 * Helpers compartidos entre todas las páginas.
 */

(function () {
'use strict';

// ── API helper ─────────────────────────────────────────────────────
async function api(method, path, body = null, headers = {}) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(path, opts);
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(json.message || json.error || 'Error desconocido'), { data: json, status: r.status });
  return json;
}

// ── Session helpers ────────────────────────────────────────────────
const Session = {
  set: (key, val) => sessionStorage.setItem(`ph_${key}`, JSON.stringify(val)),
  get: (key) => { try { return JSON.parse(sessionStorage.getItem(`ph_${key}`) || 'null'); } catch { return null; } },
  del: (key) => sessionStorage.removeItem(`ph_${key}`),
  clear: () => Object.keys(sessionStorage).filter(k => k.startsWith('ph_')).forEach(k => sessionStorage.removeItem(k)),
};

// ── DOM helpers ────────────────────────────────────────────────────
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

function show(el) { if (el) el.hidden = false; }
function hide(el) { if (el) el.hidden = true; }
function setText(el, text) { if (el) el.textContent = text; }
function showError(el, msg) {
  if (!el) return;
  el.textContent = msg || '';
  el.hidden = !msg;
}

// ── Format helpers ─────────────────────────────────────────────────
function formatUSD(amount) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

function formatDate(isoStr) {
  if (!isoStr) return '';
  return new Intl.DateTimeFormat('es', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'America/Guatemala',
  }).format(new Date(isoStr));
}

// ── Loading overlay ────────────────────────────────────────────────
let _overlay = null;
function showLoading(text = 'Procesando...') {
  if (_overlay) return;
  _overlay = document.createElement('div');
  _overlay.className = 'ph-loading-overlay';
  _overlay.innerHTML = `
    <div class="ph-spinner ph-spinner--lg"></div>
    <p class="ph-loading-overlay__text">${text}</p>
  `;
  document.body.appendChild(_overlay);
}

function hideLoading() {
  if (_overlay) { _overlay.remove(); _overlay = null; }
}

// ── QR renderer (usando qrcode.js via CDN) ─────────────────────────
function renderQR(container, token, size = 200) {
  container.innerHTML = '';
  if (typeof QRCode === 'undefined') {
    container.textContent = '[QR no disponible — activa JavaScript]';
    return;
  }
  new QRCode(container, {
    text: token,
    width: size,
    height: size,
    colorDark: '#000000',
    colorLight: '#FFFFFF',
    correctLevel: QRCode.CorrectLevel.M,
  });
}

// ── URL param helper ───────────────────────────────────────────────
function getParam(name) {
  return new URLSearchParams(window.location.search).get(name) || '';
}

// ── Navigate ───────────────────────────────────────────────────────
function navigate(url) {
  window.location.href = url;
}

// ── Export (para módulos o uso global) ────────────────────────────
window.PH = { api, Session, $, $$, show, hide, setText, showError,
               formatUSD, formatDate, showLoading, hideLoading,
               renderQR, getParam, navigate };
})();
