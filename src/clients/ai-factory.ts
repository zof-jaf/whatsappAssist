import type { AppConfig } from '../config.js';
import { ConfigError } from '../errors.js';
import type { AiClient } from './ai.js';
import { GroqClient } from './groq.js';
import { OllamaClient } from './ollama.js';

/** Construye el proveedor de IA activo según AI_PROVIDER. */
export function createAiClient(config: AppConfig, fetchImpl: typeof fetch = fetch): AiClient {
  if (config.ai.provider === 'groq') {
    if (!config.ai.groq.apiKey) {
      throw new ConfigError('Falta GROQ_API_KEY para AI_PROVIDER=groq');
    }
    return new GroqClient(
      {
        apiKey: config.ai.groq.apiKey,
        baseUrl: config.ai.groq.baseUrl,
        model: config.ollama.model,
        temperature: config.ollama.temperature,
        numPredict: config.ai.groq.maxTokens,
        timeoutMs: config.ai.groq.timeoutMs,
      },
      fetchImpl,
    );
  }
  return new OllamaClient(config.ollama, fetchImpl);
}
