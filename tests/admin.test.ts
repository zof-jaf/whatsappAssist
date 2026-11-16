import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { WahaError } from '../src/errors.js';
import {
  createTestContext,
  makeMessageEvent,
  signedPost,
  type TestContext,
} from './helpers.js';

const AUTH = { Authorization: 'Bearer test-admin-token-1234567890' };

let ctx: TestContext;

beforeEach(() => {
  ctx = createTestContext({ SUMMARY_ENABLED: 'false' });
});

afterEach(() => {
  ctx.close();
});

function seed(app: TestContext, chatId = '5491111111111@c.us') {
  const contact = app.repos.contacts.upsert({
    waId: chatId,
    phone: chatId.replace('@c.us', ''),
    pushName: 'Ana',
  });
  const conversation = app.repos.conversations.getOrCreate(contact.id);
  const inbound = app.repos.messages.insertInbound({
    conversationId: conversation.id,
    contactId: contact.id,
    waMessageId: `wamid-${chatId}`,
    body: 'Hola, necesito ayuda',
    kind: 'text',
  });
  const outbound = app.repos.messages.insertOutbound({
    conversationId: conversation.id,
    contactId: contact.id,
    body: 'Claro, decime qué necesitás.',
    status: 'sent',
    replyToMessageId: inbound.message.id,
    model: 'test-model:1b',
  });
  return { contact, conversation, inbound: inbound.message, outbound };
}

describe('API de administración', () => {
  it('exige el token Bearer', async () => {
    const missing = await request(ctx.app).get('/api/admin/overview');
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe('UNAUTHORIZED');

    const wrong = await request(ctx.app)
      .get('/api/admin/overview')
      .set('Authorization', 'Bearer token-incorrecto-123456');
    expect(wrong.status).toBe(401);

    const ok = await request(ctx.app).get('/api/admin/overview').set(AUTH);
    expect(ok.status).toBe(200);
  });

  it('devuelve 404 si el panel está desactivado', async () => {
    ctx.close();
    ctx = createTestContext({ ADMIN_ENABLED: 'false' });

    const response = await request(ctx.app)
      .get('/api/admin/overview')
      .set(AUTH);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('ADMIN_DISABLED');
  });

  it('expone un resumen general del sistema', async () => {
    seed(ctx);

    const response = await request(ctx.app)
      .get('/api/admin/overview')
      .set(AUTH);

    expect(response.status).toBe(200);
    expect(response.body.version).toBe('1.0.0');
    expect(response.body.bot.name).toBe('Asistente');
    expect(response.body.bot.model).toBe('test-model:1b');
    expect(response.body.stats.contacts).toBe(1);
    expect(response.body.stats.messages).toBe(2);
    expect(response.body.health.db.ok).toBe(true);
    expect(response.body.health.waha.ok).toBe(true);
    expect(response.body.health.ollama.hasModel).toBe(true);
    expect(response.body.worker).toBeNull();
    expect(response.body.dashboardUrl).toContain('/dashboard');
  });

  it('marca la instancia como no lista si la sesión de WAHA no está conectada', async () => {
    ctx.waha.sessionStatus = 'SCAN_QR_CODE';
    const notReady = await request(ctx.app).get('/ready');
    expect(notReady.status).toBe(503);
    expect(notReady.body.status).toBe('not_ready');
    expect(notReady.body.waha.status).toBe('SCAN_QR_CODE');

    ctx.waha.sessionStatus = 'WORKING';
    const ready = await request(ctx.app).get('/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe('ready');
  });

  it('expone el estado y el QR de la sesión de WhatsApp', async () => {
    const working = await request(ctx.app)
      .get('/api/admin/whatsapp/status')
      .set(AUTH);
    expect(working.status).toBe(200);
    expect(working.body).toMatchObject({
      ok: true,
      exists: true,
      status: 'WORKING',
      qrAvailable: false,
    });
    expect(working.body.dashboardUrl).toContain('/dashboard');

    ctx.waha.sessionStatus = 'SCAN_QR_CODE';
    const scan = await request(ctx.app)
      .get('/api/admin/whatsapp/status')
      .set(AUTH);
    expect(scan.body.status).toBe('SCAN_QR_CODE');
    expect(scan.body.qrAvailable).toBe(true);

    const qr = await request(ctx.app)
      .get('/api/admin/whatsapp/qr')
      .set(AUTH);
    expect(qr.status).toBe(200);
    expect(qr.body.status).toBe('SCAN_QR_CODE');
    expect(qr.body.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(qr.body.dataUrl).toContain(ctx.waha.qrData);
    expect(ctx.waha.qrFetches).toBe(1);
  });

  it('no devuelve QR si la sesión no está esperando escaneo', async () => {
    const response = await request(ctx.app)
      .get('/api/admin/whatsapp/qr')
      .set(AUTH);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('QR_NOT_AVAILABLE');
    expect(ctx.waha.qrFetches).toBe(0);
  });

  it('informa cuando la sesión de WAHA todavía no existe', async () => {
    ctx.waha.sessionExists = false;
    const response = await request(ctx.app)
      .get('/api/admin/whatsapp/status')
      .set(AUTH);
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.exists).toBe(false);
    expect(response.body.status).toBeNull();
    expect(response.body.qrAvailable).toBe(false);
  });

  it('informa cuando WAHA no responde', async () => {
    ctx.waha.failSession = new WahaError('WAHA caído', 502);
    const response = await request(ctx.app)
      .get('/api/admin/whatsapp/status')
      .set(AUTH);
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(false);
    expect(response.body.error).toContain('WAHA caído');
  });

  it('crea la sesión de WhatsApp si no existe', async () => {
    ctx.waha.sessionExists = false;
    const response = await request(ctx.app)
      .post('/api/admin/whatsapp/connect')
      .set(AUTH);
    expect(response.status).toBe(200);
    expect(response.body.action).toBe('created');
    expect(response.body.exists).toBe(true);
    expect(ctx.waha.createdSessions).toBe(1);
    expect(ctx.waha.startedSessions).toBe(0);
    expect(ctx.waha.restartedSessions).toBe(0);
  });

  it('reinicia una sesión fallida al conectar', async () => {
    ctx.waha.sessionStatus = 'FAILED';
    const response = await request(ctx.app)
      .post('/api/admin/whatsapp/connect')
      .set(AUTH);
    expect(response.status).toBe(200);
    expect(response.body.action).toBe('restarted');
    expect(response.body.status).toBe('STARTING');
    expect(ctx.waha.restartedSessions).toBe(1);
  });

  it('no reinicia una sesión que ya está esperando el QR', async () => {
    ctx.waha.sessionStatus = 'SCAN_QR_CODE';
    const response = await request(ctx.app)
      .post('/api/admin/whatsapp/connect')
      .set(AUTH);
    expect(response.status).toBe(200);
    expect(response.body.action).toBe('none');
    expect(response.body.status).toBe('SCAN_QR_CODE');
    expect(ctx.waha.restartedSessions).toBe(0);
  });

  it('permite reiniciar la sesión manualmente', async () => {
    ctx.waha.sessionStatus = 'FAILED';
    const response = await request(ctx.app)
      .post('/api/admin/whatsapp/restart')
      .set(AUTH);
    expect(response.status).toBe(200);
    expect(response.body.action).toBe('restarted');
    expect(ctx.waha.restartedSessions).toBe(1);
  });

  it('lista, busca y pagina conversaciones', async () => {
    seed(ctx);
    seed(ctx, '5492222222222@c.us');

    const all = await request(ctx.app)
      .get('/api/admin/conversations')
      .set(AUTH);
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(2);
    expect(all.body.items).toHaveLength(2);
    expect(all.body.items[0].contact.displayName).toBe('Ana');
    expect(all.body.items[0].messageCount).toBe(2);
    expect(all.body.items[0].lastMessage.direction).toBe('out');

    const search = await request(ctx.app)
      .get('/api/admin/conversations?search=5492222')
      .set(AUTH);
    expect(search.body.total).toBe(1);
    expect(search.body.items[0].contact.waId).toBe('5492222222222@c.us');

    const page = await request(ctx.app)
      .get('/api/admin/conversations?limit=1&offset=1')
      .set(AUTH);
    expect(page.body.items).toHaveLength(1);
    expect(page.body.total).toBe(2);
  });

  it('devuelve el detalle y todo el historial', async () => {
    const { conversation, inbound, outbound } = seed(ctx);

    const response = await request(ctx.app)
      .get(`/api/admin/conversations/${conversation.id}`)
      .set(AUTH);

    expect(response.status).toBe(200);
    expect(response.body.conversation.id).toBe(conversation.id);
    expect(response.body.contact.pushName).toBe('Ana');
    expect(response.body.messages).toHaveLength(2);
    expect(response.body.messages[0].id).toBe(inbound.id);
    expect(response.body.messages[1].id).toBe(outbound.id);
    expect(response.body.messages[1].model).toBe('test-model:1b');
    expect(response.body.context.messageCount).toBe(2);
    expect(response.body.hasMore).toBe(false);
  });

  it('devuelve 404 para una conversación inexistente', async () => {
    const response = await request(ctx.app)
      .get('/api/admin/conversations/999')
      .set(AUTH);
    expect(response.status).toBe(404);
  });

  it('activa y desactiva la IA de una conversación', async () => {
    const { conversation } = seed(ctx);

    const response = await request(ctx.app)
      .patch(`/api/admin/conversations/${conversation.id}`)
      .set(AUTH)
      .send({ aiEnabled: false });
    expect(response.status).toBe(200);
    expect(response.body.conversation.aiEnabled).toBe(false);

    const updated = ctx.repos.conversations.getById(conversation.id);
    expect(updated?.ai_enabled).toBe(0);
  });

  it('reinicia el contexto desde el panel', async () => {
    const { conversation } = seed(ctx);

    const response = await request(ctx.app)
      .post(`/api/admin/conversations/${conversation.id}/reset`)
      .set(AUTH);
    expect(response.status).toBe(200);
    expect(response.body.contextStartMessageId).toBe(2);
    expect(
      ctx.repos.conversations.getById(conversation.id)
        ?.context_start_message_id,
    ).toBe(2);
  });

  it('envía un mensaje manual por WhatsApp', async () => {
    const { conversation, contact } = seed(ctx);

    const response = await request(ctx.app)
      .post(`/api/admin/conversations/${conversation.id}/messages`)
      .set(AUTH)
      .send({ text: 'Mensaje escrito desde el panel' });

    expect(response.status).toBe(201);
    expect(response.body.message.status).toBe('sent');
    expect(response.body.message.model).toBe('manual');
    expect(ctx.waha.sent[0]?.chatId).toBe(contact.wa_id);
    expect(ctx.waha.sent[0]?.text).toBe('Mensaje escrito desde el panel');
  });

  it('rechaza mensajes manuales vacíos', async () => {
    const { conversation } = seed(ctx);

    const response = await request(ctx.app)
      .post(`/api/admin/conversations/${conversation.id}/messages`)
      .set(AUTH)
      .send({ text: '   ' });
    expect(response.status).toBe(400);
  });

  it('reintenta un mensaje saliente fallido', async () => {
    const { conversation, contact } = seed(ctx);
    const failed = ctx.repos.messages.insertOutbound({
      conversationId: conversation.id,
      contactId: contact.id,
      body: 'Mensaje que había fallado',
      status: 'failed',
    });

    const response = await request(ctx.app)
      .post(`/api/admin/messages/${failed.id}/retry`)
      .set(AUTH);

    expect(response.status).toBe(200);
    expect(response.body.message.status).toBe('sent');
    expect(ctx.waha.sent[0]?.text).toBe('Mensaje que había fallado');
  });

  it('exporta el historial completo en JSON', async () => {
    const { conversation, inbound, outbound } = seed(ctx);

    const response = await request(ctx.app)
      .get(`/api/admin/conversations/${conversation.id}/export`)
      .set(AUTH);

    expect(response.status).toBe(200);
    expect(response.headers['content-disposition']).toContain('attachment');
    expect(response.body.messages).toHaveLength(2);
    expect(response.body.messages[0].id).toBe(inbound.id);
    expect(response.body.messages[1].id).toBe(outbound.id);
    expect(response.body.exportedAt).toBeTruthy();
  });

  it('lista eventos recientes del webhook', async () => {
    await signedPost(
      ctx.app,
      'test-hmac-secret',
      makeMessageEvent({ body: 'Evento de prueba' }),
    );

    const response = await request(ctx.app)
      .get('/api/admin/events')
      .set(AUTH);

    expect(response.status).toBe(200);
    expect(response.body.items.length).toBeGreaterThan(0);
    expect(response.body.items[0].event).toBe('message');
    expect(response.body.items[0].payloadPreview).toBeTruthy();
  });

  it('lista trabajos fallidos y permite reintentarlos', async () => {
    ctx.repos.jobs.enqueue({
      waMessageId: 'wamid-job',
      chatId: '5491111111111@c.us',
      payload: '{}',
      maxAttempts: 3,
    });
    const job = ctx.repos.jobs.claimNext();
    ctx.repos.jobs.markFailure(job!.id, {
      error: 'fallo simulado',
      retryAt: new Date().toISOString(),
      final: true,
    });

    const list = await request(ctx.app).get('/api/admin/jobs').set(AUTH);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].lastError).toBe('fallo simulado');

    const retry = await request(ctx.app)
      .post(`/api/admin/jobs/${job!.id}/retry`)
      .set(AUTH);
    expect(retry.status).toBe(200);
    expect(ctx.repos.jobs.getById(job!.id)?.status).toBe('pending');
  });

  it('sirve el panel web sin exigir token para los archivos estáticos', async () => {
    const page = await request(ctx.app).get('/admin/');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.text).toContain('WhatsApp AI Bot');
    expect(page.text).toContain('/admin/app.js');
    expect(page.text).toContain('Conectar WhatsApp');
    expect(page.text).toContain('whatsapp-qr');

    const script = await request(ctx.app).get('/admin/app.js');
    expect(script.status).toBe(200);
    expect(script.headers['content-type']).toContain('javascript');
    expect(script.text).toContain('shouldAutoConnectWhatsApp');
    expect(script.text).toContain('WHATSAPP_REFRESH_MS');

    const styles = await request(ctx.app).get('/admin/styles.css');
    expect(styles.status).toBe(200);
    expect(styles.headers['content-type']).toContain('text/css');
  });

  it('expone el estado del sistema y la configuración efectiva', async () => {
    const response = await request(ctx.app)
      .get('/api/admin/system')
      .set(AUTH);

    expect(response.status).toBe(200);
    expect(response.body.health.db.ok).toBe(true);
    expect(response.body.settings.model).toBe('test-model:1b');
    expect(response.body.settings.webhookHmacEnabled).toBe(true);
    expect(Array.isArray(response.body.events)).toBe(true);
    expect(Array.isArray(response.body.failedJobs)).toBe(true);
  });
});
