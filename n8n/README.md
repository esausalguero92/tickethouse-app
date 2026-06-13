# N8N — Party House

## Rol actual de N8N

Con la refactorización de abril 2026, el server Node es el backend real
(captura PayPal, procesa transferencias, firma JWT del ticket, valida QRs).
N8N se quedó con un único workflow:

- **`admin-bot-workflow.json`** — bot de Telegram para el admin con IA que
  genera códigos de acceso y los escribe directamente en Supabase.

Los workflows viejos (`paypal-capture`, `transfer-submit`, `master-owner-bot`)
quedaron archivados en `_archived/` como referencia histórica. No se importan
en producción.

### Estrategia del workflow

- **Telegram** (Trigger + 3 envíos) → nodos **nativos** de N8N, usan la
  credencial `PartyHouse Bot` ya creada en la instancia.
- **OpenAI** → nodo **HTTP Request** con `predefinedCredentialType: openAiApi`.
  Usa la credencial `OpenAI Horizon` pero mediante el dropdown *Credential for
  OpenAI API* dentro del nodo HTTP (evita incompatibilidades de versión del
  nodo nativo OpenAI).
- **Supabase** → nodos **HTTP Request** con URL + service_role **hardcodeados
  directamente en el JSON**. No hay env vars, no hay credenciales.
- **Admin ID** y **event ID** → hardcodeados dentro del workflow.

El JSON **no tiene** referencias a IDs internos de credenciales, así que
importa limpio. Lo único manual: seleccionar la credencial correcta del
dropdown en los 5 nodos que la requieren (instrucciones abajo).

### Nodos del workflow (11 en total)

1. **Telegram Trigger** — recibe mensajes del bot.
2. **¿Admin autorizado?** (IF boolean) — compara `from.id` contra array hardcodeado.
3. **Rechazar** (Telegram) — responde al que no está autorizado.
4. **Preparar pedido OpenAI** (Function) — arma el body de chat completions,
   tolera mensajes sin texto (sticker/foto/voz → usa `'hola'`).
5. **OpenAI (HTTP)** — POST a `api.openai.com/v1/chat/completions`,
   `response_format: json_object`, modelo `gpt-4o-mini`.
6. **Construir código** (Function) — parsea `choices[0].message.content`,
   genera `NOMBRE-APEL-####`, decide si pedir más info o seguir.
7. **¿Falta info?** (IF boolean) — bifurca a reply de ayuda o al pipeline DB.
8. **Responder ayuda** (Telegram) — responde con texto del modelo.
9. **Supabase: upsert guest** (HTTP) — `POST /rest/v1/guests?on_conflict=email`.
10. **Supabase: insert access_code** (HTTP) — inserta el código con `guest_id`
    resuelto del paso anterior.
11. **Responder con código** (Telegram) — mensaje final al admin en texto plano
    (sin Markdown, para evitar 400 con nombres con `_`, `*`, `` ` ``, `[`).

---

## 1. Importar el workflow

1. Entrá a https://horizon-n8n.8qkrxr.easypanel.host/.
2. Si tenés el workflow viejo: abrilo → botón ⋮ → **Delete**.
3. **Workflows → Import from File** y subí `admin-bot-workflow.json`.
4. Debería abrirse sin errores (algunos nodos van a mostrar un warning
   ámbar porque todavía no tienen credencial seleccionada; es esperable).

## 2. Asignar credenciales (5 selecciones)

Abrí cada nodo y seleccioná la credencial del dropdown. Guardá cada uno.

| Nodo                     | Tipo                | Dónde está el dropdown                | Credencial a seleccionar  |
|--------------------------|---------------------|---------------------------------------|---------------------------|
| **Telegram Trigger**     | Telegram Trigger    | Campo *Credential to connect with*    | `PartyHouse Bot`          |
| **Rechazar**             | Telegram            | Campo *Credential to connect with*    | `PartyHouse Bot`          |
| **OpenAI (HTTP)**        | HTTP Request        | Sección *Authentication* → *Credential for OpenAI API* | `OpenAI Horizon` |
| **Responder ayuda**      | Telegram            | Campo *Credential to connect with*    | `PartyHouse Bot`          |
| **Responder con código** | Telegram            | Campo *Credential to connect with*    | `PartyHouse Bot`          |

> El nodo **OpenAI (HTTP)** usa `Authentication: Predefined Credential Type` +
> `Credential Type: OpenAI API`. N8N muestra el dropdown *Credential for OpenAI
> API* justo debajo — ahí seleccionás `OpenAI Horizon`.

Los nodos **Supabase: upsert guest** y **Supabase: insert access_code** no
necesitan credencial: el `service_role` va hardcodeado en los headers.

Después de guardar los 5 nodos, hacé **Save** al workflow completo (arriba
a la derecha).

## 3. Activar

Toggle **Active** arriba a la derecha. Listo: Telegram recibe los
mensajes → N8N procesa → Supabase recibe los códigos → el admin
recibe la respuesta.

## 4. Probar

Desde tu cuenta de Telegram (la que tiene ID `7360106479`):

```
crea código para Juan Pérez, juan@example.com, +5255123456
```

Respuesta esperada:

```
✅ Código generado

👤 Juan Pérez
🎟 Código: JUAN-PER-5821

Compartilo con el invitado...
```

En Supabase (SQL Editor) podés verificar:

```sql
select code, g.first_name, g.email, ac.created_at
from public.access_codes ac
join public.guests g on g.id = ac.guest_id
order by ac.created_at desc
limit 5;
```

## 5. Valores hardcodeados en el workflow

Si alguno de estos cambia, hay que editarlos directamente en los nodos
correspondientes:

| Valor                   | Dónde está                                 | Cuándo cambiar                           |
|-------------------------|--------------------------------------------|------------------------------------------|
| **Admin Telegram ID**   | Nodo `¿Admin autorizado?` · expresión JS `['7360106479'].includes(...)` | Sumar/quitar admins al array |
| **Event ID**            | Nodo `Construir código` · constante `EVENT_ID` | Cuando creás un nuevo evento         |
| **Supabase URL**        | Nodos `Supabase: upsert guest` y `Supabase: insert access_code` · campo `url` | Si cambiás de proyecto Supabase |
| **Supabase service_role** | Mismos nodos · headers `apikey` + `Authorization` | Si rotás la clave |

Actual:

- Admin ID: `7360106479` (Jonathan)
- Event ID: `bdf59dc5-a260-4be9-99b4-81450982c8d6`
- Supabase URL: `https://pvdrbkvafmlqoylbwsxh.supabase.co`

## 6. Cómo se usa

El admin escribe en el chat del bot, en lenguaje natural:

> crea código para Juan Pérez, juan@example.com, +52 55 1234 5678

El workflow:

1. Verifica que el Telegram ID esté autorizado.
2. Le manda el texto a GPT-4o-mini con instrucciones para devolver JSON
   `{first_name, last_name, email, phone}`.
3. Si falta data, responde un mensaje pidiendo lo que falta.
4. Genera un código con formato `NOMBRE-APEL-####` — ej. `JUAN-PER-5821`.
   - Máx. 6 letras del nombre, 3 del apellido, 4 dígitos random.
   - Quita acentos, espacios y caracteres especiales.
5. Hace `upsert` del invitado en `public.guests` (por email).
6. Inserta el código en `public.access_codes`.
7. Responde al admin en Telegram con el código listo para compartir.

## 7. Flujo completo del sistema

```
     [Telegram · admin]
            │
            ▼
 [N8N · admin-bot-workflow] ── OpenAI (parseo)
            │                 ── Supabase REST (guests + codes)
            │                 ── Telegram (respuesta)
            ▼
     [Invitado] ingresa código en la landing
            │
            ▼
   [Server Node] ── PayPal (captura) ── Supabase (orders + tickets · JWT)
            │
            ├── ticket.html → QR descargable
            └── transferencia → /admin.html (confirmación manual)

     [Staff en puerta] escanea QR
            │
            ▼
   [Server Node] ── verifica JWT ── Supabase (valida y marca como usado)
```

## 8. Troubleshooting

### "Found credential with no ID"
Usando esta versión del workflow ya **no debería ocurrir**. Si aparece,
es señal de que importaste una versión vieja. Borrá el workflow y
reimportá `admin-bot-workflow.json`.

### El bot no responde
- ¿El workflow está **Activo**?
- ¿Seleccionaste las credenciales en los 5 nodos y guardaste?
- Mirá en N8N → el workflow → pestaña *Executions* para ver si llegó
  el update y en qué nodo falló.

### "⛔ No tienes permiso"
Tu Telegram ID no matchea el hardcodeado. Abrí el nodo `¿Admin autorizado?`
y revisá el array en la expresión de `value1`. Para más admins, agregalos
al array: `['7360106479', '123456789'].includes(...)`.

### "compareOperationFunctions[...] is not a function"
Workflow viejo usando la operación `containsAny` que ya no existe en
versiones recientes de N8N. La versión actual del workflow usa una
expresión booleana con `Array.includes()`. Reimportá el JSON.

### OpenAI devuelve error
Abrí el nodo `OpenAI (HTTP)`, verificá que en *Authentication* esté
`Predefined Credential Type → OpenAI API` y que el dropdown *Credential for
OpenAI API* muestre `OpenAI Horizon`. Probá con **Execute node**.

### "null value in column 'guest_id' violates not-null constraint"
Pasa si el nodo `Supabase: insert access_code` no está leyendo el `id`
devuelto por `Supabase: upsert guest`. N8N desempaca los arrays que devuelve
PostgREST — cada elemento se convierte en un ítem propio, así que los
campos (`id`, `first_name`, etc.) viven directamente en `$json`, **no** en
`$json[0]`. El `jsonBody` correcto es:

```
{{ JSON.stringify({ code: ..., event_id: ..., guest_id: $json.id, status: 'active' }) }}
```

Si ves esto tras editar el nodo a mano, reimportá `admin-bot-workflow.json`.

### Supabase devuelve 401
La clave `eyJhbGci...` en los nodos HTTP está vencida o incorrecta.
Supabase Dashboard → Settings → API → copiá **service_role** (no anon).
Actualizá los 2 nodos HTTP en los headers `apikey` y `Authorization`.

### Supabase devuelve 409 (duplicate key)
Ya existe un invitado con ese email. El `upsert` con `on_conflict=email`
lo maneja; si el error persiste, chequeá que el header
`Prefer: resolution=merge-duplicates,return=representation` esté puesto
en el nodo `Supabase: upsert guest`.

## 9. Archivados

En `_archived/` quedan:

- `paypal-capture-workflow.json`
- `transfer-submit-workflow.json`
- `master-owner-bot-workflow.json`

Solo referencia. No los importes — ya no coinciden con el resto del sistema.
