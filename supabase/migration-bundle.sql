-- ====================================================================
-- migration-bundle.sql
-- Agrega soporte de paquetes/promos (bundle_qty) a las fases de precio.
--
-- bundle_qty = N significa: price_gtq cubre N tickets en total.
-- Ejemplo: price_gtq = 200, bundle_qty = 2 → 2 entradas por Q200.
--
-- SEGURO: 100% idempotente.
-- ====================================================================


-- ====================================================================
-- 1. COLUMNA NUEVA EN tier_phases
-- ====================================================================

ALTER TABLE public.tier_phases
  ADD COLUMN IF NOT EXISTS bundle_qty INTEGER NOT NULL DEFAULT 1;

-- Asegurar que siempre sea >= 1
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tier_phases_bundle_qty_check'
       AND conrelid = 'public.tier_phases'::regclass
  ) THEN
    ALTER TABLE public.tier_phases
      ADD CONSTRAINT tier_phases_bundle_qty_check CHECK (bundle_qty >= 1);
  END IF;
END;
$$;


-- ====================================================================
-- 2. RPC: rpc_get_active_phase  (ahora devuelve bundle_qty)
-- Debe dropearse primero porque cambia la firma de retorno.
-- ====================================================================

DROP FUNCTION IF EXISTS public.rpc_get_active_phase(UUID);

CREATE OR REPLACE FUNCTION public.rpc_get_active_phase(p_tier_id UUID)
RETURNS TABLE (
  id           UUID,
  name         TEXT,
  price_gtq    NUMERIC,
  starts_at    TIMESTAMPTZ,
  ends_at      TIMESTAMPTZ,
  capacity     INTEGER,
  tickets_sold INTEGER,
  bundle_qty   INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    tp.id,
    tp.name,
    tp.price_gtq,
    tp.starts_at,
    tp.ends_at,
    tp.capacity,
    tp.tickets_sold,
    tp.bundle_qty
  FROM public.tier_phases tp
  WHERE tp.tier_id   = p_tier_id
    AND tp.is_active  = TRUE
    -- starts_at ya NO bloquea: el admin activa manualmente con is_active
    -- ends_at SI aplica: auto-expira la fase cuando termina
    AND (tp.ends_at IS NULL OR tp.ends_at > NOW())
    AND (tp.capacity  IS NULL OR tp.tickets_sold < tp.capacity)
  ORDER BY tp.sort_order ASC, tp.created_at ASC
  LIMIT 1;
END;
$$;


-- ====================================================================
-- 3. RPC: rpc_get_event_tiers  (incluye bundle_qty en active_phase)
-- ====================================================================

CREATE OR REPLACE FUNCTION public.rpc_get_event_tiers(p_event_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
BEGIN
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id',           tt.id,
      'name',         tt.name,
      'description',  tt.description,
      'color',        tt.color,
      'capacity',     tt.capacity,
      'tickets_sold', tt.tickets_sold,
      'sort_order',   tt.sort_order,
      'active_phase', (
        SELECT jsonb_build_object(
          'id',           ap.id,
          'name',         ap.name,
          'price_gtq',    ap.price_gtq,
          'starts_at',    ap.starts_at,
          'ends_at',      ap.ends_at,
          'capacity',     ap.capacity,
          'tickets_sold', ap.tickets_sold,
          'bundle_qty',   ap.bundle_qty
        )
        FROM public.rpc_get_active_phase(tt.id) ap
        LIMIT 1
      )
    )
    ORDER BY tt.sort_order ASC, tt.created_at ASC
  ), '[]'::JSONB)
  INTO v_result
  FROM public.ticket_tiers tt
  WHERE tt.event_id = p_event_id;

  RETURN v_result;
END;
$$;


-- ====================================================================
-- 4. RPC: rpc_create_purchase_intent_tiers  (maneja bundle math)
--    - Valida que la cantidad sea múltiplo de bundle_qty
--    - Precio = (quantity / bundle_qty) * price_gtq
-- ====================================================================

CREATE OR REPLACE FUNCTION public.rpc_create_purchase_intent_tiers(
  p_event_id       UUID,
  p_full_name      TEXT,
  p_email          TEXT,
  p_tier_items     JSONB,
  p_age_verified   BOOLEAN DEFAULT FALSE,
  p_terms_accepted BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event          RECORD;
  v_order_id       UUID;
  v_total          NUMERIC(10,2) := 0;
  v_total_qty      INTEGER       := 0;
  v_tier_items_out JSONB         := '[]'::JSONB;
  v_item           JSONB;
  v_tier           RECORD;
  v_phase          RECORD;
  v_qty            INTEGER;
  v_subtotal       NUMERIC(10,2);
BEGIN
  -- Validar que el evento existe (lock para consistencia)
  SELECT id, name, capacity, tickets_sold, max_per_order
    INTO v_event
    FROM public.events
   WHERE id = p_event_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Evento no encontrado');
  END IF;

  IF p_tier_items IS NULL OR jsonb_array_length(p_tier_items) = 0 THEN
    RETURN jsonb_build_object('error', 'Debes seleccionar al menos una localidad');
  END IF;

  -- Calcular cantidad total de tickets para validar max_per_order
  SELECT COALESCE(SUM((elem->>'quantity')::INTEGER), 0)
    INTO v_total_qty
    FROM jsonb_array_elements(p_tier_items) AS elem;

  IF v_total_qty <= 0 THEN
    RETURN jsonb_build_object('error', 'Cantidad inválida');
  END IF;

  IF v_event.max_per_order IS NOT NULL AND v_total_qty > v_event.max_per_order THEN
    RETURN jsonb_build_object(
      'error', 'Máximo ' || v_event.max_per_order || ' tickets por orden'
    );
  END IF;

  -- Procesar cada localidad
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_tier_items) AS value
  LOOP
    v_qty := COALESCE((v_item->>'quantity')::INTEGER, 0);
    IF v_qty <= 0 THEN CONTINUE; END IF;

    -- Lock de la localidad
    SELECT tt.id, tt.name, tt.capacity, tt.tickets_sold
      INTO v_tier
      FROM public.ticket_tiers tt
     WHERE tt.id       = (v_item->>'tier_id')::UUID
       AND tt.event_id = p_event_id
     FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('error', 'Localidad no encontrada');
    END IF;

    -- Verificar capacidad de la localidad
    IF (v_tier.tickets_sold + v_qty) > v_tier.capacity THEN
      RETURN jsonb_build_object(
        'error', 'Sin disponibilidad en ' || v_tier.name
      );
    END IF;

    -- Obtener fase activa con bundle_qty
    SELECT tp.id, tp.name, tp.price_gtq, tp.capacity, tp.tickets_sold, tp.bundle_qty
      INTO v_phase
      FROM public.tier_phases tp
     WHERE tp.tier_id   = v_tier.id
       AND tp.is_active  = TRUE
       AND (tp.starts_at IS NULL OR tp.starts_at <= NOW())
       AND (tp.ends_at   IS NULL OR tp.ends_at   >  NOW())
       AND (tp.capacity  IS NULL OR tp.tickets_sold < tp.capacity)
     ORDER BY tp.sort_order ASC, tp.created_at ASC
     LIMIT 1;

    IF NOT FOUND THEN
      RETURN jsonb_build_object(
        'error', 'No hay precio activo para ' || v_tier.name
      );
    END IF;

    -- Validar que la cantidad sea múltiplo del bundle
    IF v_phase.bundle_qty > 1 AND (v_qty % v_phase.bundle_qty) <> 0 THEN
      RETURN jsonb_build_object(
        'error', 'La cantidad para "' || v_tier.name || '" debe ser múltiplo de ' || v_phase.bundle_qty ||
                 ' (paquete de ' || v_phase.bundle_qty || ' tickets)'
      );
    END IF;

    -- Verificar capacidad de la fase
    IF v_phase.capacity IS NOT NULL
       AND (v_phase.tickets_sold + v_qty) > v_phase.capacity THEN
      RETURN jsonb_build_object(
        'error', 'Agotada la fase actual de ' || v_tier.name
      );
    END IF;

    -- Precio: (cantidad_de_tickets / bundle_qty) * price_gtq_por_paquete
    v_subtotal := (v_qty / v_phase.bundle_qty) * v_phase.price_gtq;
    v_total    := v_total + v_subtotal;

    v_tier_items_out := v_tier_items_out || jsonb_build_array(
      jsonb_build_object(
        'tier_id',        v_tier.id,
        'tier_name',      v_tier.name,
        'phase_id',       v_phase.id,
        'phase_name',     v_phase.name,
        'quantity',       v_qty,
        'bundle_qty',     v_phase.bundle_qty,
        'unit_price_gtq', v_phase.price_gtq
      )
    );
  END LOOP;

  IF v_total <= 0 THEN
    RETURN jsonb_build_object('error', 'Total inválido');
  END IF;

  -- Crear orden pendiente
  INSERT INTO public.orders (
    event_id,
    full_name,
    email,
    quantity,
    amount_usd,
    payment_method,
    status,
    tier_items
  ) VALUES (
    p_event_id,
    p_full_name,
    p_email,
    v_total_qty,
    v_total,
    'recurrente',
    'pending',
    v_tier_items_out
  )
  RETURNING id INTO v_order_id;

  RETURN jsonb_build_object(
    'order_id',   v_order_id,
    'total_gtq',  v_total,
    'quantity',   v_total_qty,
    'tier_items', v_tier_items_out
  );
END;
$$;


-- ====================================================================
-- 5. GRANTS (funciones reemplazadas — re-otorgar)
-- ====================================================================

GRANT EXECUTE ON FUNCTION public.rpc_get_active_phase(UUID)
  TO anon, authenticated;

GRANT EXECUTE ON FUNCTION public.rpc_get_event_tiers(UUID)
  TO anon, authenticated;

GRANT EXECUTE ON FUNCTION public.rpc_create_purchase_intent_tiers(UUID, TEXT, TEXT, JSONB, BOOLEAN, BOOLEAN)
  TO anon, authenticated;
