-- ============================================================
-- TicketHouseV2 — Migration v3 (COMPLEMENTARIA / INCREMENTAL)
-- NO reemplaza schema-v2.sql ni schema-v2-patch-discounts.sql.
-- Se ejecuta sobre la BD existente con datos en producción.
-- ============================================================

-- 1. Límite de tickets por orden: 5 → 10
ALTER TABLE events
  ALTER COLUMN max_per_order SET DEFAULT 10;

-- Actualizar eventos existentes que aún tienen el default 5 (opcional,
-- solo si quieres que todos los eventos activos hereden el nuevo límite)
-- UPDATE events SET max_per_order = 10 WHERE max_per_order = 5;

-- 2. Agregar 'recurrente' al CHECK de payment_method en orders
ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_payment_method_check;

ALTER TABLE orders
  ADD CONSTRAINT orders_payment_method_check
    CHECK (payment_method IN ('paypal', 'transfer', 'complimentary', 'recurrente'));

-- 3. Columna public_code en tickets (nuevo formato TH-BLG-482719)
ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS public_code TEXT UNIQUE;

CREATE INDEX IF NOT EXISTS idx_tickets_public_code
  ON tickets(public_code);

-- 4. Columnas Recurrente en orders
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS recurrente_checkout_id TEXT;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS recurrente_intent_id TEXT;

-- 5. Tabla de idempotencia para webhooks (svix-id)
CREATE TABLE IF NOT EXISTS webhook_events (
  svix_id      TEXT PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Limpieza automática de registros > 30 días (no crítico)
-- Se puede ejecutar con un cron job o pg_cron si está disponible.
-- DELETE FROM webhook_events WHERE processed_at < now() - INTERVAL '30 days';

-- 6. RPC para validar tickets por public_code (espejo de rpc_validate_by_correlative)
--    Patrón idéntico al existente: UPDATE atómico con verificación de status.
CREATE OR REPLACE FUNCTION rpc_validate_by_public_code(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_ticket RECORD;
  v_updated RECORD;
BEGIN
  -- Buscar ticket por public_code (case-insensitive no necesario; siempre se guarda en mayúsculas)
  SELECT
    t.id,
    t.public_code,
    t.correlative_code,
    t.status,
    t.redeemed_at,
    b.full_name AS buyer_name,
    e.name      AS event_name
  INTO v_ticket
  FROM tickets t
  LEFT JOIN orders  o ON o.id = t.order_id
  LEFT JOIN buyers  b ON b.id = o.buyer_id
  LEFT JOIN events  e ON e.id = t.event_id
  WHERE t.public_code = UPPER(p_code)
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;

  IF v_ticket.status = 'redeemed' THEN
    RETURN jsonb_build_object(
      'result',          'already_used',
      'public_code',     v_ticket.public_code,
      'correlative',     v_ticket.correlative_code,
      'buyer_name',      v_ticket.buyer_name,
      'event_name',      v_ticket.event_name,
      'redeemed_at',     v_ticket.redeemed_at
    );
  END IF;

  IF v_ticket.status = 'revoked' THEN
    RETURN jsonb_build_object(
      'result',      'revoked',
      'public_code', v_ticket.public_code,
      'correlative', v_ticket.correlative_code
    );
  END IF;

  -- Marcar como canjeado de forma atómica (evita doble canje por race condition)
  UPDATE tickets
  SET status = 'redeemed', redeemed_at = now()
  WHERE id = v_ticket.id
    AND status IN ('issued', 'valid')
  RETURNING id INTO v_updated;

  IF v_updated IS NULL THEN
    -- Fue canjeado por otra petición concurrente
    RETURN jsonb_build_object(
      'result',      'already_used',
      'public_code', v_ticket.public_code,
      'correlative', v_ticket.correlative_code,
      'buyer_name',  v_ticket.buyer_name
    );
  END IF;

  RETURN jsonb_build_object(
    'result',      'valid',
    'public_code', v_ticket.public_code,
    'correlative', v_ticket.correlative_code,
    'buyer_name',  v_ticket.buyer_name,
    'event_name',  v_ticket.event_name
  );
END;
$$;

-- 7. Exponer los nuevos campos de events que el admin necesita
--    (prefix para generar códigos de ticket)
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS code_prefix TEXT;

-- Poblar prefix a partir del nombre del evento para eventos existentes
UPDATE events
SET code_prefix = UPPER(REGEXP_REPLACE(
  SUBSTRING(name FROM 1 FOR 4),
  '[^A-Z]', '', 'g'
))
WHERE code_prefix IS NULL;

