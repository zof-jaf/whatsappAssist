import type { Db } from '../database.js';
import type {
  MessageKind,
  MessageRow,
  MessageStatus,
} from '../types.js';
import { nowIso } from '../../utils/time.js';

export interface InsertInboundInput {
  conversationId: number;
  contactId: number;
  waMessageId: string;
  body: string;
  kind: MessageKind;
  mediaUrl?: string | null;
  mediaMime?: string | null;
  mediaFilename?: string | null;
  waTimestamp?: string | null;
}

export interface InsertInboundResult {
  inserted: boolean;
  message: MessageRow;
}

export interface InsertOutboundInput {
  conversationId: number;
  contactId: number;
  body: string;
  kind?: MessageKind;
  status?: MessageStatus;
  model?: string | null;
  replyToMessageId?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  latencyMs?: number | null;
}

export interface ListMessagesOptions {
  conversationId: number;
  limit?: number;
  beforeId?: number | null;
}

export interface ListMessagesResult {
  items: MessageRow[];
  hasMore: boolean;
}

export class MessageRepository {
  constructor(private readonly db: Db) {}

  getById(id: number): MessageRow | undefined {
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as
      | MessageRow
      | undefined;
  }

  getByWaMessageId(waMessageId: string): MessageRow | undefined {
    return this.db
      .prepare('SELECT * FROM messages WHERE wa_message_id = ?')
      .get(waMessageId) as MessageRow | undefined;
  }

  insertInbound(input: InsertInboundInput): InsertInboundResult {
    const now = nowIso();
    const result = this.db
      .prepare(
        `INSERT INTO messages (
          conversation_id, contact_id, wa_message_id, direction, role, kind,
          body, media_url, media_mime, media_filename, status,
          wa_timestamp, created_at, updated_at
        ) VALUES (?, ?, ?, 'in', 'user', ?, ?, ?, ?, ?, 'received', ?, ?, ?)
        ON CONFLICT(wa_message_id) DO NOTHING`,
      )
      .run(
        input.conversationId,
        input.contactId,
        input.waMessageId,
        input.kind,
        input.body,
        input.mediaUrl ?? null,
        input.mediaMime ?? null,
        input.mediaFilename ?? null,
        input.waTimestamp ?? null,
        now,
        now,
      );

    if (result.changes === 0) {
      return {
        inserted: false,
        message: this.getByWaMessageId(input.waMessageId) as MessageRow,
      };
    }

    return {
      inserted: true,
      message: this.getById(Number(result.lastInsertRowid)) as MessageRow,
    };
  }

  insertOutbound(input: InsertOutboundInput): MessageRow {
    const now = nowIso();
    const result = this.db
      .prepare(
        `INSERT INTO messages (
          conversation_id, contact_id, direction, role, kind, body, status,
          model, reply_to_message_id, prompt_tokens, completion_tokens, latency_ms,
          created_at, updated_at
        ) VALUES (?, ?, 'out', 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.conversationId,
        input.contactId,
        input.kind ?? 'text',
        input.body,
        input.status ?? 'queued',
        input.model ?? null,
        input.replyToMessageId ?? null,
        input.promptTokens ?? null,
        input.completionTokens ?? null,
        input.latencyMs ?? null,
        now,
        now,
      );

    return this.getById(Number(result.lastInsertRowid)) as MessageRow;
  }

  findOutboundReply(inboundMessageId: number): MessageRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE direction = 'out' AND reply_to_message_id = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(inboundMessageId) as MessageRow | undefined;
  }

  markSent(
    id: number,
    options: {
      waMessageId?: string | null;
      status?: MessageStatus;
    } = {},
  ): void {
    const now = nowIso();
    this.db
      .prepare(
        `UPDATE messages SET
          status = ?,
          wa_message_id = COALESCE(?, wa_message_id),
          error = NULL,
          sent_at = COALESCE(sent_at, ?),
          updated_at = ?
        WHERE id = ?`,
      )
      .run(options.status ?? 'sent', options.waMessageId ?? null, now, now, id);
  }

  markFailed(id: number, error: string): void {
    this.db
      .prepare(
        `UPDATE messages SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`,
      )
      .run(error, nowIso(), id);
  }

  markSkipped(id: number, reason: string): void {
    this.db
      .prepare(
        `UPDATE messages SET status = 'skipped', error = ?, updated_at = ? WHERE id = ?`,
      )
      .run(reason, nowIso(), id);
  }

  updateUsage(
    id: number,
    usage: {
      model: string;
      promptTokens?: number | null;
      completionTokens?: number | null;
      latencyMs?: number | null;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE messages SET
          model = ?,
          prompt_tokens = ?,
          completion_tokens = ?,
          latency_ms = ?,
          updated_at = ?
        WHERE id = ?`,
      )
      .run(
        usage.model,
        usage.promptTokens ?? null,
        usage.completionTokens ?? null,
        usage.latencyMs ?? null,
        nowIso(),
        id,
      );
  }

  updateStatusByWaMessageId(
    waMessageId: string,
    status: MessageStatus,
    error?: string,
  ): void {
    this.db
      .prepare(
        `UPDATE messages SET status = ?, error = ?, updated_at = ?
         WHERE wa_message_id = ? AND direction = 'out'`,
      )
      .run(status, error ?? null, nowIso(), waMessageId);
  }

  listByConversation(options: ListMessagesOptions): ListMessagesResult {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);
    const beforeId = options.beforeId ?? null;

    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE conversation_id = ?
           AND (? IS NULL OR id < ?)
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(options.conversationId, beforeId, beforeId, limit + 1) as MessageRow[];

    const hasMore = rows.length > limit;
    return {
      items: rows.slice(0, limit).reverse(),
      hasMore,
    };
  }

  allByConversation(conversationId: number): MessageRow[] {
    return this.db
      .prepare(
        'SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC',
      )
      .all(conversationId) as MessageRow[];
  }

  contextAfter(
    conversationId: number,
    afterMessageId: number,
    limit = 300,
  ): MessageRow[] {
    return this.db
      .prepare(
        `SELECT * FROM (
          SELECT * FROM messages
          WHERE conversation_id = ?
            AND id > ?
            AND role IN ('user', 'assistant')
            AND kind IN ('text', 'media')
            AND (direction = 'in' OR status IN ('queued', 'sent', 'delivered', 'read'))
          ORDER BY id DESC
          LIMIT ?
        ) ORDER BY id ASC`,
      )
      .all(conversationId, afterMessageId, Math.min(limit, 1000)) as MessageRow[];
  }

  listForSummary(
    conversationId: number,
    afterMessageId: number,
    throughMessageId: number,
    limit = 1000,
  ): MessageRow[] {
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE conversation_id = ?
           AND id > ?
           AND id <= ?
           AND role IN ('user', 'assistant')
           AND kind IN ('text', 'media')
           AND (direction = 'in' OR status IN ('queued', 'sent', 'delivered', 'read'))
         ORDER BY id ASC
         LIMIT ?`,
      )
      .all(
        conversationId,
        afterMessageId,
        throughMessageId,
        Math.min(limit, 2000),
      ) as MessageRow[];
  }

  countSince(conversationId: number, afterMessageId: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM messages
         WHERE conversation_id = ?
           AND id > ?
           AND role IN ('user', 'assistant')
           AND kind IN ('text', 'media')
           AND (direction = 'in' OR status IN ('queued', 'sent', 'delivered', 'read'))`,
      )
      .get(conversationId, afterMessageId) as { count: number };
    return row.count;
  }

  charsSince(conversationId: number, afterMessageId: number): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(length(body)), 0) AS chars FROM messages
         WHERE conversation_id = ?
           AND id > ?
           AND role IN ('user', 'assistant')
           AND kind IN ('text', 'media')
           AND (direction = 'in' OR status IN ('queued', 'sent', 'delivered', 'read'))`,
      )
      .get(conversationId, afterMessageId) as { chars: number };
    return row.chars;
  }

  lastMessage(conversationId: number): MessageRow | undefined {
    return this.db
      .prepare(
        'SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1',
      )
      .get(conversationId) as MessageRow | undefined;
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM messages').get() as {
      count: number;
    };
    return row.count;
  }
}
