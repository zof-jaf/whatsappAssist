import type { Db } from '../database.js';
import type { InboundJobRow, JobStats } from '../types.js';
import { nowIso } from '../../utils/time.js';

export interface EnqueueJobInput {
  waMessageId: string;
  chatId: string;
  eventId?: string | null;
  payload: string;
  maxAttempts: number;
}

export interface EnqueueJobResult {
  inserted: boolean;
  job: InboundJobRow;
}

export class JobRepository {
  constructor(private readonly db: Db) {}

  getById(id: number): InboundJobRow | undefined {
    return this.db.prepare('SELECT * FROM inbound_jobs WHERE id = ?').get(id) as
      | InboundJobRow
      | undefined;
  }

  enqueue(input: EnqueueJobInput): EnqueueJobResult {
    const now = nowIso();
    const result = this.db
      .prepare(
        `INSERT INTO inbound_jobs (
          wa_message_id, chat_id, event_id, payload, status,
          attempts, max_attempts, next_attempt_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)
        ON CONFLICT(wa_message_id) DO NOTHING`,
      )
      .run(
        input.waMessageId,
        input.chatId,
        input.eventId ?? null,
        input.payload,
        input.maxAttempts,
        now,
        now,
        now,
      );

    const job = this.db
      .prepare('SELECT * FROM inbound_jobs WHERE wa_message_id = ?')
      .get(input.waMessageId) as InboundJobRow;

    return { inserted: result.changes > 0, job };
  }

  /**
   * Reclama un trabajo pendiente respetando el orden por chat.
   * Un trabajo con reintento pendiente bloquea a los posteriores del mismo chat.
   */
  claimNext(): InboundJobRow | undefined {
    const claim = this.db.transaction((): InboundJobRow | undefined => {
      const now = nowIso();

      const candidate = this.db
        .prepare(
          `SELECT j.* FROM inbound_jobs j
           WHERE j.status = 'pending'
             AND j.next_attempt_at <= ?
             AND NOT EXISTS (
               SELECT 1 FROM inbound_jobs p
               WHERE p.chat_id = j.chat_id
                 AND p.id < j.id
                 AND p.status IN ('pending', 'processing')
             )
           ORDER BY j.id ASC
           LIMIT 1`,
        )
        .get(now) as InboundJobRow | undefined;

      if (!candidate) return undefined;

      const result = this.db
        .prepare(
          `UPDATE inbound_jobs SET
            status = 'processing',
            attempts = attempts + 1,
            locked_at = ?,
            updated_at = ?
          WHERE id = ? AND status = 'pending'`,
        )
        .run(now, now, candidate.id);

      if (result.changes === 0) return undefined;

      return this.getById(candidate.id);
    });

    return claim();
  }

  markDone(id: number): void {
    const now = nowIso();
    this.db
      .prepare(
        `UPDATE inbound_jobs SET
          status = 'done',
          locked_at = NULL,
          last_error = NULL,
          updated_at = ?
        WHERE id = ?`,
      )
      .run(now, id);
  }

  markFailure(
    id: number,
    options: { error: string; retryAt: string; final: boolean },
  ): void {
    this.db
      .prepare(
        `UPDATE inbound_jobs SET
          status = ?,
          locked_at = NULL,
          last_error = ?,
          next_attempt_at = ?,
          updated_at = ?
        WHERE id = ?`,
      )
      .run(
        options.final ? 'failed' : 'pending',
        options.error,
        options.retryAt,
        nowIso(),
        id,
      );
  }

  retry(id: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE inbound_jobs SET
          status = 'pending',
          attempts = 0,
          locked_at = NULL,
          last_error = NULL,
          next_attempt_at = ?,
          updated_at = ?
        WHERE id = ? AND status = 'failed'`,
      )
      .run(nowIso(), nowIso(), id);
    return result.changes > 0;
  }

  releaseForShutdown(id: number): void {
    const now = nowIso();
    this.db
      .prepare(
        `UPDATE inbound_jobs SET
          status = 'pending',
          attempts = MAX(attempts - 1, 0),
          locked_at = NULL,
          next_attempt_at = ?,
          updated_at = ?
        WHERE id = ? AND status = 'processing'`,
      )
      .run(now, now, id);
  }

  recoverInterrupted(): number {
    const result = this.db
      .prepare(
        `UPDATE inbound_jobs SET
          status = 'pending',
          locked_at = NULL,
          last_error = 'Recuperado tras un reinicio del proceso',
          next_attempt_at = ?,
          updated_at = ?
        WHERE status = 'processing'`,
      )
      .run(nowIso(), nowIso());
    return result.changes;
  }

  stats(): JobStats {
    const rows = this.db
      .prepare(
        'SELECT status, COUNT(*) AS count FROM inbound_jobs GROUP BY status',
      )
      .all() as Array<{ status: string; count: number }>;

    const counts = new Map(rows.map((row) => [row.status, row.count]));
    const oldest = this.db
      .prepare(
        "SELECT MIN(next_attempt_at) AS oldest FROM inbound_jobs WHERE status = 'pending'",
      )
      .get() as { oldest: string | null };

    return {
      pending: counts.get('pending') ?? 0,
      processing: counts.get('processing') ?? 0,
      done: counts.get('done') ?? 0,
      failed: counts.get('failed') ?? 0,
      oldest_pending_at: oldest.oldest,
    };
  }

  listFailed(limit = 50): InboundJobRow[] {
    return this.db
      .prepare(
        `SELECT * FROM inbound_jobs
         WHERE status = 'failed'
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(Math.min(Math.max(limit, 1), 200)) as InboundJobRow[];
  }

  pruneFinished(beforeIso: string): number {
    const result = this.db
      .prepare(
        `DELETE FROM inbound_jobs
         WHERE status IN ('done', 'failed') AND updated_at < ?`,
      )
      .run(beforeIso);
    return result.changes;
  }
}
