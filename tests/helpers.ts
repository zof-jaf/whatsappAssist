import { createHmac, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import request from 'supertest';
import { loadConfig, type AppConfig } from '../src/config.js';
import { closeDatabase, openDatabase, type Db } from '../src/db/database.js';
import { createRepositories, type Repositories } from '../src/db/repositories/index.js';
import { createSilentLogger, type Logger } from '../src/logger.js';
import { WahaClient, type WahaSendTextInput, type WahaSendTextResult, type WahaSessionInfo } from '../src/clients/waha.js';
import { OllamaClient, type OllamaChatOptions, type OllamaChatResult, type OllamaHealth } from '../src/clients/ollama.js';
import { OllamaError } from '../src/errors.js';
import { SummaryService } from '../src/services/summary-service.js';
import { ConversationService } from '../src/services/conversation-service.js';
import { HealthService } from '../src/services/health-service.js';
import { createApp } from '../src/app.js';
import type { ChatMessage } from '../src/domain/prompt.js';
import type { WahaWebhookEvent } from '../src/domain/waha.js';
import type { MessageRow } from '../src/db/types.js';

export class FakeWahaClient extends WahaClient {
  sent: Array<{ chatId: string; text: string; replyTo?: string | null }> = [];
  seen: string[] = [];
  typingStarted: string[] = [];
  typingStopped: string[] = [];
  failNextSend?: Error;
  sessionStatus = 'WORKING';
  private counter = 0;

  constructor(config: AppConfig['waha']) {
    super(config);
  }

  override async sendText(input: WahaSendTextInput): Promise<WahaSendTextResult> {
    if (this.failNextSend) {
      const error = this.failNextSend;
      this.failNextSend = undefined;
      throw error;
    }
    this.sent.push({
      chatId: input.chatId,
      text: input.text,
      replyTo: input.replyTo ?? null,
    });
    this.counter += 1;
    return { id: `fake-wa-${this.counter}`, raw: {} };
  }

  override async sendSeen(chatId: string): Promise<void> {
    this.seen.push(chatId);
  }

  override async startTyping(chatId: string): Promise<void> {
    this.typingStarted.push(chatId);
  }

  override async stopTyping(chatId: string): Promise<void> {
    this.typingStopped.push(chatId);
  }

  override async getSession(): Promise<WahaSessionInfo> {
    return { status: this.sessionStatus, me: { id: 'me@c.us', pushName: 'Bot' } };
  }

  override async health(): Promise<{ ok: boolean; body?: unknown; error?: string }> {
    return { ok: true, body: 'ok' };
  }
}

export class FakeOllamaClient extends OllamaClient {
  calls: ChatMessage[][] = [];
  responses: string[] = [];
  defaultResponse = 'Hola, ¿en qué puedo ayudarte?';
  failChats = 0;
  private readonly modelName: string;

  constructor(config: AppConfig['ollama']) {
    super(config);
    this.modelName = config.model;
  }

  override async chat(
    messages: ChatMessage[],
    _options: OllamaChatOptions = {},
  ): Promise<OllamaChatResult> {
    this.calls.push(messages);
    if (this.failChats > 0) {
      this.failChats -= 1;
      throw new OllamaError('Ollama simulado caído', 502);
    }
    return {
      content: this.responses.shift() ?? this.defaultResponse,
      model: this.modelName,
      promptTokens: 10,
      completionTokens: 5,
      latencyMs: 3,
    };
  }

  override async health(): Promise<OllamaHealth> {
    return {
      ok: true,
      models: [this.modelName],
      hasModel: true,
    };
  }
}

export interface TestContext {
  config: AppConfig;
  db: Db;
  repos: Repositories;
  logger: Logger;
  waha: FakeWahaClient;
  ollama: FakeOllamaClient;
  health: HealthService;
  summaries: SummaryService;
  conversations: ConversationService;
  app: ReturnType<typeof createApp>;
  close: () => void;
}

export function createTestContext(
  overrides: NodeJS.ProcessEnv = {},
): TestContext {
  const config = loadConfig({
    NODE_ENV: 'test',
    ADMIN_TOKEN: 'test-admin-token-1234567890',
    WAHA_WEBHOOK_HMAC_KEY: 'test-hmac-secret',
    DATABASE_PATH: ':memory:',
    OLLAMA_MODEL: 'test-model:1b',
    LOG_LEVEL: 'silent',
    ...overrides,
  });

  const db = openDatabase(':memory:');
  const repos = createRepositories(db);
  const logger = createSilentLogger();
  const waha = new FakeWahaClient(config.waha);
  const ollama = new FakeOllamaClient(config.ollama);
  const health = new HealthService(config, db, repos, waha, ollama);
  const summaries = new SummaryService(config, repos, ollama, logger);
  const conversations = new ConversationService(
    config,
    repos,
    waha,
    ollama,
    summaries,
    logger,
  );
  const app = createApp({
    config,
    db,
    repos,
    waha,
    ollama,
    conversations,
    health,
    logger,
    publicDir: resolve(process.cwd(), 'public'),
  });

  return {
    config,
    db,
    repos,
    logger,
    waha,
    ollama,
    health,
    summaries,
    conversations,
    app,
    close: () => closeDatabase(db),
  };
}

let messageCounter = 0;

export function makeMessageEvent(options: {
  from?: string;
  body?: string;
  fromMe?: boolean;
  hasMedia?: boolean;
  media?: { url?: string; mimetype?: string; filename?: string };
  event?: 'message' | 'message.any';
  id?: string;
  session?: string;
} = {}): WahaWebhookEvent {
  messageCounter += 1;
  const timestamp = Math.floor(Date.now() / 1000);
  const from = options.from ?? '5491111111111@c.us';

  return {
    id: `evt-${randomUUID()}`,
    event: options.event ?? 'message',
    session: options.session ?? 'default',
    engine: 'WEBJS',
    timestamp: Date.now(),
    payload: {
      id: options.id ?? `false_${from}_MSG${messageCounter}`,
      timestamp,
      from,
      fromMe: options.fromMe ?? false,
      body: options.body ?? 'Hola',
      hasMedia: options.hasMedia ?? false,
      media: options.media ?? null,
      _data: { notifyName: 'Contacto de Prueba' },
    },
  };
}

export function makeAckEvent(
  waMessageId: string,
  ackName: string,
  ack: number,
): WahaWebhookEvent {
  return {
    id: `evt-${randomUUID()}`,
    event: 'message.ack',
    session: 'default',
    engine: 'WEBJS',
    payload: {
      id: waMessageId,
      fromMe: true,
      ack,
      ackName,
    },
  };
}

export function signedPost(
  app: ReturnType<typeof createApp>,
  secret: string,
  event: WahaWebhookEvent,
) {
  const rawBody = JSON.stringify(event);
  const signature = signBody(rawBody, secret);
  return request(app)
    .post('/webhook')
    .set('Content-Type', 'application/json')
    .set('X-Webhook-Hmac-Algorithm', 'sha512')
    .set('X-Webhook-Hmac', signature)
    .send(rawBody);
}

export function signBody(body: string, secret: string): string {
  return createHmac('sha512', secret).update(body).digest('hex');
}

export async function enqueueMessage(
  ctx: TestContext,
  event: WahaWebhookEvent,
): Promise<MessageRow> {
  const payload = event.payload as { id: string; from: string };
  const job = ctx.repos.jobs.enqueue({
    waMessageId: payload.id,
    chatId: payload.from,
    eventId: event.id,
    payload: JSON.stringify(event),
    maxAttempts: ctx.config.queue.maxAttempts,
  });

  if (!job.inserted) throw new Error('El job ya existía');
  await ctx.conversations.processJob(job.job);
  return ctx.repos.messages.getByWaMessageId(payload.id) as MessageRow;
}
