import type { AppConfig } from '../config.js';
import { WahaError } from '../errors.js';
import { createTimeoutSignal, errorMessage } from '../utils/async.js';

export interface WahaSendTextInput {
  chatId: string;
  text: string;
  replyTo?: string | null;
}

export interface WahaSendTextResult {
  id: string | null;
  raw: unknown;
}

export interface WahaSessionInfo {
  name?: string;
  status?: string;
  me?: { id?: string; pushName?: string } | null;
  [key: string]: unknown;
}

export class WahaClient {
  private readonly baseUrl: string;

  constructor(
    private readonly config: AppConfig['waha'],
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = config.baseUrl;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'whatsapp-ai-bot/1.0',
    };
    if (this.config.apiKey) headers['X-Api-Key'] = this.config.apiKey;
    return headers;
  }

  private async request<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    const timeout = createTimeoutSignal(
      options.timeoutMs ?? this.config.requestTimeoutMs,
      options.signal,
    );

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: options.method ?? 'GET',
        headers: this.headers(),
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: timeout.signal,
      });

      const text = await response.text();
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          parsed = text;
        }
      }

      if (!response.ok) {
        const detail =
          typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
        throw new WahaError(
          `WAHA respondió ${response.status} en ${path}: ${detail.slice(0, 800)}`,
          response.status >= 500 ? 502 : response.status,
          parsed,
        );
      }

      return parsed as T;
    } catch (error) {
      if (error instanceof WahaError) throw error;
      throw new WahaError(
        `No se pudo contactar a WAHA en ${path}: ${errorMessage(error)}`,
        502,
        error,
      );
    } finally {
      timeout.cleanup();
    }
  }

  async sendText(input: WahaSendTextInput): Promise<WahaSendTextResult> {
    const body: Record<string, unknown> = {
      session: this.config.session,
      chatId: input.chatId,
      text: input.text,
    };
    if (input.replyTo) body.reply_to = input.replyTo;

    const raw = await this.request<unknown>('/api/sendText', {
      method: 'POST',
      body,
    });

    let id: string | null = null;
    if (typeof raw === 'object' && raw !== null) {
      const record = raw as Record<string, unknown>;
      if (typeof record.id === 'string') id = record.id;
      const data = record._data;
      if (!id && typeof data === 'object' && data !== null) {
        const nested = (data as Record<string, unknown>).id;
        if (typeof nested === 'string') id = nested;
      }
    }

    return { id, raw };
  }

  async sendSeen(chatId: string): Promise<void> {
    await this.request('/api/sendSeen', {
      method: 'POST',
      body: { session: this.config.session, chatId },
    });
  }

  async startTyping(chatId: string): Promise<void> {
    await this.request('/api/startTyping', {
      method: 'POST',
      body: { session: this.config.session, chatId },
    });
  }

  async stopTyping(chatId: string): Promise<void> {
    await this.request('/api/stopTyping', {
      method: 'POST',
      body: { session: this.config.session, chatId },
    });
  }

  async getSession(): Promise<WahaSessionInfo> {
    return this.request<WahaSessionInfo>(
      `/api/sessions/${encodeURIComponent(this.config.session)}`,
      { timeoutMs: 5000 },
    );
  }

  async health(): Promise<{ ok: boolean; body?: unknown; error?: string }> {
    const timeout = createTimeoutSignal(4000);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/health`, {
        headers: this.headers(),
        signal: timeout.signal,
      });
      const body = await response.text();
      return { ok: response.ok, body };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    } finally {
      timeout.cleanup();
    }
  }
}
