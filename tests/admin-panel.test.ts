import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestContext, type TestContext } from './helpers.js';

const PASSWORD = 'test-admin-token-1234567890';

let ctx: TestContext;

beforeEach(() => {
  ctx = createTestContext();
});

afterEach(() => {
  ctx.close();
});

async function login(username = 'admin', password = PASSWORD) {
  return request(ctx.app)
    .post('/api/admin/auth/login')
    .send({ username, password });
}

describe('panel de administración · gestión por usuario', () => {
  it('valida usuario y contraseña y establece una sesión', async () => {
    const bad = await login('admin', 'clave-incorrecta');
    expect(bad.status).toBe(400);

    const ok = await login();
    expect(ok.status).toBe(200);
    expect(ok.body.user.username).toBe('admin');
    expect(ok.body.user.role).toBe('admin');

    const cookie = ok.headers['set-cookie'];
    expect(cookie?.[0]).toContain('HttpOnly');

    const me = await request(ctx.app).get('/api/admin/auth/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body.user.username).toBe('admin');

    const protectedRoute = await request(ctx.app)
      .get('/api/admin/overview')
      .set('Cookie', cookie);
    expect(protectedRoute.status).toBe(200);

    await request(ctx.app).post('/api/admin/auth/logout').set('Cookie', cookie);
    const afterLogout = await request(ctx.app)
      .get('/api/admin/auth/me')
      .set('Cookie', cookie);
    expect(afterLogout.status).toBe(401);
  });

  it('permite crear usuarios con contraseña propia', async () => {
    const { headers } = await login();
    const created = await request(ctx.app)
      .post('/api/admin/users')
      .set('Cookie', headers['set-cookie'])
      .send({
        username: 'tatuador',
        password: 'clave-segura-123',
        fullName: 'Ana Tatuadora',
        role: 'user',
      });
    expect(created.status).toBe(201);

    const userLogin = await login('tatuador', 'clave-segura-123');
    expect(userLogin.status).toBe(200);
    expect(userLogin.body.user.fullName).toBe('Ana Tatuadora');
  });
});

describe('panel de administración · catálogos y agenda', () => {
  async function auth() {
    const { headers } = await login();
    return headers['set-cookie'];
  }

  it('hace CRUD de artistas', async () => {
    const cookie = await auth();
    const create = await request(ctx.app)
      .post('/api/admin/artists')
      .set('Cookie', cookie)
      .send({ name: 'Bruno', specialty: 'Blackwork', active: true });
    expect(create.status).toBe(201);
    const id = create.body.artist.id;

    const list = await request(ctx.app).get('/api/admin/artists').set('Cookie', cookie);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].name).toBe('Bruno');

    const patch = await request(ctx.app)
      .patch(`/api/admin/artists/${id}`)
      .set('Cookie', cookie)
      .send({ specialty: 'Dotwork' });
    expect(patch.body.artist.specialty).toBe('Dotwork');

    const removed = await request(ctx.app)
      .delete(`/api/admin/artists/${id}`)
      .set('Cookie', cookie);
    expect(removed.status).toBe(200);
    const empty = await request(ctx.app).get('/api/admin/artists').set('Cookie', cookie);
    expect(empty.body.items).toHaveLength(0);
  });

  it('hace CRUD del catálogo flash', async () => {
    const cookie = await auth();
    const create = await request(ctx.app)
      .post('/api/admin/flash')
      .set('Cookie', cookie)
      .send({ code: 'FL-001', name: 'Golondrina', price: 90000, category: 'clasico' });
    expect(create.status).toBe(201);
    const id = create.body.item.id;

    const patch = await request(ctx.app)
      .patch(`/api/admin/flash/${id}`)
      .set('Cookie', cookie)
      .send({ price: 120000 });
    expect(patch.body.item.price).toBe(120000);

    const removed = await request(ctx.app)
      .delete(`/api/admin/flash/${id}`)
      .set('Cookie', cookie);
    expect(removed.status).toBe(200);
  });

  it('gestiona cotizaciones y citas en la misma agenda', async () => {
    const cookie = await auth();
    const quote = await request(ctx.app)
      .post('/api/admin/appointments')
      .set('Cookie', cookie)
      .send({
        client: 'Camila',
        design: 'Rosa negra',
        at: '2026-12-01T10:00:00.000Z',
        status: 'cotizacion',
      });
    expect(quote.status).toBe(201);
    const id = quote.body.appointment.id;
    expect(quote.body.appointment.code).toMatch(/^AG-\d{8}-\d{4}$/);

    const quotes = await request(ctx.app)
      .get('/api/admin/appointments?status=cotizacion')
      .set('Cookie', cookie);
    expect(quotes.body.items).toHaveLength(1);

    const approved = await request(ctx.app)
      .patch(`/api/admin/appointments/${id}`)
      .set('Cookie', cookie)
      .send({ status: 'confirmada' });
    expect(approved.body.appointment.status).toBe('confirmada');

    const confirmed = await request(ctx.app)
      .get('/api/admin/appointments?status=confirmada')
      .set('Cookie', cookie);
    expect(confirmed.body.items).toHaveLength(1);
    const quotesAfter = await request(ctx.app)
      .get('/api/admin/appointments?status=cotizacion')
      .set('Cookie', cookie);
    expect(quotesAfter.body.items).toHaveLength(0);
  });
});

describe('panel de administración · proveedor de IA', () => {
  it('expone los proveedores y guarda la configuración activa', async () => {
    const { headers } = await login();
    const cookie = headers['set-cookie'];

    const current = await request(ctx.app).get('/api/admin/ai').set('Cookie', cookie);
    expect(current.status).toBe(200);
    expect(current.body.provider).toBe('groq');
    expect(current.body.hasApiKey).toBe(true); // proviene del .env de prueba
    const providerIds = (current.body.presets as Array<{ id: string }>).map(
      (preset) => preset.id,
    );
    expect(providerIds).toContain('anthropic');
    expect(providerIds).not.toContain('ollama');

    const saved = await request(ctx.app)
      .put('/api/admin/ai')
      .set('Cookie', cookie)
      .send({ provider: 'groq', model: 'llama-3.3-70b-versatile', apiKey: 'gsk_nueva_key' });
    expect(saved.status).toBe(200);
    expect(saved.body.model).toBe('llama-3.3-70b-versatile');

    const overview = await request(ctx.app)
      .get('/api/admin/overview')
      .set('Cookie', cookie);
    expect(overview.body.bot.model).toBe('llama-3.3-70b-versatile');
  });
});
