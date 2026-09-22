-- =============================================================
-- FIX: Capacidad con sistema de tiers/fases
-- Ejecutar en Supabase SQL Editor
-- =============================================================

-- ------------------------------------------------------------
-- 1. Resetear event.tickets_sold para eventos que ahora usan tiers
--    y sincronizar capacity = SUM(tier capacities) automáticamente.
-- ------------------------------------------------------------

-- 1a. Reset tickets_sold y sincronizar capacity desde los tiers
--     para el evento PRUEBA-LIVE.
UPDATE public.events e
SET
  tickets_sold = 0,
  capacity = COALESCE(
    (SELECT SUM(tt.capacity)
       FROM public.ticket_tiers tt
      WHERE tt.event_id = e.id
        AND tt.capacity IS NOT NULL),
    e.capacity
  )
WHERE lower(e.name) LIKE '%prueba%'
   OR lower(e.name) LIKE '%live%';

-- 1b. Sincronizar capacity desde los tiers en TODOS los eventos
--     que ya tengan localidades con capacidad definida.
UPDATE public.events e
SET capacity = (
  SELECT SUM(tt.capacity)
    FROM public.ticket_tiers tt
   WHERE tt.event_id = e.id
     AND tt.capacity IS NOT NULL
)
WHERE EXISTS (
  SELECT 1 FROM public.ticket_tiers tt
   WHERE tt.event_id = e.id AND tt.capacity IS NOT NULL
)
AND (
  SELECT SUM(tt.capacity) FROM public.ticket_tiers tt
   WHERE tt.event_id = e.id AND tt.capacity IS NOT NULL
) > 0;

-- Confirma resultado:
SELECT e.id, e.name, e.capacity, e.tickets_sold,
       COALESCE(SUM(tt.capacity), 0) AS sum_tier_caps
FROM public.events e
LEFT JOIN public.ticket_tiers tt ON tt.event_id = e.id
GROUP BY e.id, e.name, e.capacity, e.tickets_sold
ORDER BY e.name;


-- ------------------------------------------------------------
-- 2. Fix rpc_create_purchase_intent_tiers:
--    - Verificar capacidad del tier solo cuando capacity != NULL
--    - Verificar capacidad del evento con NULL guard
-- ------------------------------------------------------------
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

  SELECT COALESCE(SUM((elem->>'quantity')::INTEGER), 0)
    INTO v_total_qty
    FROM jsonb_array_elements(p_tier_items) AS elem;

  IF v_total_qty <= 0 THEN
    RETURN jsonb_build_object('error', 'Cantidad inválida');
  END IF;

  IF v_event.max_per_order IS NOT NULL AND v_total_qty > v_event.max_per_order THEN
    RETURN jsonb_build_object('error', 'Máximo ' || v_event.max_per_order || ' tickets por orden');
  END IF;

  -- Verificar cupo global del evento (solo si capacity no es null)
  IF v_event.capacity IS NOT NULL
     AND (v_event.tickets_sold + v_total_qty) > v_event.capacity THEN
    RETURN jsonb_build_object('error', 'Sin disponibilidad en el evento');
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_tier_items) AS value
  LOOP
    v_qty := COALESCE((v_item->>'quantity')::INTEGER, 0);
    IF v_qty <= 0 THEN CONTINUE; END IF;

    SELECT tt.id, tt.name, tt.capacity, tt.tickets_sold
      INTO v_tier
      FROM public.ticket_tiers tt
     WHERE tt.id       = (v_item->>'tier_id')::UUID
       AND tt.event_id = p_event_id
     FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('error', 'Localidad no encontrada');
    END IF;

    -- Verificar capacidad del tier (solo si tiene límite definido)
    IF v_tier.capacity IS NOT NULL
       AND (v_tier.tickets_sold + v_qty) > v_tier.capacity THEN
      RETURN jsonb_build_object('error', 'Sin disponibilidad en ' || v_tier.name);
    END IF;

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
      RETURN jsonb_build_object('error', 'No hay precio activo para ' || v_tier.name);
    END IF;

    IF v_phase.capacity IS NOT NULL
       AND (v_phase.tickets_sold + v_qty) > v_phase.capacity THEN
      RETURN jsonb_build_object('error', 'Agotada la fase actual de ' || v_tier.name);
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

  INSERT INTO public.orders (
    event_id, full_name, email, quantity,
    amount_usd, payment_method, status, tier_items
  ) VALUES (
    p_event_id, p_full_name, p_email, v_total_qty,
    v_total, 'recurrente', 'pending', v_tier_items_out
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


-- ------------------------------------------------------------
-- 3. Fix rpc_issue_tickets_bulk_v2:
--    - El chequeo de event.capacity respeta NULL = ilimitado
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_issue_tickets_bulk_v2(
  p_order_id     UUID,
  p_tickets_json JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order        RECORD;
  v_event        RECORD;
  v_ticket       JSONB;
  v_tier_item    JSONB;
  v_prefix       TEXT;
  v_corr         INTEGER;
  v_corr_code    TEXT;
  v_ticket_id    UUID;
  v_count        INTEGER := 0;
  v_tier_id      UUID;
  v_correlatives JSONB   := '[]'::JSONB;
  v_ticket_ids   JSONB   := '[]'::JSONB;
BEGIN
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

  SELECT e.id, e.tickets_sold, e.capacity, e.code_prefix
    INTO v_event
    FROM public.events e
   WHERE e.id = v_order.event_id
   FOR UPDATE;

  v_prefix := COALESCE(v_event.code_prefix, 'TKT');

  -- Verificar cupo global (respeta NULL = ilimitado)
  IF v_event.capacity IS NOT NULL
     AND (v_event.tickets_sold + v_order.quantity) > v_event.capacity THEN
    RETURN jsonb_build_object('error', 'Sin disponibilidad en el evento');
  END IF;

  FOR v_ticket IN SELECT value FROM jsonb_array_elements(p_tickets_json) AS value
  LOOP
    v_tier_id   := (v_ticket->>'tier_id')::UUID;
    v_corr      := v_event.tickets_sold + v_count + 1;
    v_corr_code := v_prefix || '-' || LPAD(v_corr::TEXT, 5, '0');

    INSERT INTO public.tickets (
      order_id, event_id, qr_token, status, public_code,
      correlative_num, correlative_code, tier_id, tier_name
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

  UPDATE public.events
     SET tickets_sold = tickets_sold + v_count
   WHERE id = v_order.event_id;

  UPDATE public.orders SET status = 'completed' WHERE id = p_order_id;

  RETURN jsonb_build_object(
    'correlative_codes', v_correlatives,
    'ticket_ids',        v_ticket_ids,
    'quantity',          v_count
  );
END;
$$;

-- Permisos
GRANT EXECUTE ON FUNCTION public.rpc_create_purchase_intent_tiers TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_issue_tickets_bulk_v2 TO anon, authenticated, service_role;
