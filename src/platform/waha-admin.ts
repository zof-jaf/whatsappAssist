import type { PlatformConfig } from './config.js';

export type WahaSessionStatus =
  | 'STOPPED'
  | 'STARTING'
  | 'SCAN_QR_CODE'
  | 'WORKING'
  | 'FAILED'
  | 'CONFLICT'
  | 'UNKNOWN';

export interface WahaSessionInfo {
  name: string;
  status: WahaSessionStatus;
  me?: { id?: string; pushName?: string } | null;
}

export interface WahaQr {
  mimetype: string;
  /** base64 del PNG (sin prefijo data:). */
  data: string;
  dataUrl: string;
}

interface RawResponse {
  status: number;
  ok: boolean;
  body: unknown;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Cliente de administración de WAHA.
 *
 * Usa el WAHA_ADMIN_API_KEY (token de administrador) para gestionar CUALQUIER
 * sesión. Cada usuario tiene un nombre de sesión propio y una API key propia
 * guardada en PostgreSQL, de modo que no se comparten variables de entorno
 * entre proyectos.
 */
export class WahaAdminClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly apiKey?: string;

  constructor(config: PlatformConfig, private readonly fetchImpl: typeof fetch = fetch) {
    this.baseUrl = config.WAHA_BASE_URL.replace(/\/+$/, '');
    this.timeoutMs = config.WAHA_REQUEST_TIMEOUT_MS;
    this.apiKey = config.WAHA_ADMIN_API_KEY;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'whatsapp-platform/1.0',
    };
    if (this.apiKey) headers['X-Api-Key'] = this.apiKey;
    return headers;
  }

  private async request(path: string, options: { method?: string; body?: unknown } = {}): Promise<RawResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: options.method ?? 'GET',
        headers: this.headers(),
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
      const text = await response.text();
      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      return { status: response.status, ok: response.ok, body };
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const response = await this.fetchImpl(`${this.baseUrl}/health`, {
        headers: this.headers(),
        signal: controller.signal,
      });
      clearTimeout(timer);
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Devuelve null cuando la sesión no existe (404). */
  async getSession(name: string): Promise<WahaSessionInfo | null> {
    const res = await this.request(`/api/sessions/${encodeURIComponent(name)}`);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`WAHA getSession ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
    }
    const body = (res.body ?? {}) as Record<string, unknown>;
    return {
      name: typeof body.name === 'string' ? body.name : name,
      status: (typeof body.status === 'string' ? body.status : 'UNKNOWN') as WahaSessionStatus,
      me: (body.me ?? null) as WahaSessionInfo['me'],
    };
  }

  async createSession(name: string): Promise<void> {
    const res = await this.request('/api/sessions', {
      method: 'POST',
      body: { name, start: true },
    });
    if (!res.ok && res.status !== 409 && res.status !== 422) {
      throw new Error(`WAHA createSession ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
    }
  }

  async deleteSession(name: string): Promise<void> {
    const res = await this.request(`/api/sessions/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
    // 404 = ya no existe, lo tratamos como éxito (idempotente).
    if (!res.ok && res.status !== 404) {
      throw new Error(`WAHA deleteSession ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
    }
  }

  async restartSession(name: string): Promise<void> {
    const res = await this.request(`/api/sessions/${encodeURIComponent(name)}/restart`, {
      method: 'POST',
    });
    if (!res.ok) {
      throw new Error(`WAHA restartSession ${res.status}: ${JSON.stringify(res.body).slice(0, 300)}`);
    }
  }

  /**
   * Pide el QR de la sesión. WAHA puede tardar un poco en generarlo, por eso
   * reintenta durante ~6 segundos antes de fallar.
   */
  async getQr(name: string, attempts = 12): Promise<WahaQr> {
    let lastError = 'QR no disponible';
    for (let i = 0; i < attempts; i += 1) {
      const res = await this.request(`/api/${encodeURIComponent(name)}/auth/qr`);
      if (res.ok) {
        const body = (res.body ?? {}) as Record<string, unknown>;
        const data = typeof body.data === 'string' ? body.data : '';
        if (data) {
          const mimetype = typeof body.mimetype === 'string' ? body.mimetype : 'image/png';
          return { mimetype, data, dataUrl: `data:${mimetype};base64,${data}` };
        }
      } else {
        lastError = `HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`;
      }
      await sleep(500);
    }
    throw new Error(`No se pudo obtener el QR de WAHA (${lastError})`);
  }

  /** Extrae el número de teléfono del campo `me.id` de WAHA. */
  phoneFromSession(info: WahaSessionInfo | null): string | null {
    const id = info?.me?.id;
    if (typeof id !== 'string') return null;
    return id.split('@')[0] ?? null;
  }
}

export type EnsureResult =
  | { action: 'reuse'; status: 'working'; phone: string | null; info: WahaSessionInfo }
  | { action: 'created'; status: 'scan_qr'; qr: WahaQr; info: WahaSessionInfo | null };

/**
 * Flujo principal de vinculación:
 *  1. Si la sesión existe y está WORKING → se reutiliza (login automático).
 *  2. Si existe pero NO está validada (SCAN_QR_CODE, FAILED, STOPPED...) →
 *     se ELIMINA y se crea una nueva desde cero.
 *  3. Si no existe → se crea.
 *  4. Se entrega un QR nuevo para validar la vinculación.
 */
export async function ensureWahaSession(
  waha: WahaAdminClient,
  sessionName: string,
): Promise<EnsureResult> {
  const existing = await waha.getSession(sessionName);

  if (existing?.status === 'WORKING') {
    return {
      action: 'reuse',
      status: 'working',
      phone: waha.phoneFromSession(existing),
      info: existing,
    };
  }

  if (existing) {
    await waha.deleteSession(sessionName);
  }

  await waha.createSession(sessionName);
  const qr = await waha.getQr(sessionName);
  return { action: 'created', status: 'scan_qr', qr, info: null };
}
