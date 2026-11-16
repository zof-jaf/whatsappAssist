import { Router } from 'express';
import type { PlatformDeps } from '../context.js';
import { requireAuth } from '../auth.js';
import { getDailySeries, getSummary, listEvents } from '../repositories.js';

/** Reportes del usuario sobre SU propio bot (nunca ve los de otros). */
export function createReportsRouter(deps: PlatformDeps): Router {
  const { db } = deps;
  const router = Router();
  router.use(requireAuth);

  router.get('/summary', async (req, res, next) => {
    try {
      const [summary, series, events] = await Promise.all([
        getSummary(db, req.authUser!.id),
        getDailySeries(db, req.authUser!.id),
        listEvents(db, { userId: req.authUser!.id, limit: 50 }),
      ]);
      res.json({ summary, series, events });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
