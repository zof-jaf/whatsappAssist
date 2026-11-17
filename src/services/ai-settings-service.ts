import type { AppConfig } from '../config.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Logger } from '../logger.js';
import type { AiClient } from '../clients/ai.js';
import { GroqClient } from '../clients/groq.js';
import { OllamaClient } from '../clients/ollama.js';
import { AnthropicClient } from '../clients/anthropic.js';
import { ValidationError } from '../errors.js';

const SETTINGS_KEY = 'ai.provider_settings';
/** Modelo usado cuando no hay preferencia guardada y el .env aún apunta a Ollama. */
const DEFAULT_GROQ_MODEL = 'llama-3.3-70b-versatile';

export interface AiProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  models: string[];
  docsUrl: string;
  auth: 'bearer' | 'anthropic';
}

/** Proveedores disponibles en el panel. Ollama queda fuera: es local y no aplica en producción. */
export const AI_PROVIDER_PRESETS: readonly AiProviderPreset[] = [
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: [
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'mixtral-8x7b-32768',
      'openai/gpt-oss-20b',
      'openai/gpt-oss-120b',
    ],
    docsUrl: 'https://console.groq.com/keys',
    auth: 'bearer',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'o4-mini'],
    docsUrl: 'https://platform.openai.com/api-keys',
    auth: 'bearer',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      'meta-llama/llama-3.3-70b-instruct',
      'google/gemini-2.0-flash-001',
      'anthropic/claude-3.5-haiku',
    ],
    docsUrl: 'https://openrouter.ai/keys',
    auth: 'bearer',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'],
    docsUrl: 'https://aistudio.google.com/apikey',
    auth: 'bearer',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    models: [
      'claude-3-5-haiku-latest',
      'claude-sonnet-4-20250514',
      'claude-3-7-sonnet-latest',
    ],
    docsUrl: 'https://console.anthropic.com/settings/keys',
    auth: 'anthropic',
  },
];

export interface AiStoredSettings {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  configuredAt?: string;
  lastTestOk?: boolean;
  lastTestAt?: string;
  lastError?: string;
}

export interface AiPublicSettings {
  provider: string;
  providerLabel: string;
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
  configuredAt: string | null;
  lastTestOk: boolean | null;
  lastTestAt: string | null;
  lastError: string | null;
  presets: readonly AiProviderPreset[];
}

export interface AiTestInput {
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

export interface AiTestResult {
  ok: boolean;
  models: string[];
  hasModel: boolean;
  error?: string;
}

function presetFor(provider: string): AiProviderPreset | undefined {
  return AI_PROVIDER_PRESETS.find((item) => item.id === provider);
}

/**
 * Configuración de IA administrada desde el panel y aplicada en caliente.
 * La API key se persiste en `app_meta`, igual que el token de Notion, y nunca
 * se devuelve al navegador (solo `hasApiKey`).
 */
export class AiSettingsService {
  private settings: AiStoredSettings;

  constructor(
    private readonly config: AppConfig,
    private readonly repos: Repositories,
    private readonly logger: Logger,
  ) {
    const stored = this.repos.meta.getJson<AiStoredSettings>(SETTINGS_KEY);
    if (stored?.provider && stored.model) {
      this.settings = stored;
    } else {
      const useGroq = config.ai.provider === 'ollama';
      this.settings = {
        provider: useGroq ? 'groq' : config.ai.provider,
        model: useGroq ? DEFAULT_GROQ_MODEL : config.ollama.model,
        apiKey: config.ai.groq.apiKey,
        baseUrl: undefined,
      };
      this.persist();
    }
  }

  private persist(): void {
    this.repos.meta.setJson(SETTINGS_KEY, this.settings);
  }

  get provider(): string {
    return this.settings.provider;
  }

  get model(): string {
    return this.settings.model;
  }

  snapshot(): AiPublicSettings {
    const preset = presetFor(this.settings.provider);
    return {
      provider: this.settings.provider,
      providerLabel: preset?.label ?? this.settings.provider,
      model: this.settings.model,
      baseUrl: this.settings.baseUrl ?? preset?.baseUrl ?? '',
      hasApiKey: Boolean(this.settings.apiKey),
      configuredAt: this.settings.configuredAt ?? null,
      lastTestOk: this.settings.lastTestOk ?? null,
      lastTestAt: this.settings.lastTestAt ?? null,
      lastError: this.settings.lastError ?? null,
      presets: AI_PROVIDER_PRESETS,
    };
  }

  configure(input: {
    provider: string;
    model: string;
    apiKey?: string;
    baseUrl?: string;
  }): AiPublicSettings {
    const provider = input.provider?.trim().toLowerCase();
    const model = input.model?.trim();
    if (!provider || !model) {
      throw new ValidationError('Elegí un proveedor y un modelo.');
    }
    const preset = presetFor(provider);
    if (!preset && provider !== 'custom') {
      throw new ValidationError('Proveedor de IA desconocido.');
    }

    const apiKey = input.apiKey?.trim() || this.settings.apiKey;
    if (provider !== 'custom' && !apiKey) {
      throw new ValidationError(`Ingresá la API key de ${preset?.label ?? provider}.`);
    }

    this.settings = {
      ...this.settings,
      provider,
      model,
      apiKey,
      baseUrl: input.baseUrl?.trim() || preset?.baseUrl || this.settings.baseUrl,
      configuredAt: new Date().toISOString(),
      lastTestOk: undefined,
      lastTestAt: undefined,
      lastError: undefined,
    };
    this.persist();
    this.logger.info(
      { provider, model },
      'Proveedor de IA actualizado desde el panel',
    );
    return this.snapshot();
  }

  async test(input: AiTestInput = {}): Promise<AiTestResult> {
    const provider = input.provider || this.settings.provider;
    const model = input.model || this.settings.model;
    const apiKey = input.apiKey?.trim() || this.settings.apiKey;
    const preset = presetFor(provider);

    if (provider !== 'ollama' && provider !== 'custom' && !apiKey) {
      throw new ValidationError('Ingresá la API key para probar la conexión.');
    }

    const client = this.buildClient({
      provider,
      model,
      apiKey,
      baseUrl: input.baseUrl || this.settings.baseUrl || preset?.baseUrl,
    });
    const health = await client.health();

    const usesStored =
      (!input.provider || input.provider === this.settings.provider) &&
      (!input.model || input.model === this.settings.model);
    if (usesStored) {
      this.settings.lastTestOk = health.ok;
      this.settings.lastTestAt = new Date().toISOString();
      this.settings.lastError = health.error;
      this.persist();
    }

    return {
      ok: health.ok,
      models: health.models,
      hasModel: health.hasModel,
      ...(health.error ? { error: health.error } : {}),
    };
  }

  async listModels(input: AiTestInput = {}): Promise<{
    models: string[];
    source: 'api' | 'preset';
    error?: string;
  }> {
    const provider = input.provider || this.settings.provider;
    const preset = presetFor(provider);
    const fallback = preset?.models ?? [];

    try {
      const result = await this.test(input);
      if (!result.ok) {
        return { models: fallback, source: 'preset', error: result.error };
      }
      const models = result.models.length ? result.models : fallback;
      return { models, source: result.models.length ? 'api' : 'preset' };
    } catch (error) {
      return {
        models: fallback,
        source: 'preset',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Construye el cliente activo. Se usa en un proxy para permitir cambios en caliente. */
  createClient(fetchImpl: typeof fetch = fetch): AiClient {
    return this.buildClient({
      provider: this.settings.provider,
      model: this.settings.model,
      apiKey: this.settings.apiKey,
      baseUrl: this.settings.baseUrl,
    }, fetchImpl);
  }

  private buildClient(
    input: {
      provider: string;
      model: string;
      apiKey?: string;
      baseUrl?: string;
    },
    fetchImpl: typeof fetch = fetch,
  ): AiClient {
    const preset = presetFor(input.provider);
    if (input.provider === 'ollama') {
      return new OllamaClient(
        { ...this.config.ollama, model: input.model },
        fetchImpl,
      );
    }
    if (input.provider === 'anthropic') {
      return new AnthropicClient(
        {
          apiKey: input.apiKey ?? '',
          baseUrl: input.baseUrl || preset?.baseUrl || 'https://api.anthropic.com/v1',
          model: input.model,
          maxTokens: this.config.ai.groq.maxTokens,
          temperature: this.config.ollama.temperature,
          timeoutMs: this.config.ai.groq.timeoutMs,
        },
        fetchImpl,
      );
    }
    return new GroqClient(
      {
        apiKey: input.apiKey ?? '',
        baseUrl:
          input.baseUrl ||
          preset?.baseUrl ||
          this.config.ai.groq.baseUrl,
        model: input.model,
        temperature: this.config.ollama.temperature,
        numPredict: this.config.ai.groq.maxTokens,
        timeoutMs: this.config.ai.groq.timeoutMs,
      },
      fetchImpl,
    );
  }
}
