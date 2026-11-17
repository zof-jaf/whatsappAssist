import type { AiChatOptions, AiChatResult, AiClient, AiHealth } from './ai.js';
import type { ChatMessage } from '../domain/prompt.js';

/**
 * Proxy que resuelve el proveedor activo en cada llamada. Permite que los
 * cambios de proveedor/modelo desde el panel se apliquen sin reiniciar.
 */
export class DynamicAiClient implements AiClient {
  constructor(private readonly resolve: () => AiClient) {}

  chat(messages: ChatMessage[], options?: AiChatOptions): Promise<AiChatResult> {
    return this.resolve().chat(messages, options);
  }

  health(): Promise<AiHealth> {
    return this.resolve().health();
  }
}
