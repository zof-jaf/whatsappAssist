import type { AppConfig } from '../config.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Db } from '../db/database.js';
import type { WahaClient } from '../clients/waha.js';
import type { OllamaClient, OllamaHealth } from '../clients/ollama.js';
import type { JobStats } from '../db/types.js';
import { errorMessage } from '../utils/async.js';
import { nowIso } from '../utils/time.js';

export interface WahaHealth {
  ok: boolean;
  status: string | null;
  me: { id?: string; pushName?: string } | null;
  error?: string;
}

export interface HealthSnapshot {
  checkedAt: string;
  db: { ok: boolean; error?: string };
  waha: WahaHealth;
  ollama: OllamaHealth;
  queue: JobStats;
}

export class HealthService {
  private cached?: { at: number; snapshot: HealthSnapshot };

  constructor(
    private readonly config: AppConfig,
    private readonly db: Db,
    private readonly repos: Repositories,
    private readonly waha: WahaClient,
    private readonly ollama: OllamaClient,
  ) {}

  liveness(): { ok: boolean; error?: string } {
    try {
      this.db.prepare('SELECT 1 AS ok').get();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  async snapshot(force = false): Promise<HealthSnapshot> {
    if (!force && this.cached && Date.now() - this.cached.at < 10_000) {
      return this.cached.snapshot;
    }

    const db = this.liveness();
    const metaSession = this.repos.meta.getJson<{
      status?: string;
      me?: { id?: string; pushName?: string };
    }>('waha.session');

    const [wahaResult, ollama] = await Promise.all([
      this.checkWaha(metaSession),
      this.ollama.health(),
    ]);

    const snapshot: HealthSnapshot = {
      checkedAt: nowIso(),
      db,
      waha: wahaResult,
      ollama,
      queue: this.repos.jobs.stats(),
    };

    this.cached = { at: Date.now(), snapshot };
    return snapshot;
  }

  private async checkWaha(
    metaSession:
      | { status?: string; me?: { id?: string; pushName?: string } }
      | undefined,
  ): Promise<WahaHealth> {
    try {
      const info = await this.waha.getSession();
      const status =
        typeof info.status === 'string'
          ? info.status
          : (metaSession?.status ?? null);
      return {
        ok: true,
        status,
        me: info.me ?? metaSession?.me ?? null,
      };
    } catch (error) {
      return {
        ok: false,
        status: metaSession?.status ?? null,
        me: metaSession?.me ?? null,
        error: errorMessage(error),
      };
    }
  }

  async readiness(): Promise<{ ok: boolean; snapshot: HealthSnapshot }> {
    const snapshot = await this.snapshot(true);
    return {
      ok:
        snapshot.db.ok &&
        snapshot.waha.ok &&
        snapshot.waha.status === 'WORKING' &&
        snapshot.ollama.ok &&
        snapshot.ollama.hasModel,
      snapshot,
    };
  }

  get dashboardUrl(): string {
    return `${this.config.waha.publicUrl}/dashboard`;
  }

  get model(): string {
    return this.config.ollama.model;
  }
}
