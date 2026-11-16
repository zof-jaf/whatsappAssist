import type { DbPool } from './db.js';
import { query, queryOne } from './db.js';

export type UserRole = 'user' | 'admin';
export type UserStatus = 'active' | 'suspended';
export type ConnectionStatus =
  | 'not_started'
  | 'scan_qr'
  | 'connecting'
  | 'working'
  | 'failed';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  full_name: string;
  role: UserRole;
  status: UserStatus;
  can_create_bots: boolean;
  created_at: Date;
  updated_at: Date;
  last_login_at: Date | null;
}

export type PublicUser = Omit<UserRow, 'password_hash'>;

export interface BotRow {
  id: string;
  user_id: string;
  name: string;
  waha_session: string;
  api_key_hash: string;
  api_key_preview: string;
  api_key_encrypted: string | null;
  enabled: boolean;
  connection_status: ConnectionStatus;
  phone_number: string | null;
  last_connected_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface SessionRow {
  token_hash: string;
  user_id: string;
  expires_at: Date;
  revoked_at: Date | null;
  ip_address: string | null;
  user_agent: string | null;
}

export interface UsageEventRow {
  id: string;
  user_id: string;
  bot_id: string | null;
  type: string;
  meta: Record<string, unknown>;
  created_at: Date;
}

const PUBLIC_USER_COLUMNS =
  'id, email, full_name, role, status, can_create_bots, created_at, updated_at, last_login_at';

export function toPublicUser(user: UserRow): PublicUser {
  const { password_hash: _ignored, ...rest } = user;
  return rest;
}

/* ------------------------------- Usuarios -------------------------------- */

export async function findUserByEmail(
  db: DbPool,
  email: string,
): Promise<UserRow | null> {
  return queryOne<UserRow>(
    db,
    'SELECT * FROM users WHERE lower(email) = lower($1)',
    [email],
  );
}

export async function findUserById(
  db: DbPool,
  id: string,
): Promise<UserRow | null> {
  return queryOne<UserRow>(db, 'SELECT * FROM users WHERE id = $1', [id]);
}

export async function insertUser(
  db: DbPool,
  input: {
    email: string;
    passwordHash: string;
    fullName: string;
    role?: UserRole;
    status?: UserStatus;
    canCreateBots?: boolean;
  },
): Promise<UserRow> {
  return queryOne<UserRow>(
    db,
    `INSERT INTO users (email, password_hash, full_name, role, status, can_create_bots)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      input.email.trim().toLowerCase(),
      input.passwordHash,
      input.fullName.trim(),
      input.role ?? 'user',
      input.status ?? 'active',
      input.canCreateBots ?? true,
    ],
  ) as Promise<UserRow>;
}

export async function listUsers(
  db: DbPool,
  options: { search?: string; limit: number; offset: number },
): Promise<{ rows: PublicUser[]; total: number }> {
  const search = options.search?.trim() ?? '';
  const where = search
    ? 'WHERE email ILIKE $1 OR full_name ILIKE $1'
    : '';
  const params: unknown[] = search ? [`%${search}%`] : [];

  const totalRow = await queryOne<{ total: string }>(
    db,
    `SELECT COUNT(*)::text AS total FROM users ${where}`,
    params,
  );

  const rows = await query<PublicUser>(
    db,
    `SELECT ${PUBLIC_USER_COLUMNS} FROM users ${where}
     ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, options.limit, options.offset],
  );
  return { rows, total: Number(totalRow?.total ?? 0) };
}

export async function updateUser(
  db: DbPool,
  id: string,
  patch: Partial<{
    fullName: string;
    role: UserRole;
    status: UserStatus;
    canCreateBots: boolean;
    passwordHash: string;
  }>,
): Promise<PublicUser | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  const map: Record<string, unknown> = {
    fullName: 'full_name',
    role: 'role',
    status: 'status',
    canCreateBots: 'can_create_bots',
    passwordHash: 'password_hash',
  };
  for (const [key, column] of Object.entries(map)) {
    const value = (patch as Record<string, unknown>)[key];
    if (value !== undefined) {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    }
  }
  if (fields.length === 0) {
    return queryOne<PublicUser>(
      db,
      `SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = $1`,
      [id],
    );
  }
  values.push(id);
  return queryOne<PublicUser>(
    db,
    `UPDATE users SET ${fields.join(', ')}, updated_at = now()
     WHERE id = $${values.length}
     RETURNING ${PUBLIC_USER_COLUMNS}`,
    values,
  );
}

export async function touchLastLogin(db: DbPool, id: string): Promise<void> {
  await query(db, 'UPDATE users SET last_login_at = now() WHERE id = $1', [id]);
}

export async function deleteUser(db: DbPool, id: string): Promise<boolean> {
  const result = await db.query('DELETE FROM users WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function countAdmins(db: DbPool): Promise<number> {
  const row = await queryOne<{ total: string }>(
    db,
    "SELECT COUNT(*)::text AS total FROM users WHERE role = 'admin' AND status = 'active'",
  );
  return Number(row?.total ?? 0);
}

/* ------------------------------- Sesiones -------------------------------- */

export async function insertSession(
  db: DbPool,
  input: {
    tokenHash: string;
    userId: string;
    expiresAt: Date;
    ipAddress: string | null;
    userAgent: string | null;
  },
): Promise<void> {
  await query(
    db,
    `INSERT INTO user_sessions (token_hash, user_id, expires_at, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      input.tokenHash,
      input.userId,
      input.expiresAt,
      input.ipAddress,
      input.userAgent?.slice(0, 500) ?? null,
    ],
  );
}

export async function findActiveSession(
  db: DbPool,
  tokenHash: string,
): Promise<(SessionRow & { user: UserRow }) | null> {
  return queryOne<SessionRow & { user: UserRow }>(
    db,
    `SELECT s.*, to_jsonb(u) AS user
     FROM user_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       AND u.status = 'active'`,
    [tokenHash],
  ).then((row) => {
    if (!row) return null;
    const { user, ...session } = row;
    // pg devuelve to_jsonb como objeto; lo normalizamos al tipo UserRow.
    const userRow =
      typeof user === 'string' ? (JSON.parse(user) as UserRow) : (user as unknown as UserRow);
    return { ...session, user: userRow };
  });
}

export async function revokeSession(db: DbPool, tokenHash: string): Promise<void> {
  await query(
    db,
    'UPDATE user_sessions SET revoked_at = now() WHERE token_hash = $1',
    [tokenHash],
  );
}

export async function revokeAllUserSessions(db: DbPool, userId: string): Promise<void> {
  await query(
    db,
    'UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
    [userId],
  );
}

export async function deleteExpiredSessions(db: DbPool): Promise<void> {
  await query(db, 'DELETE FROM user_sessions WHERE expires_at < now() - interval \'7 days\'');
}

/* --------------------------------- Bots ---------------------------------- */

export async function findBotByUserId(
  db: DbPool,
  userId: string,
): Promise<BotRow | null> {
  return queryOne<BotRow>(
    db,
    'SELECT * FROM bots WHERE user_id = $1',
    [userId],
  );
}

/** Resuelve el Dueño de una sesión WAHA. Solo bots habilitados de usuarios activos. */
export async function findBotBySession(
  db: DbPool,
  session: string,
): Promise<(BotRow & { user_status: UserStatus }) | null> {
  return queryOne<BotRow & { user_status: UserStatus }>(
    db,
    `SELECT b.*, u.status AS user_status
     FROM bots b JOIN users u ON u.id = b.user_id
     WHERE b.waha_session = $1 AND b.enabled = TRUE AND u.status = 'active'`,
    [session],
  );
}

/** Bots con motor activo: usados por el worker-host al arrancar y al sincronizar. */
export async function listRunnableBots(
  db: DbPool,
): Promise<(BotRow & { user_status: UserStatus })[]> {
  return query<BotRow & { user_status: UserStatus }>(
    db,
    `SELECT b.*, u.status AS user_status
     FROM bots b JOIN users u ON u.id = b.user_id
     WHERE b.enabled = TRUE AND u.status = 'active'
     ORDER BY b.created_at ASC`,
  );
}

export async function findBotByApiKeyHash(
  db: DbPool,
  hash: string,
): Promise<(BotRow & { user_status: UserStatus; user_can_create_bots: boolean }) | null> {
  return queryOne<BotRow & { user_status: UserStatus; user_can_create_bots: boolean }>(
    db,
    `SELECT b.*, u.status AS user_status, u.can_create_bots AS user_can_create_bots
     FROM bots b JOIN users u ON u.id = b.user_id
     WHERE b.api_key_hash = $1`,
    [hash],
  );
}

export async function insertBot(
  db: DbPool,
  input: {
    id?: string;
    userId: string;
    name: string;
    wahaSession: string;
    apiKeyHash: string;
    apiKeyPreview: string;
    apiKeyEncrypted?: string | null;
  },
): Promise<BotRow> {
  return queryOne<BotRow>(
    db,
    `INSERT INTO bots (id, user_id, name, waha_session, api_key_hash, api_key_preview, api_key_encrypted)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      input.id ?? null,
      input.userId,
      input.name,
      input.wahaSession,
      input.apiKeyHash,
      input.apiKeyPreview,
      input.apiKeyEncrypted ?? null,
    ],
  ) as Promise<BotRow>;
}

export async function updateBotConnection(
  db: DbPool,
  userId: string,
  status: ConnectionStatus,
  phoneNumber?: string | null,
): Promise<void> {
  await query(
    db,
    `UPDATE bots
     SET connection_status = $2,
         phone_number = COALESCE($3, phone_number),
         last_connected_at = CASE WHEN $2 = 'working' THEN now() ELSE last_connected_at END,
         updated_at = now()
     WHERE user_id = $1`,
    [userId, status, phoneNumber ?? null],
  );
}

export async function setBotEnabled(
  db: DbPool,
  userId: string,
  enabled: boolean,
): Promise<void> {
  await query(
    db,
    'UPDATE bots SET enabled = $2, updated_at = now() WHERE user_id = $1',
    [userId, enabled],
  );
}

export async function rotateBotApiKey(
  db: DbPool,
  userId: string,
  apiKeyHash: string,
  apiKeyPreview: string,
  apiKeyEncrypted?: string | null,
): Promise<void> {
  await query(
    db,
    `UPDATE bots SET api_key_hash = $2, api_key_preview = $3,
       api_key_encrypted = COALESCE($4, api_key_encrypted), updated_at = now()
     WHERE user_id = $1`,
    [userId, apiKeyHash, apiKeyPreview, apiKeyEncrypted ?? null],
  );
}

/** Limpieza de eventos de uso y sesiones vencidas. Devuelve filas borradas. */
export async function cleanupPlatformData(
  db: DbPool,
  retentionDays: number,
): Promise<{ usageEvents: number; sessions: number }> {
  const events = await query<{ deleted: string }>(
    db,
    `DELETE FROM usage_events WHERE created_at < now() - ($1::int * INTERVAL '1 day') RETURNING id`,
    [retentionDays],
  );
  const sessions = await query<{ token_hash: string }>(
    db,
    'DELETE FROM user_sessions WHERE expires_at < now() OR revoked_at IS NOT NULL RETURNING token_hash',
  );
  return { usageEvents: events.length, sessions: sessions.length };
}

export async function deleteBot(db: DbPool, userId: string): Promise<void> {
  await query(db, 'DELETE FROM bots WHERE user_id = $1', [userId]);
}

/* ------------------------- Eventos y reportes ----------------------------- */

export type EventType =
  | 'login'
  | 'logout'
  | 'register'
  | 'bot_created'
  | 'api_key_rotated'
  | 'qr_generated'
  | 'session_deleted'
  | 'session_connected'
  | 'session_lost'
  | 'message_in'
  | 'message_out';

export async function logEvent(
  db: DbPool,
  input: {
    userId: string;
    botId?: string | null;
    type: EventType;
    meta?: Record<string, unknown>;
  },
): Promise<void> {
  await query(
    db,
    `INSERT INTO usage_events (user_id, bot_id, type, meta)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [input.userId, input.botId ?? null, input.type, JSON.stringify(input.meta ?? {})],
  );
}

export async function listEvents(
  db: DbPool,
  options: { userId?: string; limit: number },
): Promise<UsageEventRow[]> {
  const where = options.userId ? 'WHERE user_id = $1' : '';
  const params: unknown[] = options.userId ? [options.userId] : [];
  params.push(options.limit);
  return query<UsageEventRow>(
    db,
    `SELECT id::text, user_id, bot_id, type, meta, created_at
     FROM usage_events ${where}
     ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
}

export interface UserReportRow {
  id: string;
  email: string;
  full_name: string;
  role: UserRole;
  status: UserStatus;
  bot_name: string | null;
  connection_status: ConnectionStatus | null;
  phone_number: string | null;
  bot_created_at: Date | null;
  logins: string;
  messages_in: string;
  messages_out: string;
  qr_generated: string;
  session_connected: string;
  last_activity_at: Date | null;
}

/** Reporte global por usuario para el panel de administración (últimos 30 días). */
export async function getUsersReport(db: DbPool): Promise<UserReportRow[]> {
  return query<UserReportRow>(
    db,
    `SELECT
       u.id::text, u.email, u.full_name, u.role, u.status,
       b.name AS bot_name, b.connection_status, b.phone_number, b.created_at AS bot_created_at,
       COUNT(e.id) FILTER (WHERE e.type = 'login')::text AS logins,
       COUNT(e.id) FILTER (WHERE e.type = 'message_in')::text AS messages_in,
       COUNT(e.id) FILTER (WHERE e.type = 'message_out')::text AS messages_out,
       COUNT(e.id) FILTER (WHERE e.type = 'qr_generated')::text AS qr_generated,
       COUNT(e.id) FILTER (WHERE e.type = 'session_connected')::text AS session_connected,
       MAX(e.created_at) AS last_activity_at
     FROM users u
     LEFT JOIN bots b ON b.user_id = u.id
     LEFT JOIN usage_events e
       ON e.user_id = u.id AND e.created_at >= now() - interval '30 days'
     GROUP BY u.id, b.id
     ORDER BY last_activity_at DESC NULLS LAST, u.created_at DESC`,
  );
}

export interface UserSummary {
  logins: string;
  messages_in: string;
  messages_out: string;
  qr_generated: string;
  session_connected: string;
  events_total: string;
}

/** Resumen agregado para un usuario (o global si no se pasa userId). */
export async function getSummary(
  db: DbPool,
  userId?: string,
): Promise<UserSummary> {
  const where = userId ? 'WHERE user_id = $1' : '';
  const params = userId ? [userId] : [];
  const row = await queryOne<UserSummary>(
    db,
    `SELECT
       COUNT(*) FILTER (WHERE type = 'login')::text AS logins,
       COUNT(*) FILTER (WHERE type = 'message_in')::text AS messages_in,
       COUNT(*) FILTER (WHERE type = 'message_out')::text AS messages_out,
       COUNT(*) FILTER (WHERE type = 'qr_generated')::text AS qr_generated,
       COUNT(*) FILTER (WHERE type = 'session_connected')::text AS session_connected,
       COUNT(*)::text AS events_total
     FROM usage_events ${where}`,
    params,
  );
  return (
    row ?? {
      logins: '0',
      messages_in: '0',
      messages_out: '0',
      qr_generated: '0',
      session_connected: '0',
      events_total: '0',
    }
  );
}

/** Serie diaria de mensajes para gráficos (últimos 14 días). */
export async function getDailySeries(
  db: DbPool,
  userId?: string,
): Promise<Array<{ day: string; inbound: string; outbound: string }>> {
  const where = userId ? 'WHERE user_id = $1' : '';
  const params = userId ? [userId] : [];
  return query<{ day: string; inbound: string; outbound: string }>(
    db,
    `SELECT
       to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
       COUNT(*) FILTER (WHERE type = 'message_in')::text AS inbound,
       COUNT(*) FILTER (WHERE type = 'message_out')::text AS outbound
     FROM usage_events
     ${where}
     GROUP BY 1
     ORDER BY 1 DESC
     LIMIT 14`,
    params,
  );
}
