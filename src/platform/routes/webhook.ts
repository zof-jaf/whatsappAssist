import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router, type Request } from 'express';
import { isWahaWebhookEvent } from '../../domain/waha.js';
import type { PlatformDeps } from '../context.js';
import type { BotEngineHost } from '../worker-host.js';

interface RawRequest extends Request {
  rawBody?: Buffer;
}

function validSignature(raw: Buffer | undefined, provided: string | undefined, secret: string): boolean {
  if (!raw || !provided || !secret) return false;
  const algorithm = 'sha512';
  const expected = createHmac(algorithm, secret).update(raw).digest();
  const received = Buffer.from(provided.trim(), 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/**
 * Entrada única de webhooks de WAHA. Resuelve el bot por sesión y delega en su
 * motor. La sesión legada se reenvía al bot single-user para no romperlo.
 */
export function createPlatformWebhookRouter(
  deps: PlatformDeps,
  host: BotEngineHost,
): Router {
  const router = Router();
  const secret = deps.config.PLATFORM_WEBHOOK_HMAC_KEY ?? process.env.WAHA_WEBHOOK_HMAC_KEY;

  router.post('/webhook', async (req: RawRequest, res) => {
    if (secret && !validSignature(req.rawBody, req.get('x-webhook-hmac'), secret)) {
      deps.logger.warn('Webhook de plataforma rechazado: firma inválida');
      res.status(401).json({
        error: { code: 'INVALID_WEBHOOK_SIGNATURE', message: 'Firma de webhook inválida' },
      });
      return;
    }

    const body: unknown = req.body;
    if (!isWahaWebhookEvent(body)) {
      res.status(400).json({
        error: { code: 'INVALID_WEBHOOK_PAYLOAD', message: 'Evento de WAHA inválido' },
      });
      return;
    }

    const session = body.session;
    if (!session) {
      res.status(200).json({ ok: true, status: 'ignored', reason: 'sin_sesion' });
      return;
    }

    const result = await host.handleWebhook(session, body);

    // El bot legado sigue recibiendo los eventos de su sesión "default".
    if (
      result.status === 404 &&
      session === deps.config.LEGACY_SESSION_NAME &&
      deps.config.LEGACY_WEBHOOK_URL
    ) {
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        for (const name of ['x-webhook-hmac', 'x-webhook-hmac-algorithm']) {
          const value = req.get(name);
          if (value) headers[name] = value;
        }
        const forwarded = await fetch(
          `${deps.config.LEGACY_WEBHOOK_URL.replace(/\/$/, '')}/webhook`,
          {
            method: 'POST',
            headers,
            body: req.rawBody ?? JSON.stringify(body),
          },
        );
        const text = await forwarded.text();
        res.status(forwarded.status).type('application/json').send(text);
        return;
      } catch (error) {
        deps.logger.warn({ err: String(error) }, 'No se pudo reenviar el webhook al bot legado');
      }
    }

    res.status(result.status).json(result.body);
  });

  return router;
}
