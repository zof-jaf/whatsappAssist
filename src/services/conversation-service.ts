import type { AppConfig } from '../config.js';
import type { ContactRow, ConversationRow, InboundJobRow, MessageRow } from '../db/types.js';
import type { Repositories } from '../db/repositories/index.js';
import type { WahaClient } from '../clients/waha.js';
import type { OllamaClient } from '../clients/ollama.js';
import type { Logger } from '../logger.js';
import type { SummaryService } from './summary-service.js';
import type { QuoteService } from './quote-service.js';
import type { SchedulingService } from './scheduling-service.js';
import type { ResponseGuideService } from './response-guide-service.js';
import {
  isWahaWebhookEvent,
  parseMessageEvent,
  type NormalizedInboundMessage,
  type WahaWebhookEvent,
} from '../domain/waha.js';
import { buildPrompt } from '../domain/prompt.js';
import {
  hasMeaningfulText,
  naturalReplyFallback,
  stripGuideLeaks,
} from '../domain/reply-sanitizer.js';
import {
  helpText,
  matchCommand,
  resetText,
} from '../domain/commands.js';
import { nowIso } from '../utils/time.js';
import {
  errorMessage,
  isAbortError,
} from '../utils/async.js';
import { sanitizeReply, truncate } from '../utils/text.js';
import { NotFoundError, OllamaError, ValidationError } from '../errors.js';
import { PermanentJobError } from './job-errors.js';

interface DeliverReplyOptions {
  conversation: ConversationRow;
  contact: ContactRow;
  inbound: MessageRow;
  text: string;
  kind: 'text' | 'command' | 'system';
  model?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  latencyMs?: number | null;
}

export class ConversationService {
  constructor(
    private readonly config: AppConfig,
    private readonly repos: Repositories,
    private readonly waha: WahaClient,
    private readonly ollama: OllamaClient,
    private readonly summaries: SummaryService,
    private readonly quotes: QuoteService,
    private readonly scheduling: SchedulingService,
    private readonly responseGuide: ResponseGuideService,
    private readonly logger: Logger,
  ) {}

  async processJob(job: InboundJobRow, signal?: AbortSignal): Promise<void> {
    let event: WahaWebhookEvent;
    try {
      const parsed: unknown = JSON.parse(job.payload);
      if (!isWahaWebhookEvent(parsed)) {
        throw new Error('El payload no es un evento de WAHA');
      }
      event = parsed;
    } catch (error) {
      throw new PermanentJobError('Payload de trabajo inválido', {
        cause: error,
      });
    }

    const parsed = parseMessageEvent(event);
    if (!parsed.ok || !parsed.message) {
      throw new PermanentJobError(
        `No se pudo interpretar el mensaje: ${parsed.reason ?? 'desconocido'}`,
      );
    }

    const message = parsed.message;
    if (message.fromMe) {
      this.logger.debug(
        { chatId: message.chatId, waMessageId: message.waMessageId },
        'Mensaje propio ignorado',
      );
      return;
    }

    const contact = this.repos.contacts.upsert({
      waId: message.chatId,
      phone: message.phone,
      pushName: message.pushName,
      displayName: message.pushName ?? message.phone ?? message.chatId,
    });
    const conversation = this.repos.conversations.getOrCreate(contact.id);

    const inbound = this.repos.messages.insertInbound({
      conversationId: conversation.id,
      contactId: contact.id,
      waMessageId: message.waMessageId,
      body: message.body,
      kind: message.kind,
      mediaUrl: message.mediaUrl,
      mediaMime: message.mediaMime,
      mediaFilename: message.mediaFilename,
      waTimestamp: message.timestampIso,
    });

    if (inbound.inserted) {
      this.repos.conversations.touchInbound(
        conversation.id,
        inbound.message.created_at,
      );
      this.logger.info(
        {
          conversationId: conversation.id,
          chatId: message.chatId,
          waMessageId: message.waMessageId,
          kind: message.kind,
          bodyChars: message.body.length,
          media: message.hasMedia,
        },
        'Mensaje entrante guardado',
      );
    }

    const alreadyDelivered = this.repos.messages.findOutboundReply(
      inbound.message.id,
    );
    if (
      alreadyDelivered &&
      ['sent', 'delivered', 'read'].includes(alreadyDelivered.status)
    ) {
      this.logger.debug(
        { conversationId: conversation.id, replyId: alreadyDelivered.id },
        'La respuesta ya había sido enviada; trabajo completado',
      );
      return;
    }

    if (!this.config.bot.enabled) {
      this.repos.messages.markSkipped(inbound.message.id, 'bot_desactivado');
      this.logger.info(
        { conversationId: conversation.id },
        'Bot desactivado globalmente; mensaje sin respuesta',
      );
      return;
    }

    // El chat del tatuador no recibe respuestas de IA: sus mensajes son
    // respuestas de cotización que se reenvían al cliente correspondiente.
    if (this.quotes.isArtistChat(message.chatId, message.phoneJid)) {
      await this.quotes.handleArtistMessage({
        message,
        conversation,
        contact,
        inbound: inbound.message,
        signal,
      });
      return;
    }

    if (!conversation.ai_enabled) {
      this.repos.messages.markSkipped(inbound.message.id, 'ia_desactivada');
      this.logger.info(
        { conversationId: conversation.id },
        'IA desactivada para la conversación; mensaje sin respuesta',
      );
      return;
    }

    if (conversation.status === 'archived') {
      this.repos.messages.markSkipped(inbound.message.id, 'conversacion_archivada');
      this.logger.info(
        { conversationId: conversation.id },
        'Conversación archivada; mensaje sin respuesta',
      );
      return;
    }

    // Si ya existe una respuesta pendiente o fallida, se reintenta el envío
    // sin volver a llamar al modelo (evita respuestas distintas y costo extra).
    const pendingReply = this.repos.messages.findOutboundReply(inbound.message.id);
    if (pendingReply) {
      await this.deliverReply({
        conversation,
        contact,
        inbound: inbound.message,
        text: pendingReply.body,
        kind:
          pendingReply.kind === 'command' || pendingReply.kind === 'system'
            ? pendingReply.kind
            : 'text',
        model: pendingReply.model,
      });
      return;
    }

    if (this.config.waha.sendSeen) {
      await this.safeWahaCall(
        () => this.waha.sendSeen(message.chatId),
        'No se pudo marcar el mensaje como leído',
      );
    }

    const command = matchCommand(message.body);
    if (command) {
      await this.handleCommand(
        command,
        message,
        contact,
        conversation,
        inbound.message,
      );
      return;
    }

    // Si el cliente ya recibió el precio y elige día y hora, la cita se
    // registra en Notion antes de confirmarla. Se corre primero para que una
    // confirmación de cita (p. ej. "el martes a las 4") no se clasifique como
    // una nueva cotización.
    const schedulingOutcome = await this.scheduling.tryHandleClientMessage({
      message,
      conversation,
      contact,
      inbound: inbound.message,
    });
    if (schedulingOutcome.handled) {
      await this.deliverReply({
        conversation,
        contact,
        inbound: inbound.message,
        text: schedulingOutcome.replyText,
        kind: 'system',
      });
      await this.summaries.maybeSummarize(conversation.id, signal);
      return;
    }

    // Si el cliente pide precio, manda medidas o imágenes, la consulta se
    // deriva al tatuador y no se llama al modelo.
    const quoteOutcome = await this.quotes.handleClientMessage({
      message,
      conversation,
      contact,
      inbound: inbound.message,
      signal,
    });
    if (quoteOutcome.handled) {
      await this.deliverReply({
        conversation,
        contact,
        inbound: inbound.message,
        text: quoteOutcome.replyText,
        kind: 'system',
      });
      await this.summaries.maybeSummarize(conversation.id, signal);
      return;
    }

    if (message.kind === 'media' && message.body.trim().length === 0) {
      await this.deliverReply({
        conversation,
        contact,
        inbound: inbound.message,
        text:
          'Por ahora solo puedo procesar mensajes de texto. Si querés, escribime en palabras qué necesitás y te ayudo.',
        kind: 'system',
      });
      this.logger.info(
        { conversationId: conversation.id, waMessageId: message.waMessageId },
        'Multimedia sin texto respondida con aviso',
      );
      return;
    }

    let typingStarted = false;
    if (this.config.waha.typingIndicator) {
      typingStarted = await this.safeWahaCall(
        async () => {
          await this.waha.startTyping(message.chatId);
          return true;
        },
        'No se pudo activar el indicador de escritura',
        false,
      );
    }

    let replyGenerated = false;

    try {
      await this.generateAndSendReply({
        conversation,
        contact,
        inbound: inbound.message,
        message,
        signal,
      });
      replyGenerated = true;
    } catch (error) {
      if (
        signal?.aborted ||
        isAbortError(error) ||
        !(error instanceof OllamaError)
      ) {
        // Los fallos de envío o de base se reintentan sin regenerar la respuesta.
        throw error;
      }

      this.logger.error(
        {
          conversationId: conversation.id,
          waMessageId: message.waMessageId,
          err: errorMessage(error),
        },
        'Falló la generación de la respuesta con IA',
      );

      await this.deliverReply({
        conversation,
        contact,
        inbound: inbound.message,
        text: this.config.bot.aiFallbackReply,
        kind: 'system',
      });
    } finally {
      if (typingStarted) {
        await this.safeWahaCall(
          () => this.waha.stopTyping(message.chatId),
          'No se pudo desactivar el indicador de escritura',
        );
      }
    }

    if (replyGenerated) {
      await this.summaries.maybeSummarize(conversation.id, signal);
    }
  }

  async sendManualMessage(
    conversationId: number,
    text: string,
  ): Promise<MessageRow> {
    const normalized = text.trim();
    if (!normalized) {
      throw new ValidationError('El mensaje no puede estar vacío');
    }

    const conversation = this.repos.conversations.getById(conversationId);
    if (!conversation) throw new NotFoundError('Conversación no encontrada');

    const contact = this.repos.contacts.getById(conversation.contact_id);
    if (!contact) throw new NotFoundError('Contacto no encontrado');

    const outbound = this.repos.messages.insertOutbound({
      conversationId,
      contactId: contact.id,
      body: normalized,
      kind: 'text',
      status: 'queued',
      model: 'manual',
    });
    this.repos.conversations.touchOutbound(conversationId, outbound.created_at);

    try {
      const result = await this.waha.sendText({
        chatId: contact.wa_id,
        text: normalized,
      });
      this.repos.messages.markSent(outbound.id, {
        waMessageId: result.id,
        status: 'sent',
      });
      this.repos.conversations.touchOutbound(conversationId, nowIso());
      this.logger.info(
        {
          conversationId,
          outboundId: outbound.id,
          waMessageId: result.id,
          manual: true,
        },
        'Mensaje manual enviado',
      );
      return this.repos.messages.getById(outbound.id) as MessageRow;
    } catch (error) {
      this.repos.messages.markFailed(outbound.id, errorMessage(error));
      throw error;
    }
  }

  async retryOutboundMessage(messageId: number): Promise<MessageRow> {
    const message = this.repos.messages.getById(messageId);
    if (!message || message.direction !== 'out') {
      throw new NotFoundError('Mensaje saliente no encontrado');
    }

    if (['sent', 'delivered', 'read'].includes(message.status)) {
      return message;
    }

    const conversation = this.repos.conversations.getById(
      message.conversation_id,
    );
    if (!conversation) throw new NotFoundError('Conversación no encontrada');
    const contact = this.repos.contacts.getById(conversation.contact_id);
    if (!contact) throw new NotFoundError('Contacto no encontrado');

    try {
      const result = await this.waha.sendText({
        chatId: contact.wa_id,
        text: message.body,
      });
      this.repos.messages.markSent(message.id, {
        waMessageId: result.id,
        status: 'sent',
      });
      this.repos.conversations.touchOutbound(conversation.id, nowIso());
      return this.repos.messages.getById(message.id) as MessageRow;
    } catch (error) {
      this.repos.messages.markFailed(message.id, errorMessage(error));
      throw error;
    }
  }

  private async handleCommand(
    command: 'reset' | 'help' | 'status',
    message: NormalizedInboundMessage,
    contact: ContactRow,
    conversation: ConversationRow,
    inbound: MessageRow,
  ): Promise<void> {
    let text: string;

    if (command === 'reset') {
      this.repos.conversations.resetContext(conversation.id);
      text = resetText();
    } else if (command === 'help') {
      text = helpText(this.config.bot.name);
    } else {
      const summary = this.repos.summaries.latestActive(conversation.id);
      const boundary = Math.max(
        conversation.context_start_message_id ?? 0,
        summary?.through_message_id ?? 0,
      );
      const contextCount = this.repos.messages.countSince(
        conversation.id,
        boundary,
      );
      text = [
        `Modelo: ${this.config.ollama.model}`,
        `Mensajes en contexto: ${contextCount}`,
        `Resumen activo: ${summary ? 'sí' : 'no'}`,
        `IA: ${conversation.ai_enabled ? 'activada' : 'desactivada'}`,
      ].join('\n');
    }

    await this.deliverReply({
      conversation,
      contact,
      inbound,
      text,
      kind: 'command',
    });

    this.logger.info(
      {
        conversationId: conversation.id,
        chatId: message.chatId,
        command,
      },
      'Comando procesado',
    );
  }

  private async generateAndSendReply(input: {
    conversation: ConversationRow;
    contact: ContactRow;
    inbound: MessageRow;
    message: NormalizedInboundMessage;
    signal?: AbortSignal;
  }): Promise<void> {
    const summary = this.repos.summaries.latestActive(input.conversation.id);
    const boundary = Math.max(
      input.conversation.context_start_message_id ?? 0,
      summary?.through_message_id ?? 0,
    );
    const contextMessages = this.repos.messages.contextAfter(
      input.conversation.id,
      boundary,
      500,
    );

    const responseGuide = await this.responseGuide.get();
    const quoteNote = this.quotes.promptNote(input.conversation.id);

    const prompt = buildPrompt(
      this.config,
      contextMessages,
      summary?.summary ?? null,
      { responseGuide, quoteNote },
    );

    if (!prompt.messages.some((item) => item.role === 'user')) {
      prompt.messages.push({
        role: 'user',
        content: truncate(
          input.message.body,
          this.config.bot.promptMaxMessageChars,
        ),
      });
    }

    const result = await this.ollama.chat(prompt.messages, {
      signal: input.signal,
    });

    const rawReply = sanitizeReply(result.content);
    const cleaned = stripGuideLeaks(rawReply);
    let reply = truncate(cleaned.text, this.config.bot.maxReplyChars);

    if (cleaned.leaked) {
      this.logger.warn(
        {
          conversationId: input.conversation.id,
          original: truncate(rawReply, 300),
          cleaned: truncate(reply, 300),
        },
        'La respuesta de IA incluía la guía interna; se limpió antes de enviar',
      );
    }

    if (!hasMeaningfulText(reply)) {
      reply = naturalReplyFallback(input.message.body);
    }

    const safeReply = this.quotes.sanitizeReply(
      reply,
      input.conversation.id,
    );
    if (safeReply !== reply) {
      this.logger.warn(
        {
          conversationId: input.conversation.id,
          original: truncate(reply, 300),
        },
        'Respuesta de IA reemplazada por la red de seguridad de cotización',
      );
      reply = safeReply;
    }

    await this.deliverReply({
      conversation: input.conversation,
      contact: input.contact,
      inbound: input.inbound,
      text: reply,
      kind: 'text',
      model: result.model,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      latencyMs: result.latencyMs,
    });

    this.logger.info(
      {
        conversationId: input.conversation.id,
        chatId: input.message.chatId,
        model: result.model,
        latencyMs: result.latencyMs,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        replyChars: reply.length,
        contextMessages: prompt.includedMessages,
        contextTruncated: prompt.truncated,
      },
      'Respuesta de IA enviada',
    );
  }

  private async deliverReply(options: DeliverReplyOptions): Promise<void> {
    let outbound = this.repos.messages.findOutboundReply(options.inbound.id);

    if (!outbound) {
      outbound = this.repos.messages.insertOutbound({
        conversationId: options.conversation.id,
        contactId: options.contact.id,
        body: options.text,
        kind: options.kind,
        status: 'queued',
        model: options.model ?? null,
        replyToMessageId: options.inbound.id,
        promptTokens: options.promptTokens ?? null,
        completionTokens: options.completionTokens ?? null,
        latencyMs: options.latencyMs ?? null,
      });
      this.repos.conversations.touchOutbound(
        options.conversation.id,
        outbound.created_at,
      );
    }

    if (['sent', 'delivered', 'read'].includes(outbound.status)) {
      return;
    }

    try {
      const result = await this.waha.sendText({
        chatId: options.contact.wa_id,
        text: outbound.body,
        replyTo: this.config.waha.quoteReplies
          ? options.inbound.wa_message_id
          : null,
      });

      this.repos.messages.markSent(outbound.id, {
        waMessageId: result.id,
        status: 'sent',
      });
      this.repos.conversations.touchOutbound(
        options.conversation.id,
        nowIso(),
      );

      this.logger.info(
        {
          conversationId: options.conversation.id,
          chatId: options.contact.wa_id,
          outboundId: outbound.id,
          waMessageId: result.id,
          kind: options.kind,
        },
        'Respuesta enviada por WhatsApp',
      );
    } catch (error) {
      this.repos.messages.markFailed(outbound.id, errorMessage(error));
      throw error;
    }
  }

  private async safeWahaCall<T>(
    action: () => Promise<T>,
    context: string,
    fallback?: T,
  ): Promise<T> {
    try {
      return await action();
    } catch (error) {
      this.logger.debug({ err: errorMessage(error) }, context);
      return fallback as T;
    }
  }
}
