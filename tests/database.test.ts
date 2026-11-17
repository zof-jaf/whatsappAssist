import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase, type Db } from '../src/db/database.js';
import { createRepositories, type Repositories } from '../src/db/repositories/index.js';

describe('base de datos SQLite', () => {
  let db: Db;
  let repos: Repositories;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repos = createRepositories(db);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('aplica la migración inicial', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(5);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all() as Array<{ name: string }>;

    const names = tables.map((table) => table.name);
    expect(names).toContain('contacts');
    expect(names).toContain('conversations');
    expect(names).toContain('messages');
    expect(names).toContain('conversation_summaries');
    expect(names).toContain('quote_requests');
    expect(names).toContain('inbound_jobs');
    expect(names).toContain('webhook_events');
    expect(names).toContain('app_meta');

    const quoteColumns = db
      .prepare("PRAGMA table_info('quote_requests')")
      .all() as Array<{ name: string }>;
    expect(quoteColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'kind',
        'appointment_at',
        'notion_page_id',
        'notion_page_url',
      ]),
    );
  });

  it('crea y actualiza contactos sin perder datos', () => {
    const created = repos.contacts.upsert({
      waId: '5491111111111@c.us',
      phone: '5491111111111',
      pushName: 'Ana',
    });

    expect(created.display_name).toBe('Ana');
    expect(created.first_seen_at).toBeTruthy();

    const updated = repos.contacts.upsert({
      waId: '5491111111111@c.us',
      pushName: 'Ana María',
      displayName: 'Ana M.',
    });

    expect(updated.id).toBe(created.id);
    expect(updated.push_name).toBe('Ana María');
    expect(updated.display_name).toBe('Ana M.');
    expect(updated.phone).toBe('5491111111111');
    expect(repos.contacts.count()).toBe(1);
  });

  it('reutiliza la conversación de un contacto', () => {
    const contact = repos.contacts.upsert({ waId: '1@c.us' });
    const first = repos.conversations.getOrCreate(contact.id);
    const second = repos.conversations.getOrCreate(contact.id);

    expect(second.id).toBe(first.id);
    expect(first.ai_enabled).toBe(1);
    expect(first.status).toBe('active');
  });

  it('deduplica mensajes por wa_message_id', () => {
    const contact = repos.contacts.upsert({ waId: '1@c.us' });
    const conversation = repos.conversations.getOrCreate(contact.id);

    const first = repos.messages.insertInbound({
      conversationId: conversation.id,
      contactId: contact.id,
      waMessageId: 'wamid-1',
      body: 'hola',
      kind: 'text',
    });
    const second = repos.messages.insertInbound({
      conversationId: conversation.id,
      contactId: contact.id,
      waMessageId: 'wamid-1',
      body: 'hola de nuevo',
      kind: 'text',
    });

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.message.id).toBe(first.message.id);
    expect(repos.messages.count()).toBe(1);
  });

  it('lista mensajes paginando hacia atrás', () => {
    const contact = repos.contacts.upsert({ waId: '1@c.us' });
    const conversation = repos.conversations.getOrCreate(contact.id);

    for (let index = 1; index <= 5; index += 1) {
      repos.messages.insertInbound({
        conversationId: conversation.id,
        contactId: contact.id,
        waMessageId: `wamid-${index}`,
        body: `mensaje ${index}`,
        kind: 'text',
      });
    }

    const page = repos.messages.listByConversation({
      conversationId: conversation.id,
      limit: 2,
    });
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.items.map((message) => message.body)).toEqual([
      'mensaje 4',
      'mensaje 5',
    ]);

    const older = repos.messages.listByConversation({
      conversationId: conversation.id,
      limit: 2,
      beforeId: page.items[0]?.id,
    });
    expect(older.items.map((message) => message.body)).toEqual([
      'mensaje 2',
      'mensaje 3',
    ]);
  });

  it('excluye respuestas fallidas del contexto de la IA', () => {
    const contact = repos.contacts.upsert({ waId: '1@c.us' });
    const conversation = repos.conversations.getOrCreate(contact.id);

    const inbound = repos.messages.insertInbound({
      conversationId: conversation.id,
      contactId: contact.id,
      waMessageId: 'wamid-in',
      body: 'hola',
      kind: 'text',
    });
    const failed = repos.messages.insertOutbound({
      conversationId: conversation.id,
      contactId: contact.id,
      body: 'respuesta fallida',
      status: 'failed',
      replyToMessageId: inbound.message.id,
    });
    const queued = repos.messages.insertOutbound({
      conversationId: conversation.id,
      contactId: contact.id,
      body: 'respuesta en cola',
      status: 'queued',
    });

    const context = repos.messages.contextAfter(conversation.id, 0);
    const bodies = context.map((message) => message.body);

    expect(bodies).toContain('hola');
    expect(bodies).toContain('respuesta en cola');
    expect(bodies).not.toContain('respuesta fallida');
    expect(failed.status).toBe('failed');
    expect(queued.status).toBe('queued');
  });

  it('reinicia el contexto sin borrar el historial', () => {
    const contact = repos.contacts.upsert({ waId: '1@c.us' });
    const conversation = repos.conversations.getOrCreate(contact.id);

    repos.messages.insertInbound({
      conversationId: conversation.id,
      contactId: contact.id,
      waMessageId: 'wamid-1',
      body: 'hola',
      kind: 'text',
    });
    repos.summaries.insert({
      conversationId: conversation.id,
      summary: 'Resumen previo',
      throughMessageId: 1,
      messagesCovered: 1,
    });

    const boundary = repos.conversations.resetContext(conversation.id);
    const updated = repos.conversations.getById(conversation.id);

    expect(boundary).toBe(1);
    expect(updated?.context_start_message_id).toBe(1);
    expect(repos.messages.count()).toBe(1);
    expect(repos.summaries.latestActive(conversation.id)).toBeUndefined();
  });

  it('respeta el orden por chat al reclamar trabajos', () => {
    repos.jobs.enqueue({
      waMessageId: 'a-1',
      chatId: 'chat-a',
      payload: '{}',
      maxAttempts: 3,
    });
    repos.jobs.enqueue({
      waMessageId: 'b-1',
      chatId: 'chat-b',
      payload: '{}',
      maxAttempts: 3,
    });
    repos.jobs.enqueue({
      waMessageId: 'a-2',
      chatId: 'chat-a',
      payload: '{}',
      maxAttempts: 3,
    });

    const first = repos.jobs.claimNext();
    expect(first?.wa_message_id).toBe('a-1');

    // a-2 no puede adelantarse a a-1 mientras este siga en proceso.
    const second = repos.jobs.claimNext();
    expect(second?.wa_message_id).toBe('b-1');

    repos.jobs.markDone(first!.id);
    const third = repos.jobs.claimNext();
    expect(third?.wa_message_id).toBe('a-2');
  });

  it('bloquea los siguientes trabajos del chat cuando uno espera reintento', () => {
    repos.jobs.enqueue({
      waMessageId: 'a-1',
      chatId: 'chat-a',
      payload: '{}',
      maxAttempts: 3,
    });
    repos.jobs.enqueue({
      waMessageId: 'a-2',
      chatId: 'chat-a',
      payload: '{}',
      maxAttempts: 3,
    });

    const first = repos.jobs.claimNext();
    repos.jobs.markFailure(first!.id, {
      error: 'falló',
      retryAt: new Date(Date.now() + 60_000).toISOString(),
      final: false,
    });

    expect(repos.jobs.claimNext()).toBeUndefined();
  });

  it('recupera trabajos interrumpidos y libera los del cierre', () => {
    repos.jobs.enqueue({
      waMessageId: 'a-1',
      chatId: 'chat-a',
      payload: '{}',
      maxAttempts: 3,
    });
    const claimed = repos.jobs.claimNext();
    expect(claimed?.status).toBe('processing');

    const recovered = repos.jobs.recoverInterrupted();
    expect(recovered).toBe(1);
    expect(repos.jobs.getById(claimed!.id)?.status).toBe('pending');
    expect(repos.jobs.getById(claimed!.id)?.attempts).toBe(1);

    const claimedAgain = repos.jobs.claimNext();
    expect(claimedAgain?.attempts).toBe(2);
    repos.jobs.releaseForShutdown(claimedAgain!.id);
    const released = repos.jobs.getById(claimedAgain!.id);
    expect(released?.status).toBe('pending');
    expect(released?.attempts).toBe(1);
  });

  it('registra eventos y permite podarlos', () => {
    repos.events.insert({
      eventId: 'evt-1',
      event: 'message',
      session: 'default',
      status: 'queued',
      payload: { ok: true },
    });

    const events = repos.events.listRecent(10);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('message');

    expect(repos.events.prune('2999-01-01T00:00:00.000Z')).toBe(1);
    expect(repos.events.listRecent(10)).toHaveLength(0);
  });

  it('guarda metadatos y calcula estadísticas', () => {
    repos.meta.set('clave', 'valor');
    repos.meta.setJson('json', { hola: 'mundo' });

    expect(repos.meta.get('clave')).toBe('valor');
    expect(repos.meta.getJson<{ hola: string }>('json')).toEqual({
      hola: 'mundo',
    });

    const contact = repos.contacts.upsert({ waId: '1@c.us' });
    const conversation = repos.conversations.getOrCreate(contact.id);
    repos.messages.insertInbound({
      conversationId: conversation.id,
      contactId: contact.id,
      waMessageId: 'wamid-1',
      body: 'hola',
      kind: 'text',
    });

    const stats = repos.stats.overview();
    expect(stats.contacts).toBe(1);
    expect(stats.conversations).toBe(1);
    expect(stats.messages).toBe(1);
    expect(stats.inboundToday).toBe(1);
    expect(stats.dbSizeBytes).toBeGreaterThan(0);
  });

  it('persiste en disco y aplica WAL', () => {
    const directory = mkdtempSync(join(tmpdir(), 'wa-bot-db-'));
    const path = join(directory, 'bot.db');
    const diskDb = openDatabase(path);

    try {
      expect(diskDb.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(diskDb.pragma('user_version', { simple: true })).toBe(5);
    } finally {
      closeDatabase(diskDb);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
