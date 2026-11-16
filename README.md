# WhatsApp AI Bot

Bot de WhatsApp con **IA local**, historial persistente y panel de administración. Usa **WAHA** como puente con WhatsApp, **Ollama** para generar las respuestas y **SQLite** como única fuente de verdad. Todo corre en tu máquina o servidor: las conversaciones no se envían a ninguna API de IA en la nube.

> Proyecto pensado para uso personal o de un equipo pequeño. No es un chatbot multi-tenant ni está preparado para escalar horizontalmente.

---

## Índice

- [Qué incluye](#qué-incluye)
- [Cómo funciona](#cómo-funciona)
- [Cotización de tatuajes](#cotización-de-tatuajes)
- [Por qué no n8n](#por-qué-no-n8n)
- [Requisitos](#requisitos)
- [Inicio rápido con Docker](#inicio-rápido-con-docker)
- [Inicio sin Docker](#inicio-sin-docker)
- [Conectar WhatsApp](#conectar-whatsapp)
- [Panel de administración](#panel-de-administración)
- [Comandos del bot](#comandos-del-bot)
- [Historial, contexto y resúmenes](#historial-contexto-y-resúmenes)
- [Configuración](#configuración)
- [API](#api)
- [Backups y restauración](#backups-y-restauración)
- [Actualizar](#actualizar)
- [Seguridad](#seguridad)
- [Solución de problemas](#solución-de-problemas)
- [Desarrollo y pruebas](#desarrollo-y-pruebas)
- [Estructura del proyecto](#estructura-del-proyecto)
- [Limitaciones conocidas](#limitaciones-conocidas)

---

## Qué incluye

- **Recepción confiable de mensajes** mediante webhooks de WAHA, con verificación de firma HMAC-SHA512.
- **Deduplicación y cola durable en SQLite**: si el bot se reinicia, los mensajes pendientes se retoman.
- **Orden por conversación**: un chat no se procesa en paralelo consigo mismo.
- **Reintentos con backoff exponencial** y panel para reintentar trabajos o envíos fallidos.
- **Historial completo** de mensajes entrantes, respuestas del bot, comandos, avisos del sistema y errores.
- **Resúmenes automáticos** de las conversaciones largas para no perder contexto ni inflar el prompt.
- **Contexto configurable** por cantidad de mensajes y por caracteres.
- **Flujo de cotización**: detecta consultas, deriva el precio al tatuador y reenvía imágenes; la configuración está en [Cotización de tatuajes](#cotización-de-tatuajes).
- **Comandos** `/ayuda`, `/reset` y `/estado`.
- **Flujo de cotización de tatuajes**: detecta pedidos de precio, medidas o imágenes, deriva la consulta al tatuador con un código `COT-000123`, reenvía la multimedia y publica la respuesta del tatuador en el chat del cliente.
- **Guía de respuestas editable** (`formato_respuestas.md`) que se inyecta en cada prompt y se relee cada minuto, sin reiniciar el bot.
- **Red de seguridad anti-precios inventados**: si la IA intenta cotizar por su cuenta, negarse a dar precios o preguntar por el significado, la respuesta se reemplaza por una segura.
- **Panel web** con estado de dependencias, cola, conversaciones, búsqueda, historial, resumen, envío manual, activación/desactivación de IA, archivado, exportación y eventos.
- **API administrativa** protegida con token Bearer.
- **Healthchecks** (`/health`, `/ready`) y cierre ordenado.
- **Backups online** de SQLite sin detener el bot.
- **Docker Compose** con WAHA, Ollama, descarga automática del modelo, inicialización de la sesión y el bot.
- **127 pruebas automatizadas** que no necesitan WAHA, Ollama ni Docker.

---

## Cómo funciona

```text
 WhatsApp
    │
    ▼
┌─────────┐   webhook firmado   ┌──────────────────────────────┐
│  WAHA   │ ──────────────────► │  Bot (Node.js + TypeScript)  │
│ :3000   │                     │  :4000                       │
└─────────┘ ◄────────────────── │                              │
    ▲          sendText         │  ┌────────────────────────┐  │
    │                           │  │ Cola durable (SQLite)  │  │
    │                           │  └───────────┬────────────┘  │
    │                           │              ▼               │
    │                           │  ┌────────────────────────┐  │
    │                           │  │ Historial + resúmenes  │  │
    │                           │  └───────────┬────────────┘  │
    │                           │              ▼               │
    │                           │  ┌────────────────────────┐  │
    │                           └─►│ Ollama :11434          │  │
    │                              └────────────────────────┘  │
    │                                          │               │
    └──────────── panel /admin ◄───────────────┘               │
```

Flujo de un mensaje:

1. WAHA recibe el mensaje de WhatsApp y lo envía a `POST /webhook`.
2. El bot verifica la firma HMAC, valida el evento y descarta grupos, broadcasts, mensajes propios y chats no permitidos.
3. El mensaje se guarda en la cola (`inbound_jobs`) y en el historial (`messages`).
4. El worker toma el trabajo, guarda el mensaje entrante si aún no existe y arma el contexto.
5. Se llama a Ollama con el prompt del sistema, el resumen activo y los últimos mensajes.
6. La respuesta se guarda como mensaje saliente y se envía con `POST /api/sendText` de WAHA.
7. Los ACK de WhatsApp actualizan el estado a `sent`, `delivered`, `read` o `failed`.
8. Cuando la conversación crece, se genera un resumen con Ollama y se conservan los últimos mensajes completos.

### Decisiones de diseño

- **SQLite como fuente de verdad**: una sola base, transacciones ACID, WAL y backups consistentes. No hace falta Redis ni Postgres para un bot personal.
- **Cola en la misma base**: el mensaje y su trabajo se guardan juntos; no hay ventana de pérdida entre webhook y procesamiento.
- **WAHA en lugar de Baileys directo**: WAHA mantiene la sesión, el QR, los reintentos y la API HTTP; el bot solo consume eventos.
- **Ollama en lugar de una API en la nube**: privacidad y costo cero por token. A cambio, requiere RAM/CPU y la calidad depende del modelo elegido.
- **Sin túnel de Cloudflare**: WAHA y el bot comparten la red interna de Docker (`http://bot:4000/webhook`). El webhook no se expone a internet.

---

## Cotización de tatuajes

El bot está orientado a **cotizar tatuajes y retoques**, no a conversar sobre la historia o el significado del diseño.

### Flujo

1. El cliente cuenta qué tattoo o retoque quiere. El bot pide solo datos concretos: tamaño en cm, zona del cuerpo, imagen de referencia, color/negro y si es un retoque.
2. Cuando el cliente pide un precio, manda una medida o una imagen, el bot crea una consulta con código `COT-000123` y se la envía al tatuador configurado desde el panel.
3. Si la consulta incluye una imagen, el bot la descarga desde WAHA y se la reenvía al tatuador.
4. El tatuador responde por WhatsApp. Si hay una sola consulta pendiente puede contestar directamente; si hay varias, debe incluir el código (`COT-000123`). **El tatuador solo define el precio**: si su mensaje no contiene un precio, el bot no lo reenvía al cliente y le pide que responda con el valor.
5. El bot publica la respuesta en el chat del cliente y agrega una pregunta para coordinar día y horario.
6. Cuando el cliente elige día y hora, el bot crea la cita en la agenda de Notion y recién entonces la confirma. Si Notion no está configurado o falla, avisa al tatuador para que intervenga en vez de confirmar una cita inexistente.

La identificación del tatuador funciona aunque WAHA entregue su chat como `@lid`: el bot lee el alias de teléfono (`remoteJidAlt`) y lo compara con el número configurado. Así el tatuador puede responder desde su propio WhatsApp sin que el bot lo trate como cliente.

### Guía de respuestas

`formato_respuestas.md` define el tono, los datos que se piden, las frases prohibidas y ejemplos correctos e incorrectos. Se inyecta en cada prompt y se relee como máximo un minuto después de editarlo, sin reiniciar el bot.

En Docker el archivo está montado como solo lectura:

```yaml
- ./formato_respuestas.md:/app/formato_respuestas.md:ro
```

### Seguridad de precios

El bot nunca inventa precios. Si el modelo responde con un valor, se niega a cotizar o vuelve a preguntar por el significado, la respuesta se reemplaza automáticamente por una segura antes de enviarla.

### Número del tatuador

Se configura desde el panel, en **Conectar WhatsApp → Tatuador · Cotizaciones**. Ingresá el número colombiano **sin código de país**: el panel agrega `+57` automáticamente y lo guarda en la base. El cambio se aplica al instante, sin reiniciar el bot.

Para despliegues automatizados también podés fijarlo en `.env`; el valor guardado desde el panel tiene prioridad y, al quitarlo, se vuelve al de `.env`.

### Configuración mínima

```dotenv
# Opcional: 10 dígitos locales o formato internacional completo
TATTOO_ARTIST_CHAT_ID=573001234567
TATTOO_ARTIST_NAME=taturador
RESPONSE_GUIDE_PATH=./formato_respuestas.md
QUOTE_REQUEST_TTL_HOURS=48
```

`TATTOO_ARTIST_CHAT_ID` acepta 10 dígitos locales (`3001234567`), un número con formato (`+57 300 123 4567`) o el ID completo (`573001234567@c.us`). Si no configurás ni el panel ni la variable, el bot no puede derivar consultas de precio.

### Agenda de Notion

Las citas se registran en una base de Notion. Configurala desde el panel, en **Conectar WhatsApp → Agenda · Notion**:

1. Creá una integración en Notion y copiá su token (`ntn_...`).
2. En Notion, abrí la base de agenda, entrá en **••• → Conexiones** y agregá la integración. Sin este paso, la API no puede ver la base.
3. Pegá el token y el enlace de la base en el panel. El bot detecta las propiedades de título, fecha, cliente, teléfono, código, precio y estado; si falta la propiedad de fecha, intenta crearla.

La base debe tener una propiedad de tipo **fecha**. Si Notion no está disponible, la cita no se confirma: el bot avisa al tatuador con el día y la hora elegidos para que la cargue manualmente. También podés fijar `NOTION_API_KEY` y `NOTION_DATABASE_ID` en `.env`; el panel tiene prioridad.

El agendamiento entiende expresiones como `2 de diciembre 4pm`, `el 2/12 a las 16:00`, `el sábado a las 3 de la tarde`, `mañana 10am` o `hoy a las 4pm`. Si el cliente manda el día y la hora en mensajes separados, el bot los combina.

---

## Por qué no n8n

n8n es excelente para integraciones y automatizaciones laterales, pero **no es la mejor opción como núcleo de este bot**:

| Aspecto | n8n como núcleo | Este proyecto |
|---|---|---|
| Persistencia del historial | Requiere nodos externos; no tiene nodo SQLite nativo | SQLite integrado, transaccional |
| Contexto de conversación | Hay que reconstruirlo con código o consultas | Ventana + resúmenes automáticos |
| Idempotencia | Difícil de garantizar entre ejecuciones | `wa_message_id` único + cola durable |
| Reintentos y orden por chat | Limitados y difíciles de auditar | Backoff, intentos y orden por chat |
| Memoria adicional | ~1 GB solo para n8n | Sin proceso extra |
| Depuración | Flujos visuales grandes se vuelven frágiles | Código tipado, tests y logs estructurados |
| Control de privacidad | Datos pasan por más servicios/nodos | Todo local |

**Recomendación:** usá este proyecto como cerebro del bot. Si más adelante querés automatizaciones laterales (por ejemplo, avisar a otro sistema cuando llega un mensaje, cargar datos en una planilla o disparar un correo), podés agregar n8n como consumidor de la API administrativa o de un webhook secundario. No lo pongas en el camino crítico de la conversación.

---

## Requisitos

### Con Docker (recomendado)

- Docker Desktop o Docker Engine con Compose v2.
- Node.js 20.11 o superior **en el host**, para ejecutar `npm run setup` y los scripts auxiliares (`backup`, `waha:init`).
- 4 GB de RAM libres como mínimo (WAHA + Ollama + bot). Para modelos de 7B/8B, 8 GB o más.
- 10 GB de disco libres (imágenes, modelo y base).
- Conexión a internet solo para descargar imágenes y el modelo la primera vez.

> Si no querés instalar Node en el host, copiá `.env.example` a `.env` y reemplazá a mano los placeholders `__GENERATE_*__` por secretos aleatorios. `ADMIN_TOKEN` debe tener al menos 16 caracteres.

### Sin Docker

- Node.js 20.11 o superior (probado con 20.19.6).
- npm 10+.
- WAHA corriendo y accesible.
- Ollama corriendo y el modelo descargado.

---

## Inicio rápido con Docker

### 1. Generar el archivo `.env`

```powershell
npm run setup
```

El script:

- copia `.env.example` a `.env`;
- genera secretos aleatorios para `WAHA_API_KEY`, `WAHA_WEBHOOK_HMAC_KEY`, `ADMIN_TOKEN` y el dashboard de WAHA;
- crea las carpetas `data/` y `backups/`;
- muestra el `ADMIN_TOKEN` por pantalla.

No sobreescribe un `.env` existente. Para regenerarlo:

```powershell
npm run setup -- --force
```

> Guardá el `ADMIN_TOKEN`. También queda en `.env`, pero ese archivo está ignorado por Git.

### 2. Levantar el stack

```powershell
docker compose up -d --build
```

Servicios:

| Servicio | Función | Estado esperado |
|---|---|---|
| `waha` | Puente con WhatsApp | `running` |
| `ollama` | Motor de IA | `running` |
| `ollama-init` | Descarga el modelo | `exited (0)` al terminar |
| `waha-init` | Crea/arranca la sesión | `exited (0)` al terminar |
| `bot` | Webhook, cola, historial y panel | `running` |

Que `ollama-init` y `waha-init` terminen es normal: son tareas de inicialización.

### 3. Ver la descarga del modelo

```powershell
docker compose logs -f ollama-init
```

La primera vez puede tardar varios minutos según la conexión. Cuando aparezca `Modelo listo`, continuá.

También podés ver el estado general:

```powershell
docker compose ps
docker compose logs -f bot
```

### 4. Escanear el QR de WhatsApp

Abrí el panel del bot:

```text
http://localhost:4000/admin
```

Ingresá el `ADMIN_TOKEN` de tu `.env`. Si la sesión todavía no está conectada,
el panel abre directamente la pestaña **Conectar WhatsApp** y muestra el código
QR. Escanealo desde WhatsApp → Dispositivos vinculados → Vincular dispositivo.

El código se renueva solo. Si la sesión quedó en `FAILED` (por ejemplo, porque
vencieron los 6 QR sin escanear), usá **Generar QR / Conectar** en el mismo
panel. También podés ejecutar:

```powershell
npm run waha:init
```

Ese comando también sirve fuera de Docker si `WAHA_BASE_URL` apunta a tu instancia.

El dashboard de WAHA (`http://localhost:3000/dashboard`, con
`WAHA_DASHBOARD_USERNAME` y `WAHA_DASHBOARD_PASSWORD`) sigue disponible como
alternativa, pero ya no es necesario para vincular WhatsApp.

Cuando el estado de la sesión sea `WORKING`, el bot ya puede responder.

### 5. Abrir el panel del bot

```text
http://localhost:4000/admin
```

Ingresá el `ADMIN_TOKEN`. El panel permite:

- ver el estado de SQLite, WAHA y Ollama;
- generar y escanear el QR de WhatsApp sin salir del panel;
- reiniciar la sesión si quedó fallida o detenida;
- revisar la cola y los trabajos fallidos;
- buscar conversaciones y leer el historial completo;
- ver el resumen activo y cuántos mensajes están en contexto;
- activar o desactivar la IA por conversación;
- archivar conversaciones;
- resetear el contexto;
- exportar el historial a JSON;
- enviar un mensaje manual;
- reintentar envíos fallidos;
- ver eventos recientes del webhook.

### 6. Probar

Escribile al número conectado desde otro teléfono. Deberías recibir:

1. el visto (`sendSeen`) si `SEND_SEEN=true`;
2. el indicador de escritura (`TYPING_INDICATOR=true`);
3. una respuesta generada por Ollama.

Para probar la cotización, configurá el número del tatuador desde el panel (pestaña **Conectar WhatsApp**) y escribile desde otro teléfono algo como “¿Cuánto sale un tatuaje de 10 cm en el antebrazo?”: el bot debe avisarte que consulta al tatuador y enviarle la consulta a ese chat con un código `COT-000001`. Respondé desde el chat del tatuador con el precio; el bot lo publica en el chat del cliente y continúa con la agenda.

Si no responde, revisá:

```powershell
docker compose logs --tail=100 bot
docker compose logs --tail=100 waha
```

---

## Inicio sin Docker

Necesitás WAHA y Ollama corriendo por separado.

### 1. Instalar dependencias

```powershell
npm ci
```

### 2. Configurar `.env`

```powershell
npm run setup
```

Editá `.env` para que apunte a tus servicios locales:

```dotenv
WAHA_BASE_URL=http://localhost:3000
OLLAMA_BASE_URL=http://localhost:11434
DATABASE_PATH=./data/bot.db
```

### 3. Descargar el modelo

```powershell
ollama pull llama3.2:3b
```

### 4. Crear la sesión de WAHA y escanear el QR

```powershell
npm run waha:init
```

### 5. Compilar y arrancar

```powershell
npm run build
npm start
```

Para desarrollo con recarga automática:

```powershell
npm run dev
```

El panel queda en `http://localhost:4000/admin`.

---

## Conectar WhatsApp

### Sesión de WAHA

El nombre de la sesión se configura con `WAHA_SESSION` (por defecto `default`). El bot ignora eventos de otras sesiones.

Para crear o arrancar la sesión manualmente:

```powershell
npm run waha:init
```

### Código QR

1. Abrí `http://localhost:4000/admin`.
2. Ingresá el `ADMIN_TOKEN`.
3. Si WhatsApp no está conectado, el panel abre la pestaña **Conectar WhatsApp**.
4. Escaneá el QR desde WhatsApp → Dispositivos vinculados → Vincular dispositivo.
5. Esperá el estado `WORKING`.

El primer QR vence a los ~60 segundos y los siguientes a los ~20 segundos.
WAHA genera hasta 6 códigos; si ninguno se escanea, la sesión pasa a `FAILED`.
El panel la reinicia sola al abrir la pestaña (hasta dos intentos) y vuelve a
mostrar el QR. También podés usar **Generar QR / Conectar** o `npm run waha:init`,
que reinicia la sesión con el endpoint correcto.

La sesión se guarda en el volumen `waha_sessions`, así que no hace falta escanear el QR en cada reinicio.

### Si el QR no aparece

- Confirmá que WAHA esté corriendo: `docker compose ps`.
- Revisá los logs: `docker compose logs --tail=200 waha`.
- Verificá que `WAHA_PUBLIC_URL` sea la URL que ves en el navegador.
- Usá **Reiniciar sesión** o **Generar QR / Conectar** en la pestaña Conectar WhatsApp.
- Si la sesión está en `FAILED`, `npm run waha:init` ahora la reinicia automáticamente.

### Número recomendado

Usá un número exclusivo para el bot o un dispositivo vinculado. No uses tu número personal principal si el bot va a responder automáticamente a todos los contactos: configurá `ALLOWED_CHAT_IDS`.

---

## Panel de administración

- URL: `http://localhost:4000/admin`
- Autenticación: `ADMIN_TOKEN` como Bearer token.
- El token se guarda en `sessionStorage` o `localStorage` del navegador, según elijas “Recordar”.
- La API vive en `/api/admin/*`.
- Los archivos estáticos del panel son públicos, pero no contienen datos.

Secciones:

- **Resumen:** métricas, dependencias, configuración efectiva y cola.
- **Conectar WhatsApp:** estado de la sesión, QR para escanear, creación/reinicio de la sesión y accesos al dashboard de WAHA.
- **Conversaciones:** búsqueda, filtro por estado, paginación, historial paginado, resumen, contexto, envío manual, archivado, reset y exportación.
- **Sistema:** salud, configuración, trabajos fallidos y últimos 50 eventos del webhook.

El panel no requiere build ni dependencias de frontend: es HTML, CSS y JavaScript servidos por el mismo Express.

---

## Comandos del bot

| Comando | Aliases | Acción |
|---|---|---|
| `/ayuda` | `/help`, `/start`, `/comandos` | Muestra la ayuda |
| `/reset` | `/reiniciar`, `/nuevo` | Inicia un contexto nuevo sin borrar el historial |
| `/estado` | `/status` | Muestra modelo, mensajes en contexto, resumen e IA |

Los comandos se guardan en el historial como mensajes `command`. No se envían a Ollama.

`/reset` mueve el límite de contexto al último mensaje y desactiva el resumen actual. El historial anterior sigue visible y exportable.

---

## Historial, contexto y resúmenes

### Qué se guarda

- Contactos y conversaciones.
- Mensajes entrantes (texto o multimedia con su metadata).
- Respuestas del bot (IA, comandos, avisos y fallback).
- Mensajes manuales enviados desde el panel.
- Estados de envío (`queued`, `sent`, `delivered`, `read`, `failed`, `skipped`).
- Errores de envío y de generación.
- Uso del modelo (`model`, tokens de prompt/completación, latencia).
- Resúmenes generados.
- Trabajos de la cola.
- Eventos del webhook (payload completo, estado y motivo).

Los mensajes enviados **desde tu teléfono** sin pasar por el bot o el panel no se capturan. Si necesitás que formen parte del contexto, respondé desde el panel o desactivá la IA y enviá el mensaje manualmente desde ahí.

### Ventana de contexto

El prompt incluye:

1. El prompt del sistema y la fecha/hora actual.
2. El resumen activo, si existe.
3. Los últimos `HISTORY_MAX_MESSAGES` mensajes.
4. Como máximo `HISTORY_MAX_CHARS` caracteres de historial.
5. Cada mensaje se recorta a `PROMPT_MAX_MESSAGE_CHARS`.

El historial siempre empieza con un mensaje del usuario. Las respuestas fallidas no se incluyen.

### Resúmenes automáticos

Cuando la conversación supera `SUMMARY_TRIGGER_MESSAGES` mensajes **o** `SUMMARY_TRIGGER_CHARS` caracteres desde el último resumen:

1. se toman los mensajes antiguos;
2. se pide a Ollama un resumen en tercera persona;
3. se guarda el resumen con el ID del último mensaje incluido;
4. se conservan los últimos `SUMMARY_KEEP_RECENT_MESSAGES` mensajes completos.

Solo puede haber un resumen activo por conversación. `/reset` lo desactiva.

### Reset de contexto

- No borra mensajes.
- No borra resúmenes antiguos.
- Mueve `context_start_message_id` al último mensaje.
- La próxima respuesta se genera solo con los mensajes posteriores.

---

## Configuración

Todo se configura por variables de entorno en `.env`. Los valores se validan al arrancar con Zod; si algo es inválido, el proceso no inicia y muestra el error.

### Aplicación

| Variable | Default | Descripción |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `test` o `production` |
| `LOG_LEVEL` | `info` | Nivel de Pino (`debug`, `info`, `warn`, `error`, `silent`) |
| `LOG_PRETTY` | según entorno | `true` para logs legibles en desarrollo |
| `HOST` | `127.0.0.1` | Interfaz de escucha (Docker usa `0.0.0.0` dentro del contenedor) |
| `PORT` | `4000` | Puerto HTTP local (en Docker el bot siempre usa 4000 dentro del contenedor) |
| `TRUST_PROXY` | `false` | Ponelo en `true` detrás de un reverse proxy |
| `BODY_LIMIT` | `1mb` | Límite del cuerpo JSON |
| `TIMEZONE` | `America/Bogota` | Zona horaria IANA para el prompt y las citas |
| `ADMIN_ENABLED` | `true` | Habilita `/api/admin` |
| `ADMIN_TOKEN` | — | Token Bearer, mínimo 16 caracteres (lo genera `npm run setup`) |

### Base de datos

| Variable | Default | Descripción |
|---|---|---|
| `DATABASE_PATH` | `./data/bot.db` | Ruta del archivo SQLite |
| `EVENT_RETENTION_DAYS` | `14` | Días que se conservan los eventos del webhook |
| `JOB_RETENTION_DAYS` | `30` | Días que se conservan trabajos terminados/fallidos |
| `BACKUP_DIR` | `./backups` | Solo para `npm run backup` |
| `BACKUP_RETENTION_DAYS` | `14` | Retención de backups generados por el script |

### WAHA

| Variable | Default | Descripción |
|---|---|---|
| `WAHA_BASE_URL` | `http://localhost:3000` | URL interna de la API de WAHA |
| `WAHA_PUBLIC_URL` | `http://localhost:3000` | URL visible desde el navegador (para el enlace al dashboard/QR) |
| `WAHA_SESSION` | `default` | Nombre de la sesión |
| `WAHA_ENGINE` | `NOWEB` | Motor de WAHA: `NOWEB` (sin navegador), `WEBJS` o `GOWS` |
| `WAHA_NOWEB_WA_VERSION` | `auto-web` | Versión de WhatsApp Web que anuncia NOWEB; `auto-web` usa la última disponible |
| `WAHA_API_KEY` | — | API key de WAHA (`X-Api-Key`) |
| `WAHA_WEBHOOK_HMAC_KEY` | — | Secreto para validar la firma del webhook |
| `WAHA_REQUEST_TIMEOUT_MS` | `15000` | Timeout de llamadas a WAHA |
| `SEND_SEEN` | `true` | Marcar como leído al recibir |
| `TYPING_INDICATOR` | `true` | Mostrar “escribiendo…” |
| `QUOTE_REPLIES` | `false` | Responder citando el mensaje entrante |

### Ollama

| Variable | Default | Descripción |
|---|---|---|
| `OLLAMA_BASE_URL` | `http://localhost:11434` | URL de Ollama |
| `OLLAMA_MODEL` | `llama3.2:3b` | Modelo a usar |
| `OLLAMA_TEMPERATURE` | `0.7` | Creatividad (0 a 2) |
| `OLLAMA_NUM_CTX` | `8192` | Ventana de contexto del modelo |
| `OLLAMA_NUM_PREDICT` | `512` | Tokens máximos de respuesta |
| `OLLAMA_TIMEOUT_MS` | `120000` | Timeout de generación |
| `OLLAMA_KEEP_ALIVE` | `30m` | Tiempo que Ollama mantiene el modelo en memoria |

Modelos sugeridos:

- `llama3.2:3b`: liviano, funciona con poca RAM.
- `qwen2.5:7b`: mejor español, requiere más recursos.
- `llama3.1:8b`: buena calidad general, más lento en CPU.

### Comportamiento del bot

| Variable | Default | Descripción |
|---|---|---|
| `BOT_NAME` | `Asistente` | Nombre que usa el bot |
| `BOT_ENABLED` | `true` | Interruptor global |
| `SYSTEM_PROMPT` | prompt incluido | Personalidad e instrucciones |
| `HISTORY_MAX_MESSAGES` | `30` | Mensajes máximos de contexto (2–200) |
| `HISTORY_MAX_CHARS` | `12000` | Caracteres máximos de historial |
| `PROMPT_MAX_MESSAGE_CHARS` | `4000` | Recorte por mensaje |
| `MAX_REPLY_CHARS` | `6000` | Recorte de la respuesta |
| `IGNORE_GROUPS` | `true` | Ignorar grupos |
| `ALLOWED_CHAT_IDS` | vacío | Lista separada por comas; vacío = cualquier chat directo |
| `AI_FALLBACK_REPLY` | mensaje técnico | Respuesta si Ollama falla |

`ALLOWED_CHAT_IDS` acepta un número con o sin formato (`5491111111111`, `+54 9 11 1111-1111`) o un ID completo (`5491111111111@c.us`). Se normaliza al arrancar. Si configurás una lista, el chat del tatuador se agrega automáticamente para que sus respuestas no se descarten.

### Cotización de tatuajes

| Variable | Default | Descripción |
|---|---|---|
| `TATTOO_ARTIST_CHAT_ID` | — | Respaldo del número del tatuador. El panel tiene prioridad; acepta 10 dígitos locales o formato internacional |
| `TATTOO_ARTIST_NAME` | `tatuador` | Nombre que usa el bot al referirse al tatuador |
| `RESPONSE_GUIDE_PATH` | `./formato_respuestas.md` | Guía de respuestas inyectada en el prompt |
| `RESPONSE_GUIDE_MAX_CHARS` | `12000` | Recorte máximo de la guía |
| `QUOTE_REQUEST_TTL_HOURS` | `48` | Horas que una consulta queda pendiente antes de vencer |

### Agenda de Notion

| Variable | Default | Descripción |
|---|---|---|
| `NOTION_API_KEY` | — | Respaldo del token de la integración. El panel tiene prioridad |
| `NOTION_DATABASE_ID` | — | Respaldo del ID o URL de la base de agenda. El panel tiene prioridad |

### Resúmenes

| Variable | Default | Descripción |
|---|---|---|
| `SUMMARY_ENABLED` | `true` | Activa resúmenes automáticos |
| `SUMMARY_TRIGGER_MESSAGES` | `30` | Mínimo de mensajes para resumir |
| `SUMMARY_TRIGGER_CHARS` | `12000` | Mínimo de caracteres para resumir |
| `SUMMARY_KEEP_RECENT_MESSAGES` | `8` | Mensajes recientes que quedan completos |
| `SUMMARY_MAX_INPUT_CHARS` | `20000` | Recorte del transcript enviado a Ollama |
| `SUMMARY_MAX_OUTPUT_TOKENS` | `400` | Tokens máximos del resumen |

### Cola

| Variable | Default | Descripción |
|---|---|---|
| `QUEUE_POLL_INTERVAL_MS` | `500` | Frecuencia de sondeo |
| `JOB_MAX_ATTEMPTS` | `5` | Intentos máximos por trabajo |

### Variables de Docker Compose

`docker-compose.yml` usa además:

- `WAHA_DASHBOARD_USERNAME` / `WAHA_DASHBOARD_PASSWORD`: acceso al dashboard de WAHA.
- `OLLAMA_KEEP_ALIVE`: se pasa también al contenedor de Ollama.
- `WAHA_PUBLIC_URL`: URL del dashboard que muestra el panel del bot.

Los puertos se publican solo en `127.0.0.1` por defecto. Si necesitás acceder desde otro equipo de la LAN o un servidor remoto, cambiá el mapeo en `docker-compose.yml` o usá un túnel SSH/reverse proxy con HTTPS.

---

## API

### Públicas

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/` | Información básica |
| `GET` | `/version` | Versión |
| `GET` | `/health` | Liveness: solo comprueba SQLite |
| `GET` | `/ready` | Readiness: SQLite + WAHA `WORKING` + modelo disponible |
| `POST` | `/webhook` | Webhook de WAHA (requiere HMAC si está configurado) |

`/health` responde `200` si la base funciona. `/ready` responde `503` hasta que WAHA esté conectado (`WORKING`) y el modelo esté descargado.

### Administrativas

Requieren `Authorization: Bearer <ADMIN_TOKEN>`.

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/admin/overview` | Métricas, salud, configuración y cola |
| `GET` | `/api/admin/conversations` | Lista con `limit`, `offset`, `search`, `status` |
| `GET` | `/api/admin/conversations/:id` | Detalle, resumen, contexto e historial paginado |
| `PATCH` | `/api/admin/conversations/:id` | `{ "aiEnabled": bool }` y/o `{ "status": "active"\|"archived" }` |
| `POST` | `/api/admin/conversations/:id/reset` | Reinicia el contexto |
| `POST` | `/api/admin/conversations/:id/messages` | Envía `{ "text": "..." }` |
| `POST` | `/api/admin/messages/:id/retry` | Reintenta un envío fallido |
| `GET` | `/api/admin/conversations/:id/export` | Exporta todo el historial a JSON |
| `GET` | `/api/admin/events` | Últimos eventos; `?full=1` incluye el payload |
| `GET` | `/api/admin/jobs` | Trabajos fallidos |
| `POST` | `/api/admin/jobs/:id/retry` | Devuelve un trabajo fallido a la cola |
| `GET` | `/api/admin/system` | Salud forzada, eventos y trabajos fallidos |

Ejemplo:

```powershell
$token = "tu-admin-token"
Invoke-RestMethod -Uri "http://localhost:4000/api/admin/conversations?limit=10" `
  -Headers @{ Authorization = "Bearer $token" }
```

Documentación detallada: [`docs/ADMIN_API.md`](docs/ADMIN_API.md).

---

## Backups y restauración

### Crear un backup

Con Docker:

```powershell
docker compose exec bot node scripts/backup.mjs
docker compose cp bot:/app/backups/. ./backups/
```

Sin Docker:

```powershell
npm run backup
```

El script usa la API de backup online de SQLite, así que no hace falta detener el bot. Los backups van a `BACKUP_DIR` (por defecto `./backups` en local y `/app/backups` en Docker) y se eliminan los más viejos que `BACKUP_RETENTION_DAYS`.

### Restaurar

1. Detené el bot:

   ```powershell
   docker compose stop bot
   ```

2. Copiá el backup dentro del contenedor:

   ```powershell
   docker compose cp .\backups\bot-2026-01-01_00-00-00.db bot:/app/data/bot.db
   ```

3. Eliminá los archivos WAL/SHM viejos:

   ```powershell
   docker compose run --rm --entrypoint sh bot -c "rm -f /app/data/bot.db-wal /app/data/bot.db-shm"
   ```

4. Arrancá de nuevo:

   ```powershell
   docker compose up -d bot
   ```

En local, reemplazá `data/bot.db` y borrá `data/bot.db-wal` y `data/bot.db-shm` antes de arrancar.

> No copies un `.db` con el bot escribiendo encima sin usar el script de backup: podés obtener una copia inconsistente.

---

## Actualizar

```powershell
git pull
npm run setup        # no sobreescribe .env
docker compose up -d --build
```

Las migraciones de SQLite se aplican solas al arrancar (`PRAGMA user_version`). Hacé un backup antes de actualizar si la base tiene datos importantes.

Para cambiar el modelo:

1. editá `OLLAMA_MODEL` en `.env`;
2. descargalo: `docker compose run --rm ollama-init` (o `ollama pull ...` en local);
3. recreá el bot: `docker compose up -d --force-recreate bot`.

---

## Seguridad

- **No expongas WAHA a internet.** Por defecto solo escucha en `127.0.0.1`. Si usás un servidor remoto, poné un reverse proxy con HTTPS y autenticación, o un túnel SSH.
- **Cambiá las credenciales del dashboard de WAHA.** `npm run setup` genera una contraseña aleatoria.
- **Usá un `ADMIN_TOKEN` largo.** El mínimo son 16 caracteres; el script genera 48.
- **Mantené `.env` fuera de Git.** Ya está en `.gitignore`.
- **Configurá `ALLOWED_CHAT_IDS`** si no querés que el bot responda a cualquier contacto.
- **El webhook está firmado con HMAC-SHA512.** No desactives `WAHA_WEBHOOK_HMAC_KEY` salvo en una red totalmente confiable.
- **Ollama no tiene autenticación.** No publiques el puerto `11434` en internet.
- **Los backups contienen datos personales.** Cifralos o guardalos en un lugar seguro.
- **Revisá los permisos del volumen** si corrés Docker en un servidor compartido.

Checklist mínima para producción:

- [ ] `.env` con secretos únicos.
- [ ] Puertos en `127.0.0.1` o detrás de HTTPS.
- [ ] `ALLOWED_CHAT_IDS` configurado.
- [ ] Backups programados y probados.
- [ ] Monitoreo de `/health` y `/ready`.
- [ ] WAHA y Ollama con versiones fijadas (no `latest`) si necesitás reproducibilidad.

---

## Solución de problemas

### El bot no responde

1. `docker compose ps`: verificá que `bot` y `waha` estén corriendo.
2. `docker compose logs --tail=100 bot`: buscá `Mensaje encolado`, `Respuesta de IA enviada` o errores.
3. `GET /ready`: debe devolver `200` con `waha.status: WORKING`.
4. Revisá que el chat no esté en `ALLOWED_CHAT_IDS` con otro formato.
5. Revisá que la conversación no esté archivada o con IA desactivada.
6. Revisá que `BOT_ENABLED=true`.

### WAHA responde 401

La `WAHA_API_KEY` del `.env` no coincide con la del contenedor. Como ambas salen del mismo `.env`, normalmente pasa cuando se editó una sola. Regenerá el `.env` o igualá los valores y recreá los contenedores.

### Ollama responde “model not found”

```powershell
docker compose logs ollama-init
docker compose exec ollama ollama list
docker compose exec ollama ollama pull llama3.2:3b
```

Si cambiaste `OLLAMA_MODEL`, descargá el nuevo modelo y recreá el bot.

### El QR no aparece o la sesión queda en `SCAN_QR_CODE`

1. Abrí `http://localhost:4000/admin` → **Conectar WhatsApp**.
2. Si el estado es `FAILED` o `STOPPED`, usá **Generar QR / Conectar**.
3. Si sigue sin aparecer, revisá los logs:

```powershell
npm run waha:init
docker compose logs --tail=200 waha
```

`npm run waha:init` lista también las sesiones detenidas y reinicia las que
están en `FAILED` (el endpoint `/start` no recupera una sesión fallida).

El dashboard de WAHA (`http://localhost:3000/dashboard`) sigue disponible con
las credenciales del `.env` como alternativa.

Si con el motor `WEBJS` la sesión pasa a `FAILED` justo después de escanear el QR (en los logs aparece `Session has been logged out`), cambiá a `WAHA_ENGINE=NOWEB` en `.env`, borrá el volumen de sesiones y recreá WAHA:

```powershell
docker compose down waha
docker volume rm whatsapp-ai-bot_waha_sessions
docker compose up -d --force-recreate waha
npm run waha:init
```

Volvé a escanear el QR. `NOWEB` no usa navegador y evita ese cierre de sesión.

### La sesión `NOWEB` queda en `FAILED` con `Connection Failure`

Si en los logs aparece `Connection closed due to 'Error: Connection Failure'` en `noise-handler.js`, WAHA está anunciando una versión de WhatsApp Web que el servidor rechaza. Verificá que el `.env` tenga `WAHA_NOWEB_WA_VERSION=auto-web` y recreá WAHA:

```powershell
docker compose up -d --force-recreate waha
docker compose logs --tail=100 waha
```

Al arrancar, WAHA busca la última versión en `web.whatsapp.com` y la usa si es más nueva que la incluida en la imagen. Si la sesión ya quedó inválida, desvinculá el dispositivo en WhatsApp y volvé a escanear el QR.

### Error `UNIQUE constraint failed: messages.wa_message_id`

No debería ocurrir en uso normal: el webhook deduplica por `wa_message_id`. Si aparece, revisá si hay dos instancias del bot usando la misma base o un webhook duplicado de otra sesión.

### El panel queda en blanco

- Abrí la consola del navegador.
- Verificá que estés entrando por `http://localhost:4000/admin/` (con barra final).
- El CSP está ajustado para HTTP local; si lo servís detrás de HTTPS, no debería haber problema.
- Mirá `docker compose logs bot` por errores de archivos estáticos.

### Los trabajos quedan en `failed`

Abrí la pestaña **Sistema** del panel, revisá `last_error` y usá **Reintentar**. Si el error es de WAHA (401, 502) o de Ollama (timeout), corregí la dependencia antes de reintentar.

### La base crece demasiado

- Los eventos se purgan cada 6 horas según `EVENT_RETENTION_DAYS`.
- Los trabajos terminados se purgan según `JOB_RETENTION_DAYS`.
- Los mensajes y resúmenes **no se purgan automáticamente**: son el historial.
- Ejecutá `VACUUM` solo con el bot detenido y después de un backup.

---

## Desarrollo y pruebas

```powershell
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm start
```

Pruebas:

- No requieren WAHA, Ollama ni Docker.
- Usan SQLite `:memory:` y clientes fake.
- Cubren configuración, webhook, HMAC, deduplicación, cola, reintentos, contexto, resúmenes, comandos, API administrativa, panel y base de datos.

Observabilidad:

- Logs JSON con Pino (o pretty en desarrollo).
- Cada request tiene `X-Request-Id`.
- `/health` y `/ready` para monitoreo.
- Eventos del webhook y trabajos fallidos visibles en el panel.

---

## Estructura del proyecto

```text
whatsapp/
├─ src/
│  ├─ app.ts                 # Express, CSP, rutas y manejo de errores
│  ├─ index.ts               # arranque, worker, mantenimiento y cierre
│  ├─ config.ts              # validación de variables de entorno
│  ├─ clients/               # WAHA y Ollama
│  ├─ db/                    # SQLite, migraciones y repositorios
│  ├─ domain/                # parseo de WAHA, prompt y comandos
│  ├─ middleware/            # auth admin y HMAC del webhook
│  ├─ routes/                # webhook y API administrativa
│  ├─ services/              # conversación, cola, resúmenes, salud
│  └─ utils/
├─ public/admin/             # panel web sin build
├─ scripts/                  # setup, backup y waha-init
├─ tests/                    # Vitest + Supertest
├─ docs/                     # base de datos, operaciones y API
├─ docker-compose.yml
├─ Dockerfile
├─ formato_respuestas.md     # Guía de respuestas del estudio
├─ .env.example
└─ README.md
```

Documentación adicional:

- [`docs/DATABASE.md`](docs/DATABASE.md): esquema, relaciones y consultas.
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md): runbook de operación y recuperación.
- [`docs/ADMIN_API.md`](docs/ADMIN_API.md): referencia de la API administrativa.

---

## Limitaciones conocidas

- **Un solo proceso de bot.** La cola y SQLite están pensadas para una instancia. No escales horizontalmente sin cambiar a Postgres y una cola distribuida.
- **Solo texto y metadata de multimedia.** No se transcriben audios ni se analizan imágenes. Las imágenes de una consulta de cotización se reenvían al tatuador, pero el bot no interpreta su contenido.
- **Los mensajes enviados desde el teléfono no se capturan.** Solo se guardan los que pasan por el bot o por el panel.
- **La calidad depende del modelo.** Un modelo de 3B es rápido pero limitado; uno de 7B/8B responde mejor y consume más RAM.
- **WAHA Core tiene límites.** Una sesión y funciones avanzadas de pago según el caso de uso.
- **Las imágenes del historial dependen de WAHA.** El bot guarda la referencia a la URL de WAHA; si el archivo se borra, la referencia deja de servir. El volumen `waha_media` conserva los archivos y puede crecer con el tiempo.
- **No hay autenticación de usuarios del panel.** Hay un único token compartido.
- **No hay cifrado en reposo.** SQLite guarda el historial en texto plano; usá cifrado de disco si hace falta.
