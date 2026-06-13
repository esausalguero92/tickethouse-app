-- =====================================================================
-- TicketHouseV2 — Schema v2.0 (Compra Libre + Múltiples Entradas)
-- =====================================================================
-- Ejecutar en: Supabase → SQL Editor
-- ESTRATEGIA: Aditivo. No elimina tablas v1. Agrega columnas y tablas nuevas.
-- Requiere haber ejecutado schema.sql (v1) previamente, O ejecutar solo este
-- archivo en una instancia nueva (contiene todo lo necesario).
-- =====================================================================

-- -------------------------------------------------------------------
-- 0. Extensiones
-- -------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- -------------------------------------------------------------------
-- 1. Tabla base: events (mantener, agregar columnas v2)
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.events (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name          TEXT NOT NULL,
    description   TEXT,
    venue         TEXT,
    event_date    TIMESTAMPTZ NOT NULL,
    price_usd     NUMERIC(10,2) NOT NULL DEFAULT 0,
    capacity      INT,
    cover_image   TEXT,
    status        TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','published','sold_out','closed','cancelled')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Columnas nuevas para v2
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS event_code     TEXT UNIQUE;
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS max_per_order  INT NOT NULL DEFAULT 5;
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS tickets_sold   INT NOT NULL DEFAULT 0;

-- Actualizar check de status para incluir sold_out
DO $$
BEGIN
  ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_status_check;
  ALTER TABLE public.events ADD CONSTRAINT events_status_check
    CHECK (status IN ('draft','published','sold_out','closed','cancelled'));
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- -------------------------------------------------------------------
-- 2. Tabla nueva: buyers (comprador anónimo — reemplaza guests en v2)
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.buyers (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    full_name       TEXT NOT NULL,
    email           TEXT NOT NULL,
    phone           TEXT,
    age_verified    BOOLEAN NOT NULL DEFAULT FALSE,
    terms_accepted  BOOLEAN NOT NULL DEFAULT FALSE,
    ip_address      INET,
    user_agent      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_buyers_email ON public.buyers(email);

-- -------------------------------------------------------------------
-- 3. Tabla nueva: event_codes (código general del evento — PH787)
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.event_codes (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_id    UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    code        TEXT NOT NULL UNIQUE,
    active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_codes_code ON public.event_codes(code);
CREATE INDEX IF NOT EXISTS idx_event_codes_event ON public.event_codes(event_id);

-- -------------------------------------------------------------------
-- 4. Tabla: app_users (sin cambios estructurales)
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.app_users (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    telegram_id    BIGINT UNIQUE,
    full_name      TEXT NOT NULL,
    email          TEXT UNIQUE,
    role           TEXT NOT NULL CHECK (role IN ('admin','master_owner','staff')),
    pin            TEXT,
    password_hash  TEXT,
    active         BOOLEAN NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.app_users ADD COLUMN IF NOT EXISTS pin           TEXT;
ALTER TABLE public.app_users ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- -------------------------------------------------------------------
-- 5. Tabla: guests (v1 — mantener para compatibilidad)
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.guests (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    first_name   TEXT NOT NULL,
    last_name    TEXT NOT NULL,
    email        TEXT UNIQUE,
    phone        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.guests ALTER COLUMN email DROP NOT NULL;

-- -------------------------------------------------------------------
-- 6. Tabla: access_codes (v1 — mantener para compatibilidad)
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.access_codes (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code            TEXT NOT NULL UNIQUE,
    event_id        UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    guest_id        UUID NOT NULL REFERENCES public.guests(id) ON DELETE CASCADE,
    generated_by    UUID REFERENCES public.app_users(id),
    status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','used','expired','revoked')),
    first_used_at   TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -------------------------------------------------------------------
-- 7. Sequence para correlativos de tickets (ATÓMICA, NUNCA REPITE)
-- -------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS public.ticket_correlative_seq
    START WITH 1
    INCREMENT BY 1
    NO MAXVALUE
    NO CYCLE;

-- -------------------------------------------------------------------
-- 8. Tabla: orders (v2 — agregar columnas, mantener v1 compatibles)
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.orders (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    -- v1 columns (nullable para compatibilidad)
    code_id                 UUID REFERENCES public.access_codes(id) ON DELETE SET NULL,
    guest_id                UUID REFERENCES public.guests(id) ON DELETE SET NULL,
    -- v2 columns
    buyer_id                UUID REFERENCES public.buyers(id) ON DELETE SET NULL,
    event_code_id           UUID REFERENCES public.event_codes(id) ON DELETE SET NULL,
    buyer_name              TEXT,   -- desnormalizado para resiliencia
    buyer_email             TEXT,   -- desnormalizado para resiliencia
    quantity                INT NOT NULL DEFAULT 1,
    -- shared columns
    event_id                UUID NOT NULL REFERENCES public.events(id),
    amount_usd              NUMERIC(10,2) NOT NULL,
    payment_method          TEXT NOT NULL CHECK (payment_method IN ('paypal','transfer','complimentary')),
    payment_status          TEXT NOT NULL DEFAULT 'pending'
                            CHECK (payment_status IN ('pending','awaiting_review','paid','rejected','refunded')),
    paypal_order_id         TEXT,
    transfer_reference      TEXT,
    transfer_receipt_url    TEXT,
    guest_email             TEXT,   -- legacy, mantener
    reviewed_by             UUID REFERENCES public.app_users(id),
    reviewed_at             TIMESTAMPTZ,
    paid_at                 TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Agregar columnas v2 si la tabla ya existía (idempotente)
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS buyer_id       UUID REFERENCES public.buyers(id) ON DELETE SET NULL;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS event_code_id  UUID REFERENCES public.event_codes(id) ON DELETE SET NULL;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS buyer_name     TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS buyer_email    TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS quantity       INT NOT NULL DEFAULT 1;

-- Fix constraint payment_method para incluir complimentary
DO $$
BEGIN
  ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_payment_method_check;
  ALTER TABLE public.orders ADD CONSTRAINT orders_payment_method_check
    CHECK (payment_method IN ('paypal','transfer','complimentary'));
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- -------------------------------------------------------------------
-- 9. Tabla: tickets (v2 — eliminar UNIQUE en order_id, agregar correlativo)
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tickets (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id          UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
    event_id          UUID NOT NULL REFERENCES public.events(id),
    -- v1 legacy (nullable)
    guest_id          UUID REFERENCES public.guests(id),
    -- v2 nuevo
    buyer_id          UUID REFERENCES public.buyers(id),
    correlative_code  TEXT UNIQUE,       -- TH-PH001, TH-PH002...
    correlative_num   BIGINT,            -- número puro
    -- QR
    qr_token          TEXT NOT NULL UNIQUE,
    qr_payload        JSONB,
    status            TEXT NOT NULL DEFAULT 'issued'
                      CHECK (status IN ('issued','redeemed','revoked')),
    redeemed_at       TIMESTAMPTZ,
    redeemed_by       UUID REFERENCES public.app_users(id),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Agregar columnas v2 si la tabla ya existía
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS buyer_id          UUID REFERENCES public.buyers(id);
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS correlative_code  TEXT UNIQUE;
ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS correlative_num   BIGINT;

-- CRÍTICO: eliminar UNIQUE en order_id para soportar múltiples tickets por orden
DO $$
BEGIN
  ALTER TABLE public.tickets DROP CONSTRAINT IF EXISTS tickets_order_id_key;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- -------------------------------------------------------------------
-- 10. Tabla: validation_log (sin cambios)
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.validation_log (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ticket_id     UUID REFERENCES public.tickets(id),
    qr_scanned    TEXT NOT NULL,
    result        TEXT NOT NULL CHECK (result IN ('valid','already_used','invalid','expired')),
    scanned_by    UUID REFERENCES public.app_users(id),
    scanned_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    user_agent    TEXT,
    ip_address    INET
);

-- -------------------------------------------------------------------
-- 11. Tabla: amenities (sin cambios)
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.amenities (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_id    UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    description TEXT,
    icon        TEXT,
    image_url   TEXT,
    sort_order  INT DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -------------------------------------------------------------------
-- 12. Tabla: activity_log (sin cambios)
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.activity_log (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    actor_id   UUID REFERENCES public.app_users(id),
    action     TEXT NOT NULL,
    entity     TEXT,
    entity_id  UUID,
    payload    JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -------------------------------------------------------------------
-- 13. Índices
-- -------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_orders_status       ON public.orders(payment_status);
CREATE INDEX IF NOT EXISTS idx_orders_event        ON public.orders(event_id);
CREATE INDEX IF NOT EXISTS idx_orders_buyer        ON public.orders(buyer_id);
CREATE INDEX IF NOT EXISTS idx_orders_buyer_email  ON public.orders(buyer_email);
CREATE INDEX IF NOT EXISTS idx_tickets_status      ON public.tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_event       ON public.tickets(event_id);
CREATE INDEX IF NOT EXISTS idx_tickets_order       ON public.tickets(order_id);
CREATE INDEX IF NOT EXISTS idx_tickets_correlative ON public.tickets(correlative_code);
CREATE INDEX IF NOT EXISTS idx_validation_scanned  ON public.validation_log(scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_created    ON public.activity_log(created_at DESC);

-- Índices v1 (mantener)
CREATE INDEX IF NOT EXISTS idx_codes_event  ON public.access_codes(event_id);
CREATE INDEX IF NOT EXISTS idx_codes_status ON public.access_codes(status);

-- -------------------------------------------------------------------
-- 14. Funciones de apoyo
-- -------------------------------------------------------------------

-- Actualiza updated_at automáticamente
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_events_updated ON public.events;
CREATE TRIGGER trg_events_updated BEFORE UPDATE ON public.events
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_orders_updated ON public.orders;
CREATE TRIGGER trg_orders_updated BEFORE UPDATE ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Función: generar código correlativo atómico
-- NUNCA llamar desde el cliente. Solo desde RPCs SECURITY DEFINER.
CREATE OR REPLACE FUNCTION public.next_ticket_correlative()
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE v_num BIGINT;
BEGIN
    SELECT nextval('public.ticket_correlative_seq') INTO v_num;
    RETURN 'TH-PH' || LPAD(v_num::TEXT, 3, '0');
END; $$;

-- Trigger: actualizar tickets_sold al insertar/revocar tickets
CREATE OR REPLACE FUNCTION public.sync_tickets_sold()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' AND NEW.status != 'revoked' THEN
        UPDATE public.events
        SET tickets_sold = tickets_sold + 1
        WHERE id = NEW.event_id;
    ELSIF TG_OP = 'UPDATE' THEN
        IF OLD.status != 'revoked' AND NEW.status = 'revoked' THEN
            UPDATE public.events
            SET tickets_sold = GREATEST(tickets_sold - 1, 0)
            WHERE id = NEW.event_id;
        END IF;
    END IF;
    RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_tickets_sold ON public.tickets;
CREATE TRIGGER trg_tickets_sold AFTER INSERT OR UPDATE ON public.tickets
FOR EACH ROW EXECUTE FUNCTION public.sync_tickets_sold();

-- -------------------------------------------------------------------
-- 15. Row Level Security
-- -------------------------------------------------------------------
ALTER TABLE public.events         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_users      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guests         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_codes   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.buyers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_codes    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tickets        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.validation_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.amenities      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_log   ENABLE ROW LEVEL SECURITY;

-- Políticas públicas mínimas
DROP POLICY IF EXISTS "public_read_published_events" ON public.events;
CREATE POLICY "public_read_published_events" ON public.events
    FOR SELECT TO anon, authenticated
    USING (status IN ('published','sold_out'));

DROP POLICY IF EXISTS "public_read_amenities" ON public.amenities;
CREATE POLICY "public_read_amenities" ON public.amenities
    FOR SELECT TO anon, authenticated
    USING (
        EXISTS (SELECT 1 FROM public.events e
                 WHERE e.id = amenities.event_id AND e.status IN ('published','sold_out'))
    );

-- Event codes: público solo para verificar que el código existe
DROP POLICY IF EXISTS "public_read_event_codes" ON public.event_codes;
CREATE POLICY "public_read_event_codes" ON public.event_codes
    FOR SELECT TO anon, authenticated
    USING (active = TRUE);

-- Todo lo demás: bloqueado para anon, solo RPCs SECURITY DEFINER y service_role

-- =====================================================================
-- 16. RPCs Públicas v2 (SECURITY DEFINER)
-- =====================================================================

-- 16.1 Obtener evento por código general (PH787)
-- Valida que el código sea de un evento activo/publicado.
-- Devuelve info del evento + disponibilidad.
CREATE OR REPLACE FUNCTION public.rpc_get_event_by_code(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ec     public.event_codes%ROWTYPE;
  v_event  public.events%ROWTYPE;
  v_available INT;
BEGIN
  -- Validar input
  IF p_code IS NULL OR length(trim(p_code)) < 2 THEN
    RETURN jsonb_build_object('error', 'code_required');
  END IF;

  -- Buscar event_code
  SELECT * INTO v_ec
    FROM public.event_codes
   WHERE code = upper(trim(p_code))
     AND active = TRUE
   LIMIT 1;

  IF v_ec.id IS NULL THEN
    RETURN jsonb_build_object('error', 'code_not_found');
  END IF;

  -- Cargar evento
  SELECT * INTO v_event FROM public.events WHERE id = v_ec.event_id;

  IF v_event.status NOT IN ('published','sold_out') THEN
    RETURN jsonb_build_object('error', 'event_not_available');
  END IF;

  -- Calcular disponibilidad
  v_available := CASE
    WHEN v_event.capacity IS NULL THEN 9999
    ELSE GREATEST(v_event.capacity - v_event.tickets_sold, 0)
  END;

  RETURN jsonb_build_object(
    'event_code_id', v_ec.id,
    'event', jsonb_build_object(
      'id',           v_event.id,
      'name',         v_event.name,
      'description',  v_event.description,
      'venue',        v_event.venue,
      'event_date',   v_event.event_date,
      'price',        v_event.price_usd,
      'price_usd',    v_event.price_usd,
      'cover_image',  v_event.cover_image,
      'status',       v_event.status,
      'max_per_order',v_event.max_per_order,
      'capacity',     v_event.capacity,
      'tickets_sold', v_event.tickets_sold,
      'available',    v_available,
      'sold_out',     (v_event.status = 'sold_out' OR v_available = 0)
    )
  );
END; $$;

GRANT EXECUTE ON FUNCTION public.rpc_get_event_by_code(TEXT) TO anon, authenticated;

-- -------------------------------------------------------------------
-- 16.2 Crear intención de compra (buyer + orden pending)
-- Valida: capacity, max_per_order, age_verified, terms_accepted.
-- Retorna un order_intent_id para usar en el pago.
-- -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_create_purchase_intent(
  p_event_code_id   UUID,
  p_full_name       TEXT,
  p_email           TEXT,
  p_phone           TEXT,
  p_quantity        INT,
  p_age_verified    BOOLEAN,
  p_terms_accepted  BOOLEAN,
  p_ip_address      TEXT DEFAULT NULL,
  p_user_agent      TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ec          public.event_codes%ROWTYPE;
  v_event       public.events%ROWTYPE;
  v_buyer_id    UUID;
  v_order_id    UUID;
  v_available   INT;
BEGIN
  -- Validaciones básicas
  IF NOT p_age_verified THEN
    RETURN jsonb_build_object('error', 'age_not_verified');
  END IF;
  IF NOT p_terms_accepted THEN
    RETURN jsonb_build_object('error', 'terms_not_accepted');
  END IF;
  IF p_quantity IS NULL OR p_quantity < 1 THEN
    RETURN jsonb_build_object('error', 'quantity_invalid');
  END IF;
  IF p_full_name IS NULL OR length(trim(p_full_name)) < 2 THEN
    RETURN jsonb_build_object('error', 'name_required');
  END IF;
  IF p_email IS NULL OR p_email NOT LIKE '%@%.%' THEN
    RETURN jsonb_build_object('error', 'email_invalid');
  END IF;

  -- Cargar event_code
  SELECT * INTO v_ec FROM public.event_codes WHERE id = p_event_code_id AND active = TRUE;
  IF v_ec.id IS NULL THEN
    RETURN jsonb_build_object('error', 'event_code_invalid');
  END IF;

  -- Cargar evento (FOR UPDATE para prevenir race condition de aforo)
  SELECT * INTO v_event FROM public.events WHERE id = v_ec.event_id FOR UPDATE;
  IF v_event.status NOT IN ('published') THEN
    RETURN jsonb_build_object('error', 'event_not_available');
  END IF;

  -- Validar max_per_order
  IF p_quantity > v_event.max_per_order THEN
    RETURN jsonb_build_object(
      'error', 'quantity_exceeds_limit',
      'max', v_event.max_per_order
    );
  END IF;

  -- Validar aforo
  IF v_event.capacity IS NOT NULL THEN
    v_available := GREATEST(v_event.capacity - v_event.tickets_sold, 0);
    IF v_available < p_quantity THEN
      RETURN jsonb_build_object(
        'error', 'insufficient_capacity',
        'available', v_available
      );
    END IF;
  END IF;

  -- Crear buyer
  INSERT INTO public.buyers (full_name, email, phone, age_verified, terms_accepted, ip_address, user_agent)
  VALUES (
    trim(p_full_name),
    lower(trim(p_email)),
    p_phone,
    p_age_verified,
    p_terms_accepted,
    p_ip_address::INET,
    p_user_agent
  )
  RETURNING id INTO v_buyer_id;

  -- Crear orden pending
  INSERT INTO public.orders (
    event_id, event_code_id, buyer_id,
    buyer_name, buyer_email,
    quantity, amount_usd,
    payment_method, payment_status
  )
  VALUES (
    v_event.id, v_ec.id, v_buyer_id,
    trim(p_full_name), lower(trim(p_email)),
    p_quantity, (v_event.price_usd * p_quantity),
    'paypal', 'pending'   -- payment_method se actualiza en el capture
  )
  RETURNING id INTO v_order_id;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'order_id', v_order_id,
    'buyer_id', v_buyer_id,
    'amount_usd', (v_event.price_usd * p_quantity),
    'quantity', p_quantity,
    'event_id', v_event.id
  );
END; $$;

GRANT EXECUTE ON FUNCTION public.rpc_create_purchase_intent(UUID, TEXT, TEXT, TEXT, INT, BOOLEAN, BOOLEAN, TEXT, TEXT) TO anon, authenticated;

-- -------------------------------------------------------------------
-- 16.3 Registrar pago PayPal en orden pending (llamado por el server)
-- -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_confirm_paypal_order(
  p_order_id        UUID,
  p_paypal_order_id TEXT,
  p_amount_usd      NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
BEGIN
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN
    RETURN jsonb_build_object('error', 'order_not_found');
  END IF;
  IF v_order.payment_status != 'pending' THEN
    RETURN jsonb_build_object('error', 'order_not_pending', 'status', v_order.payment_status);
  END IF;

  UPDATE public.orders
  SET payment_method = 'paypal',
      payment_status = 'paid',
      paypal_order_id = p_paypal_order_id,
      paid_at = NOW()
  WHERE id = p_order_id;

  RETURN jsonb_build_object('ok', TRUE, 'order_id', v_order.id,
                            'event_id', v_order.event_id, 'buyer_id', v_order.buyer_id,
                            'quantity', v_order.quantity);
END; $$;

GRANT EXECUTE ON FUNCTION public.rpc_confirm_paypal_order(UUID, TEXT, NUMERIC) TO service_role;

-- -------------------------------------------------------------------
-- 16.4 Registrar pago por transferencia (llamado por el server)
-- -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_submit_transfer_order(
  p_order_id        UUID,
  p_reference       TEXT,
  p_receipt_url     TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order public.orders%ROWTYPE;
BEGIN
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN
    RETURN jsonb_build_object('error', 'order_not_found');
  END IF;
  IF v_order.payment_status != 'pending' THEN
    RETURN jsonb_build_object('error', 'order_not_pending');
  END IF;

  UPDATE public.orders
  SET payment_method = 'transfer',
      payment_status = 'awaiting_review',
      transfer_reference = p_reference,
      transfer_receipt_url = p_receipt_url
  WHERE id = p_order_id;

  RETURN jsonb_build_object('ok', TRUE, 'order_id', v_order.id,
                            'event_id', v_order.event_id, 'buyer_id', v_order.buyer_id,
                            'quantity', v_order.quantity);
END; $$;

GRANT EXECUTE ON FUNCTION public.rpc_submit_transfer_order(UUID, TEXT, TEXT) TO service_role;

-- -------------------------------------------------------------------
-- 16.5 Emitir N tickets en bulk (atómico, correlativo seguro)
-- Llamado por el server Node DESPUÉS de confirmar pago.
-- Recibe un array de qr_tokens prefirmados.
-- -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_issue_tickets_bulk(
  p_order_id    UUID,
  p_qr_tokens   TEXT[]   -- array de JWT tokens, uno por ticket
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order     public.orders%ROWTYPE;
  v_token     TEXT;
  v_corr_code TEXT;
  v_corr_num  BIGINT;
  v_ticket_ids UUID[] := '{}';
  v_ticket_id  UUID;
  v_codes      TEXT[] := '{}';
BEGIN
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;
  IF v_order.id IS NULL THEN
    RETURN jsonb_build_object('error', 'order_not_found');
  END IF;
  IF v_order.payment_status NOT IN ('paid') THEN
    RETURN jsonb_build_object('error', 'order_not_paid');
  END IF;
  IF array_length(p_qr_tokens, 1) != v_order.quantity THEN
    RETURN jsonb_build_object('error', 'token_count_mismatch',
                              'expected', v_order.quantity,
                              'got', array_length(p_qr_tokens, 1));
  END IF;

  -- Verificar que no se hayan emitido ya
  IF EXISTS (SELECT 1 FROM public.tickets WHERE order_id = p_order_id AND status != 'revoked') THEN
    -- Idempotente: devolver los tickets existentes
    SELECT jsonb_agg(jsonb_build_object(
      'id', t.id, 'correlative_code', t.correlative_code, 'qr_token', t.qr_token
    )) INTO v_ticket_ids
    FROM public.tickets t WHERE order_id = p_order_id AND status != 'revoked';
    RETURN jsonb_build_object('ok', TRUE, 'skipped', TRUE, 'reason', 'already_issued');
  END IF;

  -- Generar un ticket por cada token
  FOREACH v_token IN ARRAY p_qr_tokens
  LOOP
    SELECT nextval('public.ticket_correlative_seq') INTO v_corr_num;
    v_corr_code := 'TH-PH' || LPAD(v_corr_num::TEXT, 3, '0');

    INSERT INTO public.tickets (
      order_id, event_id, buyer_id,
      correlative_code, correlative_num,
      qr_token, qr_payload, status
    )
    VALUES (
      p_order_id, v_order.event_id, v_order.buyer_id,
      v_corr_code, v_corr_num,
      v_token,
      jsonb_build_object(
        'correlative', v_corr_code,
        'event_id', v_order.event_id,
        'order_id', p_order_id
      ),
      'issued'
    )
    RETURNING id INTO v_ticket_id;

    v_ticket_ids := array_append(v_ticket_ids, v_ticket_id::TEXT::UUID);
    v_codes := array_append(v_codes, v_corr_code);
  END LOOP;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'ticket_ids', v_ticket_ids,
    'correlative_codes', v_codes,
    'quantity', v_order.quantity
  );
END; $$;

GRANT EXECUTE ON FUNCTION public.rpc_issue_tickets_bulk(UUID, TEXT[]) TO service_role;

-- -------------------------------------------------------------------
-- 16.6 Obtener tickets de una orden (para /ticket.html)
-- Requiere el order_id — no expone datos de otras órdenes.
-- -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_get_order_tickets(
  p_order_id  UUID,
  p_token     TEXT   -- JWT download token (verificado en server, pasado como claim)
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order  public.orders%ROWTYPE;
  v_event  public.events%ROWTYPE;
  v_result JSONB;
BEGIN
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id;
  IF v_order.id IS NULL THEN
    RETURN jsonb_build_object('error', 'order_not_found');
  END IF;

  SELECT * INTO v_event FROM public.events WHERE id = v_order.event_id;

  SELECT jsonb_build_object(
    'order', jsonb_build_object(
      'id', v_order.id,
      'quantity', v_order.quantity,
      'amount_usd', v_order.amount_usd,
      'payment_method', v_order.payment_method,
      'payment_status', v_order.payment_status,
      'buyer_name', v_order.buyer_name,
      'buyer_email', v_order.buyer_email
    ),
    'event', jsonb_build_object(
      'name', v_event.name,
      'venue', v_event.venue,
      'event_date', v_event.event_date
    ),
    'tickets', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', t.id,
        'correlative_code', t.correlative_code,
        'qr_token', t.qr_token,
        'status', t.status,
        'created_at', t.created_at
      ) ORDER BY t.correlative_num), '[]'::JSONB)
      FROM public.tickets t
      WHERE t.order_id = p_order_id AND t.status != 'revoked'
    )
  ) INTO v_result;

  RETURN v_result;
END; $$;

GRANT EXECUTE ON FUNCTION public.rpc_get_order_tickets(UUID, TEXT) TO anon, authenticated;

-- -------------------------------------------------------------------
-- 16.7 Validar ticket por correlativo (staff — manual)
-- -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_validate_by_correlative(p_correlative TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ticket public.tickets%ROWTYPE;
  v_event  public.events%ROWTYPE;
  v_buyer  public.buyers%ROWTYPE;
BEGIN
  IF p_correlative IS NULL OR length(trim(p_correlative)) < 3 THEN
    RETURN jsonb_build_object('result', 'invalid', 'message', 'Código inválido');
  END IF;

  SELECT * INTO v_ticket
    FROM public.tickets
   WHERE correlative_code = upper(trim(p_correlative))
   LIMIT 1;

  IF v_ticket.id IS NULL THEN
    RETURN jsonb_build_object('result', 'not_found', 'message', 'No encontrado');
  END IF;

  IF v_ticket.status = 'redeemed' THEN
    RETURN jsonb_build_object(
      'result', 'already_used',
      'correlative', v_ticket.correlative_code,
      'redeemed_at', v_ticket.redeemed_at
    );
  END IF;

  IF v_ticket.status = 'revoked' THEN
    RETURN jsonb_build_object('result', 'revoked', 'message', 'Entrada revocada');
  END IF;

  SELECT * INTO v_event FROM public.events WHERE id = v_ticket.event_id;
  SELECT * INTO v_buyer FROM public.buyers WHERE id = v_ticket.buyer_id;

  -- Marcar como usado
  UPDATE public.tickets
  SET status = 'redeemed', redeemed_at = NOW()
  WHERE id = v_ticket.id;

  INSERT INTO public.validation_log (ticket_id, qr_scanned, result)
  VALUES (v_ticket.id, upper(trim(p_correlative)), 'valid');

  RETURN jsonb_build_object(
    'result', 'valid',
    'correlative', v_ticket.correlative_code,
    'buyer_name', coalesce(v_buyer.full_name, 'Invitado/a'),
    'event_name', v_event.name
  );
END; $$;

GRANT EXECUTE ON FUNCTION public.rpc_validate_by_correlative(TEXT) TO authenticated;

-- -------------------------------------------------------------------
-- 16.8 Amenidades (mantener de v1)
-- -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_get_amenities(p_event_id UUID)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'id', a.id, 'title', a.title, 'description', a.description,
      'icon', a.icon, 'image_url', a.image_url, 'sort_order', a.sort_order
    ) ORDER BY a.sort_order
  ), '[]'::JSONB)
  FROM public.amenities a
  JOIN public.events e ON e.id = a.event_id
  WHERE a.event_id = p_event_id AND e.status IN ('published','sold_out');
$$;

GRANT EXECUTE ON FUNCTION public.rpc_get_amenities(UUID) TO anon, authenticated;

-- -------------------------------------------------------------------
-- 16.9 RPCs de admin — Pendientes de transferencia
-- -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_pending_transfers_v2(p_event_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'order_id', o.id,
    'buyer_name', o.buyer_name,
    'buyer_email', o.buyer_email,
    'quantity', o.quantity,
    'amount_usd', o.amount_usd,
    'reference', o.transfer_reference,
    'receipt_url', o.transfer_receipt_url,
    'created_at', o.created_at,
    'event', jsonb_build_object('id', e.id, 'name', e.name)
  ) ORDER BY o.created_at ASC), '[]'::JSONB)
  FROM public.orders o
  JOIN public.events e ON e.id = o.event_id
  WHERE o.payment_status = 'awaiting_review'
    AND (p_event_id IS NULL OR o.event_id = p_event_id);
$$;

GRANT EXECUTE ON FUNCTION public.rpc_pending_transfers_v2(UUID) TO service_role;

-- -------------------------------------------------------------------
-- 16.10 Resumen del evento (para admin/owner)
-- -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_event_summary_v2(p_event_id UUID)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'total_orders',    (SELECT count(*) FROM public.orders WHERE event_id = p_event_id AND payment_status != 'rejected'),
    'paid_orders',     (SELECT count(*) FROM public.orders WHERE event_id = p_event_id AND payment_status = 'paid'),
    'awaiting_orders', (SELECT count(*) FROM public.orders WHERE event_id = p_event_id AND payment_status = 'awaiting_review'),
    'rejected_orders', (SELECT count(*) FROM public.orders WHERE event_id = p_event_id AND payment_status = 'rejected'),
    'total_tickets',   (SELECT count(*) FROM public.tickets WHERE event_id = p_event_id AND status != 'revoked'),
    'redeemed',        (SELECT count(*) FROM public.tickets WHERE event_id = p_event_id AND status = 'redeemed'),
    'revenue_usd',     (SELECT coalesce(sum(amount_usd),0) FROM public.orders WHERE event_id = p_event_id AND payment_status = 'paid'),
    'capacity',        (SELECT capacity FROM public.events WHERE id = p_event_id),
    'tickets_sold',    (SELECT tickets_sold FROM public.events WHERE id = p_event_id)
  );
$$;

GRANT EXECUTE ON FUNCTION public.rpc_event_summary_v2(UUID) TO service_role;

-- -------------------------------------------------------------------
-- 16.11 RPCs v1 (mantener para compatibilidad con bot N8N si sigue activo)
-- -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_validate_code(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_code_id       UUID;
  v_code_status   TEXT;
  v_event_id      UUID;
  v_event_row     public.events%ROWTYPE;
  v_guest_row     public.guests%ROWTYPE;
  v_order_status  TEXT;
  v_has_ticket    BOOLEAN := FALSE;
BEGIN
  IF p_code IS NULL OR length(trim(p_code)) = 0 THEN
    RETURN jsonb_build_object('error', 'code_required');
  END IF;

  SELECT ac.id, ac.status, ac.event_id
    INTO v_code_id, v_code_status, v_event_id
  FROM public.access_codes ac
  WHERE ac.code = upper(trim(p_code)) LIMIT 1;

  IF v_code_id IS NULL THEN RETURN jsonb_build_object('error', 'code_not_found'); END IF;
  IF v_code_status IN ('revoked','expired') THEN RETURN jsonb_build_object('error', 'code_inactive'); END IF;

  UPDATE public.access_codes SET first_used_at = coalesce(first_used_at, NOW()) WHERE id = v_code_id;

  SELECT * INTO v_event_row FROM public.events WHERE id = v_event_id;
  SELECT g.* INTO v_guest_row FROM public.guests g
    JOIN public.access_codes ac ON ac.guest_id = g.id WHERE ac.id = v_code_id;

  SELECT payment_status INTO v_order_status
    FROM public.orders WHERE code_id = v_code_id AND payment_status IN ('paid','awaiting_review')
   ORDER BY created_at DESC LIMIT 1;

  SELECT EXISTS (
    SELECT 1 FROM public.tickets t JOIN public.orders o ON o.id = t.order_id
    WHERE o.code_id = v_code_id AND t.status <> 'revoked'
  ) INTO v_has_ticket;

  RETURN jsonb_build_object(
    'code', upper(trim(p_code)), 'code_id', v_code_id,
    'event', jsonb_build_object('id', v_event_row.id, 'name', v_event_row.name,
      'description', v_event_row.description, 'venue', v_event_row.venue,
      'event_date', v_event_row.event_date, 'price_usd', v_event_row.price_usd,
      'cover_image', v_event_row.cover_image),
    'guest', jsonb_build_object('first_name', v_guest_row.first_name, 'last_name', v_guest_row.last_name),
    'already_paid', coalesce(v_order_status = 'paid', FALSE),
    'awaiting_review', coalesce(v_order_status = 'awaiting_review', FALSE),
    'has_ticket', v_has_ticket
  );
END; $$;

GRANT EXECUTE ON FUNCTION public.rpc_validate_code(TEXT) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.rpc_get_my_ticket(p_code TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_code_id UUID; v_ticket public.tickets%ROWTYPE;
  v_event public.events%ROWTYPE; v_guest public.guests%ROWTYPE;
BEGIN
  SELECT id INTO v_code_id FROM public.access_codes WHERE code = upper(trim(p_code)) LIMIT 1;
  IF v_code_id IS NULL THEN RETURN jsonb_build_object('error','code_not_found'); END IF;
  SELECT t.* INTO v_ticket FROM public.tickets t JOIN public.orders o ON o.id = t.order_id
   WHERE o.code_id = v_code_id AND t.status <> 'revoked' ORDER BY t.created_at DESC LIMIT 1;
  IF v_ticket.id IS NULL THEN RETURN jsonb_build_object('error','no_ticket'); END IF;
  SELECT * INTO v_event FROM public.events WHERE id = v_ticket.event_id;
  SELECT * INTO v_guest FROM public.guests WHERE id = v_ticket.guest_id;
  RETURN jsonb_build_object(
    'ticket', jsonb_build_object('id', v_ticket.id, 'qr_token', v_ticket.qr_token,
      'correlative_code', v_ticket.correlative_code, 'status', v_ticket.status, 'created_at', v_ticket.created_at),
    'event', jsonb_build_object('name', v_event.name, 'venue', v_event.venue, 'event_date', v_event.event_date),
    'guest', jsonb_build_object('first_name', v_guest.first_name, 'last_name', v_guest.last_name)
  );
END; $$;

GRANT EXECUTE ON FUNCTION public.rpc_get_my_ticket(TEXT) TO anon, authenticated;

-- Resto de RPCs v1 (rpc_create_transfer_order, rpc_create_paypal_order, rpc_issue_ticket,
-- rpc_review_order, rpc_event_summary, rpc_pending_transfers, rpc_create_complimentary_order)
-- Se mantienen tal cual del schema v1 para compatibilidad con el bot N8N existente.
-- Ver schema.sql original.

-- =====================================================================
-- 17. Storage — policies para bucket receipts
-- =====================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'receipts') THEN
    EXECUTE 'DROP POLICY IF EXISTS "receipts_service_all" ON storage.objects';
    EXECUTE $p$CREATE POLICY "receipts_service_all" ON storage.objects
              FOR ALL TO service_role
              USING (bucket_id = 'receipts')
              WITH CHECK (bucket_id = 'receipts')$p$;
  END IF;
END $$;

-- =====================================================================
-- FIN schema-v2.sql
-- =====================================================================
