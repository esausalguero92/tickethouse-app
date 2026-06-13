-- =====================================================================
-- TicketHouseV2 — Seed v2.0 (Compra Libre)
-- =====================================================================
-- Ejecutar DESPUÉS de schema-v2.sql.
-- Crea: evento demo, event_code PH787, buyers de prueba,
--       orden de 3 tickets (pagada), orden de 2 tickets (en revisión),
--       usuarios staff/admin, amenidades.
-- =====================================================================

-- -------------------------------------------------------------------
-- 1. Evento
-- -------------------------------------------------------------------
INSERT INTO public.events (
  id, name, description, venue, event_date,
  price_usd, capacity, max_per_order, status, event_code
)
VALUES (
  '11111111-1111-1111-1111-111111111111',
  'Party House — Vol. 01',
  'La primera edición. Una noche para quienes ya saben.',
  'Rooftop Z11 · Ciudad de Guatemala',
  NOW() + INTERVAL '30 days',
  50.00,
  300,
  5,
  'published',
  'PH787'
)
ON CONFLICT (id) DO UPDATE
  SET name = EXCLUDED.name,
      description = EXCLUDED.description,
      venue = EXCLUDED.venue,
      event_date = EXCLUDED.event_date,
      price_usd = EXCLUDED.price_usd,
      capacity = EXCLUDED.capacity,
      max_per_order = EXCLUDED.max_per_order,
      status = EXCLUDED.status,
      event_code = EXCLUDED.event_code;

-- -------------------------------------------------------------------
-- 2. Event Code
-- -------------------------------------------------------------------
INSERT INTO public.event_codes (id, event_id, code, active)
VALUES (
  'c1111111-1111-1111-1111-111111111111',
  '11111111-1111-1111-1111-111111111111',
  'PH787',
  TRUE
)
ON CONFLICT (code) DO UPDATE SET active = EXCLUDED.active;

-- -------------------------------------------------------------------
-- 3. Amenidades
-- -------------------------------------------------------------------
INSERT INTO public.amenities (id, event_id, title, description, sort_order)
VALUES
  ('a1111111-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'Barra libre premium', 'Cócteles de autor y destilados top hasta las 3 AM.', 1),
  ('a1111111-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
   'Área VIP', 'Lounge privado con butacas y atención personalizada.', 2),
  ('a1111111-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111',
   'DJ Headliner', 'Line-up internacional con visuales reactivas.', 3),
  ('a1111111-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111',
   'Valet parking', 'Estacionamiento asistido toda la noche.', 4)
ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description;

-- -------------------------------------------------------------------
-- 4. App users (admin + staff)
-- -------------------------------------------------------------------
INSERT INTO public.app_users (id, full_name, email, role, pin, password_hash, active)
VALUES
  ('b0000000-0000-0000-0000-00000000aa01',
   'Staff Demo', 'staff@partyhouse.example', 'staff', '1234', NULL, TRUE),
  ('b0000000-0000-0000-0000-00000000aa02',
   'Admin Demo', 'admin@partyhouse.example', 'admin', NULL,
   '$2b$10$.mcyLuJaKpdrNuODYq.C8eDyRPgm0W3szcBhM..gAdZ2CNXczj5GK', TRUE),
  ('b0000000-0000-0000-0000-00000000aa03',
   'Owner Demo', 'owner@partyhouse.example', 'master_owner', NULL,
   '$2b$10$.mcyLuJaKpdrNuODYq.C8eDyRPgm0W3szcBhM..gAdZ2CNXczj5GK', TRUE)
ON CONFLICT (id) DO UPDATE
  SET full_name = EXCLUDED.full_name, role = EXCLUDED.role,
      pin = EXCLUDED.pin, password_hash = EXCLUDED.password_hash, active = EXCLUDED.active;

-- -------------------------------------------------------------------
-- 5. Buyers de prueba
-- -------------------------------------------------------------------
INSERT INTO public.buyers (id, full_name, email, phone, age_verified, terms_accepted)
VALUES
  ('cb000001-0000-0000-0000-000000000001',
   'Carlos Mendoza', 'carlos@example.com', '+502 5555 0001', TRUE, TRUE),
  ('cb000002-0000-0000-0000-000000000002',
   'Valentina Ruiz', 'vale@example.com', '+502 5555 0002', TRUE, TRUE),
  ('cb000003-0000-0000-0000-000000000003',
   'Diego Castillo', 'diego@example.com', '+502 5555 0003', TRUE, TRUE)
ON CONFLICT (id) DO NOTHING;

-- -------------------------------------------------------------------
-- 6. Orden 1 — PAGADA (PayPal, 3 entradas)
--    Buyer: Carlos Mendoza
--    Tickets: TH-PH001, TH-PH002, TH-PH003
-- -------------------------------------------------------------------
INSERT INTO public.orders (
  id, event_id, event_code_id, buyer_id,
  buyer_name, buyer_email, quantity, amount_usd,
  payment_method, payment_status, paypal_order_id, paid_at
)
VALUES (
  'e0000001-0000-0000-0000-000000000001',
  '11111111-1111-1111-1111-111111111111',
  'c1111111-1111-1111-1111-111111111111',
  'cb000001-0000-0000-0000-000000000001',
  'Carlos Mendoza', 'carlos@example.com',
  3, 150.00,
  'paypal', 'paid',
  'SEED-PP-ORDER-001',
  NOW() - INTERVAL '2 hours'
)
ON CONFLICT (id) DO UPDATE SET payment_status = EXCLUDED.payment_status;

-- Tickets para orden 1 (correlativos manuales para seed — en prod usan la sequence)
-- Nota: en producción real, rpc_issue_tickets_bulk usa nextval() atómico.
-- Para el seed, insertamos directamente con correlativos fijos.
INSERT INTO public.tickets (
  id, order_id, event_id, buyer_id,
  correlative_code, correlative_num,
  qr_token, qr_payload, status
)
VALUES
  ('a0000001-0000-0000-0000-000000000001',
   'e0000001-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111',
   'cb000001-0000-0000-0000-000000000001',
   'TH-PH001', 1,
   'SEED.JWT.TH-PH001.' || extract(epoch FROM NOW())::bigint::text,
   '{"correlative":"TH-PH001","buyer":"Carlos Mendoza"}',
   'issued'),
  ('a0000002-0000-0000-0000-000000000002',
   'e0000001-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111',
   'cb000001-0000-0000-0000-000000000001',
   'TH-PH002', 2,
   'SEED.JWT.TH-PH002.' || extract(epoch FROM NOW())::bigint::text,
   '{"correlative":"TH-PH002","buyer":"Carlos Mendoza"}',
   'issued'),
  ('a0000003-0000-0000-0000-000000000003',
   'e0000001-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111',
   'cb000001-0000-0000-0000-000000000001',
   'TH-PH003', 3,
   'SEED.JWT.TH-PH003.' || extract(epoch FROM NOW())::bigint::text,
   '{"correlative":"TH-PH003","buyer":"Carlos Mendoza"}',
   'redeemed')
ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status;

-- TH-PH003 ya redimido → simular validación en puerta
UPDATE public.tickets SET redeemed_at = NOW() - INTERVAL '30 minutes' WHERE id = 'a0000003-0000-0000-0000-000000000003';

INSERT INTO public.validation_log (ticket_id, qr_scanned, result, scanned_at)
VALUES (
  'a0000003-0000-0000-0000-000000000003',
  'TH-PH003', 'valid', NOW() - INTERVAL '30 minutes'
) ON CONFLICT DO NOTHING;

-- -------------------------------------------------------------------
-- 7. Orden 2 — EN REVISIÓN (transferencia, 2 entradas)
--    Buyer: Valentina Ruiz
-- -------------------------------------------------------------------
INSERT INTO public.orders (
  id, event_id, event_code_id, buyer_id,
  buyer_name, buyer_email, quantity, amount_usd,
  payment_method, payment_status,
  transfer_reference, transfer_receipt_url
)
VALUES (
  'e0000002-0000-0000-0000-000000000002',
  '11111111-1111-1111-1111-111111111111',
  'c1111111-1111-1111-1111-111111111111',
  'cb000002-0000-0000-0000-000000000002',
  'Valentina Ruiz', 'vale@example.com',
  2, 100.00,
  'transfer', 'awaiting_review',
  'REF-SEED-77890',
  'https://example.com/receipts/seed-vale-001.jpg'
)
ON CONFLICT (id) DO UPDATE SET payment_status = EXCLUDED.payment_status;

-- -------------------------------------------------------------------
-- 8. Orden 3 — PENDIENTE SIN PAGO (para probar flujo abandono)
--    Buyer: Diego Castillo
-- -------------------------------------------------------------------
INSERT INTO public.orders (
  id, event_id, event_code_id, buyer_id,
  buyer_name, buyer_email, quantity, amount_usd,
  payment_method, payment_status
)
VALUES (
  'e0000003-0000-0000-0000-000000000003',
  '11111111-1111-1111-1111-111111111111',
  'c1111111-1111-1111-1111-111111111111',
  'cb000003-0000-0000-0000-000000000003',
  'Diego Castillo', 'diego@example.com',
  1, 50.00,
  'paypal', 'pending'
)
ON CONFLICT (id) DO NOTHING;

-- -------------------------------------------------------------------
-- 9. Ajustar sequence al valor siguiente después de los seeds
--    (tickets 1, 2, 3 ya están insertados → siguiente es 4)
-- -------------------------------------------------------------------
SELECT setval('public.ticket_correlative_seq', 3, TRUE);

-- -------------------------------------------------------------------
-- 10. Actualizar tickets_sold en el evento
--     (3 tickets de orden 1 = 3 vendidos; orden 2 aún no confirmada)
-- -------------------------------------------------------------------
UPDATE public.events
SET tickets_sold = (
  SELECT count(*) FROM public.tickets
  WHERE event_id = '11111111-1111-1111-1111-111111111111'
    AND status != 'revoked'
)
WHERE id = '11111111-1111-1111-1111-111111111111';

-- -------------------------------------------------------------------
-- 11. Verificación rápida
-- -------------------------------------------------------------------
-- SELECT o.buyer_name, o.quantity, o.payment_status,
--        array_agg(t.correlative_code ORDER BY t.correlative_num) AS tickets,
--        count(t.id) AS ticket_count
--   FROM public.orders o
--   LEFT JOIN public.tickets t ON t.order_id = o.id
--  WHERE o.event_id = '11111111-1111-1111-1111-111111111111'
--  GROUP BY o.id, o.buyer_name, o.quantity, o.payment_status
--  ORDER BY o.created_at;
--
-- Esperado:
--   Carlos Mendoza  | 3 | paid            | {TH-PH001,TH-PH002,TH-PH003} | 3
--   Valentina Ruiz  | 2 | awaiting_review | {}                            | 0
--   Diego Castillo  | 1 | pending         | {}                            | 0
