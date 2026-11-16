import { afterEach, describe, expect, it } from 'vitest';
import type { InboundJobRow } from '../src/db/types.js';
import type { WahaWebhookEvent } from '../src/domain/waha.js';
import {
  createTestContext,
  makeMessageEvent,
  type TestContext,
} from './helpers.js';

const ARTIST = '5491199999999@c.us';
const CLIENT = '5491111111111@c.us';
const OTHER_CLIENT = '5492222222222@c.us';

let ctx: TestContext;

function context(overrides: NodeJS.ProcessEnv = {}): TestContext {
  ctx = createTestContext({
    SUMMARY_ENABLED: 'false',
    TATTOO_ARTIST_CHAT_ID: ARTIST,
    ...overrides,
  });
  return ctx;
}

afterEach(() => {
  ctx.close();
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

async function send(
  app: TestContext,
  event: WahaWebhookEvent,
): Promise<void> {
  await app.conversations.processJob(queue(app, event));
}

describe('flujo de cotización con el tatuador', () => {
  it('reconoce al tatuador aunque WAHA lo entregue como @lid', async () => {
    const app = context({
      TATTOO_ARTIST_CHAT_ID: '573189458461@c.us',
    });
    const artistLid = '212648796905552@lid';
    const artistPhoneJid = '573189458461@s.whatsapp.net';

    await send(
      app,
      makeMessageEvent({
        from: CLIENT,
        body: '¿Cuánto sale un tatuaje de 10x10 cm en el antebrazo?',
      }),
    );

    expect(app.repos.quoteRequests.listPending(10)).toHaveLength(1);
    app.waha.sent.length = 0;

    await send(
      app,
      makeMessageEvent({
        from: artistLid,
        body: '$300.000',
        pushName: 'Julian',
        data: {
          key: {
            remoteJid: artistLid,
            remoteJidAlt: artistPhoneJid,
            fromMe: false,
            addressingMode: 'lid',
          },
        },
      }),
    );

    expect(app.ollama.calls).toHaveLength(0);

    const clientMessage = app.waha.sent.find(
      (item) => item.chatId === CLIENT,
    );
    expect(clientMessage?.text).toContain('Respuesta del tatuador');
    expect(clientMessage?.text).toContain('300.000');

    const artistConfirmation = app.waha.sent.find(
      (item) => item.chatId === '573189458461@c.us',
    );
    expect(artistConfirmation?.text).toContain('envié tu respuesta al cliente');

    const quote = app.repos.quoteRequests.getByCode('COT-000001');
    expect(quote?.status).toBe('delivered');
  });

  it('no reenvía al cliente un mensaje del tatuador sin precio', async () => {
    const app = context();
    const artistLid = '212648796905552@lid';
    const artistPhoneJid = '5491199999999@s.whatsapp.net';

    await send(
      app,
      makeMessageEvent({
        from: CLIENT,
        body: '¿Cuánto sale un tatuaje de 10x10 cm en el antebrazo?',
      }),
    );
    app.waha.sent.length = 0;

    await send(
      app,
      makeMessageEvent({
        from: artistLid,
        body: '2 de diciembre 4pm',
        data: {
          key: {
            remoteJid: artistLid,
            remoteJidAlt: artistPhoneJid,
            fromMe: false,
            addressingMode: 'lid',
          },
        },
      }),
    );

    expect(
      app.waha.sent.filter((item) => item.chatId === CLIENT),
    ).toHaveLength(0);
    expect(app.waha.sent[0]?.chatId).toBe(ARTIST);
    expect(app.waha.sent[0]?.text).toContain('no encontré un precio');
    expect(app.repos.quoteRequests.listPending(10)).toHaveLength(1);
  });

  it('deriva una consulta de precio al tatuador sin llamar a la IA', async () => {
    const app = context();

    await send(
      app,
      makeMessageEvent({
        from: CLIENT,
        body: '¿Cuánto sale un tatuaje de 10x10 cm en el antebrazo?',
      }),
    );

    expect(app.ollama.calls).toHaveLength(0);

    const pending = app.repos.quoteRequests.listPending(10);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.status).toBe('pending');
    expect(pending[0]?.code).toBe('COT-000001');

    const artistMessage = app.waha.sent.find(
      (item) => item.chatId === ARTIST,
    );
    expect(artistMessage?.text).toContain('Nueva consulta de cotización');
    expect(artistMessage?.text).toContain('COT-000001');
    expect(artistMessage?.text).toContain('10x10');

    const clientMessage = app.waha.sent.find(
      (item) => item.chatId === CLIENT,
    );
    expect(clientMessage?.text).toContain('tatuador');
    expect(clientMessage?.text).toContain('precio');

    const contact = app.repos.contacts.getByWaId(CLIENT);
    const conversation = app.repos.conversations.getByContactId(contact!.id);
    const messages = app.repos.messages.allByConversation(conversation!.id);
    expect(messages[1]?.kind).toBe('system');
    expect(messages[1]?.reply_to_message_id).toBe(messages[0]?.id);
  });

  it('reenvía al cliente la respuesta del tatuador y habilita el agendamiento', async () => {
    const app = context();

    await send(
      app,
      makeMessageEvent({
        from: CLIENT,
        body: 'Quiero cotizar un tatuaje de 10 cm en el brazo',
      }),
    );
    app.waha.sent.length = 0;

    await send(
      app,
      makeMessageEvent({
        from: ARTIST,
        body: 'COT-000001 $80.000, incluye una sesión de 2 horas',
      }),
    );

    expect(app.ollama.calls).toHaveLength(0);

    const clientMessage = app.waha.sent.find(
      (item) => item.chatId === CLIENT,
    );
    expect(clientMessage?.text).toContain('Respuesta del tatuador');
    expect(clientMessage?.text).toContain('80.000');
    expect(clientMessage?.text).toContain('día y horario');

    const artistConfirmation = app.waha.sent.find(
      (item) => item.chatId === ARTIST,
    );
    expect(artistConfirmation?.text).toContain('envié tu respuesta al cliente');

    const quote = app.repos.quoteRequests.getByCode('COT-000001');
    expect(quote?.status).toBe('delivered');
    expect(quote?.artist_reply).toContain('80.000');
    expect(quote?.client_outbound_message_id).toBeTruthy();
  });

  it('reenvía la imagen del cliente al tatuador', async () => {
    const app = context();
    const url = 'https://example.com/referencia.jpg';

    app.waha.mediaByUrl.set(url, {
      data: Buffer.from('imagen-de-prueba'),
      mimetype: 'image/jpeg',
      filename: 'referencia.jpg',
    });

    await send(
      app,
      makeMessageEvent({
        from: CLIENT,
        hasMedia: true,
        body: '',
        media: {
          url,
          mimetype: 'image/jpeg',
          filename: 'referencia.jpg',
        },
      }),
    );

    expect(app.ollama.calls).toHaveLength(0);
    expect(app.waha.sentMedia).toHaveLength(1);
    expect(app.waha.sentMedia[0]?.chatId).toBe(ARTIST);
    expect(app.waha.sentMedia[0]?.mimetype).toBe('image/jpeg');
    expect(app.waha.sentMedia[0]?.filename).toBe('referencia.jpg');
    expect(app.waha.sentMedia[0]?.caption).toContain('COT-000001');

    const clientMessage = app.waha.sent.find(
      (item) => item.chatId === CLIENT,
    );
    expect(clientMessage?.text).toContain('archivo');
    expect(app.repos.quoteRequests.listPending(10)).toHaveLength(1);
  });

  it('pide el código cuando hay varias consultas pendientes', async () => {
    const app = context();

    await send(
      app,
      makeMessageEvent({
        from: CLIENT,
        body: '¿Cuánto cuesta un tatuaje de 5 cm?',
      }),
    );
    await send(
      app,
      makeMessageEvent({
        from: OTHER_CLIENT,
        body: '¿Cuánto cuesta un retoque de 3 cm?',
      }),
    );

    expect(app.repos.quoteRequests.listPending(10)).toHaveLength(2);
    app.waha.sent.length = 0;

    await send(
      app,
      makeMessageEvent({
        from: ARTIST,
        body: 'Te sale 50.000',
      }),
    );

    expect(app.waha.sent).toHaveLength(1);
    expect(app.waha.sent[0]?.chatId).toBe(ARTIST);
    expect(app.waha.sent[0]?.text).toContain('COT-000001');
    expect(app.waha.sent[0]?.text).toContain('COT-000002');
    expect(app.waha.sent[0]?.text).toContain('incluyendo el código');

    expect(app.repos.quoteRequests.listPending(10)).toHaveLength(2);
  });

  it('reemplaza una respuesta de la IA que inventa un precio', async () => {
    const app = context();

    await send(
      app,
      makeMessageEvent({
        from: CLIENT,
        body: '¿Cuánto cuesta un tatuaje de 8 cm?',
      }),
    );
    app.waha.sent.length = 0;
    app.ollama.responses = ['Te sale $50.000, es un precio fijo.'];

    await send(
      app,
      makeMessageEvent({
        from: CLIENT,
        body: '¿Trabajan los sábados?',
      }),
    );

    expect(app.ollama.calls).toHaveLength(1);
    expect(app.waha.sent).toHaveLength(1);
    expect(app.waha.sent[0]?.text).toContain('en revisión con el tatuador');
    expect(app.waha.sent[0]?.text).not.toContain('50.000');
  });

  it('reemplaza una respuesta de la IA que pregunta por el significado', async () => {
    const app = context();
    app.ollama.responses = [
      '¿Qué significado tiene ese diseño para vos?',
    ];

    await send(
      app,
      makeMessageEvent({
        from: CLIENT,
        body: 'Hola, quiero hacerme un tatuaje',
      }),
    );

    expect(app.waha.sent).toHaveLength(1);
    expect(app.waha.sent[0]?.text).toContain(
      'Para cotizar no necesito el significado',
    );
  });

  it('inyecta la guía de respuestas y el estado de la cotización en el prompt', async () => {
    const app = context();

    await send(
      app,
      makeMessageEvent({
        from: CLIENT,
        body: 'Quiero cotizar un tatuaje de 12 cm en la espalda',
      }),
    );
    app.ollama.calls.length = 0;

    await send(
      app,
      makeMessageEvent({
        from: CLIENT,
        body: '¿Atienden los domingos?',
      }),
    );

    const system = app.ollama.calls[0]?.[0]?.content ?? '';
    expect(system).toContain('Guía interna de referencia');
    expect(system).toContain('[Regla de oro sobre los precios]');
    expect(system).toContain('COT-000001');
    expect(system).toContain('pendiente con el tatuador');
    expect(system).not.toContain('# Formato de respuestas');
  });
});
