-- ====================================================================
-- fix-active-phase.sql
-- Corrige rpc_get_active_phase: cuando is_active = TRUE, el admin
-- tiene control manual — ya no se bloquea por starts_at en el futuro.
-- Solo se respeta ends_at para auto-expirar fases.
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
  ORDER BY tp.sort_order ASC, tp.created_at ASC
  LIMIT 1;
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_get_active_phase(UUID)
  TO anon, authenticated, service_role;
