import type { MessageRow } from '../db/types.js';
import type { AppConfig } from '../config.js';
import { formatDateTime } from '../utils/time.js';
import { truncate } from '../utils/text.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface BuiltPrompt {
  messages: ChatMessage[];
  includedMessages: number;
  truncated: boolean;
}

export interface PromptExtras {
  /** Contenido de formato_respuestas.md, ya recortado. */
  responseGuide?: string | null;
  /** Estado de la consulta de cotización de esta conversación. */
  quoteNote?: string | null;
}

/**
 * Prepara la guía para el prompt: quita el título del documento y convierte
 * los encabezados Markdown en etiquetas entre corchetes. Así el modelo no ve
 * el `#` que después tiende a copiar en la respuesta.
 */
export function prepareResponseGuide(raw: string): string {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const result: string[] = [];
  let skippingIntro = false;

  for (const line of lines) {
    // El párrafo inicial describe el documento, no la atención. Lo omitimos
    // para que el modelo no lo repita como si fuera una respuesta.
    if (!skippingIntro && /^este documento se lee/i.test(line.trim())) {
      skippingIntro = true;
      continue;
    }
    if (skippingIntro) {
      if (!line.trim()) skippingIntro = false;
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (!heading) {
      result.push(line);
      continue;
    }

    const level = (heading[1] ?? '').length;
    const title = (heading[2] ?? '').trim();
    if (!title) continue;

    // El título del documento es el que más se filtra; no lo pasamos.
    if (level === 1 && /formato de respuestas|asistente de cotizaci[oó]n/i.test(title)) {
      continue;
    }

    result.push(`[${title.replace(/^\d+(?:\.\d+)*[.)]?\s*/, '')}]`);
  }

  return result.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function messageContent(message: MessageRow, maxChars: number): string {
  const body = message.body.trim();
  let content = body;

  if (message.kind === 'media') {
    const label = message.media_mime
      ? `[Archivo adjunto: ${message.media_mime}]`
      : '[Archivo adjunto]';
    content = body ? `${label}\n${body}` : label;
  }

  return truncate(content, maxChars);
}

export function buildSystemPrompt(
  config: AppConfig,
  summary?: string | null,
  extras: PromptExtras = {},
): string {
  const now = formatDateTime(new Date(), config.bot.timeZone);
  const parts = [
    config.bot.systemPrompt,
    '',
    'Reglas del flujo de cotización:',
    '- Solo atendés consultas de tatuajes o retoques. No preguntes por el significado, la historia ni el trasfondo emocional del diseño.',
    '- Para cotizar pedí únicamente datos concretos: tamaño aproximado en cm, zona del cuerpo, imagen o referencia del diseño, color o negro, si es un retoque y disponibilidad.',
    `- El precio y los tiempos los define ${config.tattoo.artistName}. Nunca inventes ni estimes un precio por tu cuenta.`,
    '- Si el cliente pide un precio, el sistema deriva la consulta al tatuador automáticamente. Decile que ya la estás consultando y que le vas a responder cuando te confirme.',
    '- Nunca respondas que no tenés información sobre costos ni mandes al cliente a buscar precios en internet o a consultar a otro profesional.',
    '- Cuando el tatuador ya respondió, continuá con el agendamiento: día, horario y seña si corresponde. No vuelvas a cotizar.',
    '',
    `Contexto operativo:`,
    `- Tu nombre es ${config.bot.name}.`,
    `- Fecha y hora actual: ${now} (${config.bot.timeZone}).`,
    `- Canal: WhatsApp. Respondé en texto plano, sin tablas ni bloques de código extensos.`,
    `- No tenés acceso a internet ni a herramientas externas: no prometas acciones que no podés ejecutar.`,
    '- Escribí como una conversación natural de WhatsApp: sin títulos, sin numeración, sin viñetas y sin copiar fragmentos de la guía interna.',
  ];

  if (extras.responseGuide?.trim()) {
    parts.push(
      '',
      'Guía interna de referencia (no es un mensaje para el cliente):',
      '- Usala solo para decidir cómo responder.',
      '- No copies ni cites sus títulos, listas, ejemplos, viñetas ni instrucciones.',
      '- Respondé siempre con tus propias palabras, como una charla natural.',
      '<guia_interna>',
      prepareResponseGuide(extras.responseGuide),
      '</guia_interna>',
      '',
      'Recordá: la guía es material interno. Tu respuesta no debe contener títulos, numeración, viñetas ni fragmentos copiados de la guía.',
    );
  }

  if (extras.quoteNote?.trim()) {
    parts.push(
      '',
      'Estado de la cotización de esta conversación:',
      extras.quoteNote.trim(),
    );
  }

  if (summary && summary.trim()) {
    parts.push(
      '',
      'Resumen de la parte anterior de la conversación:',
      truncate(summary.trim(), 4000),
    );
  }

  return parts.join('\n');
}

/**
 * Arma el contexto enviado a Ollama:
 * - toma los últimos N mensajes;
 * - respeta un presupuesto de caracteres;
 * - evita que el historial empiece con una respuesta del asistente.
 */
export function buildPrompt(
  config: AppConfig,
  allMessages: MessageRow[],
  summary?: string | null,
  extras: PromptExtras = {},
): BuiltPrompt {
  const usable = allMessages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-config.bot.historyMaxMessages);

  const selected: MessageRow[] = [];
  let totalChars = 0;
  let truncated = false;

  for (let index = usable.length - 1; index >= 0; index -= 1) {
    const message = usable[index];
    if (!message) continue;
    const content = messageContent(message, config.bot.promptMaxMessageChars);
    const estimated = content.length + 16;

    if (selected.length > 0 && totalChars + estimated > config.bot.historyMaxChars) {
      truncated = true;
      break;
    }

    selected.push(message);
    totalChars += estimated;
  }

  if (selected.length === 0 && usable.length > 0) {
    const last = usable[usable.length - 1];
    if (last) selected.push(last);
  }

  selected.reverse();

  while (selected.length > 0 && selected[0]?.role === 'assistant') {
    selected.shift();
    truncated = true;
  }

  const history: ChatMessage[] = selected.map((message) => ({
    role: message.role === 'user' ? 'user' : 'assistant',
    content: messageContent(message, config.bot.promptMaxMessageChars),
  }));

  return {
    messages: [
      { role: 'system', content: buildSystemPrompt(config, summary, extras) },
      ...history,
    ],
    includedMessages: history.length,
    truncated: truncated || usable.length < allMessages.length,
  };
}

export interface SummaryPromptInput {
  previousSummary?: string | null;
  messages: MessageRow[];
  maxInputChars: number;
  botName: string;
}

export function buildSummaryMessages(input: SummaryPromptInput): ChatMessage[] {
  const lines: string[] = [];

  for (const message of input.messages) {
    const label = message.role === 'user' ? 'Usuario' : 'Asistente';
    const content = messageContent(message, 2000).replace(/\n/g, ' ');
    if (content.trim()) lines.push(`${label}: ${content}`);
  }

  let transcript = lines.join('\n');
  if (transcript.length > input.maxInputChars) {
    transcript = `[...inicio del fragmento omitido...]\n${transcript.slice(
      -input.maxInputChars,
    )}`;
  }

  const system = [
    `Sos un asistente que resume conversaciones de WhatsApp para ${input.botName}.`,
    'Extraé únicamente hechos, preferencias, decisiones, datos útiles y tareas pendientes.',
    'No inventes información. No incluyas saludos, opiniones ni instrucciones.',
    'Escribí en español, en tercera persona y en un solo párrafo de como máximo 250 palabras.',
  ].join(' ');

  const userParts = [
    input.previousSummary?.trim()
      ? `Resumen previo:\n${input.previousSummary.trim()}`
      : 'No hay resumen previo.',
    '',
    'Conversación a resumir:',
    transcript || '(sin mensajes)',
  ];

  return [
    { role: 'system', content: system },
    { role: 'user', content: userParts.join('\n') },
  ];
}
