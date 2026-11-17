# Plataforma multiusuario de bots de WhatsApp (WAHA + Neon PostgreSQL)

Este documento describe el **sistema web desplegable** agregado en `src/platform/` y
`public/platform/`. Es independiente del bot legado (`src/index.ts`, SQLite): el bot
legado se conserva intacto y la plataforma es la capa de despliegue multiusuario.

> Estado de lo que falta: **[docs/PENDIENTE.md](PENDIENTE.md)**.

---

## 1. Qué resuelve

| Requisito | Implementación |
| --- | --- |
| Varios usuarios con login | Registro/login con contraseña (scrypt) y sesiones en PostgreSQL con cookie `httpOnly`. |
| Reutilizar sesión activa | `POST /api/bots/connect` consulta WAHA; si está `WORKING`, reutiliza y no pide QR. |
| Sesión no validada → recrear | Si la sesión existe pero no está `WORKING`, se **borra** y se crea desde cero con QR nuevo. |
| Neon PostgreSQL | `pg` + `DATABASE_URL` con `sslmode=require&channel_binding=require`. Ver `src/platform/db.ts`. |
| Todo en `.env` | Ninguna credencial en el código. Ver `.env.example` (sección "PLATAFORMA MULTIUSUARIO"). |
| API propia por proyecto | Cada bot tiene su **API key** (hash en BD) y su **nombre de sesión WAHA** único. No se comparten variables de entorno entre usuarios. |
| Token admin de WAHA | `WAHA_ADMIN_API_KEY` se usa como `X-Api-Key` para gestionar sesiones y pedir el QR. |
| Alta de usuarios + perfil admin | Registro público (configurable) y panel de administración con CRUD, suspensión, roles y permiso de creación de bots. |
| Un usuario sin acceso no crea bots | `status = active` **y** `can_create_bots = true` son obligatorios en `POST /api/bots`. |
| Reportes detallados | `usage_events` + vistas agregadas por usuario y globales (`/api/reports`, `/api/admin/reports`). |

---

## 2. Arquitectura

```
Navegador (SPA en public/platform)
        │  HTTPS / cookie de sesión httpOnly
        ▼
Express + Helmet  (src/platform/app.ts)
        ├── /api/auth/*      registro, login, logout, me
        ├── /api/bots/*      crear bot, QR, reconectar, estado, rotar key
        ├── /api/ingest/*    API key por proyecto (eventos del bot)
        ├── /api/reports/*   reportes del usuario
        └── /api/admin/*     usuarios + reportes globales
        │
        ├── pg (Pool) ──────────────► Neon PostgreSQL
        │                              users / bots / user_sessions / usage_events
        └── WahaAdminClient ─────────► WAHA (X-Api-Key: WAHA_ADMIN_API_KEY)
                                       /api/sessions, /api/{session}/auth/qr
```

### Modelo de datos (migraciones automáticas en `src/platform/db.ts`)

- **users**: email único, `password_hash` (scrypt), `role` (`user`/`admin`), `status`
  (`active`/`suspended`), `can_create_bots`.
- **bots**: 1 por usuario, `waha_session` único, `api_key_hash` + `api_key_preview`,
  `connection_status`, `phone_number`.
- **user_sessions**: token hasheado, expiración, revocación, IP y user-agent.
- **usage_events**: eventos (`login`, `qr_generated`, `session_connected`,
  `message_in`, `message_out`, …) con `meta JSONB` para reportes.

---

## 3. Flujo de vinculación por QR

1. El usuario inicia sesión. El panel llama a `POST /api/bots/connect`.
2. `ensureWahaSession()` (`src/platform/waha-admin.ts`):
   - `GET /api/sessions/{name}` → si `status === WORKING`: **reutiliza** (login automático).
   - Si existe con otro estado (`SCAN_QR_CODE`, `FAILED`, `STOPPED`, …): **DELETE** y luego **POST /api/sessions**.
   - Si no existe: **POST /api/sessions** directamente.
   - `GET /api/{name}/auth/qr` (con reintentos) → devuelve el PNG en base64 (`data:` URI).
3. El front muestra el QR y hace polling en `GET /api/bots/status` cada 4 s.
4. Al pasar a `WORKING`, se guarda `connection_status = working`, el teléfono y se registra
   el evento `session_connected`.

> El nombre de sesión es `bot_<uuid>` (ver `sessionNameFor()`), por lo que dos usuarios
> nunca pueden colisionar en WAHA.

---

## 4. Despliegue paso a paso

### 4.1 Seguridad FIRST: rotar credenciales expuestas

La cadena de conexión de Neon apareció **en claro en un mensaje**. Antes de desplegar:

1. Entrá a Neon → tu proyecto → **Connection Details** → **Reset password**.
2. Usá la **nueva** cadena (pooler) en `DATABASE_URL`.
3. Si el `WAHA_ADMIN_API_KEY` también fue compartido en algún canal, rotalo en WAHA.
4. Confirmá que `.env` esté en `.gitignore` (ya lo está) y que el historial de git no
   contenga secretos. Si los contiene, reescribí el historial (`git filter-repo`).

### 4.2 Requisitos

- Node.js >= 20.11.
- Base Neon PostgreSQL (o cualquier Postgres con SSL).
- WAHA accesible desde la API con un API key de administrador.
- HTTPS en el proveedor (necesario para `COOKIE_SECURE=true`).

### 4.3 Instalación

```bash
npm install
cp .env.example .env      # editá los valores, NUNCA subas .env
npm run build
npm run platform:migrate  # opcional: la app también migra al arrancar
npm run start:platform
```

En desarrollo:

```bash
npm run dev:platform
```

La app queda en `http://localhost:4000` (o el `PORT` configurado).

### 4.4 Variables de entorno (resumen)

| Variable | Descripción | Ejemplo |
| --- | --- | --- |
| `DATABASE_URL` | Cadena Neon con pooler y SSL | `postgresql://user:pass@ep-x-pooler.../neondb?sslmode=require&channel_binding=require` |
| `WAHA_BASE_URL` | URL interna de WAHA | `http://waha:3000` |
| `WAHA_ADMIN_API_KEY` | Token admin de WAHA (`X-Api-Key`) | `...` |
| `SESSION_SECRET` | Pepper de sesiones (>=16 chars) | aleatorio |
| `COOKIE_SECURE` | `true` en producción | `true` |
| `APP_BASE_URL` | URL pública (links) | `https://tu-dominio.com` |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Admin sembrado en el primer arranque | `admin@dominio.com` |
| `ALLOW_PUBLIC_REGISTRATION` | Permite registro abierto | `false` recomendado en producción |
| `API_KEY_PREFIX` | Prefijo de API keys por bot | `wbp` |
| `AI_PROVIDER` | `ollama` (local) o `groq` (nube) | `groq` |
| `GROQ_API_KEY` | Key de Groq (solo entorno; rotar si se expuso) | — |
| `GROQ_MODEL` | Modelo a usar (debe existir en tu cuenta) | `openai/gpt-oss-20b` |
| `GROQ_BASE_URL` | Endpoint OpenAI-compatible de Groq | `https://api.groq.com/openai/v1` |
| `GROQ_MAX_TOKENS` | Salida máxima (gpt-oss gasta tokens en razonamiento) | `1024` |

### 4.5 Despliegue con Docker (WAHA + app)

El `docker-compose.yml` del repositorio ya incluye el servicio `platform`:

- Escucha en **4001** (`127.0.0.1:4001`), sin colisionar con el bot legado en 4000.
- Usa `env_file: .env` y `depends_on` con `waha`/`bot` en `service_healthy`.
- Monta un volumen `platform_bots` en `/app/data/bots` (una SQLite por bot).
- `WHATSAPP_HOOK_URL` de WAHA sigue apuntando al bot legado
  (`http://bot:4000/webhook`), para que un despliegue sin plataforma siga
  funcionando. El bot legado reenvía los eventos de **otras** sesiones a
  `PLATFORM_WEBHOOK_URL` (`http://platform:4001/webhook`) firmados con la misma
  HMAC. La plataforma los enruta por `event.session` al motor del bot dueño.

Levantá todo con:

```bash
docker compose up -d --build
```

Poné un reverse proxy (Caddy/Nginx/Traefik) con HTTPS delante y `TRUST_PROXY=true`.
En producción configurá `PLATFORM_PUBLIC_URL` con la URL pública y
`ALLOW_PUBLIC_REGISTRATION=false` (ya es el valor por defecto).

Verificación:

```bash
npm run smoke:platform   # PLATFORM_BASE_URL=https://tu-dominio.com
```

### 4.6 Despliegue en Railway

El repositorio incluye `railway.json`, que configura el builder Dockerfile y el
comando de arranque de la plataforma (`node dist/platform/index.js`).

**Error común:** `dockerfile invalid: docker VOLUME at Line 48 is not supported,
use Railway Volumes`. railway no permite la instrucción `VOLUME` en el Dockerfile:
ya fue eliminada. Si necesitás persistencia para el bot legado (SQLite), creá un
**Railway Volume** en el dashboard del servicio y montalo en `/app/data`. La
plataforma no requiere volumen local: guarda todo en Neon y las sesiones viven en WAHA.

Pasos:

1. Crear el servicio desde el repositorio (Railway detecta `railway.json`).
2. En Variables, cargar **todas** las de la sección 4.4, en especial:
   - `DATABASE_URL` (cadena Neon rotada).
   - `WAHA_BASE_URL` (URL pública o interna de tu servicio WAHA en Railway).
   - `WAHA_ADMIN_API_KEY`, `SESSION_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`.
   - `COOKIE_SECURE=true`, `TRUST_PROXY=true`, `APP_BASE_URL=https://<tu-dominio>.up.railway.app`.
   - `AI_PROVIDER=groq`, `GROQ_API_KEY`, `GROQ_MODEL=openai/gpt-oss-20b`.
   - `ALLOW_PUBLIC_REGISTRATION=false`.
3. El healthcheck usa `/health` y respeta la variable `PORT` que Railway asigna
   (no depende del 4000 fijo).
4. Antes de hacer push, corré el preflight (valida artefactos, Dockerfile,
   `railway.json` y variables de entorno):

   ```bash
   npm run build && npm run verify:deploy
   ```

5. Si también desplegás WAHA en Railway, usá su URL interna para `WAHA_BASE_URL` y
   configurá el webhook hacia `https://<tu-servicio>.up.railway.app/webhook` cuando
   el motor por bot esté activo.

> Si querés desplegar el **bot legado** en vez de la plataforma, cambiá
> `startCommand` en `railway.json` a `node dist/index.js` y montá un Railway Volume
> en `/app/data` para el SQLite.

### 4.7 Verificación

```bash
curl https://tu-dominio.com/health
curl https://tu-dominio.com/ready     # db: up, waha: up
```

Flujo manual: registrar usuario → crear bot → escanear QR → ver `Conectado` →
el admin abre "Administración" y ve el reporte del usuario.

---

## 5. API reference (resumen)

| Método | Ruta | Auth | Descripción |
| --- | --- | --- | --- |
| POST | `/api/auth/register` | — | Crear cuenta (si registro abierto) |
| POST | `/api/auth/login` | — | Login, setea cookie |
| POST | `/api/auth/logout` | cookie | Cierra sesión |
| GET | `/api/auth/me` | cookie | Usuario actual |
| GET | `/api/bots/me` | cookie | Bot del usuario |
| POST | `/api/bots` | cookie | Crear bot + QR + API key (una sola vez) |
| POST | `/api/bots/connect` | cookie | Reutilizar sesión o generar QR |
| POST | `/api/bots/reconnect` | cookie | Forzar QR nuevo |
| GET | `/api/bots/status` | cookie | Estado real en WAHA |
| POST | `/api/bots/api-key/rotate` | cookie | Rotar API key del proyecto |
| DELETE | `/api/bots` | cookie | Eliminar bot y sesión |
| POST | `/api/ingest/events` | **API key del bot** | Registrar `message_in`/`message_out` |
| GET | `/api/reports/summary` | cookie | Reportes propios |
| GET | `/api/admin/users` | admin | Listar usuarios |
| POST | `/api/admin/users` | admin | Crear usuario |
| PATCH | `/api/admin/users/:id` | admin | Rol, estado, permisos, password |
| DELETE | `/api/admin/users/:id` | admin | Eliminar usuario |
| POST | `/api/admin/users/:id/sessions/revoke` | admin | Cerrar sesiones del usuario |
| GET | `/api/admin/reports` | admin | Reporte global |

---

## 6. Aislamiento por proyecto (API personalizada)

No hay una única API key global para todos los bots. Cada bot genera la suya
(`wbp_...`) al crearse. El valor en claro se entrega **una sola vez**; en PostgreSQL
solo se guarda `sha256(key)` y un `preview` para mostrarlo en el panel.

El motor del bot de cada usuario se autentica contra `POST /api/ingest/events`
enviando `X-Api-Key: wbp_...`. El servidor resuelve el bot por hash, verifica que
esté habilitado y que su usuario esté activo, y escribe el evento **en el usuario
correcto**. Así:

- Las credenciales de un proyecto no se comparten con otro.
- No hace falta recrear el `.env` ni reiniciar el servidor para agregar un usuario.
- Cada sesión WAHA también es única (`bot_<uuid>`).

### Motor por bot (arquitectura A)

Cada bot habilitado tiene su propio motor aislado, creado por
`src/platform/worker-host.ts`:

- una `InboundWorker` y una SQLite en `ENGINE_DATA_DIR/<botId>/bot.db`;
- un `WahaClient` configurado con la sesión WAHA del bot (`bot_<uuid>`);
- la cadena completa de servicios (IA, cotizaciones, agenda, resúmenes);
- un cliente de ingesta que reporta `message_in` / `message_out` con la API key
  del bot (guardada cifrada en Postgres, descifrada solo en memoria).

WAHA entrega los eventos al bot legado; este reenvía los que pertenecen a otras
sesiones a `POST /webhook` de la plataforma, firmados con HMAC-SHA512. La
plataforma verifica la firma y enruta por `event.session` al motor
correspondiente. Un timer sincroniza altas, bajas y rotaciones de API key cada
30 s sin reiniciar el proceso.

> Las conversaciones viven en SQLite por bot, no en Postgres. Postgres guarda
> usuarios, bots, sesiones web y eventos de uso (reportes). El detalle de lo que
> queda para operar está en **[docs/PENDIENTE.md](PENDIENTE.md)**.

---

## 7. Riesgos de seguridad y recomendaciones

1. **Cadena de conexión expuesta (CRÍTICO).** Rotar la contraseña en Neon ya. Considerar
   la cadena anterior como comprometida. Restringir acceso por IP en Neon si es posible.
2. **Token admin de WAHA.** Dale permisos mínimos y no lo expongas al front. El panel
   nunca recibe este token: solo el servidor lo usa.
3. **API keys en claro.** Se muestran una vez. Si se filtra una key, rotarla con
   `/api/bots/api-key/rotate`. Para mayor seguridad se podrían cifrar en reposo con
   KMS (hoy se guarda el hash, suficiente para autenticar pero no para recuperar).
4. **Cookies.** `httpOnly` + `SameSite=Lax` + `Secure` en producción. `SESSION_SECRET`
   debe ser aleatorio y estable (si cambia, se invalidan las sesiones).
5. **Rate limiting.** El de login es **en memoria**; con varias réplicas no se comparte.
   Usar Redis o un limitador del reverse proxy en despliegues multi-instancia.
6. **CSRF.** `SameSite=Lax` mitiga; para operaciones sensibles se puede agregar token CSRF.
7. **WAHA.** No exponer `/dashboard` públicamente sin autenticación. Los QR son secretos
   temporales: whoever los ve puede vincular su WhatsApp. CSP ya permite `data:` solo en `img`.
8. **Inyección SQL.** Todas las consultas usan parámetros (`$1`, `$2`, …). No concatenar
   entradas del usuario.
9. **Logs.** No se registran contraseñas ni tokens. Revisar que el proveedor no loguee
   cabeceras `X-Api-Key`/`Cookie`.
10. **Backups y retención.** Neon tiene Point-in-Time Recovery; definir política de
    retención y cifrado. Los `usage_events` crecen: programar limpieza (>90 días) si hace falta.
11. **HTTPS obligatorio.** Sin TLS, la cookie y el QR viajan en claro.
12. **Permisos.** El admin puede suspender/eliminar usuarios, pero no al último admin
    activo (protección implementada).

---

## 8. Pruebas y mantenimiento

```bash
npm run typecheck
npm run build
npm test          # bot legado + plataforma + integración por sesión
npm run lint
npm run smoke:platform   # con la app arrancada
```

Las migraciones son idempotentes (`CREATE TABLE IF NOT EXISTS`). Para cambiar el
esquema, agregá una sentencia al array `MIGRATIONS` en `src/platform/db.ts`.
