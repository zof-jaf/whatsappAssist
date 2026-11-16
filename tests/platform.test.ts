import { describe, expect, it } from 'vitest';
import {
  generateApiKey,
  hashApiKey,
  hashPassword,
  verifyPassword,
  generateSessionToken,
  sessionNameFor,
} from '../src/platform/crypto.js';
import {
  ensureWahaSession,
  WahaAdminClient,
} from '../src/platform/waha-admin.js';
import type { PlatformConfig } from '../src/platform/config.js';

const config = {
  WAHA_BASE_URL: 'http://waha.test:3000',
  WAHA_ADMIN_API_KEY: 'admin-secret',
  WAHA_REQUEST_TIMEOUT_MS: 2000,
} as PlatformConfig;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('cripto de la plataforma', () => {
  it('hashea y verifica contraseñas, rechazando las incorrectas', async () => {
    const hash = await hashPassword('una-contrasena-segura');
    expect(hash).toMatch(/^scrypt\$/);
    expect(await verifyPassword('una-contrasena-segura', hash)).toBe(true);
    expect(await verifyPassword('otra-contrasena', hash)).toBe(false);
  });

  it('genera API keys con hash estable y preview enmascarado', () => {
    const { key, hash, preview } = generateApiKey('wbp');
    expect(key).toMatch(/^wbp_/);
    expect(hash).toBe(hashApiKey(key));
    expect(preview).toContain('…');
    expect(preview).not.toBe(key);
  });

  it('genera tokens opacos y nombres de sesión seguros', () => {
    expect(generateSessionToken()).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionNameFor('abc-123')).toBe('bot_abc-123');
  });
});

describe('flujo de sesión/QR de WAHA', () => {
  it('reutiliza una sesión WORKING sin borrarla ni crear una nueva', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/api/sessions/bot_1') && !url.includes('/auth/qr')) {
        return json({ name: 'bot_1', status: 'WORKING', me: { id: '549111111111@c.us' } });
      }
      throw new Error(`Llamada inesperada: ${url}`);
    };
    const waha = new WahaAdminClient(config, fetchImpl);
    const result = await ensureWahaSession(waha, 'bot_1');

    expect(result.action).toBe('reuse');
    expect(result.status).toBe('working');
    expect(result.action === 'reuse' && result.phone).toBe('549111111111');
    expect(calls.some((c) => c.includes('/auth/qr'))).toBe(false);
  });

  it('borra y recreatea una sesión no validada y entrega un QR nuevo', async () => {
    const calls: Array<{ method?: string; url: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ method, url });

      if (method === 'DELETE' && url.includes('/api/sessions/bot_2')) return json({ success: true });
      if (method === 'POST' && url.endsWith('/api/sessions')) return json({ name: 'bot_2', status: 'STARTING' });
      if (url.includes('/auth/qr')) {
        return json({ mimetype: 'image/png', data: 'QUJD' }); // "ABC" en base64
      }
      if (method === 'GET' && url.includes('/api/sessions/bot_2')) {
        return json({ name: 'bot_2', status: 'SCAN_QR_CODE' });
      }
      throw new Error(`Llamada inesperada: ${method} ${url}`);
    };
    const waha = new WahaAdminClient(config, fetchImpl);
    const result = await ensureWahaSession(waha, 'bot_2');

    expect(result.action).toBe('created');
    expect(result.action === 'created' && result.qr.dataUrl).toBe('data:image/png;base64,QUJD');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/sessions'))).toBe(true);

    // El borrado debe ocurrir ANTES de la creación.
    const deleteIndex = calls.findIndex((c) => c.method === 'DELETE');
    const createIndex = calls.findIndex((c) => c.method === 'POST');
    expect(deleteIndex).toBeLessThan(createIndex);
  });

  it('crea la sesión directamente cuando no existe (404)', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url}`);
      if (method === 'GET' && url.includes('/api/sessions/bot_3')) return json({ error: 'not found' }, 404);
      if (method === 'POST' && url.endsWith('/api/sessions')) return json({ name: 'bot_3', status: 'STARTING' });
      if (url.includes('/auth/qr')) return json({ mimetype: 'image/png', data: 'WFlY' });
      throw new Error(`Llamada inesperada: ${method} ${url}`);
    };
    const waha = new WahaAdminClient(config, fetchImpl);
    const result = await ensureWahaSession(waha, 'bot_3');

    expect(result.action).toBe('created');
    expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false);
  });
});
