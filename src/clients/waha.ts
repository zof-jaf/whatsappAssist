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

export interface WahaMediaFile {
  data: Buffer;
  mimetype: string;
  filename: string;
}

export interface WahaSendMediaInput {
  chatId: string;
  data: Buffer;
  mimetype: string;
  filename?: string | null;
  caption?: string | null;
}

export interface WahaSendMediaResult {
  id: string | null;
  raw: unknown;
}

const MAX_MEDIA_BYTES = 32 * 1024 * 1024;

const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'application/pdf': 'pdf',
};

function filenameFromUrl(url: string, mimetype: string): string {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
    if (name && name.includes('.')) return name.slice(0, 120);
  } catch {
    // La URL puede no ser absoluta; se usa el nombre por defecto.
  }
  return `archivo.${MIME_EXTENSIONS[mimetype] ?? 'bin'}`;
}

function extractMessageId(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id === 'string') return record.id;
  const data = record._data;
  if (typeof data === 'object' && data !== null) {
    const nested = (data as Record<string, unknown>).id;
    if (typeof nested === 'string') return nested;
  }
  return null;
}

export interface WahaSessionInfo {
  name?: string;
  status?: string;
  me?: { id?: string; pushName?: string } | null;
  [key: string]: unknown;
}

export interface WahaQrResult {
  mimetype: string;
  data: string;
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

    return { id: extractMessageId(raw), raw };
  }

  /**
   * Descarga un archivo multimedia servido por WAHA. Las URL suelen venir con
   * `localhost`, que dentro de Docker apunta al contenedor del bot; por eso se
   * reemplaza el origen por la URL interna configurada. El endpoint de archivos
   * exige la misma X-Api-Key que el resto de la API.
   */
  async downloadMedia(
    url: string,
    signal?: AbortSignal,
  ): Promise<WahaMediaFile> {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new WahaError(`URL de multimedia inválida: ${url.slice(0, 200)}`);
    }

    if (
      target.hostname === 'localhost' ||
      target.hostname === '127.0.0.1' ||
      target.hostname === '::1'
    ) {
      const base = new URL(this.baseUrl);
      target.protocol = base.protocol;
      target.host = base.host;
    }

    const timeout = createTimeoutSignal(
      Math.max(this.config.requestTimeoutMs, 30_000),
      signal,
    );

    try {
      const headers: Record<string, string> = {
        Accept: '*/*',
        'User-Agent': 'whatsapp-ai-bot/1.0',
      };
      if (this.config.apiKey) headers['X-Api-Key'] = this.config.apiKey;

      const response = await this.fetchImpl(target.toString(), {
        headers,
        signal: timeout.signal,
      });

      if (!response.ok) {
        throw new WahaError(
          `WAHA respondió ${response.status} al descargar multimedia`,
          response.status >= 500 ? 502 : response.status,
        );
      }

      const declaredSize = Number(response.headers.get('content-length') ?? 0);
      if (declaredSize > MAX_MEDIA_BYTES) {
        throw new WahaError('El archivo multimedia supera el límite permitido');
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_MEDIA_BYTES) {
        throw new WahaError('El archivo multimedia supera el límite permitido');
      }
      if (buffer.length === 0) {
        throw new WahaError('WAHA devolvió un archivo multimedia vacío');
      }

      const mimetype =
        response.headers.get('content-type')?.split(';')[0]?.trim() ||
        'application/octet-stream';

      return {
        data: buffer,
        mimetype,
        filename: filenameFromUrl(target.toString(), mimetype),
      };
    } catch (error) {
      if (error instanceof WahaError) throw error;
      throw new WahaError(
        `No se pudo descargar la multimedia: ${errorMessage(error)}`,
        502,
        error,
      );
    } finally {
      timeout.cleanup();
    }
  }

  /**
   * Envía una imagen o un archivo usando base64. WAHA tiene endpoints
   * separados para imágenes (`sendImage`) y documentos (`sendFile`).
   */
  async sendMedia(input: WahaSendMediaInput): Promise<WahaSendMediaResult> {
    const mimetype = input.mimetype || 'application/octet-stream';
    const filename =
      input.filename?.trim() || filenameFromUrl('', mimetype);
    const endpoint = mimetype.startsWith('image/')
      ? '/api/sendImage'
      : '/api/sendFile';

    const body: Record<string, unknown> = {
      session: this.config.session,
      chatId: input.chatId,
      file: {
        mimetype,
        filename,
        data: input.data.toString('base64'),
      },
    };
    if (input.caption?.trim()) body.caption = input.caption.trim();

    const raw = await this.request<unknown>(endpoint, {
      method: 'POST',
      body,
      timeoutMs: Math.max(this.config.requestTimeoutMs, 60_000),
    });

    return { id: extractMessageId(raw), raw };
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

  /**
   * Crea la sesión en WAHA si no existe. WAHA responde 422 si ya existe, así
   * que quien llama debe comprobar antes con getSession().
   */
  async createSession(): Promise<WahaSessionInfo> {
    return this.request<WahaSessionInfo>('/api/sessions', {
      method: 'POST',
      body: { name: this.config.session, start: true },
      timeoutMs: 15_000,
    });
  }

  async startSession(): Promise<WahaSessionInfo> {
    return this.request<WahaSessionInfo>(
      `/api/sessions/${encodeURIComponent(this.config.session)}/start`,
      { method: 'POST', timeoutMs: 10_000 },
    );
  }

  async restartSession(): Promise<WahaSessionInfo> {
    return this.request<WahaSessionInfo>(
      `/api/sessions/${encodeURIComponent(this.config.session)}/restart`,
      { method: 'POST', timeoutMs: 10_000 },
    );
  }

  /**
   * Devuelve el QR vigente como PNG en base64. Solo funciona mientras la
   * sesión está en SCAN_QR_CODE; en otro estado WAHA responde 422.
   */
  async getQr(): Promise<WahaQrResult> {
    const qr = await this.request<WahaQrResult>(
      `/api/${encodeURIComponent(this.config.session)}/auth/qr`,
      { timeoutMs: 10_000 },
    );

    if (!qr || typeof qr.data !== 'string' || qr.data.length === 0) {
      throw new WahaError('WAHA devolvió un código QR vacío', 502, qr);
    }

    return {
      mimetype:
        typeof qr.mimetype === 'string' && qr.mimetype
          ? qr.mimetype
          : 'image/png',
      data: qr.data,
    };
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
