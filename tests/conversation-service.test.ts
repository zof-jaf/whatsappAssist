import { afterEach, describe, expect, it } from 'vitest';
import type { InboundJobRow } from '../src/db/types.js';
import type { WahaWebhookEvent } from '../src/domain/waha.js';
import { WahaError } from '../src/errors.js';
import {
  createTestContext,
  makeMessageEvent,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;

function context(overrides: NodeJS.ProcessEnv = {}): TestContext {
  ctx = createTestContext({ SUMMARY_ENABLED: 'false', ...overrides });
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

describe('ConversationService', () => {
  it('procesa un mensaje de punta a punta y guarda todo el historial', async () => {
    const app = context();
    app.ollama.defaultResponse = '¡Hola! ¿Cómo estás?';

    const event = makeMessageEvent({
      from: '5491111111111@c.us',
      body: 'Hola bot',
    });
    const job = queue(app, event);
    await app.conversations.processJob(job);

    const contact = app.repos.contacts.getByWaId('5491111111111@c.us');
    expect(contact?.push_name).toBe('Contacto de Prueba');

    const conversation = app.repos.conversations.getByContactId(contact!.id);
    expect(conversation?.last_inbound_at).toBeTruthy();
    expect(conversation?.last_outbound_at).toBeTruthy();

    const messages = app.repos.messages.allByConversation(conversation!.id);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.direction).toBe('in');
    expect(messages[0]?.body).toBe('Hola bot');
    expect(messages[1]?.direction).toBe('out');
    expect(messages[1]?.body).toBe('¡Hola! ¿Cómo estás?');
    expect(messages[1]?.status).toBe('sent');
    expect(messages[1]?.model).toBe('test-model:1b');
    expect(messages[1]?.prompt_tokens).toBe(10);
    expect(messages[1]?.reply_to_message_id).toBe(messages[0]?.id);

    expect(app.waha.sent).toEqual([
      {
        chatId: '5491111111111@c.us',
        text: '¡Hola! ¿Cómo estás?',
        replyTo: null,
      },
    ]);
    expect(app.waha.seen).toContain('5491111111111@c.us');
    expect(app.waha.typingStarted).toContain('5491111111111@c.us');
    expect(app.waha.typingStopped).toContain('5491111111111@c.us');
    expect(app.ollama.calls).toHaveLength(1);
    expect(app.ollama.calls[0]?.[0]?.role).toBe('system');
  });

  it('quita el encabezado de la guía interna de una respuesta de IA', async () => {
    const app = context();
    app.ollama.defaultResponse = [
      '# Formato de respuestas — Asistente de cotización de tatuajes',
      '',
      'Buenas noches. ¿En qué puedo ayudarte?',
    ].join('\n');

    await app.conversations.processJob(
      queue(app, makeMessageEvent({ body: 'Buenas noches' })),
    );

    expect(app.waha.sent).toHaveLength(1);
    expect(app.waha.sent[0]?.text).toBe(
      'Buenas noches. ¿En qué puedo ayudarte?',
    );
  });

  it('reemplaza una respuesta que era solo la guía interna', async () => {
    const app = context();
    app.ollama.defaultResponse = [
      '# Formato de respuestas — Asistente de cotización de tatuajes',
      '',
      '## 1. Objetivo del asistente',
      '',
      '- Cotizar tatuajes y retoques.',
    ].join('\n');

    await app.conversations.processJob(
      queue(app, makeMessageEvent({ body: 'Hola' })),
    );

    const sent = app.waha.sent[0]?.text ?? '';
    expect(sent).toBe('¡Hola! ¿En qué te ayudo?');
    expect(sent).not.toContain('Formato de respuestas');
    expect(sent).not.toContain('#');
  });

  it('incluye los mensajes anteriores como contexto', async () => {
    const app = context();
    app.ollama.responses = ['Primera respuesta', 'Segunda respuesta'];

    await app.conversations.processJob(
      queue(app, makeMessageEvent({ body: 'Primer mensaje' })),
    );
    await app.conversations.processJob(
      queue(app, makeMessageEvent({ body: 'Segundo mensaje' })),
    );

    const secondCall = app.ollama.calls[1] ?? [];
    const contents = secondCall.map((message) => message.content);
    expect(contents.some((content) => content.includes('Primer mensaje'))).toBe(
      true,
    );
    expect(contents.some((content) => content.includes('Primera respuesta'))).toBe(
      true,
    );
    expect(contents.some((content) => content.includes('Segundo mensaje'))).toBe(
      true,
    );
  });

  it('responde con el mensaje de respaldo si Ollama falla', async () => {
    const app = context();
    app.ollama.failChats = 1;

    await app.conversations.processJob(
      queue(app, makeMessageEvent({ body: 'Hola' })),
    );

    const contact = app.repos.contacts.getByWaId('5491111111111@c.us');
    const conversation = app.repos.conversations.getByContactId(contact!.id);
    const messages = app.repos.messages.allByConversation(conversation!.id);

    expect(messages).toHaveLength(2);
    expect(messages[1]?.kind).toBe('system');
    expect(messages[1]?.body).toBe(app.config.bot.aiFallbackReply);
    expect(messages[1]?.status).toBe('sent');
    expect(app.waha.sent[0]?.text).toBe(app.config.bot.aiFallbackReply);
  });

  it('avisa cuando recibe multimedia sin texto', async () => {
    const app = context();

    await app.conversations.processJob(
      queue(
        app,
        makeMessageEvent({
          hasMedia: true,
          body: '',
          media: { mimetype: 'image/jpeg', url: 'https://example.com/x.jpg' },
        }),
      ),
    );

    expect(app.ollama.calls).toHaveLength(0);
    expect(app.waha.sent[0]?.text).toContain('solo puedo procesar mensajes de texto');
  });

  it('procesa /ayuda sin llamar al modelo', async () => {
    const app = context();

    await app.conversations.processJob(
      queue(app, makeMessageEvent({ body: '/ayuda' })),
    );

    expect(app.ollama.calls).toHaveLength(0);
    expect(app.waha.sent[0]?.text).toContain('Comandos disponibles');
    const contact = app.repos.contacts.getByWaId('5491111111111@c.us');
    const conversation = app.repos.conversations.getByContactId(contact!.id);
    const messages = app.repos.messages.allByConversation(conversation!.id);
    expect(messages[1]?.kind).toBe('command');
  });

  it('/reset reinicia el contexto sin borrar historial', async () => {
    const app = context();
    app.ollama.responses = ['Respuesta uno', 'Respuesta dos'];

    await app.conversations.processJob(
      queue(app, makeMessageEvent({ body: 'Uno' })),
    );
    await app.conversations.processJob(
      queue(app, makeMessageEvent({ body: '/reset' })),
    );
    await app.conversations.processJob(
      queue(app, makeMessageEvent({ body: 'Dos' })),
    );

    const contact = app.repos.contacts.getByWaId('5491111111111@c.us');
    const conversation = app.repos.conversations.getByContactId(contact!.id);
    expect(conversation?.context_start_message_id).toBe(3);
    expect(app.repos.messages.count()).toBe(6);

    const lastCall = app.ollama.calls.at(-1) ?? [];
    expect(
      lastCall.some((message) => message.content.includes('Uno')),
    ).toBe(false);
    expect(
      lastCall.some((message) => message.content.includes('Dos')),
    ).toBe(true);
  });

  it('/estado informa modelo y contexto', async () => {
    const app = context();

    await app.conversations.processJob(
      queue(app, makeMessageEvent({ body: '/estado' })),
    );

    expect(app.waha.sent[0]?.text).toContain('test-model:1b');
    expect(app.waha.sent[0]?.text).toContain('Mensajes en contexto');
  });

  it('no vuelve a responder si el trabajo se reprocesa', async () => {
    const app = context();
    const job = queue(app, makeMessageEvent({ body: 'Hola' }));

    await app.conversations.processJob(job);
    await app.conversations.processJob(job);

    expect(app.waha.sent).toHaveLength(1);
    expect(app.ollama.calls).toHaveLength(1);
  });

  it('reutiliza la respuesta pendiente si falla el envío', async () => {
    const app = context();
    app.ollama.responses = ['Respuesta única'];
    app.waha.failNextSend = new WahaError('WAHA caído');

    const job = queue(app, makeMessageEvent({ body: 'Hola' }));

    await expect(app.conversations.processJob(job)).rejects.toThrow(
      'WAHA caído',
    );

    const contact = app.repos.contacts.getByWaId('5491111111111@c.us');
    const conversation = app.repos.conversations.getByContactId(contact!.id);
    const failed = app.repos.messages.allByConversation(conversation!.id)[1];
    expect(failed?.status).toBe('failed');

    await app.conversations.processJob(job);

    expect(app.ollama.calls).toHaveLength(1);
    expect(app.waha.sent).toHaveLength(1);
    expect(app.waha.sent[0]?.text).toBe('Respuesta única');
    expect(app.repos.messages.getById(failed!.id)?.status).toBe('sent');
  });

  it('respeta quoteReplies', async () => {
    const app = context({ QUOTE_REPLIES: 'true' });

    await app.conversations.processJob(
      queue(app, makeMessageEvent({ body: 'Hola', id: 'wamid-cita' })),
    );

    expect(app.waha.sent[0]?.replyTo).toBe('wamid-cita');
  });

  it('omite la respuesta si el bot está desactivado', async () => {
    const app = context({ BOT_ENABLED: 'false' });

    await app.conversations.processJob(
      queue(app, makeMessageEvent({ body: 'Hola' })),
    );

    const contact = app.repos.contacts.getByWaId('5491111111111@c.us');
    const conversation = app.repos.conversations.getByContactId(contact!.id);
    const messages = app.repos.messages.allByConversation(conversation!.id);

    expect(messages).toHaveLength(1);
    expect(messages[0]?.status).toBe('skipped');
    expect(app.waha.sent).toHaveLength(0);
  });

  it('omite la respuesta si la IA está desactivada en la conversación', async () => {
    const app = context();
    const contact = app.repos.contacts.upsert({ waId: '5491111111111@c.us' });
    const conversation = app.repos.conversations.getOrCreate(contact.id);
    app.repos.conversations.setAiEnabled(conversation.id, false);

    await app.conversations.processJob(
      queue(app, makeMessageEvent({ body: 'Hola' })),
    );

    expect(app.waha.sent).toHaveLength(0);
    expect(
      app.repos.messages.allByConversation(conversation.id)[0]?.status,
    ).toBe('skipped');
  });

  it('omite la respuesta en conversaciones archivadas', async () => {
    const app = context();
    const contact = app.repos.contacts.upsert({ waId: '5491111111111@c.us' });
    const conversation = app.repos.conversations.getOrCreate(contact.id);
    app.repos.conversations.setStatus(conversation.id, 'archived');

    await app.conversations.processJob(
      queue(app, makeMessageEvent({ body: 'Hola' })),
    );

    expect(app.waha.sent).toHaveLength(0);
    expect(
      app.repos.messages.allByConversation(conversation.id)[0]?.status,
    ).toBe('skipped');
  });
});
