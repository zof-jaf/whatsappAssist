import type { Db } from '../database.js';
import type { WebhookEventRow, WebhookEventStatus } from '../types.js';
import { nowIso } from '../../utils/time.js';

export interface InsertWebhookEventInput {
  eventId?: string | null;
  event: string;
  session?: string | null;
  status: WebhookEventStatus;
  reason?: string | null;
  payload: unknown;
}

export class WebhookEventRepository {
  constructor(private readonly db: Db) {}

  insert(input: InsertWebhookEventInput): void {
    this.db
      .prepare(
        `INSERT INTO webhook_events (
          event_id, event, session, status, reason, payload, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.eventId ?? null,
        input.event,
        input.session ?? null,
        input.status,
        input.reason ?? null,
        JSON.stringify(input.payload),
        nowIso(),
      );
  }

  listRecent(limit = 50): WebhookEventRow[] {
    return this.db
      .prepare(
        `SELECT * FROM webhook_events
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(Math.min(Math.max(limit, 1), 200)) as WebhookEventRow[];
  }

  prune(beforeIso: string): number {
    const result = this.db
      .prepare('DELETE FROM webhook_events WHERE created_at < ?')
      .run(beforeIso);
    return result.changes;
  }
}
