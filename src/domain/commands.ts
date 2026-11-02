export type BotCommand = 'reset' | 'help' | 'status';

const COMMANDS: Record<string, BotCommand> = {
  '/reset': 'reset',
  '/reiniciar': 'reset',
  '/nuevo': 'reset',
  '/help': 'help',
  '/ayuda': 'help',
  '/start': 'help',
  '/comandos': 'help',
  '/status': 'status',
  '/estado': 'status',
};

export function matchCommand(body: string): BotCommand | undefined {
  const trimmed = body.trim().toLowerCase();
  if (!trimmed.startsWith('/')) return undefined;
  const [firstWord] = trimmed.split(/\s+/);
  if (!firstWord) return undefined;
  return COMMANDS[firstWord];
}

export function helpText(botName: string): string {
  return [
    `Soy ${botName}. Podés escribirme lo que quieras y te respondo con IA local.`,
    '',
    'Comandos disponibles:',
    '• /ayuda — muestra esta ayuda',
    '• /reset — borra el contexto de la conversación (el historial queda guardado)',
    '• /estado — muestra el modelo y el estado del contexto',
    '',
    'Por privacidad, las conversaciones se guardan en una base SQLite local.',
  ].join('\n');
}

export function resetText(): string {
  return 'Listo. Empecé un contexto nuevo para esta conversación. El historial anterior queda guardado, pero ya no se envía a la IA.';
}
