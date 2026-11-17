import { GroqError } from '../errors.js';
import { createTimeoutSignal, errorMessage, sleep } from '../utils/async.js';
import type { AiChatOptions, AiChatResult, AiClient, AiHealth } from './ai.js';
import type { ChatMessage } from '../domain/prompt.js';

export interface GroqClientConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  numPredict: number;
  timeoutMs: number;
}

interface GroqChatResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

interface GroqModelsResponse {
  data?: Array<{ id?: string }>;
}

/**
 * Cliente de Groq (API compatible con OpenAI). Reemplaza a Ollama cuando se
 * usa un modelo en la nube, manteniendo el mismo contrato AiClient.
 */
export class GroqClient implements AiClient {
  private readonly baseUrl: string;

  constructor(
    private readonly config: GroqClientConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`,
      'User-Agent': 'whatsapp-ai-bot/1.0',
    };
  }

  async chat(
    messages: ChatMessage[],
    options: AiChatOptions = {},
  ): Promise<AiChatResult> {
    const body = {
      model: this.config.model,
      messages,
      temperature: options.temperature ?? this.config.temperature,
      max_tokens: options.numPredict ?? this.config.numPredict,
      stream: false,
    };
    // Groq no tiene `num_ctx` configurable por request: el contexto lo define
    // el modelo. Se ignora a propósito para no enviar un campo inválido.
    void options.numCtx;

    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const timeout = createTimeoutSignal(this.config.timeoutMs, options.signal);
      const startedAt = Date.now();
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: timeout.signal,
        });

        const text = await response.text();
        let parsed: GroqChatResponse | null = null;
        if (text) {
          try {
            parsed = JSON.parse(text) as GroqChatResponse;
          } catch {
            parsed = null;
          }
        }

        if (!response.ok) {
          const detail =
            parsed?.error?.message ??
            (typeof parsed === 'object' && parsed !== null ? JSON.stringify(parsed) : text);
          const error = new GroqError(
            `Groq respondió ${response.status}: ${detail.slice(0, 800)}`,
            response.status >= 500 || response.status === 429 ? 502 : response.status,
            parsed,
          );
          if (response.status < 500 && response.status !== 429) throw error;
          lastError = error;
          if (attempt === 2) throw error;
          await sleep(500);
          continue;
        }

        const content = parsed?.choices?.[0]?.message?.content?.trim() ?? '';
        if (!content) {
          throw new GroqError('Groq devolvió una respuesta vacía');
        }

        return {
          content,
          model: parsed?.model ?? this.config.model,
          promptTokens:
            typeof parsed?.usage?.prompt_tokens === 'number'
              ? parsed.usage.prompt_tokens
              : null,
          completionTokens:
            typeof parsed?.usage?.completion_tokens === 'number'
              ? parsed.usage.completion_tokens
              : null,
          latencyMs: Date.now() - startedAt,
        };
      } catch (error) {
        lastError = error;
        if (error instanceof GroqError && error.statusCode !== 502) throw error;
        if (attempt === 2 || options.signal?.aborted) {
          throw error instanceof GroqError
            ? error
            : new GroqError(`No se pudo contactar a Groq: ${errorMessage(error)}`, 502, error);
        }
        await sleep(500);
      } finally {
        timeout.cleanup();
      }
    }

    throw new GroqError(
      `Groq falló después de reintentar: ${errorMessage(lastError)}`,
      502,
      lastError,
    );
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
      const data = (await response.json()) as GroqModelsResponse;
      const models = (data.data ?? [])
        .map((item) => item.id)
        .filter((id): id is string => Boolean(id));
      return {
        ok: true,
        models,
        hasModel: models.includes(this.config.model),
      };
    } catch (error) {
      return {
        ok: false,
        models: [],
        hasModel: false,
        error: `No se pudo contactar a Groq: ${errorMessage(error)}`,
      };
    } finally {
      timeout.cleanup();
    }
  }
}
