import 'dotenv/config';
import { loadPlatformConfig } from './config.js';
import { createPool, migrate, ping } from './db.js';

async function main(): Promise<void> {
  const config = loadPlatformConfig();
  const pool = createPool(config);
  await migrate(pool);
  const ok = await ping(pool);
  await pool.end();
  console.log(ok ? 'Migraciones aplicadas. Base de datos lista.' : 'Migraciones aplicadas pero ping falló.');
  process.exit(ok ? 0 : 1);
}

void main().catch((error) => {
  console.error('Error al migrar:', error);
  process.exit(1);
});
