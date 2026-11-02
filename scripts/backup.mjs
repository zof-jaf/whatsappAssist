#!/usr/bin/env node
/**
 * Copia de seguridad consistente de la base SQLite usando la API de backup
 * online de SQLite (no hace falta detener el bot).
 *
 * Uso:
 *   npm run backup
 *   docker compose exec bot node scripts/backup.mjs
 */
import 'dotenv/config';
import Database from 'better-sqlite3';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';

const root = process.cwd();
const dbPath = resolve(root, process.env.DATABASE_PATH || './data/bot.db');
const backupDir = resolve(root, process.env.BACKUP_DIR || './backups');
const retentionDays = Math.max(
  1,
  Number.parseInt(process.env.BACKUP_RETENTION_DAYS || '14', 10) || 14,
);

if (!existsSync(dbPath)) {
  console.error(`No existe la base de datos: ${dbPath}`);
  console.error('Verificá DATABASE_PATH en tu archivo .env.');
  process.exit(1);
}

mkdirSync(backupDir, { recursive: true });

const stamp = new Date()
  .toISOString()
  .replace(/[:.]/g, '-')
  .replace('T', '_')
  .replace('Z', '');
const destination = join(backupDir, `bot-${stamp}.db`);

const db = new Database(dbPath);
db.pragma('busy_timeout = 5000');

try {
  await db.backup(destination);
  const size = statSync(destination).size;
  console.log(`Backup creado: ${destination}`);
  console.log(`Tamaño: ${(size / 1024 / 1024).toFixed(2)} MB`);
} finally {
  db.close();
}

// Retención: elimina backups antiguos generados por este script.
const cutoff = Date.now() - retentionDays * 86_400_000;
let removed = 0;
for (const file of readdirSync(backupDir)) {
  if (!/^bot-.*\.db$/.test(file)) continue;
  const fullPath = join(backupDir, file);
  try {
    if (statSync(fullPath).mtimeMs < cutoff) {
      unlinkSync(fullPath);
      removed += 1;
    }
  } catch (error) {
    console.warn(`No se pudo revisar ${basename(fullPath)}: ${error.message}`);
  }
}

if (removed > 0) {
  console.log(`Backups antiguos eliminados (${retentionDays} días): ${removed}`);
}
