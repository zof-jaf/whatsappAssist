import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { PlatformDeps } from '../context.js';
import { requireAuth } from '../auth.js';
import {
  deleteBot,
  findBotByUserId,
  insertBot,
  logEvent,
  rotateBotApiKey,
  setBotEnabled,
  updateBotConnection,
  type BotRow,
  type ConnectionStatus,
} from '../repositories.js';
import { encryptSecret, generateApiKey, sessionNameFor } from '../crypto.js';
import { ensureWahaSession, type EnsureResult } from '../waha-admin.js';

const createSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
});

function publicBot(bot: BotRow) {
  return {
    id: bot.id,
    name: bot.name,
    wahaSession: bot.waha_session,
    apiKeyPreview: bot.api_key_preview,
    enabled: bot.enabled,
    connectionStatus: bot.connection_status,
    phoneNumber: bot.phone_number,
    createdAt: bot.created_at,
  };
}

function ensureResultPayload(result: EnsureResult) {
  if (result.action === 'reuse') {
    return { status: 'working' as const, phone: result.phone, qr: null, reused: true };
  }
  return { status: 'scan_qr' as const, phone: null, qr: result.qr.dataUrl, reused: false };
}

export function createBotsRouter(deps: PlatformDeps): Router {
  const { db, waha } = deps;
  const router = Router();
  router.use(requireAuth);

  router.get('/me', async (req, res, next) => {
    try {
      const bot = await findBotByUserId(db, req.authUser!.id);
      res.json({ bot: bot ? publicBot(bot) : null });
    } catch (error) {
      next(error);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      const user = req.authUserRow!;
      if (user.status !== 'active' || !user.can_create_bots) {
        res.status(403).json({
          error: { code: 'BOT_CREATION_DENIED', message: 'Tu cuenta no tiene permiso para crear bots. Contactá al administrador.' },
        });
        return;
      }
      if (await findBotByUserId(db, user.id)) {
        res.status(409).json({ error: { code: 'BOT_EXISTS', message: 'Ya tenés un bot creado.' } });
        return;
      }

      const input = createSchema.parse(req.body ?? {});
      const apiKey = generateApiKey(deps.config.API_KEY_PREFIX);
      const botId = randomUUID();
      const bot = await insertBot(db, {
        id: botId,
        userId: user.id,
        name: input.name ?? 'Mi bot',
        wahaSession: sessionNameFor(botId),
        apiKeyHash: apiKey.hash,
        apiKeyPreview: apiKey.preview,
        apiKeyEncrypted: encryptSecret(apiKey.key, deps.config.SESSION_SECRET),
      });

      await logEvent(db, { userId: user.id, botId: bot.id, type: 'bot_created' });

      let connection;
      try {
        const result = await ensureWahaSession(waha, bot.waha_session);
        connection = ensureResultPayload(result);
        await updateBotConnection(
          db,
          user.id,
          connection.status as ConnectionStatus,
          (result.action === 'reuse' ? result.phone : null) ?? null,
        );
        if (result.action === 'created') {
          await logEvent(db, { userId: user.id, botId: bot.id, type: 'qr_generated' });
        } else {
          await logEvent(db, { userId: user.id, botId: bot.id, type: 'session_connected' });
        }
      } catch (error) {
        // El bot queda creado; el usuario puede reintentar con /connect.
        deps.logger.warn({ err: String(error) }, 'No se pudo iniciar la sesión WAHA al crear el bot');
        connection = { status: 'failed', phone: null, qr: null, reused: false };
        await updateBotConnection(db, user.id, 'failed');
      }

      res.status(201).json({
        bot: publicBot({ ...bot, connection_status: connection.status as BotRow['connection_status'] }),
        // La API key se muestra UNA SOLA VEZ. Guardala en el proyecto que
        // consuma el bot; en la BD solo queda su hash.
        apiKey: apiKey.key,
        connection,
      });
    } catch (error) {
      next(error);
    }
  });

  /** Llamado al entrar al dashboard: reutiliza sesión activa o genera QR nuevo. */
  router.post('/connect', async (req, res, next) => {
    try {
      const user = req.authUserRow!;
      const bot = await findBotByUserId(db, user.id);
      if (!bot) {
        res.status(404).json({ error: { code: 'NO_BOT', message: 'Primero creá un bot.' } });
        return;
      }
      if (!bot.enabled) {
        res.status(403).json({ error: { code: 'BOT_DISABLED', message: 'Tu bot está desactivado.' } });
        return;
      }

      const result = await ensureWahaSession(waha, bot.waha_session);
      const payload = ensureResultPayload(result);
      await updateBotConnection(
        db,
        user.id,
        payload.status as ConnectionStatus,
        (result.action === 'reuse' ? result.phone : null) ?? null,
      );
      await logEvent(db, {
        userId: user.id,
        botId: bot.id,
        type: result.action === 'created' ? 'qr_generated' : 'session_connected',
      });
      if (result.action === 'created' && bot.connection_status === 'working') {
        await logEvent(db, { userId: user.id, botId: bot.id, type: 'session_lost' });
      }
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  /** Fuerza un QR nuevo: borra la sesión actual y crea otra desde cero. */
  router.post('/reconnect', async (req, res, next) => {
    try {
      const user = req.authUserRow!;
      const bot = await findBotByUserId(db, user.id);
      if (!bot) {
        res.status(404).json({ error: { code: 'NO_BOT', message: 'Primero creá un bot.' } });
        return;
      }
      await waha.deleteSession(bot.waha_session);
      await waha.createSession(bot.waha_session);
      const qr = await waha.getQr(bot.waha_session);
      await updateBotConnection(db, user.id, 'scan_qr');
      await logEvent(db, { userId: user.id, botId: bot.id, type: 'qr_generated', meta: { forced: true } });
      res.json({ status: 'scan_qr', qr: qr.dataUrl, reused: false });
    } catch (error) {
      next(error);
    }
  });

  /** Consulta el estado real en WAHA (para polling del QR). */
  router.get('/status', async (req, res, next) => {
    try {
      const bot = await findBotByUserId(db, req.authUser!.id);
      if (!bot) {
        res.status(404).json({ error: { code: 'NO_BOT', message: 'Primero creá un bot.' } });
        return;
      }
      const info = await waha.getSession(bot.waha_session);
      const raw = (info?.status ?? 'not_started').toLowerCase();
      let status: ConnectionStatus;
      if (raw === 'working') status = 'working';
      else if (raw === 'scan_qr_code') status = 'scan_qr';
      else if (raw === 'starting' || raw === 'conflict') status = 'connecting';
      else if (raw === 'failed') status = 'failed';
      else status = 'not_started';

      const phone = waha.phoneFromSession(info);
      if (status !== bot.connection_status) {
        await updateBotConnection(db, bot.user_id, status, phone);
        if (status === 'working') {
          await logEvent(db, { userId: bot.user_id, botId: bot.id, type: 'session_connected' });
        } else if (status === 'failed' && bot.connection_status === 'working') {
          await logEvent(db, { userId: bot.user_id, botId: bot.id, type: 'session_lost' });
        }
      }
      res.json({ status, phone, qr: status === 'scan_qr' ? (await waha.getQr(bot.waha_session).catch(() => null))?.dataUrl ?? null : null });
    } catch (error) {
      next(error);
    }
  });

  router.post('/api-key/rotate', async (req, res, next) => {
    try {
      const user = req.authUserRow!;
      const bot = await findBotByUserId(db, user.id);
      if (!bot) {
        res.status(404).json({ error: { code: 'NO_BOT', message: 'Primero creá un bot.' } });
        return;
      }
      const apiKey = generateApiKey(deps.config.API_KEY_PREFIX);
      await rotateBotApiKey(
        db,
        user.id,
        apiKey.hash,
        apiKey.preview,
        encryptSecret(apiKey.key, deps.config.SESSION_SECRET),
      );
      await logEvent(db, { userId: user.id, botId: bot.id, type: 'api_key_rotated' });
      res.json({ apiKey: apiKey.key, apiKeyPreview: apiKey.preview });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/', async (req, res, next) => {
    try {
      const user = req.authUserRow!;
      const bot = await findBotByUserId(db, user.id);
      if (!bot) {
        res.status(404).json({ error: { code: 'NO_BOT', message: 'No hay bot para eliminar.' } });
        return;
      }
      await waha.deleteSession(bot.waha_session).catch(() => undefined);
      await deleteBot(db, user.id);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/enabled', async (req, res, next) => {
    try {
      const enabled = z.boolean().parse(req.body?.enabled);
      const bot = await findBotByUserId(db, req.authUser!.id);
      if (!bot) {
        res.status(404).json({ error: { code: 'NO_BOT', message: 'No hay bot.' } });
        return;
      }
      await setBotEnabled(db, bot.user_id, enabled);
      res.json({ ok: true, enabled });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
