#!/usr/bin/env node
/**
 * Crea y arranca la sesión de WAHA si todavía no existe.
 * Es idempotente: se puede ejecutar varias veces sin efectos secundarios.
 *
 * Uso:
 *   npm run waha:init
 *   docker compose run --rm waha-init
 */
import 'dotenv/config';

const baseUrl = (process.env.WAHA_BASE_URL || 'http://localhost:3000').replace(
  /\/+$/,
  '',
);
const session = process.env.WAHA_SESSION || 'default';
const apiKey = process.env.WAHA_API_KEY;

const headers = { Accept: 'application/json' };
if (apiKey) headers['X-Api-Key'] = apiKey;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...headers,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { response, body };
}

async function waitForWaha(timeoutMs = 90_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/health`, {
        headers,
        signal: AbortSignal.timeout(4000),
      });
      if (response.ok) return true;
    } catch {
      // WAHA todavía no está listo.
    }
    await sleep(2000);
  }
  return false;
}

function statusOf(sessionInfo) {
  return sessionInfo?.status ?? 'UNKNOWN';
}

async function main() {
  console.log(`Esperando a WAHA en ${baseUrl}...`);
  if (!(await waitForWaha())) {
    throw new Error('WAHA no respondió a tiempo. Revisá el contenedor y la API key.');
  }

  // all=true incluye sesiones detenidas o fallidas, que de otro modo no
  // aparecen en el listado y se recrearían sin necesidad.
  const list = await request('/api/sessions?all=true');
  if (!list.response.ok) {
    throw new Error(
      `No se pudieron listar las sesiones (HTTP ${list.response.status}): ${JSON.stringify(
        list.body,
      ).slice(0, 500)}`,
    );
  }

  const sessions = Array.isArray(list.body) ? list.body : [];
  const existing = sessions.find((item) => item.name === session);

  if (!existing) {
    console.log(`Creando sesión "${session}"...`);
    const created = await request('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ name: session, start: true }),
    });

    if (!created.response.ok) {
      throw new Error(
        `No se pudo crear la sesión (HTTP ${created.response.status}): ${JSON.stringify(
          created.body,
        ).slice(0, 800)}`,
      );
    }
    console.log(`Sesión "${session}" creada.`);
  } else {
    const status = statusOf(existing);
    console.log(`La sesión "${session}" ya existe. Estado: ${status}`);

    if (status === 'FAILED') {
      // /start no hace nada cuando la sesión está FAILED (por ejemplo,
      // después de que expiraron los QR). Hay que reiniciarla.
      console.log(`Reiniciando sesión "${session}"...`);
      const restarted = await request(
        `/api/sessions/${encodeURIComponent(session)}/restart`,
        { method: 'POST' },
      );
      if (!restarted.response.ok) {
        throw new Error(
          `No se pudo reiniciar la sesión (HTTP ${restarted.response.status}): ${JSON.stringify(
            restarted.body,
          ).slice(0, 800)}`,
        );
      }
    } else if (status === 'STOPPED') {
      console.log(`Arrancando sesión "${session}"...`);
      const started = await request(
        `/api/sessions/${encodeURIComponent(session)}/start`,
        { method: 'POST' },
      );
      if (!started.response.ok) {
        throw new Error(
          `No se pudo arrancar la sesión (HTTP ${started.response.status}): ${JSON.stringify(
            started.body,
          ).slice(0, 800)}`,
        );
      }
    } else if (status === 'WORKING') {
      console.log('La sesión ya está conectada.');
    } else {
      console.log(
        `La sesión está en estado ${status}; no hace falta reiniciarla.`,
      );
    }
  }

  console.log('');
  console.log('Para escanear el QR abrí el panel del bot:');
  console.log('  http://localhost:4000/admin (pestaña "Conectar WhatsApp")');
  console.log('');
  console.log('También podés usar el dashboard de WAHA:');
  console.log(`  ${baseUrl}/dashboard`);
  console.log('');
  console.log('Cuando el estado sea WORKING, el bot ya puede responder.');
}

main().catch((error) => {
  console.error(`\nError: ${error.message}\n`);
  process.exit(1);
});
