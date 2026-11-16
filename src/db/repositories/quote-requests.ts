import type { Db } from '../database.js';
import type { QuoteRequestRow, QuoteRequestStatus } from '../types.js';
import { nowIso } from '../../utils/time.js';

export interface CreateQuoteRequestInput {
  conversationId: number;
  contactId: number;
  inboundMessageId: number | null;
  requestBody: string;
  requestMediaUrl?: string | null;
  requestMediaMime?: string | null;
  requestMediaFilename?: string | null;
  expiresAt: string;
}

function quoteCode(id: number): string {
  return `COT-${String(id).padStart(6, '0')}`;
}

/** Una cotización entregada deja de influir en el prompt después de 30 días. */
const QUOTE_CONTEXT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export class QuoteRequestRepository {
  constructor(private readonly db: Db) {}

  /**
   * Marca como vencidas las consultas pendientes cuya vigencia terminó. Se
   * ejecuta antes de buscar para que la lógica de negocio nunca trabaje con
   * consultas que ya no deberían derivarse.
   */
  expireStale(): number {
    const result = this.db
      .prepare(
        `UPDATE quote_requests
         SET status = 'expired', updated_at = ?
         WHERE status = 'pending' AND expires_at <= ?`,
      )
      .run(nowIso(), nowIso());
    return result.changes;
  }

  create(input: CreateQuoteRequestInput): QuoteRequestRow {
    const now = nowIso();
    const insert = this.db.transaction(() => {
      const result = this.db
        .prepare(
          `INSERT INTO quote_requests (
            code, conversation_id, contact_id, inbound_message_id,
            request_body, request_media_url, request_media_mime,
            request_media_filename, status, expires_at, created_at, updated_at
          ) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(
          input.conversationId,
          input.contactId,
          input.inboundMessageId,
          input.requestBody,
          input.requestMediaUrl ?? null,
          input.requestMediaMime ?? null,
          input.requestMediaFilename ?? null,
          input.expiresAt,
          now,
          now,
        );

      const id = Number(result.lastInsertRowid);
      this.db
        .prepare('UPDATE quote_requests SET code = ? WHERE id = ?')
        .run(quoteCode(id), id);

      return this.getById(id) as QuoteRequestRow;
    });

    return insert();
  }

  getById(id: number): QuoteRequestRow | undefined {
    return this.db
      .prepare('SELECT * FROM quote_requests WHERE id = ?')
      .get(id) as QuoteRequestRow | undefined;
  }

  getByCode(code: string): QuoteRequestRow | undefined {
    const normalized = code.trim().toUpperCase();
    return this.db
      .prepare('SELECT * FROM quote_requests WHERE UPPER(code) = ?')
      .get(normalized) as QuoteRequestRow | undefined;
  }

  /** Última consulta relevante de una conversación (pendiente o respondida). */
  latestByConversation(conversationId: number): QuoteRequestRow | undefined {
    this.expireStale();
    const cutoff = new Date(
      Date.now() - QUOTE_CONTEXT_WINDOW_MS,
    ).toISOString();
    return this.db
      .prepare(
        `SELECT * FROM quote_requests
         WHERE conversation_id = ?
           AND status IN ('pending', 'answered', 'delivered')
           AND (status = 'pending' OR created_at >= ?)
         ORDER BY id DESC LIMIT 1`,
      )
      .get(conversationId, cutoff) as QuoteRequestRow | undefined;
  }

  findPendingByConversation(
    conversationId: number,
  ): QuoteRequestRow | undefined {
    this.expireStale();
    return this.db
      .prepare(
        `SELECT * FROM quote_requests
         WHERE conversation_id = ? AND status = 'pending'
         ORDER BY id DESC LIMIT 1`,
      )
      .get(conversationId) as QuoteRequestRow | undefined;
  }

  /**
   * Consultas pendientes en orden de llegada. Se usa para correlacionar la
   * respuesta del tatuador cuando no incluye el código.
   */
  listPending(limit = 10): QuoteRequestRow[] {
    this.expireStale();
    return this.db
      .prepare(
        `SELECT * FROM quote_requests
         WHERE status = 'pending'
         ORDER BY id ASC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(limit, 50))) as QuoteRequestRow[];
  }

  countPending(): number {
    this.expireStale();
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM quote_requests WHERE status = 'pending'",
      )
      .get() as { count: number };
    return row.count;
  }

  setArtistNotificationMessageId(
    id: number,
    waMessageId: string | null,
  ): void {
    this.db
      .prepare(
        `UPDATE quote_requests
         SET artist_notification_message_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(waMessageId, nowIso(), id);
  }

  markAnswered(
    id: number,
    artistReply: string,
    artistInboundMessageId: number | null,
  ): void {
    const now = nowIso();
    this.db
      .prepare(
        `UPDATE quote_requests SET
          status = 'answered',
          artist_reply = ?,
          artist_inbound_message_id = ?,
          client_outbound_message_id = NULL,
          answered_at = ?,
          delivered_at = NULL,
          updated_at = ?
        WHERE id = ?`,
      )
      .run(artistReply, artistInboundMessageId, now, now, id);
  }

  setClientOutboundMessageId(
    id: number,
    clientOutboundMessageId: number,
  ): void {
    this.db
      .prepare(
        `UPDATE quote_requests
         SET client_outbound_message_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(clientOutboundMessageId, nowIso(), id);
  }

  markDelivered(
    id: number,
    clientOutboundMessageId: number | null,
  ): void {
    const now = nowIso();
    this.db
      .prepare(
        `UPDATE quote_requests SET
          status = 'delivered',
          client_outbound_message_id = ?,
          delivered_at = ?,
          updated_at = ?
        WHERE id = ?`,
      )
      .run(clientOutboundMessageId, now, now, id);
  }

  markScheduled(
    id: number,
    input: {
      appointmentAt: string;
      notionPageId: string | null;
      notionPageUrl: string | null;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE quote_requests SET
          appointment_at = ?,
          notion_page_id = ?,
          notion_page_url = ?,
          updated_at = ?
        WHERE id = ?`,
      )
      .run(
        input.appointmentAt,
        input.notionPageId,
        input.notionPageUrl,
        nowIso(),
        id,
      );
  }

  markCancelled(id: number): void {
    this.db
      .prepare(
        `UPDATE quote_requests
         SET status = 'cancelled', updated_at = ?
         WHERE id = ?`,
      )
      .run(nowIso(), id);
  }

  listByStatus(status: QuoteRequestStatus, limit = 50): QuoteRequestRow[] {
    return this.db
      .prepare(
        `SELECT * FROM quote_requests
         WHERE status = ?
         ORDER BY id DESC LIMIT ?`,
      )
      .all(status, Math.max(1, Math.min(limit, 200))) as QuoteRequestRow[];
  }
}
