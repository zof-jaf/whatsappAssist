import type { AppConfig } from '../config.js';
import type { ContactRow, ConversationRow, MessageRow } from '../db/types.js';
import type { Repositories } from '../db/repositories/index.js';
import type { WahaClient } from '../clients/waha.js';
import type { Logger } from '../logger.js';
import type { NormalizedInboundMessage } from '../domain/waha.js';
import {
  buildAppointment,
  formatZonedDateTime,
  parseSpanishAppointment,
  type AppointmentDateParts,
  type AppointmentIntent,
  type AppointmentTimeParts,
} from '../domain/scheduling.js';
import type { NotionSettingsService } from './notion-settings-service.js';
import { errorMessage } from '../utils/async.js';

export interface SchedulingInput {
  message: NormalizedInboundMessage;
  conversation: ConversationRow;
  contact: ContactRow;
  inbound: MessageRow;
}

export type SchedulingOutcome =
  | { handled: false }
  | { handled: true; replyText: string };

interface AppointmentDraft {
  date: AppointmentDateParts | null;
  time: AppointmentTimeParts | null;
  at: number;
}

const DRAFT_TTL_MS = 30 * 60 * 1000;

/**
 * Detecta cuando el cliente elige día y hora después de recibir un precio y
 * crea la cita en Notion. Si Notion no está listo, pide intervención al
 * tatuador en vez de confirmar una cita que no quedó registrada.
 */
export class SchedulingService {
  /** Fecha y hora parciales cuando el cliente las manda en mensajes distintos. */
  private readonly drafts = new Map<number, AppointmentDraft>();

  constructor(
    private readonly config: AppConfig,
    private readonly repos: Repositories,
    private readonly waha: WahaClient,
    private readonly notion: NotionSettingsService,
    private readonly logger: Logger,
  ) {}

  async tryHandleClientMessage(
    input: SchedulingInput,
  ): Promise<SchedulingOutcome> {
    if (input.message.fromMe) return { handled: false };

    const quote = this.repos.quoteRequests.latestByConversation(
      input.conversation.id,
    );
    if (!quote || !quote.artist_reply) return { handled: false };
    if (quote.status !== 'delivered' && quote.status !== 'answered') {
      return { handled: false };
    }
    if (quote.appointment_at) return { handled: false };

    // “¿Trabajan los viernes?” es una consulta de disponibilidad, no una
    // elección de turno. Se deja pasar a la IA para que responda sin agendar.
    const asksAvailability =
      /(?:trabajan|trabajas|atienden|abren|abierto|disponib|hay\s+(?:lugar|cupo|turno)|ten[eé]s?\s+(?:lugar|cupo|turno))/i.test(
        input.message.body,
      );
    const confirmsChoice =
      /(?:quiero|quedemos|agend|reserv|confirm|me\s+sirve|dale|listo|perfecto|de\s+acuerdo|\bok\b)/i.test(
        input.message.body,
      );
    if (asksAvailability && !confirmsChoice) {
      return { handled: false };
    }

    const parsed = parseSpanishAppointment(input.message.body, {
      timeZone: this.config.bot.timeZone,
    });
    if (!parsed) return { handled: false };

    let intent: AppointmentIntent | null = parsed;
    if (!parsed.start) {
      intent = this.mergeDraft(input.conversation.id, parsed);
    }

    if (!intent || !intent.start) {
      if (intent?.date && !intent.time) {
        this.saveDraft(input.conversation.id, {
          date: intent.date,
          time: null,
        });
        return {
          handled: true,
          replyText: `Perfecto, ${intent.date.label}. ¿A qué hora te queda cómodo?`,
        };
      }
      if (intent?.time && !intent.date) {
        this.saveDraft(input.conversation.id, {
          date: null,
          time: intent.time,
        });
        return {
          handled: true,
          replyText: `Perfecto, ${intent.time.label}. ¿Qué día te queda cómodo?`,
        };
      }
      return { handled: false };
    }

    this.drafts.delete(input.conversation.id);

    const label = intent.label ?? formatZonedDateTime(
      intent.start,
      this.config.bot.timeZone,
    );
    const code = quote.code ?? 'la consulta';
    const clientName =
      input.contact.display_name ??
      input.contact.push_name ??
      input.contact.phone ??
      input.contact.wa_id;

    if (!this.notion.configured) {
      await this.replyToArtist(
        [
          `El cliente de ${code} eligió ${label}.`,
          `Cliente: ${clientName}${
            input.contact.phone ? ` (${input.contact.phone})` : ''
          }.`,
          'La agenda de Notion no está configurada, así que la cita no quedó registrada.',
          'Confirmá la disponibilidad y cargala manualmente, o configurá la agenda desde el panel.',
        ].join(' '),
      );

      this.logger.warn(
        { quoteId: quote.id, code: quote.code, appointment: label },
        'El cliente eligió un horario pero Notion no está configurado',
      );

      return {
        handled: true,
        replyText: `Recibí tu preferencia para el ${label}. Estoy confirmando la disponibilidad con ${this.config.tattoo.artistName}; apenas me confirme te aviso por acá.`,
      };
    }

    try {
      const page = await this.notion.createAppointment({
        quote,
        contact: input.contact,
        appointment: { ...intent, start: intent.start },
        artistReply: quote.artist_reply,
        timeZone: this.config.bot.timeZone,
      });

      this.repos.quoteRequests.markScheduled(quote.id, {
        appointmentAt: intent.start.toISOString(),
        notionPageId: page.pageId,
        notionPageUrl: page.pageUrl || null,
      });

      await this.replyToArtist(
        [
          `Cita agendada: ${label}.`,
          `Cliente: ${clientName}${
            input.contact.phone ? ` (${input.contact.phone})` : ''
          }.`,
          `Código: ${code}.`,
          page.pageUrl ? `Notion: ${page.pageUrl}` : null,
        ]
          .filter(Boolean)
          .join(' '),
      );

      this.logger.info(
        {
          quoteId: quote.id,
          code: quote.code,
          appointmentAt: intent.start.toISOString(),
          notionPageId: page.pageId,
        },
        'Cita agendada desde WhatsApp',
      );

      return {
        handled: true,
        replyText: [
          `Listo, dejé agendada la cita para el ${label}.`,
          `Código de cita: ${code}.`,
          'Si necesitás cambiarla, avisame por acá.',
        ].join(' '),
      };
    } catch (error) {
      const message = errorMessage(error);
      this.logger.error(
        { quoteId: quote.id, code: quote.code, err: message },
        'No se pudo crear la cita en Notion',
      );

      await this.replyToArtist(
        [
          `El cliente de ${code} eligió ${label}, pero no pude crear el evento en Notion: ${message}`,
          'Revisá la configuración de la agenda y confirmá la cita manualmente.',
        ].join(' '),
      );

      return {
        handled: true,
        replyText: `Recibí tu preferencia para el ${label}. Estoy confirmando la disponibilidad con ${this.config.tattoo.artistName}; apenas me confirme te aviso por acá.`,
      };
    }
  }

  private mergeDraft(
    conversationId: number,
    parsed: AppointmentIntent,
  ): AppointmentIntent {
    const draft = this.drafts.get(conversationId);
    if (!draft || Date.now() - draft.at > DRAFT_TTL_MS) {
      this.drafts.delete(conversationId);
      return parsed;
    }

    const date = parsed.date ?? draft.date;
    const time = parsed.time ?? draft.time;
    if (!date || !time) {
      return { date, time, start: null, label: null };
    }

    return buildAppointment(date, time, this.config.bot.timeZone);
  }

  private saveDraft(
    conversationId: number,
    draft: { date: AppointmentDateParts | null; time: AppointmentTimeParts | null },
  ): void {
    this.drafts.set(conversationId, { ...draft, at: Date.now() });
  }

  private async replyToArtist(text: string): Promise<void> {
    const artistChatId = this.config.tattoo.artistChatId;
    if (!artistChatId) return;

    try {
      await this.waha.sendText({ chatId: artistChatId, text });
    } catch (error) {
      this.logger.warn(
        { err: errorMessage(error) },
        'No se pudo avisar al tatuador sobre la cita',
      );
    }
  }
}
