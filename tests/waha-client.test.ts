import { describe, expect, it } from 'vitest';
import { WahaClient } from '../src/clients/waha.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig({
  NODE_ENV: 'test',
  ADMIN_TOKEN: 'test-admin-token-1234567890',
  WAHA_BASE_URL: 'http://waha:3000',
  WAHA_SESSION: 'default',
  WAHA_API_KEY: 'secret-key',
}).waha;

interface FetchCall {
  url: string;
  init: Parameters<typeof fetch>[1];
}

function fakeFetch(body: unknown, status = 200): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('WahaClient', () => {
  it('consulta el QR en el endpoint de la sesión vigente', async () => {
    const { fetchImpl, calls } = fakeFetch({
      mimetype: 'image/png',
      data: 'base64-qr',
    });
    const client = new WahaClient(config, fetchImpl);

    const qr = await client.getQr();

    expect(qr).toEqual({ mimetype: 'image/png', data: 'base64-qr' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://waha:3000/api/default/auth/qr');
    expect(calls[0]?.init?.method ?? 'GET').toBe('GET');

    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('x-api-key')).toBe('secret-key');
    expect(headers.get('accept')).toBe('application/json');
  });

  it('crea, arranca y reinicia la sesión con los endpoints correctos', async () => {
    const { fetchImpl, calls } = fakeFetch({
      name: 'default',
      status: 'STARTING',
    });
    const client = new WahaClient(config, fetchImpl);

    await client.createSession();
    await client.startSession();
    await client.restartSession();

    expect(calls.map((call) => call.url)).toEqual([
      'http://waha:3000/api/sessions',
      'http://waha:3000/api/sessions/default/start',
      'http://waha:3000/api/sessions/default/restart',
    ]);
    expect(calls.map((call) => call.init?.method)).toEqual([
      'POST',
      'POST',
      'POST',
    ]);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      name: 'default',
      start: true,
    });
  });

  it('rechaza un QR vacío', async () => {
    const { fetchImpl } = fakeFetch({ mimetype: 'image/png', data: '' });
    const client = new WahaClient(config, fetchImpl);

    await expect(client.getQr()).rejects.toThrow('QR vacío');
  });
});
