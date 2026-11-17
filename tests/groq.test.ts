import { describe, expect, it } from 'vitest';
import { GroqClient, type GroqClientConfig } from '../src/clients/groq.js';
import { createAiClient } from '../src/clients/ai-factory.js';
import { OllamaClient } from '../src/clients/ollama.js';
import { GroqError } from '../src/errors.js';
import { loadConfig } from '../src/config.js';

const config: GroqClientConfig = {
  apiKey: 'gsk_test_key',
  baseUrl: 'https://api.groq.com/openai/v1',
  model: 'openai/gpt-oss-20b',
  temperature: 0.7,
  numPredict: 512,
  timeoutMs: 5000,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('GroqClient', () => {
  it('envía chat completions con Bearer y parsea tokens', async () => {
    const captured: {
      url: string;
      headers: Record<string, string>;
      body: Record<string, unknown>;
    } = { url: '', headers: {}, body: {} };
    const fetchImpl: typeof fetch = async (input, init) => {
      captured.url = String(input);
      captured.headers = init?.headers as Record<string, string>;
      captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({
        model: 'openai/gpt-oss-20b',
        choices: [{ message: { content: '  Hola desde Groq  ' } }],
        usage: { prompt_tokens: 12, completion_tokens: 5 },
      });
    };

    const client = new GroqClient(config, fetchImpl);
    const result = await client.chat([{ role: 'user', content: 'hola' }], { numPredict: 128 });

    expect(result.content).toBe('Hola desde Groq');
    expect(result.promptTokens).toBe(12);
    expect(result.completionTokens).toBe(5);
    expect(result.model).toBe('openai/gpt-oss-20b');
    expect(captured.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(captured.headers.Authorization).toBe('Bearer gsk_test_key');
    expect(captured.body.max_tokens).toBe(128);
    expect(captured.body.model).toBe('openai/gpt-oss-20b');
  });

  it('informa salud y disponibilidad del modelo', async () => {
    const fetchImpl: typeof fetch = async () =>
      json({ data: [{ id: 'openai/gpt-oss-20b' }, { id: 'mixtral-8x7b' }] });
    const client = new GroqClient(config, fetchImpl);
    const health = await client.health();
    expect(health.ok).toBe(true);
    expect(health.hasModel).toBe(true);
    expect(health.models).toContain('openai/gpt-oss-20b');
  });

  it('marca hasModel=false si el modelo no está en la cuenta', async () => {
    const fetchImpl: typeof fetch = async () => json({ data: [{ id: 'otro-modelo' }] });
    const health = await new GroqClient(config, fetchImpl).health();
    expect(health.ok).toBe(true);
    expect(health.hasModel).toBe(false);
  });

  it('reporta fallos de red identificando al proveedor', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('fetch failed');
    };
    const health = await new GroqClient(config, fetchImpl).health();
    expect(health.ok).toBe(false);
    expect(health.error).toMatch(/Groq/);
  });

  it('lanza GroqError en errores de autenticación sin reintentar', async () => {
    const fetchImpl: typeof fetch = async () => json({ error: { message: 'Invalid API Key' } }, 401);
    await expect(new GroqClient(config, fetchImpl).chat([])).rejects.toBeInstanceOf(GroqError);
  });
});

describe('selector de proveedor de IA', () => {
  it('usa Groq cuando AI_PROVIDER=groq', () => {
    const appConfig = loadConfig({
      NODE_ENV: 'test',
      ADMIN_TOKEN: 'test-admin-token-1234567890',
      AI_PROVIDER: 'groq',
      GROQ_API_KEY: 'gsk_test_key',
    });
    expect(createAiClient(appConfig)).toBeInstanceOf(GroqClient);
    expect(appConfig.ollama.model).toBe('openai/gpt-oss-20b');
  });

  it('usa Ollama por defecto', () => {
    const appConfig = loadConfig({
      NODE_ENV: 'test',
      ADMIN_TOKEN: 'test-admin-token-1234567890',
    });
    expect(createAiClient(appConfig)).toBeInstanceOf(OllamaClient);
  });

  it('exige GROQ_API_KEY con AI_PROVIDER=groq', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'test',
        ADMIN_TOKEN: 'test-admin-token-1234567890',
        AI_PROVIDER: 'groq',
      }),
    ).toThrow(/GROQ_API_KEY/);
  });
});
