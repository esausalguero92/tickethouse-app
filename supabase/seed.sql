-- =====================================================================
-- Party House — Seed de datos de prueba
-- =====================================================================
-- Uso: ejecutar en Supabase SQL Editor DESPUÉS de schema.sql.
-- Idempotente: se puede re-ejecutar sin duplicar filas (usa ON CONFLICT).
--
-- Qué crea:
--   • 1 evento publicado (UUID fijo para que lo puedas usar como PH_CURRENT_EVENT_ID)
--   • 4 amenidades asociadas al evento
--   • 1 usuario staff (PIN 1234) + 1 admin + 1 master_owner de ejemplo
--   • 2 invitados (Jonathan y Demo)
--   • 2 códigos de acceso (JONATHAN-0001 y DEMO-0002)
--   • 1 orden 'paid' + 1 ticket emitido (para el flujo "ya pagó")
--   • 1 orden 'awaiting_review' con comprobante (para probar /aprobar en el bot)
--
-- Valores clave para copiar en las variables de entorno:
--   PH_CURRENT_EVENT_ID = 11111111-1111-1111-1111-111111111111
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Evento
-- ---------------------------------------------------------------------
insert into public.events (id, name, description, venue, event_date, price_usd, capacity, status)
values (
  '11111111-1111-1111-1111-111111111111',
  'Party House — Opening Night',
  'Fiesta de apertura de temporada. Dress code: black + neon.',
  'Salón Neón · Rooftop',
  now() + interval '30 days',
  50.00,
  300,
  'published'
)
on conflict (id) do update
  set name = excluded.name,
      description = excluded.description,
      venue = excluded.venue,
      event_date = excluded.event_date,
      price_usd = excluded.price_usd,
      capacity = excluded.capacity,
      status = excluded.status;

-- ---------------------------------------------------------------------
-- 2. Amenidades
-- ---------------------------------------------------------------------
insert into public.amenities (id, event_id, title, description, sort_order)
values
  ('a1111111-0000-0000-0000-000000000001',
   '11111111-1111-1111-1111-111111111111',
   'Barra libre premium',
   'Cócteles de autor y destilados top hasta las 3 AM.',
   1),
  ('a1111111-0000-0000-0000-000000000002',
   '11111111-1111-1111-1111-111111111111',
   'Área VIP',
   'Lounge privado con butacas de cuero y atención personalizada.',
   2),
  ('a1111111-0000-0000-0000-000000000003',
   '11111111-1111-1111-1111-111111111111',
   'DJ Headliner',
   'Line-up internacional con visuales reactivas a la música.',
   3),
  ('a1111111-0000-0000-0000-000000000004',
   '11111111-1111-1111-1111-111111111111',
   'Valet parking',
   'Estacionamiento asistido durante toda la noche.',
   4)
on conflict (id) do update
  set title = excluded.title,
      description = excluded.description,
      sort_order = excluded.sort_order;

-- ---------------------------------------------------------------------
-- 3. Usuarios de app (staff + admin + owner de ejemplo)
--    Ajustá telegram_id por el real antes de producción.
-- ---------------------------------------------------------------------
-- Admin y Owner comparten password_hash de demo: bcrypt("admin123").
-- Login web en /admin.html con: admin@partyhouse.example / admin123
insert into public.app_users (id, telegram_id, full_name, email, role, pin, password_hash, active)
values
  ('b0000000-0000-0000-0000-00000000aa01',
   NULL, 'Staff Demo', 'staff@partyhouse.example', 'staff', '1234', NULL, true),
  ('b0000000-0000-0000-0000-00000000aa02',
   100000001, 'Admin Demo', 'admin@partyhouse.example', 'admin',
   NULL, '$2b$10$.mcyLuJaKpdrNuODYq.C8eDyRPgm0W3szcBhM..gAdZ2CNXczj5GK', true),
  ('b0000000-0000-0000-0000-00000000aa03',
   200000001, 'Owner Demo', 'owner@partyhouse.example', 'master_owner',
   NULL, '$2b$10$.mcyLuJaKpdrNuODYq.C8eDyRPgm0W3szcBhM..gAdZ2CNXczj5GK', true)
on conflict (id) do update
  set telegram_id = excluded.telegram_id,
      full_name = excluded.full_name,
      email = excluded.email,
      role = excluded.role,
      pin = excluded.pin,
      password_hash = excluded.password_hash,
      active = excluded.active;

-- ---------------------------------------------------------------------
-- 4. Invitados
-- ---------------------------------------------------------------------
insert into public.guests (id, first_name, last_name, email, phone)
values
  ('c0000000-0000-0000-0000-0000000000a1',
   'Jonathan', 'Pérez', 'jonathan@example.com', '+52 555 000 0001'),
  ('c0000000-0000-0000-0000-0000000000a2',
   'Demo',     'Guest', 'demo@example.com',     '+52 555 000 0002'),
  ('c0000000-0000-0000-0000-0000000000a3',
   'Ana',      'Transfer', 'ana@example.com',   '+52 555 000 0003')
on conflict (email) do update
  set first_name = excluded.first_name,
      last_name = excluded.last_name,
      phone = excluded.phone;

-- ---------------------------------------------------------------------
-- 5. Códigos de acceso
--    JONATHAN-0001 → ya pagó (escenario "redirigir a ticket")
--    DEMO-0002     → sin pagar (flujo completo de pago)
--    ANA-0003      → transferencia en revisión
-- ---------------------------------------------------------------------
insert into public.access_codes (id, code, event_id, guest_id, generated_by, status)
values
  ('d0000000-0000-0000-0000-0000000000c1',
   'JONATHAN-0001',
   '11111111-1111-1111-1111-111111111111',
   'c0000000-0000-0000-0000-0000000000a1',
   'b0000000-0000-0000-0000-00000000aa02',
   'active'),
  ('d0000000-0000-0000-0000-0000000000c2',
   'DEMO-0002',
   '11111111-1111-1111-1111-111111111111',
   'c0000000-0000-0000-0000-0000000000a2',
   'b0000000-0000-0000-0000-00000000aa02',
   'active'),
  ('d0000000-0000-0000-0000-0000000000c3',
   'ANA-0003',
   '11111111-1111-1111-1111-111111111111',
   'c0000000-0000-0000-0000-0000000000a3',
   'b0000000-0000-0000-0000-00000000aa02',
   'active')
on conflict (code) do update
  set event_id = excluded.event_id,
      guest_id = excluded.guest_id,
      status = excluded.status;

-- ---------------------------------------------------------------------
-- 6. Orden PAGADA (PayPal) + ticket emitido para JONATHAN-0001
--    qr_token de ejemplo: NO es un JWT válido (el server lo rechazará),
--    pero sirve para probar visualmente /ticket.html renderizando el QR.
-- ---------------------------------------------------------------------
insert into public.orders (
  id, code_id, event_id, guest_id,
  amount_usd, payment_method, payment_status,
  paypal_order_id, paid_at
)
values (
  'e0000000-0000-0000-0000-000000000001',
  'd0000000-0000-0000-0000-0000000000c1',
  '11111111-1111-1111-1111-111111111111',
  'c0000000-0000-0000-0000-0000000000a1',
  50.00, 'paypal', 'paid',
  'SEED-PAYPAL-ORDER-0001', now() - interval '1 hour'
)
on conflict (id) do update
  set payment_status = excluded.payment_status,
      paid_at = excluded.paid_at;

insert into public.tickets (
  id, order_id, event_id, guest_id, qr_token, qr_payload, status
)
values (
  'f0000000-0000-0000-0000-000000000001',
  'e0000000-0000-0000-0000-000000000001',
  '11111111-1111-1111-1111-111111111111',
  'c0000000-0000-0000-0000-0000000000a1',
  'SEED.JWT.TOKEN.JONATHAN-0001.' || extract(epoch from now())::bigint::text,
  jsonb_build_object(
    'guest', 'Jonathan Pérez',
    'event', 'Party House — Opening Night',
    'code',  'JONATHAN-0001'
  ),
  'issued'
)
on conflict (id) do update
  set qr_token = excluded.qr_token,
      qr_payload = excluded.qr_payload,
      status = excluded.status;

-- ---------------------------------------------------------------------
-- 7. Orden EN REVISIÓN (transferencia) para ANA-0003
--    receipt_url simulado; reemplazar por una URL firmada real si querés
--    abrirlo desde el bot.
-- ---------------------------------------------------------------------
insert into public.orders (
  id, code_id, event_id, guest_id,
  amount_usd, payment_method, payment_status,
  transfer_reference, transfer_receipt_url
)
values (
  'e0000000-0000-0000-0000-000000000002',
  'd0000000-0000-0000-0000-0000000000c3',
  '11111111-1111-1111-1111-111111111111',
  'c0000000-0000-0000-0000-0000000000a3',
  50.00, 'transfer', 'awaiting_review',
  'REF-SEED-0002',
  'https://example.com/receipts/seed-ana-0003.jpg'
)
on conflict (id) do update
  set payment_status = excluded.payment_status,
      transfer_reference = excluded.transfer_reference,
      transfer_receipt_url = excluded.transfer_receipt_url;

-- ---------------------------------------------------------------------
-- 8. Verificación rápida
-- ---------------------------------------------------------------------
-- select code, g.first_name, o.payment_status, t.status as ticket_status
--   from public.access_codes ac
--   join public.guests g on g.id = ac.guest_id
--   left join public.orders o on o.code_id = ac.id
--   left join public.tickets t on t.order_id = o.id
--  order by ac.code;
--
-- Esperado:
--   ANA-0003       · Ana      · awaiting_review · (null)
--   DEMO-0002      · Demo     · (null)          · (null)
--   JONATHAN-0001  · Jonathan · paid            · issued
