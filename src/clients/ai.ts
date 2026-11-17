import type { ChatMessage } from '../domain/prompt.js';

/** Contrato común de los proveedores de IA (Ollama local / Groq cloud). */
export interface AiChatOptions {
  temperature?: number;
  numPredict?: number;
  numCtx?: number;
  signal?: AbortSignal;
}

export interface AiChatResult {
  content: string;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number;
}

export interface AiHealth {
  ok: boolean;
  models: string[];
  hasModel: boolean;
  error?: string;
}

export interface AiClient {
  chat(messages: ChatMessage[], options?: AiChatOptions): Promise<AiChatResult>;
  health(): Promise<AiHealth>;
}
