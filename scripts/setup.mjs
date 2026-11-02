#!/usr/bin/env node
/**
 * Genera un archivo .env con secretos aleatorios a partir de .env.example.
 * Uso:
 *   node scripts/setup.mjs
 *   node scripts/setup.mjs --force
 */
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.cwd());
const examplePath = resolve(root, '.env.example');
const envPath = resolve(root, '.env');
const force = process.argv.includes('--force');

function secret(bytes) {
  return randomBytes(bytes).toString('hex');
}

if (!existsSync(examplePath)) {
  console.error('No se encontró .env.example en la raíz del proyecto.');
  process.exit(1);
}

if (existsSync(envPath) && !force) {
  console.log('\nYa existe un archivo .env. No se modificó.');
  console.log('Si querés regenerarlo (se perderán los secretos actuales):');
  console.log('  npm run setup -- --force\n');
  process.exit(0);
}

const values = {
  __GENERATE_48__: secret(24),
  __GENERATE_64__: secret(32),
  __GENERATE_24__: secret(12),
};

let template = readFileSync(examplePath, 'utf8');
for (const [placeholder, value] of Object.entries(values)) {
  template = template.split(placeholder).join(value);
}

writeFileSync(envPath, template, { encoding: 'utf8', mode: 0o600 });

mkdirSync(resolve(root, 'data'), { recursive: true });
mkdirSync(resolve(root, 'backups'), { recursive: true });

const adminToken = values.__GENERATE_48__;

console.log('\n============================================================');
console.log('  Archivo .env creado correctamente');
console.log('============================================================');
console.log(`\n  ADMIN_TOKEN: ${adminToken}\n`);
console.log('  Guardá este token: lo vas a usar para entrar a /admin.');
console.log('  También quedó guardado en el archivo .env.\n');
console.log('Próximos pasos con Docker:');
console.log('  1. docker compose up -d --build');
console.log('  2. docker compose logs -f ollama-init   (descarga del modelo)');
console.log('  3. Abrí http://localhost:3000/dashboard y escaneá el QR de WhatsApp');
console.log('  4. Abrí http://localhost:4000/admin e ingresá el ADMIN_TOKEN\n');
console.log('Alternativa sin Docker (WAHA y Ollama deben estar corriendo):');
console.log('  npm run dev\n');
