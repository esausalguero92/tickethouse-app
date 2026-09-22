-- ====================================================================
-- fix-rpcs-v2.sql
-- Corrige nombres de columna en ambas RPCs de tiers:
--   full_name  → buyer_name
--   email      → buyer_email
--   status     → payment_status
--   'completed'→ 'paid'
-- Y restaura la math correcta de bundle:
--   subtotal = (qty / bundle_qty) * price_gtq
-- ====================================================================

-- ------------------------------------------------------------
-- 1. rpc_create_purchase_intent_tiers  (corregida)
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
  v_packs          INTEGER;
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
    RETURN jsonb_build_object('error', 'Cantidad invalida');
  END IF;

  IF v_event.max_per_order IS NOT NULL AND v_total_qty > v_event.max_per_order THEN
    RETURN jsonb_build_object('error', 'Maximo ' || v_event.max_per_order || ' tickets por orden');
  END IF;

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

    IF v_tier.capacity IS NOT NULL
       AND (v_tier.tickets_sold + v_qty) > v_tier.capacity THEN
      RETURN jsonb_build_object('error', 'Sin disponibilidad en ' || v_tier.name);
    END IF;

    SELECT tp.id, tp.name, tp.price_gtq, tp.capacity, tp.tickets_sold,
           COALESCE(tp.bundle_qty, 1) AS bundle_qty
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

    IF v_phase.bundle_qty > 1 AND (v_qty % v_phase.bundle_qty) <> 0 THEN
      RETURN jsonb_build_object(
        'error', 'La cantidad para "' || v_tier.name || '" debe ser multiplo de ' || v_phase.bundle_qty
      );
    END IF;

    IF v_phase.capacity IS NOT NULL
       AND (v_phase.tickets_sold + v_qty) > v_phase.capacity THEN
      RETURN jsonb_build_object('error', 'Agotada la fase actual de ' || v_tier.name);
    END IF;

    v_packs    := v_qty / v_phase.bundle_qty;
    v_subtotal := v_packs * v_phase.price_gtq;
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
    RETURN jsonb_build_object('error', 'Total invalido');
  END IF;

  INSERT INTO public.orders (
    event_id,
    buyer_name,
    buyer_email,
    quantity,
    amount_usd,
    payment_method,
    payment_status,
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


-- ------------------------------------------------------------
-- 2. rpc_issue_tickets_bulk_v2  (corregida)
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
  SELECT o.id, o.event_id, o.quantity, o.payment_status, o.tier_items
    INTO v_order
    FROM public.orders o
   WHERE o.id = p_order_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Orden no encontrada');
  END IF;

  -- Idempotency: si ya existen tickets para esta orden, no re-emitir
  IF EXISTS (SELECT 1 FROM public.tickets WHERE order_id = p_order_id AND status != 'revoked') THEN
    RETURN jsonb_build_object('error', 'Tickets ya emitidos para esta orden');
  END IF;
  -- Aceptar tanto 'pending' como 'paid' (el caller puede pre-marcar la orden)
  IF v_order.payment_status NOT IN ('pending', 'paid') THEN
    RETURN jsonb_build_object('error', 'Orden en estado invalido: ' || v_order.payment_status);
  END IF;

  SELECT e.id, e.tickets_sold, e.capacity, e.code_prefix
    INTO v_event
    FROM public.events e
   WHERE e.id = v_order.event_id
   FOR UPDATE;

  v_prefix := COALESCE(v_event.code_prefix, 'TKT');

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
      'issued',
      encode(extensions.gen_random_bytes(9), 'base64'),
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

  UPDATE public.orders
     SET payment_status = 'paid',
         paid_at        = NOW()
   WHERE id = p_order_id;

  RETURN jsonb_build_object(
    'correlative_codes', v_correlatives,
    'ticket_ids',        v_ticket_ids,
    'quantity',          v_count
  );
END;
$$;


-- ------------------------------------------------------------
-- 3. Permisos
-- ------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.rpc_create_purchase_intent_tiers(UUID, TEXT, TEXT, JSONB, BOOLEAN, BOOLEAN)
  TO anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.rpc_issue_tickets_bulk_v2(UUID, JSONB)
  TO anon, authenticated, service_role;
