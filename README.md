# Party House — Sistema de Boletería

Plataforma para gestionar acceso, pagos y validación de entradas de las fiestas Party House.

> **Arquitectura (abril 2026):** el **server Node** es el backend real
> (captura PayPal, procesa transferencias, firma el JWT del QR, expone el
> panel admin y sirve la landing). **Supabase** es la única fuente de verdad
> (Postgres + Storage + RPCs SECURITY DEFINER). **N8N** quedó reducido a un
> único workflow: el bot de Telegram que genera códigos de acceso con IA.

**N8N corre en un VPS externo:** https://horizon-n8n.8qkrxr.easypanel.host/
(no se levanta N8N local).

---

## Estructura del proyecto

```
party-house-system/
├── landing/                  Frontend estático (dark + neon)
│   ├── index.html            Login por código de invitación (RPC Supabase)
│   ├── evento.html           Bienvenida + pago (PayPal SDK + transferencia)
│   ├── ticket.html           QR en el navegador + botón "Descargar QR"
│   ├── amenidades.html       Amenidades del evento (RPC)
│   ├── validador.html        PWA del staff (login PIN + escaneo QR)
│   ├── admin.html            Panel web del admin (confirmar transferencias)
│   ├── manifest.webmanifest  PWA manifest
│   ├── css/style.css         Línea gráfica
│   └── js/
│       ├── config.js         SUPABASE_URL, ANON_KEY (sin secretos)
│       └── app.js            Cliente Supabase + helpers + sesión
├── server/                   Node.js — backend real
│   ├── server.js             PayPal + transfers + admin + QR download + JWT
│   ├── package.json
│   └── .env.example
├── supabase/
│   ├── schema.sql            Tablas, RLS, RPCs SECURITY DEFINER, storage
│   ├── seed.sql              Evento demo + admin/owner con bcrypt
│   └── README.md
├── n8n/
│   ├── admin-bot-workflow.json   Único workflow activo (IA + Supabase)
│   ├── _archived/                Workflows viejos (referencia histórica)
│   └── README.md
├── docs/
│   ├── deploy.md             Deploy paso a paso en Easypanel
│   └── ui-guide.md           Línea gráfica, paleta, tipografías, componentes
├── Dockerfile
└── docker-compose.yml
```

## Flujo funcional

1. **Admin** habla con el bot de Telegram: *"crea código para Jonathan Pérez,
   jon@x.com, +5255123456"*.
2. **N8N + GPT-4o-mini** parsea el pedido, hace `upsert` en `public.guests`
   e inserta el código en `public.access_codes`. Devuelve por Telegram:
   `JONATHAN-PER-5821` listo para compartir (formato
   `NOMBRE-APEL-####`: 6 letras de nombre, 3 de apellido, 4 dígitos).
3. **Invitado** abre `https://partyhouse.tu-dominio/?c=JONATHAN-PER-5821`.
   La landing llama a `rpc_validate_code` (Supabase anon) y recupera
   nombre, evento, monto y estado de pago.
4. **Landing** muestra bienvenida personalizada + detalle del evento + pago.
5. **Pago — PayPal:**
   - El SDK arranca con el `client_id` expuesto por `/api/public-config`.
   - `createOrder` → `POST /api/paypal/create-order` (server crea la orden
     con el monto real del evento, tomado de la BD).
   - `onApprove` → `POST /api/paypal/capture-order` (server captura con
     `client_secret`, llama a `rpc_create_paypal_order`, firma el JWT,
     llama a `rpc_issue_ticket` y responde `{code, qr_token}`).
   - Redirección a `/ticket.html?c=<code>` con el QR listo.
6. **Pago — Transferencia:**
   - El invitado indica referencia opcional y **sube la foto/PDF del
     comprobante** (máx. 5 MB) directamente en la landing.
   - `POST /api/transfer/submit` (multipart) sube la imagen al bucket
     privado `receipts` de Supabase Storage, genera una URL firmada
     (1 año) y crea la orden `awaiting_review`.
   - El server le manda al admin (vía Telegram Bot API) un `sendPhoto`
     con caption (nombre, código, monto, folio, evento y link al panel).
7. **Admin** recibe la notificación, entra a `/admin.html`, hace login
   y ve la transferencia pendiente con la foto. Con un clic en
   **Confirmar**, el server llama a `createTicketForOrder`, firma el
   JWT y emite el ticket. Acto seguido, **manda un email** al invitado
   (vía SMTP propio del hosting — Roundcube/Postfix) con el QR adjunto
   (`party-house-CODIGO.png`) y un link a `/ticket.html` para
   descargarlo también desde el navegador.
8. **`/ticket.html`** ofrece tres formas de quedarse con el QR:
   - **Descargar QR** (PNG generado por el server vía `/api/qr/:code/download`).
   - **Guardar imagen** (screenshot directo del canvas del navegador).
   - Ver el QR en pantalla para escanearlo en la puerta.
9. **En la puerta,** el staff abre `/validador.html`, hace login con PIN
   contra `/api/staff/login`, escanea el QR y el server verifica la firma
   JWT + marca el ticket como `redeemed` (`/api/tickets/validate`).
10. **Si el invitado vuelve con un código ya pagado** → la landing detecta
    `already_paid` y lo lleva directo a `/ticket.html`.

## ¿Qué hace el server y qué hace N8N?

| Responsabilidad                              | Server Node | N8N (VPS)              |
|----------------------------------------------|-------------|------------------------|
| Servir landing + PWA staff + panel admin     | Sí          | —                      |
| Crear orden PayPal (server-side)             | Sí          | —                      |
| Capturar pago PayPal (`client_secret`)       | Sí          | —                      |
| Upload de boleta a Supabase Storage          | Sí          | —                      |
| Registrar transferencia (`awaiting_review`)  | Sí          | —                      |
| Notificar al admin por Telegram (sendPhoto)  | Sí          | —                      |
| Panel admin para confirmar/rechazar          | Sí          | —                      |
| Email con QR adjunto al confirmar (SMTP propio) | Sí       | —                      |
| Login admin (bcrypt contra `app_users`)      | Sí          | —                      |
| Firmar JWT del QR (`exp = event_date + 48h`) | Sí          | —                      |
| Generar PNG del QR y servirlo                | Sí          | —                      |
| Verificar JWT + marcar ticket usado          | Sí          | —                      |
| Crear códigos de acceso desde Telegram (IA)  | —           | Sí (único workflow)    |

> El invitado recibe el QR por email (SMTP propio) al confirmarse la
> transferencia y también puede descargarlo desde `/ticket.html`.

## Secretos y dónde viven

| Secreto                         | Vive en             | Para qué                                 |
|---------------------------------|---------------------|------------------------------------------|
| `SUPABASE_URL`                  | server, N8N         | Conexión a Supabase                      |
| `SUPABASE_SERVICE_ROLE_KEY`     | server, N8N         | Acceso admin a la BD                     |
| `SUPABASE_ANON_KEY`             | landing (`config.js`) | RPCs anónimas desde el navegador       |
| `JWT_SECRET`                    | server              | Firma + verificación del QR              |
| `PAYPAL_CLIENT_ID`              | server              | Expuesto vía `/api/public-config`        |
| `PAYPAL_CLIENT_SECRET`          | server              | Captura server-side                      |
| `PAYPAL_BASE`                   | server              | `api-m.sandbox.paypal.com` o live        |
| `WHATSAPP_NUMBER`               | server              | (Opcional) referencia, ya no se usa      |
| `BANK_DETAILS`                  | server              | Texto mostrado en la landing             |
| `STAFF_PIN`                     | server              | Login staff (fallback si no hay en BD)   |
| `TELEGRAM_BOT_TOKEN`            | server              | `sendPhoto` al admin en nueva transfer.  |
| `ADMIN_TELEGRAM_IDS`            | server              | IDs de admins que reciben las notifs     |
| `SMTP_HOST` / `SMTP_PORT`       | server              | Servidor SMTP propio (hosting/Roundcube) |
| `SMTP_SECURE`                   | server              | `true` p/ SSL 465 · `false` p/ STARTTLS 587 |
| `SMTP_USER` / `SMTP_PASS`       | server              | Credenciales de la casilla que envía     |
| `MAIL_FROM`                     | server              | Remitente visible (default = `SMTP_USER`)|
| `PUBLIC_BASE_URL`               | server              | URL base para links en emails/Telegram   |
| `RECEIPTS_BUCKET`               | server              | Nombre del bucket privado de Storage     |
| Credencial N8N `PartyHouse Bot` | N8N                 | Bot de Telegram (mismo token que arriba) |
| Credencial N8N `OpenAI Horizon` | N8N                 | GPT-4o-mini para parsear pedidos         |
| Admin ID y Event ID (hardcoded) | N8N workflow        | El JSON trae `7360106479` y el event UUID|

El admin del panel web se autentica con `password_hash` (bcrypt) guardado
en `public.app_users`. El seed incluye:
`admin@partyhouse.example` / `admin123` (cambiar antes de producción).

## Inicio rápido (desarrollo local)

```bash
# 1. Instalar dependencias del servidor
cd server
npm install
cp .env.example .env   # completar con todos los valores (ver .env.example)

# 2. Ejecutar supabase/schema.sql y supabase/seed.sql en el SQL Editor de Supabase

# 3. Configurar landing/js/config.js con SUPABASE_URL y SUPABASE_ANON_KEY
#    (el PAYPAL_CLIENT_ID ya no va acá — lo sirve /api/public-config)

# 4. Levantar el servidor
npm run dev
# Visitar http://localhost:3000
```

Para correr la app con Docker:

```bash
docker compose up --build
# Landing + API + Admin: http://localhost:3000
```

URLs clave:

- `/` — login por código
- `/evento.html` — bienvenida + pago
- `/ticket.html?c=CODIGO` — QR + descarga
- `/admin.html` — panel de confirmación de transferencias
- `/validador.html` — PWA del staff en puerta

## Importar workflow en N8N

1. Entrar a https://horizon-n8n.8qkrxr.easypanel.host/.
2. Importar `n8n/admin-bot-workflow.json` (limpio, sin credencial-IDs).
3. Abrir cada nodo que lo necesite y seleccionar del dropdown:
   - Telegram Trigger, Rechazar, Responder ayuda, Responder con código → `PartyHouse Bot`
   - OpenAI (HTTP) → `OpenAI Horizon` (dropdown *Credential for OpenAI API*)
4. **No se necesitan env vars en N8N**: el workflow trae el admin ID, el
   event UUID y la `service_role` de Supabase hardcodeados. Ver
   `n8n/README.md` para cambiarlos si hace falta.
5. Activar el workflow.

> Los workflows viejos (`paypal-capture`, `transfer-submit`,
> `master-owner-bot`) quedaron en `n8n/_archived/` como referencia.
> **No los importes** en producción.

## Deploy en producción

Ver `docs/deploy.md`. Pasos resumidos:

1. Crear proyecto Supabase y ejecutar `schema.sql` + (opcional) `seed.sql`.
2. Crear el **bucket `receipts`** en Supabase → Storage (privado, 5MB).
3. En el panel del hosting (cPanel / Plesk / Hestia), crear una casilla
   tipo `no-reply@tudominio.com` y anotar:
   - `SMTP_HOST` (ej. `mail.tudominio.com`)
   - `SMTP_PORT` + `SMTP_SECURE` (`465` + `true` para SSL directo, o
     `587` + `false` para STARTTLS)
   - `SMTP_USER` (email completo) y `SMTP_PASS` (la contraseña de la casilla)
   - Opcional: `MAIL_FROM="Party House <no-reply@tudominio.com>"`
4. Desplegar el servicio `app` con el `Dockerfile` en Easypanel.
5. Apuntar el dominio a `app`, setear `PUBLIC_BASE_URL=https://tudominio.com`
   y completar `config.js` con `SUPABASE_URL` + `SUPABASE_ANON_KEY`.
6. Cargar en `.env` del server los secretos: Supabase service role, JWT,
   PayPal, Telegram bot token, admin IDs, credenciales SMTP y bank details.
7. Importar `admin-bot-workflow.json` en N8N y seleccionar manualmente las
   credenciales `PartyHouse Bot` y `OpenAI Horizon` en los 5 nodos.
6. Crear un admin en `public.app_users` con `password_hash` real
   (bcrypt) y acceder a `/admin.html`.
7. Probar end-to-end con PayPal Sandbox.

## Requisitos cumplidos

- [x] Pago online (PayPal capture server-side) **procesado en la landing**
- [x] QR descargable desde `/ticket.html` (PNG y screenshot)
- [x] Transferencia con confirmación manual vía panel admin + WhatsApp
- [x] N8N + IA (GPT-4o-mini) para generar códigos desde Telegram
- [x] Formato de código: `NOMBRE-APEL-####` (ej. `JUAN-PER-5821`)
- [x] Página web para validar QR (`/validador.html` PWA)
- [x] Panel admin integrado en la web (`/admin.html`)
- [x] QR firmado (JWT con expiración = fecha del evento + 48h)
- [x] Supabase como BD (RLS + RPCs SECURITY DEFINER + Storage)
- [x] Deploy con Docker en Easypanel
- [x] Frontend dark + neon con bienvenida personalizada
