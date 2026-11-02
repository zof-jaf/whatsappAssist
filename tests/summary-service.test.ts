import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;

function context(overrides: NodeJS.ProcessEnv = {}): TestContext {
  ctx = createTestContext({
    SUMMARY_ENABLED: 'true',
    SUMMARY_TRIGGER_MESSAGES: '6',
    SUMMARY_TRIGGER_CHARS: '100000',
    SUMMARY_KEEP_RECENT_MESSAGES: '2',
    ...overrides,
  });
  return ctx;
}

afterEach(() => {
  ctx.close();
});

function seedConversation(app: TestContext, exchanges: number, start = 0) {
  const contact = app.repos.contacts.upsert({
    waId: '5491111111111@c.us',
    pushName: 'Ana',
  });
  const conversation = app.repos.conversations.getOrCreate(contact.id);

  for (let offset = 0; offset < exchanges; offset += 1) {
    const index = start + offset;
    app.repos.messages.insertInbound({
      conversationId: conversation.id,
      contactId: contact.id,
      waMessageId: `wamid-in-${index}`,
      body: `Pregunta ${index}`,
      kind: 'text',
    });
    app.repos.messages.insertOutbound({
      conversationId: conversation.id,
      contactId: contact.id,
      body: `Respuesta ${index}`,
      status: 'sent',
    });
  }

  return { contact, conversation };
}

describe('SummaryService', () => {
  it('genera un resumen al superar el umbral y conserva los recientes', async () => {
    const app = context();
    app.ollama.defaultResponse = 'El usuario hizo cuatro preguntas de prueba.';
    const { conversation } = seedConversation(app, 4);

    const created = await app.summaries.maybeSummarize(conversation.id);

    expect(created).toBe(true);
    expect(app.ollama.calls).toHaveLength(1);

    const summary = app.repos.summaries.latestActive(conversation.id);
    expect(summary?.summary).toBe('El usuario hizo cuatro preguntas de prueba.');
    expect(summary?.through_message_id).toBe(6);
    expect(summary?.messages_covered).toBe(6);
    expect(summary?.is_active).toBe(1);

    const summaryPrompt = app.ollama.calls[0]?.map((item) => item.content).join('\n');
    expect(summaryPrompt).toContain('Pregunta 0');
    expect(summaryPrompt).toContain('Pregunta 2');
    expect(summaryPrompt).not.toContain('Pregunta 3');
  });

  it('no resume si no se alcanzó el umbral', async () => {
    const app = context();
    const { conversation } = seedConversation(app, 2);

    const created = await app.summaries.maybeSummarize(conversation.id);

    expect(created).toBe(false);
    expect(app.ollama.calls).toHaveLength(0);
    expect(app.repos.summaries.latestActive(conversation.id)).toBeUndefined();
  });

  it('no resume si no quedan mensajes antiguos suficientes', async () => {
    const app = context({
      SUMMARY_TRIGGER_MESSAGES: '6',
      SUMMARY_KEEP_RECENT_MESSAGES: '10',
    });
    const { conversation } = seedConversation(app, 3);

    const created = await app.summaries.maybeSummarize(conversation.id);

    expect(created).toBe(false);
    expect(app.ollama.calls).toHaveLength(0);
  });

  it('vuelve a resumir solo los mensajes nuevos', async () => {
    const app = context();
    app.ollama.responses = ['Primer resumen', 'Segundo resumen'];
    const { conversation } = seedConversation(app, 4);

    await app.summaries.maybeSummarize(conversation.id);
    seedConversation(app, 3, 4);

    const created = await app.summaries.maybeSummarize(conversation.id);

    expect(created).toBe(true);
    expect(app.ollama.calls).toHaveLength(2);

    const summary = app.repos.summaries.latestActive(conversation.id);
    expect(summary?.summary).toBe('Segundo resumen');
    expect((summary?.messages_covered ?? 0) > 6).toBe(true);

    const activeSummaries = app.db
      .prepare(
        'SELECT COUNT(*) AS count FROM conversation_summaries WHERE conversation_id = ? AND is_active = 1',
      )
      .get(conversation.id) as { count: number };
    expect(activeSummaries.count).toBe(1);

    const secondPrompt = app.ollama.calls[1]?.map((item) => item.content).join('\n');
    expect(secondPrompt).toContain('Primer resumen');
    expect(secondPrompt).toContain('Pregunta 4');
  });

  it('no rompe el flujo si Ollama falla al resumir', async () => {
    const app = context();
    app.ollama.failChats = 1;
    const { conversation } = seedConversation(app, 4);

    const created = await app.summaries.maybeSummarize(conversation.id);

    expect(created).toBe(false);
    expect(app.repos.summaries.latestActive(conversation.id)).toBeUndefined();
  });

  it('no hace nada si los resúmenes están desactivados', async () => {
    const app = context({ SUMMARY_ENABLED: 'false' });
    const { conversation } = seedConversation(app, 10);

    const created = await app.summaries.maybeSummarize(conversation.id);

    expect(created).toBe(false);
    expect(app.ollama.calls).toHaveLength(0);
  });
});
