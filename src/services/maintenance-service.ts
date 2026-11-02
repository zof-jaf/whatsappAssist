import type { AppConfig } from '../config.js';
import type { Db } from '../db/database.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Logger } from '../logger.js';
import { errorMessage } from '../utils/async.js';

export class MaintenanceService {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly config: AppConfig,
    private readonly db: Db,
    private readonly repos: Repositories,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.run();
    this.timer = setInterval(() => {
      void this.run();
    }, 6 * 60 * 60 * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const eventCutoff = new Date(
        Date.now() - this.config.db.eventRetentionDays * 86_400_000,
      ).toISOString();
      const jobCutoff = new Date(
        Date.now() - this.config.db.jobRetentionDays * 86_400_000,
      ).toISOString();

      const events = this.repos.events.prune(eventCutoff);
      const jobs = this.repos.jobs.pruneFinished(jobCutoff);

      try {
        this.db.pragma('wal_checkpoint(PASSIVE)');
      } catch {
        // El checkpoint es best-effort.
      }

      if (events > 0 || jobs > 0) {
        this.logger.info(
          { eventsDeleted: events, jobsDeleted: jobs },
          'Mantenimiento de base de datos completado',
        );
      }
    } catch (error) {
      this.logger.warn(
        { err: errorMessage(error) },
        'Falló la tarea de mantenimiento',
      );
    } finally {
      this.running = false;
    }
  }
}
