import type { Db } from '../database.js';
import { ContactRepository } from './contacts.js';
import { ConversationRepository } from './conversations.js';
import { MessageRepository } from './messages.js';
import { SummaryRepository } from './summaries.js';
import { JobRepository } from './jobs.js';
import { WebhookEventRepository } from './events.js';
import { MetaRepository } from './meta.js';
import { StatsRepository } from './stats.js';

export interface Repositories {
  contacts: ContactRepository;
  conversations: ConversationRepository;
  messages: MessageRepository;
  summaries: SummaryRepository;
  jobs: JobRepository;
  events: WebhookEventRepository;
  meta: MetaRepository;
  stats: StatsRepository;
}

export function createRepositories(db: Db): Repositories {
  return {
    contacts: new ContactRepository(db),
    conversations: new ConversationRepository(db),
    messages: new MessageRepository(db),
    summaries: new SummaryRepository(db),
    jobs: new JobRepository(db),
    events: new WebhookEventRepository(db),
    meta: new MetaRepository(db),
    stats: new StatsRepository(db),
  };
}
