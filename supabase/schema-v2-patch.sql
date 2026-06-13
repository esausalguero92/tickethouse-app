-- =====================================================================
-- schema-v2-patch.sql
-- RPCs auxiliares para TicketService.js
-- Ejecutar después de schema-v2.sql
-- =====================================================================

-- -------------------------------------------------------------------
-- rpc_reserve_correlatives
-- Reserva N correlativos atómicamente usando nextval().
-- Retorna un TEXT[] con los códigos TH-PH001...
-- SOLO llamar desde service_role (server Node).
-- -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_reserve_correlatives(p_quantity INT)
RETURNS TEXT[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_codes TEXT[] := '{}';
  v_num   BIGINT;
  i       INT;
BEGIN
  IF p_quantity < 1 OR p_quantity > 20 THEN
    RAISE EXCEPTION 'quantity_out_of_range';
  END IF;
  FOR i IN 1..p_quantity LOOP
    SELECT nextval('public.ticket_correlative_seq') INTO v_num;
    v_codes := array_append(v_codes, 'TH-PH' || LPAD(v_num::TEXT, 3, '0'));
  END LOOP;
  RETURN v_codes;
END; $$;

GRANT EXECUTE ON FUNCTION public.rpc_reserve_correlatives(INT) TO service_role;

-- -------------------------------------------------------------------
-- rpc_issue_tickets_with_correlativos
-- Inserta N tickets con correlativos y JWTs ya firmados.
-- Los correlativos y tokens llegan pre-generados desde el server Node.
-- ATÓMICO: si falla 1 ticket, rollback de todos.
-- -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_issue_tickets_with_correlativos(
  p_order_id          UUID,
  p_correlative_codes TEXT[],
  p_qr_tokens         TEXT[]
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order        public.orders%ROWTYPE;
  v_ticket_ids   UUID[] := '{}';
  v_ticket_id    UUID;
  v_corr         TEXT;
  v_token        TEXT;
  i              INT;
BEGIN
  -- Verificar orden
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN
    RETURN jsonb_build_object('error', 'order_not_found');
  END IF;
  IF v_order.payment_status != 'paid' THEN
    RETURN jsonb_build_object('error', 'order_not_paid', 'status', v_order.payment_status);
  END IF;

  -- Verificar arrays
  IF array_length(p_correlative_codes, 1) != array_length(p_qr_tokens, 1) THEN
    RETURN jsonb_build_object('error', 'array_length_mismatch');
  END IF;
  IF array_length(p_correlative_codes, 1) != v_order.quantity THEN
    RETURN jsonb_build_object('error', 'quantity_mismatch',
                              'expected', v_order.quantity,
                              'got', array_length(p_correlative_codes, 1));
  END IF;

  -- Idempotencia: si ya hay tickets emitidos, retornar sin error
  IF EXISTS (SELECT 1 FROM public.tickets WHERE order_id = p_order_id AND status != 'revoked') THEN
    RETURN jsonb_build_object('ok', TRUE, 'skipped', TRUE, 'reason', 'already_issued');
  END IF;

  -- Insertar tickets
  FOR i IN 1..array_length(p_correlative_codes, 1) LOOP
    v_corr  := p_correlative_codes[i];
    v_token := p_qr_tokens[i];

    INSERT INTO public.tickets (
      order_id, event_id, buyer_id,
      correlative_code, correlative_num,
      qr_token, qr_payload, status
    )
    VALUES (
      p_order_id, v_order.event_id, v_order.buyer_id,
      v_corr,
      -- Extraer número del correlativo (TH-PH001 → 1)
      (regexp_replace(v_corr, '[^0-9]', '', 'g'))::BIGINT,
      v_token,
      jsonb_build_object(
        'correlative', v_corr,
        'event_id', v_order.event_id,
        'order_id', p_order_id,
        'buyer_name', v_order.buyer_name
      ),
      'issued'
    )
    RETURNING id INTO v_ticket_id;

    v_ticket_ids := array_append(v_ticket_ids, v_ticket_id);
  END LOOP;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'ticket_ids', v_ticket_ids,
    'correlative_codes', p_correlative_codes,
    'quantity', array_length(p_correlative_codes, 1)
  );
END; $$;

GRANT EXECUTE ON FUNCTION public.rpc_issue_tickets_with_correlativos(UUID, TEXT[], TEXT[]) TO service_role;
