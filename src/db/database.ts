import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wa_id TEXT NOT NULL UNIQUE,
    phone TEXT,
    push_name TEXT,
    display_name TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_contacts_phone ON contacts(phone);
  CREATE INDEX idx_contacts_last_seen ON contacts(last_seen_at DESC);

  CREATE TABLE conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER NOT NULL UNIQUE REFERENCES contacts(id) ON DELETE CASCADE,
    ai_enabled INTEGER NOT NULL DEFAULT 1 CHECK (ai_enabled IN (0, 1)),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    context_start_message_id INTEGER,
    last_inbound_at TEXT,
    last_outbound_at TEXT,
    last_message_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_conversations_last_message ON conversations(last_message_at DESC);
  CREATE INDEX idx_conversations_status ON conversations(status);

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    wa_message_id TEXT UNIQUE,
    direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'media', 'command', 'system', 'error')),
    body TEXT NOT NULL DEFAULT '',
    media_url TEXT,
    media_mime TEXT,
    media_filename TEXT,
    status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'queued', 'sent', 'delivered', 'read', 'failed', 'skipped')),
    error TEXT,
    model TEXT,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    latency_ms INTEGER,
    reply_to_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    wa_timestamp TEXT,
    sent_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_messages_conversation ON messages(conversation_id, id);
  CREATE INDEX idx_messages_created ON messages(created_at);
  CREATE INDEX idx_messages_direction ON messages(conversation_id, direction, id);
  CREATE INDEX idx_messages_reply_to ON messages(reply_to_message_id);

  CREATE TABLE conversation_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    summary TEXT NOT NULL,
    through_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    messages_covered INTEGER NOT NULL,
    model TEXT,
    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_summaries_conversation
    ON conversation_summaries(conversation_id, is_active, id DESC);

  CREATE TABLE inbound_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wa_message_id TEXT NOT NULL UNIQUE,
    chat_id TEXT NOT NULL,
    event_id TEXT,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    next_attempt_at TEXT NOT NULL,
    locked_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_jobs_claim ON inbound_jobs(status, next_attempt_at, id);
  CREATE INDEX idx_jobs_chat ON inbound_jobs(chat_id, id);

  CREATE TABLE webhook_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT,
    event TEXT NOT NULL,
    session TEXT,
    status TEXT NOT NULL CHECK (status IN ('queued', 'processed', 'ignored', 'duplicate', 'error')),
    reason TEXT,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_webhook_events_created ON webhook_events(created_at DESC);
  CREATE INDEX idx_webhook_events_event_id ON webhook_events(event_id);

  CREATE TABLE app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE quote_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    inbound_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    request_body TEXT NOT NULL DEFAULT '',
    request_media_url TEXT,
    request_media_mime TEXT,
    request_media_filename TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'answered', 'delivered', 'cancelled', 'expired')),
    artist_reply TEXT,
    artist_inbound_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    client_outbound_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    artist_notification_message_id TEXT,
    answered_at TEXT,
    delivered_at TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_quote_requests_conversation
    ON quote_requests(conversation_id, id DESC);
  CREATE INDEX idx_quote_requests_status
    ON quote_requests(status, expires_at);
  `,
  `
  ALTER TABLE quote_requests ADD COLUMN appointment_at TEXT;
  ALTER TABLE quote_requests ADD COLUMN notion_page_id TEXT;
  ALTER TABLE quote_requests ADD COLUMN notion_page_url TEXT;
  `,
  `
  ALTER TABLE quote_requests ADD COLUMN kind TEXT NOT NULL DEFAULT 'quote'
    CHECK (kind IN ('quote', 'question'));
  CREATE INDEX idx_quote_requests_kind
    ON quote_requests(kind, status);
  `,
  `
  -- Usuarios del panel con contraseña cifrada (scrypt) y sesiones.
  CREATE TABLE admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    full_name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    last_login_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE admin_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_admin_sessions_hash ON admin_sessions(token_hash);
  CREATE INDEX idx_admin_sessions_user ON admin_sessions(user_id);

  -- Equipo del estudio.
  CREATE TABLE artists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    specialty TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    bio TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- Catálogo de tatuajes flash.
  CREATE TABLE flash_tattoos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'clasico',
    price INTEGER NOT NULL DEFAULT 0,
    size TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    image_url TEXT,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_flash_tattoos_category ON flash_tattoos(category);

  -- Agenda unificada: las cotizaciones son registros con status 'cotizacion'.
  CREATE TABLE appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    client TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    design TEXT NOT NULL DEFAULT '',
    zone TEXT NOT NULL DEFAULT '',
    artist TEXT NOT NULL DEFAULT '',
    at TEXT NOT NULL,
    price INTEGER NOT NULL DEFAULT 0,
    deposit INTEGER NOT NULL DEFAULT 0,
    paid INTEGER NOT NULL DEFAULT 0 CHECK (paid IN (0, 1)),
    status TEXT NOT NULL DEFAULT 'cotizacion'
      CHECK (status IN ('cotizacion', 'pendiente', 'confirmada', 'completada', 'cancelada')),
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_appointments_at ON appointments(at);
  CREATE INDEX idx_appointments_status ON appointments(status);
  `,
];

export interface OpenDatabaseOptions {
  readonly?: boolean;
}

export function openDatabase(path: string, options: OpenDatabaseOptions = {}): Db {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path, { readonly: options.readonly ?? false });
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('wal_autocheckpoint = 1000');

  if (path !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }

  if (!options.readonly) {
    migrate(db);
  }

  return db;
}

export function migrate(db: Db): void {
  const currentVersion = db.pragma('user_version', { simple: true }) as number;
  const pending = MIGRATIONS.slice(currentVersion);

  for (let index = 0; index < pending.length; index += 1) {
    const version = currentVersion + index + 1;
    const sql = pending[index];
    if (!sql) continue;

    const apply = db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version}`);
    });
    apply();
  }
}

export function closeDatabase(db: Db): void {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // La base puede estar en modo solo lectura o en memoria; cerrar igualmente.
  }
  db.close();
}
