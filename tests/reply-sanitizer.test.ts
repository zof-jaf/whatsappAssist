import { describe, expect, it } from 'vitest';
import {
  hasMeaningfulText,
  naturalReplyFallback,
  stripGuideLeaks,
} from '../src/domain/reply-sanitizer.js';

describe('limpieza de respuestas con la guía interna', () => {
  it('quita el encabezado filtrado y conserva el saludo', () => {
    const result = stripGuideLeaks(
      '# Formato de respuestas — Asistente de cotización de tatuajes\n\nBuenas noches. ¿En qué puedo ayudarte?',
    );

    expect(result.leaked).toBe(true);
    expect(result.text).toBe('Buenas noches. ¿En qué puedo ayudarte?');
  });

  it('deja el texto vacío cuando la respuesta es solo el encabezado', () => {
    const result = stripGuideLeaks(
      '# Formato de respuestas — Asistente de cotización de tatuajes',
    );

    expect(result.leaked).toBe(true);
    expect(result.text).toBe('');
    expect(hasMeaningfulText(result.text)).toBe(false);
  });

  it('quita títulos de sección y líneas instructivas de la guía', () => {
    const result = stripGuideLeaks(
      [
        '## 5. Flujo de atención',
        '### 5.1 Primera consulta',
        '- Este documento se lee antes de cada respuesta.',
        'Frases prohibidas:',
        'Antes de responder, verificá:',
      ].join('\n'),
    );

    expect(result.leaked).toBe(true);
    expect(result.text).toBe('');
  });

  it('quita etiquetas y marcadores internos con formato Markdown', () => {
    const result = stripGuideLeaks(
      [
        '**Formato de respuesta interno**',
        'Respuesta: [Respuesta breve y clara]',
        '*   Asistente: [Nombre del asistente]',
        '*   Fecha y hora actual: [Fecha y hora actual]',
        '*   Canal: [Canal de comunicación]',
        '*   Tipo de mensaje: [Tipo de mensaje]',
        'Ejemplo:',
        'Asistente: Hola, te ayudo a cotizar.',
      ].join('\n'),
    );

    expect(result.leaked).toBe(true);
    expect(result.text).toBe('Hola, te ayudo a cotizar.');
  });

  it('quita la etiqueta de ejemplo sin perder la respuesta', () => {
    const result = stripGuideLeaks(
      'Asistente: "Con esos datos ya le paso la consulta al tatuador."',
    );

    expect(result.leaked).toBe(true);
    expect(result.text).toBe(
      '"Con esos datos ya le paso la consulta al tatuador."',
    );
  });

  it('no modifica una respuesta natural', () => {
    const reply =
      'Con esos datos ya le paso la consulta al tatuador. Apenas me confirme el precio te lo escribo por acá.';
    const result = stripGuideLeaks(reply);

    expect(result).toEqual({ text: reply, leaked: false });
  });

  it('detecta texto con contenido real', () => {
    expect(hasMeaningfulText('¡Hola!')).toBe(true);
    expect(hasMeaningfulText('...')).toBe(false);
    expect(hasMeaningfulText('  ')).toBe(false);
  });
});

describe('respuesta natural de respaldo', () => {
  it('responde a un saludo', () => {
    expect(naturalReplyFallback('Buenas noches')).toBe(
      '¡Hola! ¿En qué puedo ayudarte?',
    );
  });

  it('pide los datos cuando consultan por precio', () => {
    expect(naturalReplyFallback('¿Cuánto sale un tatuaje?')).toContain(
      'tamaño aproximado',
    );
  });

  it('invita a contar más en otros casos', () => {
    expect(naturalReplyFallback('Quiero hacerme algo')).toBe(
      'Contame un poco más sobre el tatuaje o retoque que querés cotizar.',
    );
  });
});
