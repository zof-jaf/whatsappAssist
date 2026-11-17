#!/usr/bin/env node
/**
 * Preflight de despliegue. Verifica artefactos, configuración de Railway y
 * variables de entorno ANTES de subir, para no fallar en el deploy.
 *
 * Uso: npm run build && npm run verify:deploy
 * En local lee .env; en Railway/Fly/etc. usa las variables inyectadas.
 */
import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
let failures = 0;

function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
}

function read(relativePath) {
  try {
    return readFileSync(resolve(root, relativePath), 'utf8');
  } catch {
    return null;
  }
}

console.log('== Artefactos compilados ==');
check('dist/index.js', existsSync(resolve(root, 'dist/index.js')));
check('dist/platform/index.js', existsSync(resolve(root, 'dist/platform/index.js')));
check('public/platform/index.html', existsSync(resolve(root, 'public/platform/index.html')));
check('public/platform/app.js', existsSync(resolve(root, 'public/platform/app.js')));
check('public/platform/styles.css', existsSync(resolve(root, 'public/platform/styles.css')));

console.log('\n== Dockerfile ==');
const dockerfile = read('Dockerfile') ?? '';
check('sin instrucción de montaje (Railway lo rechaza)', !/^\s*VOLUME\s/im.test(dockerfile));
check('healthcheck respeta PORT dinámico', dockerfile.includes('process.env.PORT'));
check('CMD/ENTRYPOINT presentes', /ENTRYPOINT/.test(dockerfile) && /CMD/.test(dockerfile));

console.log('\n== railway.json ==');
let railway = null;
try {
  railway = JSON.parse(read('railway.json') ?? 'null');
} catch (error) {
  check('JSON válido', false, String(error));
}
if (railway) {
  check('JSON válido', true);
  check('builder DOCKERFILE', railway.build?.builder === 'DOCKERFILE');
  check('startCommand apunta a la plataforma',
    String(railway.deploy?.startCommand ?? '').includes('dist/platform/index.js'),
    railway.deploy?.startCommand);
  check('healthcheckPath /health', railway.deploy?.healthcheckPath === '/health');
}

console.log('\n== Variables de entorno ==');
const env = process.env;
for (const name of ['DATABASE_URL', 'SESSION_SECRET', 'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'WAHA_BASE_URL']) {
  check(`${name} definida`, Boolean(env[name]?.trim()));
}
check('DATABASE_URL es postgres', /^postgres(ql)?:\/\//.test(env.DATABASE_URL ?? ''));
check('SESSION_SECRET >= 16 caracteres', (env.SESSION_SECRET ?? '').length >= 16);
check('ADMIN_PASSWORD >= 12 caracteres', (env.ADMIN_PASSWORD ?? '').length >= 12);
check('ADMIN_EMAIL válido', /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(env.ADMIN_EMAIL ?? ''));
check('WAHA_BASE_URL es http(s)', /^https?:\/\//.test(env.WAHA_BASE_URL ?? ''));
if (env.AI_PROVIDER === 'groq') {
  check('GROQ_API_KEY definida', Boolean(env.GROQ_API_KEY?.trim()));
  check('GROQ_MODEL definido', Boolean(env.GROQ_MODEL?.trim()));
  check('GROQ_BASE_URL es http(s)', /^https?:\/\//.test(env.GROQ_BASE_URL ?? ''));
}
if (env.NODE_ENV === 'production' || !env.NODE_ENV) {
  check('COOKIE_SECURE=true en producción', env.COOKIE_SECURE === 'true');
  check('APP_BASE_URL usa HTTPS', /^https:\/\//.test(env.APP_BASE_URL ?? ''));
}

console.log(failures === 0 ? '\nPREFLIGHT OK — listo para desplegar' : `\nPREFLIGHT FALLÓ: ${failures} problema(s)`);
process.exit(failures === 0 ? 0 : 1);
