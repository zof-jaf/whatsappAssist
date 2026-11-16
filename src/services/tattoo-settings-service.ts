import type { AppConfig } from '../config.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Logger } from '../logger.js';
import {
  normalizeColombianPhone,
  phoneFromArtistChatId,
  TATTOO_COUNTRY_CODE,
  type NormalizedPhone,
} from '../domain/phones.js';
import { ValidationError } from '../errors.js';
import { normalizeChatId } from '../utils/text.js';

const META_KEY = 'tattoo.artist_phone';

export type TattooArtistSource = 'dashboard' | 'env' | 'none';

export interface TattooArtistSettings {
  configured: boolean;
  /** Dígitos locales sin código de país. */
  phone: string | null;
  displayPhone: string | null;
  chatId: string | null;
  artistName: string;
  source: TattooArtistSource;
  countryCode: string;
}

/**
 * Número del tatuador configurable desde el panel.
 *
 * El valor del panel se guarda en `app_meta` y se aplica a `config` en caliente,
 * sin reiniciar. `TATTOO_ARTIST_CHAT_ID` queda como respaldo para despliegues
 * que prefieren fijarlo por `.env`.
 */
export class TattooSettingsService {
  private readonly envChatId: string | null;

  constructor(
    private readonly config: AppConfig,
    private readonly repos: Repositories,
    private readonly logger: Logger,
  ) {
    this.envChatId = config.tattoo.artistChatId;
  }

  /** Aplica el número guardado en la base al arrancar el bot. */
  load(): void {
    const stored = this.repos.meta.get(META_KEY);
    if (!stored) return;

    const parsed = normalizeColombianPhone(stored);
    if (!parsed) {
      this.repos.meta.delete(META_KEY);
      this.logger.warn(
        { stored },
        'El número del tatuador guardado no es válido; se ignora',
      );
      return;
    }

    this.apply(parsed);
    this.logger.info(
      { chatId: parsed.chatId },
      'Número del tatuador cargado desde el panel',
    );
  }

  get chatId(): string | null {
    return this.config.tattoo.artistChatId;
  }

  get artistName(): string {
    return this.config.tattoo.artistName;
  }

  get source(): TattooArtistSource {
    if (this.repos.meta.get(META_KEY)) return 'dashboard';
    return this.envChatId ? 'env' : 'none';
  }

  get phone(): string | null {
    const stored = this.repos.meta.get(META_KEY);
    if (stored) {
      const parsed = normalizeColombianPhone(stored);
      if (parsed) return parsed.phone;
    }
    return phoneFromArtistChatId(this.envChatId);
  }

  get displayPhone(): string | null {
    const phone = this.phone;
    if (!phone) return null;
    return normalizeColombianPhone(phone)?.display ?? null;
  }

  /** Texto para el panel: formato +57 o, si el .env usa otro país, el ID. */
  get display(): string | null {
    const formatted = this.displayPhone;
    if (formatted) return formatted;
    const chatId = this.chatId;
    if (!chatId) return null;
    return chatId.replace(/@c\.us$/i, '') || chatId;
  }

  snapshot(): TattooArtistSettings {
    return {
      configured: Boolean(this.chatId),
      phone: this.phone,
      displayPhone: this.display,
      chatId: this.chatId,
      artistName: this.artistName,
      source: this.source,
      countryCode: TATTOO_COUNTRY_CODE,
    };
  }

  /** Guarda y aplica un número colombiano sin código de país. */
  save(value: string): TattooArtistSettings {
    const parsed = normalizeColombianPhone(value);
    if (!parsed) {
      throw new ValidationError(
        'Ingresá un número colombiano de 10 dígitos, sin código de país. Ejemplo: 300 123 4567.',
      );
    }

    this.repos.meta.set(META_KEY, parsed.phone);
    this.apply(parsed);
    this.logger.info(
      { chatId: parsed.chatId },
      'Número del tatuador actualizado desde el panel',
    );

    return this.snapshot();
  }

  /** Quita el valor del panel y vuelve al de `.env`, si existe. */
  clear(): TattooArtistSettings {
    this.repos.meta.delete(META_KEY);
    this.config.tattoo.artistChatId = this.envChatId;
    if (this.envChatId) this.allow(this.envChatId);

    this.logger.info(
      { chatId: this.config.tattoo.artistChatId },
      'Número del tatuador quitado desde el panel',
    );

    return this.snapshot();
  }

  private apply(parsed: NormalizedPhone): void {
    this.config.tattoo.artistChatId = parsed.chatId;
    this.allow(parsed.chatId);
  }

  private allow(chatId: string): void {
    // Sin lista blanca todos los chats están permitidos. Con lista blanca, el
    // tatuador debe poder escribir aunque se configure en caliente.
    if (this.config.bot.allowedChatIds.size === 0) return;
    const normalized = normalizeChatId(chatId);
    if (normalized) this.config.bot.allowedChatIds.add(normalized);
  }
}
