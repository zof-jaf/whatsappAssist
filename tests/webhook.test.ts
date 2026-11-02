import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  createTestContext,
  makeAckEvent,
  makeMessageEvent,
  signedPost,
  signBody,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;

function context(overrides: NodeJS.ProcessEnv = {}): TestContext {
  ctx = createTestContext(overrides);
  return ctx;
}

afterEach(() => {
  ctx.close();
});

describe('webhook de WAHA', () => {
  it('acepta un evento firmado y lo encola', async () => {
    const app = context();
    const event = makeMessageEvent({ body: 'Hola bot' });

    const response = await signedPost(app.app, 'test-hmac-secret', event);

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('queued');
    expect(response.body.jobId).toBe(1);
    expect(app.repos.jobs.stats().pending).toBe(1);
    expect(app.repos.events.listRecent(1)[0]?.status).toBe('queued');
  });

  it('rechaza firmas ausentes o incorrectas', async () => {
    const app = context();
    const event = makeMessageEvent();

    const unsigned = await request(app.app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(event));
    expect(unsigned.status).toBe(401);
    expect(unsigned.body.error.code).toBe('INVALID_WEBHOOK_SIGNATURE');

    const wrong = await request(app.app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Hmac', 'deadbeef')
      .send(JSON.stringify(event));
    expect(wrong.status).toBe(401);

    const wrongAlgorithm = await request(app.app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Hmac', signBody(JSON.stringify(event), 'test-hmac-secret'))
      .set('X-Webhook-Hmac-Algorithm', 'sha256')
      .send(JSON.stringify(event));
    expect(wrongAlgorithm.status).toBe(401);

    expect(app.repos.jobs.stats().pending).toBe(0);
  });

  it('no exige HMAC fuera del webhook', async () => {
    const app = context();
    const response = await request(app.app).get('/health');
    expect(response.status).toBe(200);
  });

  it('deduplica entregas repetidas del mismo mensaje', async () => {
    const app = context();
    const event = makeMessageEvent({ id: 'wamid-repetido' });

    const first = await signedPost(app.app, 'test-hmac-secret', event);
    const second = await signedPost(app.app, 'test-hmac-secret', event);

    expect(first.body.status).toBe('queued');
    expect(second.body.status).toBe('duplicate');
    expect(app.repos.jobs.stats().pending).toBe(1);
  });

  it('ignora mensajes propios, grupos, difusiones y vacíos', async () => {
    const app = context();
    const secret = 'test-hmac-secret';

    const fromMe = await signedPost(
      app.app,
      secret,
      makeMessageEvent({ fromMe: true }),
    );
    expect(fromMe.body.reason).toBe('from_me');

    const group = await signedPost(
      app.app,
      secret,
      makeMessageEvent({ from: '120363000000000000@g.us' }),
    );
    expect(group.body.reason).toBe('grupo');

    const broadcast = await signedPost(
      app.app,
      secret,
      makeMessageEvent({ from: 'status@broadcast' }),
    );
    expect(broadcast.body.reason).toBe('broadcast');

    const empty = await signedPost(
      app.app,
      secret,
      makeMessageEvent({ body: '   ' }),
    );
    expect(empty.body.reason).toBe('mensaje_vacio');

    expect(app.repos.jobs.stats().pending).toBe(0);
  });

  it('acepta grupos cuando IGNORE_GROUPS=false', async () => {
    const app = context({ IGNORE_GROUPS: 'false' });
    const response = await signedPost(
      app.app,
      'test-hmac-secret',
      makeMessageEvent({ from: '120363000000000000@g.us' }),
    );

    expect(response.body.status).toBe('queued');
  });

  it('ignora eventos de otra sesión', async () => {
    const app = context();
    const response = await signedPost(
      app.app,
      'test-hmac-secret',
      makeMessageEvent({ session: 'otra-sesion' }),
    );

    expect(response.status).toBe(200);
    expect(response.body.reason).toBe('session');
    expect(app.repos.jobs.stats().pending).toBe(0);
  });

  it('filtra chats cuando ALLOWED_CHAT_IDS está configurado', async () => {
    const app = context({ ALLOWED_CHAT_IDS: '5491111111111@c.us' });

    const allowed = await signedPost(
      app.app,
      'test-hmac-secret',
      makeMessageEvent({ from: '5491111111111@c.us' }),
    );
    expect(allowed.body.status).toBe('queued');

    const blocked = await signedPost(
      app.app,
      'test-hmac-secret',
      makeMessageEvent({ from: '5499999999999@c.us' }),
    );
    expect(blocked.body.reason).toBe('chat_no_permitido');
    expect(app.repos.jobs.stats().pending).toBe(1);
  });

  it('responde 400 ante un cuerpo inválido', async () => {
    const app = context();
    const rawBody = JSON.stringify({ hola: 'mundo' });
    const response = await request(app.app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Hmac', signBody(rawBody, 'test-hmac-secret'))
      .send(rawBody);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_WEBHOOK_PAYLOAD');
  });

  it('responde 400 ante JSON malformado', async () => {
    const app = context();
    const rawBody = '{esto no es json';
    const response = await request(app.app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Hmac', signBody(rawBody, 'test-hmac-secret'))
      .send(rawBody);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_JSON');
  });

  it('guarda el estado de la sesión', async () => {
    const app = context();
    const rawBody = JSON.stringify({
      id: 'evt-status',
      event: 'session.status',
      session: 'default',
      timestamp: Date.now(),
      payload: { status: 'WORKING' },
      me: { id: 'me@c.us', pushName: 'Bot' },
    });

    const response = await request(app.app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Hmac', signBody(rawBody, 'test-hmac-secret'))
      .send(rawBody);

    expect(response.status).toBe(200);
    expect(app.repos.meta.getJson<{ status: string }>('waha.session')?.status).toBe(
      'WORKING',
    );
  });

  it('actualiza el estado de un mensaje saliente con los acks', async () => {
    const app = context();
    const contact = app.repos.contacts.upsert({ waId: '5491111111111@c.us' });
    const conversation = app.repos.conversations.getOrCreate(contact.id);
    const outbound = app.repos.messages.insertOutbound({
      conversationId: conversation.id,
      contactId: contact.id,
      body: 'respuesta',
      status: 'sent',
    });
    app.db
      .prepare('UPDATE messages SET wa_message_id = ? WHERE id = ?')
      .run('wamid-out-1', outbound.id);

    const response = await signedPost(
      app.app,
      'test-hmac-secret',
      makeAckEvent('wamid-out-1', 'READ', 3),
    );

    expect(response.body.status).toBe('processed');
    expect(app.repos.messages.getById(outbound.id)?.status).toBe('read');

    // Un ack sin mensaje asociado no rompe el webhook.
    const unknown = await signedPost(
      app.app,
      'test-hmac-secret',
      makeAckEvent('wamid-desconocido', 'DELIVERY', 2),
    );
    expect(unknown.status).toBe(200);
  });

  it('acepta eventos message.any', async () => {
    const app = context();
    const response = await signedPost(
      app.app,
      'test-hmac-secret',
      makeMessageEvent({ event: 'message.any' }),
    );

    expect(response.body.status).toBe('queued');
  });
});
