import type { Db } from '../database.js';
import type {
  ConversationListItem,
  ConversationRow,
  ConversationStatus,
} from '../types.js';
import { nowIso } from '../../utils/time.js';

export interface ListConversationsOptions {
  limit?: number;
  offset?: number;
  search?: string;
  status?: ConversationStatus | 'all';
}

export interface ListConversationsResult {
  items: ConversationListItem[];
  total: number;
}

export class ConversationRepository {
  constructor(private readonly db: Db) {}

  getById(id: number): ConversationRow | undefined {
    return this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as
      | ConversationRow
      | undefined;
  }

  getByContactId(contactId: number): ConversationRow | undefined {
    return this.db
      .prepare('SELECT * FROM conversations WHERE contact_id = ?')
      .get(contactId) as ConversationRow | undefined;
  }

  getOrCreate(contactId: number): ConversationRow {
    const existing = this.getByContactId(contactId);
    if (existing) return existing;

    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO conversations (contact_id, created_at, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(contact_id) DO NOTHING`,
      )
      .run(contactId, now, now);

    return this.getByContactId(contactId) as ConversationRow;
  }

  list(options: ListConversationsOptions = {}): ListConversationsResult {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const offset = Math.max(options.offset ?? 0, 0);
    const status = options.status ?? 'all';
    const search = (options.search ?? '').trim().toLowerCase();

    const where = [
      '(? = \'all\' OR c.status = ?)',
      `(
        ? = ''
        OR instr(lower(ct.wa_id), ?) > 0
        OR instr(lower(coalesce(ct.phone, '')), ?) > 0
        OR instr(lower(coalesce(ct.push_name, '')), ?) > 0
        OR instr(lower(coalesce(ct.display_name, '')), ?) > 0
      )`,
    ].join(' AND ');

    const baseParams = [status, status, search, search, search, search, search];

    const totalRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM conversations c
         JOIN contacts ct ON ct.id = c.contact_id
         WHERE ${where}`,
      )
      .get(...baseParams) as { count: number };

    const items = this.db
      .prepare(
        `SELECT
          c.*,
          ct.wa_id,
          ct.phone,
          ct.push_name,
          ct.display_name,
          (SELECT m.body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_body,
          (SELECT m.direction FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_direction,
          (SELECT m.status FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_status,
          (SELECT m.created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message_created_at,
          (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
          (SELECT MAX(m.id) FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'in') AS last_inbound_id,
          (SELECT MAX(m.id) FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'out') AS last_outbound_id
         FROM conversations c
         JOIN contacts ct ON ct.id = c.contact_id
         WHERE ${where}
         ORDER BY coalesce(c.last_message_at, c.created_at) DESC, c.id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...baseParams, limit, offset) as ConversationListItem[];

    return { items, total: totalRow.count };
  }

  touchInbound(conversationId: number, at: string): void {
    this.db
      .prepare(
        `UPDATE conversations SET
          last_inbound_at = ?,
          last_message_at = ?,
          updated_at = ?
        WHERE id = ?`,
      )
      .run(at, at, at, conversationId);
  }

  touchOutbound(conversationId: number, at: string): void {
    this.db
      .prepare(
        `UPDATE conversations SET
          last_outbound_at = ?,
          last_message_at = ?,
          updated_at = ?
        WHERE id = ?`,
      )
      .run(at, at, at, conversationId);
  }

  setAiEnabled(conversationId: number, enabled: boolean): void {
    this.db
      .prepare('UPDATE conversations SET ai_enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, nowIso(), conversationId);
  }

  setStatus(conversationId: number, status: ConversationStatus): void {
    this.db
      .prepare('UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, nowIso(), conversationId);
  }

  resetContext(conversationId: number): number {
    const transaction = this.db.transaction(() => {
      const row = this.db
        .prepare(
          'SELECT COALESCE(MAX(id), 0) AS max_id FROM messages WHERE conversation_id = ?',
        )
        .get(conversationId) as { max_id: number };

      this.db
        .prepare(
          'UPDATE conversations SET context_start_message_id = ?, updated_at = ? WHERE id = ?',
        )
        .run(row.max_id, nowIso(), conversationId);

      this.db
        .prepare(
          'UPDATE conversation_summaries SET is_active = 0 WHERE conversation_id = ? AND is_active = 1',
        )
        .run(conversationId);

      return row.max_id;
    });

    return transaction();
  }
}
