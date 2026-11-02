import { afterEach, describe, expect, it } from 'vitest';
import { InboundWorker } from '../src/services/worker.js';
import { PermanentJobError } from '../src/services/job-errors.js';
import {
  createTestContext,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;
let worker: InboundWorker | undefined;

afterEach(async () => {
  await worker?.stop();
  worker = undefined;
  ctx.close();
});

function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
  intervalMs = 20,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('Timeout esperando la condición'));
      }
    }, intervalMs);
  });
}

function context(): TestContext {
  ctx = createTestContext({
    QUEUE_POLL_INTERVAL_MS: '100',
    SUMMARY_ENABLED: 'false',
  });
  return ctx;
}

describe('InboundWorker', () => {
  it('procesa trabajos pendientes y los marca como completados', async () => {
    const app = context();
    const processed: number[] = [];
    worker = new InboundWorker(
      app.config,
      app.repos.jobs,
      {
        processJob: async (job) => {
          processed.push(job.id);
        },
      },
      app.logger,
    );

    app.repos.jobs.enqueue({
      waMessageId: 'wamid-1',
      chatId: 'chat-a',
      payload: '{}',
      maxAttempts: 3,
    });

    worker.start();
    await waitFor(() => app.repos.jobs.stats().done === 1);

    expect(processed).toEqual([1]);
    expect(app.repos.jobs.stats()).toMatchObject({
      pending: 0,
      processing: 0,
      done: 1,
      failed: 0,
    });
  });

  it('marca como fallido un error permanente sin reintentar', async () => {
    const app = context();
    worker = new InboundWorker(
      app.config,
      app.repos.jobs,
      {
        processJob: async () => {
          throw new PermanentJobError('payload inválido');
        },
      },
      app.logger,
    );

    app.repos.jobs.enqueue({
      waMessageId: 'wamid-1',
      chatId: 'chat-a',
      payload: '{}',
      maxAttempts: 3,
    });

    worker.start();
    await waitFor(() => app.repos.jobs.stats().failed === 1);

    const failed = app.repos.jobs.listFailed(1)[0];
    expect(failed?.attempts).toBe(1);
    expect(failed?.last_error).toBe('payload inválido');
  });

  it('reintenta errores transitorios con backoff', async () => {
    const app = context();
    worker = new InboundWorker(
      app.config,
      app.repos.jobs,
      {
        processJob: async () => {
          throw new Error('fallo transitorio');
        },
      },
      app.logger,
    );

    app.repos.jobs.enqueue({
      waMessageId: 'wamid-1',
      chatId: 'chat-a',
      payload: '{}',
      maxAttempts: 3,
    });

    worker.start();
    await waitFor(() => {
      const job = app.repos.jobs.listFailed(1)[0];
      return Boolean(job) || app.repos.jobs.stats().pending === 1;
    });

    const job = app.db
      .prepare('SELECT * FROM inbound_jobs WHERE wa_message_id = ?')
      .get('wamid-1') as {
      status: string;
      attempts: number;
      last_error: string | null;
    };
    expect(job.status).toBe('pending');
    expect(job.attempts).toBe(1);
    expect(job.last_error).toBe('fallo transitorio');
  });

  it('devuelve a la cola el trabajo en curso durante un cierre ordenado', async () => {
    const app = context();
    let started = false;

    worker = new InboundWorker(
      app.config,
      app.repos.jobs,
      {
        processJob: (job, signal) =>
          new Promise<void>((_resolve, reject) => {
            started = true;
            expect(job.id).toBe(1);
            signal?.addEventListener('abort', () => {
              reject(new Error('abortado'));
            });
          }),
      },
      app.logger,
    );

    app.repos.jobs.enqueue({
      waMessageId: 'wamid-1',
      chatId: 'chat-a',
      payload: '{}',
      maxAttempts: 3,
    });

    worker.start();
    await waitFor(() => started);
    await worker.stop();
    const stopped = worker;
    worker = undefined;

    expect(stopped.isRunning).toBe(false);
    const job = app.repos.jobs.getById(1);
    expect(job?.status).toBe('pending');
    expect(job?.attempts).toBe(0);
    expect(job?.locked_at).toBeNull();
  });

  it('recupera trabajos que quedaron en proceso al reiniciar', async () => {
    const app = context();
    app.repos.jobs.enqueue({
      waMessageId: 'wamid-1',
      chatId: 'chat-a',
      payload: '{}',
      maxAttempts: 3,
    });
    app.repos.jobs.claimNext();

    worker = new InboundWorker(
      app.config,
      app.repos.jobs,
      {
        processJob: async () => Promise.resolve(),
      },
      app.logger,
    );

    worker.start();
    await waitFor(() => app.repos.jobs.stats().done === 1);

    const job = app.repos.jobs.getById(1);
    expect(job?.attempts).toBe(2);
    expect(job?.last_error).toBeNull();
  });
});
