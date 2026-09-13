-- ============================================================
-- TicketHouseV2 — Migration v4
-- Códigos de descuento siempre asociados a un evento específico.
-- Los códigos globales (event_id NULL) ya no están permitidos.
-- ============================================================

-- 1. Eliminar códigos globales existentes (si los hubiera)
--    PRECAUCIÓN: revisar antes de ejecutar en producción.
-- DELETE FROM public.discount_codes WHERE event_id IS NULL;

-- 2. Hacer event_id NOT NULL en discount_codes
ALTER TABLE public.discount_codes
  ALTER COLUMN event_id SET NOT NULL;

-- 3. Actualizar rpc_validate_discount_code — quitar la rama global
CREATE OR REPLACE FUNCTION public.rpc_validate_discount_code(
    p_code          TEXT,
    p_event_id      UUID,
    p_amount_usd    NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_dc    public.discount_codes%ROWTYPE;
    v_disc  NUMERIC(10,2);
    v_final NUMERIC(10,2);
BEGIN
    -- Buscar código exactamente para este evento (case-insensitive)
    SELECT * INTO v_dc
    FROM public.discount_codes
    WHERE UPPER(code) = UPPER(p_code)
      AND event_id = p_event_id
      AND active = TRUE
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
        v_disc  := LEAST(v_dc.discount_value, p_amount_usd);
    END IF;

    v_final := GREATEST(p_amount_usd - v_disc, 0);

    RETURN jsonb_build_object(
        'valid',               TRUE,
        'discount_id',         v_dc.id,
        'code',                v_dc.code,
        'description',         v_dc.description,
        'discount_type',       v_dc.discount_type,
        'discount_value',      v_dc.discount_value,
        'discount_amount_usd', v_disc,
        'final_amount_usd',    v_final
    );
END; $$;

GRANT EXECUTE ON FUNCTION public.rpc_validate_discount_code(TEXT, UUID, NUMERIC)
  TO anon, authenticated;
