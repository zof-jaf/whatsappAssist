/** Recorta por puntos de código para no partir emojis. */
export function truncate(text: string, maxChars: number, suffix = '…'): string {
  if (maxChars <= 0) return '';
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return chars.slice(0, Math.max(0, maxChars - suffix.length)).join('') + suffix;
}

export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor((maxChars - 1) / 2);
  return `${text.slice(0, half)}…${text.slice(-half)}`;
}

export function phoneFromWaId(waId: string): string | null {
  if (!waId.endsWith('@c.us')) return null;
  const digits = waId.slice(0, -'@c.us'.length).replace(/\D/g, '');
  return digits || null;
}

/**
 * Extrae el teléfono de un JID de WhatsApp. WAHA usa `@c.us` para chats
 * tradicionales y `@s.whatsapp.net` para el alias de teléfono de un `@lid`.
 */
export function phoneFromJid(value: string | null | undefined): string | null {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();
  if (!lower.endsWith('@c.us') && !lower.endsWith('@s.whatsapp.net')) {
    return null;
  }

  const digits = trimmed.slice(0, trimmed.lastIndexOf('@')).replace(/\D/g, '');
  return digits || null;
}

export function isGroupId(waId: string): boolean {
  return waId.endsWith('@g.us');
}

export function isBroadcastId(waId: string): boolean {
  return (
    waId === 'status@broadcast' ||
    waId.endsWith('@broadcast') ||
    waId.endsWith('@newsletter')
  );
}

export function normalizeChatId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.includes('@')) return trimmed.toLowerCase();
  const digits = trimmed.replace(/\D/g, '');
  return digits ? `${digits}@c.us` : '';
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function sanitizeReply(value: string): string {
  return value
    .split(String.fromCharCode(0))
    .join('')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

export function preview(value: string, maxChars = 120): string {
  const singleLine = collapseWhitespace(value);
  return truncate(singleLine, maxChars);
}

export function splitCommaList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
