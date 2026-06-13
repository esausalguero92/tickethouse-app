# TicketHouseV2 — Análisis Arquitectónico + Plan de Refactorización
**Versión de análisis:** 2.0.0  
**Versión actual del proyecto:** 0.4.0  
**Fecha:** 2026-06-12  
**Roles aplicados:** Software Architect · Security Engineer · PostgreSQL Architect · Supabase Specialist · Node.js Architect · UI/UX Architect · Brand System Designer

---

## 1. ANÁLISIS DE ARQUITECTURA ACTUAL

### 1.1 Stack

| Capa | Tecnología | Estado |
|------|-----------|--------|
| Backend | Node.js 20 + Express (monolito, 1 archivo ~1,200 líneas) | ⚠️ Refactorizar |
| Base de datos | Supabase PostgreSQL + RLS + RPCs SECURITY DEFINER | ✅ Sólido, migrar |
| Pagos | PayPal server-side capture | ✅ Mantener |
| Pagos alt. | Transferencia bancaria manual + foto comprobante | ✅ Mantener |
| Autenticación | JWT (QR) + bcrypt (admin web) + PIN (staff) | ✅ Mantener |
| Email | SMTP propio via nodemailer | ✅ Mantener |
| Notificaciones | Telegram Bot API (sendPhoto al admin) | ✅ Mantener |
| Automatización | N8N en VPS externo (solo bot Telegram con IA) | 🗑️ Eliminar dependencia |
| Storage | Supabase Storage bucket `receipts` | ✅ Mantener |
| Infraestructura | Docker + Easypanel | ✅ Sin cambios |

### 1.2 Modelo de Datos Actual

```
guests          → access_codes → orders → tickets
(1 persona)        (1 código)    (1 compra) (1 entrada)
first_name         JUAN-PER-5821  PayPal/transfer  JWT + QR
last_name                         amount_usd
email
```

**Relaciones críticas (todas 1:1):**
- 1 guest → N access_codes (aunque en práctica es 1:1)
- 1 access_code → 1 order (NOT UNIQUE en schema pero la lógica lo fuerza)
- 1 order → 1 ticket (UNIQUE constraint en `tickets.order_id`)

**Problema central:** El modelo entero está diseñado para 1 persona = 1 entrada. No soporta múltiples entradas por compra.

### 1.3 Flujo Actual

```
Admin (Telegram)
  → N8N + GPT-4o-mini
    → upsert guests
    → insert access_codes (JUAN-PER-5821)
      → Comprador ingresa código en landing
        → PayPal / Transferencia
          → 1 ticket (JWT + QR)
```

### 1.4 Dependencias del Backend

El `server.js` monolito carga:
- `dotenv`, `express`, `cors`, `path`
- `jwt` (jsonwebtoken), `bcryptjs`
- `QRCode`, `PDFDocument` (pdfkit), `multer`
- `nodemailer`
- `@supabase/supabase-js`
- `ws` (websockets para Supabase realtime)

### 1.5 Endpoints Actuales

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/public-config` | PayPal client_id, WhatsApp |
| GET | `/api/transfer/info` | Datos bancarios |
| POST | `/api/paypal/create-order` | Crear orden PayPal |
| POST | `/api/paypal/capture-order` | Capturar pago + emitir ticket |
| POST | `/api/transfer/submit` | Subir comprobante + crear orden |
| POST | `/api/admin/login` | Login admin (bcrypt) |
| GET | `/api/admin/transfers/pending` | Transferencias pendientes |
| POST | `/api/admin/transfers/:id/confirm` | Confirmar + emitir ticket |
| POST | `/api/admin/transfers/:id/reject` | Rechazar transferencia |
| POST | `/api/admin/complimentary/:code` | Ticket gratis (admin) |
| POST | `/api/admin/test-email` | Test SMTP |
| GET | `/api/qr/:code/download` | Descargar PDF del ticket |
| POST | `/api/n8n/complimentary-ticket` | Ticket gratis (N8N webhook) |
| POST | `/api/staff/login` | Login staff (PIN) |
| POST | `/api/tickets/validate` | Validar QR en puerta |
| GET | `/api/health` | Health check |

### 1.6 RPCs Supabase (SECURITY DEFINER)

| RPC | Descripción |
|-----|-------------|
| `rpc_validate_code(text)` | Valida código personal → guest + evento |
| `rpc_get_amenities(uuid)` | Amenidades del evento |
| `rpc_get_my_ticket(text)` | Ticket del invitado por código |
| `rpc_create_transfer_order(...)` | Crear orden transferencia |
| `rpc_create_paypal_order(...)` | Crear orden PayPal paid |
| `rpc_issue_ticket(...)` | Emitir ticket (JWT) |
| `rpc_review_order(...)` | Aprobar/rechazar (bot) |
| `rpc_event_summary(uuid)` | Resumen para bot |
| `rpc_pending_transfers(uuid)` | Lista pendientes |
| `rpc_create_complimentary_order(text)` | Orden gratis |

---

## 2. RIESGOS IDENTIFICADOS

### 2.1 Riesgos de Arquitectura

| # | Riesgo | Severidad | Mitigación |
|---|--------|-----------|------------|
| R1 | server.js monolito — una sola falla afecta todo | ALTA | Separar en capas (services/routes/middleware) |
| R2 | Sin rate limiting — DoS trivial | ALTA | Implementar express-rate-limit por ruta |
| R3 | Sin Helmet — headers HTTP inseguros | MEDIA | Agregar helmet() como primer middleware |
| R4 | Sin sanitización de inputs — SQLi/XSS latente | ALTA | Implementar validator/express-validator |
| R5 | JWT_SECRET con fallback débil en producción | ALTA | Validar en boot, fallar si no está seteado |
| R6 | `/api/qr/:code/download` — IDOR por código predecible | MEDIA | Usar token firmado para descargas |
| R7 | Stack traces en respuestas de error (algunos endpoints) | MEDIA | Error handler centralizado |
| R8 | N8N_WEBHOOK_SECRET warning pero no falla en boot | BAJA | Forzar en prod, warn en dev |
| R9 | No hay CSRF protection en rutas admin | MEDIA | Tokens cortos + SameSite en cookies |
| R10 | `app_users` con rol 'staff' sin password_hash = PIN solo | BAJA | Aceptable para staff en puerta |

### 2.2 Riesgos de Migración

| # | Riesgo | Severidad | Mitigación |
|---|--------|-----------|------------|
| M1 | `access_codes` tiene FK en `orders` — eliminar en cascada rompe órdenes existentes | ALTA | Migración aditiva: agregar nuevas tablas, no eliminar viejas |
| M2 | `tickets.order_id` UNIQUE — impide múltiples tickets por orden | ALTA | ALTER TABLE para quitar UNIQUE, agregar columna correlative_code |
| M3 | Sequence correlativo — race condition si se genera desde app layer | ALTA | Usar PostgreSQL SEQUENCE nativo dentro de RPC SECURITY DEFINER |
| M4 | Aforo (capacity) ya existe en `events` pero sin enforcement backend | MEDIA | Agregar validación en RPC de creación de orden |
| M5 | RPCs actuales retornan `guest_id`/`code_id` — el nuevo modelo no los tiene | ALTA | Crear nuevas RPCs paralelas, no modificar las existentes hasta migrar frontend |

### 2.3 Riesgos de Regresión

| # | Qué puede romperse | Causa | Protección |
|---|-------------------|-------|------------|
| REG1 | Admin panel login | Cambio en `app_users` | No tocar tabla ni endpoint |
| REG2 | Staff validator (QR) | Cambio en `tickets` schema | Mantener `qr_token` + `status` columns |
| REG3 | SMTP email (confirmación transfer) | Refactor de emailService | Tests manuales pre-deploy |
| REG4 | Telegram notifications | Refactor telegramService | Tests manuales pre-deploy |
| REG5 | PayPal capture | Refactor paymentRoutes | PayPal API no cambia |
| REG6 | Docker build | Cambio de estructura de carpetas | Actualizar Dockerfile |

---

## 3. PLAN DE IMPLEMENTACIÓN

### Fase 1 — Base de Datos (aditiva, no destructiva)
1. Crear `supabase/schema-v2.sql` con nuevas tablas
2. Crear `supabase/migration-v1-to-v2.sql` (ALTER statements)
3. Crear `supabase/seed-v2.sql` con datos de prueba nuevos

### Fase 2 — Backend Refactorizado
1. Crear nueva estructura de carpetas dentro de `server/`
2. Implementar `config/env.js` con validación en boot
3. Implementar `middleware/security.js` (helmet, rate-limit, sanitize)
4. Implementar `middleware/auth.js` (requireAdmin, requireStaff)
5. Implementar `middleware/errorHandler.js` (centralizado)
6. Implementar `services/` (Ticket, Pdf, Email, Qr, Telegram)
7. Implementar `routes/` (public, payment, admin, staff, download)
8. Actualizar `server.js` como entry point limpio

### Fase 3 — Design System
1. Crear `landing/css/tokens.css` (design tokens)
2. Crear `landing/css/components.css` (botones, cards, formularios)
3. Crear `landing/css/animations.css` (glows, transiciones)

### Fase 4 — Frontend
1. `landing/index.html` — ingreso de código PH787
2. `landing/evento.html` — info evento + formulario + pago
3. `landing/ticket.html` — confirmación + descarga
4. `landing/admin.html` — panel admin actualizado
5. `landing/validador.html` — staff PWA + validación manual

### Fase 5 — Infraestructura
1. Actualizar `server/package.json` (agregar helmet, express-rate-limit, express-validator)
2. Actualizar `server/.env.example`
3. Actualizar `Dockerfile` si hay cambios de estructura
4. Actualizar `README.md`

---

## 4. MODELO DE DATOS PROPUESTO

### 4.1 Cambios en tabla `events` (ALTER)

```sql
-- Agregar columnas nuevas
event_code       TEXT UNIQUE    -- PH787 (código de acceso público al evento)
max_per_order    INT DEFAULT 5  -- máximo entradas por compra
tickets_sold     INT DEFAULT 0  -- contador atómico (actualizado por trigger)
```

### 4.2 Nueva tabla: `buyers`

Reemplaza `guests` para el nuevo flujo de compra libre.

```sql
CREATE TABLE public.buyers (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    full_name       TEXT NOT NULL,
    email           TEXT NOT NULL,
    phone           TEXT,
    age_verified    BOOLEAN NOT NULL DEFAULT FALSE,
    terms_accepted  BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 4.3 Rediseño de tabla `orders`

```sql
-- Nuevas columnas (ALTER)
buyer_id         UUID REFERENCES public.buyers(id)    -- comprador (nuevo)
buyer_name       TEXT                                  -- desnormalizado (resiliente)
buyer_email      TEXT                                  -- desnormalizado
quantity         INT NOT NULL DEFAULT 1                -- entradas compradas
event_code_id    UUID REFERENCES public.event_codes(id)  -- código evento usado

-- guest_id se mantiene como NULLABLE para compatibilidad con v1
-- code_id se mantiene como NULLABLE para compatibilidad con v1
```

### 4.4 Rediseño de tabla `tickets`

```sql
-- Cambios (ALTER)
-- Eliminar UNIQUE en order_id (permite N tickets por orden)
-- Agregar:
correlative_code  TEXT UNIQUE NOT NULL  -- TH-PH001, TH-PH002...
correlative_num   BIGINT NOT NULL       -- número puro de la sequence

-- guest_id se mantiene como NULLABLE
```

### 4.5 Nueva tabla: `event_codes`

```sql
CREATE TABLE public.event_codes (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_id    UUID NOT NULL REFERENCES public.events(id),
    code        TEXT NOT NULL UNIQUE,   -- PH787
    active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 4.6 Sequence correlativo

```sql
CREATE SEQUENCE IF NOT EXISTS public.ticket_correlative_seq START 1 INCREMENT 1 NO CYCLE;

-- Función para generar código correlativo atómico
CREATE OR REPLACE FUNCTION public.next_ticket_code()
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE v_num BIGINT;
BEGIN
    SELECT nextval('public.ticket_correlative_seq') INTO v_num;
    RETURN 'TH-PH' || LPAD(v_num::TEXT, 3, '0');
END; $$;
```

### 4.7 Diagrama del nuevo modelo

```
event_codes ──────────────────────────────────── events
  code: PH787                                     event_code: PH787 (mirror)
  event_id                                        capacity: 300
                                                  max_per_order: 5
                                                  tickets_sold: 127

buyers ───────────────────────────────────────── orders
  full_name: "Juan Pérez"        buyer_id ──────→  quantity: 3
  email: juan@x.com              buyer_name         amount_usd: 150.00
  age_verified: true             buyer_email        payment_method
  terms_accepted: true           event_code_id      payment_status
                                                    paypal_order_id
                                                    transfer_receipt_url

orders ────────────────────────────────────────── tickets (1 order → N tickets)
  id                             order_id ──────→  correlative_code: TH-PH001
                                                   correlative_code: TH-PH002
                                                   correlative_code: TH-PH003
                                                   qr_token (JWT firmado)
                                                   status: issued|redeemed|revoked
```

---

## 5. NUEVAS RPCs SUPABASE

| RPC Nueva | Descripción |
|-----------|-------------|
| `rpc_get_event_by_code(text)` | Info del evento por código PH787 |
| `rpc_check_capacity(uuid, int)` | Verifica disponibilidad (capacity - tickets_sold >= qty) |
| `rpc_create_buyer(...)` | Crea buyer + valida age/terms |
| `rpc_create_order_v2(...)` | Crea orden con qty, valida aforo atómicamente |
| `rpc_issue_tickets_bulk(...)` | Genera N tickets con correlativos atómicos |
| `rpc_get_order_tickets(uuid)` | Tickets de una orden (para /ticket.html) |
| `rpc_validate_ticket_by_correlative(text)` | Validar por TH-PH001 |

**RPCs mantenidas (sin cambios):**
- `rpc_get_amenities` ✅
- `rpc_review_order` ✅ (admin bot, si se mantiene N8N)
- `rpc_event_summary` ✅
- `rpc_pending_transfers` ✅

---

## 6. NUEVA ARQUITECTURA BACKEND

```
server/
├── server.js                    ← Entry point (~60 líneas)
├── package.json                 ← + helmet, express-rate-limit, express-validator
├── config/
│   └── env.js                   ← Validación de env vars en boot (falla si faltan)
├── db/
│   └── supabase.js              ← Singleton del cliente Supabase
├── middleware/
│   ├── security.js              ← helmet, cors, rate-limit, sanitize
│   ├── auth.js                  ← requireAdmin, requireStaff
│   └── errorHandler.js          ← Error centralizado (sin stack en prod)
├── services/
│   ├── TicketService.js         ← Lógica de negocio: crear tickets bulk, validar
│   ├── PdfService.js            ← Generar PDF buffer (invitación premium)
│   ├── QrService.js             ← Generar QR buffer, firmar JWT
│   ├── EmailService.js          ← Enviar email (múltiples PDFs adjuntos)
│   └── TelegramService.js       ← Notificaciones al admin
├── routes/
│   ├── publicRoutes.js          ← GET evento por código, config pública
│   ├── paymentRoutes.js         ← PayPal + transferencia
│   ├── adminRoutes.js           ← Panel admin (login, transferencias, complimentary)
│   ├── staffRoutes.js           ← Login staff + validación QR
│   └── downloadRoutes.js        ← Descarga segura de PDFs (token firmado)
└── utils/
    ├── validation.js            ← Schemas de validación (express-validator)
    └── asyncHandler.js          ← Wrapper try/catch para rutas async
```

---

## 7. NUEVA ARQUITECTURA FRONTEND

```
landing/
├── index.html                   ← Ingreso código PH787 (puerta de entrada)
├── evento.html                  ← Info evento + formulario + pago
├── ticket.html                  ← Confirmación + descarga PDFs
├── admin.html                   ← Panel admin (compras, cantidades, estado)
├── validador.html               ← PWA staff (QR + correlativo manual)
├── manifest.webmanifest
├── css/
│   ├── tokens.css               ← DESIGN SYSTEM (paleta, espaciados, tipografía)
│   ├── components.css           ← Botones, cards, forms, modals
│   └── animations.css           ← Glows, transiciones, keyframes
└── js/
    ├── config.js                ← SUPABASE_URL + ANON_KEY (sin secretos)
    └── app.js                   ← Helpers compartidos
```

---

## 8. DESIGN SYSTEM — PARTY HOUSE BRAND

### 8.1 Paleta "Social Neon"

```css
:root {
  /* Core */
  --ph-bg:        #050505;   /* 70% del espacio visual */
  --ph-blue:      #1D4FFF;   /* Electric Blue — acción principal */
  --ph-purple:    #5D2D91;   /* Deep Purple — acento, gradientes */
  --ph-magenta:   #FF2E9A;   /* Neon Magenta — highlights, CTA hover */
  --ph-white:     #FFFFFF;
  --ph-text-mute: #6B7280;

  /* Glow system (blur suave, nunca gaming) */
  --glow-blue:    0 0 24px rgba(29, 79, 255, 0.35);
  --glow-purple:  0 0 24px rgba(93, 45, 145, 0.35);
  --glow-magenta: 0 0 24px rgba(255, 46, 154, 0.35);
  --glow-subtle:  0 0 12px rgba(29, 79, 255, 0.18);

  /* Typography */
  --font-display: 'Bebas Neue', 'Arial Narrow', Impact, sans-serif;
  --font-body:    'Space Grotesk', system-ui, -apple-system, sans-serif;

  /* Spacing scale */
  --space-1: 4px;  --space-2: 8px;  --space-3: 12px;
  --space-4: 16px; --space-6: 24px; --space-8: 32px;
  --space-12: 48px; --space-16: 64px;

  /* Borders */
  --radius-sm: 4px; --radius-md: 8px; --radius-lg: 16px;
  --border-subtle: 1px solid rgba(255,255,255,0.08);
  --border-neon: 1px solid rgba(29,79,255,0.5);
}
```

### 8.2 Componentes clave

**Botón primario:**
```css
.btn-primary {
  background: transparent;
  border: 1px solid var(--ph-blue);
  color: var(--ph-white);
  font-family: var(--font-display);
  letter-spacing: 0.15em;
  transition: all 0.25s ease;
}
.btn-primary:hover {
  border-color: var(--ph-purple);
  box-shadow: var(--glow-blue);
  transform: translateY(-1px);
}
.btn-primary:active {
  border-color: var(--ph-magenta);
  box-shadow: var(--glow-magenta);
}
```

**Card (objeto flotando en oscuridad):**
```css
.ph-card {
  background: rgba(255,255,255,0.02);
  border: 1px solid rgba(255,255,255,0.06);
  backdrop-filter: blur(8px);
  box-shadow: 0 8px 32px rgba(0,0,0,0.5);
}
```

### 8.3 PDF — Invitación Premium (no boleto de transporte)
- Fondo: `#050505`
- Header: "PARTY HOUSE" en Bebas Neue, 52pt, blanco
- QR: ocupar el 60% del espacio visual, centrado
- Correlativo (`TH-PH001`): visible pero no dominante, gris claro
- Footer: "FOR THOSE WHO KNOW." en DancingScript
- Sin bordes de corte, sin logos de banco, sin aspecto de factura

### 8.4 Email — "Tu acceso está confirmado"
- Subject: `✦ Tu acceso a [EVENTO] está confirmado`
- Hero text: "ACCESO CONFIRMADO" (no "Compra procesada")
- Adjuntos: `ticket-TH-PH001.pdf`, `ticket-TH-PH002.pdf`...
- CTA: "VER MIS ENTRADAS" (no "Ver comprobante")
- Paleta: `#050505` background, blanco texto

---

## 9. SEGURIDAD — CAMBIOS OBLIGATORIOS

### 9.1 Nuevas dependencias
```bash
npm install helmet express-rate-limit express-validator
```

### 9.2 Middleware stack (orden importa)
```
1. helmet()           → headers HTTP seguros
2. cors(whitelist)    → solo dominios propios
3. rateLimiter       → 100 req/15min global, 5/min en /api/paypal/*
4. express.json()    → con límite 512kb
5. sanitize()        → strip HTML de todos los string inputs
6. routes...
7. errorHandler()    → 404 + 500 centralizados
```

### 9.3 Validaciones obligatorias por endpoint

| Endpoint | Validaciones |
|----------|-------------|
| `/api/event/:code` | code: 3-20 chars, alphanum-guion |
| `/api/payment/create-intent` | full_name, email, quantity (1-5), age_verified, terms_accepted |
| `/api/paypal/create-order` | order_intent_id (UUID), quantity |
| `/api/transfer/submit` | file: jpg/png/pdf, max 5MB; order_intent_id |
| `/api/admin/login` | user: email format, password: min 8 chars |
| `/api/staff/login` | pin: 4-8 digits |
| `/api/tickets/validate` | qr: string, max 1000 chars |

### 9.4 Protecciones adicionales
- **IDOR**: Descargas de PDFs usan JWT firmado con `oid` (order ID), expira en 24h
- **Replay**: JWT del QR incluye `jti` (JWT ID) — validar que no se ha usado
- **Path Traversal**: multer con whitelist de mime types
- **Injection**: Toda consulta a Supabase usa cliente JS (parameterized)
- **JWT Tampering**: `verifyJwt` falla silenciosamente, log + reject
- **Aforo race condition**: Validación de capacity dentro de RPC PostgreSQL (atómica)
- **Logs**: Structured logging con timestamps, IP, user-agent (sin datos sensibles)

---

## 10. ESTRATEGIA DE MIGRACIÓN (sin downtime)

### Paso 1 — Preparar BD (backward compatible)
```sql
-- Ejecutar schema-v2.sql:
-- Agrega columnas a tablas existentes (event_code, max_per_order en events)
-- Crea tablas nuevas (buyers, event_codes)
-- Crea sequence ticket_correlative_seq
-- Crea nuevas RPCs (nombres distintos, no toca las existentes)
-- Quita UNIQUE en tickets.order_id (permite N tickets por orden)
-- Agrega correlative_code a tickets
```

### Paso 2 — Deploy backend v2
- El nuevo backend usa las nuevas RPCs y tablas
- Los endpoints de admin/staff no cambian (sin afectar producción activa)

### Paso 3 — Deploy frontend v2
- Nuevas landing pages usan nuevo flujo

### Paso 4 — Limpieza (post-estabilización, semana 2+)
- Archivar RPCs v1 no usadas
- Evaluar si mantener tabla `guests` y `access_codes` como histórico

---

## 11. CASOS DE PRUEBA CRÍTICOS

### Flujo compra libre
- [ ] Código inválido → error claro
- [ ] Evento sold out → bloqueo
- [ ] Cantidad 0 o > max_per_order → rechazo
- [ ] Sin aceptar edad → rechazo (frontend + backend)
- [ ] Sin aceptar términos → rechazo (frontend + backend)
- [ ] Email inválido → rechazo
- [ ] Compra exitosa PayPal → N tickets con correlativos únicos
- [ ] Compra exitosa PayPal → email con N PDFs adjuntos
- [ ] Doble captura PayPal → idempotente (no duplicar)

### Concurrencia / aforo
- [ ] 2 compras simultáneas que llenan aforo → solo 1 pasa, la otra rechazada
- [ ] Correlativo nunca se repite bajo carga concurrente

### Validación en puerta
- [ ] QR válido → verde, marcar como redeemed
- [ ] QR ya usado → rojo, mostrar hora de redención
- [ ] QR inválido (tampered) → rojo, inválido
- [ ] Correlativo TH-PH001 manual → verde
- [ ] Correlativo inexistente → no encontrado

### Seguridad
- [ ] Rate limit en `/api/paypal/*` (> 5 req/min → 429)
- [ ] Admin login con password erróneo → 401
- [ ] Token expirado → 401
- [ ] IDOR: intentar descargar PDF con order_id de otro usuario → 401
- [ ] Archivo malicioso en upload → 415

---

## 12. NOTAS PARA N8N

Con el nuevo modelo, N8N pierde su función principal (crear invitados y códigos).  
**Se puede eliminar completamente** si no se quiere mantener el bot de Telegram para generación de códigos.

Si se quiere mantener para administración (ej. bot de consultas, resúmenes):
- El workflow `admin-bot-workflow.json` puede adaptarse para mostrar estadísticas del evento
- El endpoint `/api/n8n/complimentary-ticket` puede migrarse a un `/api/admin/complimentary-ticket` standard

**Recomendación:** eliminar dependencia de N8N para el flujo principal. Mantener como herramienta opcional de admin.

---

*Fin del análisis. Proceder con implementación en el orden de fases definido.*
