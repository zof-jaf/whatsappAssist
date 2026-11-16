import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { errorMessage } from '../utils/async.js';
import { truncate } from '../utils/text.js';

const CACHE_TTL_MS = 60_000;

/**
 * Lee `formato_respuestas.md` y lo mantiene en caché por un minuto. Así el
 * estudio puede ajustar las respuestas sin reiniciar el bot.
 */
export class ResponseGuideService {
  private cached: { content: string | null; at: number } | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  async get(): Promise<string | null> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < CACHE_TTL_MS) {
      return this.cached.content;
    }

    const path = resolve(
      process.cwd(),
      this.config.tattoo.responseGuidePath,
    );

    try {
      const raw = await readFile(path, 'utf8');
      const content = truncate(
        raw.trim(),
        this.config.tattoo.responseGuideMaxChars,
        '',
      ).trim();

      this.cached = { content: content || null, at: now };
      this.lastError = null;
      return this.cached.content;
    } catch (error) {
      const message = errorMessage(error);
      if (message !== this.lastError) {
        this.lastError = message;
        this.logger.warn(
          { path, err: message },
          'No se pudo leer la guía de respuestas; se continúa sin ella',
        );
      }
      this.cached = { content: null, at: now };
      return null;
    }
  }

  /** Fuerza a releer el archivo en la próxima consulta. */
  invalidate(): void {
    this.cached = null;
  }
}
