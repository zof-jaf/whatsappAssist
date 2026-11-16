import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import type { PlatformConfig } from './config.js';

export type DbPool = Pool;

/**
 * Pool de PostgreSQL (Neon). El modo pooler de Neon usa SSL; la cadena de
 * conexión completa viene de DATABASE_URL (ver .env.example).
 */
export function createPool(config: PlatformConfig): Pool {
  return new Pool({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_MAX,
    ssl: config.DB_SSL ? { rejectUnauthorized: true } : undefined,
    connectionTimeoutMillis: config.DB_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: 30_000,
    allowExitOnIdle: false,
  });
}

/** Helper tipado para consultas. */
export async function query<T extends QueryResultRow>(
  pool: Pool | PoolClient,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await pool.query<T>(text, params);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow>(
  pool: Pool | PoolClient,
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(pool, text, params);
  return rows[0] ?? null;
}

/**
 * Migraciones idempotentes. Se ejecutan al arrancar. En producción se recomienda
 * usar un paso de migrate explícito (npm run platform:migrate) antes de escalar,
 * pero correrlas aquí hace el despliegue "plug and play".
 */
const MIGRATIONS: string[] = [
  `
  CREATE EXTENSION IF NOT EXISTS "pgcrypto";

  CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    full_name TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    can_create_bots BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ
  );

  CREATE TABLE IF NOT EXISTS bots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT 'Mi bot',
    waha_session TEXT NOT NULL UNIQUE,
    api_key_hash TEXT NOT NULL,
    api_key_preview TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    connection_status TEXT NOT NULL DEFAULT 'not_started'
      CHECK (connection_status IN ('not_started','scan_qr','connecting','working','failed')),
    phone_number TEXT,
    last_connected_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS user_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    ip_address TEXT,
    user_agent TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions(expires_at);

  CREATE TABLE IF NOT EXISTS usage_events (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bot_id UUID REFERENCES bots(id) ON DELETE SET NULL,
    type TEXT NOT NULL,
    meta JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_usage_events_user_created ON usage_events(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_usage_events_type ON usage_events(type, created_at DESC);
  `,
  // El motor por bot necesita la key en claro (cifrada en reposo) para
  // autenticarse contra /api/ingest/events. El hash sigue siendo la credencial.
  `ALTER TABLE bots ADD COLUMN IF NOT EXISTS api_key_encrypted TEXT;`,
];

export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const statement of MIGRATIONS) {
      await client.query(statement);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function ping(pool: Pool): Promise<boolean> {
  try {
    const rows = await query<{ ok: number }>(pool, 'SELECT 1 AS ok');
    return rows[0]?.ok === 1;
  } catch {
    return false;
  }
}
