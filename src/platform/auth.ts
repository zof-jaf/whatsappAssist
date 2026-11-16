import type { NextFunction, Request, Response } from 'express';
import type { PlatformConfig } from './config.js';
import type { DbPool } from './db.js';
import {
  findActiveSession,
  revokeSession,
  toPublicUser,
  type PublicUser,
  type UserRow,
} from './repositories.js';
import { hashSessionToken } from './crypto.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authUser?: PublicUser;
      authUserRow?: UserRow;
      sessionTokenHash?: string;
    }
  }
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

export function createSessionMiddleware(config: PlatformConfig, db: DbPool) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const token = parseCookies(req.headers.cookie)[config.COOKIE_NAME];
      if (!token) return next();

      const tokenHash = hashSessionToken(token, config.SESSION_SECRET);
      const session = await findActiveSession(db, tokenHash);
      if (!session) return next();

      req.authUser = toPublicUser(session.user);
      req.authUserRow = session.user;
      req.sessionTokenHash = tokenHash;
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.authUser || !req.authUserRow) {
    res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Iniciá sesión para continuar.' } });
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.authUser) {
    res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Iniciá sesión para continuar.' } });
    return;
  }
  if (req.authUser.role !== 'admin') {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Se requiere perfil de administrador.' } });
    return;
  }
  next();
}

export function sessionCookieOptions(config: PlatformConfig) {
  return {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'lax' as const,
    domain: config.COOKIE_DOMAIN,
    path: '/',
    maxAge: config.SESSION_TTL_HOURS * 60 * 60 * 1000,
  };
}

export async function logoutCurrentSession(
  config: PlatformConfig,
  db: DbPool,
  req: Request,
  res: Response,
): Promise<void> {
  if (req.sessionTokenHash) await revokeSession(db, req.sessionTokenHash);
  res.clearCookie(config.COOKIE_NAME, {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'lax',
    domain: config.COOKIE_DOMAIN,
    path: '/',
  });
}

/* ------------------------- Rate limit simple (login) ----------------------- */

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Rate limiter en memoria para login/registro. En un despliegue con varias
 * réplicas se debería reemplazar por Redis (ver SECURITY en la documentación).
 */
export function createRateLimiter(maxAttempts: number, windowMs: number) {
  const buckets = new Map<string, Bucket>();
  return (key: string): { allowed: boolean; retryAfter: number } => {
    const now = Date.now();
    for (const [k, v] of buckets) {
      if (v.resetAt <= now) buckets.delete(k);
    }
    const bucket = buckets.get(key) ?? { count: 0, resetAt: now + windowMs };
    if (bucket.count >= maxAttempts) {
      return { allowed: false, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
    }
    bucket.count += 1;
    buckets.set(key, bucket);
    return { allowed: true, retryAfter: 0 };
  };
}
