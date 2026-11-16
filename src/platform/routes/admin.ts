import { Router } from 'express';
import { z } from 'zod';
import type { PlatformDeps } from '../context.js';
import { requireAdmin, requireAuth } from '../auth.js';
import {
  countAdmins,
  deleteUser,
  findUserByEmail,
  findUserById,
  getDailySeries,
  getSummary,
  getUsersReport,
  listEvents,
  listUsers,
  logEvent,
  revokeAllUserSessions,
  updateUser,
  insertUser,
  toPublicUser,
  type UserRole,
  type UserStatus,
} from '../repositories.js';
import { hashPassword } from '../crypto.js';

const createUserSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(128),
  fullName: z.string().trim().min(1).max(120).optional(),
  role: z.enum(['user', 'admin']).optional(),
  canCreateBots: z.boolean().optional(),
});

const patchUserSchema = z.object({
  fullName: z.string().trim().min(1).max(120).optional(),
  role: z.enum(['user', 'admin']).optional(),
  status: z.enum(['active', 'suspended']).optional(),
  canCreateBots: z.boolean().optional(),
  password: z.string().min(8).max(128).optional(),
});

export function createAdminRouter(deps: PlatformDeps): Router {
  const { db } = deps;
  const router = Router();
  router.use(requireAuth, requireAdmin);

  router.get('/users', async (req, res, next) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const search = typeof req.query.search === 'string' ? req.query.search : undefined;
      const result = await listUsers(db, { limit, offset, search });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/users', async (req, res, next) => {
    try {
      const input = createUserSchema.parse(req.body);
      const email = input.email.trim().toLowerCase();
      const existing = await findUserByEmail(db, email);
      if (existing) {
        res.status(409).json({ error: { code: 'EMAIL_TAKEN', message: 'Ese correo ya está registrado.' } });
        return;
      }
      const user = await insertUser(db, {
        email,
        passwordHash: await hashPassword(input.password),
        fullName: input.fullName ?? email.split('@')[0]!,
        role: input.role ?? 'user',
        canCreateBots: input.canCreateBots ?? true,
      });
      await logEvent(db, {
        userId: user.id,
        type: 'register',
        meta: { via: 'admin', by: req.authUser!.id },
      });
      res.status(201).json({ user: toPublicUser(user) });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/users/:id', async (req, res, next) => {
    try {
      const target = await findUserById(db, req.params.id!);
      if (!target) {
        res.status(404).json({ error: { code: 'USER_NOT_FOUND', message: 'Usuario no encontrado.' } });
        return;
      }
      const patch = patchUserSchema.parse(req.body);

      // No se puede desactivar ni degradar al último administrador activo.
      const demotesAdmin =
        (patch.status && patch.status === 'suspended' && target.role === 'admin') ||
        (patch.role && patch.role === 'user' && target.role === 'admin');
      if (demotesAdmin && (await countAdmins(db)) <= 1) {
        res.status(400).json({
          error: { code: 'LAST_ADMIN', message: 'No podés desactivar o degradar al último administrador.' },
        });
        return;
      }

      const updated = await updateUser(db, target.id, {
        fullName: patch.fullName,
        role: patch.role as UserRole | undefined,
        status: patch.status as UserStatus | undefined,
        canCreateBots: patch.canCreateBots,
        passwordHash: patch.password ? await hashPassword(patch.password) : undefined,
      });
      if (patch.status === 'suspended' || patch.role === 'user') {
        await revokeAllUserSessions(db, target.id);
      }
      res.json({ user: updated });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/users/:id', async (req, res, next) => {
    try {
      if (req.params.id === req.authUser!.id) {
        res.status(400).json({ error: { code: 'SELF_DELETE', message: 'No podés eliminar tu propia cuenta.' } });
        return;
      }
      const target = await findUserById(db, req.params.id!);
      if (!target) {
        res.status(404).json({ error: { code: 'USER_NOT_FOUND', message: 'Usuario no encontrado.' } });
        return;
      }
      if (target.role === 'admin' && (await countAdmins(db)) <= 1) {
        res.status(400).json({ error: { code: 'LAST_ADMIN', message: 'No podés eliminar al último administrador.' } });
        return;
      }
      await deleteUser(db, target.id);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post('/users/:id/sessions/revoke', async (req, res, next) => {
    try {
      await revokeAllUserSessions(db, req.params.id!);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.get('/reports', async (_req, res, next) => {
    try {
      const [users, summary, series] = await Promise.all([
        getUsersReport(db),
        getSummary(db),
        getDailySeries(db),
      ]);
      res.json({ users, summary, series });
    } catch (error) {
      next(error);
    }
  });

  router.get('/events', async (req, res, next) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 100, 500);
      res.json({ events: await listEvents(db, { limit }) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
