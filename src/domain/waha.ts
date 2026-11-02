import { toIsoFromUnix } from '../utils/time.js';
import { isBroadcastId, isGroupId, phoneFromWaId } from '../utils/text.js';

export interface WahaMedia {
  url?: string | null;
  mimetype?: string | null;
  filename?: string | null;
}

export interface WahaMessagePayload {
  id?: unknown;
  timestamp?: unknown;
  from?: unknown;
  fromMe?: unknown;
  body?: unknown;
  hasMedia?: unknown;
  media?: unknown;
  participant?: unknown;
  pushName?: unknown;
  _data?: unknown;
  [key: string]: unknown;
}

export interface WahaWebhookEvent {
  id?: string;
  timestamp?: number;
  event: string;
  session?: string;
  engine?: string;
  payload?: unknown;
  me?: { id?: string; pushName?: string };
  [key: string]: unknown;
}

export interface NormalizedInboundMessage {
  waMessageId: string;
  chatId: string;
  fromMe: boolean;
  isGroup: boolean;
  isBroadcast: boolean;
  phone: string | null;
  pushName: string | null;
  body: string;
  hasMedia: boolean;
  mediaUrl: string | null;
  mediaMime: string | null;
  mediaFilename: string | null;
  timestampIso: string;
  kind: 'text' | 'media';
}

export interface ParsedMessageResult {
  ok: boolean;
  message?: NormalizedInboundMessage;
  reason?: string;
}

export interface SessionStatusInfo {
  status: string;
  at: string;
  data?: unknown;
  me?: { id?: string; pushName?: string };
}

export interface AckInfo {
  waMessageId: string;
  ackName: string;
  ack: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asMedia(value: unknown): WahaMedia | undefined {
  return asRecord(value) as WahaMedia | undefined;
}

function extractPushName(payload: WahaMessagePayload): string | null {
  const direct = asString(payload.pushName);
  if (direct) return direct;

  const data = asRecord(payload._data);
  if (data) {
    const notifyName = asString(data.notifyName);
    if (notifyName) return notifyName;
    const senderName = asString(data.senderName);
    if (senderName) return senderName;
  }

  return null;
}

export function parseMessageEvent(
  event: WahaWebhookEvent,
  fallbackNow: Date = new Date(),
): ParsedMessageResult {
  if (event.event !== 'message' && event.event !== 'message.any') {
    return { ok: false, reason: 'evento_no_soportado' };
  }

  const payload = asRecord(event.payload) as WahaMessagePayload | undefined;
  if (!payload) {
    return { ok: false, reason: 'payload_ausente' };
  }

  const waMessageId = asString(payload.id);
  const chatId = asString(payload.from);

  if (!waMessageId) return { ok: false, reason: 'id_ausente' };
  if (!chatId) return { ok: false, reason: 'from_ausente' };

  const body = typeof payload.body === 'string' ? payload.body : '';
  const hasMedia = asBoolean(payload.hasMedia);
  const media = asMedia(payload.media);
  const isGroup = isGroupId(chatId);
  const isBroadcast = isBroadcastId(chatId);
  const fromMe = asBoolean(payload.fromMe);

  const timestampSource =
    payload.timestamp !== undefined ? payload.timestamp : event.timestamp;

  const message: NormalizedInboundMessage = {
    waMessageId,
    chatId,
    fromMe,
    isGroup,
    isBroadcast,
    phone: phoneFromWaId(chatId),
    pushName: extractPushName(payload),
    body,
    hasMedia,
    mediaUrl: asString(media?.url) ?? null,
    mediaMime: asString(media?.mimetype) ?? null,
    mediaFilename: asString(media?.filename) ?? null,
    timestampIso: toIsoFromUnix(timestampSource, fallbackNow),
    kind: hasMedia ? 'media' : 'text',
  };

  return { ok: true, message };
}

export function parseSessionStatusEvent(
  event: WahaWebhookEvent,
): SessionStatusInfo | undefined {
  if (event.event !== 'session.status') return undefined;
  const payload = asRecord(event.payload);
  if (!payload) return undefined;
  const status = asString(payload.status);
  if (!status) return undefined;

  return {
    status,
    at: toIsoFromUnix(event.timestamp, new Date()),
    data: payload.data,
    me: event.me
      ? { id: event.me.id, pushName: event.me.pushName }
      : undefined,
  };
}

export function parseAckEvent(event: WahaWebhookEvent): AckInfo | undefined {
  if (event.event !== 'message.ack') return undefined;
  const payload = asRecord(event.payload);
  if (!payload) return undefined;

  const waMessageId = asString(payload.id);
  const ackName = asString(payload.ackName) ?? 'UNKNOWN';
  const ack = typeof payload.ack === 'number' ? payload.ack : -99;

  if (!waMessageId) return undefined;
  return { waMessageId, ackName, ack };
}

export function ackToMessageStatus(
  ack: AckInfo,
): 'sent' | 'delivered' | 'read' | 'failed' | undefined {
  switch (ack.ackName) {
    case 'SERVER':
      return 'sent';
    case 'DEVICE':
      return 'delivered';
    case 'READ':
    case 'PLAYED':
      return 'read';
    case 'ERROR':
      return 'failed';
    default:
      break;
  }

  switch (ack.ack) {
    case 1:
      return 'sent';
    case 2:
      return 'delivered';
    case 3:
    case 4:
      return 'read';
    case -1:
      return 'failed';
    default:
      return undefined;
  }
}

export function isWahaWebhookEvent(value: unknown): value is WahaWebhookEvent {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.event === 'string' && record.event.length > 0;
}
