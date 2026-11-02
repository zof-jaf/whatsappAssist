import type { Db } from '../database.js';
import type { ConversationSummaryRow } from '../types.js';
import { nowIso } from '../../utils/time.js';

export interface InsertSummaryInput {
  conversationId: number;
  summary: string;
  throughMessageId: number;
  messagesCovered: number;
  model?: string | null;
}

export class SummaryRepository {
  constructor(private readonly db: Db) {}

  latestActive(conversationId: number): ConversationSummaryRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM conversation_summaries
         WHERE conversation_id = ? AND is_active = 1
         ORDER BY id DESC LIMIT 1`,
      )
      .get(conversationId) as ConversationSummaryRow | undefined;
  }

  insert(input: InsertSummaryInput): ConversationSummaryRow {
    const insert = this.db.transaction(() => {
      // Solo puede quedar un resumen activo por conversación.
      this.db
        .prepare(
          'UPDATE conversation_summaries SET is_active = 0 WHERE conversation_id = ? AND is_active = 1',
        )
        .run(input.conversationId);

      const result = this.db
        .prepare(
          `INSERT INTO conversation_summaries (
            conversation_id, summary, through_message_id,
            messages_covered, model, is_active, created_at
          ) VALUES (?, ?, ?, ?, ?, 1, ?)`,
        )
        .run(
          input.conversationId,
          input.summary,
          input.throughMessageId,
          input.messagesCovered,
          input.model ?? null,
          nowIso(),
        );

      return this.db
        .prepare('SELECT * FROM conversation_summaries WHERE id = ?')
        .get(Number(result.lastInsertRowid)) as ConversationSummaryRow;
    });

    return insert();
  }

  deactivateAll(conversationId: number): void {
    this.db
      .prepare(
        'UPDATE conversation_summaries SET is_active = 0 WHERE conversation_id = ? AND is_active = 1',
      )
      .run(conversationId);
  }

  countActive(): number {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS count FROM conversation_summaries WHERE is_active = 1',
      )
      .get() as { count: number };
    return row.count;
  }
}
