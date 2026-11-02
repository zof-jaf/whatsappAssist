import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import express, { type ErrorRequestHandler, type Request } from 'express';
import helmet from 'helmet';
import pinoHttp, {
  type HttpLogger,
  type Options as PinoHttpOptions,
} from 'pino-http';
import type { AppConfig } from './config.js';
import type { Db } from './db/database.js';
import type { Repositories } from './db/repositories/index.js';
import type { WahaClient } from './clients/waha.js';
import type { OllamaClient } from './clients/ollama.js';
import type { ConversationService } from './services/conversation-service.js';
import type { HealthService } from './services/health-service.js';
import type { InboundWorker } from './services/worker.js';
import type { Logger } from './logger.js';
import { createAdminAuthMiddleware } from './middleware/admin-auth.js';
import { createWebhookHmacMiddleware, type RawBodyRequest } from './middleware/webhook-hmac.js';
import { createAdminRouter } from './routes/admin.js';
import { createWebhookRouter } from './routes/webhook.js';
import { AppError } from './errors.js';
import { APP_VERSION } from './version.js';
import { errorMessage } from './utils/async.js';

export interface AppDependencies {
  config: AppConfig;
  db: Db;
  repos: Repositories;
  waha: WahaClient;
  ollama: OllamaClient;
  conversations: ConversationService;
  health: HealthService;
  worker?: InboundWorker;
  logger: Logger;
  publicDir: string;
}

export function createApp(deps: AppDependencies): express.Express {
  const { config, repos, conversations, health, worker, logger, publicDir } =
    deps;
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.server.trustProxy);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          baseUri: ["'none'"],
          fontSrc: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          imgSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          connectSrc: ["'self'"],
          // El panel se sirve por HTTP local (http://localhost:4000/admin).
          // Si se activara upgrade-insecure-requests, el navegador intentaría
          // cargar los assets por HTTPS y el panel quedaría en blanco.
          upgradeInsecureRequests: null,
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  const createHttpLogger = pinoHttp as unknown as (
    options: PinoHttpOptions,
  ) => HttpLogger;

  app.use(
    createHttpLogger({
      logger,
      genReqId: (req, res) => {
        const header = req.headers['x-webhook-request-id'];
        const id =
          typeof header === 'string' && header.length > 0
            ? header
            : randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      autoLogging: {
        ignore: (req) =>
          req.url === '/health' ||
          req.url === '/ready' ||
          req.url === '/favicon.ico',
      },
      customLogLevel: (_req, res, error) => {
        if (error || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
    }),
  );

  app.use(
    express.json({
      limit: config.server.bodyLimit,
      verify: (req, _res, buffer) => {
        (req as RawBodyRequest).rawBody = Buffer.from(buffer);
      },
    }),
  );

  app.get('/', (_req, res) => {
    res.json({
      name: 'whatsapp-ai-bot',
      version: APP_VERSION,
      admin: '/admin',
      health: '/health',
      ready: '/ready',
    });
  });

  app.get('/version', (_req, res) => {
    res.json({ version: APP_VERSION });
  });

  app.get('/health', (_req, res) => {
    const liveness = health.liveness();
    res.status(liveness.ok ? 200 : 503).json({
      status: liveness.ok ? 'ok' : 'error',
      version: APP_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      db: liveness,
      checkedAt: new Date().toISOString(),
    });
  });

  app.get('/ready', async (_req, res) => {
    const readiness = await health.readiness();
    res.status(readiness.ok ? 200 : 503).json({
      status: readiness.ok ? 'ready' : 'not_ready',
      version: APP_VERSION,
      ...readiness.snapshot,
      worker: worker?.snapshot() ?? null,
    });
  });

  app.use(
    createWebhookHmacMiddleware(config.waha.hmacKey, logger),
    createWebhookRouter({ config, repos, logger }),
  );

  app.use(
    '/api/admin',
    createAdminAuthMiddleware(config),
    createAdminRouter({
      config,
      repos,
      health,
      conversations,
      worker,
    }),
  );

  app.use(
    '/admin',
    express.static(join(publicDir, 'admin'), {
      index: 'index.html',
      etag: true,
      maxAge: 0,
    }),
  );

  app.use((req, res) => {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: `Ruta no encontrada: ${req.method} ${req.path}`,
      },
    });
  });

  const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
    if (res.headersSent) return;

    const requestId = (req as Request & { id?: string | number }).id;
    const bodyParseError =
      typeof error === 'object' &&
      error !== null &&
      'type' in error &&
      (error as { type?: string }).type === 'entity.parse.failed';

    if (bodyParseError) {
      res.status(400).json({
        error: {
          code: 'INVALID_JSON',
          message: 'El cuerpo de la petición no es JSON válido',
        },
      });
      return;
    }

    const appError =
      error instanceof AppError
        ? error
        : new AppError(errorMessage(error), { cause: error });
    const status = appError.statusCode;
    const log = status >= 500 ? logger.error : logger.warn;
    log.call(
      logger,
      {
        requestId,
        method: req.method,
        path: req.path,
        status,
        code: appError.code,
        err: errorMessage(error),
        stack: status >= 500 ? (error instanceof Error ? error.stack : undefined) : undefined,
      },
      'Error HTTP',
    );

    const payload: {
      error: {
        code: string;
        message: string;
        details?: unknown;
      };
    } = {
      error: {
        code: appError.code,
        message: appError.expose ? appError.message : 'Error interno del servidor',
      },
    };

    if (appError.expose && appError.details !== undefined) {
      payload.error.details = appError.details;
    }

    res.status(status).json(payload);
  };

  app.use(errorHandler);

  return app;
}
