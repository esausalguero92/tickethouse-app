-- ====================================================================
-- PATCH: Códigos de Descuento
-- Aplica sobre schema-v2.sql
-- ====================================================================

-- -------------------------------------------------------------------
-- 1. Tabla: discount_codes
-- -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.discount_codes (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_id        UUID REFERENCES public.events(id) ON DELETE CASCADE,  -- NULL = global (todos los eventos)
    code            TEXT NOT NULL UNIQUE,
    description     TEXT,
    discount_type   TEXT NOT NULL DEFAULT 'percent'
                    CHECK (discount_type IN ('percent', 'fixed')),
    discount_value  NUMERIC(10,2) NOT NULL CHECK (discount_value > 0),
    max_uses        INT,          -- NULL = ilimitado
    uses_count      INT NOT NULL DEFAULT 0,
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    expires_at      TIMESTAMPTZ,  -- NULL = sin vencimiento
    created_by      UUID REFERENCES public.app_users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_discount_codes_code     ON public.discount_codes(UPPER(code));
CREATE INDEX IF NOT EXISTS idx_discount_codes_event    ON public.discount_codes(event_id);
CREATE INDEX IF NOT EXISTS idx_discount_codes_active   ON public.discount_codes(active);

-- Trigger updated_at
CREATE OR REPLACE FUNCTION public.set_discount_codes_updated()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_discount_codes_updated ON public.discount_codes;
CREATE TRIGGER trg_discount_codes_updated
  BEFORE UPDATE ON public.discount_codes
  FOR EACH ROW EXECUTE FUNCTION public.set_discount_codes_updated();

-- -------------------------------------------------------------------
-- 2. Columnas en orders
-- -------------------------------------------------------------------
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS discount_code_id    UUID REFERENCES public.discount_codes(id) ON DELETE SET NULL;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS discount_amount_usd NUMERIC(10,2);

-- -------------------------------------------------------------------
-- 3. RLS
-- -------------------------------------------------------------------
ALTER TABLE public.discount_codes ENABLE ROW LEVEL SECURITY;

-- Solo service_role puede leer/escribir discount_codes directamente
DROP POLICY IF EXISTS "discount_codes_service_only" ON public.discount_codes;
CREATE POLICY "discount_codes_service_only" ON public.discount_codes
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- -------------------------------------------------------------------
-- 4. Función: rpc_validate_discount_code
-- Valida un código de descuento para un evento y devuelve el descuento.
-- Llamada desde el frontend (anon) — NO decrementa uses_count todavía.
-- -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_validate_discount_code(
    p_code          TEXT,
    p_event_id      UUID,
    p_amount_usd    NUMERIC   -- monto base (precio * cantidad)
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_dc   public.discount_codes%ROWTYPE;
    v_disc NUMERIC(10,2);
    v_final NUMERIC(10,2);
BEGIN
    -- Buscar código (insensible a mayúsculas)
    SELECT * INTO v_dc
    FROM public.discount_codes
    WHERE UPPER(code) = UPPER(p_code)
      AND active = TRUE
      AND (event_id IS NULL OR event_id = p_event_id)
    LIMIT 1;

    IF v_dc.id IS NULL THEN
        RETURN jsonb_build_object('valid', FALSE, 'error', 'code_not_found');
    END IF;

    -- Verificar vencimiento
    IF v_dc.expires_at IS NOT NULL AND v_dc.expires_at < NOW() THEN
        RETURN jsonb_build_object('valid', FALSE, 'error', 'code_expired');
    END IF;

    -- Verificar límite de usos
    IF v_dc.max_uses IS NOT NULL AND v_dc.uses_count >= v_dc.max_uses THEN
        RETURN jsonb_build_object('valid', FALSE, 'error', 'code_exhausted');
    END IF;

    -- Calcular descuento
    IF v_dc.discount_type = 'percent' THEN
        v_disc  := ROUND(p_amount_usd * (v_dc.discount_value / 100.0), 2);
    ELSE
        v_disc  := LEAST(v_dc.discount_value, p_amount_usd); -- no puede ser mayor al total
    END IF;

    v_final := GREATEST(p_amount_usd - v_disc, 0);

    RETURN jsonb_build_object(
        'valid',          TRUE,
        'discount_id',    v_dc.id,
        'code',           v_dc.code,
        'description',    v_dc.description,
        'discount_type',  v_dc.discount_type,
        'discount_value', v_dc.discount_value,
        'discount_amount_usd', v_disc,
        'final_amount_usd',    v_final
    );
END; $$;

GRANT EXECUTE ON FUNCTION public.rpc_validate_discount_code(TEXT, UUID, NUMERIC) TO anon, authenticated;

-- -------------------------------------------------------------------
-- 5. Función: rpc_create_purchase_intent (reemplaza la de schema-v2.sql)
-- Acepta p_discount_code opcional.
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
    p_user_agent      TEXT DEFAULT NULL,
    p_discount_code   TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_ec              public.event_codes%ROWTYPE;
    v_event           public.events%ROWTYPE;
    v_buyer_id        UUID;
    v_order_id        UUID;
    v_available       INT;
    v_base_amount     NUMERIC(10,2);
    v_final_amount    NUMERIC(10,2);
    v_discount_id     UUID;
    v_discount_amount NUMERIC(10,2) := 0;
    v_dc_result       JSONB;
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

    -- Cargar evento
    SELECT * INTO v_event FROM public.events WHERE id = v_ec.event_id FOR UPDATE;
    IF v_event.status NOT IN ('published') THEN
        RETURN jsonb_build_object('error', 'event_not_available');
    END IF;

    -- Validar max_per_order
    IF p_quantity > v_event.max_per_order THEN
        RETURN jsonb_build_object('error', 'quantity_exceeds_limit', 'max', v_event.max_per_order);
    END IF;

    -- Validar aforo
    IF v_event.capacity IS NOT NULL THEN
        v_available := GREATEST(v_event.capacity - v_event.tickets_sold, 0);
        IF v_available < p_quantity THEN
            RETURN jsonb_build_object('error', 'insufficient_capacity', 'available', v_available);
        END IF;
    END IF;

    -- Calcular monto base
    v_base_amount  := v_event.price_usd * p_quantity;
    v_final_amount := v_base_amount;

    -- Aplicar código de descuento (opcional)
    IF p_discount_code IS NOT NULL AND trim(p_discount_code) <> '' THEN
        SELECT public.rpc_validate_discount_code(p_discount_code, v_event.id, v_base_amount)
        INTO v_dc_result;

        IF (v_dc_result->>'valid')::BOOLEAN THEN
            v_discount_id     := (v_dc_result->>'discount_id')::UUID;
            v_discount_amount := (v_dc_result->>'discount_amount_usd')::NUMERIC;
            v_final_amount    := (v_dc_result->>'final_amount_usd')::NUMERIC;

            -- Incrementar uses_count (dentro de la misma transacción)
            UPDATE public.discount_codes
            SET uses_count = uses_count + 1
            WHERE id = v_discount_id;
        END IF;
        -- Si el código es inválido, simplemente lo ignoramos (no bloqueamos la compra)
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
        discount_code_id, discount_amount_usd,
        payment_method, payment_status
    )
    VALUES (
        v_event.id, v_ec.id, v_buyer_id,
        trim(p_full_name), lower(trim(p_email)),
        p_quantity, v_final_amount,
        v_discount_id, NULLIF(v_discount_amount, 0),
        'paypal', 'pending'
    )
    RETURNING id INTO v_order_id;

    RETURN jsonb_build_object(
        'ok',                  TRUE,
        'order_id',            v_order_id,
        'buyer_id',            v_buyer_id,
        'amount_usd',          v_final_amount,
        'base_amount_usd',     v_base_amount,
        'discount_amount_usd', v_discount_amount,
        'quantity',            p_quantity,
        'event_id',            v_event.id
    );
END; $$;

GRANT EXECUTE ON FUNCTION public.rpc_create_purchase_intent(UUID, TEXT, TEXT, TEXT, INT, BOOLEAN, BOOLEAN, TEXT, TEXT, TEXT) TO anon, authenticated;
