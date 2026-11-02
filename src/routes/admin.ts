import { Router } from 'express';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Repositories } from '../db/repositories/index.js';
import type { HealthService } from '../services/health-service.js';
import type { ConversationService } from '../services/conversation-service.js';
import type { InboundWorker } from '../services/worker.js';
import type {
  ConversationListItem,
  MessageRow,
} from '../db/types.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { APP_VERSION } from '../version.js';
import { preview } from '../utils/text.js';

export interface AdminRouterDeps {
  config: AppConfig;
  repos: Repositories;
  health: HealthService;
  conversations: ConversationService;
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
  const { config, repos, health, conversations, worker } = deps;

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
      },
      stats,
      health: snapshot,
      worker: worker?.snapshot() ?? null,
      dashboardUrl: health.dashboardUrl,
    });
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
      },
    });
  });

  return router;
}
