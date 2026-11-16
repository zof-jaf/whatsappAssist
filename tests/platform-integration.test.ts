import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { decryptSecret, encryptSecret } from '../src/platform/crypto.js';
import { createIngestClient } from '../src/platform/ingest-client.js';
import { createPlatformWebhookRouter } from '../src/platform/routes/webhook.js';
import type { PlatformConfig } from '../src/platform/config.js';
import type { PlatformDeps } from '../src/platform/context.js';
import type { BotEngineHost } from '../src/platform/worker-host.js';

const SECRET = 'clave-de-prueba-suficientemente-larga';

function makeConfig(): PlatformConfig {
  return {
    PLATFORM_WEBHOOK_HMAC_KEY: SECRET,
    LEGACY_SESSION_NAME: 'default',
    LEGACY_WEBHOOK_URL: undefined,
    WAHA_REQUEST_TIMEOUT_MS: 2000,
    PLATFORM_BASE_URL: 'http://platform.test:4000',
  } as PlatformConfig;
}

function sign(body: string): string {
  return createHmac('sha512', SECRET).update(body).digest('hex');
}

function messageEvent(session: string) {
  return {
    id: `evt-${session}`,
    event: 'message',
    session,
    payload: {
      id: `msg-${session}`,
      timestamp: 1700000000,
      from: '111@c.us',
      to: '222@c.us',
      body: 'hola',
      hasMedia: false,
      fromMe: false,
    },
  };
}

function fakeDeps(): PlatformDeps {
  return {
    config: makeConfig(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as PlatformDeps;
}

function fakeHost(calls: string[], result?: { status: number; body: unknown }): BotEngineHost {
  return {
    async handleWebhook(session, body) {
      calls.push(session);
      return result ?? {
        status: 200,
        body: { ok: true, status: 'queued', received: (body as { id: string }).id },
      };
    },
    async sync() {
      return { running: 0, started: 0, stopped: 0 };
    },
    async stop() {},
    snapshot() {
      return [];
    },
  };
}

async function listen(router: express.Router): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buffer) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buffer;
      },
    }),
  );
  app.use(router);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('sin dirección');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('integración de la plataforma', () => {
  it('cifra y descifra la API key del bot; otra clave no puede leerla', () => {
    const cipher = encryptSecret('wbp_secreto_super_secreto', SECRET);
    expect(cipher).toMatch(/^v1\./);
    expect(decryptSecret(cipher, SECRET)).toBe('wbp_secreto_super_secreto');
    expect(decryptSecret(cipher, 'otra-clave-tambien-larga')).toBeNull();
  });

  it('envía eventos al ingesta con la API key del bot', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const client = createIngestClient(makeConfig());

    const ok = await client.postEvent('wbp_key_del_bot', {
      type: 'message_in',
      chatId: '111@c.us',
      messageId: 'msg-1',
      chars: 4,
      session: 'bot_a',
    });

    expect(ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://platform.test:4000/api/ingest/events');
    expect((init.headers as Record<string, string>)['X-Api-Key']).toBe('wbp_key_del_bot');
    expect(JSON.parse(String(init.body))).toMatchObject({ type: 'message_in', session: 'bot_a' });
  });

  it('un fallo del ingesta nunca lanza hacia el motor', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('caído')));
    const client = createIngestClient(makeConfig());
    await expect(client.postEvent('wbp_key', { type: 'message_out' })).resolves.toBe(false);
  });

  it('enruta cada webhook al motor de su sesión (aislamiento entre bots)', async () => {
    const callsA: string[] = [];
    const callsB: string[] = [];
    const deps = fakeDeps();
    const router = createPlatformWebhookRouter(deps, {
      ...fakeHost(callsA),
      async handleWebhook(session, body) {
        if (session !== 'bot_a') return { status: 404, body: { error: { code: 'UNKNOWN_SESSION' } } };
        callsA.push((body as { id: string }).id);
        return { status: 200, body: { ok: true, status: 'queued' } };
      },
    } as BotEngineHost);
    // Un segundo router simulando el motor B para comprobar que no recibe A.
    const routerB = createPlatformWebhookRouter(deps, {
      ...fakeHost(callsB),
      async handleWebhook(session, body) {
        if (session !== 'bot_b') return { status: 404, body: { error: { code: 'UNKNOWN_SESSION' } } };
        callsB.push((body as { id: string }).id);
        return { status: 200, body: { ok: true, status: 'queued' } };
      },
    } as BotEngineHost);

    const serverA = await listen(router);
    const serverB = await listen(routerB);
    try {
      for (const [server, session] of [[serverA, 'bot_a'], [serverB, 'bot_b']] as const) {
        const body = JSON.stringify(messageEvent(session));
        const response = await request(server.url)
          .post('/webhook')
          .set('Content-Type', 'application/json')
          .set('x-webhook-hmac', sign(body))
          .send(body);
        expect(response.status).toBe(200);
      }
    } finally {
      await serverA.close();
      await serverB.close();
    }

    expect(callsA).toEqual(['evt-bot_a']);
    expect(callsB).toEqual(['evt-bot_b']);
  });

  it('rechaza webhooks sin firma HMAC válida', async () => {
    const calls: string[] = [];
    const server = await listen(createPlatformWebhookRouter(fakeDeps(), fakeHost(calls)));
    try {
      const response = await request(server.url)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('x-webhook-hmac', 'deadbeef')
        .send(JSON.stringify(messageEvent('bot_a')));
      expect(response.status).toBe(401);
      expect(calls).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
});
