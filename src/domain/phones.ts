import { phoneFromJid } from '../utils/text.js';

/** Colombia es el país por defecto para el chat del tatuador. */
export const TATTOO_COUNTRY_CODE = '57';

export interface NormalizedPhone {
  /** Dígitos locales, sin código de país. */
  phone: string;
  /** Chat ID que espera WAHA. */
  chatId: string;
  /** Formato legible: +57 300 123 4567. */
  display: string;
}

/**
 * Normaliza un número colombiano escrito con o sin código de país.
 *
 * Acepta `3001234567`, `+57 300 123 4567`, `573001234567` o
 * `0057 300 123 4567`. Devuelve `null` si no quedan exactamente 10 dígitos
 * locales, que es el formato de los números colombianos.
 */
export function normalizeColombianPhone(
  value: string | null | undefined,
): NormalizedPhone | null {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return null;

  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 12 && digits.startsWith(TATTOO_COUNTRY_CODE)) {
    digits = digits.slice(TATTOO_COUNTRY_CODE.length);
  }
  if (digits.length !== 10) return null;

  return {
    phone: digits,
    chatId: `${TATTOO_COUNTRY_CODE}${digits}@c.us`,
    display: `+${TATTOO_COUNTRY_CODE} ${digits.slice(0, 3)} ${digits.slice(
      3,
      6,
    )} ${digits.slice(6)}`,
  };
}

/** Extrae los 10 dígitos locales de un chat ID configurado por .env. */
export function phoneFromArtistChatId(
  chatId: string | null | undefined,
): string | null {
  const digits = digitsFromChatId(chatId);

  if (!digits) return null;
  if (digits.length === 12 && digits.startsWith(TATTOO_COUNTRY_CODE)) {
    return digits.slice(TATTOO_COUNTRY_CODE.length);
  }
  return digits.length === 10 ? digits : null;
}

/** Dígitos de un JID de teléfono (`@c.us` o `@s.whatsapp.net`). */
export function digitsFromChatId(
  value: string | null | undefined,
): string | null {
  const fromJid = phoneFromJid(value);
  if (fromJid) return fromJid;

  // Un chat sin sufijo también puede ser un número configurado a mano.
  const raw = String(value ?? '').trim();
  if (!raw || raw.includes('@')) return null;
  return raw.replace(/\D/g, '') || null;
}

function canonicalPhone(
  digits: string | null,
): { full: string; local: string | null } | null {
  if (!digits) return null;

  if (digits.length === 12 && digits.startsWith(TATTOO_COUNTRY_CODE)) {
    return { full: digits, local: digits.slice(TATTOO_COUNTRY_CODE.length) };
  }
  if (digits.length === 10) {
    return { full: `${TATTOO_COUNTRY_CODE}${digits}`, local: digits };
  }
  return { full: digits, local: null };
}

/**
 * Compara dos teléfonos aunque uno venga como `573001234567`, otro como
 * `3001234567` y otro como JID. No compara LIDs: esos IDs no son teléfonos.
 */
export function sameWhatsAppPhone(
  first: string | null | undefined,
  second: string | null | undefined,
): boolean {
  const a = canonicalPhone(digitsFromChatId(first));
  const b = canonicalPhone(digitsFromChatId(second));
  if (!a || !b) return false;

  if (a.full === b.full) return true;
  return Boolean(a.local && b.local && a.local === b.local);
}

/**
 * Reconoce el chat del tatuador aunque WAHA lo entregue como `@lid`.
 *
 * El JID `@lid` no contiene el teléfono, pero WAHA adjunta el alias real en
 * `_data.key.remoteJidAlt`; ese alias se expone como `phoneJid`.
 */
export function isArtistChatIdentity(
  artistChatId: string | null | undefined,
  chatId: string | null | undefined,
  phoneJid?: string | null,
): boolean {
  const artist = String(artistChatId ?? '').trim();
  if (!artist) return false;

  if (chatId && chatId.toLowerCase() === artist.toLowerCase()) return true;

  const artistDigits = digitsFromChatId(artist);
  if (!artistDigits) return false;

  return (
    sameWhatsAppPhone(artistDigits, chatId) ||
    sameWhatsAppPhone(artistDigits, phoneJid)
  );
}
