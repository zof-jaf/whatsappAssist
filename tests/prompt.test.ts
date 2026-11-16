import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { MessageRow } from '../src/db/types.js';
import {
  buildPrompt,
  buildSummaryMessages,
  buildSystemPrompt,
  prepareResponseGuide,
} from '../src/domain/prompt.js';

const config = loadConfig({
  ADMIN_TOKEN: 'token-de-prueba-1234567890',
  HISTORY_MAX_MESSAGES: '6',
  HISTORY_MAX_CHARS: '2000',
  PROMPT_MAX_MESSAGE_CHARS: '200',
});

let counter = 0;

function message(
  role: 'user' | 'assistant',
  body: string,
  overrides: Partial<MessageRow> = {},
): MessageRow {
  counter += 1;
  return {
    id: counter,
    conversation_id: 1,
    contact_id: 1,
    wa_message_id: `wamid-${counter}`,
    direction: role === 'user' ? 'in' : 'out',
    role,
    kind: 'text',
    body,
    media_url: null,
    media_mime: null,
    media_filename: null,
    status: role === 'user' ? 'received' : 'sent',
    error: null,
    model: null,
    prompt_tokens: null,
    completion_tokens: null,
    latency_ms: null,
    reply_to_message_id: null,
    wa_timestamp: null,
    sent_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('construcción del prompt', () => {
  it('marca la guía como material interno y no expone su encabezado', () => {
    const guide = [
      '# Formato de respuestas — Asistente de cotización de tatuajes',
      '',
      '## 5. Flujo de atención',
      '',
      'Respondé con calidez.',
    ].join('\n');
    const system = buildSystemPrompt(config, null, { responseGuide: guide });

    expect(system).toContain('Guía interna de referencia');
    expect(system).toContain('<guia_interna>');
    expect(system).toContain('[Flujo de atención]');
    expect(system).toContain('No copies ni cites');
    expect(system).not.toContain('# Formato de respuestas');
  });

  it('quita el título del documento y los encabezados Markdown de la guía', () => {
    const prepared = prepareResponseGuide(
      [
        '# Formato de respuestas — Asistente de cotización de tatuajes',
        '',
        'Este documento se lee antes de cada respuesta.',
        'Su objetivo es que el asistente derive los precios.',
        '',
        '## 1. Objetivo del asistente',
        '',
        '- Cotizar tatuajes y retoques.',
      ].join('\n'),
    );

    expect(prepared).toBe(
      '[Objetivo del asistente]\n\n- Cotizar tatuajes y retoques.',
    );
  });

  it('incluye instrucciones, fecha y resumen', () => {
    const system = buildSystemPrompt(config, 'Al usuario le gusta el café.');

    expect(system).toContain(config.bot.systemPrompt);
    expect(system).toContain(config.bot.name);
    expect(system).toContain(config.bot.timeZone);
    expect(system).toContain('Resumen de la parte anterior');
    expect(system).toContain('Al usuario le gusta el café.');
  });

  it('arma el historial en orden y respeta el máximo de mensajes', () => {
    const messages = [
      message('user', 'uno'),
      message('assistant', 'dos'),
      message('user', 'tres'),
      message('assistant', 'cuatro'),
      message('user', 'cinco'),
      message('assistant', 'seis'),
      message('user', 'siete'),
      message('assistant', 'ocho'),
    ];

    const prompt = buildPrompt(config, messages);
    const history = prompt.messages.filter((item) => item.role !== 'system');

    expect(prompt.messages[0]?.role).toBe('system');
    expect(history).toHaveLength(6);
    expect(history.map((item) => item.content)).toEqual([
      'tres',
      'cuatro',
      'cinco',
      'seis',
      'siete',
      'ocho',
    ]);
    expect(prompt.truncated).toBe(true);
  });

  it('nunca empieza el historial con una respuesta del asistente', () => {
    const messages = [
      message('assistant', 'respuesta vieja'),
      message('user', 'hola'),
      message('assistant', 'respuesta'),
    ];

    const prompt = buildPrompt(config, messages);
    const history = prompt.messages.filter((item) => item.role !== 'system');

    expect(history[0]?.role).toBe('user');
    expect(history[0]?.content).toBe('hola');
  });

  it('respeta el presupuesto de caracteres conservando lo más reciente', () => {
    const budgetConfig = loadConfig({
      ADMIN_TOKEN: 'token-de-prueba-1234567890',
      HISTORY_MAX_MESSAGES: '10',
      HISTORY_MAX_CHARS: '1000',
      PROMPT_MAX_MESSAGE_CHARS: '200',
    });
    const messages = [
      message('user', 'x'.repeat(500)),
      message('assistant', 'y'.repeat(500)),
      message('user', 'z'.repeat(500)),
      message('assistant', 'w'.repeat(500)),
      message('user', 'v'.repeat(500)),
      message('assistant', 'u'.repeat(500)),
      message('user', 't'.repeat(500)),
      message('user', 'mensaje reciente'),
    ];

    const prompt = buildPrompt(budgetConfig, messages);
    const history = prompt.messages.filter((item) => item.role !== 'system');

    expect(history.length).toBeLessThan(messages.length);
    expect(history.at(-1)?.content).toBe('mensaje reciente');
    expect(prompt.truncated).toBe(true);
  });

  it('etiqueta los mensajes multimedia', () => {
    const messages = [
      message('user', 'mirá esto', {
        kind: 'media',
        media_mime: 'image/jpeg',
      }),
    ];

    const prompt = buildPrompt(config, messages);
    const history = prompt.messages.filter((item) => item.role !== 'system');

    expect(history[0]?.content).toContain('[Archivo adjunto: image/jpeg]');
    expect(history[0]?.content).toContain('mirá esto');
  });

  it('genera el prompt de resumen con resumen previo', () => {
    const summaryMessages = buildSummaryMessages({
      previousSummary: 'El usuario se llama Ana.',
      messages: [message('user', 'Me mudé a Córdoba.')],
      maxInputChars: 5000,
      botName: 'Asistente',
    });

    expect(summaryMessages[0]?.role).toBe('system');
    expect(summaryMessages[1]?.content).toContain('El usuario se llama Ana.');
    expect(summaryMessages[1]?.content).toContain('Usuario: Me mudé a Córdoba.');
  });

  it('recorta el inicio de transcripciones demasiado largas', () => {
    const summaryMessages = buildSummaryMessages({
      messages: [
        message('user', 'inicio '.repeat(100)),
        message('user', 'final importante'),
      ],
      maxInputChars: 100,
      botName: 'Asistente',
    });

    const content = summaryMessages[1]?.content ?? '';
    expect(content).toContain('[...inicio del fragmento omitido...]');
    expect(content).toContain('final importante');
  });
});
