# Pendiente — organización del trabajo

Estado del repositorio al **2026-11-16**. Este documento ordena lo que quedó sin
hacer después de entregar la plataforma multiusuario (`src/platform/`).

**Leyenda:** `P0` = bloqueante / seguridad · `P1` = funcionalidad clave · `P2` = limpieza.

---

## Resumen rápido

| Área | Estado |
| --- | --- |
| Plataforma web (auth, QR, Neon, admin, reportes) | ✅ Entregada y verificada |
| Integración del motor por usuario (worker + SQLite por bot) | ✅ Implementada |
| Enrutamiento de webhooks por sesión WAHA | ✅ Implementado |
| Ingesta real de `message_in` / `message_out` | ✅ Implementada |
| Servicio `platform` en Docker + CI + smoke test | ✅ Implementado |
| Rotación de credenciales expuestas | ⚠️ **P0 — requiere acción humana en consolas externas** |
| HTTPS / variables de producción | ⚠️ P0 — depende del despliegue |
| Unificación de documentación | ✅ Parcial: ver `DATABASE.md` y `OPERATIONS.md` |
| Ordenación de cambios en git | ✅ Commits separados por origen |
| Bot legado | ✅ Conservado como modo single-user; registro cerrado |

---

## P0 — Seguridad (hacer antes de cualquier despliegue)

Estas tareas **no se pueden ejecutar desde el repositorio**: requieren acceso a
las consolas de Neon y WAHA. Quedan como responsabilidad del operador.

- [ ] **Rotar la contraseña de Neon.** La cadena de conexión se publicó en claro.
  - Consola Neon → *Connection Details* → *Reset password*.
  - Actualizar `DATABASE_URL` (pooler + `sslmode=require&channel_binding=require`).
  - Verificar con `npm run platform:migrate`.
- [ ] **Rotar `WAHA_ADMIN_API_KEY`** si fue compartida por algún canal.
- [ ] **Rotar `WAHA_WEBHOOK_HMAC_KEY`** compartida (actualizar también en WAHA).
- [ ] **Revisar el historial de git** en busca de secretos (`git log -p`, `git filter-repo`).
- [ ] **Variables de producción:** `COOKIE_SECURE=true`, `APP_BASE_URL=https://…`,
      `ALLOW_PUBLIC_REGISTRATION=false`, `ADMIN_PASSWORD` fuerte y único.
- [ ] **HTTPS** delante de la app (Caddy/Nginx/Traefik) con `TRUST_PROXY=true`.
- [ ] Smoke test en producción: `npm run smoke:platform` con `PLATFORM_BASE_URL`.

> El código ya viene con `ALLOW_PUBLIC_REGISTRATION=false` por defecto y con
> `/ready` devolviendo 503 si WAHA está caído. La API key de cada bot se guarda
> como hash (autenticación) **y** cifrada en AES-256-GCM (para el worker).

---

## P1 — Integración del motor multiusuario ✅ COMPLETADO

Arquitectura elegida: **A) un motor por bot, preservando SQLite**.

- [x] **Enrutamiento de webhooks por sesión.** `src/platform/routes/webhook.ts`
  verifica la firma HMAC, lee `event.session` y delega en
  `BotEngineHost.handleWebhook()`. `findBotBySession()` solo devuelve bots
  habilitados de usuarios activos.
- [x] **Motor por bot.** `src/platform/worker-host.ts` crea, por cada bot
  habilitado, un `InboundWorker`, una SQLite en `ENGINE_DATA_DIR/<botId>/bot.db`,
  un `WahaClient` con su propia sesión y toda la cadena de servicios. Se
  sincroniza cada 30 s (altas, bajas y rotación de API key).
- [x] **Ingesta real de eventos.** `src/platform/ingest-client.ts` envía
  `message_in` / `message_out` a `POST /api/ingest/events` con la API key del
  bot (descifrada en memoria). `ConversationService` acepta un callback
  opcional `onEvent` que no altera el comportamiento del bot legado.
- [x] **Aislamiento de datos.** Cada bot tiene su propio archivo SQLite; la
  plataforma filtra reportes por `user_id` / `bot_id`.
- [x] **Pruebas de integración.** `tests/platform-integration.test.ts` cubre
  cifrado de la key, ingesta con key correcta, rechazo HMAC y enrutamiento de
  dos sesiones distintas sin cruce de eventos.

**Bot legado:** se conserva en `/admin` (single-user) y sigue siendo el destino
del webhook de WAHA. Reenvía los eventos de otras sesiones a la plataforma
(`PLATFORM_WEBHOOK_URL`). Registro público desactivado: el administrador crea
usuarios.

---

## P1 — Despliegue ✅ COMPLETADO

- [x] Servicio `platform` en `docker-compose.yml` (puerto **4001**, sin colisión
  con el bot en 4000) con `env_file`, healthcheck, `depends_on` y volumen propio.
- [x] El bot legado reenvía las sesiones ajenas a `http://platform:4001/webhook`
  sin cambiar el `WHATSAPP_HOOK_URL` de WAHA (legacy sigue funcionando solo).
- [x] Healthcheck de WAHA para poder esperar `service_healthy`.
- [x] CI: `.github/workflows/ci.yml` ejecuta `typecheck`, `lint`, `test`, `build`.
- [x] `npm run platform:migrate` documentado como paso de release (además de
  ejecutarse automáticamente al arrancar).
- [x] `npm run smoke:platform` verifica `/health`, `/ready` y la SPA.

---

## P2 — Limpieza y documentación

- [x] README distingue bot legado vs plataforma y enlaza ambos documentos.
- [x] `PLATFORM_DEPLOYMENT.md` describe la arquitectura del motor por bot y el
  despliegue real en Docker.
- [x] `DATABASE.md` incluye el esquema PostgreSQL de la plataforma.
- [x] `OPERATIONS.md` incluye el runbook de la plataforma.
- [x] Retención de `usage_events` y limpieza de sesiones vencidas
  (`cleanupPlatformData`, cada 6 h, `USAGE_EVENT_RETENTION_DAYS=90`).

---

## P2 — Ordenación de git ✅ COMPLETADO

Dos commits separados por origen:

| Commit | Archivos |
| --- | --- |
| `feat(platform): sistema multiusuario con motor por bot` | `src/platform/`, `public/platform/`, `tests/platform*`, `.env.example`, `package.json`, `package-lock.json`, `docs/PLATFORM_DEPLOYMENT.md`, `docs/PENDIENTE.md`, `docker-compose.yml`, `.github/workflows/ci.yml`, `scripts/smoke-platform.mjs`, `src/routes/webhook.ts`, `src/services/conversation-service.ts` |
| `feat(admin): rediseño del panel de citas` | `public/admin/*`, `Design.md` |

Nunca commitear `.env` (ya ignorado y nunca trackeado).
