-- =============================================================
-- FIX: Verificación de capacidad por tier en rpc_issue_tickets_bulk_v2
-- Ejecutar en Supabase SQL Editor
-- =============================================================

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
  v_tier         RECORD;
  v_phase        RECORD;
  v_prefix       TEXT;
  v_corr         INTEGER;
  v_corr_code    TEXT;
  v_ticket_id    UUID;
  v_count        INTEGER := 0;
  v_tier_id      UUID;
  v_correlatives JSONB   := '[]'::JSONB;
  v_ticket_ids   JSONB   := '[]'::JSONB;
BEGIN
  -- Idempotencia: si ya existen tickets para esta orden, retornar sin hacer nada
  IF EXISTS (SELECT 1 FROM public.tickets WHERE order_id = p_order_id LIMIT 1) THEN
    RETURN jsonb_build_object('error', 'tickets_already_exist',
      'count', (SELECT COUNT(*) FROM public.tickets WHERE order_id = p_order_id));
  END IF;

  SELECT o.id, o.event_id, o.quantity, o.payment_status, o.tier_items
    INTO v_order
    FROM public.orders o
   WHERE o.id = p_order_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Orden no encontrada');
  END IF;

  IF v_order.payment_status NOT IN ('pending', 'paid') THEN
    RETURN jsonb_build_object('error', 'Orden en estado invalido: ' || v_order.payment_status);
  END IF;

  SELECT e.id, e.tickets_sold, e.capacity, e.code_prefix
    INTO v_event
    FROM public.events e
   WHERE e.id = v_order.event_id
   FOR UPDATE;

  v_prefix := COALESCE(v_event.code_prefix, 'TKT');

  -- Verificar cupo global del evento (con lock)
  IF v_event.capacity IS NOT NULL
     AND (v_event.tickets_sold + v_order.quantity) > v_event.capacity THEN
    RETURN jsonb_build_object('error', 'Sin disponibilidad en el evento');
  END IF;

  -- ── NUEVO: Verificar capacidad por tier Y por fase (con FOR UPDATE) ──
  IF v_order.tier_items IS NOT NULL THEN
    FOR v_tier_item IN SELECT value FROM jsonb_array_elements(v_order.tier_items) AS value
    LOOP
      -- Lock y verificar tier
      SELECT tt.id, tt.name, tt.capacity, tt.tickets_sold
        INTO v_tier
        FROM public.ticket_tiers tt
       WHERE tt.id = (v_tier_item->>'tier_id')::UUID
       FOR UPDATE;

      IF FOUND AND v_tier.capacity IS NOT NULL
         AND (v_tier.tickets_sold + (v_tier_item->>'quantity')::INTEGER) > v_tier.capacity THEN
        RETURN jsonb_build_object('error', 'Sin disponibilidad en ' || v_tier.name);
      END IF;

      -- Lock y verificar fase
      IF (v_tier_item->>'phase_id') IS NOT NULL THEN
        SELECT tp.id, tp.name, tp.capacity, tp.tickets_sold
          INTO v_phase
          FROM public.tier_phases tp
         WHERE tp.id = (v_tier_item->>'phase_id')::UUID
         FOR UPDATE;

        IF FOUND AND v_phase.capacity IS NOT NULL
           AND (v_phase.tickets_sold + (v_tier_item->>'quantity')::INTEGER) > v_phase.capacity THEN
          RETURN jsonb_build_object('error', 'Agotada la fase actual de ' || v_tier.name);
        END IF;
      END IF;
    END LOOP;
  END IF;

  -- Insertar tickets
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

  -- Actualizar contadores
  IF v_order.tier_items IS NOT NULL THEN
    FOR v_tier_item IN SELECT value FROM jsonb_array_elements(v_order.tier_items) AS value
    LOOP
      UPDATE public.ticket_tiers
         SET tickets_sold = tickets_sold + (v_tier_item->>'quantity')::INTEGER
       WHERE id = (v_tier_item->>'tier_id')::UUID;

      UPDATE public.tier_phases
         SET tickets_sold = tickets_sold + (v_tier_item->>'quantity')::INTEGER
       WHERE id = (v_tier_item->>'phase_id')::UUID
         AND (v_tier_item->>'phase_id') IS NOT NULL;
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

GRANT EXECUTE ON FUNCTION public.rpc_issue_tickets_bulk_v2 TO anon, authenticated, service_role;
