import { Router } from 'express';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { AdminAuthService } from '../services/admin-auth-service.js';
import { ADMIN_COOKIE, parseCookies } from '../middleware/admin-auth.js';
import { ValidationError } from '../errors.js';

const loginSchema = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(200),
});

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError('Credenciales inválidas');
  }
  return result.data;
}

export function createAdminAuthRouter(input: {
  config: AppConfig;
  auth: AdminAuthService;
}): Router {
  const router = Router();
  const { config, auth } = input;

  const cookieOptions = {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };

  router.post('/login', (req, res) => {
    if (!config.admin.enabled) {
      res.status(404).json({ error: { code: 'ADMIN_DISABLED', message: 'Panel deshabilitado' } });
      return;
    }
    const body = parseOrThrow(loginSchema, req.body);
    const result = auth.login(body.username, body.password);
    res.cookie(ADMIN_COOKIE, result.token, cookieOptions);
    res.json({ ok: true, user: result.user });
  });

  router.post('/logout', (req, res) => {
    const token = parseCookies(req.headers.cookie)[ADMIN_COOKIE];
    auth.logout(token);
    res.clearCookie(ADMIN_COOKIE, {
      httpOnly: true,
      secure: config.isProduction,
      sameSite: 'lax',
      path: '/',
    });
    res.json({ ok: true });
  });

  router.get('/me', (req, res) => {
    if (!req.adminUser) {
      res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Sin sesión activa.' },
      });
      return;
    }
    res.json({ ok: true, user: req.adminUser });
  });

  return router;
}
