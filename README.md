# Party House — Sistema de Boletería v2

Plataforma para gestionar acceso, pagos y validación de entradas de las fiestas Party House.

> **Arquitectura v2.0 (junio 2026):** el **server Node** es el backend real
> (captura PayPal, procesa transferencias, firma el JWT del QR con código
> correlativo, emite N entradas por orden, expone el panel admin y sirve la
> landing). **Supabase** es la única fuente de verdad (Postgres + Storage +
> RPCs SECURITY DEFINER + SEQUENCE atómica). N8N ya no gestiona invitados
> individuales — el nuevo modelo es **venta directa**: cualquiera puede
> comprar con código de evento (ej. `PH787`).

**N8N corre en un VPS externo:** https://horizon-n8n.8qkrxr.easypanel.host/
(no se levanta N8N local).

## Cambios v2.0

- **Eliminado:** flujo individual Telegram → N8N → GPT → código de invitado
- **Nuevo:** código de evento público (`PH787`) → landing → compra → N entradas
- **Nuevo:** modelo Orden → N Tickets con códigos correlativos (`TH-PH001`, `TH-PH002`…)
- **Nuevo:** capacidad máxima por evento (SOLD OUT automático)
- **Nuevo:** límite configurable por compra (default: 5 entradas)
- **Nuevo:** QR firmado individualmente por entrada (JWT con correlativo)
- **Nuevo:** PDF premium por entrada (diseño Party House)
- **Nuevo:** descarga segura por token (URLs firmadas, no predecibles)
- **Nuevo:** validador soporta código correlativo manual (`TH-PH001`)
- **Nuevo:** panel admin muestra pedidos, cantidades, correlativos, redenciones
- **Nuevo:** arquitectura por capas (Service Layer, Repository, Factory, Middleware)
- **Nuevo:** Helmet, rate limiting, sanitización, validación estricta
- **Nuevo:** design system centralizado (tokens.css → components.css → animations.css)

---

## Estructura del proyecto

```
TicketHouseV2/
├── landing/                        Frontend estático — Party House Brand System
│   ├── index.html                  Entrada: usuario ingresa código PH787
│   ├── evento.html                 Info del evento + formulario + PayPal/transferencia
│   ├── ticket.html                 Confirmación: QR por entrada + descarga PDF
│   ├── admin.html                  Panel admin: pedidos, entradas, transferencias
│   ├── validador.html              PWA staff: escaneo QR + validación manual correlativo
│   ├── manifest.webmanifest        PWA manifest
│   ├── css/
│   │   ├── tokens.css              Design system centralizado (colores, tipografía, spacing)
│   │   ├── components.css          Componentes reutilizables (botones, cards, formularios)
│   │   └── animations.css          Keyframes, glows, transiciones
│   └── js/
│       ├── config.js               SUPABASE_URL, ANON_KEY (sin secretos)
│       └── app.js                  Helpers compartidos (api, Session, formatDate, renderQR…)
├── server/                         Node.js — backend v2.0
│   ├── server.js                   Entry point (~60 líneas, monta rutas)
│   ├── package.json                v2.0.0 + helmet, express-rate-limit, express-validator
│   ├── .env.example                Variables documentadas
│   ├── config/
│   │   └── env.js                  Validación fail-fast de variables de entorno al arranque
│   ├── db/
│   │   └── supabase.js             Singleton del cliente Supabase
│   ├── middleware/
│   │   ├── security.js             Helmet, rate limiters, sanitización
│   │   ├── auth.js                 requireAdmin, requireStaff (JWT)
│   │   └── errorHandler.js         Manejo centralizado de errores
│   ├── services/
│   │   ├── TicketService.js        Orquesta emisión atómica de N entradas
│   │   ├── QrService.js            JWT por entrada + token de descarga
│   │   ├── PdfService.js           PDF premium por entrada (PDFKit)
│   │   ├── EmailService.js         Email con N PDFs adjuntos (nodemailer)
│   │   └── TelegramService.js      Notificación foto al admin
│   └── routes/
│       ├── publicRoutes.js         GET /api/event/:code, /api/public-config, /health
│       ├── paymentRoutes.js        /api/payment/intent, /api/paypal/*, /api/transfer/submit
│       ├── adminRoutes.js          /api/admin/* (login, pedidos, confirmar, rechazar)
│       ├── staffRoutes.js          /api/staff/login, /api/tickets/validate*
│       └── downloadRoutes.js       /api/download/order/:token, /api/download/ticket/:token/:cor
├── supabase/
│   ├── schema-v2.sql               Schema v2 completo (tablas, SEQUENCE, triggers, RPCs)
│   ├── schema-v2-patch.sql         RPCs adicionales (rpc_reserve_correlatives, rpc_issue_tickets_with_correlativos)
│   ├── seed-v2.sql                 Datos de prueba v2 (evento PH787, 3 órdenes, 3 tickets)
│   └── schema.sql                  Schema v1 (referencia histórica — no borrar)
├── ANALISIS-REFACTOR-V2.md         Plan técnico completo (análisis, riesgos, migraciones)
├── Dockerfile                      Multi-stage (deps + runner, usuario sin privilegios)
└── docker-compose.yml
```

## Flujo funcional v2

1. **Comprador** abre `https://partyhouse.com` e ingresa `PH787`.
2. **`/api/event/PH787`** valida el código y devuelve info del evento (nombre, fecha, lugar, precio, disponibilidad).
3. **Landing `evento.html`** muestra la info + formulario: nombre completo, email, cantidad (1–5), mayoría de edad ✓, T&C ✓.
4. **`POST /api/payment/intent`** crea la orden en BD con estado `pending` (validación completa server-side, incluyendo capacidad y checkboxes).
5. **Pago — PayPal:**
   - `POST /api/paypal/create-order` → server crea orden PayPal con el monto real (nunca desde el cliente).
   - `onApprove` → `POST /api/paypal/capture-order` → server captura, llama a `TicketService.issueTickets()`.
6. **Pago — Transferencia:**
   - Comprador sube foto/PDF del comprobante + referencia.
   - `POST /api/transfer/submit` (multipart) → sube al bucket `receipts`, notifica al admin por Telegram (`sendPhoto`).
   - Admin entra a `/admin.html`, revisa y confirma → `TicketService.issueTickets()`.
7. **`TicketService.issueTickets()`** en un solo flujo atómico:
   - `rpc_reserve_correlatives(N)` → reserva N correlativos via PostgreSQL SEQUENCE (atómico, sin colisiones).
   - `generateTicketTokens()` → N JWTs firmados, cada uno con su correlativo y `jti` anti-replay.
   - `rpc_issue_tickets_with_correlativos()` → inserta N tickets en BD (transacción atómica, idempotente).
   - `generateTicketPdf()` × N en paralelo → N PDFs premium.
   - `generateDownloadToken()` → JWT de descarga con expiración 24h.
   - `sendConfirmationEmail()` (fire-and-forget) → email con N PDFs adjuntos, asunto "Tu acceso está confirmado".
8. **`/ticket.html?ot=<token>`** muestra las N entradas: QR individual, código correlativo, botón `⬇ PDF` por entrada.
9. **En la puerta,** el staff abre `/validador.html` (PWA), hace login con PIN, escanea el QR con la cámara.
   - Server verifica JWT: firma → tipo → correlativo → estado → no repetición.
   - También acepta código manual `TH-PH001` por si el QR no lee.
   - Estados claros en pantalla: VÁLIDA / YA USADA / INVÁLIDA / NO ENCONTRADA con vibración diferenciada.

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
# 1. Clonar y entrar al proyecto
cd TicketHouseV2

# 2. Instalar dependencias del servidor
cd server && npm install

# 3. Configurar variables de entorno
cp .env.example .env   # Completar TODOS los valores obligatorios

# 4. Aplicar schema v2 en Supabase
#    Ejecutar en orden en Supabase SQL Editor:
#    - supabase/schema-v2.sql
#    - supabase/schema-v2-patch.sql
#    - supabase/seed-v2.sql  (opcional — datos de prueba)

# 5. Configurar landing/js/config.js
#    Solo SUPABASE_URL y SUPABASE_ANON_KEY (anon key, no service_role)

# 6. Levantar el servidor
npm run dev
# API + landing disponibles en http://localhost:3000
```

Con Docker:

```bash
docker compose up --build
# http://localhost:3000
```

URLs principales:

| URL | Descripción |
|-----|-------------|
| `/` | Entrada: ingresa código `PH787` |
| `/evento.html?c=PH787` | Info del evento + formulario + pago |
| `/ticket.html?ot=<token>` | Confirmación + QR por entrada + descarga PDF |
| `/admin.html` | Panel admin (pedidos, entradas, transferencias) |
| `/validador.html` | PWA staff en puerta (QR + código correlativo) |
| `/api/health` | Health check |

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

## Seguridad implementada

- **NUNCA** se confía en datos del cliente para precios, capacidad o estados
- **Correlativo atómico:** PostgreSQL SEQUENCE via RPC — imposible colisión
- **JWT por entrada:** `jti` único anti-replay, correlativo en payload, `t` type claim
- **Descarga segura:** token firmado (`t: 'ph.download'`, 24h) — URLs no predecibles
- **Helmet** con CSP configurado
- **Rate limiting:** global (200/15min), payment (8/1min), purchase (5/1min), auth (10/15min)
- **Sanitización:** deep XSS strip en todos los inputs
- **Validación:** express-validator con escape + backend independiente del frontend
- **Sin stack traces** en respuestas de producción
- **Logs auditables** con timestamp, IP, método, path, status
- **Admin/Staff tokens** validados en cada request (no cookies, no sessions)
- Protección IDOR, Path Traversal, Injection en todas las rutas

## Requisitos v2 cumplidos

- [x] Venta directa con código de evento (`PH787`) — sin invitaciones individuales
- [x] Formulario obligatorio: nombre, email, cantidad, mayoría de edad, T&C
- [x] Validación frontend Y backend de checkboxes — no se puede bypassear
- [x] Modelo Orden → N Tickets con correlativos atómicos (`TH-PH001`, `TH-PH002`…)
- [x] Capacidad máxima por evento — SOLD OUT automático, backend bloquea
- [x] Límite de 5 entradas por compra (configurable)
- [x] JWT individual por entrada con QR
- [x] PDF premium por entrada (Party House brand)
- [x] Email: "Acceso Confirmado" con N PDFs adjuntos (un email, todos los tickets)
- [x] Descarga segura por token firmado (no URLs predecibles)
- [x] PayPal server-side capture (mantenido)
- [x] Transferencia con upload + Telegram (mantenido)
- [x] Panel admin: pedidos, cantidades, correlativos, redenciones
- [x] Validador PWA: QR por cámara + código manual (`TH-PH001`)
- [x] Estados del validador: VÁLIDA / YA USADA / INVÁLIDA / NO ENCONTRADA
- [x] Arquitectura por capas (Service, Repository, Middleware, Factory)
- [x] Design System centralizado (tokens.css → Party House Social Neon)
- [x] Supabase como BD (RLS + SEQUENCE + RPCs SECURITY DEFINER + Storage)
- [x] Deploy con Docker multi-stage en Easypanel
