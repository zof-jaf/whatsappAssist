import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadConfig, type AppConfig } from '../config.js';
import { createLogger, type Logger } from '../logger.js';
import { closeDatabase, openDatabase, type Db } from '../db/database.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { WahaClient } from '../clients/waha.js';
import { OllamaClient } from '../clients/ollama.js';
import { SummaryService } from '../services/summary-service.js';
import { QuoteService } from '../services/quote-service.js';
import { SchedulingService } from '../services/scheduling-service.js';
import { NotionSettingsService } from '../services/notion-settings-service.js';
import { ResponseGuideService } from '../services/response-guide-service.js';
import { TattooSettingsService } from '../services/tattoo-settings-service.js';
import { ConversationService } from '../services/conversation-service.js';
import { InboundWorker } from '../services/worker.js';
import { MaintenanceService } from '../services/maintenance-service.js';
import {
  processWebhookEvent,
  type WebhookResult,
} from '../routes/webhook.js';
import type { PlatformDeps } from './context.js';
import { decryptSecret } from './crypto.js';
import { createIngestClient, type IngestClient } from './ingest-client.js';
import { listRunnableBots, type BotRow } from './repositories.js';

interface BotEngine {
  bot: BotRow;
  config: AppConfig;
  logger: Logger;
  db: Db;
  repos: Repositories;
  worker: InboundWorker;
  maintenance: MaintenanceService;
  ingestKey: string;
}

export interface BotEngineHost {
  /** Sincroniza los motores con la BD (alta/baja de bots y rotación de key). */
  sync(): Promise<{ running: number; started: number; stopped: number }>;
  /** Procesa un evento de WAHA con el motor dueño de la sesión. */
  handleWebhook(session: string, body: unknown): Promise<WebhookResult>;
  /** Detiene todos los motores y cierra sus bases. */
  stop(): Promise<void>;
  snapshot(): Array<{ botId: string; session: string; running: boolean }>;
}

function engineEnv(deps: PlatformDeps, bot: BotRow): NodeJS.ProcessEnv {
  const botDir = resolve(deps.config.ENGINE_DATA_DIR, bot.id);
  return {
    ...process.env,
    // Cada bot tiene su propio nombre de sesión WAHA y su propia SQLite.
    WAHA_SESSION: bot.waha_session,
    DATABASE_PATH: join(botDir, 'bot.db'),
    // El motor no expone panel ni API administrativa: eso vive en la plataforma.
    ADMIN_ENABLED: 'false',
    // loadConfig exige ADMIN_TOKEN aunque el panel esté deshabilitado.
    ADMIN_TOKEN: process.env.ADMIN_TOKEN ?? 'engine-admin-disabled-0000000000',
    BOT_ENABLED: 'true',
    ALLOWED_CHAT_IDS: '',
    // El token admin de WAHA también sirve para enviar mensajes por sesión.
    WAHA_API_KEY: process.env.WAHA_API_KEY ?? deps.config.WAHA_ADMIN_API_KEY ?? '',
  };
}

async function createEngine(
  deps: PlatformDeps,
  bot: BotRow,
  ingest: IngestClient,
): Promise<BotEngine> {
  const config = loadConfig(engineEnv(deps, bot));
  const dbPath = config.db.path;
  mkdirSync(dirname(dbPath), { recursive: true });

  const logger = createLogger({
    level: config.logging.level,
    pretty: config.logging.pretty,
  });
  const db = openDatabase(dbPath);
  const repos = createRepositories(db);

  const tattoo = new TattooSettingsService(config, repos, logger);
  tattoo.load();
  const notion = new NotionSettingsService(config, repos, logger);
  await notion.initialize();

  const waha = new WahaClient(config.waha);
  const ollama = new OllamaClient(config.ollama);
  const summaries = new SummaryService(config, repos, ollama, logger);
  const quotes = new QuoteService(config, repos, waha, logger);
  const scheduling = new SchedulingService(config, repos, waha, notion, logger);
  const responseGuide = new ResponseGuideService(config, logger);
  const ingestKey = bot.api_key_encrypted
    ? decryptSecret(bot.api_key_encrypted, deps.config.SESSION_SECRET) ?? ''
    : '';

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
    (event) => {
      void ingest.postEvent(ingestKey, { ...event, session: bot.waha_session });
    },
  );

  const worker = new InboundWorker(config, repos.jobs, conversations, logger);
  const maintenance = new MaintenanceService(config, db, repos, logger);

  worker.start();
  maintenance.start();

  return { bot, config, logger, db, repos, worker, maintenance, ingestKey };
}

async function disposeEngine(engine: BotEngine): Promise<void> {
  engine.maintenance.stop();
  await engine.worker.stop();
  try {
    closeDatabase(engine.db);
  } catch (error) {
    engine.logger.warn({ err: String(error) }, 'No se pudo cerrar la SQLite del bot');
  }
}

/**
 * Un motor (worker + SQLite + servicios) por bot habilitado. El webhook de la
 * plataforma resuelve la sesión WAHA y delega en el motor correspondiente.
 */
export function createBotEngineHost(deps: PlatformDeps): BotEngineHost {
  const engines = new Map<string, BotEngine>();
  const ingest = createIngestClient(deps.config, deps.logger);
  let syncing: Promise<unknown> = Promise.resolve();

  async function sync(): Promise<{ running: number; started: number; stopped: number }> {
    // Serializa syncs concurrentes (webhook + timer).
    const previous = syncing;
    let release!: () => void;
    syncing = new Promise<void>((done) => { release = done; });
    await previous;

    try {
      const bots = await listRunnableBots(deps.db);
      const desired = new Set(bots.map((bot) => bot.waha_session));
      let started = 0;
      let stopped = 0;

      for (const [session, engine] of engines) {
        const fresh = bots.find((bot) => bot.waha_session === session);
        if (!desired.has(session)) {
          await disposeEngine(engine);
          engines.delete(session);
          stopped += 1;
        } else if (fresh && fresh.api_key_encrypted !== engine.bot.api_key_encrypted) {
          // La key rotó: hay que reconstruir el motor con la nueva credencial.
          await disposeEngine(engine);
          engines.delete(session);
        }
      }

      for (const bot of bots) {
        if (engines.has(bot.waha_session)) continue;
        try {
          engines.set(bot.waha_session, await createEngine(deps, bot, ingest));
          started += 1;
          deps.logger.info(
            { botId: bot.id, session: bot.waha_session },
            'Motor de bot iniciado',
          );
        } catch (error) {
          deps.logger.error(
            { botId: bot.id, err: String(error) },
            'No se pudo iniciar el motor del bot',
          );
        }
      }

      return { running: engines.size, started, stopped };
    } finally {
      release();
    }
  }

  return {
    sync,

    async handleWebhook(session, body) {
      let engine = engines.get(session);
      if (!engine) {
        await sync();
        engine = engines.get(session);
      }
      if (!engine) {
        return {
          status: 404,
          body: {
            error: {
              code: 'UNKNOWN_SESSION',
              message: 'No hay un bot habilitado para esa sesión WAHA.',
            },
          },
        };
      }
      return processWebhookEvent({
        config: engine.config,
        repos: engine.repos,
        logger: engine.logger,
        expectedSession: session,
      }, body);
    },

    async stop() {
      for (const engine of engines.values()) await disposeEngine(engine);
      engines.clear();
    },

    snapshot() {
      return Array.from(engines.entries()).map(([session, engine]) => ({
        botId: engine.bot.id,
        session,
        running: engine.worker.isRunning,
      }));
    },
  };
}
