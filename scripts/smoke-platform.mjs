#!/usr/bin/env node
/** Smoke test de la plataforma: /health, /ready y SPA. Requiere la app arrancada. */
const base = (process.env.PLATFORM_BASE_URL ?? 'http://127.0.0.1:4001').replace(/\/$/, '');
const checks = [
  ['/health', (data) => data?.status === 'ok' && typeof data?.engines === 'number'],
  ['/ready', (data) => data?.status === 'ready' && data?.db === 'up' && data?.waha === 'up'],
];

let failed = 0;
for (const [path, validate] of checks) {
  try {
    const response = await fetch(`${base}${path}`);
    const data = await response.json();
    const ok = response.ok && validate(data);
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${path} -> ${response.status}`, data);
    if (!ok) failed += 1;
  } catch (error) {
    console.log(`FAIL ${path} -> ${error instanceof Error ? error.message : error}`);
    failed += 1;
  }
}

try {
  const response = await fetch(`${base}/`);
  const html = await response.text();
  const ok = response.ok && html.includes('id="app-view"');
  console.log(`${ok ? 'OK  ' : 'FAIL'} / -> ${response.status} (SPA)`);
  if (!ok) failed += 1;
} catch (error) {
  console.log(`FAIL / -> ${error instanceof Error ? error.message : error}`);
  failed += 1;
}

process.exit(failed === 0 ? 0 : 1);
