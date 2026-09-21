-- ====================================================================
-- migration-tiers.sql
-- Agrega soporte de localidades (ticket_tiers) y fases de precio
-- (tier_phases) a TicketHouseV2.
--
-- SEGURO: 100% idempotente (IF NOT EXISTS / CREATE OR REPLACE).
-- No modifica restricciones existentes ni elimina columnas.
-- Compatible con migration-v3.sql y migration-v4.sql ya aplicados.
-- ====================================================================


-- ====================================================================
-- 1. TABLAS NUEVAS
-- ====================================================================

-- ticket_tiers: secciones/localidades por evento
CREATE TABLE IF NOT EXISTS public.ticket_tiers (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     UUID        NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  name         TEXT        NOT NULL,            -- "VIP", "General", "Palco"…
  description  TEXT,
  color        TEXT        NOT NULL DEFAULT '#6366f1',  -- color badge UI
  capacity     INTEGER     NOT NULL,
  tickets_sold INTEGER     NOT NULL DEFAULT 0,
  sort_order   INTEGER     NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- tier_phases: ventanas de precio por localidad
CREATE TABLE IF NOT EXISTS public.tier_phases (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tier_id      UUID        NOT NULL REFERENCES public.ticket_tiers(id) ON DELETE CASCADE,
  name         TEXT        NOT NULL,            -- "Preventa", "Precio Normal"…
  price_gtq    NUMERIC(10,2) NOT NULL,
  starts_at    TIMESTAMPTZ,                     -- NULL = sin restricción de inicio
  ends_at      TIMESTAMPTZ,                     -- NULL = sin restricción de fin
  capacity     INTEGER,                         -- NULL = sin límite de capacidad
  tickets_sold INTEGER     NOT NULL DEFAULT 0,
  is_active    BOOLEAN     NOT NULL DEFAULT TRUE,
  sort_order   INTEGER     NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ====================================================================
-- 2. COLUMNAS NUEVAS EN TABLAS EXISTENTES (todas idempotentes)
-- ====================================================================

-- orders: desglose de localidades seleccionadas
-- Formato: [{tier_id, tier_name, phase_id, phase_name, quantity, unit_price_gtq}]
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS tier_items JSONB;

-- tickets: a qué localidad pertenece este ticket
ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS tier_id   UUID REFERENCES public.ticket_tiers(id),
  ADD COLUMN IF NOT EXISTS tier_name TEXT;


-- ====================================================================
-- 3. ÍNDICES
-- ====================================================================

CREATE INDEX IF NOT EXISTS idx_ticket_tiers_event_id
  ON public.ticket_tiers(event_id);

CREATE INDEX IF NOT EXISTS idx_tier_phases_tier_id
  ON public.tier_phases(tier_id);

CREATE INDEX IF NOT EXISTS idx_tickets_tier_id
  ON public.tickets(tier_id);


-- ====================================================================
-- 4. ROW LEVEL SECURITY
-- ====================================================================

ALTER TABLE public.ticket_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tier_phases   ENABLE ROW LEVEL SECURITY;

-- Lectura pública (igual que events)
DROP POLICY IF EXISTS "ticket_tiers_public_read" ON public.ticket_tiers;
CREATE POLICY "ticket_tiers_public_read"
  ON public.ticket_tiers FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "tier_phases_public_read" ON public.tier_phases;
CREATE POLICY "tier_phases_public_read"
  ON public.tier_phases FOR SELECT
  USING (true);

-- Service role tiene acceso total (usado por RPCs SECURITY DEFINER)
DROP POLICY IF EXISTS "ticket_tiers_service_all" ON public.ticket_tiers;
CREATE POLICY "ticket_tiers_service_all"
  ON public.ticket_tiers FOR ALL
  USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS "tier_phases_service_all" ON public.tier_phases;
CREATE POLICY "tier_phases_service_all"
  ON public.tier_phases FOR ALL
  USING (auth.role() = 'service_role');


-- ====================================================================
-- 5. RPC: rpc_get_active_phase
--    Devuelve la fase activa de una localidad, o ninguna fila si no hay.
--    Lógica AND: is_active=TRUE AND fecha vigente AND cupo disponible.
-- ====================================================================

CREATE OR REPLACE FUNCTION public.rpc_get_active_phase(p_tier_id UUID)
RETURNS TABLE (
  id           UUID,
  name         TEXT,
  price_gtq    NUMERIC,
  starts_at    TIMESTAMPTZ,
  ends_at      TIMESTAMPTZ,
  capacity     INTEGER,
  tickets_sold INTEGER
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
    tp.tickets_sold
  FROM public.tier_phases tp
  WHERE tp.tier_id  = p_tier_id
    AND tp.is_active = TRUE
    AND (tp.starts_at IS NULL OR tp.starts_at <= NOW())
    AND (tp.ends_at   IS NULL OR tp.ends_at   >  NOW())
    AND (tp.capacity  IS NULL OR tp.tickets_sold < tp.capacity)
  ORDER BY tp.sort_order ASC, tp.created_at ASC
  LIMIT 1;
END;
$$;


-- ====================================================================
-- 6. RPC: rpc_get_event_tiers
--    Devuelve todas las localidades de un evento con su fase activa.
--    Respuesta: JSONB [{id, name, color, capacity, tickets_sold,
--                       sort_order, active_phase: {...} | null}]
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
          'tickets_sold', ap.tickets_sold
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
-- 7. RPC: rpc_create_purchase_intent_tiers
--    Crea una orden pendiente para una compra multi-localidad.
--    p_tier_items: [{tier_id: UUID, quantity: int}]
--    Precios siempre de tier_phases.price_gtq (nunca de events.price_gtq).
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

  -- Calcular cantidad total para validar max_per_order
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

    -- Obtener fase activa (lógica inline para evitar ambigüedades)
    SELECT tp.id, tp.name, tp.price_gtq, tp.capacity, tp.tickets_sold
      INTO v_phase
      FROM public.tier_phases tp
     WHERE tp.tier_id  = v_tier.id
       AND tp.is_active = TRUE
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

    -- Verificar capacidad de la fase
    IF v_phase.capacity IS NOT NULL
       AND (v_phase.tickets_sold + v_qty) > v_phase.capacity THEN
      RETURN jsonb_build_object(
        'error', 'Agotada la fase actual de ' || v_tier.name
      );
    END IF;

    v_subtotal := v_qty * v_phase.price_gtq;
    v_total    := v_total + v_subtotal;

    v_tier_items_out := v_tier_items_out || jsonb_build_array(
      jsonb_build_object(
        'tier_id',        v_tier.id,
        'tier_name',      v_tier.name,
        'phase_id',       v_phase.id,
        'phase_name',     v_phase.name,
        'quantity',       v_qty,
        'unit_price_gtq', v_phase.price_gtq
      )
    );
  END LOOP;

  IF v_total <= 0 THEN
    RETURN jsonb_build_object('error', 'Total inválido');
  END IF;

  -- Crear orden pendiente
  -- Nota: amount_usd es nombre heredado; almacena el total en GTQ
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
-- 8. RPC: rpc_issue_tickets_bulk_v2
--    Emite tickets para una orden de localidades tras pago exitoso.
--    p_tickets_json: [{qr_token, tier_id, tier_name}]
--    Actualiza: events.tickets_sold, ticket_tiers.tickets_sold,
--               tier_phases.tickets_sold, orders.status = 'completed'.
-- ====================================================================

CREATE OR REPLACE FUNCTION public.rpc_issue_tickets_bulk_v2(
  p_order_id     UUID,
  p_tickets_json JSONB   -- [{qr_token, tier_id, tier_name}]
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order           RECORD;
  v_event           RECORD;
  v_ticket          JSONB;
  v_tier_item       JSONB;
  v_prefix          TEXT;
  v_corr            INTEGER;
  v_corr_code       TEXT;
  v_ticket_id       UUID;
  v_count           INTEGER := 0;
  v_tier_id         UUID;
  v_correlatives    JSONB   := '[]'::JSONB;
  v_ticket_ids      JSONB   := '[]'::JSONB;
BEGIN
  -- Lock de la orden
  SELECT o.id, o.event_id, o.quantity, o.status, o.tier_items
    INTO v_order
    FROM public.orders o
   WHERE o.id = p_order_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Orden no encontrada');
  END IF;

  IF v_order.status = 'completed' THEN
    RETURN jsonb_build_object('error', 'Orden ya procesada');
  END IF;

  -- Lock del evento
  SELECT e.id, e.tickets_sold, e.capacity, e.code_prefix
    INTO v_event
    FROM public.events e
   WHERE e.id = v_order.event_id
   FOR UPDATE;

  v_prefix := COALESCE(v_event.code_prefix, 'TKT');

  -- Verificar que hay cupo global
  IF (v_event.tickets_sold + v_order.quantity) > v_event.capacity THEN
    RETURN jsonb_build_object('error', 'Sin disponibilidad en el evento');
  END IF;

  -- Emitir cada ticket, colectando correlativos e IDs para retornarlos
  FOR v_ticket IN SELECT value FROM jsonb_array_elements(p_tickets_json) AS value
  LOOP
    v_tier_id   := (v_ticket->>'tier_id')::UUID;
    v_corr      := v_event.tickets_sold + v_count + 1;
    v_corr_code := v_prefix || '-' || LPAD(v_corr::TEXT, 5, '0');

    INSERT INTO public.tickets (
      order_id,
      event_id,
      qr_token,
      status,
      public_code,
      correlative_num,
      correlative_code,
      tier_id,
      tier_name
    ) VALUES (
      p_order_id,
      v_order.event_id,
      v_ticket->>'qr_token',
      'valid',
      encode(gen_random_bytes(9), 'base64'),
      v_corr,
      v_corr_code,
      v_tier_id,
      v_ticket->>'tier_name'
    )
    RETURNING id INTO v_ticket_id;

    v_correlatives := v_correlatives || jsonb_build_array(v_corr_code);
    v_ticket_ids   := v_ticket_ids   || jsonb_build_array(v_ticket_id);
    v_count        := v_count + 1;
  END LOOP;

  -- Actualizar contadores de ticket_tiers y tier_phases usando tier_items de la orden
  IF v_order.tier_items IS NOT NULL THEN
    FOR v_tier_item IN SELECT value FROM jsonb_array_elements(v_order.tier_items) AS value
    LOOP
      UPDATE public.ticket_tiers
         SET tickets_sold = tickets_sold + (v_tier_item->>'quantity')::INTEGER
       WHERE id = (v_tier_item->>'tier_id')::UUID;

      UPDATE public.tier_phases
         SET tickets_sold = tickets_sold + (v_tier_item->>'quantity')::INTEGER
       WHERE id = (v_tier_item->>'phase_id')::UUID;
    END LOOP;
  END IF;

  -- Actualizar contador global del evento
  UPDATE public.events
     SET tickets_sold = tickets_sold + v_count
   WHERE id = v_order.event_id;

  -- Marcar orden como completada
  UPDATE public.orders
     SET status = 'completed'
   WHERE id = p_order_id;

  RETURN jsonb_build_object(
    'issued',            v_count,
    'order_id',          p_order_id,
    'correlative_codes', v_correlatives,
    'ticket_ids',        v_ticket_ids
  );
END;
$$;


-- ====================================================================
-- 9. GRANTS
-- ====================================================================

GRANT EXECUTE ON FUNCTION public.rpc_get_active_phase(UUID)
  TO anon, authenticated;

GRANT EXECUTE ON FUNCTION public.rpc_get_event_tiers(UUID)
  TO anon, authenticated;

GRANT EXECUTE ON FUNCTION public.rpc_create_purchase_intent_tiers(UUID, TEXT, TEXT, JSONB, BOOLEAN, BOOLEAN)
  TO anon, authenticated;

GRANT EXECUTE ON FUNCTION public.rpc_issue_tickets_bulk_v2(UUID, JSONB)
  TO anon, authenticated;
