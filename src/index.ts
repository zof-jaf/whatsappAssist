import 'dotenv/config';
import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import { loadConfig, type AppConfig } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { closeDatabase, openDatabase, type Db } from './db/database.js';
import { createRepositories, type Repositories } from './db/repositories/index.js';
import { WahaClient } from './clients/waha.js';
import { createAiClient } from './clients/ai-factory.js';
import { SummaryService } from './services/summary-service.js';
import { QuoteService } from './services/quote-service.js';
import { SchedulingService } from './services/scheduling-service.js';
import { NotionSettingsService } from './services/notion-settings-service.js';
import { ResponseGuideService } from './services/response-guide-service.js';
import { TattooSettingsService } from './services/tattoo-settings-service.js';
import { ConversationService } from './services/conversation-service.js';
import { HealthService } from './services/health-service.js';
import { InboundWorker } from './services/worker.js';
import { MaintenanceService } from './services/maintenance-service.js';
import { createApp } from './app.js';
import { APP_VERSION } from './version.js';
import { ConfigError } from './errors.js';
import { errorMessage } from './utils/async.js';
import type { Server } from 'node:http';

/** Reenvía eventos de otras sesiones WAHA a la plataforma multiusuario. */
function createPlatformForwarder(config: AppConfig, logger: Logger) {
  const url = process.env.PLATFORM_WEBHOOK_URL?.trim();
  if (!url) return undefined;

  return async (event: unknown, rawBody?: Buffer): Promise<void> => {
    const body = rawBody ?? Buffer.from(JSON.stringify(event));
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.waha.hmacKey) {
      headers['x-webhook-hmac'] = createHmac('sha512', config.waha.hmacKey)
        .update(body)
        .digest('hex');
      headers['x-webhook-hmac-algorithm'] = 'sha512';
    }
    const response = await fetch(url, { method: 'POST', headers, body });
    if (!response.ok) {
      logger.warn(
        { status: response.status, url },
        'La plataforma rechazó el reenvío de un evento',
      );
    }
  };
}

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
      aiProvider: config.ai.provider,
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
  const tattoo = new TattooSettingsService(config, repos, logger);
  tattoo.load();

  const notion = new NotionSettingsService(config, repos, logger);
  await notion.initialize();

  if (!tattoo.chatId) {
    logger.warn(
      'El número del tatuador no está configurado: cargalo desde el panel (Conectar WhatsApp) o definí TATTOO_ARTIST_CHAT_ID en .env. Sin esto el bot no puede derivar consultas de precio.',
    );
  } else {
    logger.info(
      { chatId: tattoo.chatId, source: tattoo.source },
      'Tatuador configurado para cotizaciones',
    );
  }

  const waha = new WahaClient(config.waha);
  const ollama = createAiClient(config);
  const health = new HealthService(config, db, repos, waha, ollama);
  const summaries = new SummaryService(config, repos, ollama, logger);
  const quotes = new QuoteService(config, repos, waha, logger);
  const scheduling = new SchedulingService(
    config,
    repos,
    waha,
    notion,
    logger,
  );
  const responseGuide = new ResponseGuideService(config, logger);
  const conversations = new ConversationService(
    config,
    repos,
    waha,
    ollama,
    summaries,
    quotes,
    scheduling,
    responseGuide,
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
    tattoo,
    notion,
    worker,
    logger,
    publicDir: resolve(process.cwd(), 'public'),
    onOtherSession: createPlatformForwarder(config, logger),
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
        ai: {
          provider: input.config.ai.provider,
          model: input.config.ollama.model,
          ok: snapshot.ollama.ok,
          hasModel: snapshot.ollama.hasModel,
          models: snapshot.ollama.models.length,
        },
        queue: snapshot.queue,
      },
      'Estado inicial de dependencias',
    );

    if (!snapshot.ollama.hasModel) {
      if (input.config.ai.provider === 'groq') {
        input.logger.warn(
          { model: input.config.ollama.model },
          'El modelo configurado no está disponible en tu cuenta de Groq',
        );
      } else {
        input.logger.warn(
          {
            model: input.config.ollama.model,
            command: `docker compose exec ollama ollama pull ${input.config.ollama.model}`,
          },
          'El modelo configurado no está descargado en Ollama',
        );
      }
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
