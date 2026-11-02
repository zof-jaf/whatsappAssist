# Operación y mantenimiento

Runbook para instalar, operar, monitorear y recuperar el bot. Los comandos están pensados para Windows/PowerShell con Docker Compose v2. En Linux/macOS son equivalentes.

---

## 1. Arranque y parada

### Arrancar

```powershell
npm run setup          # solo la primera vez
docker compose up -d --build
```

### Ver estado

```powershell
docker compose ps
docker compose logs --tail=100 bot
docker compose logs --tail=100 waha
```

### Detener

```powershell
docker compose stop
```

### Detener y eliminar contenedores (conserva volúmenes)

```powershell
docker compose down
```

### Detener y eliminar también los datos

> Esto borra la base, las sesiones de WAHA y el modelo descargado.

```powershell
docker compose down -v
```

### Reiniciar solo el bot

```powershell
docker compose restart bot
```

### Recrear el bot tras cambiar `.env`

```powershell
docker compose up -d --force-recreate bot
```

---

## 2. Servicios y estados esperados

| Servicio | Estado normal | Notas |
|---|---|---|
| `waha` | `running` | Debe quedar `healthy` si el healthcheck está disponible |
| `ollama` | `running` | El modelo debe aparecer en `ollama list` |
| `ollama-init` | `exited (0)` | Tarea de descarga; se puede volver a ejecutar |
| `waha-init` | `exited (0)` | Crea/arranca la sesión; idempotente |
| `bot` | `running` | `/health` responde 200 |

Si `ollama-init` o `waha-init` aparecen como `exited (0)`, es correcto.

---

## 3. Healthchecks y monitoreo

### Liveness

```powershell
curl.exe -s http://localhost:4000/health
```

Respuesta esperada:

```json
{
  "status": "ok",
  "version": "1.0.0",
  "db": { "ok": true }
}
```

Solo comprueba SQLite. Si falla, el proceso está roto o la base no se puede abrir.

### Readiness

```powershell
curl.exe -s http://localhost:4000/ready
```

Deve devolver `200` y `"status": "ready"` cuando:

- SQLite responde;
- WAHA responde y la sesión está `WORKING`;
- Ollama responde y el modelo configurado está descargado.

Si devuelve `503` y `"status": "not_ready"`, revisá el campo `waha` y `ollama` de la respuesta.

### Monitoreo externo

- `/health`: cada 30 s; alerta si falla 3 veces seguidas.
- `/ready`: cada 60 s; alerta si falla durante más de 5 minutos.
- Espacio en disco: menos de 15 % libre.
- Backup: alerta si no hay un archivo nuevo en 24 h.

El healthcheck de Docker usa `/health`, no `/ready`, para no reiniciar el contenedor mientras se espera el QR o la descarga del modelo.

---

## 4. Logs

```powershell
# Bot en vivo
docker compose logs -f --tail=100 bot

# WAHA
docker compose logs -f --tail=100 waha

# Ollama
docker compose logs -f --tail=100 ollama

# Inicializadores
docker compose logs ollama-init
docker compose logs waha-init
```

Los logs son JSON en producción. Eventos útiles:

| Mensaje | Significado |
|---|---|
| `Mensaje encolado para procesamiento` | Webhook aceptado |
| `Mensaje entrante guardado` | Se persistió el entrante |
| `Respuesta de IA enviada` | Respuesta generada y enviada |
| `Respuesta enviada por WhatsApp` | WAHA aceptó el envío |
| `Trabajo falló; se reintentará` | Error transitorio |
| `Trabajo agotó sus intentos` | Requiere intervención |
| `Resumen de conversación actualizado` | Resumen generado |
| `WAHA requiere escanear el código QR` | Sesión sin vincular |
| `Webhook rechazado: firma HMAC incorrecta` | Secreto distinto entre WAHA y bot |

Cada request tiene `X-Request-Id`; WAHA envía `X-Webhook-Request-Id`, que se usa como ID de correlación.

---

## 5. Operaciones frecuentes

### Volver a escanear el QR

1. Abrí `http://localhost:3000/dashboard`.
2. Iniciá sesión con `WAHA_DASHBOARD_USERNAME` / `WAHA_DASHBOARD_PASSWORD`.
3. Buscá la sesión `default`.
4. Si está detenida, iniciala.
5. Escaneá el QR.

También:

```powershell
npm run waha:init
```

### Cambiar el modelo

```powershell
# 1. Editar OLLAMA_MODEL en .env
# 2. Descargar el modelo
docker compose run --rm ollama-init

# 3. Recrear el bot para que lea la nueva configuración
docker compose up -d --force-recreate bot
```

Verificar:

```powershell
docker compose exec ollama ollama list
curl.exe -s http://localhost:4000/ready
```

### Activar o desactivar la IA de un chat

Desde el panel: **Conversaciones → elegir chat → IA activada/desactivada**.

O por API:

```powershell
$token = "tu-admin-token"
Invoke-RestMethod -Method Patch `
  -Uri "http://localhost:4000/api/admin/conversations/1" `
  -Headers @{ Authorization = "Bearer $token" } `
  -ContentType "application/json" `
  -Body '{"aiEnabled":false}'
```

### Archivar una conversación

```powershell
Invoke-RestMethod -Method Patch `
  -Uri "http://localhost:4000/api/admin/conversations/1" `
  -Headers @{ Authorization = "Bearer $token" } `
  -ContentType "application/json" `
  -Body '{"status":"archived"}'
```

El bot no responde en conversaciones archivadas, pero el historial queda.

### Resetear el contexto

Desde el panel o:

```powershell
Invoke-RestMethod -Method Post `
  -Uri "http://localhost:4000/api/admin/conversations/1/reset" `
  -Headers @{ Authorization = "Bearer $token" }
```

No borra mensajes. La próxima respuesta solo usa lo que llegue después.

### Reintentar un trabajo fallido

Panel: **Sistema → Trabajos fallidos → Reintentar**.

API:

```powershell
Invoke-RestMethod -Method Post `
  -Uri "http://localhost:4000/api/admin/jobs/12/retry" `
  -Headers @{ Authorization = "Bearer $token" }
```

### Reintentar un envío fallido

Panel: abrir el mensaje fallido → **Reintentar envío**.

API:

```powershell
Invoke-RestMethod -Method Post `
  -Uri "http://localhost:4000/api/admin/messages/34/retry" `
  -Headers @{ Authorization = "Bearer $token" }
```

### Exportar una conversación

Panel: **Conversaciones → Exportar**.

API:

```powershell
Invoke-WebRequest `
  -Uri "http://localhost:4000/api/admin/conversations/1/export" `
  -Headers @{ Authorization = "Bearer $token" } `
  -OutFile "conversacion-1.json"
```

---

## 6. Backups

### Manual

Con Docker:

```powershell
docker compose exec bot node scripts/backup.mjs
docker compose cp bot:/app/backups/. ./backups/
```

Sin Docker:

```powershell
npm run backup
```

### Automático en Windows

Crear una tarea programada que ejecute:

```powershell
cd C:\Users\Lenovo\Documents\julian\whatsapp
docker compose exec -T bot node scripts/backup.mjs
docker compose cp bot:/app/backups/. .\backups\
```

Frecuencia sugerida: cada 6 o 12 horas. Retención: `BACKUP_RETENTION_DAYS=14` o más.

### Verificar un backup

```powershell
# Copiar el backup fuera del contenedor y abrirlo en modo solo lectura
docker compose cp bot:/app/backups/bot-XXXX.db ./backups/verificar.db
node -e "const D=require('better-sqlite3');const db=new D('./backups/verificar.db',{readonly:true});console.log(db.pragma('integrity_check'));console.log(db.prepare('select count(*) c from messages').get());db.close();"
```

Debe devolver `integrity_check: [ { integrity_check: 'ok' } ]`.

### Restaurar

```powershell
docker compose stop bot
docker compose cp .\backups\bot-XXXX.db bot:/app/data/bot.db
docker compose run --rm --entrypoint sh bot -c "rm -f /app/data/bot.db-wal /app/data/bot.db-shm"
docker compose up -d bot
docker compose logs --tail=50 bot
```

Verificar:

```powershell
curl.exe -s http://localhost:4000/health
```

> Si restaurás una base de otra versión del esquema, el bot aplicará las migraciones pendientes al arrancar. Hacé un backup antes de cada actualización.

---

## 7. Disco y mantenimiento

### Ver uso

```powershell
docker system df
docker compose exec bot du -sh /app/data /app/backups
```

### Crecimiento esperado

- Cada mensaje de texto ocupa unos cientos de bytes.
- Los eventos del webhook son la parte que más crece; se purgan a los `EVENT_RETENTION_DAYS` días.
- Los backups ocupan aproximadamente el tamaño de la base cada uno.
- El modelo de Ollama puede ocupar entre 2 GB y 5 GB.
- El volumen `waha_media` guarda los archivos multimedia sin vencimiento (`WHATSAPP_FILES_LIFETIME=0`). Si el disco es limitado, programá una limpieza de archivos viejos o cambiá ese valor en `docker-compose.yml`.

### Limpieza segura

```powershell
# Backups viejos (el script ya aplica retención)
npm run backup

# Imágenes y capas sin usar
docker image prune

# Contenedores detenidos
docker container prune
```

No ejecutes `docker volume prune` sin estar seguro: puede borrar `bot_data`, `waha_sessions` y `ollama_data`.

### VACUUM

Solo con el bot detenido y después de un backup:

```powershell
docker compose stop bot
docker compose run --rm --entrypoint sh bot -c "node -e \"const D=require('better-sqlite3');const db=new D('/app/data/bot.db');db.exec('VACUUM');db.close()\""
docker compose up -d bot
```

---

## 8. Actualizaciones

1. Backup:

   ```powershell
   npm run backup
   ```

2. Actualizar código:

   ```powershell
   git pull
   ```

3. Revisar variables nuevas en `.env.example` y agregarlas a `.env` si hace falta.

4. Rebuild:

   ```powershell
   docker compose up -d --build
   ```

5. Verificar:

   ```powershell
   docker compose ps
   curl.exe -s http://localhost:4000/ready
   docker compose logs --tail=100 bot
   ```

Las migraciones se aplican solas. Si una migración falla, el bot no arranca y el error queda en los logs; restaurá el backup y revisá la migración.

---

## 9. Seguridad operativa

- No publiques `3000` (WAHA), `4000` (panel) ni `11434` (Ollama) en internet sin protección.
- Si usás un VPS, accedé por túnel SSH:

  ```powershell
  ssh -L 4000:127.0.0.1:4000 usuario@servidor
  ssh -L 3000:127.0.0.1:3000 usuario@servidor
  ```

- Rotá `ADMIN_TOKEN`, `WAHA_API_KEY`, `WAHA_WEBHOOK_HMAC_KEY` y `WAHA_DASHBOARD_PASSWORD` si sospechás que se filtraron.

  Al rotar `WAHA_WEBHOOK_HMAC_KEY`, recreá WAHA y el bot al mismo tiempo para que ambos usen el nuevo secreto.

- Mantené actualizados WAHA, Ollama y las dependencias de Node.
- Revisá los accesos al panel en los logs (`/api/admin`).
- No compartas el archivo `.env` ni los backups.

---

## 10. Incidentes y recuperación

### El bot no arranca: configuración inválida

Los logs muestran `Configuración inválida: ...`. Corregí `.env` y recreá:

```powershell
docker compose up -d --force-recreate bot
```

### El bot arranca pero `/ready` da 503

| Campo | Causa probable | Acción |
|---|---|---|
| `db.ok=false` | Permisos o archivo corrupto | Revisar volumen, restaurar backup |
| `waha.ok=false` | WAHA caído o API key incorrecta | `docker compose logs waha`, revisar `WAHA_API_KEY` |
| `waha.status=SCAN_QR_CODE` | Sesión sin vincular | Escanear QR |
| `waha.status=FAILED` | Sesión caída | Reiniciar sesión, revisar logs |
| `ollama.ok=false` | Ollama caído | `docker compose logs ollama` |
| `ollama.hasModel=false` | Modelo no descargado | `docker compose run --rm ollama-init` |

### WAHA responde 401

`WAHA_API_KEY` distinta entre el contenedor de WAHA y el bot. Como ambos leen el mismo `.env`, suele pasar tras editar solo un valor o reutilizar un `.env` viejo. Igualá los valores y recreá ambos:

```powershell
docker compose up -d --force-recreate waha bot waha-init
```

### Webhook rechazado por HMAC

`WAHA_WEBHOOK_HMAC_KEY` distinta entre WAHA y el bot, o un proxy que modifica el cuerpo. Recreá ambos servicios con el mismo `.env`. No agregues middlewares que reformateen el JSON antes de la verificación.

### Ollama tarda demasiado o devuelve timeout

- Modelo demasiado grande para la RAM disponible.
- CPU saturada.
- `OLLAMA_TIMEOUT_MS` bajo.

Probá un modelo más chico (`llama3.2:3b`) o aumentá `OLLAMA_TIMEOUT_MS`. El bot responde con `AI_FALLBACK_REPLY` si Ollama falla, y el trabajo queda registrado.

### La cola no avanza

1. Revisar `/api/admin/overview` o la pestaña Sistema.
2. Ver si hay un trabajo `processing` colgado: reiniciar el bot lo devuelve a `pending`.
3. Ver si el primer trabajo de un chat está en `pending` con `next_attempt_at` futuro: bloquea a los siguientes de ese chat por diseño.
4. Revisar `last_error`.

### Base bloqueada (`SQLITE_BUSY`)

- El bot usa WAL y `busy_timeout=5000`.
- Evitá abrir la base con escritores externos.
- Si usás un editor SQLite, abrilo en modo solo lectura.
- No copies el `.db` mientras el bot escribe; usá el script de backup.

### Pérdida de datos

1. Detener el bot.
2. Restaurar el backup más reciente.
3. Verificar integridad.
4. Arrancar y revisar `/ready`.

Si no hay backup, los datos del volumen pueden recuperarse con herramientas forenses de SQLite, pero no hay garantía. La prevención es el backup automático.

---

## 11. Contactos de emergencia (plantilla)

Completar al desplegar:

| Rol | Nombre | Contacto |
|---|---|---|
| Responsable del bot | | |
| Administrador del servidor | | |
| Dueño del número de WhatsApp | | |

---

## 12. Checklist diario / semanal

Diario:

- [ ] `/health` responde 200.
- [ ] `/ready` responde 200.
- [ ] No hay trabajos fallidos nuevos.
- [ ] La sesión de WAHA sigue `WORKING`.

Semanal:

- [ ] Backup reciente y verificable.
- [ ] Espacio en disco suficiente.
- [ ] Logs sin errores repetitivos.
- [ ] Revisar conversaciones con IA desactivada o archivadas por error.
- [ ] Revisar eventos `ignored` por motivos inesperados.
