import type { Db } from '../database.js';
import { nowIso } from '../../utils/time.js';

export interface ArtistRow {
  id: number;
  name: string;
  specialty: string;
  phone: string;
  bio: string;
  active: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface ArtistInput {
  name: string;
  specialty?: string;
  phone?: string;
  bio?: string;
  active?: boolean;
  sortOrder?: number;
}

export class ArtistRepository {
  constructor(private readonly db: Db) {}

  list(includeInactive = true): ArtistRow[] {
    const where = includeInactive ? '' : 'WHERE active = 1';
    return this.db
      .prepare(`SELECT * FROM artists ${where} ORDER BY sort_order ASC, id ASC`)
      .all() as ArtistRow[];
  }

  getById(id: number): ArtistRow | undefined {
    return this.db
      .prepare('SELECT * FROM artists WHERE id = ?')
      .get(id) as ArtistRow | undefined;
  }

  create(input: ArtistInput): ArtistRow {
    const now = nowIso();
    const result = this.db
      .prepare(
        `INSERT INTO artists
          (name, specialty, phone, bio, active, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.name.trim(),
        input.specialty?.trim() ?? '',
        input.phone?.trim() ?? '',
        input.bio?.trim() ?? '',
        input.active === false ? 0 : 1,
        input.sortOrder ?? 0,
        now,
        now,
      );
    return this.getById(Number(result.lastInsertRowid)) as ArtistRow;
  }

  update(id: number, input: Partial<ArtistInput>): ArtistRow | undefined {
    const current = this.getById(id);
    if (!current) return undefined;
    this.db
      .prepare(
        `UPDATE artists SET
          name = ?, specialty = ?, phone = ?, bio = ?, active = ?, sort_order = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.name?.trim() || current.name,
        input.specialty?.trim() ?? current.specialty,
        input.phone?.trim() ?? current.phone,
        input.bio?.trim() ?? current.bio,
        input.active === undefined ? current.active : input.active ? 1 : 0,
        input.sortOrder ?? current.sort_order,
        nowIso(),
        id,
      );
    return this.getById(id);
  }

  delete(id: number): boolean {
    return this.db.prepare('DELETE FROM artists WHERE id = ?').run(id).changes > 0;
  }
}
