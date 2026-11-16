import { Router } from 'express';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Repositories } from '../db/repositories/index.js';
import type { HealthService } from '../services/health-service.js';
import type { ConversationService } from '../services/conversation-service.js';
import type { NotionSettingsService } from '../services/notion-settings-service.js';
import type { TattooSettingsService } from '../services/tattoo-settings-service.js';
import type { InboundWorker } from '../services/worker.js';
import type {
  ConversationListItem,
  MessageRow,
} from '../db/types.js';
import type { WahaClient, WahaSessionInfo } from '../clients/waha.js';
import { NotFoundError, ValidationError, WahaError } from '../errors.js';
import { APP_VERSION } from '../version.js';
import { preview } from '../utils/text.js';
import { errorMessage } from '../utils/async.js';

export interface AdminRouterDeps {
  config: AppConfig;
  repos: Repositories;
  health: HealthService;
  conversations: ConversationService;
  tattoo: TattooSettingsService;
  notion: NotionSettingsService;
  waha: WahaClient;
  worker?: InboundWorker;
}

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  search: z.string().max(200).default(''),
  status: z.enum(['all', 'active', 'archived']).default('all'),
});

const detailQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  beforeId: z.preprocess(
    (value) => (value === undefined || value === '' ? undefined : Number(value)),
    z.number().int().positive().optional(),
  ),
});

const patchConversationSchema = z
  .object({
    aiEnabled: z.boolean().optional(),
    status: z.enum(['active', 'archived']).optional(),
  })
  .refine(
    (value) => value.aiEnabled !== undefined || value.status !== undefined,
    'Indicá al menos un campo para actualizar',
  );

const manualMessageSchema = z.object({
  text: z.string().trim().min(1).max(6000),
});

const tattooPhoneSchema = z.object({
  phone: z.string().trim().max(40),
});

const notionSettingsSchema = z.object({
  apiKey: z.string().trim().max(400).optional(),
  databaseId: z.string().trim().max(500).optional(),
});

const limitQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError('Parámetros inválidos', result.error.issues);
  }
  return result.data;
}

function parseId(raw: string | undefined): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError('Identificador inválido');
  }
  return value;
}

function mapMessage(message: MessageRow) {
  return {
    id: message.id,
    waMessageId: message.wa_message_id,
    direction: message.direction,
    role: message.role,
    kind: message.kind,
    body: message.body,
    status: message.status,
    error: message.error,
    model: message.model,
    promptTokens: message.prompt_tokens,
    completionTokens: message.completion_tokens,
    latencyMs: message.latency_ms,
    media: message.media_url || message.media_mime
      ? {
          url: message.media_url,
          mime: message.media_mime,
          filename: message.media_filename,
        }
      : null,
    replyToMessageId: message.reply_to_message_id,
    createdAt: message.created_at,
    sentAt: message.sent_at,
  };
}

function isSessionNotFound(error: unknown): boolean {
  return error instanceof WahaError && error.statusCode === 404;
}

function sessionStatus(info: WahaSessionInfo | null | undefined): string | null {
  return typeof info?.status === 'string' ? info.status : null;
}

function mapConversationItem(item: ConversationListItem) {
  return {
    id: item.id,
    contact: {
      waId: item.wa_id,
      phone: item.phone,
      pushName: item.push_name,
      displayName: item.display_name ?? item.push_name ?? item.phone ?? item.wa_id,
    },
    aiEnabled: item.ai_enabled === 1,
    status: item.status,
    lastMessageAt: item.last_message_created_at ?? item.last_message_at,
    lastMessage:
      item.last_direction !== null
        ? {
            body: item.last_body ?? '',
            direction: item.last_direction,
            status: item.last_status,
            createdAt: item.last_message_created_at,
          }
        : null,
    messageCount: item.message_count ?? 0,
    pendingReply:
      (item.last_inbound_id ?? 0) > (item.last_outbound_id ?? 0),
    createdAt: item.created_at,
  };
}

export function createAdminRouter(deps: AdminRouterDeps): Router {
  const router = Router();
  const { config, repos, health, conversations, tattoo, notion, waha, worker } =
    deps;

  router.get('/overview', async (_req, res) => {
    const [snapshot, stats] = await Promise.all([
      health.snapshot(),
      Promise.resolve(repos.stats.overview()),
    ]);

    res.json({
      version: APP_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      bot: {
        name: config.bot.name,
        model: config.ollama.model,
        timeZone: config.bot.timeZone,
        enabled: config.bot.enabled,
        historyMaxMessages: config.bot.historyMaxMessages,
        summaryEnabled: config.bot.summary.enabled,
      },
      settings: {
        ignoreGroups: config.bot.ignoreGroups,
        allowedChatsConfigured: config.bot.allowedChatIds.size,
        webhookHmacEnabled: Boolean(config.waha.hmacKey),
        adminEnabled: config.admin.enabled,
        historyMaxChars: config.bot.historyMaxChars,
        summaryTriggerMessages: config.bot.summary.triggerMessages,
        queueMaxAttempts: config.queue.maxAttempts,
        sendSeen: config.waha.sendSeen,
        typingIndicator: config.waha.typingIndicator,
        tattooArtist: tattoo.display,
        tattooArtistSource: tattoo.source,
        notionAgenda: notion.snapshot().databaseTitle,
        notionAgendaReady: notion.snapshot().ready,
      },
      stats,
      health: snapshot,
      worker: worker?.snapshot() ?? null,
      dashboardUrl: health.dashboardUrl,
    });
  });

  /* ---------- WhatsApp / sesión de WAHA ---------- */

  router.get('/whatsapp/status', async (_req, res) => {
    const base = { dashboardUrl: health.dashboardUrl };

    try {
      const info = await waha.getSession();
      const status = sessionStatus(info);
      res.json({
        ok: true,
        exists: true,
        status,
        me: info.me ?? null,
        qrAvailable: status === 'SCAN_QR_CODE',
        ...base,
      });
    } catch (error) {
      if (isSessionNotFound(error)) {
        res.json({
          ok: true,
          exists: false,
          status: null,
          me: null,
          qrAvailable: false,
          ...base,
        });
        return;
      }

      res.json({
        ok: false,
        exists: false,
        status: null,
        me: null,
        qrAvailable: false,
        error: errorMessage(error),
        ...base,
      });
    }
  });

  router.get('/whatsapp/qr', async (_req, res) => {
    let info: WahaSessionInfo;
    try {
      info = await waha.getSession();
    } catch (error) {
      if (isSessionNotFound(error)) {
        res.status(409).json({
          error: {
            code: 'SESSION_NOT_FOUND',
            message:
              'La sesión de WhatsApp no existe. Usá "Conectar WhatsApp" para crearla.',
          },
        });
        return;
      }
      throw error;
    }

    const status = sessionStatus(info);
    if (status !== 'SCAN_QR_CODE') {
      res.status(409).json({
        error: {
          code: 'QR_NOT_AVAILABLE',
          message: `La sesión está en estado ${status ?? 'desconocido'}. Generá un QR nuevo para escanear.`,
          details: { status },
        },
      });
      return;
    }

    try {
      const qr = await waha.getQr();
      res.json({
        ok: true,
        status,
        mimetype: qr.mimetype,
        dataUrl: `data:${qr.mimetype};base64,${qr.data}`,
        fetchedAt: new Date().toISOString(),
      });
    } catch (error) {
      // WAHA responde 422 mientras el QR todavía no está generado.
      if (
        error instanceof WahaError &&
        (error.statusCode === 422 || error.statusCode === 404)
      ) {
        res.status(409).json({
          error: {
            code: 'QR_NOT_AVAILABLE',
            message:
              'WAHA todavía está generando el código QR. Esperá unos segundos y reintentá.',
            details: { status },
          },
        });
        return;
      }
      throw error;
    }
  });

  router.post('/whatsapp/connect', async (_req, res) => {
    const base = { dashboardUrl: health.dashboardUrl };
    let info: WahaSessionInfo | null = null;
    let action: 'created' | 'restarted' | 'none' = 'none';

    try {
      info = await waha.getSession();
    } catch (error) {
      if (!isSessionNotFound(error)) throw error;
    }

    if (!info) {
      info = await waha.createSession();
      action = 'created';
    } else {
      const status = sessionStatus(info);
      if (status === 'FAILED' || status === 'STOPPED') {
        info = await waha.restartSession();
        action = 'restarted';
      }
    }

    const status = sessionStatus(info);
    res.json({
      ok: true,
      exists: true,
      action,
      status,
      me: info.me ?? null,
      qrAvailable: status === 'SCAN_QR_CODE',
      ...base,
    });
  });

  router.post('/whatsapp/restart', async (_req, res) => {
    const base = { dashboardUrl: health.dashboardUrl };
    let info: WahaSessionInfo | null = null;
    let action: 'created' | 'restarted';

    try {
      info = await waha.getSession();
    } catch (error) {
      if (!isSessionNotFound(error)) throw error;
    }

    if (!info) {
      info = await waha.createSession();
      action = 'created';
    } else {
      info = await waha.restartSession();
      action = 'restarted';
    }

    const status = sessionStatus(info);
    res.json({
      ok: true,
      exists: true,
      action,
      status,
      me: info.me ?? null,
      qrAvailable: status === 'SCAN_QR_CODE',
      ...base,
    });
  });

  /* ---------- Tatuador / cotizaciones ---------- */

  router.get('/tattoo', (_req, res) => {
    res.json({ ok: true, ...tattoo.snapshot() });
  });

  router.put('/tattoo', (req, res) => {
    const body = parseOrThrow(tattooPhoneSchema, req.body);
    const settings = body.phone ? tattoo.save(body.phone) : tattoo.clear();
    res.json({ ok: true, ...settings });
  });

  /* ---------- Agenda de Notion ---------- */

  router.get('/notion', (_req, res) => {
    res.json({ ok: true, ...notion.snapshot() });
  });

  router.put('/notion', async (req, res, next) => {
    try {
      const body = parseOrThrow(notionSettingsSchema, req.body);
      const settings = await notion.save(body);
      res.json({ ok: true, ...settings });
    } catch (error) {
      next(error);
    }
  });

  router.post('/notion/test', async (_req, res, next) => {
    try {
      const result = await notion.test();
      res.json({ ok: result.ok, error: result.error, schema: result.schema });
    } catch (error) {
      next(error);
    }
  });

  router.post('/notion/discover', async (_req, res, next) => {
    try {
      const result = await notion.discover();
      res.json({ ok: true, ...result });
    } catch (error) {
      next(error);
    }
  });

  router.get('/conversations', (req, res) => {
    const query = parseOrThrow(listQuerySchema, req.query);
    const result = repos.conversations.list({
      limit: query.limit,
      offset: query.offset,
      search: query.search,
      status: query.status,
    });

    res.json({
      items: result.items.map(mapConversationItem),
      total: result.total,
      limit: query.limit,
      offset: query.offset,
    });
  });

  router.get('/conversations/:id', (req, res) => {
    const id = parseId(req.params.id);
    const query = parseOrThrow(detailQuerySchema, req.query);
    const conversation = repos.conversations.getById(id);
    if (!conversation) throw new NotFoundError('Conversación no encontrada');

    const contact = repos.contacts.getById(conversation.contact_id);
    if (!contact) throw new NotFoundError('Contacto no encontrado');

    const summary = repos.summaries.latestActive(id);
    const boundary = Math.max(
      conversation.context_start_message_id ?? 0,
      summary?.through_message_id ?? 0,
    );
    const messages = repos.messages.listByConversation({
      conversationId: id,
      limit: query.limit,
      beforeId: query.beforeId ?? null,
    });

    res.json({
      conversation: {
        id: conversation.id,
        aiEnabled: conversation.ai_enabled === 1,
        status: conversation.status,
        contextStartMessageId: conversation.context_start_message_id,
        lastInboundAt: conversation.last_inbound_at,
        lastOutboundAt: conversation.last_outbound_at,
        lastMessageAt: conversation.last_message_at,
        createdAt: conversation.created_at,
      },
      contact: {
        waId: contact.wa_id,
        phone: contact.phone,
        pushName: contact.push_name,
        displayName:
          contact.display_name ?? contact.push_name ?? contact.phone ?? contact.wa_id,
        firstSeenAt: contact.first_seen_at,
        lastSeenAt: contact.last_seen_at,
      },
      summary: summary
        ? {
            text: summary.summary,
            throughMessageId: summary.through_message_id,
            messagesCovered: summary.messages_covered,
            model: summary.model,
            createdAt: summary.created_at,
          }
        : null,
      context: {
        startMessageId: boundary,
        messageCount: repos.messages.countSince(id, boundary),
      },
      messages: messages.items.map(mapMessage),
      hasMore: messages.hasMore,
    });
  });

  router.patch('/conversations/:id', (req, res) => {
    const id = parseId(req.params.id);
    const body = parseOrThrow(patchConversationSchema, req.body);
    const conversation = repos.conversations.getById(id);
    if (!conversation) throw new NotFoundError('Conversación no encontrada');

    if (body.aiEnabled !== undefined) {
      repos.conversations.setAiEnabled(id, body.aiEnabled);
    }
    if (body.status !== undefined) {
      repos.conversations.setStatus(id, body.status);
    }

    const updated = repos.conversations.getById(id);
    res.json({
      ok: true,
      conversation: {
        id,
        aiEnabled: updated?.ai_enabled === 1,
        status: updated?.status,
      },
    });
  });

  router.post('/conversations/:id/reset', (req, res) => {
    const id = parseId(req.params.id);
    const conversation = repos.conversations.getById(id);
    if (!conversation) throw new NotFoundError('Conversación no encontrada');

    const contextStartMessageId = repos.conversations.resetContext(id);
    res.json({ ok: true, contextStartMessageId });
  });

  router.post('/conversations/:id/messages', async (req, res) => {
    const id = parseId(req.params.id);
    const body = parseOrThrow(manualMessageSchema, req.body);
    const message = await conversations.sendManualMessage(id, body.text);
    res.status(201).json({ ok: true, message: mapMessage(message) });
  });

  router.post('/messages/:id/retry', async (req, res) => {
    const id = parseId(req.params.id);
    const message = await conversations.retryOutboundMessage(id);
    res.json({ ok: true, message: mapMessage(message) });
  });

  router.get('/conversations/:id/export', (req, res) => {
    const id = parseId(req.params.id);
    const conversation = repos.conversations.getById(id);
    if (!conversation) throw new NotFoundError('Conversación no encontrada');
    const contact = repos.contacts.getById(conversation.contact_id);
    const summary = repos.summaries.latestActive(id);
    const messages = repos.messages.allByConversation(id);

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="conversacion-${id}.json"`,
    );
    res.json({
      exportedAt: new Date().toISOString(),
      conversation: {
        id: conversation.id,
        aiEnabled: conversation.ai_enabled === 1,
        status: conversation.status,
        createdAt: conversation.created_at,
      },
      contact: contact
        ? {
            waId: contact.wa_id,
            phone: contact.phone,
            pushName: contact.push_name,
            displayName: contact.display_name,
          }
        : null,
      summary: summary
        ? {
            text: summary.summary,
            throughMessageId: summary.through_message_id,
            messagesCovered: summary.messages_covered,
            model: summary.model,
            createdAt: summary.created_at,
          }
        : null,
      messages: messages.map(mapMessage),
    });
  });

  router.get('/events', (req, res) => {
    const query = parseOrThrow(limitQuerySchema, req.query);
    const full = req.query.full === '1';
    const items = repos.events.listRecent(query.limit).map((event) => {
      let payload: unknown = undefined;
      if (full) {
        try {
          payload = JSON.parse(event.payload) as unknown;
        } catch {
          payload = event.payload;
        }
      }

      return {
        id: event.id,
        eventId: event.event_id,
        event: event.event,
        session: event.session,
        status: event.status,
        reason: event.reason,
        payloadPreview: preview(event.payload, 300),
        payload,
        createdAt: event.created_at,
      };
    });

    res.json({ items });
  });

  router.get('/jobs', (req, res) => {
    const query = parseOrThrow(limitQuerySchema, req.query);
    const items = repos.jobs.listFailed(query.limit).map((job) => ({
      id: job.id,
      waMessageId: job.wa_message_id,
      chatId: job.chat_id,
      attempts: job.attempts,
      maxAttempts: job.max_attempts,
      lastError: job.last_error,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
    }));
    res.json({ items });
  });

  router.post('/jobs/:id/retry', (req, res) => {
    const id = parseId(req.params.id);
    const job = repos.jobs.getById(id);
    if (!job) throw new NotFoundError('Trabajo no encontrado');

    const retried = repos.jobs.retry(id);
    if (!retried) {
      throw new ValidationError('El trabajo no está en estado fallido');
    }

    res.json({ ok: true });
  });

  router.get('/system', async (_req, res) => {
    const snapshot = await health.snapshot(true);
    const events = repos.events.listRecent(50).map((event) => ({
      id: event.id,
      event: event.event,
      status: event.status,
      reason: event.reason,
      createdAt: event.created_at,
      payloadPreview: preview(event.payload, 200),
    }));
    const failedJobs = repos.jobs.listFailed(50).map((job) => ({
      id: job.id,
      chatId: job.chat_id,
      attempts: job.attempts,
      maxAttempts: job.max_attempts,
      lastError: job.last_error,
      updatedAt: job.updated_at,
    }));

    res.json({
      health: snapshot,
      worker: worker?.snapshot() ?? null,
      events,
      failedJobs,
      settings: {
        model: config.ollama.model,
        botName: config.bot.name,
        timeZone: config.bot.timeZone,
        historyMaxMessages: config.bot.historyMaxMessages,
        historyMaxChars: config.bot.historyMaxChars,
        summaryEnabled: config.bot.summary.enabled,
        summaryTriggerMessages: config.bot.summary.triggerMessages,
        ignoreGroups: config.bot.ignoreGroups,
        allowedChatsConfigured: config.bot.allowedChatIds.size,
        adminEnabled: config.admin.enabled,
        webhookHmacEnabled: Boolean(config.waha.hmacKey),
        tattooArtist: tattoo.display,
        tattooArtistSource: tattoo.source,
        notionAgenda: notion.snapshot().databaseTitle,
        notionAgendaReady: notion.snapshot().ready,
      },
    });
  });

  return router;
}
