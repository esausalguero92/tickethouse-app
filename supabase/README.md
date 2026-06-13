# Supabase — Party House

## 1. Crear el proyecto
1. Entrar a https://supabase.com y crear un nuevo proyecto.
2. Guardar las credenciales:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY` (uso público en la landing)
   - `SUPABASE_SERVICE_ROLE_KEY` (uso en backend y N8N — NUNCA exponer al cliente)

## 2. Ejecutar el esquema
Abrir el **SQL Editor** del proyecto y pegar el contenido de `schema.sql`. Ejecutar.

## 2.1 (Opcional) Seed de datos de prueba
Para probar la landing sin tener que crear códigos manualmente, ejecutar también `seed.sql` desde el SQL Editor. Crea:

- 1 evento publicado (`PH_CURRENT_EVENT_ID = 11111111-1111-1111-1111-111111111111`).
- 4 amenidades.
- 1 staff (PIN `1234`), 1 admin y 1 owner de demostración.
- 3 invitados + 3 códigos:
  - `JONATHAN-0001` → orden pagada + ticket emitido (entra directo a `/ticket.html`).
  - `DEMO-0002` → sin pagar (ejecuta el flujo completo de pago).
  - `ANA-0003` → transferencia en revisión (prueba el flujo `awaiting_review`).

El seed es idempotente: se puede volver a ejecutar sin duplicar filas.

## 3. Storage
Crear un bucket llamado `receipts` (privado) para almacenar los comprobantes de transferencia subidos por los invitados.

## 4. Variables de entorno (ejemplo)
```
SUPABASE_URL=https://xxxxxxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOi...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...
```

## 5. Notas de seguridad
- Las tablas tienen RLS habilitado. Solo los eventos publicados y las amenidades son legibles por `anon`.
- Todas las operaciones sensibles (crear códigos, confirmar pagos, validar QR) pasan por el backend con `service_role`.
- N8N usa `service_role` para escribir (generación de códigos desde el bot de administradores).

## 6. Diagrama lógico
```
events ──< access_codes >── guests
  │              │
  │              └─< orders ── tickets ──< validation_log
  │
  └─< amenities

app_users ─< activity_log
app_users ─(generated_by)─> access_codes
app_users ─(reviewed_by)──> orders
app_users ─(redeemed_by)──> tickets
```
