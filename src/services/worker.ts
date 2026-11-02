import type { AppConfig } from '../config.js';
import type { InboundJobRow } from '../db/types.js';
import type { JobRepository } from '../db/repositories/jobs.js';
import type { Logger } from '../logger.js';
import {
  addMilliseconds,
  nowIso,
} from '../utils/time.js';
import {
  backoffDelayMs,
  errorMessage,
  isAbortError,
  sleep,
} from '../utils/async.js';
import { PermanentJobError } from './job-errors.js';

export interface JobProcessor {
  processJob(job: InboundJobRow, signal?: AbortSignal): Promise<void>;
}

export class InboundWorker {
  private running = false;
  private loopPromise?: Promise<void>;
  private current?: { jobId: number; controller: AbortController };

  constructor(
    private readonly config: AppConfig,
    private readonly jobs: JobRepository,
    private readonly processor: JobProcessor,
    private readonly logger: Logger,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;

    const recovered = this.jobs.recoverInterrupted();
    if (recovered > 0) {
      this.logger.warn(
        { recovered },
        'Trabajos interrumpidos recuperados al iniciar',
      );
    }

    this.running = true;
    this.loopPromise = this.loop();
    this.logger.info(
      { pollIntervalMs: this.config.queue.pollIntervalMs },
      'Worker de mensajes iniciado',
    );
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.current?.controller.abort();

    if (this.loopPromise) {
      const timeout = new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.logger.warn('El worker no terminó a tiempo durante el cierre');
          resolve();
        }, 15_000);
        timer.unref?.();
      });
      await Promise.race([this.loopPromise, timeout]);
    }

    this.logger.info('Worker de mensajes detenido');
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let job: InboundJobRow | undefined;

      try {
        job = this.jobs.claimNext();
      } catch (error) {
        this.logger.error(
          { err: errorMessage(error) },
          'No se pudo reclamar un trabajo de la cola',
        );
        await sleep(this.config.queue.pollIntervalMs);
        continue;
      }

      if (!job) {
        await sleep(this.config.queue.pollIntervalMs);
        continue;
      }

      const controller = new AbortController();
      this.current = { jobId: job.id, controller };

      try {
        await this.processor.processJob(job, controller.signal);
        this.jobs.markDone(job.id);
        this.logger.debug(
          { jobId: job.id, attempts: job.attempts },
          'Trabajo completado',
        );
      } catch (error) {
        const interrupted =
          !this.running &&
          (controller.signal.aborted || isAbortError(error));

        if (interrupted) {
          this.jobs.releaseForShutdown(job.id);
          this.logger.info(
            { jobId: job.id },
            'Trabajo devuelto a la cola por cierre ordenado',
          );
        } else {
          const permanent = error instanceof PermanentJobError;
          const final = permanent || job.attempts >= job.max_attempts;
          const retryAt = addMilliseconds(backoffDelayMs(job.attempts));
          const message = errorMessage(error);

          this.jobs.markFailure(job.id, {
            error: message,
            retryAt,
            final,
          });

          const log = final ? this.logger.error : this.logger.warn;
          log.call(
            this.logger,
            {
              jobId: job.id,
              chatId: job.chat_id,
              attempts: job.attempts,
              maxAttempts: job.max_attempts,
              final,
              nextAttemptAt: final ? undefined : retryAt,
              err: message,
            },
            final
              ? 'Trabajo agotó sus intentos'
              : 'Trabajo falló; se reintentará',
          );
        }
      } finally {
        this.current = undefined;
      }
    }
  }

  snapshot(): {
    running: boolean;
    currentJobId: number | null;
    checkedAt: string;
  } {
    return {
      running: this.running,
      currentJobId: this.current?.jobId ?? null,
      checkedAt: nowIso(),
    };
  }
}
