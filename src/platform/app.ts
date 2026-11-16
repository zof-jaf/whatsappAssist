import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import { ZodError } from 'zod';
import type { PlatformDeps } from './context.js';
import { createSessionMiddleware } from './auth.js';
import { createAuthRouter } from './routes/auth.js';
import { createBotsRouter } from './routes/bots.js';
import { createIngestRouter } from './routes/ingest.js';
import { createAdminRouter } from './routes/admin.js';
import { createReportsRouter } from './routes/reports.js';
import { createPlatformWebhookRouter } from './routes/webhook.js';
import { ping } from './db.js';

export function createPlatformApp(deps: PlatformDeps, publicDir: string): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', deps.config.TRUST_PROXY);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          baseUri: ["'none'"],
          fontSrc: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          // Se permiten data: URI para mostrar el QR devuelto por WAHA en base64.
          imgSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          connectSrc: ["'self'"],
          upgradeInsecureRequests: deps.config.isProduction ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.use(
    express.json({
      limit: deps.config.BODY_LIMIT,
      verify: (req, _res, buffer) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buffer;
      },
    }),
  );

  // Se aplica a TODAS las rutas para que req.authUser esté disponible en bots,
  // reportes y administración (no solo en /api/auth).
  app.use(createSessionMiddleware(deps.config, deps.db));

  app.use((req, res, next) => {
    const id = randomUUID();
    res.setHeader('X-Request-Id', id);
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'whatsapp-platform',
      uptime: process.uptime(),
      engines: deps.engines.snapshot().length,
    });
  });

  app.get('/ready', async (_req, res) => {
    const [dbOk, wahaOk] = await Promise.all([ping(deps.db), deps.waha.health()]);
    res.status(dbOk && wahaOk ? 200 : 503).json({
      status: dbOk && wahaOk ? 'ready' : 'not_ready',
      db: dbOk ? 'up' : 'down',
      waha: wahaOk ? 'up' : 'down',
    });
  });

  app.use(createPlatformWebhookRouter(deps, deps.engines));

  app.use('/api/auth', createAuthRouter(deps));
  app.use('/api/bots', createBotsRouter(deps));
  app.use('/api/ingest', createIngestRouter(deps));
  app.use('/api/admin', createAdminRouter(deps));
  app.use('/api/reports', createReportsRouter(deps));

  app.use(
    express.static(join(publicDir, 'platform'), {
      index: 'index.html',
      etag: true,
      maxAge: 0,
    }),
  );

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Ruta no encontrada.' } });
  });

  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.headersSent) return;
    if (error instanceof ZodError) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Datos inválidos.',
          details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const status = typeof error?.status === 'number' ? error.status : 500;
    deps.logger.error({ err: message, status }, 'Error HTTP en plataforma');
    res.status(status >= 400 && status < 500 ? status : 502).json({
      error: {
        code: status >= 500 ? 'UPSTREAM_ERROR' : 'BAD_REQUEST',
        message: status >= 500 ? 'Error al contactar un servicio (WAHA/Base de datos).' : message,
      },
    });
  };
  app.use(errorHandler);

  return app;
}
