# Deploy — Party House en Easypanel

## Arquitectura

```
                          Landing estática
                          + PWA validador
                          + /admin.html
Usuario ── HTTPS ──► [Easypanel · app (Node.js)]
                              │
                              │ service_role
                              ▼
                        [Supabase Cloud]
                        (Postgres + Storage + RPCs)
                              ▲
                              │ service_role
Admin ── Telegram ──►  [Easypanel · N8N VPS]
                       horizon-n8n.8qkrxr.easypanel.host
                       └── admin-bot (único workflow)
```

El **server Node** es el backend real: captura PayPal, registra
transferencias, valida QRs, firma los JWTs, sirve el panel admin y la
landing. **N8N** solo corre el workflow del bot admin para generar
códigos de acceso con IA y escribirlos en Supabase.

## 1) Requisitos previos

- VPS con Easypanel instalado (idealmente el mismo donde vive N8N).
- Dominio apuntado al VPS (ej. `partyhouse.tu-dominio.com`).
- Proyecto Supabase creado (ver `supabase/README.md`).
- 1 token de bot de Telegram (creado con @BotFather para los admins).
- Cuenta PayPal Developer (app sandbox + app live: `client_id` y `client_secret`).
- `OPENAI_API_KEY` para el parseo del bot admin con GPT-4o-mini.
- Un número de WhatsApp donde los invitados van a enviar el comprobante
  de transferencia (puede ser el mismo del admin).

## 2) Desplegar el servicio `app`

En Easypanel → Project **party-house** → **New service → App**:

- **Source:** Git (tu repositorio con `party-house-system/`) o Upload.
- **Build:** Dockerfile (raíz del proyecto).
- **Port:** `3000`.
- **Environment variables:** ver sección 3.
- **Domain:** `partyhouse.tu-dominio.com` — Easypanel gestiona Let's Encrypt.

## 3) Variables de entorno del servicio `app`

```
PORT=3000

# Supabase
SUPABASE_URL=https://<proyecto>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...

# JWT (firma el QR; solo vive en el server)
JWT_SECRET=<64 hex — generar con el snippet de abajo>

# PayPal
PAYPAL_BASE=https://api-m.sandbox.paypal.com      # o https://api-m.paypal.com en live
PAYPAL_CLIENT_ID=<client_id>
PAYPAL_CLIENT_SECRET=<client_secret>
PAYPAL_CURRENCY=USD

# WhatsApp + datos bancarios (se muestran al invitado en la landing)
WHATSAPP_NUMBER=+5255123456789
BANK_DETAILS=Banco Ejemplo · CLABE 012345678901234567 · Titular Party House SA

# Staff PIN de fallback (si no cargaste app_users con pin en BD)
STAFF_PIN=1234
```

Generar `JWT_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> **Ojo:** a diferencia de la arquitectura anterior, `JWT_SECRET` ya no
> se comparte con N8N. El server es el único que firma y verifica.

## 4) Configurar la landing (`landing/js/config.js`)

```javascript
window.PH_CONFIG = {
  SUPABASE_URL: "https://<proyecto>.supabase.co",
  SUPABASE_ANON_KEY: "<anon-key>"
};
```

Eso es todo lo que necesita el frontend. El `PAYPAL_CLIENT_ID`, el número
de WhatsApp y los datos bancarios los entrega el server en tiempo real
vía `/api/public-config` y `/api/transfer/info`, así que no hay que
hardcodearlos en el bundle.

## 5) Crear el admin en Supabase

El panel `/admin.html` se autentica contra `public.app_users` con bcrypt.
Tenés dos caminos:

**a) Seed de demo** — corré `supabase/seed.sql` y usá:

```
Email:    admin@partyhouse.example
Password: admin123
```

Sirve para probar; **cambialo antes de producción**.

**b) Crear el admin real:**

```bash
# Generar el hash con bcrypt (node.js):
node -e "console.log(require('bcryptjs').hashSync('<contraseña>', 10))"
```

Luego en el SQL Editor de Supabase:

```sql
insert into public.app_users (full_name, email, role, password_hash, active)
values ('Tu Nombre', 'tu@mail.com', 'admin', '<hash_bcrypt>', true);
```

El login acepta email o nombre completo. Rol `admin` o `master_owner`.

## 6) Configurar N8N (en el VPS existente)

Entrá a https://horizon-n8n.8qkrxr.easypanel.host/.

### 6.1 Credenciales a crear

- `PH_ADMIN_BOT` (Telegram API, token del bot admin).
- `PH_OPENAI` (OpenAI API key — GPT-4o-mini).

Las credenciales `PH_OWNER_BOT`, `PH_PAYPAL_BASIC` y `PH_SMTP` **ya no
son necesarias**; se usaban en workflows que quedaron archivados.

### 6.2 Variables de entorno del contenedor N8N

```
SUPABASE_URL=https://<proyecto>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...
ADMIN_TELEGRAM_IDS=111,222,333,444,555
PH_CURRENT_EVENT_ID=<uuid del evento activo>
```

N8N **ya no necesita** `JWT_SECRET`, `PAYPAL_*`, `SMTP_*` ni
`PUBLIC_BASE_URL`. Todo eso se movió al server Node.

Reiniciar N8N desde Easypanel después de guardar las variables.

### 6.3 Importar el workflow

`Workflows → Import from File`:

- `n8n/admin-bot-workflow.json` — único workflow activo.

Activalo con el toggle de arriba a la derecha.

Los archivos de `n8n/_archived/` (`paypal-capture-workflow.json`,
`transfer-submit-workflow.json`, `master-owner-bot-workflow.json`)
**no se importan**: quedaron ahí como referencia histórica y ya no
se mantienen al día con el resto del sistema.

## 7) Prueba end-to-end

1. Desde Telegram (admin autorizado) al bot: *"crea código para
   Juan Pérez, juan@x.com, +5255123456"*.
2. El bot responde con `JUAN-PER-5821` (formato
   `NOMBRE-APEL-####`).
3. Compartir el link `https://partyhouse.tu-dominio.com/?c=JUAN-PER-5821`.
4. La landing muestra "Hola, Juan" + monto del evento.
5. **Flujo PayPal:**
   - Pagar con PayPal Sandbox desde la landing.
   - El server captura server-side y redirige a `/ticket.html?c=JUAN-PER-5821`.
   - Desde ahí, probar *Descargar QR* (PNG firmado) y *Guardar imagen*.
   - Escanear el QR en `/validador.html` — debe marcarlo como `redeemed`.
6. **Flujo transferencia:**
   - Usar un código distinto (p. ej. `ANA-GAR-1122`).
   - En la landing, completar el formulario de transferencia.
   - La landing muestra el botón *Enviar comprobante por WhatsApp*.
   - Abrir `/admin.html`, loguearse, ver la transferencia pendiente.
   - Clic en **Confirmar** → se emite el ticket.
   - Volver al link de la invitada: ahora redirige directo a
     `/ticket.html` con el QR descargable.

## 8) Seguridad mínima

- `SUPABASE_SERVICE_ROLE_KEY`, `PAYPAL_CLIENT_SECRET` y `JWT_SECRET`
  **solo viven en el server** (nunca en el frontend, ya no en N8N tampoco).
- 2FA en Supabase, PayPal, Easypanel.
- Cambiar el password de `admin@partyhouse.example` antes del primer evento.
- Cambiar `STAFF_PIN` o crear staff real en `public.app_users`
  con `role='staff'` y su propio PIN.
- Rotar `JWT_SECRET` por evento si querés invalidar QRs viejos.
- Revisar que N8N tenga autenticación básica habilitada (Easypanel la
  configura por defecto).

## 9) Backups

- **Supabase:** habilitar backups diarios (plan Pro).
- **N8N:** backup del volumen `/home/node/.n8n` desde Easypanel
  (contiene el workflow y las credenciales cifradas).
- **Server:** el código vive en Git; el `.env` hay que respaldarlo por
  fuera (secret manager / vault / notas cifradas).
