import { describe, expect, it } from 'vitest';
import {
  normalizeColombianPhone,
  phoneFromArtistChatId,
} from '../src/domain/phones.js';

describe('números de WhatsApp de Colombia', () => {
  it('normaliza un número local de 10 dígitos', () => {
    expect(normalizeColombianPhone('3001234567')).toEqual({
      phone: '3001234567',
      chatId: '573001234567@c.us',
      display: '+57 300 123 4567',
    });
  });

  it('acepta el código de país y separadores', () => {
    expect(normalizeColombianPhone('+57 300 123 4567')?.chatId).toBe(
      '573001234567@c.us',
    );
    expect(normalizeColombianPhone('57 (300) 123-4567')?.phone).toBe(
      '3001234567',
    );
    expect(normalizeColombianPhone('0057 300 123 4567')?.phone).toBe(
      '3001234567',
    );
  });

  it('rechaza números incompletos o con otro formato', () => {
    expect(normalizeColombianPhone('')).toBeNull();
    expect(normalizeColombianPhone('300123456')).toBeNull();
    expect(normalizeColombianPhone('30012345678')).toBeNull();
    expect(normalizeColombianPhone('123')).toBeNull();
  });

  it('extrae el número local de un chat ID configurado por .env', () => {
    expect(phoneFromArtistChatId('573001234567@c.us')).toBe('3001234567');
    expect(phoneFromArtistChatId('3001234567@c.us')).toBe('3001234567');
    expect(phoneFromArtistChatId('212648796905552@lid')).toBeNull();
    expect(phoneFromArtistChatId(null)).toBeNull();
  });
});
