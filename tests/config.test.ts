import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ConfigError } from '../src/errors.js';

const REQUIRED = {
  ADMIN_TOKEN: 'token-de-prueba-1234567890',
};

describe('loadConfig', () => {
  it('aplica valores por defecto razonables', () => {
    const config = loadConfig(REQUIRED);

    expect(config.env).toBe('development');
    expect(config.server.port).toBe(4000);
    expect(config.db.path).toBe('./data/bot.db');
    expect(config.waha.baseUrl).toBe('http://localhost:3000');
    expect(config.waha.session).toBe('default');
    expect(config.ollama.baseUrl).toBe('http://localhost:11434');
    expect(config.ollama.model).toBe('llama3.2:3b');
    expect(config.bot.name).toBe('Asistente');
    expect(config.bot.enabled).toBe(true);
    expect(config.bot.ignoreGroups).toBe(true);
    expect(config.bot.summary.enabled).toBe(true);
    expect(config.admin.enabled).toBe(true);
    expect(config.logging.pretty).toBe(true);
  });

  it('exige un ADMIN_TOKEN de al menos 16 caracteres', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ ADMIN_TOKEN: 'corto' })).toThrow(ConfigError);
  });

  it('rechaza una zona horaria inválida', () => {
    expect(() =>
      loadConfig({ ...REQUIRED, TIMEZONE: 'Marte/Olympus' }),
    ).toThrow(/TIMEZONE inválida/);
  });

  it('normaliza booleanos habituales', () => {
    const config = loadConfig({
      ...REQUIRED,
      BOT_ENABLED: 'no',
      SEND_SEEN: '1',
      TYPING_INDICATOR: 'off',
      LOG_PRETTY: 'false',
      TRUST_PROXY: 'sí',
    });

    expect(config.bot.enabled).toBe(false);
    expect(config.waha.sendSeen).toBe(true);
    expect(config.waha.typingIndicator).toBe(false);
    expect(config.logging.pretty).toBe(false);
    expect(config.server.trustProxy).toBe(true);
  });

  it('convierte ALLOWED_CHAT_IDS en un Set normalizado', () => {
    const config = loadConfig({
      ...REQUIRED,
      ALLOWED_CHAT_IDS:
        '5491111111111@c.us, 5492222222222@C.US, +54 9 11 3333-4444',
    });

    expect(config.bot.allowedChatIds.size).toBe(3);
    expect(config.bot.allowedChatIds.has('5491111111111@c.us')).toBe(true);
    expect(config.bot.allowedChatIds.has('5492222222222@c.us')).toBe(true);
    expect(config.bot.allowedChatIds.has('5491133334444@c.us')).toBe(true);
  });

  it('recorta barras finales de las URLs', () => {
    const config = loadConfig({
      ...REQUIRED,
      WAHA_BASE_URL: 'http://waha:3000///',
      OLLAMA_BASE_URL: 'http://ollama:11434/',
    });

    expect(config.waha.baseUrl).toBe('http://waha:3000');
    expect(config.ollama.baseUrl).toBe('http://ollama:11434');
  });

  it('valida la sesión de WAHA', () => {
    expect(() =>
      loadConfig({ ...REQUIRED, WAHA_SESSION: 'sesión con espacios' }),
    ).toThrow(ConfigError);
  });

  it('en producción desactiva el logger pretty por defecto', () => {
    const config = loadConfig({ ...REQUIRED, NODE_ENV: 'production' });
    expect(config.logging.pretty).toBe(false);
    expect(config.isProduction).toBe(true);
  });
});
