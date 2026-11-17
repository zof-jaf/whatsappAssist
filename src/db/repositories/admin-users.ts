import type { Db } from '../database.js';
import { nowIso as timestamp } from '../../utils/time.js';

export interface AdminUserRow {
  id: number;
  username: string;
  full_name: string;
  password_hash: string;
  role: 'admin' | 'user';
  active: number;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AdminSessionRow {
  id: number;
  user_id: number;
  token_hash: string;
  expires_at: string;
  created_at: string;
}

export interface CreateAdminUserInput {
  username: string;
  fullName?: string;
  passwordHash: string;
  role?: 'admin' | 'user';
}

export interface UpdateAdminUserInput {
  fullName?: string;
  role?: 'admin' | 'user';
  active?: boolean;
  passwordHash?: string;
}

export class AdminUserRepository {
  constructor(private readonly db: Db) {}

  count(): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS count FROM admin_users').get() as {
        count: number;
      }
    ).count;
  }

  getById(id: number): AdminUserRow | undefined {
    return this.db
      .prepare('SELECT * FROM admin_users WHERE id = ?')
      .get(id) as AdminUserRow | undefined;
  }

  findByUsername(username: string): AdminUserRow | undefined {
    return this.db
      .prepare('SELECT * FROM admin_users WHERE username = ?')
      .get(username.trim().toLowerCase()) as AdminUserRow | undefined;
  }

  list(): AdminUserRow[] {
    return this.db
      .prepare('SELECT * FROM admin_users ORDER BY id ASC')
      .all() as AdminUserRow[];
  }

  create(input: CreateAdminUserInput): AdminUserRow {
    const now = timestamp();
    const result = this.db
      .prepare(
        `INSERT INTO admin_users
          (username, full_name, password_hash, role, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        input.username.trim().toLowerCase(),
        input.fullName?.trim() || input.username.trim(),
        input.passwordHash,
        input.role ?? 'user',
        now,
        now,
      );
    return this.getById(Number(result.lastInsertRowid)) as AdminUserRow;
  }

  update(id: number, input: UpdateAdminUserInput): AdminUserRow | undefined {
    const current = this.getById(id);
    if (!current) return undefined;
    const now = timestamp();
    this.db
      .prepare(
        `UPDATE admin_users SET
          full_name = ?, role = ?, active = ?, password_hash = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.fullName?.trim() || current.full_name,
        input.role ?? current.role,
        input.active === undefined ? current.active : input.active ? 1 : 0,
        input.passwordHash ?? current.password_hash,
        now,
        id,
      );
    return this.getById(id);
  }

  delete(id: number): boolean {
    return this.db.prepare('DELETE FROM admin_users WHERE id = ?').run(id).changes > 0;
  }

  touchLogin(id: number): void {
    this.db
      .prepare('UPDATE admin_users SET last_login_at = ? WHERE id = ?')
      .run(timestamp(), id);
  }
}

export class AdminSessionRepository {
  constructor(private readonly db: Db) {}

  create(userId: number, tokenHash: string, expiresAt: string): void {
    this.db
      .prepare(
        `INSERT INTO admin_sessions (user_id, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(userId, tokenHash, expiresAt, timestamp());
  }

  find(tokenHash: string): (AdminSessionRow & AdminUserRow) | undefined {
    return this.db
      .prepare(
        `SELECT s.*, u.username, u.full_name, u.password_hash, u.role, u.active,
                u.last_login_at, u.created_at AS user_created_at,
                u.updated_at AS user_updated_at
           FROM admin_sessions s
           JOIN admin_users u ON u.id = s.user_id
          WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .get(tokenHash, timestamp()) as (AdminSessionRow & AdminUserRow) | undefined;
  }

  delete(tokenHash: string): void {
    this.db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(tokenHash);
  }

  deleteForUser(userId: number): void {
    this.db.prepare('DELETE FROM admin_sessions WHERE user_id = ?').run(userId);
  }

  deleteExpired(): void {
    this.db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').run(timestamp());
  }
}
