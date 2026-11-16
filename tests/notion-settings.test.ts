import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { NotionDatabase } from '../src/clients/notion.js';
import { createTestContext, type TestContext } from './helpers.js';

const AUTH = { Authorization: 'Bearer test-admin-token-1234567890' };
const DATABASE_ID = '11111111-1111-1111-1111-111111111111';

let ctx: TestContext;

beforeEach(() => {
  ctx = createTestContext({ SUMMARY_ENABLED: 'false' });
});

afterEach(() => {
  ctx.close();
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

describe('configuración de la agenda de Notion', () => {
  it('guarda token y base, y devuelve el esquema detectado', async () => {
    ctx.notionClient.databases = [database()];

    const saved = await request(ctx.app)
      .put('/api/admin/notion')
      .set(AUTH)
      .send({
        apiKey: 'secret_test_token',
        databaseId: `https://www.notion.so/agenda-${DATABASE_ID}`,
      });

    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      configured: true,
      ready: true,
      tokenSet: true,
      tokenSource: 'dashboard',
      databaseId: DATABASE_ID,
      databaseTitle: 'Agenda de tatuajes',
      dateProperty: 'Fecha',
      titleProperty: 'Nombre',
      statusProperty: 'Estado',
    });
    expect(saved.body.apiKey).toBeUndefined();
    expect(ctx.repos.meta.get('notion.api_key')).toBe('secret_test_token');

    const loaded = await request(ctx.app).get('/api/admin/notion').set(AUTH);
    expect(loaded.status).toBe(200);
    expect(loaded.body.tokenSet).toBe(true);
    expect(loaded.body.apiKey).toBeUndefined();
  });

  it('detecta una base compartida cuando solo se guarda el token', async () => {
    ctx.notionClient.databases = [database()];

    const saved = await request(ctx.app)
      .put('/api/admin/notion')
      .set(AUTH)
      .send({ apiKey: 'secret_test_token' });

    expect(saved.status).toBe(200);
    expect(saved.body.configured).toBe(true);
    expect(saved.body.databaseId).toBe(DATABASE_ID);
    expect(saved.body.ready).toBe(true);
  });

  it('explica que falta compartir una base si no hay ninguna', async () => {
    ctx.notionClient.databases = [];

    const saved = await request(ctx.app)
      .put('/api/admin/notion')
      .set(AUTH)
      .send({ apiKey: 'secret_test_token' });

    expect(saved.status).toBe(200);
    expect(saved.body.configured).toBe(false);
    expect(saved.body.warning).toContain('Compartí la base');
  });

  it('prueba la conexión y devuelve la propiedad de fecha', async () => {
    ctx.notionClient.databases = [database()];
    await request(ctx.app)
      .put('/api/admin/notion')
      .set(AUTH)
      .send({ apiKey: 'secret_test_token', databaseId: DATABASE_ID });

    const tested = await request(ctx.app)
      .post('/api/admin/notion/test')
      .set(AUTH);

    expect(tested.status).toBe(200);
    expect(tested.body.ok).toBe(true);
    expect(tested.body.schema).toMatchObject({
      databaseId: DATABASE_ID,
      dateProperty: 'Fecha',
    });
  });

  it('rechaza una base que la integración no puede ver', async () => {
    ctx.notionClient.databases = [];

    const response = await request(ctx.app)
      .put('/api/admin/notion')
      .set(AUTH)
      .send({
        apiKey: 'secret_test_token',
        databaseId: DATABASE_ID,
      });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain('No pude acceder');
  });

  it('lista las bases visibles para la integración', async () => {
    ctx.notionClient.databases = [database()];
    await request(ctx.app)
      .put('/api/admin/notion')
      .set(AUTH)
      .send({ apiKey: 'secret_test_token' });

    const discovered = await request(ctx.app)
      .post('/api/admin/notion/discover')
      .set(AUTH);

    expect(discovered.status).toBe(200);
    expect(discovered.body.databases).toEqual([
      {
        id: DATABASE_ID,
        title: 'Agenda de tatuajes',
        url: 'https://www.notion.so/agenda',
      },
    ]);
  });
});
