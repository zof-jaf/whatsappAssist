import type { ChatMessage } from '../domain/prompt.js';
import type { AppConfig } from '../config.js';
import { OllamaError } from '../errors.js';
import { sleep, createTimeoutSignal, errorMessage } from '../utils/async.js';
import type { AiChatOptions, AiChatResult, AiClient, AiHealth } from './ai.js';

// Se mantienen los nombres históricos para no romper importaciones existentes.
export type OllamaChatOptions = AiChatOptions;
export type OllamaChatResult = AiChatResult;
export type OllamaHealth = AiHealth;

interface OllamaChatResponse {
  model?: string;
  message?: { role?: string; content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
}

export class OllamaClient implements AiClient {
  private readonly baseUrl: string;

  constructor(
    private readonly config: AppConfig['ollama'],
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = config.baseUrl;
  }

  async chat(
    messages: ChatMessage[],
    options: OllamaChatOptions = {},
  ): Promise<OllamaChatResult> {
    const body = {
      model: this.config.model,
      messages,
      stream: false,
      keep_alive: this.config.keepAlive,
      options: {
        temperature: options.temperature ?? this.config.temperature,
        num_ctx: options.numCtx ?? this.config.numCtx,
        num_predict: options.numPredict ?? this.config.numPredict,
      },
    };

    let lastError: unknown;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const timeout = createTimeoutSignal(this.config.timeoutMs, options.signal);
      const startedAt = Date.now();

      try {
        const response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': 'whatsapp-ai-bot/1.0',
          },
          body: JSON.stringify(body),
          signal: timeout.signal,
        });

        const text = await response.text();
        let parsed: OllamaChatResponse | null = null;
        if (text) {
          try {
            parsed = JSON.parse(text) as OllamaChatResponse;
          } catch {
            parsed = null;
          }
        }

        if (!response.ok) {
          const detail =
            typeof parsed === 'object' && parsed !== null
              ? JSON.stringify(parsed)
              : text;
          const error = new OllamaError(
            `Ollama respondió ${response.status}: ${detail.slice(0, 800)}`,
            response.status >= 500 ? 502 : response.status,
            parsed,
          );
          if (response.status < 500 || attempt === 2) throw error;
          lastError = error;
          await sleep(500);
          continue;
        }

        const content = parsed?.message?.content?.trim() ?? '';
        if (!content) {
          throw new OllamaError('Ollama devolvió una respuesta vacía');
        }

        return {
          content,
          model: parsed?.model ?? this.config.model,
          promptTokens:
            typeof parsed?.prompt_eval_count === 'number'
              ? parsed.prompt_eval_count
              : null,
          completionTokens:
            typeof parsed?.eval_count === 'number' ? parsed.eval_count : null,
          latencyMs: Date.now() - startedAt,
        };
      } catch (error) {
        lastError = error;
        if (error instanceof OllamaError && error.statusCode !== 502) {
          throw error;
        }
        if (attempt === 2 || options.signal?.aborted) {
          throw error instanceof OllamaError
            ? error
            : new OllamaError(
                `No se pudo contactar a Ollama: ${errorMessage(error)}`,
                502,
                error,
              );
        }
        await sleep(500);
      } finally {
        timeout.cleanup();
      }
    }

    throw new OllamaError(
      `Ollama falló después de reintentar: ${errorMessage(lastError)}`,
      502,
      lastError,
    );
  }

  async health(): Promise<OllamaHealth> {
    const timeout = createTimeoutSignal(4000);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/tags`, {
        headers: { Accept: 'application/json' },
        signal: timeout.signal,
      });

      if (!response.ok) {
        return {
          ok: false,
          models: [],
          hasModel: false,
          error: `HTTP ${response.status}`,
        };
      }

      const data = (await response.json()) as {
        models?: Array<{ name?: string; model?: string }>;
      };
      const models = (data.models ?? [])
        .map((model) => model.name ?? model.model)
        .filter((name): name is string => Boolean(name));

      return {
        ok: true,
        models,
        hasModel: models.some(
          (name) =>
            name === this.config.model ||
            name === `${this.config.model}:latest` ||
            name.startsWith(`${this.config.model}:`),
        ),
      };
    } catch (error) {
      return {
        ok: false,
        models: [],
        hasModel: false,
        error: errorMessage(error),
      };
    } finally {
      timeout.cleanup();
    }
  }
}
