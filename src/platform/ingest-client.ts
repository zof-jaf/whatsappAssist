import type { PlatformConfig } from './config.js';

export interface PlatformEvent {
  type: 'message_in' | 'message_out';
  chatId?: string;
  messageId?: string;
  chars?: number;
  session?: string;
}

export interface IngestClient {
  postEvent(apiKey: string, event: PlatformEvent): Promise<boolean>;
}

/**
 * Cliente de eventos hacia la plataforma. Cada motor de bot usa SU API key
 * (guardada cifrada en Postgres) para escribir sus propios eventos de uso.
 * Nunca lanza: un fallo de reportes no debe detener la conversación.
 */
export function createIngestClient(
  config: PlatformConfig,
  logger?: { warn: (obj: unknown, msg?: string) => void },
): IngestClient {
  const url = `${config.PLATFORM_BASE_URL.replace(/\/$/, '')}/api/ingest/events`;

  return {
    async postEvent(apiKey, event) {
      if (!apiKey) return false;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.WAHA_REQUEST_TIMEOUT_MS);
      timer.unref?.();
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Api-Key': apiKey,
          },
          body: JSON.stringify(event),
          signal: controller.signal,
        });
        return response.ok;
      } catch (error) {
        logger?.warn(
          { err: String(error), url },
          'No se pudo enviar el evento de uso a la plataforma',
        );
        return false;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
