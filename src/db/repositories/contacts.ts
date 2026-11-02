import type { Db } from '../database.js';
import type { ContactRow } from '../types.js';
import { nowIso } from '../../utils/time.js';

export interface UpsertContactInput {
  waId: string;
  phone?: string | null;
  pushName?: string | null;
  displayName?: string | null;
}

export class ContactRepository {
  constructor(private readonly db: Db) {}

  getById(id: number): ContactRow | undefined {
    return this.db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as
      | ContactRow
      | undefined;
  }

  getByWaId(waId: string): ContactRow | undefined {
    return this.db.prepare('SELECT * FROM contacts WHERE wa_id = ?').get(waId) as
      | ContactRow
      | undefined;
  }

  upsert(input: UpsertContactInput): ContactRow {
    const now = nowIso();
    const existing = this.getByWaId(input.waId);

    if (!existing) {
      const pushName = input.pushName?.trim() || null;
      const displayName =
        input.displayName?.trim() ||
        pushName ||
        input.phone ||
        input.waId;

      const result = this.db
        .prepare(
          `INSERT INTO contacts (
            wa_id, phone, push_name, display_name,
            first_seen_at, last_seen_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.waId,
          input.phone ?? null,
          pushName,
          displayName,
          now,
          now,
          now,
          now,
        );

      return this.getById(Number(result.lastInsertRowid)) as ContactRow;
    }

    const pushName = input.pushName?.trim() || existing.push_name;
    const displayName =
      input.displayName?.trim() ||
      existing.display_name ||
      pushName ||
      input.phone ||
      input.waId;

    this.db
      .prepare(
        `UPDATE contacts SET
          phone = COALESCE(?, phone),
          push_name = ?,
          display_name = ?,
          last_seen_at = ?,
          updated_at = ?
        WHERE id = ?`,
      )
      .run(
        input.phone ?? null,
        pushName,
        displayName,
        now,
        now,
        existing.id,
      );

    return this.getById(existing.id) as ContactRow;
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM contacts').get() as {
      count: number;
    };
    return row.count;
  }
}
