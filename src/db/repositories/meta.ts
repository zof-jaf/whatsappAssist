import type { Db } from '../database.js';
import { nowIso } from '../../utils/time.js';

export class MetaRepository {
  constructor(private readonly db: Db) {}

  get(key: string): string | undefined {
    const row = this.db
      .prepare('SELECT value FROM app_meta WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO app_meta (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, nowIso());
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM app_meta WHERE key = ?').run(key);
  }

  getJson<T>(key: string): T | undefined {
    const value = this.get(key);
    if (!value) return undefined;
    try {
      return JSON.parse(value) as T;
    } catch {
      return undefined;
    }
  }

  setJson(key: string, value: unknown): void {
    this.set(key, JSON.stringify(value));
  }
}
