import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;

/**
 * Hash de contraseña con scrypt. Formato: scrypt$N$r$p$saltHex$hashHex
 * scrypt es resistente a GPU/ASIC y ya viene con Node (sin dependencias extra).
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('hex'),
    derived.toString('hex'),
  ].join('$');
}

/** Verificación en tiempo constante. Devuelve false si el formato es inválido. */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  try {
    const [scheme, n, r, p, saltHex, hashHex] = stored.split('$');
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;

    const expected = Buffer.from(hashHex, 'hex');
    const actual = await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });

    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/** Token opaco de sesión: 32 bytes aleatorios en hexadecimal. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('hex');
}

/** Hash de un token de sesión con pepper para no guardar el token en claro. */
export function hashSessionToken(token: string, secret: string): string {
  return createHash('sha256').update(`${secret}:${token}`).digest('hex');
}

/** Comparación genérica en tiempo constante para tokens/API keys. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * API key por proyecto. Formato: <prefijo>_<24 bytes en base64url>.
 * Se devuelve en claro solo al crearla; en la BD se guarda el hash y un preview.
 */
export function generateApiKey(prefix: string): {
  key: string;
  hash: string;
  preview: string;
} {
  const random = randomBytes(24).toString('base64url');
  const key = `${prefix}_${random}`;
  const hash = createHash('sha256').update(key).digest('hex');
  const preview = `${prefix}_${random.slice(0, 4)}…${random.slice(-4)}`;
  return { key, hash, preview };
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Nombre de sesión WAHA seguro y determinista a partir del id del bot. */
export function sessionNameFor(botId: string): string {
  return `bot_${botId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40)}`;
}

/** Clave simétrica derivada del pepper de sesiones (nunca se persiste). */
function encryptionKey(secret: string): Buffer {
  return createHash('sha256').update(`enc:${secret}`).digest();
}

/**
 * Cifra un secreto en reposo (AES-256-GCM). Se usa para guardar la API key
 * en claro *cifrada*: el worker la necesita para autenticarse contra
 * /api/ingest/events, pero el hash sigue siendo la credencial de autenticación.
 */
export function encryptSecret(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

/** Descifra un secreto previamente guardado con encryptSecret. */
export function decryptSecret(stored: string, secret: string): string | null {
  try {
    const [version, ivPart, tagPart, dataPart] = stored.split('.');
    if (version !== 'v1' || !ivPart || !tagPart || !dataPart) return null;
    const decipher = createDecipheriv(
      'aes-256-gcm',
      encryptionKey(secret),
      Buffer.from(ivPart, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}
