import { Router } from 'express';
import { z } from 'zod';
import type { PlatformDeps } from '../context.js';
import { logoutCurrentSession, sessionCookieOptions } from '../auth.js';
import {
  findUserByEmail,
  insertSession,
  insertUser,
  logEvent,
  toPublicUser,
  touchLastLogin,
} from '../repositories.js';
import {
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  verifyPassword,
} from '../crypto.js';

const registerSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(128),
  fullName: z.string().trim().min(1).max(120).optional(),
});

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
});

function clientIp(req: {
  headers?: Record<string, unknown>;
  ip?: string;
  socket?: { remoteAddress?: string };
}): string {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0]!.trim();
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}

export function createAuthRouter(deps: PlatformDeps): Router {
  const { config, db, rateLimiter } = deps;
  const router = Router();

  router.get('/me', (req, res) => {
    res.json({ user: req.authUser ?? null });
  });

  router.post('/register', async (req, res, next) => {
    try {
      if (!config.ALLOW_PUBLIC_REGISTRATION) {
        res.status(403).json({
          error: { code: 'REGISTRATION_CLOSED', message: 'El registro está cerrado. Contactá al administrador.' },
        });
        return;
      }

      const input = registerSchema.parse(req.body);
      const email = input.email.trim().toLowerCase();
      if (await findUserByEmail(db, email)) {
        res.status(409).json({ error: { code: 'EMAIL_TAKEN', message: 'Ese correo ya está registrado.' } });
        return;
      }

      const user = await insertUser(db, {
        email,
        passwordHash: await hashPassword(input.password),
        fullName: input.fullName || email.split('@')[0]!,
      });
      await logEvent(db, { userId: user.id, type: 'register', meta: { via: 'public' } });
      res.status(201).json({ user: toPublicUser(user) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/login', async (req, res, next) => {
    try {
      const ip = clientIp(req);
      const input = loginSchema.parse(req.body);
      const email = input.email.trim().toLowerCase();
      const limit = rateLimiter(`login:${ip}:${email}`);
      if (!limit.allowed) {
        res.status(429).json({
          error: { code: 'RATE_LIMITED', message: 'Demasiados intentos. Esperá un momento.' },
          details: { retryAfter: limit.retryAfter },
        });
        return;
      }

      const user = await findUserByEmail(db, email);
      if (!user || user.status !== 'active' || !(await verifyPassword(input.password, user.password_hash))) {
        res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Correo o contraseña incorrectos.' } });
        return;
      }

      const token = generateSessionToken();
      const tokenHash = hashSessionToken(token, config.SESSION_SECRET);
      const expiresAt = new Date(Date.now() + config.SESSION_TTL_HOURS * 3600_000);
      await insertSession(db, {
        tokenHash,
        userId: user.id,
        expiresAt,
        ipAddress: ip,
        userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
      });
      await touchLastLogin(db, user.id);
      await logEvent(db, { userId: user.id, type: 'login' });

      res.cookie(config.COOKIE_NAME, token, sessionCookieOptions(config));
      res.json({ user: toPublicUser(user) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/logout', async (req, res, next) => {
    try {
      await logoutCurrentSession(config, db, req, res);
      if (req.authUser) await logEvent(db, { userId: req.authUser.id, type: 'logout' });
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
