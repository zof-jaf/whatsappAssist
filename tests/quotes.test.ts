import { describe, expect, it } from 'vitest';
import {
  isQuoteRequestMessage,
  isQuoteRequestText,
  parseQuoteCode,
  replyContainsPrice,
  replyIsOffTopic,
  replyIsRefusal,
} from '../src/domain/quotes.js';

describe('detección de consultas de cotización', () => {
  it('detecta pedidos de precio y medidas', () => {
    expect(isQuoteRequestText('¿Cuánto sale un tatuaje?')).toBe(true);
    expect(isQuoteRequestText('¿Cuánto cuesta un retoque?')).toBe(true);
    expect(isQuoteRequestText('Es de 10x10 cm')).toBe(true);
    expect(isQuoteRequestText('Un tatuaje de 5 cm')).toBe(true);
    expect(isQuoteRequestText('Quiero cotizar un tatuaje')).toBe(false);
    expect(isQuoteRequestText('¿Cuánto tarda en sanar?')).toBe(false);
  });

  it('considera la multimedia como consulta', () => {
    expect(isQuoteRequestMessage({ body: '', hasMedia: true })).toBe(true);
    expect(isQuoteRequestMessage({ body: 'Hola', hasMedia: false })).toBe(
      false,
    );
  });

  it('extrae el código COT sin confundirlo con un precio', () => {
    expect(parseQuoteCode('COT-000123 sale $50.000')).toEqual({
      code: 'COT-000123',
      text: 'sale $50.000',
    });
    expect(parseQuoteCode('#cot 123, $50.000')).toEqual({
      code: 'COT-000123',
      text: '$50.000',
    });
    expect(parseQuoteCode('cotización 80000 pesos')).toEqual({
      code: null,
      text: 'cotización 80000 pesos',
    });
  });

  it('detecta precios, negativas y preguntas fuera de tema', () => {
    expect(replyContainsPrice('Te sale $50.000')).toBe(true);
    expect(replyContainsPrice('Son 50 mil pesos')).toBe(true);
    expect(replyContainsPrice('Te espero en el estudio')).toBe(false);

    expect(replyIsRefusal('No tengo información sobre costos')).toBe(true);
    expect(replyIsRefusal('Buscá precios en internet')).toBe(true);
    expect(replyIsRefusal('Consultá con otro tatuador')).toBe(true);

    expect(replyIsOffTopic('¿Qué significado tiene para vos?')).toBe(true);
    expect(replyIsOffTopic('¿Tiene algún significado especial?')).toBe(true);
    expect(replyIsOffTopic('Contame la historia del diseño')).toBe(true);
    expect(replyIsOffTopic('¿Qué tamaño tiene?')).toBe(false);
  });
});
