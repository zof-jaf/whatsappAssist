import type { NormalizedInboundMessage } from './waha.js';

const PRICE_PATTERN =
  /(?:cu[aá]nto\s+(?:sale|vale|cuesta|costar[ií]a|saldr[ií]a|ser[ií]a|es|est[aá]|cobr[aá]s|me\s+cobr[aá]s|cobran|por|me\s+(?:sale|vale|cuesta))\b|(?:qu[eé]|cu[aá]l)\s+(?:es\s+)?(?:el\s+)?(?:precio|costo|valor|tarifa)\b|(?:qu[eé]|cu[aá]l)\s+precio\b|me\s+(?:pas[aá]s|das|dec[ií]s|pod[eé]s\s+(?:decir|pasar))\s+(?:el\s+)?(?:precio|valor|costo|presupuesto)\b|dec[ií]me\s+(?:el\s+)?(?:precio|valor|costo|presupuesto)\b|(?:quiero|necesito|quisiera)\s+(?:saber\s+)?(?:el\s+)?(?:precio|valor|costo|presupuesto)\b|(?:saber|consultar|preguntar)\s+(?:el\s+)?(?:precio|valor|costo|presupuesto)\b|(?:^|\n)\s*(?:precio|presupuesto|costo|valor|tarifa)\s*(?:\?|$)|presupuesto\b|(?:sale|vale|cuesta)\s*\?|(?:sale|vale|cuesta)\s*$|^[\s¿¡]*(?:cu[aá]nto|precio)\s*[?!.]*\s*$)/i;

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
 * Preguntas o comentarios sobre el tatuaje que no son de agenda: descuentos,
 * negociación, pagos, seña, condiciones, cuidados, dolor o cambios de diseño.
 * Todas se derivan al tatuador; el bot no las responde ni las negocia.
 */
const NEGOTIATION_PATTERN =
  /(?:\bdescuent\w*|\brebaj\w*|\bbarat\w*|\becon[oó]mic\w*|\bcar[oa]s?\b|\bnegoci\w*|\bcuot\w*|\babono\w*|\bse[nñ]a\b|\banticipo\b|\bformas?\s+de\s+pago\b|\bpagos?\b|\bpagar\b|\btransferencia\b|\bnequi\b|\bdaviplata\b|\bbancolombia\b|\befectivo\b|\btarjeta\b|\bcondici[oó]n\w*|\bgarant[ií]a\b|\bincluye\b|\bincluyen\b|\bme\s+lo\s+dej[aá]s|\bprecio\s+especial|\b(?:hacer|hacerme|hac[eé]s)\s+(?:un\s+)?precio\b|\b(?:cambiar|modificar|ajustar)\s+(?:el\s+)?(?:dise[nñ]o|tama[nñ]o|color|zona|precio)\b|\bm[aá]s\s+(?:peque[nñ]o|grande)\b)/i;

const QUESTION_CUE_PATTERN =
  /(?:\?|\b(?:cu[aá]nto|cu[aá]ndo|c[oó]mo|d[oó]nde|qu[eé]|cu[aá]l|qui[eé]n|puedo|puedes|pod[eé]s|puede|se\s+puede|hay|ten[eé]s|tienen|incluye|incluyen|sirve|sirven|vale|sale|cuesta|duele|necesito|debo|es\s+posible|se\s+debe|me\s+(?:hac[eé]s|das|dej[aá]s|rebaj[aá]s)|hac[eé]s|aceptan|acept[aá]s|manejan|manej[aá]s|trabajan|trabajas|atienden|abren)\b)/i;

const TATTOO_TOPIC_PATTERN =
  /(?:\btatuaj\w*|\bretoqu\w*|\bdise[nñ]o\b|\baguja\w*|\btinta\b|\bpiel\b|\bcuraci[oó]n\b|\bcicatriz\w*|\bcuid\w*|\bsanar\b|\bsana\b|\bduele\b|\bdolor\w*|\binfecci[oó]n\b|\bcrema\b|\bcolor\w*|\bnegro\b|\bgris\w*|\bsombra\w*|\bl[ií]nea\w*|\btama[nñ]o\b|\bcm\b|\bcent[ií]metro\w*|\bzona\b|\bcuerpo\b|\bbrazo\b|\bantebrazo\b|\bpierna\b|\bespalda\b|\bpecho\b|\bmu[sñ]eca\b|\bmano\b|\bpie\b|\bcuello\b|\bcostilla\w*|\bmuslo\b|\btobillo\b)/i;

const CARE_TOPIC_PATTERN =
  /(?:\bsol\b|\bplaya\b|\bagua\b|\bpiscina\b|\bgimnasio\b|\bejercicio\b|\balcohol\b|\bducha\w*|\bnadar\b|\bcrema\b|\bsanar\b|\bcicatriz\w*|\bcuid\w*|\bduele\b|\bdolor\w*|\binfecci[oó]n\b)/i;

const NEW_DESIGN_PATTERN =
  /\b(?:otro|nuevo|segundo|diferente)\s+tatuaj\w*/i;

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
 * Detecta preguntas o pedidos sobre el tatuaje que no son de agenda y que el
 * tatuador debe responder: descuentos, negociación, pagos, seña, condiciones,
 * cuidados, dolor o cambios de diseño. El bot no las contesta por su cuenta.
 */
export function isTattooQuestionText(body: string): boolean {
  const text = body.trim();
  if (!text) return false;
  if (isQuoteRequestText(text)) return false;
  if (NEGOTIATION_PATTERN.test(text)) return true;
  if (!QUESTION_CUE_PATTERN.test(text)) return false;
  return TATTOO_TOPIC_PATTERN.test(text) || CARE_TOPIC_PATTERN.test(text);
}

/**
 * Verdadero cuando el mensaje trae datos de un tatuaje nuevo (medidas,
 * retoque u otro diseño). Sirve para no crear una cotización duplicada cuando
 * el cliente solo vuelve a hablar del precio ya entregado.
 */
export function hasNewQuoteDetails(body: string): boolean {
  return (
    DIMENSION_PATTERN.test(body) ||
    RETOUCH_PATTERN.test(body) ||
    NEW_DESIGN_PATTERN.test(body)
  );
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
