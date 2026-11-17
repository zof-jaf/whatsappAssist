import type { ChatMessage } from '../domain/prompt.js';
import { AiError } from '../errors.js';
import { createTimeoutSignal, errorMessage } from '../utils/async.js';
import type { AiChatOptions, AiChatResult, AiClient, AiHealth } from './ai.js';

export interface AnthropicClientConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  temperature: number;
  timeoutMs: number;
}

interface AnthropicMessageResponse {
  content?: Array<{ type?: string; text?: string }>;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

interface AnthropicModelsResponse {
  data?: Array<{ id?: string }>;
}

/** Cliente para la API de Anthropic (formato Messages, distinto a OpenAI). */
export class AnthropicClient implements AiClient {
  private readonly baseUrl: string;

  constructor(
    private readonly config: AnthropicClientConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-api-key': this.config.apiKey,
      'anthropic-version': '2023-06-01',
      'User-Agent': 'whatsapp-ai-bot/1.0',
    };
  }

  async chat(
    messages: ChatMessage[],
    options: AiChatOptions = {},
  ): Promise<AiChatResult> {
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
    const conversation = messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({ role: message.role, content: message.content }));

    const timeout = createTimeoutSignal(this.config.timeoutMs, options.signal);
    const startedAt = Date.now();
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: options.numPredict ?? this.config.maxTokens,
          temperature: options.temperature ?? this.config.temperature,
          ...(system ? { system } : {}),
          messages: conversation,
        }),
        signal: timeout.signal,
      });

      const text = await response.text();
      let parsed: AnthropicMessageResponse | null = null;
      if (text) {
        try {
          parsed = JSON.parse(text) as AnthropicMessageResponse;
        } catch {
          parsed = null;
        }
      }

      if (!response.ok) {
        throw new AiError(
          `Anthropic respondió ${response.status}: ${(
            parsed?.error?.message || text
          ).slice(0, 800)}`,
        );
      }

      const content = (parsed?.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('')
        .trim();
      if (!content) throw new AiError('Anthropic devolvió una respuesta vacía');

      return {
        content,
        model: parsed?.model ?? this.config.model,
        promptTokens: parsed?.usage?.input_tokens ?? null,
        completionTokens: parsed?.usage?.output_tokens ?? null,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      if (error instanceof AiError) throw error;
      throw new AiError(`No se pudo contactar a Anthropic: ${errorMessage(error)}`);
    } finally {
      timeout.cleanup();
    }
  }

  async health(): Promise<AiHealth> {
    const timeout = createTimeoutSignal(this.config.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/models`, {
        headers: this.headers(),
        signal: timeout.signal,
      });
      if (!response.ok) {
        return { ok: false, models: [], hasModel: false, error: `HTTP ${response.status}` };
      }
      const data = (await response.json()) as AnthropicModelsResponse;
      const models = (data.data ?? [])
        .map((item) => item.id)
        .filter((id): id is string => Boolean(id));
      return { ok: true, models, hasModel: models.includes(this.config.model) };
    } catch (error) {
      return {
        ok: false,
        models: [],
        hasModel: false,
        error: `No se pudo contactar a Anthropic: ${errorMessage(error)}`,
      };
    } finally {
      timeout.cleanup();
    }
  }
}
