import { Router } from 'express';
import { z } from 'zod';
import type { PlatformDeps } from '../context.js';
import { hashApiKey } from '../crypto.js';
import { findBotByApiKeyHash, logEvent, type EventType } from '../repositories.js';

const eventSchema = z.object({
  type: z.enum(['message_in', 'message_out']),
  chatId: z.string().max(120).optional(),
  messageId: z.string().max(200).optional(),
  chars: z.coerce.number().int().min(0).max(1_000_000).optional(),
  session: z.string().max(120).optional(),
});

/**
 * API de ingresa por proyecto. Cada bot tiene su propia API key (guardada como
 * hash en PostgreSQL). Así el motor del bot no comparte variables de entorno
 * con otros proyectos: se autentica con SU key y escribe SUS eventos.
 */
export function createIngestRouter(deps: PlatformDeps): Router {
  const { db } = deps;
  const router = Router();

  async function authenticate(req: { headers: Record<string, unknown> }) {
    const raw = req.headers['x-api-key'] ?? req.headers['authorization'];
    let key: string | null = null;
    if (typeof raw === 'string') {
      key = raw.startsWith('Bearer ') ? raw.slice(7).trim() : raw.trim();
    }
    if (!key) return null;
    const hashed = hashApiKey(key);
    const bot = await findBotByApiKeyHash(db, hashed);
    if (!bot || !bot.enabled || bot.user_status !== 'active') return null;
    return bot;
  }

  router.get('/me', async (req, res, next) => {
    try {
      const bot = await authenticate(req as never);
      if (!bot) {
        res.status(401).json({ error: { code: 'INVALID_API_KEY', message: 'API key inválida o sin acceso.' } });
        return;
      }
      res.json({
        bot: { id: bot.id, name: bot.name, connectionStatus: bot.connection_status, wahaSession: bot.waha_session },
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/events', async (req, res, next) => {
    try {
      const bot = await authenticate(req as never);
      if (!bot) {
        res.status(401).json({ error: { code: 'INVALID_API_KEY', message: 'API key inválida o sin acceso.' } });
        return;
      }
      const input = eventSchema.parse(req.body);
      await logEvent(db, {
        userId: bot.user_id,
        botId: bot.id,
        type: input.type as EventType,
        meta: {
          chatId: input.chatId ?? null,
          messageId: input.messageId ?? null,
          chars: input.chars ?? null,
          session: input.session ?? null,
        },
      });
      res.status(201).json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
