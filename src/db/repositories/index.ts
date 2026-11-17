import type { Db } from '../database.js';
import { ContactRepository } from './contacts.js';
import { ConversationRepository } from './conversations.js';
import { MessageRepository } from './messages.js';
import { SummaryRepository } from './summaries.js';
import { QuoteRequestRepository } from './quote-requests.js';
import { JobRepository } from './jobs.js';
import { WebhookEventRepository } from './events.js';
import { MetaRepository } from './meta.js';
import { StatsRepository } from './stats.js';
import {
  AdminSessionRepository,
  AdminUserRepository,
} from './admin-users.js';
import { ArtistRepository } from './artists.js';
import { FlashTattooRepository } from './flash.js';
import { AppointmentRepository } from './appointments.js';

export interface Repositories {
  contacts: ContactRepository;
  conversations: ConversationRepository;
  messages: MessageRepository;
  summaries: SummaryRepository;
  quoteRequests: QuoteRequestRepository;
  jobs: JobRepository;
  events: WebhookEventRepository;
  meta: MetaRepository;
  stats: StatsRepository;
  adminUsers: AdminUserRepository;
  adminSessions: AdminSessionRepository;
  artists: ArtistRepository;
  flash: FlashTattooRepository;
  appointments: AppointmentRepository;
}

export function createRepositories(db: Db): Repositories {
  return {
    contacts: new ContactRepository(db),
    conversations: new ConversationRepository(db),
    messages: new MessageRepository(db),
    summaries: new SummaryRepository(db),
    quoteRequests: new QuoteRequestRepository(db),
    jobs: new JobRepository(db),
    events: new WebhookEventRepository(db),
    meta: new MetaRepository(db),
    stats: new StatsRepository(db),
    adminUsers: new AdminUserRepository(db),
    adminSessions: new AdminSessionRepository(db),
    artists: new ArtistRepository(db),
    flash: new FlashTattooRepository(db),
    appointments: new AppointmentRepository(db),
  };
}
