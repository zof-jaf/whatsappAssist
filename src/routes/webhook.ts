import { Router } from 'express';
import type { AppConfig } from '../config.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Logger } from '../logger.js';
import type { WebhookEventStatus } from '../db/types.js';
import {
  ackToMessageStatus,
  isWahaWebhookEvent,
  parseAckEvent,
  parseMessageEvent,
  parseSessionStatusEvent,
  type WahaWebhookEvent,
} from '../domain/waha.js';
import { phoneFromJid } from '../utils/text.js';
import { isArtistChatIdentity } from '../domain/phones.js';
import { errorMessage } from '../utils/async.js';

export interface WebhookRouterDeps {
  config: AppConfig;
  repos: Repositories;
  logger: Logger;
}

function isAllowedChat(
  chatId: string,
  phoneJid: string | null,
  allowed: Set<string>,
): boolean {
  if (allowed.size === 0) return true;

  const normalized = chatId.toLowerCase();
  if (allowed.has(normalized)) return true;

  for (const candidate of [chatId, phoneJid]) {
    const phone = phoneFromJid(candidate);
    if (!phone) continue;
    if (allowed.has(phone) || allowed.has(`${phone}@c.us`)) return true;
  }

  return false;
}

function isArtistChat(
  chatId: string,
  phoneJid: string | null,
  config: AppConfig,
): boolean {
  return isArtistChatIdentity(config.tattoo.artistChatId, chatId, phoneJid);
}

export function createWebhookRouter(deps: WebhookRouterDeps): Router {
  const router = Router();
  const { config, repos, logger } = deps;

  const logEvent = (
    event: WahaWebhookEvent | undefined,
    status: WebhookEventStatus,
    reason?: string,
  ): void => {
    try {
      repos.events.insert({
        eventId: event?.id,
        event: event?.event ?? 'invalid',
        session: event?.session,
        status,
        reason,
        payload: event ?? null,
      });
    } catch (error) {
      logger.warn(
        { err: errorMessage(error) },
        'No se pudo registrar el evento de webhook',
      );
    }
  };

  router.post('/webhook', (req, res) => {
    const body: unknown = req.body;

    if (!isWahaWebhookEvent(body)) {
      logger.warn('Webhook con formato inválido');
      logEvent(undefined, 'error', 'formato_invalido');
      res.status(400).json({
        error: {
          code: 'INVALID_WEBHOOK_PAYLOAD',
          message: 'El cuerpo no es un evento de WAHA válido',
        },
      });
      return;
    }

    const event = body;

    if (event.session && event.session !== config.waha.session) {
      logger.debug(
        { session: event.session, expected: config.waha.session },
        'Evento de otra sesión ignorado',
      );
      logEvent(event, 'ignored', 'sesion_distinta');
      res.status(200).json({ ok: true, status: 'ignored', reason: 'session' });
      return;
    }

    try {
      if (event.event === 'session.status') {
        const info = parseSessionStatusEvent(event);
        if (!info) {
          logEvent(event, 'ignored', 'session_status_invalido');
          res.status(200).json({ ok: true, status: 'ignored' });
          return;
        }

        repos.meta.setJson('waha.session', {
          status: info.status,
          at: info.at,
          me: info.me ?? null,
          data: info.data ?? null,
        });

        if (info.status === 'SCAN_QR_CODE') {
          logger.warn(
            { dashboard: `${config.waha.publicUrl}/dashboard` },
            'WAHA requiere escanear el código QR',
          );
        } else if (info.status === 'WORKING') {
          logger.info('Sesión de WhatsApp conectada y trabajando');
        } else if (info.status === 'FAILED') {
          logger.error({ data: info.data }, 'La sesión de WhatsApp falló');
        }

        logEvent(event, 'processed', `session_status:${info.status}`);
        res.status(200).json({ ok: true, status: 'processed' });
        return;
      }

      if (event.event === 'message.ack') {
        const ack = parseAckEvent(event);
        const status = ack ? ackToMessageStatus(ack) : undefined;
        if (!ack || !status) {
          logEvent(event, 'ignored', 'ack_no_mapeado');
          res.status(200).json({ ok: true, status: 'ignored' });
          return;
        }

        repos.messages.updateStatusByWaMessageId(ack.waMessageId, status);
        logEvent(event, 'processed', `ack:${status}`);
        res.status(200).json({ ok: true, status: 'processed' });
        return;
      }

      if (event.event !== 'message' && event.event !== 'message.any') {
        logEvent(event, 'ignored', `evento:${event.event}`);
        res.status(200).json({ ok: true, status: 'ignored' });
        return;
      }

      const parsed = parseMessageEvent(event);
      if (!parsed.ok || !parsed.message) {
        logEvent(event, 'ignored', parsed.reason ?? 'mensaje_invalido');
        res.status(200).json({ ok: true, status: 'ignored' });
        return;
      }

      const message = parsed.message;

      if (message.fromMe) {
        logEvent(event, 'ignored', 'from_me');
        res.status(200).json({ ok: true, status: 'ignored', reason: 'from_me' });
        return;
      }

      if (message.isBroadcast) {
        logEvent(event, 'ignored', 'broadcast');
        res
          .status(200)
          .json({ ok: true, status: 'ignored', reason: 'broadcast' });
        return;
      }

      if (
        message.isGroup &&
        config.bot.ignoreGroups &&
        !isArtistChat(message.chatId, message.phoneJid, config)
      ) {
        logEvent(event, 'ignored', 'grupo');
        res.status(200).json({ ok: true, status: 'ignored', reason: 'grupo' });
        return;
      }

      const fromArtist = isArtistChat(
        message.chatId,
        message.phoneJid,
        config,
      );

      if (
        !fromArtist &&
        !isAllowedChat(
          message.chatId,
          message.phoneJid,
          config.bot.allowedChatIds,
        )
      ) {
        logger.info(
          { chatId: message.chatId },
          'Mensaje de chat no permitido ignorado',
        );
        logEvent(event, 'ignored', 'chat_no_permitido');
        res.status(200).json({
          ok: true,
          status: 'ignored',
          reason: 'chat_no_permitido',
        });
        return;
      }

      if (message.body.trim().length === 0 && !message.hasMedia) {
        logEvent(event, 'ignored', 'mensaje_vacio');
        res.status(200).json({
          ok: true,
          status: 'ignored',
          reason: 'mensaje_vacio',
        });
        return;
      }

      const result = repos.jobs.enqueue({
        waMessageId: message.waMessageId,
        chatId: message.chatId,
        eventId: event.id,
        payload: JSON.stringify(event),
        maxAttempts: config.queue.maxAttempts,
      });

      if (!result.inserted) {
        logEvent(event, 'duplicate', 'job_duplicado');
        res.status(200).json({ ok: true, status: 'duplicate' });
        return;
      }

      logEvent(event, 'queued');
      logger.info(
        {
          jobId: result.job.id,
          chatId: message.chatId,
          waMessageId: message.waMessageId,
          event: event.event,
          kind: message.kind,
        },
        'Mensaje encolado para procesamiento',
      );
      res.status(200).json({ ok: true, status: 'queued', jobId: result.job.id });
    } catch (error) {
      logger.error(
        {
          err: errorMessage(error),
          event: event.event,
          eventId: event.id,
        },
        'Error procesando webhook',
      );
      logEvent(event, 'error', errorMessage(error));
      res.status(500).json({
        error: {
          code: 'WEBHOOK_PROCESSING_ERROR',
          message: 'No se pudo procesar el webhook',
        },
      });
    }
  });

  return router;
}
