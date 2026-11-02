import type { AppConfig } from '../config.js';
import type { Repositories } from '../db/repositories/index.js';
import type { OllamaClient } from '../clients/ollama.js';
import type { Logger } from '../logger.js';
import { buildSummaryMessages } from '../domain/prompt.js';
import { collapseWhitespace, truncate } from '../utils/text.js';
import { errorMessage } from '../utils/async.js';

export class SummaryService {
  private readonly inFlight = new Set<number>();

  constructor(
    private readonly config: AppConfig,
    private readonly repos: Repositories,
    private readonly ollama: OllamaClient,
    private readonly logger: Logger,
  ) {}

  async maybeSummarize(
    conversationId: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const settings = this.config.bot.summary;
    if (!settings.enabled) return false;
    if (this.inFlight.has(conversationId)) return false;

    this.inFlight.add(conversationId);
    try {
      const conversation = this.repos.conversations.getById(conversationId);
      if (!conversation) return false;

      const previous = this.repos.summaries.latestActive(conversationId);
      const boundary = Math.max(
        conversation.context_start_message_id ?? 0,
        previous?.through_message_id ?? 0,
      );

      const count = this.repos.messages.countSince(conversationId, boundary);
      const chars = this.repos.messages.charsSince(conversationId, boundary);

      if (
        count < settings.triggerMessages &&
        chars < settings.triggerChars
      ) {
        return false;
      }

      if (count <= settings.keepRecentMessages) return false;

      const messages = this.repos.messages.listForSummary(
        conversationId,
        boundary,
        Number.MAX_SAFE_INTEGER,
        2000,
      );

      if (messages.length <= settings.keepRecentMessages) return false;

      const targetIndex = Math.max(
        0,
        messages.length - settings.keepRecentMessages - 1,
      );
      const target = messages[targetIndex];
      if (!target) return false;

      const newMessages = messages.filter(
        (message) =>
          message.id > (previous?.through_message_id ?? boundary) &&
          message.id <= target.id,
      );

      if (newMessages.length === 0) return false;

      const summaryMessages = buildSummaryMessages({
        previousSummary: previous?.summary ?? null,
        messages: newMessages,
        maxInputChars: settings.maxInputChars,
        botName: this.config.bot.name,
      });

      const result = await this.ollama.chat(summaryMessages, {
        temperature: 0.2,
        numPredict: settings.maxOutputTokens,
        signal,
      });

      const summary = truncate(
        collapseWhitespace(result.content),
        4000,
        '…',
      );
      if (!summary) return false;

      this.repos.summaries.insert({
        conversationId,
        summary,
        throughMessageId: target.id,
        messagesCovered:
          (previous?.messages_covered ?? 0) + newMessages.length,
        model: result.model,
      });

      this.logger.info(
        {
          conversationId,
          throughMessageId: target.id,
          summarizedMessages: newMessages.length,
          totalCovered: (previous?.messages_covered ?? 0) + newMessages.length,
          model: result.model,
        },
        'Resumen de conversación actualizado',
      );

      return true;
    } catch (error) {
      if (signal?.aborted) {
        this.logger.debug({ conversationId }, 'Resumen cancelado por cierre');
      } else {
        this.logger.warn(
          { conversationId, err: errorMessage(error) },
          'No se pudo actualizar el resumen de la conversación',
        );
      }
      return false;
    } finally {
      this.inFlight.delete(conversationId);
    }
  }
}
