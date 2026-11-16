export type MessageDirection = 'in' | 'out';
export type MessageRole = 'user' | 'assistant' | 'system';
export type MessageKind = 'text' | 'media' | 'command' | 'system' | 'error';
export type MessageStatus =
  | 'received'
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed'
  | 'skipped';
export type ConversationStatus = 'active' | 'archived';
export type QuoteRequestStatus =
  | 'pending'
  | 'answered'
  | 'delivered'
  | 'cancelled'
  | 'expired';
export type JobStatus = 'pending' | 'processing' | 'done' | 'failed';
export type WebhookEventStatus = 'queued' | 'processed' | 'ignored' | 'duplicate' | 'error';

export interface ContactRow {
  id: number;
  wa_id: string;
  phone: string | null;
  push_name: string | null;
  display_name: string | null;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}

export interface ConversationRow {
  id: number;
  contact_id: number;
  ai_enabled: number;
  status: ConversationStatus;
  context_start_message_id: number | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: number;
  conversation_id: number;
  contact_id: number;
  wa_message_id: string | null;
  direction: MessageDirection;
  role: MessageRole;
  kind: MessageKind;
  body: string;
  media_url: string | null;
  media_mime: string | null;
  media_filename: string | null;
  status: MessageStatus;
  error: string | null;
  model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  latency_ms: number | null;
  reply_to_message_id: number | null;
  wa_timestamp: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConversationSummaryRow {
  id: number;
  conversation_id: number;
  summary: string;
  through_message_id: number;
  messages_covered: number;
  model: string | null;
  is_active: number;
  created_at: string;
}

export interface QuoteRequestRow {
  id: number;
  code: string | null;
  conversation_id: number;
  contact_id: number;
  inbound_message_id: number | null;
  request_body: string;
  request_media_url: string | null;
  request_media_mime: string | null;
  request_media_filename: string | null;
  status: QuoteRequestStatus;
  artist_reply: string | null;
  artist_inbound_message_id: number | null;
  client_outbound_message_id: number | null;
  artist_notification_message_id: string | null;
  answered_at: string | null;
  delivered_at: string | null;
  appointment_at: string | null;
  notion_page_id: string | null;
  notion_page_url: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface InboundJobRow {
  id: number;
  wa_message_id: string;
  chat_id: string;
  event_id: string | null;
  payload: string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  locked_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface WebhookEventRow {
  id: number;
  event_id: string | null;
  event: string;
  session: string | null;
  status: WebhookEventStatus;
  reason: string | null;
  payload: string;
  created_at: string;
}

export interface ConversationListItem extends ConversationRow {
  wa_id: string;
  phone: string | null;
  push_name: string | null;
  display_name: string | null;
  last_body: string | null;
  last_direction: MessageDirection | null;
  last_status: MessageStatus | null;
  last_message_created_at: string | null;
  message_count: number;
  last_inbound_id: number | null;
  last_outbound_id: number | null;
}

export interface JobStats {
  pending: number;
  processing: number;
  done: number;
  failed: number;
  oldest_pending_at: string | null;
}

export interface OverviewStats {
  contacts: number;
  conversations: number;
  archivedConversations: number;
  messages: number;
  inboundToday: number;
  outboundToday: number;
  summaries: number;
  dbSizeBytes: number;
}
