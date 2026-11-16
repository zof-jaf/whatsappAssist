import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { InboundJobRow } from '../src/db/types.js';
import type { WahaWebhookEvent } from '../src/domain/waha.js';
import {
  createTestContext,
  makeMessageEvent,
  type TestContext,
} from './helpers.js';

const AUTH = { Authorization: 'Bearer test-admin-token-1234567890' };
const ARTIST_FROM_PANEL = '573001234567@c.us';
const CLIENT = '5491111111111@c.us';

let ctx: TestContext | null = null;

afterEach(() => {
  ctx?.close();
  ctx = null;
});

function queue(app: TestContext, event: WahaWebhookEvent): InboundJobRow {
  const payload = event.payload as { id: string; from: string };
  const result = app.repos.jobs.enqueue({
    waMessageId: payload.id,
    chatId: payload.from,
    eventId: event.id,
    payload: JSON.stringify(event),
    maxAttempts: app.config.queue.maxAttempts,
  });
  return result.job;
}

describe('configuración del tatuador desde el panel', () => {
  it('acepta 10 dígitos locales en TATTOO_ARTIST_CHAT_ID', () => {
    ctx = createTestContext({
      SUMMARY_ENABLED: 'false',
      TATTOO_ARTIST_CHAT_ID: '3001234567',
    });

    expect(ctx.config.tattoo.artistChatId).toBe(ARTIST_FROM_PANEL);
    expect(ctx.tattoo.source).toBe('env');
    expect(ctx.tattoo.displayPhone).toBe('+57 300 123 4567');
  });

  it('guarda el número local y lo aplica sin reiniciar', async () => {
    ctx = createTestContext({ SUMMARY_ENABLED: 'false' });
    const app = ctx;

    const initial = await request(app.app).get('/api/admin/tattoo').set(AUTH);
    expect(initial.status).toBe(200);
    expect(initial.body.configured).toBe(false);
    expect(initial.body.source).toBe('none');

    const saved = await request(app.app)
      .put('/api/admin/tattoo')
      .set(AUTH)
      .send({ phone: '300 123 4567' });

    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      configured: true,
      phone: '3001234567',
      displayPhone: '+57 300 123 4567',
      chatId: ARTIST_FROM_PANEL,
      source: 'dashboard',
      countryCode: '57',
    });
    expect(app.config.tattoo.artistChatId).toBe(ARTIST_FROM_PANEL);
    expect(app.repos.meta.get('tattoo.artist_phone')).toBe('3001234567');

    const overview = await request(app.app)
      .get('/api/admin/overview')
      .set(AUTH);
    expect(overview.body.settings.tattooArtist).toBe('+57 300 123 4567');
    expect(overview.body.settings.tattooArtistSource).toBe('dashboard');
  });

  it('rechaza números que no tienen 10 dígitos colombianos', async () => {
    ctx = createTestContext({ SUMMARY_ENABLED: 'false' });

    const response = await request(ctx.app)
      .put('/api/admin/tattoo')
      .set(AUTH)
      .send({ phone: '30012345' });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain('10 dígitos');
    expect(ctx.config.tattoo.artistChatId).toBeNull();
  });

  it('vuelve al número de .env al quitar el valor del panel', async () => {
    ctx = createTestContext({
      SUMMARY_ENABLED: 'false',
      TATTOO_ARTIST_CHAT_ID: '573009998877@c.us',
    });

    await request(ctx.app)
      .put('/api/admin/tattoo')
      .set(AUTH)
      .send({ phone: '3001234567' });
    expect(ctx.config.tattoo.artistChatId).toBe(ARTIST_FROM_PANEL);

    const cleared = await request(ctx.app)
      .put('/api/admin/tattoo')
      .set(AUTH)
      .send({ phone: '' });

    expect(cleared.status).toBe(200);
    expect(cleared.body.configured).toBe(true);
    expect(cleared.body.source).toBe('env');
    expect(cleared.body.chatId).toBe('573009998877@c.us');
    expect(ctx.config.tattoo.artistChatId).toBe('573009998877@c.us');
    expect(ctx.repos.meta.get('tattoo.artist_phone')).toBeUndefined();
  });

  it('deriva una consulta de precio al número guardado desde el panel', async () => {
    ctx = createTestContext({ SUMMARY_ENABLED: 'false' });

    await request(ctx.app)
      .put('/api/admin/tattoo')
      .set(AUTH)
      .send({ phone: '3001234567' });

    const event = makeMessageEvent({
      from: CLIENT,
      body: '¿Cuánto cuesta un tatuaje de 10 cm en el brazo?',
    });
    await ctx.conversations.processJob(queue(ctx, event));

    expect(ctx.ollama.calls).toHaveLength(0);
    const artistMessage = ctx.waha.sent.find(
      (item) => item.chatId === ARTIST_FROM_PANEL,
    );
    expect(artistMessage?.text).toContain('Nueva consulta de cotización');
    expect(artistMessage?.text).toContain('COT-000001');

    const quote = ctx.repos.quoteRequests.getByCode('COT-000001');
    expect(quote?.status).toBe('pending');
  });
});
