import type { Db } from '../database.js';
import { nowIso } from '../../utils/time.js';

export interface FlashTattooRow {
  id: number;
  code: string;
  name: string;
  category: string;
  price: number;
  size: string;
  description: string;
  image_url: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface FlashTattooInput {
  code: string;
  name: string;
  category?: string;
  price?: number;
  size?: string;
  description?: string;
  imageUrl?: string | null;
  active?: boolean;
}

export class FlashTattooRepository {
  constructor(private readonly db: Db) {}

  list(category?: string): FlashTattooRow[] {
    if (category && category !== 'all') {
      return this.db
        .prepare('SELECT * FROM flash_tattoos WHERE category = ? ORDER BY id ASC')
        .all(category) as FlashTattooRow[];
    }
    return this.db
      .prepare('SELECT * FROM flash_tattoos ORDER BY id ASC')
      .all() as FlashTattooRow[];
  }

  getById(id: number): FlashTattooRow | undefined {
    return this.db
      .prepare('SELECT * FROM flash_tattoos WHERE id = ?')
      .get(id) as FlashTattooRow | undefined;
  }

  getByCode(code: string): FlashTattooRow | undefined {
    return this.db
      .prepare('SELECT * FROM flash_tattoos WHERE code = ?')
      .get(code.trim().toUpperCase()) as FlashTattooRow | undefined;
  }

  create(input: FlashTattooInput): FlashTattooRow {
    const now = nowIso();
    const result = this.db
      .prepare(
        `INSERT INTO flash_tattoos
          (code, name, category, price, size, description, image_url, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.code.trim().toUpperCase(),
        input.name.trim(),
        input.category?.trim() || 'clasico',
        Math.max(0, Math.round(Number(input.price) || 0)),
        input.size?.trim() ?? '',
        input.description?.trim() ?? '',
        input.imageUrl?.trim() || null,
        input.active === false ? 0 : 1,
        now,
        now,
      );
    return this.getById(Number(result.lastInsertRowid)) as FlashTattooRow;
  }

  update(id: number, input: Partial<FlashTattooInput>): FlashTattooRow | undefined {
    const current = this.getById(id);
    if (!current) return undefined;
    this.db
      .prepare(
        `UPDATE flash_tattoos SET
          code = ?, name = ?, category = ?, price = ?, size = ?, description = ?,
          image_url = ?, active = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.code?.trim().toUpperCase() || current.code,
        input.name?.trim() || current.name,
        input.category?.trim() || current.category,
        input.price === undefined ? current.price : Math.max(0, Math.round(Number(input.price) || 0)),
        input.size?.trim() ?? current.size,
        input.description?.trim() ?? current.description,
        input.imageUrl === undefined ? current.image_url : input.imageUrl?.trim() || null,
        input.active === undefined ? current.active : input.active ? 1 : 0,
        nowIso(),
        id,
      );
    return this.getById(id);
  }

  delete(id: number): boolean {
    return this.db.prepare('DELETE FROM flash_tattoos WHERE id = ?').run(id).changes > 0;
  }
}
