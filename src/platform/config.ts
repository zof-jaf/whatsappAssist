import { z } from 'zod';

/**
 * Configuración de la plataforma multiusuario.
 *
 * TODAS las credenciales y URLs viven en variables de entorno (.env en local,
 * "Environment Variables" en el proveedor de despliegue). Nunca se hardcodean.
 * Esta configuración es distinta a la del bot legado (src/config.ts): el bot
 * legado usa SQLite, la plataforma usa PostgreSQL (Neon).
 */

const boolFromEnv = (defaultValue: boolean) =>
  z.preprocess((value) => {
    if (value === undefined || value === null || value === '') return defaultValue;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const v = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'si', 'sí', 'on'].includes(v)) return true;
      if (['false', '0', 'no', 'off'].includes(v)) return false;
    }
    return value;
  }, z.boolean());

const optionalString = z
  .string()
  .optional()
  .transform((v) => {
    const t = v?.trim();
    return t ? t : undefined;
  });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),

  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  TRUST_PROXY: boolFromEnv(true),
  APP_BASE_URL: z.string().url().default('http://localhost:4000'),

  // Neon PostgreSQL. La cadena completa (sslmode=require&channel_binding=require)
  // se entrega desde el entorno, jamás en el código fuente.
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL es obligatoria (cadena de conexión a Neon PostgreSQL)'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15_000),
  /** Permite arrancar aunque la BD no responda (útil para correr migrate). */
  DB_SSL: boolFromEnv(true),

  // WAHA global: el token de administrador se usa para crear/borrar sesiones y
  // pedir el QR. Cada bot además tiene su propia API key guardada en la BD.
  WAHA_BASE_URL: z.string().url().default('http://localhost:3000'),
  WAHA_ADMIN_API_KEY: optionalString,
  WAHA_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15000),

  // Webhooks entrantes: la plataforma recibe eventos de TODAS las sesiones y
  // los enruta al motor del bot dueño de esa sesión (arquitectura A).
  PLATFORM_WEBHOOK_HMAC_KEY: optionalString,
  PLATFORM_BASE_URL: z.string().url().default('http://localhost:4000'),
  ENGINE_DATA_DIR: z.string().default('./data/bots'),
  ENGINE_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(500),

  // El bot legado (single-user) sigue vivo: sus eventos se reenvían a su
  // propio /webhook para no romper el despliegue existente.
  LEGACY_SESSION_NAME: z.string().default('default'),
  LEGACY_WEBHOOK_URL: optionalString,

  // Secreto para hacer hash de los tokens de sesión (pepper). No es la contraseña
  // del usuario ni la API key de WAHA.
  SESSION_SECRET: z.string().min(16, 'SESSION_SECRET debe tener al menos 16 caracteres'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(168),
  COOKIE_SECURE: boolFromEnv(false),
  COOKIE_DOMAIN: optionalString,
  COOKIE_NAME: z.string().min(1).default('wabm_session'),

  // Cuenta administradora sembrada en el primer arranque.
  ADMIN_EMAIL: z.string().email().default('admin@example.com'),
  ADMIN_PASSWORD: z.string().min(12, 'ADMIN_PASSWORD debe tener al menos 12 caracteres'),
  ADMIN_FULL_NAME: z.string().min(1).default('Administrador'),

  // Registro cerrado por defecto: solo el administrador crea usuarios.
  ALLOW_PUBLIC_REGISTRATION: boolFromEnv(false),

  // Prefijo visible de las API keys por proyecto.
  API_KEY_PREFIX: z.string().min(3).default('wbp'),

  // Retención de eventos de uso (reportes). 0 desactiva la limpieza.
  USAGE_EVENT_RETENTION_DAYS: z.coerce.number().int().min(0).default(90),

  BODY_LIMIT: z.string().default('256kb'),
});

export type PlatformConfig = z.infer<typeof envSchema> & {
  isProduction: boolean;
};

export function loadPlatformConfig(
  env: NodeJS.ProcessEnv = process.env,
): PlatformConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'env'}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuración de plataforma inválida:\n${details}`);
  }
  return {
    ...parsed.data,
    isProduction: parsed.data.NODE_ENV === 'production',
  };
}
