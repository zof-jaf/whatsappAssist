import type { Db } from '../database.js';
import { nowIso } from '../../utils/time.js';

export type AppointmentStatus =
  | 'cotizacion'
  | 'pendiente'
  | 'confirmada'
  | 'completada'
  | 'cancelada';

export interface AppointmentRow {
  id: number;
  code: string;
  client: string;
  phone: string;
  design: string;
  zone: string;
  artist: string;
  at: string;
  price: number;
  deposit: number;
  paid: number;
  status: AppointmentStatus;
  note: string;
  created_at: string;
  updated_at: string;
}

export interface AppointmentInput {
  client: string;
  phone?: string;
  design?: string;
  zone?: string;
  artist?: string;
  at: string;
  price?: number;
  deposit?: number;
  paid?: boolean;
  status?: AppointmentStatus;
  note?: string;
}

export interface ListAppointmentsOptions {
  search?: string;
  status?: AppointmentStatus | 'all';
  artist?: string;
  from?: string;
  to?: string;
}

export class AppointmentRepository {
  constructor(private readonly db: Db) {}

  list(options: ListAppointmentsOptions = {}): AppointmentRow[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (options.status && options.status !== 'all') {
      clauses.push('status = ?');
      params.push(options.status);
    }
    if (options.artist && options.artist !== 'all') {
      clauses.push('artist = ?');
      params.push(options.artist);
    }
    if (options.from) {
      clauses.push('at >= ?');
      params.push(options.from);
    }
    if (options.to) {
      clauses.push('at < ?');
      params.push(options.to);
    }
    if (options.search?.trim()) {
      clauses.push(
        `(LOWER(code) LIKE ? OR LOWER(client) LIKE ? OR LOWER(phone) LIKE ? OR LOWER(design) LIKE ? OR LOWER(zone) LIKE ?)`,
      );
      const term = `%${options.search.trim().toLowerCase()}%`;
      params.push(term, term, term, term, term);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .prepare(`SELECT * FROM appointments ${where} ORDER BY at ASC, id ASC`)
      .all(...params) as AppointmentRow[];
  }

  getById(id: number): AppointmentRow | undefined {
    return this.db
      .prepare('SELECT * FROM appointments WHERE id = ?')
      .get(id) as AppointmentRow | undefined;
  }

  getByCode(code: string): AppointmentRow | undefined {
    return this.db
      .prepare('SELECT * FROM appointments WHERE code = ?')
      .get(code.trim().toUpperCase()) as AppointmentRow | undefined;
  }

  /** Genera un código legible y único: AG-20261117-0001. */
  nextCode(at: string): string {
    const date = new Date(at);
    const stamp = Number.isNaN(date.getTime())
      ? new Date().toISOString().slice(0, 10).replace(/-/g, '')
      : date.toISOString().slice(0, 10).replace(/-/g, '');
    const prefix = `AG-${stamp}-`;
    const row = this.db
      .prepare('SELECT MAX(code) AS code FROM appointments WHERE code LIKE ?')
      .get(`${prefix}%`) as { code: string | null };
    const last = row.code ? Number(row.code.slice(prefix.length)) || 0 : 0;
    return `${prefix}${String(last + 1).padStart(4, '0')}`;
  }

  create(input: AppointmentInput): AppointmentRow {
    const now = nowIso();
    const code = this.nextCode(input.at);
    const result = this.db
      .prepare(
        `INSERT INTO appointments
          (code, client, phone, design, zone, artist, at, price, deposit, paid, status, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        code,
        input.client.trim(),
        input.phone?.trim() ?? '',
        input.design?.trim() ?? '',
        input.zone?.trim() ?? '',
        input.artist?.trim() ?? '',
        input.at,
        Math.max(0, Math.round(Number(input.price) || 0)),
        Math.max(0, Math.round(Number(input.deposit) || 0)),
        input.paid ? 1 : 0,
        input.status ?? 'cotizacion',
        input.note?.trim() ?? '',
        now,
        now,
      );
    return this.getById(Number(result.lastInsertRowid)) as AppointmentRow;
  }

  update(id: number, input: Partial<AppointmentInput>): AppointmentRow | undefined {
    const current = this.getById(id);
    if (!current) return undefined;
    this.db
      .prepare(
        `UPDATE appointments SET
          client = ?, phone = ?, design = ?, zone = ?, artist = ?, at = ?,
          price = ?, deposit = ?, paid = ?, status = ?, note = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.client?.trim() || current.client,
        input.phone?.trim() ?? current.phone,
        input.design?.trim() ?? current.design,
        input.zone?.trim() ?? current.zone,
        input.artist?.trim() ?? current.artist,
        input.at ?? current.at,
        input.price === undefined ? current.price : Math.max(0, Math.round(Number(input.price) || 0)),
        input.deposit === undefined ? current.deposit : Math.max(0, Math.round(Number(input.deposit) || 0)),
        input.paid === undefined ? current.paid : input.paid ? 1 : 0,
        input.status ?? current.status,
        input.note?.trim() ?? current.note,
        nowIso(),
        id,
      );
    return this.getById(id);
  }

  delete(id: number): boolean {
    return this.db.prepare('DELETE FROM appointments WHERE id = ?').run(id).changes > 0;
  }
}
