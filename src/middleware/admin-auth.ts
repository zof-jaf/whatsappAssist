import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { AppConfig } from '../config.js';
import type { AdminAuthService, AdminPublicUser } from '../services/admin-auth-service.js';

export const ADMIN_COOKIE = 'wa_admin_session';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      adminUser?: AdminPublicUser;
      adminSessionToken?: string;
    }
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left).digest();
  const rightHash = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

/** Carga al usuario autenticado desde la cookie de sesión (o el token de reserva). */
export function createAdminSessionMiddleware(
  config: AppConfig,
  auth: AdminAuthService,
): RequestHandler {
  return (req, res, next) => {
    if (!config.admin.enabled) {
      res.status(404).json({
        error: { code: 'ADMIN_DISABLED', message: 'Panel deshabilitado' },
      });
      return;
    }

    const header = req.get('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    const bearer = match?.[1]?.trim();

    // Reserva: el token estático del .env sigue válido para APIs y tests.
    if (bearer && safeEqual(bearer, config.admin.token)) {
      req.adminUser = {
        id: 0,
        username: 'admin',
        fullName: 'Administrador (token de reserva)',
        role: 'admin',
        active: true,
        lastLoginAt: null,
      };
      req.adminSessionToken = bearer;
      res.setHeader('Cache-Control', 'no-store');
      next();
      return;
    }

    const token = parseCookies(req.headers.cookie)[ADMIN_COOKIE] || bearer;
    const user = auth.userFromToken(token);
    if (user) {
      req.adminUser = user;
      req.adminSessionToken = token;
    }

    res.setHeader('Cache-Control', 'no-store');
    next();
  };
}

export const requireAdminAuth: RequestHandler = (req, res, next) => {
  if (!req.adminUser) {
    res.status(401).json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Iniciá sesión para acceder al panel.',
      },
    });
    return;
  }
  next();
};
