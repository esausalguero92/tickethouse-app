/**
 * Party House — Configuración del frontend
 *
 * Completá estos valores ANTES de servir la landing. No contienen secretos
 * peligrosos: SUPABASE_ANON_KEY está pensada para ser pública (Supabase
 * protege la BD con RLS y con las RPCs SECURITY DEFINER definidas en
 * supabase/schema.sql). El service_role key NUNCA va acá.
 */
window.PH_CONFIG = {
  SUPABASE_URL: "https://pvdrbkvafmlqoylbwsxh.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_G3nfncmtqs8U2JrG546efw_Ing7OszN",

  // Instancia de N8N donde viven los webhooks ph/paypal-capture y ph/transfer-submit
  N8N_BASE_URL: "https://horizon-n8n.8qkrxr.easypanel.host",
  N8N_WEBHOOK_PAYPAL:   "/webhook/ph/paypal-capture",
  N8N_WEBHOOK_TRANSFER: "/webhook/ph/transfer-submit",

  // client_id de PayPal (sandbox o live). 'sb' = sandbox público para pruebas.
  // Reemplazar por el Client ID real cuando conectes PayPal.
  PAYPAL_CLIENT_ID: "sb",
  PAYPAL_CURRENCY: "USD"
};
