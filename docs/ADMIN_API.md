# API administrativa

API HTTP para operar el bot. La usa el panel web, pero también se puede consumir desde scripts, n8n u otro sistema.

- Base: `http://localhost:4000/api/admin`
- Autenticación: `Authorization: Bearer <ADMIN_TOKEN>`
- Formato: JSON
- Si `ADMIN_ENABLED=false`, todas las rutas responden `404`.

> El token es único y compartido. No hay usuarios, roles ni sesiones del lado del servidor. Tratalo como una contraseña de administrador.

---

## Autenticación

```http
GET /api/admin/overview HTTP/1.1
Host: localhost:4000
Authorization: Bearer tu-admin-token
```

Respuestas de autenticación:

| Caso | HTTP | Código |
|---|---|---|
| Token ausente o inválido | `401` | `UNAUTHORIZED` |
| Panel deshabilitado | `404` | `ADMIN_DISABLED` |

Ejemplos:

```powershell
$token = "tu-admin-token"
$headers = @{ Authorization = "Bearer $token" }
Invoke-RestMethod -Uri "http://localhost:4000/api/admin/overview" -Headers $headers
```

```bash
curl -s http://localhost:4000/api/admin/overview \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

---

## Formato de errores

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Parámetros inválidos",
    "details": [
      {
        "path": ["limit"],
        "message": "Too big: expected number to be <=200"
      }
    ]
  }
}
```

Códigos posibles:

| Código | HTTP | Significado |
|---|---|---|
| `UNAUTHORIZED` | 401 | Token inválido |
| `ADMIN_DISABLED` | 404 | Panel deshabilitado |
| `NOT_FOUND` | 404 | Recurso inexistente |
| `VALIDATION_ERROR` | 400 | Parámetros o cuerpo inválidos |
| `WAHA_ERROR` | 4xx/502 | Error al enviar por WAHA |
| `OLLAMA_ERROR` | 502 | Error de Ollama |
| `INTERNAL_ERROR` | 500 | Error inesperado |

Los errores de WAHA/Ollama no exponen detalles internos en la respuesta; quedan en los logs.

---

## Resumen

### `GET /api/admin/overview`

Devuelve versión, uptime, configuración efectiva, estadísticas, salud y estado de la cola.

```json
{
  "version": "1.0.0",
  "uptimeSeconds": 3600,
  "bot": {
    "name": "Asistente",
    "model": "llama3.2:3b",
    "timeZone": "America/Argentina/Buenos_Aires",
    "enabled": true,
    "historyMaxMessages": 30,
    "summaryEnabled": true
  },
  "settings": {
    "ignoreGroups": true,
    "allowedChatsConfigured": 0,
    "webhookHmacEnabled": true,
    "adminEnabled": true,
    "historyMaxChars": 12000,
    "summaryTriggerMessages": 30,
    "queueMaxAttempts": 5,
    "sendSeen": true,
    "typingIndicator": true
  },
  "stats": {
    "contacts": 12,
    "conversations": 12,
    "archivedConversations": 1,
    "messages": 340,
    "inboundToday": 15,
    "outboundToday": 15,
    "summaries": 2,
    "dbSizeBytes": 245760
  },
  "health": {
    "checkedAt": "2026-01-01T12:00:00.000Z",
    "db": { "ok": true },
    "waha": {
      "ok": true,
      "status": "WORKING",
      "me": { "id": "5491111111111@c.us", "pushName": "Bot" }
    },
    "ollama": {
      "ok": true,
      "models": ["llama3.2:3b"],
      "hasModel": true
    },
    "queue": {
      "pending": 0,
      "processing": 0,
      "done": 340,
      "failed": 0,
      "oldest_pending_at": null
    }
  },
  "worker": {
    "running": true,
    "currentJobId": null,
    "checkedAt": "2026-01-01T12:00:00.000Z"
  },
  "dashboardUrl": "http://localhost:3000/dashboard"
}
```

---

## Conversaciones

### `GET /api/admin/conversations`

Lista conversaciones ordenadas por último mensaje.

Parámetros:

| Parámetro | Tipo | Default | Límites |
|---|---|---|---|
| `limit` | integer | 50 | 1–200 |
| `offset` | integer | 0 | ≥ 0 |
| `search` | string | vacío | ≤ 200 caracteres |
| `status` | string | `all` | `all`, `active`, `archived` |

Busca en `wa_id`, `phone`, `push_name` y `display_name`.

```json
{
  "items": [
    {
      "id": 1,
      "contact": {
        "waId": "5491111111111@c.us",
        "phone": "5491111111111",
        "pushName": "Ana",
        "displayName": "Ana"
      },
      "aiEnabled": true,
      "status": "active",
      "lastMessageAt": "2026-01-01T12:00:00.000Z",
      "lastMessage": {
        "body": "Claro, decime qué necesitás.",
        "direction": "out",
        "status": "sent",
        "createdAt": "2026-01-01T12:00:00.000Z"
      },
      "messageCount": 12,
      "pendingReply": false,
      "createdAt": "2025-12-01T10:00:00.000Z"
    }
  ],
  "total": 1,
  "limit": 50,
  "offset": 0
}
```

`pendingReply` es `true` cuando el último mensaje entrante es posterior al último saliente (el bot todavía no respondió o la respuesta falló).

Ejemplo con búsqueda:

```powershell
Invoke-RestMethod `
  -Uri "http://localhost:4000/api/admin/conversations?search=ana&status=active&limit=20" `
  -Headers $headers
```

### `GET /api/admin/conversations/:id`

Detalle de la conversación, contacto, resumen activo, estado del contexto y mensajes paginados.

Parámetros:

| Parámetro | Tipo | Default | Límites |
|---|---|---|---|
| `limit` | integer | 100 | 1–200 |
| `beforeId` | integer | — | > 0 |

`beforeId` permite cargar mensajes anteriores (paginación hacia atrás).

```json
{
  "conversation": {
    "id": 1,
    "aiEnabled": true,
    "status": "active",
    "contextStartMessageId": 0,
    "lastInboundAt": "2026-01-01T12:00:00.000Z",
    "lastOutboundAt": "2026-01-01T12:00:01.000Z",
    "lastMessageAt": "2026-01-01T12:00:01.000Z",
    "createdAt": "2025-12-01T10:00:00.000Z"
  },
  "contact": {
    "waId": "5491111111111@c.us",
    "phone": "5491111111111",
    "pushName": "Ana",
    "displayName": "Ana",
    "firstSeenAt": "2025-12-01T10:00:00.000Z",
    "lastSeenAt": "2026-01-01T12:00:00.000Z"
  },
  "summary": {
    "text": "Ana consultó por...",
    "throughMessageId": 280,
    "messagesCovered": 280,
    "model": "llama3.2:3b",
    "createdAt": "2025-12-31T18:00:00.000Z"
  },
  "context": {
    "startMessageId": 280,
    "messageCount": 60
  },
  "messages": [
    {
      "id": 341,
      "waMessageId": "false_5491111111111@c.us_ABC",
      "direction": "in",
      "role": "user",
      "kind": "text",
      "body": "Hola",
      "status": "received",
      "error": null,
      "model": null,
      "promptTokens": null,
      "completionTokens": null,
      "latencyMs": null,
      "media": null,
      "replyToMessageId": null,
      "createdAt": "2026-01-01T12:00:00.000Z",
      "sentAt": null
    }
  ],
  "hasMore": true
}
```

`messages` viene ordenado cronológicamente (ascendente). `hasMore=true` indica que hay mensajes más antiguos; usá `beforeId` con el `id` del primer mensaje de la lista.

### `PATCH /api/admin/conversations/:id`

Actualiza la conversación. Se debe enviar al menos un campo.

```json
{
  "aiEnabled": false,
  "status": "archived"
}
```

| Campo | Tipo | Valores |
|---|---|---|
| `aiEnabled` | boolean | `true` / `false` |
| `status` | string | `active` / `archived` |

Respuesta:

```json
{
  "ok": true,
  "conversation": {
    "id": 1,
    "aiEnabled": false,
    "status": "archived"
  }
}
```

### `POST /api/admin/conversations/:id/reset`

Reinicia el contexto de IA sin borrar mensajes. Desactiva el resumen actual y mueve el límite al último mensaje.

```json
{
  "ok": true,
  "contextStartMessageId": 340
}
```

### `POST /api/admin/conversations/:id/messages`

Envía un mensaje manual por WhatsApp, como si lo hubiera escrito el bot.

```json
{
  "text": "Hola, te escribo desde el panel."
}
```

Validaciones:

- `text` obligatorio;
- se recorta;
- entre 1 y 6000 caracteres.

Respuesta `201`:

```json
{
  "ok": true,
  "message": {
    "id": 342,
    "direction": "out",
    "role": "assistant",
    "kind": "text",
    "body": "Hola, te escribo desde el panel.",
    "status": "sent",
    "model": "manual",
    "createdAt": "2026-01-01T12:05:00.000Z",
    "sentAt": "2026-01-01T12:05:00.000Z"
  }
}
```

Si WAHA falla, el mensaje queda guardado con `status: "failed"` y la API responde con error. Se puede reintentar.

### `POST /api/admin/messages/:id/retry`

Reintenta el envío de un mensaje saliente fallido o pendiente.

- Si ya está `sent`, `delivered` o `read`, devuelve el mismo mensaje sin reenviar.
- Si no existe o es entrante: `404 NOT_FOUND`.

```json
{
  "ok": true,
  "message": {
    "id": 342,
    "status": "sent"
  }
}
```

### `GET /api/admin/conversations/:id/export`

Descarga un JSON con la conversación completa, contacto, resumen y todos los mensajes.

```http
Content-Disposition: attachment; filename="conversacion-1.json"
```

Estructura:

```json
{
  "exportedAt": "2026-01-01T12:10:00.000Z",
  "conversation": {
    "id": 1,
    "aiEnabled": true,
    "status": "active",
    "createdAt": "2025-12-01T10:00:00.000Z"
  },
  "contact": {
    "waId": "5491111111111@c.us",
    "phone": "5491111111111",
    "pushName": "Ana",
    "displayName": "Ana"
  },
  "summary": {
    "text": "...",
    "throughMessageId": 280,
    "messagesCovered": 280,
    "model": "llama3.2:3b",
    "createdAt": "2025-12-31T18:00:00.000Z"
  },
  "messages": []
}
```

---

## Eventos y cola

### `GET /api/admin/events`

Últimos eventos del webhook.

| Parámetro | Tipo | Default | Límites |
|---|---|---|---|
| `limit` | integer | 50 | 1–200 |
| `full` | `1` | — | Incluye el payload completo |

Sin `full`, cada evento incluye `payloadPreview` (300 caracteres). Con `full=1`, incluye `payload` parseado.

```json
{
  "items": [
    {
      "id": 100,
      "eventId": "evt-123",
      "event": "message",
      "session": "default",
      "status": "queued",
      "reason": null,
      "payloadPreview": "{\"event\":\"message\",...}",
      "createdAt": "2026-01-01T12:00:00.000Z"
    }
  ]
}
```

Estados: `queued`, `processed`, `ignored`, `duplicate`, `error`.

Motivos frecuentes de `ignored`: `from_me`, `grupo`, `broadcast`, `chat_no_permitido`, `mensaje_vacio`, `sesion_distinta`, `evento:*`.

### `GET /api/admin/jobs`

Trabajos en estado `failed`.

| Parámetro | Tipo | Default | Límites |
|---|---|---|---|
| `limit` | integer | 50 | 1–200 |

```json
{
  "items": [
    {
      "id": 12,
      "waMessageId": "false_5491111111111@c.us_ABC",
      "chatId": "5491111111111@c.us",
      "attempts": 5,
      "maxAttempts": 5,
      "lastError": "No se pudo contactar a Ollama...",
      "createdAt": "2026-01-01T11:00:00.000Z",
      "updatedAt": "2026-01-01T11:05:00.000Z"
    }
  ]
}
```

### `POST /api/admin/jobs/:id/retry`

Devuelve un trabajo `failed` a `pending`, reinicia intentos y limpia el error.

- Si no existe: `404`.
- Si no está `failed`: `400 VALIDATION_ERROR`.

```json
{ "ok": true }
```

### `GET /api/admin/system`

Vista consolidada para la pestaña Sistema:

- salud forzada (sin caché);
- estado del worker;
- últimos 50 eventos;
- últimos 50 trabajos fallidos;
- configuración efectiva.

```json
{
  "health": {},
  "worker": {
    "running": true,
    "currentJobId": null,
    "checkedAt": "2026-01-01T12:00:00.000Z"
  },
  "events": [],
  "failedJobs": [],
  "settings": {
    "model": "llama3.2:3b",
    "botName": "Asistente",
    "timeZone": "America/Argentina/Buenos_Aires",
    "historyMaxMessages": 30,
    "historyMaxChars": 12000,
    "summaryEnabled": true,
    "summaryTriggerMessages": 30,
    "ignoreGroups": true,
    "allowedChatsConfigured": 0,
    "adminEnabled": true,
    "webhookHmacEnabled": true
  }
}
```

---

## Endpoints públicos relacionados

Estos no requieren token:

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/` | Info básica |
| `GET` | `/version` | Versión |
| `GET` | `/health` | Liveness (SQLite) |
| `GET` | `/ready` | Readiness (SQLite + WAHA + modelo) |
| `POST` | `/webhook` | Webhook de WAHA (HMAC) |

`/ready` devuelve `503` si la sesión de WAHA no está `WORKING` o si el modelo no está descargado.

---

## Ejemplos de automatización

### Consultar conversaciones pendientes de respuesta

```powershell
$items = (Invoke-RestMethod `
  -Uri "http://localhost:4000/api/admin/conversations?status=active&limit=100" `
  -Headers $headers).items

$pending = $items | Where-Object { $_.pendingReply -eq $true }
$pending | Select-Object id, @{n='contacto';e={$_.contact.displayName}}, lastMessageAt
```

### Desactivar la IA en un chat

```powershell
Invoke-RestMethod -Method Patch `
  -Uri "http://localhost:4000/api/admin/conversations/1" `
  -Headers $headers `
  -ContentType "application/json" `
  -Body '{"aiEnabled":false}'
```

### Exportar conversaciones

El endpoint de listado devuelve como máximo 200 por página. Para exportar todo,
iterá con `offset`:

```powershell
$offset = 0
do {
  $page = Invoke-RestMethod `
    -Uri "http://localhost:4000/api/admin/conversations?limit=200&offset=$offset" `
    -Headers $headers

  foreach ($c in $page.items) {
    Invoke-WebRequest `
      -Uri "http://localhost:4000/api/admin/conversations/$($c.id)/export" `
      -Headers $headers `
      -OutFile ("export-$($c.id).json")
  }

  $offset += $page.items.Count
} while ($offset -lt $page.total)
```

### Integración con n8n

n8n puede llamar a esta API con un nodo HTTP Request:

- Header `Authorization: Bearer <token>`;
- URL `http://bot:4000/api/admin/...` si n8n está en la misma red de Docker;
- o `http://localhost:4000/api/admin/...` si corre en el host.

Casos típicos:

- detectar `pendingReply` y avisar a un humano;
- exportar conversaciones a un data warehouse;
- disparar una acción externa cuando aparece un trabajo fallido;
- consultar `/api/admin/system` para monitoreo.

No uses n8n para reemplazar la cola interna: el orden por chat, la idempotencia y los reintentos ya viven en SQLite.

---

## Buenas prácticas

- No guardes el token en el frontend de terceros.
- Usá HTTPS si la API se consume fuera de localhost.
- No consultes `/api/admin/system` cada segundo: fuerza healthchecks a WAHA y Ollama.
- Para automatizaciones, preferí `overview` y `conversations` antes que `system`.
- Respetá los límites de paginación (`limit` máximo 200).
- Si vas a hacer muchas exportaciones, hacelas de a una y esperá la respuesta.
