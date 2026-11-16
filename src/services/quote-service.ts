import type { AppConfig } from '../config.js';
import type {
  ContactRow,
  ConversationRow,
  MessageRow,
  QuoteRequestRow,
} from '../db/types.js';
import type { Repositories } from '../db/repositories/index.js';
import type { WahaClient } from '../clients/waha.js';
import type { Logger } from '../logger.js';
import type { NormalizedInboundMessage } from '../domain/waha.js';
import {
  artistReplyContainsPrice,
  isQuoteRequestMessage,
  parseQuoteCode,
  replyContainsPrice,
  replyIsOffTopic,
  replyIsRefusal,
} from '../domain/quotes.js';
import { isArtistChatIdentity } from '../domain/phones.js';
import { addMilliseconds, formatDateTime, nowIso } from '../utils/time.js';
import { errorMessage } from '../utils/async.js';
import { truncate } from '../utils/text.js';

const PENDING_REPLY =
  'Ya tengo tu consulta en revisión con el tatuador. Apenas me confirme el precio te lo paso por acá.';

const NO_PRICE_REPLY =
  'El precio exacto lo define el tatuador. Contame el tamaño aproximado, la zona del cuerpo y, si tenés, una imagen de referencia, y le paso tu consulta.';

const OFF_TOPIC_REPLY =
  'Para cotizar no necesito el significado del diseño. Contame el tamaño aproximado, la zona del cuerpo y si tenés una imagen de referencia.';

const ARTIST_SINGLE_PENDING_HINT =
  'Podés responder directamente a este mensaje con el precio.';

export type QuoteClientOutcome =
  | { handled: false }
  | { handled: true; replyText: string };

export interface QuoteClientInput {
  message: NormalizedInboundMessage;
  conversation: ConversationRow;
  contact: ContactRow;
  inbound: MessageRow;
  signal?: AbortSignal;
}

export interface QuoteArtistInput {
  message: NormalizedInboundMessage;
  conversation: ConversationRow;
  contact: ContactRow;
  inbound: MessageRow;
  signal?: AbortSignal;
}

/**
 * Orquesta la derivación de cotizaciones al tatuador:
 *
 * 1. Detecta consultas del cliente y crea una solicitud con código COT-000123.
 * 2. Notifica al tatuador y reenvía las imágenes.
 * 3. Cuando el tatuador responde, envía el precio al cliente y habilita el
 *    agendamiento.
 *
 * El bot nunca inventa precios: la única fuente válida es el tatuador.
 */
export class QuoteService {
  constructor(
    private readonly config: AppConfig,
    private readonly repos: Repositories,
    private readonly waha: WahaClient,
    private readonly logger: Logger,
  ) {}

  get artistChatId(): string | null {
    return this.config.tattoo.artistChatId;
  }

  isArtistChat(chatId: string, phoneJid?: string | null): boolean {
    return isArtistChatIdentity(this.artistChatId, chatId, phoneJid);
  }

  /**
   * Procesa un mensaje del cliente. Devuelve `handled: true` cuando la
   * consulta ya fue derivada y el bot no debe llamar al modelo.
   */
  async handleClientMessage(
    input: QuoteClientInput,
  ): Promise<QuoteClientOutcome> {
    if (!this.artistChatId) return { handled: false };
    if (input.message.fromMe) return { handled: false };
    if (!isQuoteRequestMessage(input.message)) return { handled: false };

    const pending = this.repos.quoteRequests.findPendingByConversation(
      input.conversation.id,
    );

    if (pending) {
      // Reintento del mismo mensaje del cliente: la consulta ya se creó y se
      // notificó al tatuador; solo falta entregar el acuse.
      if (pending.inbound_message_id === input.inbound.id) {
        return {
          handled: true,
          replyText: this.acknowledgment(input.message),
        };
      }

      await this.notifyArtist(pending, input.message, input.contact, true);
      this.logger.info(
        {
          quoteId: pending.id,
          code: pending.code,
          conversationId: input.conversation.id,
        },
        'Información adicional de cotización reenviada al tatuador',
      );
      return {
        handled: true,
        replyText: `Sumé estos datos a tu consulta. Sigue en revisión con ${this.config.tattoo.artistName}; apenas me confirme el precio te lo paso por acá.`,
      };
    }

    const expiresAt = addMilliseconds(
      this.config.tattoo.requestTtlHours * 3_600_000,
    );
    const quote = this.repos.quoteRequests.create({
      conversationId: input.conversation.id,
      contactId: input.contact.id,
      inboundMessageId: input.inbound.id,
      requestBody: input.message.body.trim(),
      requestMediaUrl: input.message.mediaUrl,
      requestMediaMime: input.message.mediaMime,
      requestMediaFilename: input.message.mediaFilename,
      expiresAt,
    });

    try {
      await this.notifyArtist(quote, input.message, input.contact, false);
    } catch (error) {
      this.repos.quoteRequests.markCancelled(quote.id);
      this.logger.error(
        {
          quoteId: quote.id,
          code: quote.code,
          err: errorMessage(error),
        },
        'No se pudo notificar la consulta al tatuador',
      );
      throw error;
    }

    this.logger.info(
      {
        quoteId: quote.id,
        code: quote.code,
        conversationId: input.conversation.id,
        hasMedia: input.message.hasMedia,
      },
      'Consulta de cotización derivada al tatuador',
    );

    return {
      handled: true,
      replyText: this.acknowledgment(input.message),
    };
  }

  /**
   * Procesa un mensaje del tatuador. No usa IA: correlaciona la respuesta con
   * una consulta, la reenvía al cliente y confirma la entrega.
   */
  async handleArtistMessage(input: QuoteArtistInput): Promise<void> {
    if (!this.artistChatId) return;
    if (!this.isArtistChat(input.message.chatId, input.message.phoneJid)) {
      return;
    }

    const parsed = parseQuoteCode(input.message.body);
    let quote: QuoteRequestRow | undefined;

    if (parsed.code) {
      quote = this.repos.quoteRequests.getByCode(parsed.code);
      if (!quote) {
        await this.replyToArtist(
          `No encontré ninguna consulta con el código ${parsed.code}. Revisá el código e intentá de nuevo.`,
        );
        return;
      }
    } else {
      const pending = this.repos.quoteRequests.listPending(10);
      if (pending.length === 1) {
        quote = pending[0];
      } else if (pending.length > 1) {
        const lines = pending.map((item) => {
          const contact = this.repos.contacts.getById(item.contact_id);
          const name =
            contact?.display_name ?? contact?.phone ?? `contacto ${item.contact_id}`;
          const detail = item.request_body
            ? truncate(item.request_body.replace(/\s+/g, ' '), 90)
            : 'archivo adjunto';
          return `• ${item.code}: ${name} — ${detail}`;
        });
        await this.replyToArtist(
          [
            `Hay ${pending.length} consultas pendientes. Respondé incluyendo el código para saber a quién enviarle el precio:`,
            '',
            ...lines,
          ].join('\n'),
        );
        return;
      } else {
        this.logger.info(
          { chatId: input.message.chatId },
          'Mensaje del tatuador sin consultas pendientes; se ignora',
        );
        return;
      }
    }

    if (!quote) return;

    // Reintento del mismo mensaje: no volver a enviar la respuesta al cliente.
    if (quote.artist_inbound_message_id === input.inbound.id) {
      if (quote.status === 'delivered') return;

      if (quote.client_outbound_message_id) {
        const existing = this.repos.messages.getById(
          quote.client_outbound_message_id,
        );
        if (
          existing &&
          ['sent', 'delivered', 'read'].includes(existing.status)
        ) {
          this.repos.quoteRequests.markDelivered(quote.id, existing.id);
          return;
        }
        if (existing) {
          await this.sendClientRelay(quote, existing, input);
          return;
        }
      }
    }

    const replyText =
      parsed.text.trim() ||
      (input.message.hasMedia ? '' : input.message.body.trim());

    if (!replyText && !input.message.hasMedia) {
      await this.replyToArtist(
        `Recibí tu mensaje para ${quote.code}, pero necesito el texto del precio para enviárselo al cliente.`,
      );
      return;
    }

    // El tatuador solo define el precio. Si escribe una fecha, un saludo o
    // cualquier texto sin precio, no se reenvía al cliente como cotización.
    if (!artistReplyContainsPrice(replyText)) {
      await this.replyToArtist(
        [
          `Recibí tu mensaje para ${quote.code}, pero no encontré un precio.`,
          'Respondé solo con el precio, por ejemplo: $300.000.',
          'Si querés agregar una condición, incluila en el mismo mensaje.',
        ].join(' '),
      );
      return;
    }

    this.repos.quoteRequests.markAnswered(
      quote.id,
      replyText || '(archivo adjunto)',
      input.inbound.id,
    );
    quote = this.repos.quoteRequests.getById(quote.id) as QuoteRequestRow;

    const clientText = this.buildClientRelay(quote, replyText);
    const outbound = this.repos.messages.insertOutbound({
      conversationId: quote.conversation_id,
      contactId: quote.contact_id,
      body: clientText,
      kind: 'text',
      status: 'queued',
    });
    this.repos.quoteRequests.setClientOutboundMessageId(quote.id, outbound.id);
    this.repos.conversations.touchOutbound(
      quote.conversation_id,
      outbound.created_at,
    );

    await this.sendClientRelay(quote, outbound, input);
  }

  /** Nota que se inyecta en el prompt para que la IA sepa qué ya se cotizó. */
  promptNote(conversationId: number): string | null {
    const latest = this.repos.quoteRequests.latestByConversation(conversationId);
    if (!latest) return null;

    if (latest.status === 'pending') {
      const since = formatDateTime(
        new Date(latest.created_at),
        this.config.bot.timeZone,
      );
      return `Hay una consulta ${latest.code ?? ''} pendiente con el tatuador desde ${since}. No inventes precios ni plazos: cuando el tatuador responda, la respuesta se enviará automáticamente al cliente.`;
    }

    if (
      (latest.status === 'answered' || latest.status === 'delivered') &&
      latest.artist_reply
    ) {
      const appointment = latest.appointment_at
        ? ` La cita ya quedó agendada para ${formatDateTime(
            new Date(latest.appointment_at),
            this.config.bot.timeZone,
          )}. No vuelvas a pedir día ni horario ni a confirmar otra cita.`
        : '';
      return `El tatuador ya respondió la consulta ${latest.code ?? ''}: "${truncate(
        latest.artist_reply,
        1500,
      )}". Usá esa respuesta para continuar con el agendamiento (día, horario y seña si corresponde). No inventes otro precio.${appointment}`;
    }

    return null;
  }

  /**
   * Red de seguridad: reemplaza respuestas de la IA que inventen precios,
   * vuelvan a preguntar por el significado o se nieguen a cotizar.
   */
  sanitizeReply(reply: string, conversationId: number): string {
    const latest = this.repos.quoteRequests.latestByConversation(conversationId);
    const pending = latest?.status === 'pending';
    const answered =
      !!latest &&
      (latest.status === 'answered' || latest.status === 'delivered') &&
      !!latest.artist_reply;

    if (replyIsOffTopic(reply)) return OFF_TOPIC_REPLY;
    if (replyIsRefusal(reply)) return pending ? PENDING_REPLY : NO_PRICE_REPLY;
    if (replyContainsPrice(reply) && !answered) {
      return pending ? PENDING_REPLY : NO_PRICE_REPLY;
    }

    // No permitir que la IA diga que la cita ya quedó agendada si todavía no
    // existe un evento real en la agenda, haya o no una cotización previa.
    if (
      !latest?.appointment_at &&
      /(?:cita|turno|reserva|agenda).{0,60}(?:agendad|confirmad|reservad)|(?:agendad|confirmad|reservad).{0,60}(?:cita|turno|reserva)/i.test(
        reply,
      )
    ) {
      return 'Todavía no puedo confirmar la cita. Decime qué día y a qué hora te queda cómodo y la coordino con el tatuador.';
    }

    return reply;
  }

  private acknowledgment(message: NormalizedInboundMessage): string {
    return message.hasMedia
      ? 'Recibí el archivo. Ya se lo reenvié al tatuador para que lo revise; apenas me confirme el precio te lo paso por acá.'
      : 'Listo, ya le pasé tu consulta al tatuador. Apenas me confirme el precio te lo paso por acá.';
  }

  private buildClientRelay(
    quote: QuoteRequestRow,
    artistReply: string,
  ): string {
    const reply = artistReply.trim();
    const mentionsScheduling =
      /(?:cita|turno|agenda|disponib|horario|se[nñ]a)/i.test(reply);
    const parts = ['Respuesta del tatuador:'];

    if (reply) {
      parts.push(reply);
    } else {
      parts.push('Te envió un archivo con la información.');
    }

    if (!mentionsScheduling) {
      parts.push(
        'Si querés avanzar, contame qué día y horario te queda cómodo y coordinamos la cita.',
      );
    }

    return truncate(parts.join('\n\n'), this.config.bot.maxReplyChars);
  }

  private async sendClientRelay(
    quote: QuoteRequestRow,
    outbound: MessageRow,
    input: QuoteArtistInput,
  ): Promise<void> {
    const contact = this.repos.contacts.getById(quote.contact_id);
    if (!contact) {
      this.repos.messages.markFailed(
        outbound.id,
        'Contacto de la consulta no encontrado',
      );
      await this.replyToArtist(
        `No pude enviarle la respuesta al cliente de ${quote.code}: el contacto ya no existe.`,
      );
      return;
    }

    try {
      const result = await this.waha.sendText({
        chatId: contact.wa_id,
        text: outbound.body,
      });
      this.repos.messages.markSent(outbound.id, {
        waMessageId: result.id,
        status: 'sent',
      });
      this.repos.conversations.touchOutbound(quote.conversation_id, nowIso());
      this.repos.quoteRequests.markDelivered(quote.id, outbound.id);

      if (input.message.hasMedia && input.message.mediaUrl) {
        await this.forwardArtistMediaToClient(input, contact);
      }

      this.logger.info(
        {
          quoteId: quote.id,
          code: quote.code,
          conversationId: quote.conversation_id,
          clientOutboundId: outbound.id,
        },
        'Respuesta del tatuador enviada al cliente',
      );

      await this.replyToArtist(
        `Listo, envié tu respuesta al cliente (${quote.code}).`,
      );
    } catch (error) {
      this.repos.messages.markFailed(outbound.id, errorMessage(error));
      this.logger.error(
        {
          quoteId: quote.id,
          code: quote.code,
          err: errorMessage(error),
        },
        'No se pudo enviar la respuesta del tatuador al cliente',
      );
      throw error;
    }
  }

  private async forwardArtistMediaToClient(
    input: QuoteArtistInput,
    contact: ContactRow,
  ): Promise<void> {
    const url = input.message.mediaUrl;
    if (!url) return;

    try {
      const media = await this.waha.downloadMedia(url, input.signal);
      await this.waha.sendMedia({
        chatId: contact.wa_id,
        data: media.data,
        mimetype: media.mimetype,
        filename: input.message.mediaFilename ?? media.filename,
        caption: 'Respuesta del tatuador',
      });
    } catch (error) {
      this.logger.warn(
        { err: errorMessage(error), chatId: contact.wa_id },
        'No se pudo reenviar el archivo del tatuador al cliente',
      );
      await this.replyToArtist(
        'No pude reenviar el archivo al cliente. Probá enviarlo de nuevo o pasale el dato por texto.',
      );
    }
  }

  private async notifyArtist(
    quote: QuoteRequestRow,
    message: NormalizedInboundMessage,
    contact: ContactRow,
    isUpdate: boolean,
  ): Promise<void> {
    const artistChatId = this.artistChatId;
    if (!artistChatId) return;

    const name =
      contact.display_name ?? contact.push_name ?? contact.phone ?? contact.wa_id;
    const code = quote.code ?? 'sin código';
    const lines = [
      `${isUpdate ? 'Actualización de la consulta' : 'Nueva consulta de cotización'} ${code}`,
      `Cliente: ${name}${contact.phone ? ` (${contact.phone})` : ''}`,
    ];

    if (message.body.trim()) {
      lines.push(`Mensaje: ${truncate(message.body.trim(), 1200)}`);
    } else if (message.hasMedia) {
      lines.push('El cliente envió un archivo sin texto.');
    }

    lines.push(
      '',
      `${ARTIST_SINGLE_PENDING_HINT} Si tenés varias consultas pendientes, incluí el código ${code} en tu respuesta.`,
    );

    const text = truncate(lines.join('\n'), 2400);
    const result = await this.waha.sendText({
      chatId: artistChatId,
      text,
    });

    if (!isUpdate) {
      this.repos.quoteRequests.setArtistNotificationMessageId(
        quote.id,
        result.id,
      );
    }

    if (message.hasMedia) {
      await this.forwardClientMediaToArtist(
        code,
        message,
        artistChatId,
        isUpdate,
      );
    }
  }

  private async forwardClientMediaToArtist(
    code: string,
    message: NormalizedInboundMessage,
    artistChatId: string,
    isUpdate: boolean,
  ): Promise<void> {
    if (!message.mediaUrl) {
      await this.replyToArtist(
        `La consulta ${code} tiene un archivo adjunto, pero WAHA no me dio una URL para descargarlo. Pedile al cliente que lo reenvíe.`,
      );
      return;
    }

    try {
      const media = await this.waha.downloadMedia(message.mediaUrl);
      await this.waha.sendMedia({
        chatId: artistChatId,
        data: media.data,
        mimetype: media.mimetype,
        filename: message.mediaFilename ?? media.filename,
        caption: `${isUpdate ? 'Actualización' : 'Consulta'} ${code}`,
      });
    } catch (error) {
      this.logger.warn(
        { err: errorMessage(error), code },
        'No se pudo reenviar la imagen del cliente al tatuador',
      );
      await this.replyToArtist(
        `No pude reenviar el archivo de la consulta ${code}. Pedile al cliente que lo mande de nuevo.`,
      );
    }
  }

  private async replyToArtist(text: string): Promise<void> {
    if (!this.artistChatId) return;
    try {
      await this.waha.sendText({ chatId: this.artistChatId, text });
    } catch (error) {
      this.logger.warn(
        { err: errorMessage(error) },
        'No se pudo responder al tatuador',
      );
    }
  }
}
