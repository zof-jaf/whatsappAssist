import 'dotenv/config';
import { resolve } from 'node:path';
import type { Server } from 'node:http';
import { loadPlatformConfig } from './config.js';
import { createPool, migrate, ping } from './db.js';
import { createRateLimiter } from './auth.js';
import { findUserByEmail, insertUser } from './repositories.js';
import { hashPassword } from './crypto.js';
import { WahaAdminClient } from './waha-admin.js';
import { createBotEngineHost } from './worker-host.js';
import { cleanupPlatformData } from './repositories.js';
import { createPlatformApp } from './app.js';
import type { PlatformDeps } from './context.js';

function createLogger(level: string): PlatformDeps['logger'] {
  const enabled = (name: string) => {
    const order = ['debug', 'info', 'warn', 'error'];
    return order.indexOf(name) >= order.indexOf(level);
  };
  const emit = (name: string) => (obj: unknown, msg?: string) => {
    if (!enabled(name)) return;
    const time = new Date().toISOString();
    console.log(`[${time}] ${name.toUpperCase()} ${msg ?? ''}`, obj ?? '');
  };
  return { info: emit('info'), warn: emit('warn'), error: emit('error') };
}

async function seedAdmin(deps: PlatformDeps): Promise<void> {
  const { config, db, logger } = deps;
  const existing = await findUserByEmail(db, config.ADMIN_EMAIL);
  if (existing) {
    logger.info({ email: config.ADMIN_EMAIL }, 'Administrador ya existente');
    return;
  }
  await insertUser(db, {
    email: config.ADMIN_EMAIL,
    passwordHash: await hashPassword(config.ADMIN_PASSWORD),
    fullName: config.ADMIN_FULL_NAME,
    role: 'admin',
    canCreateBots: true,
  });
  logger.info({ email: config.ADMIN_EMAIL }, 'Administrador creado (seed)');
}

async function main(): Promise<void> {
  const config = loadPlatformConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const db = createPool(config);

  logger.info(
    { host: config.HOST, port: config.PORT, db: 'neon-postgres', waha: config.WAHA_BASE_URL },
    'Iniciando plataforma WhatsApp multiusuario',
  );

  if (!config.WAHA_ADMIN_API_KEY) {
    logger.warn('WAHA_ADMIN_API_KEY no configurada: WAHA podría rechazar la gestión de sesiones.');
  }

  await migrate(db);
  if (!(await ping(db))) throw new Error('No se pudo conectar a PostgreSQL (Neon).');

  const deps: PlatformDeps = {
    config,
    db,
    waha: new WahaAdminClient(config),
    // Se asigna justo debajo: el host necesita las deps ya construidas.
    engines: undefined as unknown as PlatformDeps['engines'],
    // 10 intentos / 15 min por IP+correo.
    rateLimiter: createRateLimiter(10, 15 * 60_000),
    logger,
  };
  deps.engines = createBotEngineHost(deps);

  await seedAdmin(deps);

  const app = createPlatformApp(deps, resolve(process.cwd(), 'public'));
  const server: Server = app.listen(config.PORT, config.HOST, () => {
    logger.info(
      { url: config.APP_BASE_URL, login: `${config.APP_BASE_URL}/` },
      'Plataforma escuchando',
    );

    void deps.engines.sync().then((result) => {
      logger.info(result, 'Motores de bots sincronizados');
    });
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  // sincroniza altas/bajas de bots y rota keys sin reiniciar el proceso.
  const engineTimer = setInterval(() => {
    void deps.engines.sync().catch((error) => {
      logger.warn({ err: String(error) }, 'No se pudo sincronizar los motores');
    });
  }, 30_000);
  engineTimer.unref?.();

  // limpieza de eventos de uso y sesiones vencidas.
  if (config.USAGE_EVENT_RETENTION_DAYS > 0) {
    const retentionTimer = setInterval(() => {
      void cleanupPlatformData(db, config.USAGE_EVENT_RETENTION_DAYS)
        .then((result) => {
          logger.info(result, 'Limpieza de datos de plataforma completada');
        })
        .catch((error) => {
          logger.warn({ err: String(error) }, 'No se pudo limpiar los datos de plataforma');
        });
    }, 6 * 60 * 60_000);
    retentionTimer.unref?.();
  }

  let closed = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (closed) return;
    closed = true;
    logger.info({ reason }, 'Cerrando plataforma');
    clearInterval(engineTimer);
    const force = setTimeout(() => process.exit(1), 20_000);
    force.unref?.();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await deps.engines.stop();
    await db.end();
    clearTimeout(force);
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('uncaughtException', (error) => {
    logger.error({ err: error.message, stack: error.stack }, 'Excepción no capturada');
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: String(reason) }, 'Promesa rechazada');
  });
}

void main().catch((error) => {
  console.error('[plataforma] Error fatal:', error);
  process.exit(1);
});
