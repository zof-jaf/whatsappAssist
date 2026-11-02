import 'dotenv/config';
import { resolve } from 'node:path';
import { loadConfig, type AppConfig } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { closeDatabase, openDatabase, type Db } from './db/database.js';
import { createRepositories, type Repositories } from './db/repositories/index.js';
import { WahaClient } from './clients/waha.js';
import { OllamaClient } from './clients/ollama.js';
import { SummaryService } from './services/summary-service.js';
import { ConversationService } from './services/conversation-service.js';
import { HealthService } from './services/health-service.js';
import { InboundWorker } from './services/worker.js';
import { MaintenanceService } from './services/maintenance-service.js';
import { createApp } from './app.js';
import { APP_VERSION } from './version.js';
import { ConfigError } from './errors.js';
import { errorMessage } from './utils/async.js';
import type { Server } from 'node:http';

interface Runtime {
  config: AppConfig;
  logger: Logger;
  db: Db;
  repos: Repositories;
  server: Server;
  worker: InboundWorker;
  maintenance: MaintenanceService;
  health: HealthService;
}

async function main(): Promise<void> {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (error) {
    const message =
      error instanceof ConfigError ? error.message : errorMessage(error);
    // Todavía no existe logger configurado.
    console.error(`\n[whatsapp-ai-bot] ${message}\n`);
    process.exit(1);
  }

  const logger = createLogger({
    level: config.logging.level,
    pretty: config.logging.pretty,
  });

  logger.info(
    {
      version: APP_VERSION,
      node: process.version,
      env: config.env,
      model: config.ollama.model,
      botEnabled: config.bot.enabled,
      adminEnabled: config.admin.enabled,
    },
    'Iniciando whatsapp-ai-bot',
  );

  if (!config.waha.apiKey) {
    logger.warn(
      'WAHA_API_KEY no está configurada. WAHA puede rechazar las llamadas si generó una clave automática.',
    );
  }
  if (!config.waha.hmacKey) {
    logger.warn(
      'WAHA_WEBHOOK_HMAC_KEY no está configurada: los webhooks no se autentican. Configurala en .env.',
    );
  }
  if (config.bot.allowedChatIds.size === 0) {
    logger.warn(
      'ALLOWED_CHAT_IDS está vacía: el bot responderá a cualquier chat directo que le escriba. Para uso personal, considerá restringirlo.',
    );
  }

  let db: Db;
  try {
    db = openDatabase(config.db.path);
  } catch (error) {
    logger.error(
      { err: errorMessage(error), path: config.db.path },
      'No se pudo abrir la base de datos',
    );
    process.exit(1);
  }

  const repos = createRepositories(db);
  const waha = new WahaClient(config.waha);
  const ollama = new OllamaClient(config.ollama);
  const health = new HealthService(config, db, repos, waha, ollama);
  const summaries = new SummaryService(config, repos, ollama, logger);
  const conversations = new ConversationService(
    config,
    repos,
    waha,
    ollama,
    summaries,
    logger,
  );
  const worker = new InboundWorker(config, repos.jobs, conversations, logger);
  const maintenance = new MaintenanceService(config, db, repos, logger);

  const app = createApp({
    config,
    db,
    repos,
    waha,
    ollama,
    conversations,
    health,
    worker,
    logger,
    publicDir: resolve(process.cwd(), 'public'),
  });

  const server = app.listen(config.server.port, config.server.host, () => {
    logger.info(
      {
        url: `http://localhost:${config.server.port}`,
        admin: `http://localhost:${config.server.port}/admin`,
        wahaDashboard: `${config.waha.publicUrl}/dashboard`,
      },
      'Servidor HTTP escuchando',
    );

    worker.start();
    maintenance.start();
    void logStartupHealth({ config, logger, health });
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  const runtime: Runtime = {
    config,
    logger,
    db,
    repos,
    server,
    worker,
    maintenance,
    health,
  };

  let shuttingDown = false;

  const shutdown = async (
    state: Runtime,
    reason: string,
    exitCode = 0,
  ): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    state.logger.info({ reason }, 'Iniciando cierre ordenado');
    const force = setTimeout(() => {
      state.logger.error('Cierre forzado por timeout');
      process.exit(1);
    }, 25_000);
    force.unref?.();

    state.maintenance.stop();

    await new Promise<void>((resolveClose) => {
      state.server.close(() => resolveClose());
      state.server.closeIdleConnections();
      const timer = setTimeout(() => {
        state.server.closeAllConnections();
        resolveClose();
      }, 5000);
      timer.unref?.();
    });

    await state.worker.stop();

    try {
      closeDatabase(state.db);
    } catch (error) {
      state.logger.warn(
        { err: errorMessage(error) },
        'No se pudo cerrar la base de datos limpiamente',
      );
    }

    state.logger.info('Cierre completado');
    process.exit(exitCode);
  };

  server.on('error', (error) => {
    logger.error({ err: errorMessage(error) }, 'Error del servidor HTTP');
    void shutdown(runtime, 'server_error', 1);
  });

  process.on('SIGINT', () => {
    void shutdown(runtime, 'SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown(runtime, 'SIGTERM');
  });
  process.on('uncaughtException', (error) => {
    logger.error(
      { err: errorMessage(error), stack: error.stack },
      'Excepción no capturada',
    );
    void shutdown(runtime, 'uncaughtException', 1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error(
      { err: errorMessage(reason) },
      'Promesa rechazada sin manejar',
    );
    void shutdown(runtime, 'unhandledRejection', 1);
  });
}

async function logStartupHealth(input: {
  config: AppConfig;
  logger: Logger;
  health: HealthService;
}): Promise<void> {
  try {
    const snapshot = await input.health.snapshot(true);
    input.logger.info(
      {
        db: snapshot.db.ok,
        waha: { ok: snapshot.waha.ok, status: snapshot.waha.status },
        ollama: {
          ok: snapshot.ollama.ok,
          hasModel: snapshot.ollama.hasModel,
          models: snapshot.ollama.models.length,
        },
        queue: snapshot.queue,
      },
      'Estado inicial de dependencias',
    );

    if (!snapshot.ollama.hasModel) {
      input.logger.warn(
        {
          model: input.config.ollama.model,
          command: `docker compose exec ollama ollama pull ${input.config.ollama.model}`,
        },
        'El modelo configurado no está descargado en Ollama',
      );
    }
    if (!snapshot.waha.ok) {
      input.logger.warn(
        {
          dashboard: input.health.dashboardUrl,
        },
        'WAHA no está disponible todavía. Revisá el contenedor y escaneá el QR.',
      );
    } else if (snapshot.waha.status !== 'WORKING') {
      input.logger.warn(
        {
          status: snapshot.waha.status,
          dashboard: input.health.dashboardUrl,
        },
        'La sesión de WhatsApp no está en estado WORKING',
      );
    }
  } catch (error) {
    input.logger.warn(
      { err: errorMessage(error) },
      'No se pudo verificar el estado inicial',
    );
  }
}

void main().catch((error) => {
  console.error('[whatsapp-ai-bot] Error fatal:', error);
  process.exit(1);
});
