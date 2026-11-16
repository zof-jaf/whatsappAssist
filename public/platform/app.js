(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const state = { user: null, bot: null, view: 'dashboard', poll: null };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    let payload = {};
    try { payload = await response.json(); } catch { /* sin cuerpo */ }
    if (!response.ok) {
      const err = new Error(payload?.error?.message || `Error ${response.status}`);
      err.code = payload?.error?.code;
      err.status = response.status;
      throw err;
    }
    return payload;
  }

  function showError(element, message) {
    if (!element) return;
    element.textContent = message || '';
    element.hidden = !message;
  }

  function globalError(message) {
    showError($('#global-error'), message);
  }

  /* ----------------------------- Autenticación ---------------------------- */

  function setupAuth() {
    $('#tab-login').addEventListener('click', () => switchTab('login'));
    $('#tab-register').addEventListener('click', () => switchTab('register'));

    $('#login-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      showError($('#auth-error'), '');
      const form = new FormData(event.currentTarget);
      try {
        const { user } = await api('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email: form.get('email'), password: form.get('password') }),
        });
        state.user = user;
        enterApp();
      } catch (err) {
        showError($('#auth-error'), err.message);
      }
    });

    $('#register-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      showError($('#register-error'), '');
      const form = new FormData(event.currentTarget);
      try {
        await api('/api/auth/register', {
          method: 'POST',
          body: JSON.stringify({
            email: form.get('email'),
            password: form.get('password'),
            fullName: form.get('fullName'),
          }),
        });
        const { user } = await api('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email: form.get('email'), password: form.get('password') }),
        });
        state.user = user;
        enterApp();
      } catch (err) {
        showError($('#register-error'), err.message);
      }
    });
  }

  function switchTab(tab) {
    const login = tab === 'login';
    $('#tab-login').classList.toggle('active', login);
    $('#tab-register').classList.toggle('active', !login);
    $('#login-form').hidden = !login;
    $('#register-form').hidden = login;
  }

  /* -------------------------- Navegación / app ---------------------------- */

  function enterApp() {
    $('#auth-view').hidden = true;
    $('#app-view').hidden = false;
    $('#user-name').textContent = state.user.full_name || state.user.email;
    $('#user-email').textContent = state.user.email;
    $('#side-role').textContent = state.user.role === 'admin' ? 'Administrador' : 'Usuario';
    document.querySelectorAll('.admin-only').forEach((el) => { el.hidden = state.user.role !== 'admin'; });
    navigate('dashboard');
  }

  function setupApp() {
    document.querySelectorAll('.nav-item').forEach((button) => {
      button.addEventListener('click', () => navigate(button.dataset.view));
    });
    $('#logout-btn').addEventListener('click', async () => {
      try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignorar */ }
      stopPolling();
      state.user = null;
      state.bot = null;
      $('#app-view').hidden = true;
      $('#auth-view').hidden = false;
      switchTab('login');
    });
  }

  function navigate(view) {
    state.view = view;
    const titles = { dashboard: 'Mi bot', reports: 'Reportes', admin: 'Administración' };
    const subtitles = {
      dashboard: 'Estado de conexión y vinculación',
      reports: 'Actividad de tu bot',
      admin: 'Usuarios y reportes del sistema',
    };
    $('#view-title').textContent = titles[view];
    $('#view-subtitle').textContent = subtitles[view];
    document.querySelectorAll('.nav-item').forEach((el) => el.classList.toggle('active', el.dataset.view === view));
    ['dashboard', 'reports', 'admin'].forEach((v) => { $('#view-' + v).hidden = v !== view; });
    globalError('');
    if (view === 'dashboard') loadDashboard();
    if (view === 'reports') loadMyReports();
    if (view === 'admin') loadAdmin();
  }

  /* ------------------------------- Dashboard ------------------------------ */

  function renderConnection(status, phone, qr) {
    const label = $('#conn-label');
    const detail = $('#conn-detail');
    label.className = 'status-pill';
    const map = {
      working: ['status-ok', 'Conectado'],
      scan_qr: ['status-warn', 'Esperando escaneo de QR'],
      connecting: ['status-warn', 'Conectando…'],
      failed: ['status-bad', 'Error en la sesión'],
      not_started: ['status-idle', 'Sin iniciar'],
    };
    const [cls, text] = map[status] || map.not_started;
    label.classList.add(cls);
    label.textContent = text;
    detail.textContent = phone
      ? `Número vinculado: ${phone}`
      : status === 'scan_qr'
        ? 'Escaneá el QR para vincular tu WhatsApp.'
        : 'Si tu sesión no está validada, se crea una nueva desde cero.';

    $('#qr-wrap').hidden = !qr;
    $('#qr-placeholder').hidden = Boolean(qr);
    if (qr) $('#qr-img').src = qr;
  }

  function stopPolling() {
    if (state.poll) { clearInterval(state.poll); state.poll = null; }
  }

  function startPolling() {
    stopPolling();
    state.poll = setInterval(async () => {
      if (!state.bot || state.view !== 'dashboard') return stopPolling();
      try {
        const data = await api('/api/bots/status');
        renderConnection(data.status, data.phone, data.qr);
        if (data.status === 'working') {
          state.bot.connectionStatus = 'working';
          state.bot.phoneNumber = data.phone;
          renderBot();
          stopPolling();
        }
      } catch { stopPolling(); }
    }, 4000);
  }

  function renderBot() {
    const bot = state.bot;
    $('#bot-empty').hidden = Boolean(bot);
    $('#bot-info').hidden = !bot;
    if (bot) {
      $('#bot-name').textContent = bot.name;
      $('#bot-session').textContent = bot.wahaSession || bot.id;
      $('#bot-phone').textContent = bot.phoneNumber || '—';
      $('#api-key-preview').textContent = bot.apiKeyPreview ? `Key actual: ${bot.apiKeyPreview}` : '';
    }
  }

  async function loadDashboard() {
    globalError('');
    try {
      const { bot } = await api('/api/bots/me');
      state.bot = bot;
      renderBot();
      renderConnection(bot?.connectionStatus || 'not_started', bot?.phoneNumber, null);
      // Reutiliza sesión activa o muestra un QR nuevo automáticamente.
      if (bot && bot.enabled) await checkConnection();
    } catch (err) {
      globalError(err.message);
    }
  }

  async function checkConnection() {
    try {
      const data = await api('/api/bots/connect', { method: 'POST' });
      renderConnection(data.status, data.phone, data.qr);
      if (data.status === 'scan_qr') startPolling();
      else stopPolling();
      await loadBotOnly();
    } catch (err) {
      globalError(err.message);
    }
  }

  async function loadBotOnly() {
    const { bot } = await api('/api/bots/me');
    state.bot = bot;
    renderBot();
  }

  function setupDashboard() {
    $('#check-conn').addEventListener('click', checkConnection);
    $('#new-qr').addEventListener('click', async () => {
      try {
        const data = await api('/api/bots/reconnect', { method: 'POST' });
        renderConnection(data.status, data.phone, data.qr);
        startPolling();
      } catch (err) { globalError(err.message); }
    });
    $('#create-bot').addEventListener('click', async () => {
      try {
        const result = await api('/api/bots', { method: 'POST', body: JSON.stringify({ name: 'Mi bot' }) });
        state.bot = result.bot;
        renderBot();
        $('#api-key-box').hidden = false;
        $('#api-key-value').textContent = result.apiKey;
        showError($('#api-key-warning'), 'Guardá esta key ahora: no volverá a mostrarse en claro.');
        $('#api-key-warning').hidden = false;
        renderConnection(result.connection.status, result.connection.phone, result.connection.qr);
        if (result.connection.status === 'scan_qr') startPolling();
      } catch (err) { globalError(err.message); }
    });
    $('#rotate-key').addEventListener('click', async () => {
      try {
        const { apiKey, apiKeyPreview } = await api('/api/bots/api-key/rotate', { method: 'POST' });
        $('#api-key-box').hidden = false;
        $('#api-key-value').textContent = apiKey;
        $('#api-key-warning').hidden = false;
        $('#api-key-preview').textContent = `Key actual: ${apiKeyPreview}`;
      } catch (err) { globalError(err.message); }
    });
    $('#copy-key').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText($('#api-key-value').textContent); } catch { /* ignorar */ }
    });
    $('#delete-bot').addEventListener('click', async () => {
      if (!window.confirm('¿Eliminar el bot y su sesión de WhatsApp?')) return;
      try {
        await api('/api/bots', { method: 'DELETE' });
        stopPolling();
        state.bot = null;
        $('#api-key-box').hidden = true;
        $('#api-key-warning').hidden = true;
        $('#api-key-preview').textContent = '';
        renderBot();
        renderConnection('not_started', null, null);
      } catch (err) { globalError(err.message); }
    });
  }

  /* ------------------------------- Reportes ------------------------------- */

  function renderStats(container, stats) {
    container.innerHTML = Object.entries(stats)
      .map(([label, value]) => `<div class="stat"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`)
      .join('');
  }

  function renderSeries(container, series) {
    if (!series.length) { container.innerHTML = '<p class="muted">Sin actividad todavía.</p>'; return; }
    container.innerHTML = series.map((s) =>
      `<div class="series-row"><span class="mono">${escapeHtml(s.day)}</span><span>Entrantes: ${escapeHtml(s.inbound)} · Salientes: ${escapeHtml(s.outbound)}</span></div>`
    ).join('');
  }

  function renderEvents(container, events) {
    const rows = events.map((e) =>
      `<tr><td class="mono">${escapeHtml(new Date(e.created_at).toLocaleString())}</td><td>${escapeHtml(e.type)}</td><td class="mono">${escapeHtml(JSON.stringify(e.meta || {}))}</td></tr>`
    ).join('');
    container.innerHTML = `<thead><tr><th>Fecha</th><th>Evento</th><th>Detalle</th></tr></thead><tbody>${rows}</tbody>`;
  }

  async function loadMyReports() {
    try {
      const data = await api('/api/reports/summary');
      renderStats($('#my-summary'), {
        'Logins': data.summary.logins,
        'Mensajes entrantes': data.summary.messages_in,
        'Mensajes salientes': data.summary.messages_out,
        'QR generados': data.summary.qr_generated,
      });
      renderSeries($('#my-series'), data.series);
      renderEvents($('#my-events'), data.events);
    } catch (err) { globalError(err.message); }
  }

  /* ----------------------------- Administración --------------------------- */

  async function loadAdmin() {
    try {
      const data = await api('/api/admin/reports');
      renderStats($('#admin-summary'), {
        'Usuarios': data.users.length,
        'Bots activos': data.users.filter((u) => u.connection_status === 'working').length,
        'Mensajes (30d)': data.summary.messages_in,
        'Eventos totales': data.summary.events_total,
      });
      renderAdminReport($('#admin-report'), data.users);
      await loadUsers();
    } catch (err) { globalError(err.message); }
  }

  function renderAdminReport(container, users) {
    const rows = users.map((u) =>
      `<tr>
        <td>${escapeHtml(u.email)}</td>
        <td>${escapeHtml(u.full_name)}</td>
        <td>${escapeHtml(u.role)}</td>
        <td>${escapeHtml(u.status)}</td>
        <td>${escapeHtml(u.connection_status || '—')}</td>
        <td>${escapeHtml(u.messages_in)}</td>
        <td>${escapeHtml(u.messages_out)}</td>
        <td>${escapeHtml(u.logins)}</td>
      </tr>`
    ).join('');
    container.innerHTML = `<thead><tr><th>Correo</th><th>Nombre</th><th>Rol</th><th>Estado</th><th>Conexión</th><th>Msgs in</th><th>Msgs out</th><th>Logins</th></tr></thead><tbody>${rows}</tbody>`;
  }

  async function loadUsers() {
    const search = $('#user-search').value.trim();
    const data = await api(`/api/admin/users?limit=200&search=${encodeURIComponent(search)}`);
    const rows = data.rows.map((u) =>
      `<tr>
        <td>${escapeHtml(u.email)}</td>
        <td>${escapeHtml(u.full_name)}</td>
        <td>${escapeHtml(u.role)}</td>
        <td>${escapeHtml(u.status)}</td>
        <td>${u.can_create_bots ? 'Sí' : 'No'}</td>
        <td class="mono">${u.last_login_at ? escapeHtml(new Date(u.last_login_at).toLocaleString()) : '—'}</td>
        <td>
          <div class="actions">
            <button class="btn btn-ghost btn-sm" data-action="toggle" data-id="${u.id}" data-value="${u.status}">${u.status === 'active' ? 'Suspender' : 'Activar'}</button>
            <button class="btn btn-ghost btn-sm" data-action="bots" data-id="${u.id}" data-value="${u.can_create_bots}">Permiso bots</button>
            <button class="btn btn-ghost btn-sm" data-action="revoke" data-id="${u.id}">Cerrar sesiones</button>
            <button class="btn btn-danger btn-sm" data-action="delete" data-id="${u.id}">Eliminar</button>
          </div>
        </td>
      </tr>`
    ).join('');
    $('#admin-users').innerHTML = `<thead><tr><th>Correo</th><th>Nombre</th><th>Rol</th><th>Estado</th><th>Crea bots</th><th>Último ingreso</th><th>Acciones</th></tr></thead><tbody>${rows}</tbody>`;
  }

  function setupAdmin() {
    let searchTimer;
    $('#user-search').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => loadUsers().catch((e) => globalError(e.message)), 250);
    });
    $('#open-create-user').addEventListener('click', () => { $('#user-modal').hidden = false; });
    $('#close-user-modal').addEventListener('click', () => { $('#user-modal').hidden = true; });
    $('#create-user-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      showError($('#create-user-error'), '');
      const form = new FormData(event.currentTarget);
      try {
        await api('/api/admin/users', {
          method: 'POST',
          body: JSON.stringify({
            email: form.get('email'),
            password: form.get('password'),
            fullName: form.get('fullName'),
            role: form.get('role'),
            canCreateBots: form.get('canCreateBots') === 'on',
          }),
        });
        $('#user-modal').hidden = true;
        event.currentTarget.reset();
        await loadAdmin();
      } catch (err) { showError($('#create-user-error'), err.message); }
    });

    $('#admin-users').addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const { action, id, value } = button.dataset;
      try {
        if (action === 'toggle') {
          await api(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify({ status: value === 'active' ? 'suspended' : 'active' }) });
        } else if (action === 'bots') {
          await api(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify({ canCreateBots: value !== 'true' }) });
        } else if (action === 'revoke') {
          await api(`/api/admin/users/${id}/sessions/revoke`, { method: 'POST' });
        } else if (action === 'delete') {
          if (!window.confirm('¿Eliminar este usuario y su bot?')) return;
          await api(`/api/admin/users/${id}`, { method: 'DELETE' });
        }
        await loadAdmin();
      } catch (err) { globalError(err.message); }
    });
  }

  /* -------------------------------- Inicio -------------------------------- */

  async function init() {
    setupAuth();
    setupApp();
    setupDashboard();
    setupAdmin();
    try {
      const { user } = await api('/api/auth/me');
      if (user) { state.user = user; enterApp(); }
    } catch { /* sin sesión */ }
  }

  init();
})();
