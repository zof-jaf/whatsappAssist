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
  /** Sesión WAHA esperada. En el bot legado es config.waha.session; en la
   * plataforma se pasa la sesión del bot resuelto antes de procesar. */
  expectedSession?: string;
  /** Eventos de otras sesiones se reenvían a la plataforma multiusuario. */
  onOtherSession?: (event: WahaWebhookEvent, rawBody?: Buffer) => Promise<void>;
}

export interface WebhookResult {
  status: number;
  body: unknown;
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

/**
 * Procesa un evento de WAHA y devuelve la respuesta HTTP correspondiente.
 * Compartido por el bot legado (una sesión) y por el worker-host de la
 * plataforma (una instancia por sesión).
 */
export function processWebhookEvent(
  deps: WebhookRouterDeps,
  body: unknown,
): WebhookResult {
  const { config, repos, logger } = deps;
  const ok = (extra: Record<string, unknown> = {}, status = 200): WebhookResult => ({
    status,
    body: { ok: true, ...extra },
  });

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

  if (!isWahaWebhookEvent(body)) {
    logger.warn('Webhook con formato inválido');
    logEvent(undefined, 'error', 'formato_invalido');
    return {
      status: 400,
      body: {
        error: {
          code: 'INVALID_WEBHOOK_PAYLOAD',
          message: 'El cuerpo no es un evento de WAHA válido',
        },
      },
    };
  }

  const event = body;
  const expectedSession = deps.expectedSession ?? config.waha.session;

  if (event.session && event.session !== expectedSession) {
    logger.debug(
      { session: event.session, expected: expectedSession },
      'Evento de otra sesión ignorado',
    );
    logEvent(event, 'ignored', 'sesion_distinta');
    return ok({ status: 'ignored', reason: 'session' });
  }

  try {
    if (event.event === 'session.status') {
      const info = parseSessionStatusEvent(event);
      if (!info) {
        logEvent(event, 'ignored', 'session_status_invalido');
        return ok({ status: 'ignored' });
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
      return ok({ status: 'processed' });
    }

    if (event.event === 'message.ack') {
      const ack = parseAckEvent(event);
      const status = ack ? ackToMessageStatus(ack) : undefined;
      if (!ack || !status) {
        logEvent(event, 'ignored', 'ack_no_mapeado');
        return ok({ status: 'ignored' });
      }

      repos.messages.updateStatusByWaMessageId(ack.waMessageId, status);
      logEvent(event, 'processed', `ack:${status}`);
      return ok({ status: 'processed' });
    }

    if (event.event !== 'message' && event.event !== 'message.any') {
      logEvent(event, 'ignored', `evento:${event.event}`);
      return ok({ status: 'ignored' });
    }

    const parsed = parseMessageEvent(event);
    if (!parsed.ok || !parsed.message) {
      logEvent(event, 'ignored', parsed.reason ?? 'mensaje_invalido');
      return ok({ status: 'ignored' });
    }

    const message = parsed.message;

    if (message.fromMe) {
      logEvent(event, 'ignored', 'from_me');
      return ok({ status: 'ignored', reason: 'from_me' });
    }

    if (message.isBroadcast) {
      logEvent(event, 'ignored', 'broadcast');
      return ok({ status: 'ignored', reason: 'broadcast' });
    }

    if (
      message.isGroup &&
      config.bot.ignoreGroups &&
      !isArtistChat(message.chatId, message.phoneJid, config)
    ) {
      logEvent(event, 'ignored', 'grupo');
      return ok({ status: 'ignored', reason: 'grupo' });
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
      return ok({ status: 'ignored', reason: 'chat_no_permitido' });
    }

    if (message.body.trim().length === 0 && !message.hasMedia) {
      logEvent(event, 'ignored', 'mensaje_vacio');
      return ok({ status: 'ignored', reason: 'mensaje_vacio' });
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
      return ok({ status: 'duplicate' });
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
    return ok({ status: 'queued', jobId: result.job.id });
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
    return {
      status: 500,
      body: {
        error: {
          code: 'WEBHOOK_PROCESSING_ERROR',
          message: 'No se pudo procesar el webhook',
        },
      },
    };
  }
}

export function createWebhookRouter(deps: WebhookRouterDeps): Router {
  const router = Router();
  router.post('/webhook', (req, res) => {
    const expected = deps.expectedSession ?? deps.config.waha.session;
    if (
      deps.onOtherSession &&
      isWahaWebhookEvent(req.body) &&
      req.body.session &&
      req.body.session !== expected
    ) {
      const raw = (req as typeof req & { rawBody?: Buffer }).rawBody;
      void deps.onOtherSession(req.body, raw).catch((error) => {
        deps.logger.warn(
          { err: errorMessage(error), session: req.body.session },
          'No se pudo reenviar el evento a la plataforma',
        );
      });
    }
    const result = processWebhookEvent(deps, req.body);
    res.status(result.status).json(result.body);
  });
  return router;
}
