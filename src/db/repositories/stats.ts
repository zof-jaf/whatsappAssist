import type { Db } from '../database.js';
import type { OverviewStats } from '../types.js';
import { startOfUtcDay } from '../../utils/time.js';

export class StatsRepository {
  constructor(private readonly db: Db) {}

  overview(): OverviewStats {
    const today = startOfUtcDay();

    const contacts = this.db
      .prepare('SELECT COUNT(*) AS count FROM contacts')
      .get() as { count: number };
    const conversations = this.db
      .prepare('SELECT COUNT(*) AS count FROM conversations')
      .get() as { count: number };
    const archived = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM conversations WHERE status = 'archived'",
      )
      .get() as { count: number };
    const messages = this.db
      .prepare('SELECT COUNT(*) AS count FROM messages')
      .get() as { count: number };
    const inboundToday = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM messages WHERE direction = 'in' AND created_at >= ?",
      )
      .get(today) as { count: number };
    const outboundToday = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM messages WHERE direction = 'out' AND created_at >= ?",
      )
      .get(today) as { count: number };
    const summaries = this.db
      .prepare(
        'SELECT COUNT(*) AS count FROM conversation_summaries WHERE is_active = 1',
      )
      .get() as { count: number };

    const pageCount = this.db.pragma('page_count', { simple: true }) as number;
    const pageSize = this.db.pragma('page_size', { simple: true }) as number;

    return {
      contacts: contacts.count,
      conversations: conversations.count,
      archivedConversations: archived.count,
      messages: messages.count,
      inboundToday: inboundToday.count,
      outboundToday: outboundToday.count,
      summaries: summaries.count,
      dbSizeBytes: pageCount * pageSize,
    };
  }
}
