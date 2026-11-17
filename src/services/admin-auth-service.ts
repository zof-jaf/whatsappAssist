import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { Repositories } from '../db/repositories/index.js';
import type { AdminUserRow } from '../db/repositories/admin-users.js';
import type { Logger } from '../logger.js';
import { ValidationError } from '../errors.js';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SCRYPT_KEYLEN = 64;

export interface AdminPublicUser {
  id: number;
  username: string;
  fullName: string;
  role: 'admin' | 'user';
  active: boolean;
  lastLoginAt: string | null;
}

export interface AdminLoginResult {
  token: string;
  user: AdminPublicUser;
}

/** Hash de contraseña con scrypt y sal aleatoria: scrypt$<salt>$<hash>. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('base64url');
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN).toString('base64url');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = parts[1];
  let expected: Buffer;
  try {
    expected = Buffer.from(parts[2], 'base64url');
  } catch {
    return false;
  }
  const actual = scryptSync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function toPublicUser(row: AdminUserRow): AdminPublicUser {
  return {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    role: row.role,
    active: row.active === 1,
    lastLoginAt: row.last_login_at,
  };
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Autenticación del panel por usuario y contraseña.
 *
 * El token estático `ADMIN_TOKEN` se conserva SOLO como mecanismo de reserva
 * para automatizaciones y tests; el login del panel usa credenciales por
 * usuario y sesiones con cookie httpOnly.
 */
export class AdminAuthService {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly config: AppConfig,
    private readonly repos: Repositories,
    private readonly logger: Logger,
  ) {}

  /** Crea el usuario inicial si la tabla está vacía. */
  seed(): void {
    if (this.repos.adminUsers.count() > 0) return;

    const username = (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
    const password =
      process.env.ADMIN_PASSWORD?.trim() || this.config.admin.token;
    this.repos.adminUsers.create({
      username,
      fullName: 'Administrador',
      passwordHash: hashPassword(password),
      role: 'admin',
    });
    this.logger.info(
      { username, source: process.env.ADMIN_PASSWORD ? 'ADMIN_PASSWORD' : 'ADMIN_TOKEN' },
      'Usuario inicial del panel creado',
    );
  }

  private allowAttempt(key: string): boolean {
    const now = Date.now();
    for (const [id, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(id);
    }
    const bucket = this.buckets.get(key) ?? {
      count: 0,
      resetAt: now + 15 * 60 * 1000,
    };
    if (bucket.count >= 10) return false;
    bucket.count += 1;
    this.buckets.set(key, bucket);
    return true;
  }

  login(username: string, password: string): AdminLoginResult {
    const key = username.trim().toLowerCase() || '(vacío)';
    if (!this.allowAttempt(key)) {
      throw new ValidationError('Demasiados intentos. Esperá unos minutos.');
    }

    const row = this.repos.adminUsers.findByUsername(key);
    if (!row || row.active !== 1 || !verifyPassword(password, row.password_hash)) {
      throw new ValidationError('Usuario o contraseña incorrectos.');
    }

    this.repos.adminUsers.touchLogin(row.id);
    this.repos.adminSessions.deleteExpired();

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    this.repos.adminSessions.create(row.id, tokenHash(token), expiresAt);

    const updated = this.repos.adminUsers.getById(row.id) ?? row;
    return { token, user: toPublicUser(updated) };
  }

  userFromToken(token: string | undefined): AdminPublicUser | null {
    if (!token) return null;
    const session = this.repos.adminSessions.find(tokenHash(token));
    if (!session || session.active !== 1) return null;
    return {
      id: session.user_id,
      username: session.username,
      fullName: session.full_name,
      role: session.role,
      active: session.active === 1,
      lastLoginAt: session.last_login_at,
    };
  }

  logout(token: string | undefined): void {
    if (token) this.repos.adminSessions.delete(tokenHash(token));
  }

  listUsers(): AdminPublicUser[] {
    return this.repos.adminUsers.list().map(toPublicUser);
  }

  createUser(input: {
    username: string;
    password: string;
    fullName?: string;
    role?: 'admin' | 'user';
  }): AdminPublicUser {
    const username = input.username?.trim().toLowerCase();
    if (!username || !/^[a-z0-9._-]{3,40}$/.test(username)) {
      throw new ValidationError(
        'El usuario debe tener entre 3 y 40 caracteres: letras, números, punto, guión o guión bajo.',
      );
    }
    if (!input.password || input.password.length < 8) {
      throw new ValidationError('La contraseña debe tener al menos 8 caracteres.');
    }
    if (this.repos.adminUsers.findByUsername(username)) {
      throw new ValidationError('Ese nombre de usuario ya está en uso.');
    }
    return toPublicUser(
      this.repos.adminUsers.create({
        username,
        fullName: input.fullName,
        passwordHash: hashPassword(input.password),
        role: input.role ?? 'user',
      }),
    );
  }

  updateUser(
    id: number,
    input: {
      fullName?: string;
      role?: 'admin' | 'user';
      active?: boolean;
      password?: string;
    },
  ): AdminPublicUser | null {
    if (input.password && input.password.length < 8) {
      throw new ValidationError('La contraseña debe tener al menos 8 caracteres.');
    }
    const row = this.repos.adminUsers.update(id, {
      fullName: input.fullName,
      role: input.role,
      active: input.active,
      passwordHash: input.password ? hashPassword(input.password) : undefined,
    });
    if (!row) return null;
    if (input.active === false) this.repos.adminSessions.deleteForUser(id);
    return toPublicUser(row);
  }

  deleteUser(id: number): boolean {
    return this.repos.adminUsers.delete(id);
  }
}
