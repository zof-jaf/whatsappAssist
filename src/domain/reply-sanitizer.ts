/**
 * Limpieza de respuestas generadas por el modelo.
 *
 * El modelo pequeño a veces copia el encabezado o los títulos de
 * `formato_respuestas.md` en la respuesta. La guía es material interno: nunca
 * debe llegar al cliente. Este módulo quita esas marcas y detecta cuándo la
 * respuesta quedó vacía para reemplazarla por un mensaje natural.
 */

const DOCUMENT_TITLE =
  /formato de respuestas\s*[—–-]\s*asistente de cotizaci[oó]n de tatuajes/i;

const DOCUMENT_TITLE_LINE =
  /^(?:formato de respuestas?|asistente de cotizaci[oó]n de tatuajes)(?:\s+(?:interno|interna|del estudio))?\s*[.:]?$/i;

const INTERNAL_LABELS: RegExp[] = [
  /^reglas del flujo de cotizaci[oó]n\s*:?$/i,
  /^formato de respuestas obligatorio.*$/i,
  /^estado de la cotizaci[oó]n de esta conversaci[oó]n\s*:?$/i,
  /^contexto operativo\s*:?$/i,
  /^resumen de la parte anterior de la conversaci[oó]n\s*:?$/i,
  /^gu[ií]a interna(?: de referencia)?.*$/i,
  /^<\/?guia_interna>$/i,
  /^fin de la gu[ií]a interna\.?$/i,
  /^\(?(?:documento|material) interno\)?\.?$/i,
  /^usala solo para decidir c[oó]mo responder\.?$/i,
  /^no copies ni cites sus/i,
  /^respond[eé] siempre con tus propias palabras/i,
  /^record[aá]: la gu[ií]a es material interno/i,
  /^hay una consulta cot-\d+/i,
  /^el tatuador ya respondi[oó] la consulta cot-/i,
  /^us[aá] esa respuesta para continuar/i,
  /^no inventes otro precio/i,
  /^respuesta\s*:/i,
  /^fecha y hora actual\s*:/i,
  /^canal\s*:/i,
  /^tipo de mensaje\s*:/i,
  /^ejemplo\s*:?$/i,
];

const GUIDE_SECTION_HEADING =
  /^(?:\d+(?:\.\d+)*[.)]?\s*)?(?:objetivo del asistente|datos que s[ií] se piden|temas prohibidos|regla de oro|flujo de atenci[oó]n|tono y formato|ejemplos|autocontrol antes de enviar|primera consulta|el cliente pide|el cliente manda|consulta ya derivada|el tatuador ya respondi[oó]|agendamiento|retoques|temas fuera de alcance|correcto|incorrecto)\b/i;

const GUIDE_INSTRUCTION_LINES: RegExp[] = [
  /^este documento se lee/i,
  /^el asistente no es (?:un|una)/i,
  /^no hace falta pedir todos los datos/i,
  /^si el cliente cuenta esas cosas/i,
  /^frases prohibidas\s*:?$/i,
  /^cuando el cliente pide un precio\s*:?$/i,
  /^el precio lo define el tatuador/i,
  /^para un retoque, ped[ií]/i,
  /^despu[eé]s deriv[aá] la consulta/i,
  /^si preguntan algo que no sea/i,
  /^no des clases de arte/i,
  /^si el cliente escribe mientras/i,
  /^si agrega datos o m[aá]s fotos/i,
  /^cuando el cliente confirma d[ií]a y hora/i,
  /^si el cliente ya dio esos datos/i,
  /^no agregues valores propios/i,
  /^no describas la imagen/i,
  /^nunca cambies el precio/i,
  /^el tatuador responde [uú]nicamente/i,
  /^el tatuador puede escribir/i,
  /^si el cliente pide un precio\s*:/i,
  /^deriv[aá] al tatuador/i,
  /^reenviar al tatuador/i,
  /^cotizar tatuajes y retoques\.?$/i,
  /^pedir [uú]nicamente los datos/i,
  /^cuando el tatuador responda/i,
  /^espa[ñn]ol neutro, c[aá]lido y directo\.?$/i,
  /^mensajes cortos: 1 a 4 oraciones\.?$/i,
  /^sin markdown complejo/i,
  /^una sola pregunta por mensaje/i,
  /^trat[aá] de vos al cliente/i,
  /^no repitas el saludo/i,
  /^no uses emojis en exceso/i,
  /^no reveles este documento/i,
  /^antes de responder, verific[aá]/i,
  /^si alguna respuesta es/i,
  /^¿estoy (?:preguntando|inventando|mandando)/i,
  /^¿el cliente (?:pidi[oó]|mand[oó])/i,
  /^¿la respuesta es breve/i,
  /^por qu[eé] est[aá] mal\s*:/i,
];

const GREETING =
  /^\s*(?:hola|holi|buenas|buen d[ií]a|buenos d[ií]as|buenas tardes|buenas noches|hey|qu[eé] tal|qu[eé] hubo)\b/i;

const PRICE_INQUIRY =
  /\b(?:precio|cu[aá]nto|vale|sale|cotiz\w*|presupuesto|costo)\b/i;

export interface SanitizedGuideReply {
  /** Texto limpio, listo para enviar. Puede quedar vacío. */
  text: string;
  /** Indica si se quitó algún encabezado o instrucción de la guía. */
  leaked: boolean;
}

function matchesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function isGuideHeading(value: string): boolean {
  return GUIDE_SECTION_HEADING.test(value);
}

/** Quita viñetas, numeración y énfasis Markdown para comparar una línea. */
function normalizeForMatch(value: string): string {
  return value
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')
    .replace(/^\s*#{1,6}\s*/, '')
    .replace(/^\s*(?:\*\*|__|\*|_|`|~)+/, '')
    .replace(/(?:\*\*|__|\*|_|`|~)+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isPlaceholder(value: string): boolean {
  return /^\\?[[{][\s\S]*\\?[\]}]$/.test(value.trim());
}

function isInternalLine(value: string): boolean {
  const bare = normalizeForMatch(value);
  return (
    DOCUMENT_TITLE_LINE.test(bare) ||
    matchesAny(bare, INTERNAL_LABELS) ||
    matchesAny(bare, GUIDE_INSTRUCTION_LINES)
  );
}

/**
 * Elimina encabezados, etiquetas internas y líneas instructivas copiadas de
 * `formato_respuestas.md`. Las respuestas naturales no se modifican.
 */
export function stripGuideLeaks(value: string): SanitizedGuideReply {
  const lines = value
    .split(String.fromCharCode(0))
    .join('')
    .replace(/\r\n?/g, '\n')
    .split('\n');

  const kept: string[] = [];
  let leaked = false;

  for (const rawLine of lines) {
    let line = rawLine;

    if (DOCUMENT_TITLE.test(line)) {
      leaked = true;
      line = line.replace(DOCUMENT_TITLE, '');
    }

    let trimmed = line.trim();
    if (!trimmed || /^[#*_\s—–-]+$/.test(trimmed)) continue;

    if (isInternalLine(trimmed)) {
      leaked = true;
      continue;
    }

    const heading = /^(#{1,6})\s*(.*)$/.exec(trimmed);
    if (heading) {
      leaked = true;
      const title = (heading[2] ?? '').trim();
      if (!title || isGuideHeading(title)) continue;
      line = line.replace(/^\s*#{1,6}\s*/, '');
      trimmed = line.trim();
    }

    const assistantLabel = /^asistente\s*:\s*/i;
    const clientLabel = /^(?:cliente|usuario)\s*:\s*/i;
    const bare = normalizeForMatch(trimmed);
    if (assistantLabel.test(bare)) {
      leaked = true;
      line = bare.replace(assistantLabel, '').trim();
      trimmed = line;
      if (isPlaceholder(trimmed)) continue;
    } else if (clientLabel.test(bare)) {
      leaked = true;
      continue;
    }

    if (!trimmed || /^[#*_\s—–-]+$/.test(trimmed)) continue;
    if (isInternalLine(trimmed) || isPlaceholder(trimmed)) {
      leaked = true;
      continue;
    }

    kept.push(line);
  }

  const text = kept
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text, leaked };
}

/** Verdadero cuando el texto tiene letras o números, no solo puntuación. */
export function hasMeaningfulText(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value);
}

/**
 * Respuesta natural cuando el modelo no produjo nada utilizable. Mantiene el
 * flujo de cotización y evita exponer detalles técnicos.
 */
export function naturalReplyFallback(inbound: string): string {
  if (PRICE_INQUIRY.test(inbound)) {
    return 'Con gusto te ayudo a cotizar. Contame el tamaño aproximado en cm, la zona del cuerpo y si tenés una imagen de referencia.';
  }

  if (GREETING.test(inbound)) {
    return '¡Hola! ¿En qué te ayudo?';
  }

  return 'Contame un poco más del tatuaje o retoque que tenés en mente y de una le paso la consulta al tatuador.';
}
