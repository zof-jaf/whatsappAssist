import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import type { Logger } from '../logger.js';

export interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

export function createWebhookHmacMiddleware(
  secret: string | undefined,
  logger: Logger,
): RequestHandler {
  return (req, res, next) => {
    // El middleware cubre toda la cadena de Express; solo debe proteger el webhook.
    if (req.path !== '/webhook') {
      next();
      return;
    }

    if (!secret) {
      next();
      return;
    }

    const rawBody = (req as RawBodyRequest).rawBody;
    const provided = req.get('x-webhook-hmac')?.trim().toLowerCase();
    const algorithm = (
      req.get('x-webhook-hmac-algorithm') ?? 'sha512'
    ).toLowerCase();

    if (!rawBody || !provided || algorithm !== 'sha512') {
      logger.warn(
        {
          hasBody: Boolean(rawBody),
          hasSignature: Boolean(provided),
          algorithm,
        },
        'Webhook rechazado: firma HMAC ausente o algoritmo inválido',
      );
      res.status(401).json({
        error: {
          code: 'INVALID_WEBHOOK_SIGNATURE',
          message: 'Firma de webhook inválida',
        },
      });
      return;
    }

    const expected = createHmac('sha512', secret).update(rawBody).digest('hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    const providedBuffer = Buffer.from(provided, 'hex');

    if (
      expectedBuffer.length !== providedBuffer.length ||
      !timingSafeEqual(expectedBuffer, providedBuffer)
    ) {
      logger.warn('Webhook rechazado: firma HMAC incorrecta');
      res.status(401).json({
        error: {
          code: 'INVALID_WEBHOOK_SIGNATURE',
          message: 'Firma de webhook inválida',
        },
      });
      return;
    }

    next();
  };
}
