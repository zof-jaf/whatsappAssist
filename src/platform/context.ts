import type { PlatformConfig } from './config.js';
import type { DbPool } from './db.js';
import type { WahaAdminClient } from './waha-admin.js';
import type { createRateLimiter } from './auth.js';
import type { BotEngineHost } from './worker-host.js';

export interface PlatformDeps {
  config: PlatformConfig;
  db: DbPool;
  waha: WahaAdminClient;
  engines: BotEngineHost;
  rateLimiter: ReturnType<typeof createRateLimiter>;
  logger: {
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
  };
}
