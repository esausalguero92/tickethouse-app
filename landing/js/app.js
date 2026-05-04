/**
 * Party House — Cliente Supabase compartido + utilidades de formato.
 * Requiere que config.js se haya cargado antes y que @supabase/supabase-js
 * esté disponible como supabase.createClient (vía CDN en los HTML).
 *
 * Mock Mode:
 *   Visitar cualquier página con ?mock=1 activa un modo de demostración que
 *   NO toca Supabase ni N8N. Útil cuando la base está caída o para demos.
 *   - Persiste en sessionStorage (ph_mock=1) para sobrevivir a la navegación.
 *   - Se desactiva con ?mock=0.
 *   - Códigos de prueba en modo mock:
 *       DEMO-0001      → invitado sin pagar (flujo completo)
 *       PAID-0001      → ya pagó (redirige a ticket)
 *       AWAIT-0001     → transferencia en revisión
 *       INACTIVE-0000  → código inactivo
 *       NOTFOUND-0000  → código no encontrado
 */
(function () {
  const cfg = window.PH_CONFIG || {};

  // --------- detectar Mock Mode ---------
  let mockActive = false;
  try {
    const urlParam = new URLSearchParams(location.search).get("mock");
    if (urlParam === "1") sessionStorage.setItem("ph_mock", "1");
    if (urlParam === "0") sessionStorage.removeItem("ph_mock");
    mockActive = sessionStorage.getItem("ph_mock") === "1";
  } catch (_) { mockActive = false; }

  if (!mockActive && (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY)) {
    console.warn("[PH] Config incompleta — edita landing/js/config.js");
  }

  // --------- cliente Supabase real ---------
  let supa = null;
  if (window.supabase && window.supabase.createClient && cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY) {
    try {
      supa = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
        auth: { persistSession: false }
      });
    } catch (e) { console.warn("[PH] createClient falló", e); }
  }

  // --------- mock RPC ---------
  function mockRpc(name, args) {
    const res = (data) => Promise.resolve({ data, error: null });

    if (name === "rpc_validate_code") {
      const code = String(args?.p_code || "").toUpperCase();
      if (!code) return res({ error: "code_required" });
      if (code === "INACTIVE-0000") return res({ error: "code_inactive" });
      if (code === "NOTFOUND-0000") return res({ error: "code_not_found" });
      const base = {
        code,
        event: {
          id: "evt-mock-1",
          name: "Party House",
          venue: "",
          event_date: "2026-05-17T02:00:00Z",
          price_usd: 6.45
        }
      };
      if (code === "PAID-0001") return res({
        ...base,
        guest: { id: "g-mock-1", first_name: "Jonathan", last_name: "Pérez", email: "jon@example.com" },
        already_paid: true,
        awaiting_review: false
      });
      if (code === "AWAIT-0001") return res({
        ...base,
        guest: { id: "g-mock-2", first_name: "Demo", last_name: "Transfer", email: "transfer@example.com" },
        already_paid: false,
        awaiting_review: true
      });
      // Por defecto: invitado sin pagar (flujo completo)
      return res({
        ...base,
        guest: { id: "g-mock-3", first_name: "Demo", last_name: "Guest", email: "demo@example.com" },
        already_paid: false,
        awaiting_review: false
      });
    }

    if (name === "rpc_get_amenities") {
      return res([
        { title: "Barra libre premium", description: "Cócteles de autor y destilados top hasta las 3 AM." },
        { title: "Área VIP", description: "Lounge privado con butacas de cuero y atención personalizada." },
        { title: "DJ Headliner", description: "Line-up internacional con visuales reactivas a la música." },
        { title: "Valet parking", description: "Estacionamiento asistido durante toda la noche." }
      ]);
    }

    if (name === "rpc_get_my_ticket") {
      return res({
        event: { id: "evt-mock-1", name: "Party House", event_date: "2026-05-17T02:00:00Z", venue: "" },
        guest: { first_name: "Jonathan", last_name: "Pérez" },
        ticket: { id: "t-mock-1", qr_token: "MOCK.QR." + Date.now(), status: "issued" }
      });
    }

    return Promise.resolve({ data: null, error: { message: "mock: rpc desconocida " + name } });
  }

  if (mockActive) {
    // Reemplazar (o crear) el cliente supabase con un stub que solo implementa rpc()
    supa = { rpc: mockRpc };

    // Stub de PayPal SDK para que evento.html pueda renderizar un botón "Simular pago"
    window.paypal = {
      Buttons(opts) {
        return {
          render(selector) {
            const container = document.querySelector(selector);
            if (!container) return;
            container.innerHTML = "";
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "btn btn-primary";
            btn.style.width = "100%";
            btn.textContent = "Simular pago con PayPal (Mock)";
            btn.addEventListener("click", async () => {
              btn.disabled = true;
              btn.textContent = "Procesando...";
              try {
                if (opts && typeof opts.onApprove === "function") {
                  await opts.onApprove({ orderID: "MOCK-ORDER-" + Date.now() }, { order: { capture: async () => ({}) } });
                }
              } catch (e) {
                if (opts && typeof opts.onError === "function") opts.onError(e);
              }
            });
            container.appendChild(btn);
          }
        };
      }
    };
    window.__paypalReady = true;

    // Interceptar fetch a los webhooks de N8N
    const origFetch = window.fetch ? window.fetch.bind(window) : null;
    window.fetch = async (url, options) => {
      const u = String(url || "");
      if (u.includes("/api/transfer/submit") || u.includes("/webhook/ph/paypal-capture") || u.includes("/webhook/ph/transfer-submit")) {
        await new Promise(r => setTimeout(r, 500));
        return new Response(JSON.stringify({ ok: true, mock: true, order_id: "MOCK-" + Date.now(), email: "demo@example.com", ticket_url: "./ticket.html" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return origFetch ? origFetch(url, options) : Promise.reject(new Error("fetch no disponible"));
    };

    // Banner visual
    document.addEventListener("DOMContentLoaded", () => {
      if (document.getElementById("ph-mock-banner")) return;
      const banner = document.createElement("div");
      banner.id = "ph-mock-banner";
      banner.style.cssText =
        "position:fixed;top:0;left:0;right:0;z-index:9999;background:#ff3366;color:#fff;" +
        "font-family:Inter,sans-serif;font-size:12px;letter-spacing:1px;text-transform:uppercase;" +
        "text-align:center;padding:6px 12px;font-weight:700;box-shadow:0 2px 8px rgba(0,0,0,0.4);";
      banner.innerHTML =
        "MOCK MODE · Supabase y N8N simulados · Códigos: DEMO-0001 · PAID-0001 · AWAIT-0001 · " +
        "<a href=\"?mock=0\" style=\"color:#fff;text-decoration:underline;\">desactivar</a>";
      document.body.appendChild(banner);
      // Empujar el navbar hacia abajo para que no se solape
      const nav = document.querySelector(".navbar");
      if (nav) nav.style.top = "28px";
    });
  }

  window.ph = {
    supabase: supa,
    cfg,
    mock: mockActive,
    formatMoney: (v) => "USD " + Number(v || 0).toFixed(2),
    formatDate: (iso) => new Date(iso).toLocaleString("es-GT", {
      timeZone: "America/Guatemala",
      day: "numeric", month: "numeric", year: "numeric",
      hour: "2-digit", minute: "2-digit"
    }),
    getSession: () => { try { return JSON.parse(sessionStorage.getItem("ph_session") || "null"); } catch { return null; } },
    setSession: (s) => sessionStorage.setItem("ph_session", JSON.stringify(s)),
    clearSession: () => { const keep = sessionStorage.getItem("ph_mock"); sessionStorage.clear(); if (keep) sessionStorage.setItem("ph_mock", keep); },
    n8nUrl: (path) => (cfg.N8N_BASE_URL || "").replace(/\/$/, "") + path
  };
})();
