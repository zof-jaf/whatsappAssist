import type { NormalizedInboundMessage } from './waha.js';

const PRICE_PATTERN =
  /(?:\bprecio(?:s)?\b|\bpresupuesto(?:s)?\b|\bcost(?:o|os)\b|\btarifa(?:s)?\b|\bsale\b|\bvale(?:n)?\b|\bcuesta(?:n)?\b|\bcu[aá]nto\s+(?:sale|vale|cuesta|costar[ií]a|ser[ií]a|es)\b)/i;

const DIMENSION_PATTERN =
  /\b\d{1,3}\s*(?:cm|cent[ií]metros?)?\s*[x×*]\s*\d{1,3}\b|\b\d{1,3}\s*(?:cm|cent[ií]metros?)\b/i;

const RETOUCH_PATTERN = /\bret(?:oque|oques|ocar)\b/i;

const PRICE_IN_REPLY_PATTERN =
  /(?:\$\s?\d|\bpesos?\b|\bd[oó]lares?\b|\bars\b|\busd\b|\b\d{1,3}(?:[.,]\d{3})+\b|\b\d+\s?(?:mil|k)\b|\b\d{5,}\b)/i;

const OFF_TOPIC_PATTERN =
  /(?:significado|significa|historia|trasfondo|transfondo|emocional|inspiraci[oó]n)/i;

const REFUSAL_PATTERN =
  /(?:no tengo (?:informaci[oó]n|datos|precios)|no puedo (?:darte|proporcionar|brindar|decirte) (?:un )?(?:precio|presupuesto)|no manejo (?:precios|costos|tarifas)|busc[aá].{0,40}(?:internet|google)|consult[aá].{0,40}(?:otro|otra) (?:profesional|tatuador))/i;

/**
 * Detecta mensajes que ya contienen datos suficientes para pedirle precio al
 * tatuador, o que directamente piden un precio. No alcanza con "quiero
 * cotizar": en ese caso el bot primero debe pedir tamaño, zona y referencia.
 */
export function isQuoteRequestText(body: string): boolean {
  const text = body.trim();
  if (!text) return false;
  return (
    PRICE_PATTERN.test(text) ||
    DIMENSION_PATTERN.test(text) ||
    (RETOUCH_PATTERN.test(text) && DIMENSION_PATTERN.test(text))
  );
}

export function isQuoteRequestMessage(
  message: Pick<NormalizedInboundMessage, 'body' | 'hasMedia'>,
): boolean {
  if (message.hasMedia) return true;
  return isQuoteRequestText(message.body);
}

/**
 * Extrae el código de consulta que el tatuador incluye en su respuesta.
 * Acepta formatos como "#COT-000123", "COT 123" o "cot 123". No confunde
 * "cotización 80000" con un código.
 */
export function parseQuoteCode(body: string): {
  code: string | null;
  text: string;
} {
  const match = /#?\s*\bCOT[\s-]*0*(\d{1,8})\b/i.exec(body);
  if (!match) return { code: null, text: body.trim() };

  const digits = match[1] ?? '';
  const before = body.slice(0, match.index);
  const after = body.slice(match.index + match[0].length);
  const text = `${before} ${after}`
    .replace(/\s+/g, ' ')
    .replace(/^[\s:;,\-–—]+|[\s:;,\-–—]+$/g, '')
    .trim();

  return {
    code: digits ? `COT-${digits.padStart(6, '0')}` : null,
    text,
  };
}

/** Evita que el modelo invente un precio cuando la cotización está pendiente. */
export function replyContainsPrice(reply: string): boolean {
  return PRICE_IN_REPLY_PATTERN.test(reply);
}

/**
 * Un precio enviado por el tatuador puede ser tan corto como `300` o
 * `300.000`. Se exige al menos tres dígitos para no confundirlo con un
 * “ok”, una fecha o un número de teléfono.
 */
export function artistReplyContainsPrice(reply: string): boolean {
  return (
    replyContainsPrice(reply) ||
    /\b\d{3,}(?:[.,]\d{3})*\b/.test(reply) ||
    /\b(?:mil|mill[oó]n|millones)\b/i.test(reply)
  );
}

/** Detecta respuestas que vuelven a preguntar por el significado o la historia. */
export function replyIsOffTopic(reply: string): boolean {
  return OFF_TOPIC_PATTERN.test(reply);
}

/** Detecta las frases prohibidas del ejemplo ("no tengo información..."). */
export function replyIsRefusal(reply: string): boolean {
  return REFUSAL_PATTERN.test(reply);
}
