# Base de datos

El bot usa **SQLite** mediante `better-sqlite3`. La base es el registro completo de contactos, conversaciones, mensajes, resúmenes, trabajos y eventos del webhook.

- Ruta local por defecto: `./data/bot.db`.
- Ruta en Docker: `/app/data/bot.db` (volumen `bot_data`).
- Motor: SQLite 3 con WAL, `foreign_keys=ON`, `busy_timeout=5000` y `synchronous=NORMAL`.
- Migraciones: se aplican al arrancar y se versionan con `PRAGMA user_version`.
- Versión actual del esquema: **2**.

> No edites el esquema a mano. Para cambios, agregá una migración nueva en `src/db/database.ts` y subí la versión.

---

## Diagrama de relaciones

```text
contacts 1 ─── 1 conversations
    │                 │
    │                 ├── N messages
    │                 ├── N conversation_summaries
    │                 ├── N quote_requests
    │                 └── N inbound_jobs (por chat_id, no FK)
    │
    └── N messages (contact_id)

app_meta       (clave/valor independiente)
webhook_events (independiente, guarda el payload crudo)
```

`messages` tiene dos claves foráneas: `conversation_id` y `contact_id`. `reply_to_message_id` apunta al mensaje entrante que originó una respuesta.

---

## Tablas

### `contacts`

Persona o chat que interactuó con el bot. Un contacto tiene una sola conversación (`contact_id UNIQUE`).

| Columna | Tipo | Notas |
|---|---|---|
| `id` | INTEGER PK | Autoincremental |
| `wa_id` | TEXT UNIQUE | ID de WhatsApp, por ejemplo `5491111111111@c.us` |
| `phone` | TEXT | Solo dígitos, si es un chat directo |
| `push_name` | TEXT | Nombre que informa WhatsApp |
| `display_name` | TEXT | Nombre visible usado por el panel |
| `first_seen_at` | TEXT ISO | Primera vez visto |
| `last_seen_at` | TEXT ISO | Última actividad |
| `created_at`, `updated_at` | TEXT ISO | Auditoría |

Índices: `phone`, `last_seen_at`.

### `conversations`

Estado de la conversación con un contacto.

| Columna | Tipo | Notas |
|---|---|---|
| `id` | INTEGER PK | |
| `contact_id` | INTEGER UNIQUE FK | `ON DELETE CASCADE` |
| `ai_enabled` | INTEGER 0/1 | Interruptor por conversación |
| `status` | TEXT | `active` o `archived` |
| `context_start_message_id` | INTEGER | Límite inferior del contexto tras `/reset` |
| `last_inbound_at` | TEXT ISO | Último mensaje entrante |
| `last_outbound_at` | TEXT ISO | Último mensaje saliente |
| `last_message_at` | TEXT ISO | Último mensaje de cualquier dirección |
| `created_at`, `updated_at` | TEXT ISO | Auditoría |

Índices: `last_message_at DESC`, `status`.

Semántica:

- `archived`: el bot no responde, pero el historial queda.
- `ai_enabled=0`: el bot no responde automáticamente; se puede enviar manualmente.
- `context_start_message_id`: los mensajes con `id <=` ese valor no se envían a la IA. El historial sigue guardado.

### `messages`

Historial completo. Es la tabla central.

| Columna | Tipo | Notas |
|---|---|---|
| `id` | INTEGER PK | Orden cronológico |
| `conversation_id` | INTEGER FK | `ON DELETE CASCADE` |
| `contact_id` | INTEGER FK | `ON DELETE CASCADE` |
| `wa_message_id` | TEXT UNIQUE | ID de WhatsApp; `NULL` para mensajes locales aún no enviados |
| `direction` | TEXT | `in` u `out` |
| `role` | TEXT | `user`, `assistant` o `system` |
| `kind` | TEXT | `text`, `media`, `command`, `system` o `error` |
| `body` | TEXT | Texto o caption |
| `media_url` | TEXT | URL de WAHA |
| `media_mime` | TEXT | MIME |
| `media_filename` | TEXT | Nombre original |
| `status` | TEXT | `received`, `queued`, `sent`, `delivered`, `read`, `failed`, `skipped` |
| `error` | TEXT | Último error de envío/generación |
| `model` | TEXT | Modelo usado o `manual` |
| `prompt_tokens`, `completion_tokens` | INTEGER | Uso informado por Ollama |
| `latency_ms` | INTEGER | Latencia de generación |
| `reply_to_message_id` | INTEGER FK | Mensaje entrante respondido |
| `wa_timestamp` | TEXT ISO | Timestamp original del mensaje |
| `sent_at` | TEXT ISO | Momento del envío exitoso |
| `created_at`, `updated_at` | TEXT ISO | Auditoría |

Índices:

- `(conversation_id, id)` para paginar el historial;
- `created_at`;
- `(conversation_id, direction, id)`;
- `reply_to_message_id`.

Estados:

| Estado | Significado |
|---|---|
| `received` | Entrante guardado |
| `queued` | Saliente creado, todavía no enviado |
| `sent` | WAHA aceptó el envío |
| `delivered` | ACK de entrega |
| `read` | ACK de lectura |
| `failed` | Falló el envío; se puede reintentar |
| `skipped` | El bot decidió no responder (IA apagada, archivada, bot apagado) |

Los mensajes salientes fallidos se guardan para no regenerar la respuesta y para poder reintentar el mismo texto.

### `conversation_summaries`

Resúmenes generados por Ollama. Solo uno puede estar activo por conversación.

| Columna | Tipo | Notas |
|---|---|---|
| `id` | INTEGER PK | |
| `conversation_id` | INTEGER FK | `ON DELETE CASCADE` |
| `summary` | TEXT | Texto del resumen |
| `through_message_id` | INTEGER FK | Último mensaje incluido |
| `messages_covered` | INTEGER | Cantidad acumulada de mensajes resumidos |
| `model` | TEXT | Modelo usado |
| `is_active` | INTEGER 0/1 | Solo uno activo por conversación |
| `created_at` | TEXT ISO | |

`through_message_id` es el límite inferior del contexto junto con `context_start_message_id`: se usa el mayor de los dos.

### `quote_requests`

Consultas de cotización derivadas al tatuador. El código se genera después del
insert a partir del `id` (`COT-000001`, `COT-000002`, …).

| Columna | Tipo | Notas |
|---|---|---|
| `id` | INTEGER PK | |
| `code` | TEXT UNIQUE | Código `COT-000123` |
| `conversation_id` | INTEGER FK | `ON DELETE CASCADE` |
| `contact_id` | INTEGER FK | `ON DELETE CASCADE` |
| `inbound_message_id` | INTEGER FK | Mensaje del cliente que originó la consulta |
| `request_body` | TEXT | Texto original del cliente |
| `request_media_url` | TEXT | URL de WAHA del archivo adjunto |
| `request_media_mime` | TEXT | MIME del adjunto |
| `request_media_filename` | TEXT | Nombre original del adjunto |
| `status` | TEXT | `pending`, `answered`, `delivered`, `cancelled` o `expired` |
| `artist_reply` | TEXT | Texto que respondió el tatuador |
| `artist_inbound_message_id` | INTEGER FK | Mensaje del tatuador (idempotencia) |
| `client_outbound_message_id` | INTEGER FK | Mensaje enviado al cliente |
| `artist_notification_message_id` | TEXT | ID de WAHA de la notificación al tatuador |
| `answered_at`, `delivered_at` | TEXT ISO | Momentos clave |
| `appointment_at` | TEXT ISO | Fecha y hora de la cita confirmada |
| `notion_page_id` | TEXT | Página creada en la agenda de Notion |
| `notion_page_url` | TEXT | Enlace a la página de Notion |
| `expires_at` | TEXT ISO | Vencimiento según `QUOTE_REQUEST_TTL_HOURS` |
| `created_at`, `updated_at` | TEXT ISO | Auditoría |

Índices: `(conversation_id, id DESC)` y `(status, expires_at)`.

Estados:

| Estado | Significado |
|---|---|
| `pending` | Esperando la respuesta del tatuador |
| `answered` | El tatuador respondió; se está enviando al cliente |
| `delivered` | La respuesta ya se publicó en el chat del cliente |
| `cancelled` | No se pudo notificar al tatuador |
| `expired` | Venció el plazo sin respuesta |

`appointment_at` se completa únicamente después de crear la página en Notion.
Si la cita no se pudo registrar, queda en `NULL` y el bot pide intervención al
tatuador en lugar de confirmarla.

### `inbound_jobs`

Cola durable de mensajes entrantes.

| Columna | Tipo | Notas |
|---|---|---|
| `id` | INTEGER PK | Orden de llegada |
| `wa_message_id` | TEXT UNIQUE | Deduplicación del webhook |
| `chat_id` | TEXT | Chat de WhatsApp |
| `event_id` | TEXT | ID del evento de WAHA |
| `payload` | TEXT | Evento completo en JSON |
| `status` | TEXT | `pending`, `processing`, `done`, `failed` |
| `attempts` | INTEGER | Intentos realizados |
| `max_attempts` | INTEGER | Límite configurado al encolar |
| `next_attempt_at` | TEXT ISO | Cuándo puede reclamarse |
| `locked_at` | TEXT ISO | Cuándo se tomó |
| `last_error` | TEXT | Último error |
| `created_at`, `updated_at` | TEXT ISO | |

Índices: `(status, next_attempt_at, id)` y `(chat_id, id)`.

Reglas:

- Un trabajo `pending` con `next_attempt_at` futuro bloquea a los posteriores del mismo chat para preservar el orden.
- `recoverInterrupted()` devuelve a `pending` los trabajos que quedaron en `processing` tras un reinicio.
- `releaseForShutdown()` devuelve el trabajo actual a `pending` y descuenta el intento durante un cierre ordenado.
- Los trabajos `done`/`failed` se purgan según `JOB_RETENTION_DAYS`.

### `webhook_events`

Auditoría de todo lo que llega por `/webhook`.

| Columna | Tipo | Notas |
|---|---|---|
| `id` | INTEGER PK | |
| `event_id` | TEXT | ID de WAHA |
| `event` | TEXT | Tipo de evento |
| `session` | TEXT | Sesión |
| `status` | TEXT | `queued`, `processed`, `ignored`, `duplicate`, `error` |
| `reason` | TEXT | Motivo (por ejemplo `grupo`, `from_me`, `chat_no_permitido`) |
| `payload` | TEXT | JSON completo |
| `created_at` | TEXT ISO | |

Índices: `created_at DESC`, `event_id`.

Los eventos se purgan según `EVENT_RETENTION_DAYS` (por defecto 14 días). El panel muestra un preview; la API con `?full=1` devuelve el JSON completo.

### `app_meta`

Clave/valor para estado operativo. Por ejemplo:

- `waha.session`: último estado conocido de la sesión, `me` y datos del evento `session.status`.
- `tattoo.artist_phone`: número local de 10 dígitos del tatuador configurado desde el panel. Tiene prioridad sobre `TATTOO_ARTIST_CHAT_ID`.
- `notion.api_key`: token de la integración de Notion. No se expone en la API.
- `notion.database_id`: ID normalizado de la base de agenda. Tiene prioridad sobre `NOTION_DATABASE_ID`.
- `notion.database_title`: título de la base para mostrarlo en el panel.
- `notion.last_error`: último error al leer o escribir en Notion.
- `notion.last_checked_at`: última verificación del esquema de la base.

| Columna | Tipo |
|---|---|
| `key` | TEXT PK |
| `value` | TEXT (JSON) |
| `updated_at` | TEXT ISO |

---

## Migraciones

El arranque ejecuta `migrate(db)`:

1. lee `PRAGMA user_version`;
2. aplica las migraciones pendientes de `MIGRATIONS`;
3. cada migración corre en una transacción y actualiza `user_version`.

Para agregar una migración:

```ts
// src/db/database.ts
export const MIGRATIONS: readonly string[] = [
  `...esquema actual...`,
  `ALTER TABLE ...;`, // nueva migración
];
```

Nunca modifiques una migración ya aplicada en producción: agregá una nueva.

---

## Consultas útiles

Todas son de solo lectura. Abrí la base con el bot detenido o con una conexión de solo lectura para evitar bloqueos.

```sql
-- Últimas conversaciones
SELECT c.id, ct.wa_id, ct.display_name, c.status, c.ai_enabled,
       c.last_message_at
FROM conversations c
JOIN contacts ct ON ct.id = c.contact_id
ORDER BY c.last_message_at DESC
LIMIT 20;

-- Historial de una conversación
SELECT id, direction, role, kind, status, substr(body, 1, 80) AS preview,
       created_at
FROM messages
WHERE conversation_id = ?
ORDER BY id ASC;

-- Resumen activo
SELECT summary, through_message_id, messages_covered, model, created_at
FROM conversation_summaries
WHERE conversation_id = ? AND is_active = 1
ORDER BY id DESC
LIMIT 1;

-- Mensajes en contexto
SELECT COUNT(*) AS en_contexto
FROM messages
WHERE conversation_id = ?
  AND id > COALESCE((SELECT context_start_message_id FROM conversations WHERE id = ?), 0)
  AND role IN ('user', 'assistant')
  AND kind IN ('text', 'media')
  AND (direction = 'in' OR status IN ('queued', 'sent', 'delivered', 'read'));

-- Trabajos fallidos
SELECT id, chat_id, attempts, max_attempts, last_error, updated_at
FROM inbound_jobs
WHERE status = 'failed'
ORDER BY updated_at DESC;

-- Consultas de cotización pendientes
SELECT q.id, q.code, ct.display_name, q.request_body, q.created_at, q.expires_at
FROM quote_requests q
JOIN contacts ct ON ct.id = q.contact_id
WHERE q.status = 'pending'
ORDER BY q.id ASC;

-- Eventos ignorados por motivo
SELECT reason, COUNT(*) AS total
FROM webhook_events
WHERE status = 'ignored'
GROUP BY reason
ORDER BY total DESC;

-- Tamaño de la base
SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size();
```

Consultas de escritura: evitarlas con el bot corriendo. Si necesitás modificar datos, usá el panel o la API administrativa.

---

## Backup y recuperación

El script `scripts/backup.mjs` usa `db.backup()` de better-sqlite3, que hace una copia consistente online. No copies el archivo `.db` a mano mientras el bot escribe.

```powershell
npm run backup
```

Con Docker:

```powershell
docker compose exec bot node scripts/backup.mjs
docker compose cp bot:/app/backups/. ./backups/
```

Restauración:

1. detener el bot;
2. reemplazar `bot.db` por el backup;
3. borrar `bot.db-wal` y `bot.db-shm`;
4. arrancar el bot.

Más detalle en [`OPERATIONS.md`](OPERATIONS.md).

---

## Privacidad

- Todo el historial queda en tu disco.
- Ollama recibe el contexto necesario para responder, pero se ejecuta localmente.
- No hay telemetría ni servicios externos en el flujo del bot.
- Los backups contienen datos personales: tratalos como información sensible.
- Para borrar definitivamente una conversación, eliminá la fila de `conversations` (cascade) o la base completa con el bot detenido. No hay borrado selectivo desde el panel.
