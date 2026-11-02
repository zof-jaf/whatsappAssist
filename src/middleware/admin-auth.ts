import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { AppConfig } from '../config.js';

function safeEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left).digest();
  const rightHash = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

export function createAdminAuthMiddleware(config: AppConfig): RequestHandler {
  return (req, res, next) => {
    if (!config.admin.enabled) {
      res.status(404).json({
        error: { code: 'ADMIN_DISABLED', message: 'Panel deshabilitado' },
      });
      return;
    }

    const header = req.get('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    const provided = match?.[1]?.trim();

    if (!provided || !safeEqual(provided, config.admin.token)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Token de administración inválido o ausente',
        },
      });
      return;
    }

    res.setHeader('Cache-Control', 'no-store');
    next();
  };
}
