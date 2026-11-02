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
): string {
  const now = formatDateTime(new Date(), config.bot.timeZone);
  const parts = [
    config.bot.systemPrompt,
    '',
    `Contexto operativo:`,
    `- Tu nombre es ${config.bot.name}.`,
    `- Fecha y hora actual: ${now} (${config.bot.timeZone}).`,
    `- Canal: WhatsApp. Respondé en texto plano, sin tablas ni bloques de código extensos.`,
    `- No tenés acceso a internet ni a herramientas externas: no prometas acciones que no podés ejecutar.`,
  ];

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
      { role: 'system', content: buildSystemPrompt(config, summary) },
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
