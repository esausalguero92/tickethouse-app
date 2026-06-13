-- =====================================================================
-- Party House — Esquema de base de datos (Supabase / PostgreSQL)
-- =====================================================================
-- Ejecutar en: Supabase > SQL Editor
-- Orden: 1) extensiones 2) tablas 3) índices 4) funciones 5) RLS 6) RPCs públicas 7) Storage
-- =====================================================================

-- -------------------------------------------------------------
-- 1. Extensiones
-- -------------------------------------------------------------
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- -------------------------------------------------------------
-- 2. Tablas
-- -------------------------------------------------------------

-- Eventos / fiestas
create table if not exists public.events (
    id           uuid primary key default uuid_generate_v4(),
    name         text not null,
    description  text,
    venue        text,
    event_date   timestamptz not null,
    price_usd    numeric(10,2) not null default 0,
    capacity     int,
    cover_image  text,
    status       text not null default 'draft'
                 check (status in ('draft','published','closed','cancelled')),
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

-- Usuarios administradores / master owners / staff
-- Para admin/master_owner el password_hash se usa en el login web de /admin.html.
-- Para staff el pin se usa en /validador.html.
create table if not exists public.app_users (
    id             uuid primary key default uuid_generate_v4(),
    telegram_id    bigint unique,
    full_name      text not null,
    email          text unique,
    role           text not null check (role in ('admin','master_owner','staff')),
    pin            text,           -- pin de puerta para staff; null para admin/owner
    password_hash  text,           -- bcrypt hash (solo admin / master_owner)
    active         boolean not null default true,
    created_at     timestamptz not null default now()
);

-- Compatibilidad: si la tabla ya existía sin la columna password_hash, agregarla.
alter table public.app_users add column if not exists password_hash text;

-- Compatibilidad: actualizar el constraint de payment_method para incluir 'complimentary'.
do $$
begin
  alter table public.orders drop constraint if exists orders_payment_method_check;
  alter table public.orders add constraint orders_payment_method_check
    check (payment_method in ('paypal','transfer','complimentary'));
exception when others then null;
end $$;

-- Compatibilidad: si la tabla existía sin UNIQUE en email, agregarlo.
-- (necesario para que el upsert por email de create-admin.js funcione)
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'app_users_email_key'
       and conrelid = 'public.app_users'::regclass
  ) then
    alter table public.app_users add constraint app_users_email_key unique (email);
  end if;
end $$;

-- Invitados / clientes
create table if not exists public.guests (
    id           uuid primary key default uuid_generate_v4(),
    first_name   text not null,
    last_name    text not null,
    email        text,           -- se captura al momento del pago, no al crear el código
    phone        text,
    created_at   timestamptz not null default now(),
    unique (email)
);

-- Compatibilidad: si la tabla ya existía con email NOT NULL, quitamos la restricción.
alter table public.guests alter column email drop not null;

-- Códigos de acceso a la landing page
-- Formato sugerido: NOMBRE-####  (ej. JONATHAN-4821)
create table if not exists public.access_codes (
    id              uuid primary key default uuid_generate_v4(),
    code            text not null unique,
    event_id        uuid not null references public.events(id) on delete cascade,
    guest_id        uuid not null references public.guests(id) on delete cascade,
    generated_by    uuid references public.app_users(id),
    status          text not null default 'active'
                    check (status in ('active','used','expired','revoked')),
    first_used_at   timestamptz,
    expires_at      timestamptz,
    created_at      timestamptz not null default now()
);

-- Órdenes / pagos
create table if not exists public.orders (
    id                uuid primary key default uuid_generate_v4(),
    code_id           uuid not null references public.access_codes(id) on delete cascade,
    event_id          uuid not null references public.events(id),
    guest_id          uuid not null references public.guests(id),
    amount_usd        numeric(10,2) not null,
    payment_method    text not null check (payment_method in ('paypal','transfer','complimentary')),
    payment_status    text not null default 'pending'
                      check (payment_status in ('pending','awaiting_review','paid','rejected','refunded')),
    paypal_order_id   text,
    transfer_reference text,
    transfer_receipt_url text,
    reviewed_by       uuid references public.app_users(id),
    reviewed_at       timestamptz,
    paid_at           timestamptz,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now()
);

-- Tickets con QR generado tras pago confirmado
create table if not exists public.tickets (
    id            uuid primary key default uuid_generate_v4(),
    order_id      uuid not null unique references public.orders(id) on delete cascade,
    event_id      uuid not null references public.events(id),
    guest_id      uuid not null references public.guests(id),
    qr_token      text not null unique,   -- JWT firmado
    qr_payload    jsonb,                   -- datos visibles al escanear
    status        text not null default 'issued'
                  check (status in ('issued','redeemed','revoked')),
    redeemed_at   timestamptz,
    redeemed_by   uuid references public.app_users(id),
    created_at    timestamptz not null default now()
);

-- Log de validaciones en puerta (auditoría)
create table if not exists public.validation_log (
    id            uuid primary key default uuid_generate_v4(),
    ticket_id     uuid references public.tickets(id),
    qr_scanned    text not null,
    result        text not null check (result in ('valid','already_used','invalid','expired')),
    scanned_by    uuid references public.app_users(id),
    scanned_at    timestamptz not null default now(),
    user_agent    text,
    ip_address    inet
);

-- Amenidades del evento (publicables en la landing)
create table if not exists public.amenities (
    id          uuid primary key default uuid_generate_v4(),
    event_id    uuid not null references public.events(id) on delete cascade,
    title       text not null,
    description text,
    icon        text,
    image_url   text,
    sort_order  int default 0,
    created_at  timestamptz not null default now()
);

-- Log general para el bot Master Owner (consultas y auditoría)
create table if not exists public.activity_log (
    id         uuid primary key default uuid_generate_v4(),
    actor_id   uuid references public.app_users(id),
    action     text not null,
    entity     text,
    entity_id  uuid,
    payload    jsonb,
    created_at timestamptz not null default now()
);

-- -------------------------------------------------------------
-- 3. Índices
-- -------------------------------------------------------------
create index if not exists idx_codes_event on public.access_codes(event_id);
create index if not exists idx_codes_status on public.access_codes(status);
create index if not exists idx_orders_status on public.orders(payment_status);
create index if not exists idx_orders_code on public.orders(code_id);
create index if not exists idx_tickets_status on public.tickets(status);
create index if not exists idx_tickets_event on public.tickets(event_id);
create index if not exists idx_validation_scanned_at on public.validation_log(scanned_at desc);
create index if not exists idx_activity_created on public.activity_log(created_at desc);

-- -------------------------------------------------------------
-- 4. Funciones de apoyo
-- -------------------------------------------------------------

-- Actualiza updated_at automáticamente
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end; $$;

drop trigger if exists trg_events_updated on public.events;
create trigger trg_events_updated before update on public.events
for each row execute function public.set_updated_at();

drop trigger if exists trg_orders_updated on public.orders;
create trigger trg_orders_updated before update on public.orders
for each row execute function public.set_updated_at();

-- Generador de códigos: 2 iniciales + 3 dígitos (ej. JP482)
-- Espacio = 26*26*900 = 608 400 códigos únicos posibles.
create or replace function public.generate_access_code(p_first_name text, p_last_name text default '')
returns text language plpgsql as $$
declare
    first_init text;
    last_init  text;
    candidate  text;
    attempts   int := 0;
begin
    first_init := upper(left(regexp_replace(p_first_name, '[^A-Za-z]', '', 'g'), 1));
    last_init  := upper(left(regexp_replace(p_last_name,  '[^A-Za-z]', '', 'g'), 1));
    if first_init = '' then first_init := 'G'; end if;
    if last_init  = '' then last_init  := 'X'; end if;

    loop
        candidate := first_init || last_init || (floor(random()*900) + 100)::int::text;
        exit when not exists (select 1 from public.access_codes where code = candidate);
        attempts := attempts + 1;
        if attempts > 200 then
            raise exception 'No se pudo generar un código único después de 200 intentos';
        end if;
    end loop;

    return candidate;
end; $$;

-- Marca el código como usado al primer login
create or replace function public.mark_code_first_use(p_code text)
returns void language plpgsql as $$
begin
    update public.access_codes
       set first_used_at = coalesce(first_used_at, now())
     where code = p_code;
end; $$;

-- -------------------------------------------------------------
-- 5. Row Level Security (RLS)
-- -------------------------------------------------------------
-- Habilitamos RLS en todas las tablas. Las lecturas desde la landing
-- se hacen EXCLUSIVAMENTE vía funciones SECURITY DEFINER (sección 6),
-- por lo que las tablas sensibles quedan bloqueadas para anon.

alter table public.events          enable row level security;
alter table public.app_users       enable row level security;
alter table public.guests          enable row level security;
alter table public.access_codes    enable row level security;
alter table public.orders          enable row level security;
alter table public.tickets         enable row level security;
alter table public.validation_log  enable row level security;
alter table public.amenities       enable row level security;
alter table public.activity_log    enable row level security;

-- Políticas públicas mínimas (solo amenidades y eventos publicados son "vitrina")
drop policy if exists "public_read_published_events" on public.events;
create policy "public_read_published_events" on public.events
    for select to anon, authenticated
    using (status = 'published');

drop policy if exists "public_read_amenities" on public.amenities;
create policy "public_read_amenities" on public.amenities
    for select to anon, authenticated
    using (
        exists (select 1 from public.events e
                 where e.id = amenities.event_id and e.status = 'published')
    );

-- El resto de las tablas queda bloqueado para anon. Solo los SECURITY DEFINER
-- RPCs abajo y la service_role key (usada desde N8N) podrán escribir.

-- =====================================================================
-- 6. RPCs públicas (llamadas desde la landing con la anon_key)
-- =====================================================================
-- Todas son SECURITY DEFINER → ejecutan con privilegios de su owner
-- (postgres/supabase_admin), por lo que evaden RLS de forma controlada.
-- Validan sus parámetros y solo exponen lo estrictamente necesario.
-- =====================================================================

-- 6.1 Login por código: devuelve los datos para la bienvenida + estado de pago.
create or replace function public.rpc_validate_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code_id       uuid;
  v_code_status   text;
  v_event_id      uuid;
  v_event_row     public.events%rowtype;
  v_guest_row     public.guests%rowtype;
  v_order_status  text;
  v_has_ticket    boolean := false;
begin
  if p_code is null or length(trim(p_code)) = 0 then
    return jsonb_build_object('error', 'code_required');
  end if;

  select ac.id, ac.status, ac.event_id
    into v_code_id, v_code_status, v_event_id
  from public.access_codes ac
  where ac.code = upper(trim(p_code))
  limit 1;

  if v_code_id is null then
    return jsonb_build_object('error', 'code_not_found');
  end if;

  if v_code_status in ('revoked','expired') then
    return jsonb_build_object('error', 'code_inactive');
  end if;

  -- Marcar primer uso
  update public.access_codes
     set first_used_at = coalesce(first_used_at, now())
   where id = v_code_id;

  select * into v_event_row from public.events where id = v_event_id;
  select g.* into v_guest_row
    from public.guests g
    join public.access_codes ac on ac.guest_id = g.id
   where ac.id = v_code_id;

  select payment_status into v_order_status
    from public.orders
   where code_id = v_code_id
     and payment_status in ('paid','awaiting_review')
   order by created_at desc
   limit 1;

  select exists (
    select 1 from public.tickets t
    join public.orders o on o.id = t.order_id
    where o.code_id = v_code_id and t.status <> 'revoked'
  ) into v_has_ticket;

  return jsonb_build_object(
    'code', upper(trim(p_code)),
    'code_id', v_code_id,
    'event', jsonb_build_object(
      'id', v_event_row.id,
      'name', v_event_row.name,
      'description', v_event_row.description,
      'venue', v_event_row.venue,
      'event_date', v_event_row.event_date,
      'price_usd', v_event_row.price_usd,
      'cover_image', v_event_row.cover_image
    ),
    'guest', jsonb_build_object(
      'first_name', v_guest_row.first_name,
      'last_name', v_guest_row.last_name
    ),
    'already_paid',     coalesce(v_order_status = 'paid', false),
    'awaiting_review',  coalesce(v_order_status = 'awaiting_review', false),
    'has_ticket',       v_has_ticket
  );
end; $$;

grant execute on function public.rpc_validate_code(text) to anon, authenticated;

-- 6.2 Amenidades de un evento publicado (si preferís no usar la política RLS directa).
create or replace function public.rpc_get_amenities(p_event_id uuid)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'id', a.id,
             'title', a.title,
             'description', a.description,
             'icon', a.icon,
             'image_url', a.image_url,
             'sort_order', a.sort_order
           ) order by a.sort_order
         ), '[]'::jsonb)
    from public.amenities a
    join public.events e on e.id = a.event_id
   where a.event_id = p_event_id
     and e.status = 'published';
$$;

grant execute on function public.rpc_get_amenities(uuid) to anon, authenticated;

-- 6.3 Ticket del invitado (muestra el QR si ya fue emitido).
create or replace function public.rpc_get_my_ticket(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code_id uuid;
  v_ticket  public.tickets%rowtype;
  v_event   public.events%rowtype;
  v_guest   public.guests%rowtype;
begin
  select id into v_code_id
    from public.access_codes
   where code = upper(trim(p_code))
   limit 1;

  if v_code_id is null then
    return jsonb_build_object('error','code_not_found');
  end if;

  select t.* into v_ticket
    from public.tickets t
    join public.orders o on o.id = t.order_id
   where o.code_id = v_code_id
     and t.status <> 'revoked'
   order by t.created_at desc
   limit 1;

  if v_ticket.id is null then
    return jsonb_build_object('error','no_ticket');
  end if;

  select * into v_event from public.events where id = v_ticket.event_id;
  select * into v_guest from public.guests where id = v_ticket.guest_id;

  return jsonb_build_object(
    'ticket', jsonb_build_object(
      'id', v_ticket.id,
      'qr_token', v_ticket.qr_token,
      'status', v_ticket.status,
      'created_at', v_ticket.created_at
    ),
    'event', jsonb_build_object(
      'name', v_event.name,
      'venue', v_event.venue,
      'event_date', v_event.event_date
    ),
    'guest', jsonb_build_object(
      'first_name', v_guest.first_name,
      'last_name', v_guest.last_name
    )
  );
end; $$;

grant execute on function public.rpc_get_my_ticket(text) to anon, authenticated;

-- 6.4 Transferencia: registra que el invitado subió comprobante (N8N lo procesa después).
-- Recibe el código, monto, referencia y la URL del comprobante (ya subido por N8N a Storage).
-- Esta RPC la llama N8N vía service_role, pero se deja SECURITY DEFINER para permitir usos futuros.
create or replace function public.rpc_create_transfer_order(
  p_code text,
  p_amount_usd numeric,
  p_reference text,
  p_receipt_url text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code_id  uuid;
  v_event_id uuid;
  v_guest_id uuid;
  v_order_id uuid;
begin
  select id, event_id, guest_id
    into v_code_id, v_event_id, v_guest_id
  from public.access_codes
  where code = upper(trim(p_code))
    and status = 'active'
  limit 1;

  if v_code_id is null then
    return jsonb_build_object('error','code_not_found_or_inactive');
  end if;

  insert into public.orders (code_id, event_id, guest_id, amount_usd,
                             payment_method, payment_status,
                             transfer_reference, transfer_receipt_url)
  values (v_code_id, v_event_id, v_guest_id, p_amount_usd,
          'transfer','awaiting_review',
          p_reference, p_receipt_url)
  returning id into v_order_id;

  return jsonb_build_object('ok', true, 'order_id', v_order_id);
end; $$;

grant execute on function public.rpc_create_transfer_order(text, numeric, text, text) to anon, authenticated, service_role;

-- 6.5 PayPal: crea la orden como pagada una vez confirmada la captura desde N8N.
create or replace function public.rpc_create_paypal_order(
  p_code text,
  p_amount_usd numeric,
  p_paypal_order_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code_id  uuid;
  v_event_id uuid;
  v_guest_id uuid;
  v_order_id uuid;
begin
  select id, event_id, guest_id
    into v_code_id, v_event_id, v_guest_id
  from public.access_codes
  where code = upper(trim(p_code))
    and status = 'active'
  limit 1;

  if v_code_id is null then
    return jsonb_build_object('error','code_not_found_or_inactive');
  end if;

  insert into public.orders (code_id, event_id, guest_id, amount_usd,
                             payment_method, payment_status,
                             paypal_order_id, paid_at)
  values (v_code_id, v_event_id, v_guest_id, p_amount_usd,
          'paypal','paid',
          p_paypal_order_id, now())
  returning id into v_order_id;

  return jsonb_build_object('ok', true, 'order_id', v_order_id,
                            'event_id', v_event_id, 'guest_id', v_guest_id);
end; $$;

grant execute on function public.rpc_create_paypal_order(text, numeric, text) to service_role;

-- 6.6 Registrar ticket emitido (llamado por N8N con service_role después de firmar el JWT).
create or replace function public.rpc_issue_ticket(
  p_order_id uuid,
  p_qr_token text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_id uuid;
  v_guest_id uuid;
  v_ticket_id uuid;
begin
  select event_id, guest_id into v_event_id, v_guest_id
    from public.orders where id = p_order_id;

  if v_event_id is null then
    return jsonb_build_object('error','order_not_found');
  end if;

  insert into public.tickets (order_id, event_id, guest_id, qr_token, qr_payload)
  values (p_order_id, v_event_id, v_guest_id, p_qr_token, p_payload)
  returning id into v_ticket_id;

  return jsonb_build_object('ok', true, 'ticket_id', v_ticket_id);
end; $$;

grant execute on function public.rpc_issue_ticket(uuid, text, jsonb) to service_role;

-- 6.7 Aprobar/rechazar orden (llamada por N8N desde el bot Admin).
create or replace function public.rpc_review_order(
  p_order_id uuid,
  p_decision text,          -- 'approve' | 'reject'
  p_reviewer_telegram bigint default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reviewer uuid;
  v_order    public.orders%rowtype;
begin
  if p_decision not in ('approve','reject') then
    return jsonb_build_object('error','invalid_decision');
  end if;

  select id into v_reviewer
    from public.app_users
   where telegram_id = p_reviewer_telegram
   limit 1;

  select * into v_order from public.orders where id = p_order_id;
  if v_order.id is null then
    return jsonb_build_object('error','order_not_found');
  end if;

  if p_decision = 'approve' then
    update public.orders
       set payment_status = 'paid',
           paid_at = now(),
           reviewed_by = v_reviewer,
           reviewed_at = now()
     where id = p_order_id;
    return jsonb_build_object('ok', true, 'action','approved',
                              'order_id', p_order_id,
                              'event_id', v_order.event_id,
                              'guest_id', v_order.guest_id);
  else
    update public.orders
       set payment_status = 'rejected',
           reviewed_by = v_reviewer,
           reviewed_at = now()
     where id = p_order_id;
    return jsonb_build_object('ok', true, 'action','rejected',
                              'order_id', p_order_id,
                              'reason', p_reason);
  end if;
end; $$;

grant execute on function public.rpc_review_order(uuid, text, bigint, text) to service_role;

-- 6.8 Consulta resumen del evento para el bot Master Owner.
create or replace function public.rpc_event_summary(p_event_id uuid)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'codes',        (select count(*) from public.access_codes where event_id = p_event_id),
    'codes_used',   (select count(*) from public.access_codes where event_id = p_event_id and first_used_at is not null),
    'paid',         (select count(*) from public.orders where event_id = p_event_id and payment_status='paid'),
    'awaiting',     (select count(*) from public.orders where event_id = p_event_id and payment_status='awaiting_review'),
    'rejected',     (select count(*) from public.orders where event_id = p_event_id and payment_status='rejected'),
    'revenue_usd',  (select coalesce(sum(amount_usd),0) from public.orders where event_id = p_event_id and payment_status='paid'),
    'tickets',      (select count(*) from public.tickets where event_id = p_event_id and status <> 'revoked'),
    'redeemed',     (select count(*) from public.tickets where event_id = p_event_id and status = 'redeemed')
  );
$$;

grant execute on function public.rpc_event_summary(uuid) to service_role;

-- 6.9 Listado de transferencias pendientes para el bot Owner/Admin.
create or replace function public.rpc_pending_transfers(p_event_id uuid default null)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'order_id', o.id,
           'amount_usd', o.amount_usd,
           'reference', o.transfer_reference,
           'receipt_url', o.transfer_receipt_url,
           'created_at', o.created_at,
           'guest', jsonb_build_object(
             'first_name', g.first_name,
             'last_name', g.last_name,
             'email', g.email
           ),
           'event', jsonb_build_object('id', e.id, 'name', e.name)
         ) order by o.created_at asc), '[]'::jsonb)
    from public.orders o
    join public.guests g on g.id = o.guest_id
    join public.events e on e.id = o.event_id
   where o.payment_status = 'awaiting_review'
     and (p_event_id is null or o.event_id = p_event_id);
$$;

grant execute on function public.rpc_pending_transfers(uuid) to service_role;

-- 6.10 Crea una orden gratuita ('complimentary') para invitados especiales.
-- Llamada desde el server Node (N8N → /api/n8n/complimentary-ticket).
create or replace function public.rpc_create_complimentary_order(
  p_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code_id  uuid;
  v_event_id uuid;
  v_guest_id uuid;
  v_order_id uuid;
begin
  select id, event_id, guest_id
    into v_code_id, v_event_id, v_guest_id
  from public.access_codes
  where code = upper(trim(p_code))
    and status = 'active'
  limit 1;

  if v_code_id is null then
    return jsonb_build_object('error','code_not_found_or_inactive');
  end if;

  -- Si ya hay una orden activa (paid o awaiting), no crear duplicado.
  if exists (
    select 1 from public.orders
     where code_id = v_code_id
       and payment_status in ('paid','awaiting_review')
  ) then
    return jsonb_build_object('error','order_already_exists');
  end if;

  insert into public.orders (code_id, event_id, guest_id, amount_usd,
                             payment_method, payment_status, paid_at)
  values (v_code_id, v_event_id, v_guest_id, 0,
          'complimentary', 'paid', now())
  returning id into v_order_id;

  return jsonb_build_object('ok', true, 'order_id', v_order_id,
                            'event_id', v_event_id, 'guest_id', v_guest_id);
end; $$;

grant execute on function public.rpc_create_complimentary_order(text) to service_role;

-- =====================================================================
-- 7. Storage — bucket `receipts` para los comprobantes de transferencia
-- =====================================================================
-- El bucket se crea desde la UI de Supabase (privado, 5MB max).
-- Estas políticas permiten que N8N (service_role) lea/escriba, y que los
-- comprobantes NO sean accesibles por anon directamente.
-- =====================================================================

-- Nota: las políticas de storage se crean sobre storage.objects.
-- Ejecutá estas sentencias SOLO si el bucket 'receipts' ya existe.

do $$
begin
  if exists (select 1 from storage.buckets where id = 'receipts') then
    -- Limpiar políticas previas con el mismo nombre (idempotencia)
    execute 'drop policy if exists "receipts_service_all" on storage.objects';
    execute $p$create policy "receipts_service_all" on storage.objects
              for all to service_role
              using (bucket_id = 'receipts')
              with check (bucket_id = 'receipts')$p$;
  end if;
end $$;

-- -------------------------------------------------------------
-- 8. Datos iniciales (opcional — descomentar para probar)
-- -------------------------------------------------------------
-- insert into public.events (name, description, venue, event_date, price_usd, status)
-- values ('Party House — Opening Night', 'Fiesta de apertura', 'Salón Neón', now() + interval '30 days', 50, 'published');
