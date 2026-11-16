import { afterEach, describe, expect, it } from 'vitest';
import type { InboundJobRow } from '../src/db/types.js';
import type { WahaWebhookEvent } from '../src/domain/waha.js';
import type { NotionDatabase } from '../src/clients/notion.js';
import {
  createTestContext,
  makeMessageEvent,
  type TestContext,
} from './helpers.js';

const ARTIST = '573001234567@c.us';
const CLIENT = '5491111111111@c.us';
const DATABASE_ID = '11111111-1111-1111-1111-111111111111';

let ctx: TestContext | null = null;

afterEach(() => {
  ctx?.close();
  ctx = null;
});

function database(): NotionDatabase {
  return {
    id: DATABASE_ID,
    title: 'Agenda de tatuajes',
    url: 'https://www.notion.so/agenda',
    properties: {
      Nombre: { name: 'Nombre', type: 'title' },
      Fecha: { name: 'Fecha', type: 'date' },
      Cliente: { name: 'Cliente', type: 'rich_text' },
      Teléfono: { name: 'Teléfono', type: 'rich_text' },
      Código: { name: 'Código', type: 'rich_text' },
      Precio: { name: 'Precio', type: 'number' },
      Estado: {
        name: 'Estado',
        type: 'status',
        status: { options: [{ name: 'Confirmada' }] },
      },
    },
  };
}

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

async function send(app: TestContext, event: WahaWebhookEvent): Promise<void> {
  await app.conversations.processJob(queue(app, event));
}

function notionContext(): TestContext {
  ctx = createTestContext({
    SUMMARY_ENABLED: 'false',
    TATTOO_ARTIST_CHAT_ID: ARTIST,
    NOTION_API_KEY: 'secret_test_token',
    NOTION_DATABASE_ID: DATABASE_ID,
  });
  ctx.notionClient.databases = [database()];
  return ctx;
}

async function deliverQuote(app: TestContext): Promise<void> {
  await send(
    app,
    makeMessageEvent({
      from: CLIENT,
      body: 'Quiero cotizar un tatuaje de 10 cm en el brazo',
    }),
  );
  await send(
    app,
    makeMessageEvent({
      from: ARTIST,
      body: 'COT-000001 $300.000',
    }),
  );
  app.waha.sent.length = 0;
}

describe('agenda de citas en Notion', () => {
  it('crea la cita cuando el cliente elige día y hora', async () => {
    const app = notionContext();
    await deliverQuote(app);

    await send(
      app,
      makeMessageEvent({
        from: CLIENT,
        body: '2 de diciembre 4pm',
      }),
    );

    expect(app.ollama.calls).toHaveLength(0);
    expect(app.notionClient.pages).toHaveLength(1);

    const page = app.notionClient.pages[0];
    expect(page?.databaseId).toBe(DATABASE_ID);
    expect(page?.properties).toMatchObject({
      Nombre: {
        title: [{ text: { content: expect.stringContaining('Tatuaje') } }],
      },
      Fecha: { date: { start: expect.stringMatching(/T21:00:00\.000Z$/) } },
      Cliente: { rich_text: [{ text: { content: 'Contacto de Prueba' } }] },
      Código: { rich_text: [{ text: { content: 'COT-000001' } }] },
      Precio: { number: 300000 },
      Estado: { status: { name: 'Confirmada' } },
    });

    const quote = app.repos.quoteRequests.getByCode('COT-000001');
    expect(quote?.appointment_at).toMatch(/T21:00:00\.000Z$/);
    expect(quote?.notion_page_id).toBe('notion-page-1');

    const clientMessage = app.waha.sent.find(
      (item) => item.chatId === CLIENT,
    );
    expect(clientMessage?.text).toContain('dejé agendada la cita');
    expect(clientMessage?.text).toContain('COT-000001');

    const artistMessage = app.waha.sent.find(
      (item) => item.chatId === ARTIST,
    );
    expect(artistMessage?.text).toContain('Cita agendada');
    expect(artistMessage?.text).toContain('notion.so');
  });

  it('pregunta la hora cuando el cliente solo da el día', async () => {
    const app = notionContext();
    await deliverQuote(app);

    await send(
      app,
      makeMessageEvent({
        from: CLIENT,
        body: '2 de diciembre',
      }),
    );

    expect(app.notionClient.pages).toHaveLength(0);
    expect(app.ollama.calls).toHaveLength(0);
    expect(app.waha.sent[0]?.text).toContain('¿A qué hora');
    expect(
      app.repos.quoteRequests.getByCode('COT-000001')?.appointment_at,
    ).toBeNull();
  });

  it('combina el día y la hora si llegan en mensajes distintos', async () => {
    const app = notionContext();
    await deliverQuote(app);

    await send(
      app,
      makeMessageEvent({
        from: CLIENT,
        body: '2 de diciembre',
      }),
    );
    expect(app.notionClient.pages).toHaveLength(0);

    await send(
      app,
      makeMessageEvent({
        from: CLIENT,
        body: '4pm',
      }),
    );

    expect(app.ollama.calls).toHaveLength(0);
    expect(app.notionClient.pages).toHaveLength(1);
    expect(
      app.repos.quoteRequests.getByCode('COT-000001')?.appointment_at,
    ).toMatch(/T21:00:00\.000Z$/);
  });

  it('combina la hora y el día si llegan en orden inverso', async () => {
    const app = notionContext();
    await deliverQuote(app);

    await send(
      app,
      makeMessageEvent({
        from: CLIENT,
        body: 'a las 4pm',
      }),
    );
    expect(app.notionClient.pages).toHaveLength(0);

    await send(
      app,
      makeMessageEvent({
        from: CLIENT,
        body: 'el sábado',
      }),
    );

    expect(app.ollama.calls).toHaveLength(0);
    expect(app.notionClient.pages).toHaveLength(1);
    expect(
      app.repos.quoteRequests.getByCode('COT-000001')?.appointment_at,
    ).toBeTruthy();
  });

  it('pide intervención al tatuador si Notion falla', async () => {
    const app = notionContext();
    await deliverQuote(app);
    app.notionClient.failCreate = new Error('La integración no puede editar');

    await send(
      app,
      makeMessageEvent({
        from: CLIENT,
        body: '2 de diciembre 4pm',
      }),
    );

    expect(app.notionClient.pages).toHaveLength(0);
    expect(app.ollama.calls).toHaveLength(0);
    expect(
      app.repos.quoteRequests.getByCode('COT-000001')?.appointment_at,
    ).toBeNull();

    const clientMessage = app.waha.sent.find(
      (item) => item.chatId === CLIENT,
    );
    expect(clientMessage?.text).toContain('confirmando la disponibilidad');

    const artistMessage = app.waha.sent.find(
      (item) => item.chatId === ARTIST,
    );
    expect(artistMessage?.text).toContain('no pude crear el evento en Notion');
    expect(artistMessage?.text).toContain('La integración no puede editar');
  });

  it('avisa al tatuador cuando el cliente elige horario sin Notion', async () => {
    ctx = createTestContext({
      SUMMARY_ENABLED: 'false',
      TATTOO_ARTIST_CHAT_ID: ARTIST,
    });
    const app = ctx;
    await deliverQuote(app);

    await send(
      app,
      makeMessageEvent({
        from: CLIENT,
        body: '2 de diciembre 4pm',
      }),
    );

    expect(app.ollama.calls).toHaveLength(0);
    expect(
      app.repos.quoteRequests.getByCode('COT-000001')?.appointment_at,
    ).toBeNull();

    const clientMessage = app.waha.sent.find(
      (item) => item.chatId === CLIENT,
    );
    expect(clientMessage?.text).toContain('confirmando la disponibilidad');

    const artistMessage = app.waha.sent.find(
      (item) => item.chatId === ARTIST,
    );
    expect(artistMessage?.text).toContain('La agenda de Notion no está configurada');
  });

  it('no confirma una cita que la IA inventó', async () => {
    const app = notionContext();
    await deliverQuote(app);
    app.ollama.responses = [
      'Listo, la cita quedó agendada para el viernes a las 3.',
    ];

    await send(
      app,
      makeMessageEvent({
        from: CLIENT,
        body: '¿Trabajan los viernes?',
      }),
    );

    const clientMessage = app.waha.sent.find(
      (item) => item.chatId === CLIENT,
    );
    expect(clientMessage?.text).toContain('Todavía no puedo confirmar la cita');
    expect(clientMessage?.text).not.toContain('quedó agendada');
  });

  it('no confirma una cita inventada sin cotización previa', async () => {
    ctx = createTestContext({
      SUMMARY_ENABLED: 'false',
      TATTOO_ARTIST_CHAT_ID: ARTIST,
    });
    const app = ctx;
    app.ollama.responses = [
      'Listo, tu cita quedó agendada para el viernes a las 3.',
    ];

    await send(
      app,
      makeMessageEvent({
        from: CLIENT,
        body: 'Hola, ¿trabajan los viernes?',
      }),
    );

    const clientMessage = app.waha.sent.find(
      (item) => item.chatId === CLIENT,
    );
    expect(clientMessage?.text).toContain('Todavía no puedo confirmar la cita');
    expect(clientMessage?.text).not.toContain('quedó agendada');
  });
});
