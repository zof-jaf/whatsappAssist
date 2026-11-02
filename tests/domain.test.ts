import { describe, expect, it } from 'vitest';
import {
  ackToMessageStatus,
  isWahaWebhookEvent,
  parseAckEvent,
  parseMessageEvent,
  parseSessionStatusEvent,
} from '../src/domain/waha.js';
import {
  helpText,
  matchCommand,
  resetText,
} from '../src/domain/commands.js';
import {
  isBroadcastId,
  isGroupId,
  normalizeChatId,
  phoneFromWaId,
  sanitizeReply,
  truncate,
} from '../src/utils/text.js';

describe('parser de eventos WAHA', () => {
  function event(overrides: Record<string, unknown> = {}) {
    const { payload: payloadOverrides, ...rest } = overrides;
    return {
      event: 'message',
      session: 'default',
      timestamp: 1_700_000_000_000,
      payload: {
        id: 'false_5491111111111@c.us_ABC',
        from: '5491111111111@c.us',
        fromMe: false,
        body: 'Hola',
        hasMedia: false,
        timestamp: 1_700_000_000,
        pushName: 'Ana',
        ...((payloadOverrides as Record<string, unknown>) ?? {}),
      },
      ...rest,
    };
  }

  it('normaliza un mensaje de texto', () => {
    const result = parseMessageEvent(event());

    expect(result.ok).toBe(true);
    expect(result.message?.waMessageId).toBe('false_5491111111111@c.us_ABC');
    expect(result.message?.chatId).toBe('5491111111111@c.us');
    expect(result.message?.phone).toBe('5491111111111');
    expect(result.message?.pushName).toBe('Ana');
    expect(result.message?.kind).toBe('text');
    expect(result.message?.timestampIso).toContain('2023-11-14');
  });

  it('usa _data.notifyName si falta pushName', () => {
    const result = parseMessageEvent(
      event({ payload: { pushName: undefined, _data: { notifyName: 'Beto' } } }),
    );
    expect(result.message?.pushName).toBe('Beto');
  });

  it('detecta grupos y multimedia', () => {
    const result = parseMessageEvent(
      event({
        payload: {
          from: '120363000000000000@g.us',
          hasMedia: true,
          body: '',
          media: { url: 'https://example.com/f.jpg', mimetype: 'image/jpeg' },
        },
      }),
    );

    expect(result.message?.isGroup).toBe(true);
    expect(result.message?.kind).toBe('media');
    expect(result.message?.mediaMime).toBe('image/jpeg');
  });

  it('rechaza eventos sin id o sin remitente', () => {
    expect(
      parseMessageEvent(event({ payload: { id: undefined } })).ok,
    ).toBe(false);
    expect(
      parseMessageEvent(event({ payload: { from: undefined } })).ok,
    ).toBe(false);
  });

  it('rechaza eventos que no son mensajes', () => {
    const result = parseMessageEvent(event({ event: 'session.status' }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('evento_no_soportado');
  });

  it('interpreta session.status', () => {
    const info = parseSessionStatusEvent({
      event: 'session.status',
      timestamp: 1_700_000_000_000,
      payload: { status: 'WORKING' },
      me: { id: 'me@c.us', pushName: 'Bot' },
    });

    expect(info?.status).toBe('WORKING');
    expect(info?.me?.pushName).toBe('Bot');
  });

  it('interpreta acks por nombre y por número', () => {
    const byName = parseAckEvent({
      event: 'message.ack',
      payload: { id: 'wamid-1', ack: 3, ackName: 'READ' },
    });
    expect(byName).toBeDefined();
    expect(ackToMessageStatus(byName!)).toBe('read');

    const byNumber = parseAckEvent({
      event: 'message.ack',
      payload: { id: 'wamid-2', ack: 2 },
    });
    expect(ackToMessageStatus(byNumber!)).toBe('delivered');

    const errorAck = parseAckEvent({
      event: 'message.ack',
      payload: { id: 'wamid-3', ack: -1 },
    });
    expect(ackToMessageStatus(errorAck!)).toBe('failed');

    const unknown = parseAckEvent({
      event: 'message.ack',
      payload: { id: 'wamid-4', ack: 99, ackName: 'OTRO' },
    });
    expect(ackToMessageStatus(unknown!)).toBeUndefined();
  });

  it('valida la forma mínima de un webhook', () => {
    expect(isWahaWebhookEvent({ event: 'message' })).toBe(true);
    expect(isWahaWebhookEvent({ event: '' })).toBe(false);
    expect(isWahaWebhookEvent({ hola: 'mundo' })).toBe(false);
    expect(isWahaWebhookEvent(null)).toBe(false);
  });
});

describe('comandos', () => {
  it('reconoce comandos con alias y mayúsculas', () => {
    expect(matchCommand('/reset')).toBe('reset');
    expect(matchCommand('/REINICIAR')).toBe('reset');
    expect(matchCommand('  /ayuda  ')).toBe('help');
    expect(matchCommand('/estado ahora')).toBe('status');
    expect(matchCommand('hola /reset')).toBeUndefined();
    expect(matchCommand('/desconocido')).toBeUndefined();
  });

  it('genera textos de ayuda y reset', () => {
    expect(helpText('Copiloto')).toContain('Copiloto');
    expect(helpText('Copiloto')).toContain('/reset');
    expect(resetText()).toContain('contexto nuevo');
  });
});

describe('utilidades de texto', () => {
  it('extrae teléfonos y clasifica chats', () => {
    expect(phoneFromWaId('5491111111111@c.us')).toBe('5491111111111');
    expect(phoneFromWaId('123@g.us')).toBeNull();
    expect(isGroupId('123@g.us')).toBe(true);
    expect(isBroadcastId('status@broadcast')).toBe(true);
    expect(isBroadcastId('123@newsletter')).toBe(true);
    expect(isBroadcastId('123@c.us')).toBe(false);
  });

  it('normaliza chat ids', () => {
    expect(normalizeChatId('5491111111111')).toBe('5491111111111@c.us');
    expect(normalizeChatId('5491111111111@C.US')).toBe('5491111111111@c.us');
    expect(normalizeChatId('')).toBe('');
  });

  it('recorta sin partir emojis', () => {
    expect(truncate('hola mundo', 6)).toBe('hola …');
    expect(Array.from(truncate('😀😀😀😀', 3))).toHaveLength(3);
    expect(truncate('corto', 10)).toBe('corto');
  });

  it('sanea respuestas para WhatsApp', () => {
    const cleaned = sanitizeReply('  hola  \r\n\r\nmundo \u0000 ');
    expect(cleaned).toBe('hola\n\nmundo');
  });
});
