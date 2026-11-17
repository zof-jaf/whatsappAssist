'use strict';

const TOKEN_KEY = 'wa_admin_token';
const REFRESH_MS = 20_000;
const WHATSAPP_REFRESH_MS = 5_000;

const state = {
  token: '',
  inApp: false,
  tab: 'overview',
  timeZone: undefined,
  overview: null,
  detail: null,
  currentId: null,
  refreshTimer: null,
  whatsapp: {
    ok: null,
    exists: null,
    status: null,
    me: null,
    error: null,
    qrDataUrl: '',
    qrHint: '',
    dashboardUrl: '',
    lastUpdated: null,
    loading: false,
    timer: null,
    autoConnects: 0,
    autoConnectAt: 0,
  },
  conversations: {
    items: [],
    total: 0,
    limit: 20,
    offset: 0,
    search: '',
    status: 'all',
    loaded: false,
    loading: false,
  },
  tattoo: {
    configured: false,
    phone: null,
    displayPhone: null,
    chatId: null,
    artistName: 'tatuador',
    source: 'none',
    countryCode: '57',
    loaded: false,
  },
  notion: {
    configured: false,
    ready: false,
    tokenSet: false,
    tokenSource: 'none',
    databaseId: null,
    databaseTitle: null,
    databaseUrl: null,
    dateProperty: null,
    titleProperty: null,
    statusProperty: null,
    warning: null,
    lastError: null,
    checkedAt: null,
    loaded: false,
  },
  agenda: {
    search: '',
    artist: 'all',
    status: 'all',
    period: 'semana',
    selected: null,
  },
};

/* ---------- Agenda / catálogo ----------
   El proyecto arranca vacío: no hay registros ilustrativos. Las citas reales
   viven en Notion y se cargarán desde la integración cuando esté conectada. */
const APPOINTMENTS = [];
const CHAT_SCRIPT = [];
const FLASH_ITEMS = [];
const FLASH_ART = {};

const $ = (selector) => document.querySelector(selector);

const els = {
  loginView: $('#login-view'),
  loginForm: $('#login-form'),
  loginToken: $('#login-token'),
  loginRemember: $('#login-remember'),
  loginSubmit: $('#login-submit'),
  loginError: $('#login-error'),
  appView: $('#app-view'),
  brandName: $('#brand-name'),
  brandSubtitle: $('#brand-subtitle'),
  modelChip: $('#model-chip'),
  connectionChip: $('#connection-chip'),
  logoutButton: $('#logout-button'),
  tabs: Array.from(document.querySelectorAll('.nav-item')),
  panels: {
    agenda: $('#tab-agenda'),
    overview: $('#tab-overview'),
    conversations: $('#tab-conversations'),
    whatsapp: $('#tab-whatsapp'),
    artistas: $('#tab-artistas'),
    flash: $('#tab-flash'),
    system: $('#tab-system'),
  },
  crumbCurrent: $('#crumb-current'),
  liveDot: $('#live-dot'),
  liveTitle: $('#live-title'),
  liveSubtitle: $('#live-subtitle'),
  sidebarModel: $('#sidebar-model'),
  refreshTop: $('#refresh-top'),
  agendaBody: $('#agenda-body'),
  agendaSearch: $('#agenda-search'),
  agendaArtist: $('#agenda-artist'),
  agendaCount: $('#agenda-count'),
  agendaFootCount: $('#agenda-foot-count'),
  agendaPeriodLabel: $('#agenda-period-label'),
  drawer: $('#appointment-drawer'),
  drawerBackdrop: $('#drawer-backdrop'),
  drawerContent: $('#drawer-content'),
  drawerTitle: $('#drawer-title'),
  drawerClose: $('#drawer-close'),
  upcomingList: $('#upcoming-list'),
  staleList: $('#stale-list'),
  botActivity: $('#bot-activity'),
  flashGrid: $('#flash-grid'),
  statsGrid: $('#stats-grid'),
  healthGrid: $('#health-grid'),
  botInfo: $('#bot-info'),
  queueInfo: $('#queue-info'),
  wahaLink: $('#waha-link'),
  refreshOverview: $('#refresh-overview'),
  conversationList: $('#conversation-list'),
  conversationsCount: $('#conversations-count'),
  conversationSearch: $('#conversation-search'),
  conversationStatus: $('#conversation-status'),
  conversationsPrev: $('#conversations-prev'),
  conversationsNext: $('#conversations-next'),
  conversationsPage: $('#conversations-page'),
  refreshConversations: $('#refresh-conversations'),
  detailPanel: $('#conversation-detail'),
  detailEmpty: $('#detail-empty'),
  detailContent: $('#detail-content'),
  detailHeader: $('#detail-header'),
  detailSummary: $('#detail-summary'),
  detailContext: $('#detail-context'),
  messageList: $('#message-list'),
  loadOlder: $('#load-older'),
  manualForm: $('#manual-form'),
  manualText: $('#manual-text'),
  systemHealth: $('#system-health'),
  systemSettings: $('#system-settings'),
  failedJobs: $('#failed-jobs'),
  failedJobsCount: $('#failed-jobs-count'),
  recentEvents: $('#recent-events'),
  refreshSystem: $('#refresh-system'),
  whatsappStatusChip: $('#whatsapp-status-chip'),
  whatsappStatus: $('#whatsapp-status'),
  whatsappQrPanel: $('#whatsapp-qr-panel'),
  whatsappQr: $('#whatsapp-qr'),
  whatsappConnect: $('#whatsapp-connect'),
  whatsappRestart: $('#whatsapp-restart'),
  whatsappDashboardLink: $('#whatsapp-dashboard-link'),
  whatsappInfo: $('#whatsapp-info'),
  refreshWhatsApp: $('#refresh-whatsapp'),
  tattooForm: $('#tattoo-form'),
  tattooPhone: $('#tattoo-phone'),
  tattooSave: $('#tattoo-save'),
  tattooClear: $('#tattoo-clear'),
  tattooStatusChip: $('#tattoo-status-chip'),
  tattooHint: $('#tattoo-hint'),
  notionForm: $('#notion-form'),
  notionToken: $('#notion-token'),
  notionDatabase: $('#notion-database'),
  notionSave: $('#notion-save'),
  notionTest: $('#notion-test'),
  notionDiscover: $('#notion-discover'),
  notionStatusChip: $('#notion-status-chip'),
  notionHint: $('#notion-hint'),
  notionDatabases: $('#notion-databases'),
  toastContainer: $('#toast-container'),
  goWhatsApp: $('#go-whatsapp'),
  goConversations: $('#go-conversations'),
  goSystem: $('#go-system'),
};

/* ---------- Utilidades ---------- */

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return character;
    }
  });
}

const numberFormatter = new Intl.NumberFormat('es-AR');
const relativeFormatter = new Intl.RelativeTimeFormat('es-AR', {
  numeric: 'auto',
});

function formatNumber(value) {
  return numberFormatter.format(Number(value) || 0);
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[index]}`;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${minutes % 60} min`;
  const days = Math.floor(hours / 24);
  return `${days} d ${hours % 24} h`;
}

function dateFormatter(options) {
  const base = { ...options };
  if (state.timeZone) base.timeZone = state.timeZone;
  try {
    return new Intl.DateTimeFormat('es-AR', base);
  } catch {
    return new Intl.DateTimeFormat('es-AR', options);
  }
}

function formatDate(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return dateFormatter({ dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function formatTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return dateFormatter({ hour: '2-digit', minute: '2-digit' }).format(date);
}

function formatRelative(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const diff = date.getTime() - Date.now();
  const abs = Math.abs(diff);
  if (abs < 45_000) return 'ahora';

  const units = [
    [31_536_000_000, 'year'],
    [2_592_000_000, 'month'],
    [604_800_000, 'week'],
    [86_400_000, 'day'],
    [3_600_000, 'hour'],
    [60_000, 'minute'],
  ];

  for (const [size, unit] of units) {
    if (abs >= size) {
      return relativeFormatter.format(Math.round(diff / size), unit);
    }
  }
  return relativeFormatter.format(Math.round(diff / 1000), 'second');
}

function formatDay(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return 'Hoy';
  if (date.toDateString() === yesterday.toDateString()) return 'Ayer';

  return dateFormatter({ weekday: 'long', day: 'numeric', month: 'long' })
    .format(date)
    .replace(/^./, (letter) => letter.toUpperCase());
}

function initials(name) {
  const cleaned = String(name ?? '').trim();
  if (!cleaned) return '?';
  const words = cleaned.split(/\s+/).filter(Boolean);
  const letters = words
    .slice(0, 2)
    .map((word) => Array.from(word)[0])
    .join('');
  return (letters || Array.from(cleaned)[0] || '?').toUpperCase();
}

const STATUS_LABELS = {
  received: 'Recibido',
  queued: 'En cola',
  sent: 'Enviado',
  delivered: 'Entregado',
  read: 'Leído',
  failed: 'Falló',
  skipped: 'Omitido',
};

const KIND_LABELS = {
  text: '',
  media: 'Multimedia',
  command: 'Comando',
  system: 'Sistema',
  error: 'Error',
};

function statusLabel(status) {
  return STATUS_LABELS[status] ?? status ?? '';
}

function toast(message, type = 'success') {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  els.toastContainer.appendChild(node);
  setTimeout(() => {
    node.remove();
  }, 4500);
}

/* ---------- API ---------- */

async function api(path, options = {}) {
  const method = options.method ?? 'GET';
  const headers = { Accept: 'application/json' };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }

  let response;
  try {
    response = await fetch(`/api/admin${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    const error = new Error(
      'No se pudo conectar con el servidor. Verificá que el bot esté corriendo.',
    );
    error.status = 0;
    throw error;
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const message =
      data && data.error && data.error.message
        ? data.error.message
        : `Error HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.details = data && data.error ? data.error.details : undefined;
    throw error;
  }

  return data;
}

async function apiAuthed(path, options) {
  try {
    return await api(path, options);
  } catch (error) {
    if (error.status === 401) {
      logout('La sesión expiró. Volvé a ingresar el token de administración.');
    }
    throw error;
  }
}

function handleError(error) {
  if (!error || error.status === 401) return;
  toast(error.message || 'Ocurrió un error inesperado', 'error');
}

/* ---------- Sesión ---------- */

function safeGet(storage, key) {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(storage, key, value) {
  try {
    storage.setItem(key, value);
  } catch {
    /* almacenamiento no disponible */
  }
}

function safeRemove(storage, key) {
  try {
    storage.removeItem(key);
  } catch {
    /* almacenamiento no disponible */
  }
}

function readStoredToken() {
  return (
    safeGet(window.sessionStorage, TOKEN_KEY) ||
    safeGet(window.localStorage, TOKEN_KEY) ||
    ''
  );
}

function storeToken(token, remember) {
  safeRemove(window.sessionStorage, TOKEN_KEY);
  safeRemove(window.localStorage, TOKEN_KEY);
  if (remember) {
    safeSet(window.localStorage, TOKEN_KEY, token);
  } else {
    safeSet(window.sessionStorage, TOKEN_KEY, token);
  }
}

function clearStoredToken() {
  safeRemove(window.sessionStorage, TOKEN_KEY);
  safeRemove(window.localStorage, TOKEN_KEY);
}

function showLogin(message) {
  stopAutoRefresh();
  stopWhatsAppPolling();
  state.inApp = false;
  state.token = '';
  state.detail = null;
  state.currentId = null;
  els.appView.hidden = true;
  els.loginView.hidden = false;
  els.loginSubmit.disabled = false;
  els.loginSubmit.textContent = 'Entrar al panel';
  if (message) {
    els.loginError.textContent = message;
    els.loginError.hidden = false;
  } else {
    els.loginError.hidden = true;
  }
  setTimeout(() => els.loginToken.focus(), 30);
}

function showApp(overview) {
  els.loginView.hidden = true;
  els.appView.hidden = false;
  state.inApp = true;
  state.timeZone = overview?.bot?.timeZone;
  state.whatsapp.autoConnects = 0;
  state.whatsapp.autoConnectAt = 0;
  renderOverview(overview);

  const model = overview?.bot?.model;
  if (els.modelChip) els.modelChip.textContent = model || '—';
  if (els.sidebarModel) els.sidebarModel.textContent = model || '—';

  // Si WhatsApp todavía no está conectado, mostramos primero el QR.
  const needsWhatsApp = overview?.health?.waha?.status !== 'WORKING';
  activateTab(needsWhatsApp ? 'whatsapp' : 'agenda');
  if (needsWhatsApp) void loadWhatsApp();
  startAutoRefresh();
}

function logout(message) {
  clearStoredToken();
  showLogin(message);
}

/* ---------- Navegación ---------- */

const TAB_LABELS = {
  agenda: 'Agenda',
  overview: 'Resumen',
  conversations: 'Conversaciones',
  whatsapp: 'Flujo del Bot',
  artistas: 'Artistas',
  flash: 'Catálogo Flash',
  system: 'Sistema',
};

function syncAgendaFilterChips() {
  document.querySelectorAll('.filter-chip[data-status]').forEach((chip) => {
    chip.classList.toggle('active', chip.dataset.status === state.agenda.status);
  });
}

function activateTab(tab) {
  state.tab = tab;
  els.tabs.forEach((button) => {
    const filter = button.dataset.agendaFilter;
    const selected = button.dataset.tab === tab &&
      (!filter || filter === state.agenda.status);
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  Object.entries(els.panels).forEach(([name, panel]) => {
    panel.hidden = name !== tab;
  });

  if (els.crumbCurrent) els.crumbCurrent.textContent = TAB_LABELS[tab] ?? tab;
  closeDrawer();

  if (tab === 'whatsapp') {
    startWhatsAppPolling();
    void loadTattoo();
    void loadNotion();
  } else {
    stopWhatsAppPolling();
  }
}

function switchTab(tab, options = {}) {
  if (tab === 'agenda') {
    state.agenda.status = options.agendaStatus || 'all';
    syncAgendaFilterChips();
  }
  activateTab(tab);
  if (tab === 'agenda') {
    renderAgenda();
  } else if (tab === 'overview') {
    void loadOverview();
  } else if (tab === 'conversations') {
    void loadConversations();
  } else if (tab === 'whatsapp') {
    void loadWhatsApp();
  } else if (tab === 'artistas') {
    // Vista estática del directorio del estudio.
  } else if (tab === 'flash') {
    renderFlash();
  } else if (tab === 'system') {
    void loadSystem();
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  state.refreshTimer = setInterval(() => {
    if (
      state.inApp &&
      state.tab === 'overview' &&
      document.visibilityState === 'visible'
    ) {
      void loadOverview({ silent: true });
    }
  }, REFRESH_MS);
}

function stopAutoRefresh() {
  if (state.refreshTimer) {
    clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }
}

function startWhatsAppPolling() {
  stopWhatsAppPolling();
  state.whatsapp.timer = setInterval(() => {
    if (
      state.inApp &&
      state.tab === 'whatsapp' &&
      document.visibilityState === 'visible'
    ) {
      void loadWhatsApp({ silent: true });
    }
  }, WHATSAPP_REFRESH_MS);
}

function stopWhatsAppPolling() {
  if (state.whatsapp.timer) {
    clearInterval(state.whatsapp.timer);
    state.whatsapp.timer = null;
  }
}

/* ---------- Render genérico ---------- */

function statCard(label, value, detail) {
  return `
    <div class="stat-card">
      <span class="stat-label">${esc(label)}</span>
      <strong class="stat-value">${esc(value)}</strong>
      <span class="stat-detail">${esc(detail)}</span>
    </div>`;
}

function healthItem(name, severity, detail) {
  const safeSeverity = ['ok', 'warn', 'error'].includes(severity)
    ? severity
    : '';
  return `
    <div class="health-item">
      <div class="health-item-main">
        <span class="health-dot ${safeSeverity}"></span>
        <div class="health-text">
          <strong>${esc(name)}</strong>
          <span title="${esc(detail)}">${esc(detail)}</span>
        </div>
      </div>
    </div>`;
}

function renderInfoList(element, entries) {
  element.innerHTML = entries
    .map(
      ([label, value]) => `
        <div>
          <dt>${esc(label)}</dt>
          <dd>${esc(value)}</dd>
        </div>`,
    )
    .join('');
}

function aiProviderLabel(provider) {
  return provider === 'groq' ? 'Groq' : 'Ollama';
}

function setConnectionChip(health, aiProvider = 'ollama') {
  let severity = 'ok';
  let label = 'Operativo';
  const provider = aiProviderLabel(aiProvider);

  if (!health.waha.ok) {
    severity = 'error';
    label = 'WAHA sin conexión';
  } else if (health.waha.status !== 'WORKING') {
    severity = 'warn';
    label = `WAHA: ${health.waha.status ?? 'sin sesión'}`;
  }

  if (!health.ollama.ok) {
    severity = 'error';
    label = health.waha.ok ? `${provider} sin conexión` : 'Dependencias caídas';
  } else if (!health.ollama.hasModel) {
    if (severity !== 'error') severity = 'warn';
    label = aiProvider === 'groq'
      ? 'Modelo de Groq no disponible'
      : 'Modelo sin descargar';
  }

  els.connectionChip.className = `chip ${severity}`;
  els.connectionChip.textContent = label;

  if (els.liveDot) {
    const working = health.waha.ok && health.waha.status === 'WORKING';
    els.liveDot.className = `live-dot ${working ? 'on' : 'off'}`;
    els.liveTitle.textContent = working ? 'Bot conectado' : 'Bot desconectado';
    els.liveSubtitle.textContent = working
      ? `WhatsApp · ${health.waha.me?.pushName || 'sesión activa'}`
      : `WAHA · ${health.waha.status ?? 'sin sesión'}`;
  }
}

function renderHealth(container, health, worker, aiProvider = 'ollama') {
  const parts = [];
  const provider = aiProviderLabel(aiProvider);

  parts.push(
    healthItem(
      'Base de datos',
      health.db.ok ? 'ok' : 'error',
      health.db.ok ? 'SQLite operativa' : health.db.error || 'Error de base de datos',
    ),
  );

  const wahaDetail = health.waha.ok
    ? `Sesión: ${health.waha.status ?? 'desconocida'}${
        health.waha.me?.pushName ? ` · ${health.waha.me.pushName}` : ''
      }`
    : health.waha.error || 'No se pudo contactar a WAHA';
  parts.push(
    healthItem(
      'WAHA / WhatsApp',
      health.waha.ok
        ? health.waha.status === 'WORKING'
          ? 'ok'
          : 'warn'
        : 'error',
      wahaDetail,
    ),
  );

  const aiDetail = health.ollama.ok
    ? health.ollama.hasModel
      ? `Modelo disponible en ${provider} (${health.ollama.models.length} modelo/s)`
      : aiProvider === 'groq'
        ? `${provider} responde, pero el modelo configurado no está disponible en tu cuenta`
        : `${provider} responde, pero falta el modelo configurado`
    : `${provider}: ${health.ollama.error || 'no se pudo contactar'}`;
  parts.push(
    healthItem(
      aiProvider === 'groq' ? 'Groq / IA en la nube' : 'Ollama / IA local',
      health.ollama.ok ? (health.ollama.hasModel ? 'ok' : 'warn') : 'error',
      aiDetail,
    ),
  );

  if (health.queue) {
    const failed = health.queue.failed ?? 0;
    const pending = health.queue.pending ?? 0;
    const processing = health.queue.processing ?? 0;
    parts.push(
      healthItem(
        'Cola de trabajos',
        failed > 0 ? 'warn' : 'ok',
        `${pending} pendientes · ${processing} en proceso · ${failed} fallidos`,
      ),
    );
  }

  if (worker) {
    parts.push(
      healthItem(
        'Worker',
        worker.running ? 'ok' : 'warn',
        worker.running
          ? worker.currentJobId
            ? `Activo · procesando trabajo #${worker.currentJobId}`
            : 'Activo y esperando mensajes'
          : 'Detenido',
      ),
    );
  }

  container.innerHTML = parts.join('');
}

/* ---------- Resumen ---------- */

async function loadOverview(options = {}) {
  try {
    const data = await apiAuthed('/overview');
    state.overview = data;
    state.timeZone = data.bot?.timeZone;
    renderOverview(data);
  } catch (error) {
    if (!options.silent) handleError(error);
  }
}

function renderOverview(data) {
  if (!data) return;

  els.brandName.textContent = 'Estudio de Tatuajes';
  els.brandSubtitle.textContent = `${data.bot?.name || 'Asistente'} · v${data.version ?? '—'}`;
  els.modelChip.textContent = data.bot?.model || 'modelo desconocido';
  els.modelChip.title = `Modelo de IA (${aiProviderLabel(data.bot?.aiProvider)}): ${data.bot?.model ?? '—'}`;
  setConnectionChip(data.health, data.bot?.aiProvider);

  const stats = data.stats ?? {};
  const queue = data.health?.queue ?? {};
  els.statsGrid.innerHTML = [
    statCard(
      'Contactos',
      formatNumber(stats.contacts),
      `${formatNumber(stats.conversations)} conversaciones`,
    ),
    statCard(
      'Mensajes',
      formatNumber(stats.messages),
      `${formatNumber(stats.inboundToday)} entrantes · ${formatNumber(
        stats.outboundToday,
      )} salientes hoy`,
    ),
    statCard(
      'Conversaciones',
      formatNumber(stats.conversations),
      `${formatNumber(stats.archivedConversations)} archivadas`,
    ),
    statCard(
      'Resúmenes activos',
      formatNumber(stats.summaries),
      'Contexto comprimido automáticamente',
    ),
    statCard(
      'Base de datos',
      formatBytes(stats.dbSizeBytes),
      'SQLite con historial persistente',
    ),
    statCard(
      'Cola pendiente',
      formatNumber(queue.pending),
      `${formatNumber(queue.failed)} fallidos · ${formatNumber(
        queue.done,
      )} completados`,
    ),
    statCard(
      'Actividad de hoy',
      formatNumber((stats.inboundToday ?? 0) + (stats.outboundToday ?? 0)),
      'Mensajes intercambiados',
    ),
    statCard(
      'Uptime',
      formatDuration(data.uptimeSeconds),
      data.worker?.running ? 'Worker activo' : 'Worker detenido',
    ),
  ].join('');

  renderHealth(els.healthGrid, data.health, data.worker, data.bot?.aiProvider);
  setConnectionChip(data.health, data.bot?.aiProvider);

  const settings = data.settings ?? {};
  renderInfoList(els.botInfo, [
    ['Bot', `${data.bot?.name ?? '—'}${data.bot?.enabled ? '' : ' (desactivado)'}`],
    ['Modelo', data.bot?.model ?? '—'],
    ['Zona horaria', data.bot?.timeZone ?? '—'],
    ['Historial', `${formatNumber(data.bot?.historyMaxMessages)} mensajes`],
    [
      'Resúmenes',
      data.bot?.summaryEnabled
        ? `Cada ${formatNumber(settings.summaryTriggerMessages)} mensajes`
        : 'Desactivados',
    ],
    ['Grupos', settings.ignoreGroups ? 'Ignorados' : 'Habilitados'],
    [
      'Chats permitidos',
      settings.allowedChatsConfigured > 0
        ? formatNumber(settings.allowedChatsConfigured)
        : 'Todos',
    ],
    ['Tatuador', settings.tattooArtist || 'Sin configurar'],
    ['Webhook HMAC', settings.webhookHmacEnabled ? 'Activo' : 'Sin firma'],
    ['Panel admin', settings.adminEnabled ? 'Activo' : 'Desactivado'],
    ['Versión', data.version ?? '—'],
  ]);

  els.queueInfo.innerHTML = `
    <div class="queue-item">
      <strong>${formatNumber(queue.pending)}</strong>
      <span>Pendientes</span>
    </div>
    <div class="queue-item">
      <strong>${formatNumber(queue.processing)}</strong>
      <span>Procesando</span>
    </div>
    <div class="queue-item ${queue.failed > 0 ? 'danger' : ''}">
      <strong>${formatNumber(queue.failed)}</strong>
      <span>Fallidos</span>
    </div>
    <div class="queue-item">
      <strong>${formatNumber(queue.done)}</strong>
      <span>Completados</span>
    </div>
    <p class="queue-note muted small">
      ${
        queue.oldest_pending_at
          ? `Trabajo pendiente más antiguo: ${esc(
              formatRelative(queue.oldest_pending_at),
            )}`
          : 'No hay trabajos pendientes en la cola.'
      }
    </p>`;

  const dashboardUrl = data.dashboardUrl || '#';
  els.wahaLink.href = dashboardUrl;
  els.wahaLink.setAttribute(
    'aria-disabled',
    dashboardUrl === '#' ? 'true' : 'false',
  );
}

/* ---------- WhatsApp ---------- */

const WHATSAPP_STATUS = {
  WORKING: {
    label: 'Conectado',
    severity: 'ok',
    detail: 'WhatsApp vinculado y listo para responder.',
    hint: 'El bot ya puede recibir y enviar mensajes.',
  },
  SCAN_QR_CODE: {
    label: 'Esperando escaneo',
    severity: 'warn',
    detail: 'Escaneá el código QR con tu teléfono.',
    hint: 'El código se renueva automáticamente. Si vence, generá uno nuevo.',
  },
  STARTING: {
    label: 'Iniciando sesión',
    severity: 'warn',
    detail: 'WAHA está arrancando la sesión.',
    hint: 'El código QR aparecerá en unos segundos.',
  },
  FAILED: {
    label: 'Sesión fallida',
    severity: 'error',
    detail: 'Los códigos QR expiraron o la sesión se cerró.',
    hint: 'Usá “Generar QR nuevo” para reiniciar la sesión.',
  },
  STOPPED: {
    label: 'Sesión detenida',
    severity: 'warn',
    detail: 'La sesión está detenida.',
    hint: 'Usá “Generar QR nuevo” para arrancarla de nuevo.',
  },
};

function applyWhatsAppData(data) {
  state.whatsapp.ok = data.ok !== false;
  state.whatsapp.exists = Boolean(data.exists);
  state.whatsapp.status = data.status ?? null;
  state.whatsapp.me = data.me ?? null;
  state.whatsapp.error = data.error ?? null;
  if (data.dashboardUrl) state.whatsapp.dashboardUrl = data.dashboardUrl;
  state.whatsapp.lastUpdated = new Date().toISOString();
  renderWhatsApp();
}

function clearWhatsAppQr() {
  state.whatsapp.qrDataUrl = '';
  state.whatsapp.qrHint = '';
  els.whatsappQr.removeAttribute('src');
}

async function loadWhatsApp(options = {}) {
  if (state.whatsapp.loading) return;
  state.whatsapp.loading = true;
  try {
    const data = await apiAuthed('/whatsapp/status');
    applyWhatsAppData(data);

    if (shouldAutoConnectWhatsApp(data)) {
      await autoConnectWhatsApp();
      return;
    }

    if (data.ok && data.status === 'SCAN_QR_CODE') {
      await loadWhatsAppQr({ silent: options.silent });
    } else {
      clearWhatsAppQr();
      renderWhatsApp();
    }
  } catch (error) {
    if (!options.silent) handleError(error);
  } finally {
    state.whatsapp.loading = false;
  }
}

function shouldAutoConnectWhatsApp(data) {
  if (!data.ok) return false;
  if (['WORKING', 'STARTING', 'SCAN_QR_CODE'].includes(data.status)) {
    return false;
  }
  if (state.whatsapp.autoConnects >= 2) return false;
  if (Date.now() - state.whatsapp.autoConnectAt < 30_000) return false;
  return (
    data.exists === false ||
    data.status === 'FAILED' ||
    data.status === 'STOPPED'
  );
}

async function autoConnectWhatsApp() {
  state.whatsapp.autoConnects += 1;
  state.whatsapp.autoConnectAt = Date.now();
  try {
    const data = await apiAuthed('/whatsapp/connect', { method: 'POST' });
    applyWhatsAppData(data);
    clearWhatsAppQr();

    if (data.status === 'SCAN_QR_CODE') {
      await loadWhatsAppQr({ silent: true });
    }

    toast(
      data.action === 'created'
        ? 'Sesión creada. Generando el código QR…'
        : 'Sesión reiniciada. Generando el código QR…',
    );
  } catch (error) {
    // El panel ya muestra el estado y el botón manual; evitamos duplicar el
    // error en cada reintento automático.
    if (error.status !== 401) {
      state.whatsapp.qrHint =
        error.message || 'No se pudo reiniciar la sesión automáticamente.';
      renderWhatsApp();
    }
  }
}

async function loadWhatsAppQr(options = {}) {
  try {
    const data = await apiAuthed('/whatsapp/qr');
    state.whatsapp.qrHint = '';
    if (data.dataUrl) {
      state.whatsapp.qrDataUrl = data.dataUrl;
      els.whatsappQr.src = data.dataUrl;
    }
  } catch (error) {
    if (error.status === 409) {
      // WAHA todavía está generando el QR: es un estado transitorio.
      state.whatsapp.qrHint = error.message;
    } else if (!options.silent) {
      handleError(error);
    }
  } finally {
    renderWhatsApp();
  }
}

function renderWhatsApp() {
  const whatsapp = state.whatsapp;
  const meta = WHATSAPP_STATUS[whatsapp.status] ?? {
    label: whatsapp.status || 'Sin sesión',
    severity: 'neutral',
    detail: 'No se pudo determinar el estado de la sesión.',
    hint: 'Revisá el dashboard de WAHA para más detalles.',
  };

  let label = meta.label;
  let severity = meta.severity;
  let detail = meta.detail;
  let hint = meta.hint;

  if (whatsapp.ok === false) {
    label = 'WAHA sin conexión';
    severity = 'error';
    detail = 'No se pudo contactar al servicio de WhatsApp.';
    hint =
      whatsapp.error ||
      'Verificá que el contenedor de WAHA esté corriendo.';
  } else if (whatsapp.exists === false) {
    label = 'Sin sesión de WhatsApp';
    severity = 'warn';
    detail = 'Todavía no existe una sesión en WAHA.';
    hint = 'Usá “Crear sesión y generar QR” para empezar.';
  }

  if (whatsapp.status === 'SCAN_QR_CODE' && whatsapp.qrHint) {
    hint = whatsapp.qrHint;
  }

  const me = whatsapp.me;
  const phone = me?.id ? String(me.id).split('@')[0] : '';
  if (whatsapp.status === 'WORKING' && (phone || me?.pushName)) {
    detail = [me?.pushName, phone].filter(Boolean).join(' · ');
  }

  els.whatsappStatusChip.className = `chip ${severity}`;
  els.whatsappStatusChip.textContent = label;

  els.whatsappStatus.innerHTML = `
    <div class="status-main">
      <span class="health-dot ${severity === 'neutral' ? '' : severity}"></span>
      <div class="status-copy">
        <strong>${esc(label)}</strong>
        <span>${esc(detail)}</span>
      </div>
    </div>
    <p class="status-hint muted small ${
      severity === 'error' ? 'error' : ''
    }">${esc(hint)}</p>`;

  renderInfoList(els.whatsappInfo, [
    ['Estado técnico', whatsapp.status ?? '—'],
    [
      'Sesión',
      whatsapp.exists === null
        ? 'Comprobando…'
        : whatsapp.exists
          ? 'Creada'
          : 'No creada',
    ],
    ['Teléfono', phone || '—'],
    ['Nombre', me?.pushName || '—'],
    [
      'Actualizado',
      whatsapp.lastUpdated ? formatTime(whatsapp.lastUpdated) : '—',
    ],
  ]);

  const showQr =
    whatsapp.status === 'SCAN_QR_CODE' && Boolean(whatsapp.qrDataUrl);
  els.whatsappQrPanel.hidden = !showQr;

  els.whatsappConnect.hidden = false;
  els.whatsappConnect.disabled = false;
  if (whatsapp.ok === false) {
    els.whatsappConnect.textContent = 'Reintentar conexión';
  } else if (whatsapp.exists === false) {
    els.whatsappConnect.textContent = 'Crear sesión y generar QR';
  } else if (whatsapp.status === 'WORKING') {
    els.whatsappConnect.hidden = true;
  } else if (whatsapp.status === 'STARTING') {
    els.whatsappConnect.textContent = 'Iniciando…';
    els.whatsappConnect.disabled = true;
  } else if (whatsapp.status === 'SCAN_QR_CODE') {
    els.whatsappConnect.textContent = 'Actualizar QR';
  } else {
    els.whatsappConnect.textContent = 'Generar QR nuevo';
  }

  const canRestart =
    whatsapp.ok === true &&
    whatsapp.exists === true &&
    whatsapp.status !== 'WORKING';
  els.whatsappRestart.hidden = !canRestart;
  els.whatsappRestart.disabled = whatsapp.status === 'STARTING';

  els.whatsappDashboardLink.href = whatsapp.dashboardUrl || '#';
}

async function connectWhatsApp(button) {
  try {
    await withBusy(button, async () => {
      const data = await apiAuthed('/whatsapp/connect', { method: 'POST' });
      applyWhatsAppData(data);
      clearWhatsAppQr();

      if (data.status === 'SCAN_QR_CODE') {
        await loadWhatsAppQr();
      }

      if (data.action === 'created') {
        toast('Sesión creada. Generando el código QR…');
      } else if (data.action === 'restarted') {
        toast('Sesión reiniciada. Generando el código QR…');
      } else {
        toast('Estado de WhatsApp actualizado');
      }
    });
  } finally {
    renderWhatsApp();
  }
}

async function restartWhatsApp(button) {
  try {
    await withBusy(button, async () => {
      const data = await apiAuthed('/whatsapp/restart', { method: 'POST' });
      applyWhatsAppData(data);
      clearWhatsAppQr();
      toast('Sesión reiniciada. El QR aparecerá en unos segundos.');
    });
  } finally {
    renderWhatsApp();
  }
}

/* ---------- Tatuador / cotizaciones ---------- */

function applyTattooData(data) {
  state.tattoo = {
    configured: Boolean(data.configured),
    phone: data.phone ?? null,
    displayPhone: data.displayPhone ?? null,
    chatId: data.chatId ?? null,
    artistName: data.artistName ?? 'tatuador',
    source: data.source ?? 'none',
    countryCode: data.countryCode ?? '57',
    loaded: true,
  };

  if (document.activeElement !== els.tattooPhone) {
    els.tattooPhone.value = state.tattoo.phone ?? '';
  }
  renderTattoo();
}

function tattooSourceLabel(source) {
  if (source === 'dashboard') return 'Guardado desde este panel';
  if (source === 'env') return 'Configurado desde .env';
  return 'Sin configurar';
}

function renderTattoo() {
  const tattoo = state.tattoo;
  const display = tattoo.displayPhone || tattoo.chatId || '';

  els.tattooStatusChip.className = `chip ${
    tattoo.configured ? 'ok' : 'warn'
  }`;
  els.tattooStatusChip.textContent = tattoo.configured
    ? 'Configurado'
    : 'Sin configurar';
  els.tattooClear.hidden = tattoo.source !== 'dashboard';

  if (tattoo.configured) {
    els.tattooHint.classList.remove('error');
    els.tattooHint.textContent = `${tattooSourceLabel(
      tattoo.source,
    )} · Las consultas de precio se envían a ${display}.`;
  } else {
    els.tattooHint.classList.add('error');
    els.tattooHint.textContent =
      'Sin configurar: el bot no puede derivar consultas de precio al tatuador.';
  }
}

async function loadTattoo(options = {}) {
  try {
    const data = await apiAuthed('/tattoo');
    applyTattooData(data);
  } catch (error) {
    if (!options.silent) handleError(error);
  }
}

function normalizeTattooInput() {
  let digits = els.tattooPhone.value.replace(/\D/g, '');
  if (digits.startsWith('0057')) digits = digits.slice(4);
  if (digits.length === 12 && digits.startsWith('57')) digits = digits.slice(2);
  els.tattooPhone.value = digits.slice(0, 10);
}

async function saveTattoo(event) {
  event.preventDefault();
  const phone = els.tattooPhone.value.trim();
  if (!phone) {
    toast('Ingresá el número del tatuador', 'error');
    els.tattooPhone.focus();
    return;
  }

  await withBusy(els.tattooSave, async () => {
    const data = await apiAuthed('/tattoo', {
      method: 'PUT',
      body: { phone },
    });
    applyTattooData(data);
    els.tattooPhone.value = data.phone ?? '';
    toast(`Tatuador configurado: ${data.displayPhone || data.chatId}`);
    if (state.tab === 'overview') void loadOverview({ silent: true });
  });
}

async function clearTattoo() {
  const confirmed = window.confirm(
    '¿Quitar el número del tatuador guardado desde el panel? Si hay un valor en .env, se usará ese.',
  );
  if (!confirmed) return;

  await withBusy(els.tattooClear, async () => {
    const data = await apiAuthed('/tattoo', {
      method: 'PUT',
      body: { phone: '' },
    });
    applyTattooData(data);
    toast('Número del tatuador quitado');
    if (state.tab === 'overview') void loadOverview({ silent: true });
  });
}

/* ---------- Agenda de Notion ---------- */

function applyNotionData(data) {
  state.notion = {
    configured: Boolean(data.configured),
    ready: Boolean(data.ready),
    tokenSet: Boolean(data.tokenSet),
    tokenSource: data.tokenSource ?? 'none',
    databaseId: data.databaseId ?? null,
    databaseTitle: data.databaseTitle ?? null,
    databaseUrl: data.databaseUrl ?? null,
    dateProperty: data.dateProperty ?? null,
    titleProperty: data.titleProperty ?? null,
    statusProperty: data.statusProperty ?? null,
    warning: data.warning ?? null,
    lastError: data.lastError ?? null,
    checkedAt: data.checkedAt ?? null,
    loaded: true,
  };

  if (document.activeElement !== els.notionDatabase) {
    els.notionDatabase.value = state.notion.databaseId ?? '';
  }
  els.notionToken.value = '';
  renderNotion();
}

function notionSourceLabel(source) {
  if (source === 'dashboard') return 'Token guardado en el panel';
  if (source === 'env') return 'Token configurado desde .env';
  return 'Token sin configurar';
}

function renderNotion() {
  const notion = state.notion;
  let chipClass = 'neutral';
  let chipText = 'Sin configurar';

  if (notion.ready) {
    chipClass = 'ok';
    chipText = 'Agenda lista';
  } else if (notion.configured) {
    chipClass = 'warn';
    chipText = 'Revisar agenda';
  } else if (notion.tokenSet) {
    chipClass = 'warn';
    chipText = 'Falta la base';
  }

  els.notionStatusChip.className = `chip ${chipClass}`;
  els.notionStatusChip.textContent = chipText;
  els.notionToken.placeholder = notion.tokenSet
    ? 'Token guardado · dejalo vacío para conservarlo'
    : 'ntn_…';

  const lines = [notionSourceLabel(notion.tokenSource)];
  if (notion.databaseTitle) {
    lines.push(`Base: ${notion.databaseTitle}`);
  }
  if (notion.dateProperty) {
    lines.push(`Propiedad de fecha: ${notion.dateProperty}`);
  }
  if (notion.warning) {
    lines.push(notion.warning);
  }
  if (notion.lastError) {
    lines.push(`Último error: ${notion.lastError}`);
  }
  if (!notion.tokenSet && !notion.databaseId) {
    lines.push(
      'Compartí la base de agenda con la integración de Notion y configurala acá.',
    );
  }

  els.notionHint.textContent = lines.join(' · ');
  els.notionHint.classList.toggle(
    'error',
    Boolean(notion.lastError || notion.warning) || !notion.ready,
  );
}

async function loadNotion(options = {}) {
  try {
    const data = await apiAuthed('/notion');
    applyNotionData(data);
  } catch (error) {
    if (!options.silent) handleError(error);
  }
}

async function saveNotion(event) {
  event.preventDefault();
  const token = els.notionToken.value.trim();
  const databaseId = els.notionDatabase.value.trim();
  const body = {};

  if (token) body.apiKey = token;
  if (databaseId !== (state.notion.databaseId ?? '')) {
    body.databaseId = databaseId;
  }
  if (Object.keys(body).length === 0) {
    toast('No hay cambios para guardar en Notion');
    return;
  }

  await withBusy(els.notionSave, async () => {
    const data = await apiAuthed('/notion', { method: 'PUT', body });
    applyNotionData(data);
    els.notionDatabases.hidden = true;
    toast(
      data.ready
        ? `Agenda conectada: ${data.databaseTitle || 'Notion'}`
        : 'Configuración de Notion guardada. Revisá la base y el token.',
    );
  });
}

async function testNotion() {
  await withBusy(els.notionTest, async () => {
    const result = await apiAuthed('/notion/test', { method: 'POST' });
    if (result.ok) {
      toast('Conexión con Notion verificada');
    } else {
      toast(result.error || 'No se pudo conectar con Notion', 'error');
    }
    await loadNotion({ silent: true });
  });
}

function renderNotionDatabases(databases) {
  els.notionDatabases.innerHTML = '';

  if (!databases.length) {
    els.notionDatabases.hidden = true;
    return;
  }

  els.notionDatabases.hidden = false;
  for (const database of databases) {
    const row = document.createElement('div');
    row.className = 'notion-database-option';

    const title = document.createElement('span');
    title.textContent = database.title || database.id;
    title.title = database.url || database.id;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button ghost small';
    button.textContent = 'Usar esta base';
    button.addEventListener('click', () => {
      useNotionDatabase(database.id, button).catch(handleError);
    });

    row.append(title, button);
    els.notionDatabases.append(row);
  }
}

async function useNotionDatabase(databaseId, button) {
  await withBusy(button, async () => {
    const data = await apiAuthed('/notion', {
      method: 'PUT',
      body: { databaseId },
    });
    applyNotionData(data);
    els.notionDatabases.hidden = true;
    toast(
      data.ready
        ? `Agenda conectada: ${data.databaseTitle || 'Notion'}`
        : 'Base guardada. Revisá la propiedad de fecha.',
    );
  });
}

async function discoverNotion() {
  await withBusy(els.notionDiscover, async () => {
    const result = await apiAuthed('/notion/discover', { method: 'POST' });
    renderNotionDatabases(result.databases ?? []);

    if (result.warning) {
      toast(result.warning, 'error');
    } else if ((result.databases ?? []).length === 0) {
      toast('No hay bases compartidas con la integración', 'error');
    } else {
      toast(
        `${result.databases.length} base(s) encontrada(s). Elegí la agenda.`,
      );
    }
  });
}

/* ---------- Conversaciones ---------- */

async function loadConversations(options = {}) {
  if (state.conversations.loading) return;
  state.conversations.loading = true;
  try {
    const params = new URLSearchParams({
      limit: String(state.conversations.limit),
      offset: String(state.conversations.offset),
      search: state.conversations.search,
      status: state.conversations.status,
    });
    const data = await apiAuthed(`/conversations?${params.toString()}`);
    state.conversations.items = data.items ?? [];
    state.conversations.total = data.total ?? 0;
    state.conversations.loaded = true;
    renderConversationList();
  } catch (error) {
    if (!options.silent) handleError(error);
  } finally {
    state.conversations.loading = false;
  }
}

function renderConversationList() {
  const { items, total, limit, offset } = state.conversations;
  els.conversationsCount.textContent =
    total === 0
      ? 'Sin conversaciones'
      : `${formatNumber(total)} conversación${total === 1 ? '' : 'es'}`;

  if (items.length === 0) {
    els.conversationList.innerHTML = `<div class="list-empty">${
      state.conversations.search
        ? 'No hay resultados para esa búsqueda.'
        : 'Todavía no hay conversaciones. Cuando alguien le escriba al bot, aparecerá acá.'
    }</div>`;
  } else {
    els.conversationList.innerHTML = items
      .map((item) => {
        const contact = item.contact ?? {};
        const name = contact.displayName || contact.pushName || contact.waId;
        const last = item.lastMessage;
        const preview = last
          ? `${last.direction === 'out' ? 'Vos: ' : ''}${
              last.body || '(sin texto)'
            }`
          : 'Sin mensajes';
        const chips = [];
        if (item.pendingReply) chips.push('<span class="mini-chip pending">Pendiente</span>');
        if (!item.aiEnabled) chips.push('<span class="mini-chip">IA off</span>');
        if (item.status === 'archived')
          chips.push('<span class="mini-chip archived">Archivada</span>');

        return `
          <button
            class="conversation-item ${
              state.currentId === item.id ? 'active' : ''
            }"
            type="button"
            data-conversation-id="${item.id}"
          >
            <span class="avatar">${esc(initials(name))}</span>
            <span class="conversation-main">
              <span class="conversation-top">
                <span class="conversation-name">${esc(name)}</span>
                <span class="conversation-time">${esc(
                  formatRelative(item.lastMessageAt),
                )}</span>
              </span>
              <span class="conversation-preview">
                <span>${esc(preview)}</span>
                <span class="mini-chips">${chips.join('')}</span>
              </span>
            </span>
          </button>`;
      })
      .join('');
  }

  els.conversationsPage.textContent =
    total === 0
      ? '0'
      : `${formatNumber(offset + 1)}–${formatNumber(
          Math.min(offset + limit, total),
        )} de ${formatNumber(total)}`;
  els.conversationsPrev.disabled = offset <= 0;
  els.conversationsNext.disabled = offset + limit >= total;
}

function markActiveConversation(id) {
  els.conversationList
    .querySelectorAll('[data-conversation-id]')
    .forEach((button) => {
      button.classList.toggle(
        'active',
        Number(button.dataset.conversationId) === id,
      );
    });
}

function showDetailPlaceholder(title, text) {
  els.detailEmpty.innerHTML = `
    <div class="empty-icon" aria-hidden="true">💬</div>
    <h3>${esc(title)}</h3>
    <p class="muted">${esc(text)}</p>`;
  els.detailEmpty.hidden = false;
  els.detailContent.hidden = true;
}

async function openConversation(id, options = {}) {
  if (!id) return;
  const changed = state.currentId !== id;
  state.currentId = id;
  markActiveConversation(id);

  if (changed) {
    showDetailPlaceholder('Cargando conversación…', 'Un momento por favor.');
    els.manualText.value = '';
  }

  try {
    const data = await apiAuthed(`/conversations/${id}?limit=100`);
    state.detail = {
      ...data,
      messages: data.messages ?? [],
      hasMore: Boolean(data.hasMore),
      oldestId: data.messages?.[0]?.id ?? null,
    };
    els.detailEmpty.hidden = true;
    els.detailContent.hidden = false;
    renderDetail();
  } catch (error) {
    if (error.status !== 401) {
      showDetailPlaceholder(
        'No se pudo cargar la conversación',
        error.message || 'Intentá de nuevo en unos segundos.',
      );
    }
    handleError(error);
  }
}

function renderDetail() {
  const data = state.detail;
  if (!data) return;

  const contact = data.contact ?? {};
  const conversation = data.conversation ?? {};
  const name = contact.displayName || contact.pushName || contact.waId;
  const archived = conversation.status === 'archived';
  const aiEnabled = Boolean(conversation.aiEnabled);

  els.detailHeader.innerHTML = `
    <div class="detail-identity">
      <span class="avatar">${esc(initials(name))}</span>
      <div>
        <h3>${esc(name)}</h3>
        <p>${esc(contact.waId)}${contact.phone ? ` · ${esc(contact.phone)}` : ''}</p>
        <p class="muted small">
          Primera vez: ${esc(formatDate(contact.firstSeenAt))} ·
          Último mensaje: ${esc(formatRelative(conversation.lastMessageAt))}
        </p>
      </div>
    </div>
    <div class="detail-actions">
      <button
        type="button"
        class="toggle ${aiEnabled ? 'on' : ''}"
        data-action="toggle-ai"
        title="${aiEnabled ? 'Desactivar respuestas automáticas' : 'Activar respuestas automáticas'}"
      >
        <span class="dot"></span> IA ${aiEnabled ? 'activada' : 'desactivada'}
      </button>
      <button type="button" class="button ghost small" data-action="toggle-archive">
        ${archived ? 'Reactivar' : 'Archivar'}
      </button>
      <button type="button" class="button ghost small" data-action="reset-context">
        Reiniciar contexto
      </button>
      <button type="button" class="button ghost small" data-action="export">
        Exportar JSON
      </button>
    </div>`;

  if (data.summary) {
    els.detailSummary.innerHTML = `
      <div class="detail-summary">
        <h4>Resumen de contexto</h4>
        <p>${esc(data.summary.text)}</p>
        <p class="muted">
          Cubre ${formatNumber(data.summary.messagesCovered)} mensajes ·
          ${esc(formatDate(data.summary.createdAt))}
          ${data.summary.model ? ` · ${esc(data.summary.model)}` : ''}
        </p>
      </div>`;
  } else {
    els.detailSummary.innerHTML = '';
  }

  els.detailContext.textContent = `${formatNumber(
    data.context?.messageCount ?? 0,
  )} mensajes en contexto${
    archived ? ' · conversación archivada' : ''
  }`;

  els.loadOlder.hidden = !data.hasMore;
  renderMessageList();
  scrollMessagesToBottom();
}

function renderMessageList() {
  const data = state.detail;
  if (!data) return;

  const messages = data.messages ?? [];
  if (messages.length === 0) {
    els.messageList.innerHTML =
      '<div class="empty-mini">Todavía no hay mensajes en esta conversación.</div>';
    return;
  }

  const parts = [];
  let currentDay = '';

  for (const message of messages) {
    const day = formatDay(message.createdAt);
    if (day && day !== currentDay) {
      currentDay = day;
      parts.push(`<div class="day-separator">${esc(day)}</div>`);
    }

    const outbound = message.direction === 'out';
    const media = message.media;
    const body = message.body || (media ? '' : '(sin texto)');
    const kindLabel = KIND_LABELS[message.kind] ?? '';
    const failed = message.status === 'failed';

    const meta = [`<span>${esc(formatTime(message.createdAt))}</span>`];
    if (outbound && message.status) {
      meta.push(
        `<span class="status ${esc(message.status)}">${esc(
          statusLabel(message.status),
        )}</span>`,
      );
    }
    if (kindLabel) meta.push(`<span class="kind">${esc(kindLabel)}</span>`);
    if (message.model && message.model !== 'manual') {
      meta.push(
        `<span title="Modelo de IA">${esc(message.model)}</span>`,
      );
    }
    if (message.model === 'manual') {
      meta.push('<span class="bubble-manual">manual</span>');
    }
    if (message.latencyMs !== null && message.latencyMs !== undefined) {
      meta.push(`<span>${formatNumber(message.latencyMs)} ms</span>`);
    }

    const mediaBlock = media
      ? `<span class="media-icon" aria-hidden="true">${
          String(media.mime || '').startsWith('image/')
            ? '🖼️'
            : String(media.mime || '').startsWith('audio/')
              ? '🎧'
              : String(media.mime || '').startsWith('video/')
                ? '🎬'
                : '📎'
        }</span>`
      : '';

    const errorBlock =
      message.error && failed
        ? `<div class="bubble-error">
             ${esc(message.error)}
             ${
               outbound
                 ? `<br><button type="button" class="button danger small" data-action="retry-message" data-id="${message.id}">Reintentar envío</button>`
                 : ''
             }
           </div>`
        : '';

    parts.push(`
      <div class="message-row ${outbound ? 'out' : 'in'}">
        <div class="bubble">
          <div class="bubble-body ${media ? 'media' : ''}">
            ${mediaBlock}
            <span>${esc(body)}</span>
          </div>
          ${errorBlock}
          <div class="bubble-meta">${meta.join('')}</div>
        </div>
      </div>`);
  }

  els.messageList.innerHTML = parts.join('');
}

function scrollMessagesToBottom() {
  els.messageList.scrollTop = els.messageList.scrollHeight;
}

async function loadOlderMessages(button) {
  const data = state.detail;
  if (!data || !data.hasMore || !data.oldestId) return;

  const previousHeight = els.messageList.scrollHeight;
  const previousScroll = els.messageList.scrollTop;

  await withBusy(button, async () => {
    const older = await apiAuthed(
      `/conversations/${data.conversation.id}?limit=100&beforeId=${data.oldestId}`,
    );
    const olderMessages = older.messages ?? [];
    if (olderMessages.length > 0) {
      data.messages = [...olderMessages, ...data.messages];
      data.oldestId = olderMessages[0].id;
    }
    data.hasMore = Boolean(older.hasMore);
    els.loadOlder.hidden = !data.hasMore;
    renderMessageList();
    els.messageList.scrollTop =
      els.messageList.scrollHeight - previousHeight + previousScroll;
  });
}

async function withBusy(button, task) {
  if (!button) return task();
  const original = button.textContent;
  button.disabled = true;
  button.textContent = '…';
  try {
    return await task();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

/* ---------- Acciones de conversación ---------- */

async function toggleAi(button) {
  const data = state.detail;
  if (!data) return;
  const next = !data.conversation.aiEnabled;
  await withBusy(button, async () => {
    await apiAuthed(`/conversations/${data.conversation.id}`, {
      method: 'PATCH',
      body: { aiEnabled: next },
    });
    toast(next ? 'IA activada para esta conversación' : 'IA desactivada');
    await openConversation(data.conversation.id);
    await loadConversations({ silent: true });
  });
}

async function toggleArchive(button) {
  const data = state.detail;
  if (!data) return;
  const next = data.conversation.status === 'archived' ? 'active' : 'archived';
  await withBusy(button, async () => {
    await apiAuthed(`/conversations/${data.conversation.id}`, {
      method: 'PATCH',
      body: { status: next },
    });
    toast(next === 'archived' ? 'Conversación archivada' : 'Conversación reactivada');
    await openConversation(data.conversation.id);
    await loadConversations({ silent: true });
  });
}

async function resetContext(button) {
  const data = state.detail;
  if (!data) return;
  const confirmed = window.confirm(
    '¿Reiniciar el contexto de esta conversación? El historial se conserva, pero la IA dejará de usarlo.',
  );
  if (!confirmed) return;

  await withBusy(button, async () => {
    await apiAuthed(`/conversations/${data.conversation.id}/reset`, {
      method: 'POST',
    });
    toast('Contexto reiniciado. El historial quedó guardado.');
    await openConversation(data.conversation.id);
  });
}

async function retryMessage(button) {
  const messageId = Number(button.dataset.id);
  if (!messageId) return;

  await withBusy(button, async () => {
    await apiAuthed(`/messages/${messageId}/retry`, { method: 'POST' });
    toast('Mensaje reenviado');
    if (state.currentId) await openConversation(state.currentId);
    await loadConversations({ silent: true });
  });
}

async function exportConversation(button) {
  const data = state.detail;
  if (!data) return;

  await withBusy(button, async () => {
    const response = await fetch(
      `/api/admin/conversations/${data.conversation.id}/export`,
      { headers: { Authorization: `Bearer ${state.token}` } },
    );

    if (response.status === 401) {
      logout('La sesión expiró. Volvé a ingresar el token.');
      return;
    }
    if (!response.ok) {
      throw new Error(`No se pudo exportar (HTTP ${response.status})`);
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `conversacion-${data.conversation.id}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    toast('Historial exportado en JSON');
  });
}

async function sendManualMessage() {
  const data = state.detail;
  if (!data) return;
  const text = els.manualText.value.trim();
  if (!text) return;

  const button = els.manualForm.querySelector('button[type="submit"]');
  await withBusy(button, async () => {
    await apiAuthed(`/conversations/${data.conversation.id}/messages`, {
      method: 'POST',
      body: { text },
    });
    els.manualText.value = '';
    toast('Mensaje enviado por WhatsApp');
    await openConversation(data.conversation.id);
    await loadConversations({ silent: true });
  });
}

/* ---------- Sistema ---------- */

async function loadSystem(options = {}) {
  try {
    const data = await apiAuthed('/system');
    renderSystem(data);
  } catch (error) {
    if (!options.silent) handleError(error);
  }
}

function renderSystem(data) {
  renderHealth(els.systemHealth, data.health, data.worker, data.settings?.aiProvider);

  const settings = data.settings ?? {};
  renderInfoList(els.systemSettings, [
    ['Proveedor de IA', aiProviderLabel(settings.aiProvider)],
    ['Modelo', settings.model ?? '—'],
    ['Bot', settings.botName ?? '—'],
    ['Zona horaria', settings.timeZone ?? '—'],
    ['Historial máximo', `${formatNumber(settings.historyMaxMessages)} mensajes`],
    ['Límite de contexto', `${formatNumber(settings.historyMaxChars)} caracteres`],
    [
      'Resúmenes',
      settings.summaryEnabled
        ? `Cada ${formatNumber(settings.summaryTriggerMessages)} mensajes`
        : 'Desactivados',
    ],
    ['Grupos', settings.ignoreGroups ? 'Ignorados' : 'Habilitados'],
    [
      'Chats permitidos',
      settings.allowedChatsConfigured > 0
        ? formatNumber(settings.allowedChatsConfigured)
        : 'Todos',
    ],
    ['Tatuador', settings.tattooArtist || 'Sin configurar'],
    ['Webhook HMAC', settings.webhookHmacEnabled ? 'Activo' : 'Sin firma'],
    ['Panel admin', settings.adminEnabled ? 'Activo' : 'Desactivado'],
  ]);

  const jobs = data.failedJobs ?? [];
  els.failedJobsCount.textContent = String(jobs.length);
  els.failedJobsCount.className = `chip ${
    jobs.length > 0 ? 'error' : 'neutral'
  }`;
  els.failedJobs.innerHTML =
    jobs.length === 0
      ? '<div class="empty-mini">No hay trabajos fallidos. Todo en orden.</div>'
      : jobs
          .map(
            (job) => `
              <div class="stack-item">
                <div class="stack-item-top">
                  <span class="stack-item-title">Trabajo #${job.id} · ${esc(
                    job.chatId,
                  )}</span>
                  <span class="badge failed">${formatNumber(
                    job.attempts,
                  )}/${formatNumber(job.maxAttempts)}</span>
                </div>
                <div class="stack-item-sub">
                  ${esc(job.lastError || 'Sin detalle del error')}
                </div>
                <div class="stack-item-sub">
                  Actualizado: ${esc(formatDate(job.updatedAt))}
                </div>
                <button
                  type="button"
                  class="button ghost small"
                  data-job-id="${job.id}"
                >
                  Reintentar trabajo
                </button>
              </div>`,
          )
          .join('');

  const events = data.events ?? [];
  els.recentEvents.innerHTML =
    events.length === 0
      ? '<div class="empty-mini">Todavía no hay eventos de webhook.</div>'
      : events
          .map(
            (event) => `
              <div class="stack-item">
                <div class="stack-item-top">
                  <span class="stack-item-title">${esc(event.event)}</span>
                  <span class="badge ${esc(event.status)}">${esc(
                    event.status,
                  )}</span>
                </div>
                <div class="stack-item-sub">
                  ${esc(formatDate(event.createdAt))}${
                    event.reason ? ` · ${esc(event.reason)}` : ''
                  }
                </div>
                ${
                  event.payloadPreview
                    ? `<details>
                         <summary>Ver payload</summary>
                         <pre>${esc(event.payloadPreview)}</pre>
                       </details>`
                    : ''
                }
              </div>`,
          )
          .join('');
}

async function retryJob(button) {
  const jobId = Number(button.dataset.jobId);
  if (!jobId) return;
  await withBusy(button, async () => {
    await apiAuthed(`/jobs/${jobId}/retry`, { method: 'POST' });
    toast('Trabajo reencolado');
    await loadSystem();
  });
}

/* ---------- Eventos de interfaz ---------- */

/* ---------- Agenda: tabla, filtros y detalle ---------- */

const AGENDA_STATUS_LABELS = {
  confirmada: 'Confirmada',
  pendiente: 'Depósito pend.',
  cotizacion: 'Cotización',
  completada: 'Completada',
  cancelada: 'Cancelada',
};

function money(value) {
  return `$${formatNumber(value)}`;
}

function appointmentDate(item) {
  return new Date(item.at);
}

function filteredAppointments() {
  const query = state.agenda.search.trim().toLowerCase();
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const start = new Date(now);
  const end = new Date(now);

  if (state.agenda.period === 'hoy') {
    end.setDate(end.getDate() + 1);
  } else if (state.agenda.period === 'semana') {
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    end.setDate(start.getDate() + 7);
  } else if (state.agenda.period === 'mes') {
    start.setDate(1);
    end.setMonth(now.getMonth() + 1, 1);
  }

  return APPOINTMENTS.filter((item) => {
    if (state.agenda.status !== 'all' && item.status !== state.agenda.status) return false;
    if (state.agenda.artist !== 'all' && item.artist !== state.agenda.artist) return false;
    if (query && !`${item.code} ${item.client} ${item.phone} ${item.design} ${item.zone}`.toLowerCase().includes(query)) return false;
    if (state.agenda.period !== 'all') {
      const date = appointmentDate(item);
      if (date < start || date >= end) return false;
    }
    return true;
  }).sort((a, b) => appointmentDate(a) - appointmentDate(b));
}

function appointmentRow(item) {
  const date = appointmentDate(item);
  const day = dateFormatter({ weekday: 'short', day: '2-digit', month: 'short' }).format(date);
  const time = dateFormatter({ hour: '2-digit', minute: '2-digit' }).format(date);

  return `
    <tr data-code="${esc(item.code)}" class="${state.agenda.selected === item.code ? 'row-selected' : ''}">
      <td><span class="cell-code">${esc(item.code)}</span></td>
      <td>
        <div class="cell-client">
          <span class="mini-avatar">${esc(initials(item.client))}</span>
          <div><strong>${esc(item.client)}</strong><small>${esc(item.phone)}</small></div>
        </div>
      </td>
      <td><div class="cell-design"><span>${esc(item.design)}</span><small>${esc(item.zone)}</small></div></td>
      <td>
        <div class="cell-artist">
          <span class="mini-avatar soft">${esc(initials(item.artist))}</span>
          <strong>${esc(item.artist)}</strong>
        </div>
      </td>
      <td><div class="cell-when">${esc(day)}<small>${esc(time)}</small></div></td>
      <td class="num"><span class="cell-price">${money(item.price)}</span></td>
      <td class="num">
        <span class="deposit ${item.paid ? 'paid' : item.deposit ? 'due' : ''}">
          <span class="dot"></span>${item.deposit ? money(item.deposit) : '—'}
        </span>
      </td>
      <td><span class="table-status ${esc(item.status)}">${esc(AGENDA_STATUS_LABELS[item.status] ?? item.status)}</span></td>
      <td><button class="row-more" type="button" aria-label="Ver detalle de ${esc(item.code)}"><svg class="icon" aria-hidden="true"><use href="#i-more"/></svg></button></td>
    </tr>`;
}

function periodLabel() {
  const now = new Date();
  if (state.agenda.period === 'hoy') {
    return dateFormatter({ weekday: 'long', day: 'numeric', month: 'long' }).format(now);
  }
  if (state.agenda.period === 'mes') {
    return dateFormatter({ month: 'long', year: 'numeric' }).format(now);
  }
  const start = new Date(now);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const from = dateFormatter({ day: 'numeric' }).format(start);
  const to = dateFormatter({ day: 'numeric', month: 'short' }).format(end);
  return `semana del ${from} al ${to}`;
}

function renderAgenda() {
  if (!els.agendaBody) return;
  const items = filteredAppointments();
  els.agendaBody.innerHTML = items.length
    ? items.map(appointmentRow).join('')
    : '<tr><td colspan="9" class="table-empty">No hay citas que coincidan con los filtros.</td></tr>';
  els.agendaCount.textContent = `${items.length} ${items.length === 1 ? 'registro' : 'registros'}`;
  els.agendaFootCount.textContent = `mostrando ${items.length} de ${APPOINTMENTS.length}`;
  if (els.agendaPeriodLabel) els.agendaPeriodLabel.textContent = periodLabel();

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const todayCount = APPOINTMENTS.filter((item) => {
    const date = appointmentDate(item);
    return date >= today && date < tomorrow && ['confirmada', 'pendiente'].includes(item.status);
  }).length;
  const quoteCount = APPOINTMENTS.filter((item) => item.status === 'cotizacion').length;
  const countAgenda = document.getElementById('nav-count-agenda');
  const countQuotes = document.getElementById('nav-count-quotes');
  if (countAgenda) countAgenda.textContent = String(todayCount).padStart(2, '0');
  if (countQuotes) countQuotes.textContent = String(quoteCount).padStart(2, '0');
}

function renderBento() {
  const now = Date.now();
  const horizon = now + 3 * 86_400_000;
  const upcoming = APPOINTMENTS
    .filter((item) => {
      const date = appointmentDate(item).getTime();
      return date >= now && date <= horizon && item.status !== 'cancelada';
    })
    .sort((a, b) => appointmentDate(a) - appointmentDate(b))
    .slice(0, 3);

  els.upcomingList.innerHTML = upcoming.length
    ? upcoming.map((item) => {
        const tone = item.status === 'pendiente' ? 'crimson' : 'gold';
        const date = appointmentDate(item);
        const when = dateFormatter({ weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
        return `<div class="timeline-item">
          <div class="timeline-rail"><span class="${tone}"></span></div>
          <div class="timeline-body"><strong>${esc(item.client)}</strong><p>${esc(item.design)} · ${esc(item.artist)}</p><time>${esc(when)}</time></div>
        </div>`;
      }).join('')
    : '<p class="muted small">Sin sesiones en las próximas 72 h.</p>';

  const stale = APPOINTMENTS.filter((item) => item.status === 'cotizacion').slice(0, 3);
  els.staleList.innerHTML = stale.length
    ? stale.map((item) => `<div class="stale-item">
        <div><strong>${esc(item.client)}</strong><small>${esc(item.code)} · ${esc(item.design)}</small></div>
        <span class="wait">${esc(item.note.split('·')[0].trim())}</span>
      </div>`).join('')
    : '<div class="empty-mini">Sin cotizaciones abiertas.</div>';

  els.botActivity.innerHTML =
    '<p class="muted small">Sin actividad reciente del bot.</p>';
}

function openAppointment(code) {
  const item = APPOINTMENTS.find((entry) => entry.code === code);
  if (!item) return;
  state.agenda.selected = code;
  const date = appointmentDate(item);
  const when = dateFormatter({ weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(date);

  els.drawerTitle.textContent = item.code;
  els.drawerContent.innerHTML = `
    <section class="drawer-section">
      <h3>Cliente</h3>
      <div class="drawer-client">
        <span class="avatar-ring">${esc(initials(item.client))}</span>
        <div><strong>${esc(item.client)}</strong><small>${esc(item.phone)} · WhatsApp</small></div>
      </div>
    </section>
    <section class="drawer-section">
      <h3>Detalle de la sesión</h3>
      <dl class="drawer-facts">
        <div><dt>Estado</dt><dd>${esc(AGENDA_STATUS_LABELS[item.status] ?? item.status)}</dd></div>
        <div><dt>Fecha & hora</dt><dd>${esc(when)}</dd></div>
        <div><dt>Diseño</dt><dd>${esc(item.design)}</dd></div>
        <div><dt>Zona</dt><dd>${esc(item.zone)}</dd></div>
        <div><dt>Artista</dt><dd>${esc(item.artist)}</dd></div>
        <div><dt>Precio</dt><dd>${money(item.price)}</dd></div>
        <div><dt>Depósito</dt><dd>${item.deposit ? money(item.deposit) : '—'}</dd></div>
        <div><dt>Pago</dt><dd>${item.paid ? 'Recibido' : item.deposit ? 'Pendiente' : 'No requerido'}</dd></div>
      </dl>
      <p class="muted small" style="margin-top:10px">${esc(item.note)}</p>
    </section>
    <section class="drawer-section">
      <h3>Conversación de WhatsApp</h3>
      <div class="drawer-chat">
        ${CHAT_SCRIPT.length
          ? CHAT_SCRIPT.map((message) => `<div class="bubble ${message.from}">${esc(message.text)}<small>${esc(message.time)} · ${message.from === 'bot' ? 'Bot' : 'Cliente'}</small></div>`).join('')
          : '<p class="muted small">Sin conversación registrada para esta cita.</p>'}
      </div>
    </section>`;

  els.drawerBackdrop.hidden = false;
  els.drawer.hidden = false;
  document.body.style.overflow = 'hidden';
  renderAgenda();
  els.drawerClose.focus();
}

function closeDrawer() {
  if (!els.drawer || els.drawer.hidden) return;
  els.drawer.hidden = true;
  els.drawerBackdrop.hidden = true;
  document.body.style.overflow = '';
  state.agenda.selected = null;
  renderAgenda();
}

/* ---------- Catálogo flash ---------- */

function renderFlash(filter = 'all') {
  if (!els.flashGrid) return;
  const items = filter === 'all'
    ? FLASH_ITEMS
    : FLASH_ITEMS.filter((item) => item.category === filter);

  els.flashGrid.innerHTML = items.length
    ? items.map((item) => `
    <article class="card flash-card">
      <div class="flash-art">
        <span class="flash-code">${esc(item.code)}</span>
        <svg viewBox="0 0 100 100" aria-hidden="true">${FLASH_ART[item.art] ?? ''}</svg>
      </div>
      <div class="flash-body">
        <h3>${esc(item.name)}</h3>
        <p>${esc(item.category)} · disponible para agendar</p>
        <div class="flash-meta"><span class="price">${money(item.price)}</span><span class="size">${esc(item.size)}</span></div>
      </div>
    </article>`).join('')
    : '<p class="muted small">El catálogo está vacío. Agregá diseños cuando quieras.</p>';
}

function bindEvents() {
  els.loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const token = els.loginToken.value.trim();
    if (!token) return;

    els.loginSubmit.disabled = true;
    els.loginSubmit.textContent = 'Verificando…';
    els.loginError.hidden = true;

    state.token = token;
    try {
      const overview = await api('/overview');
      storeToken(token, els.loginRemember.checked);
      showApp(overview);
      toast('Sesión iniciada');
    } catch (error) {
      state.token = '';
      els.loginError.textContent =
        error.status === 401
          ? 'Token inválido. Revisá el valor de ADMIN_TOKEN en el archivo .env.'
          : error.message || 'No se pudo iniciar sesión.';
      els.loginError.hidden = false;
    } finally {
      els.loginSubmit.disabled = false;
      els.loginSubmit.textContent = 'Entrar al panel';
    }
  });

  els.logoutButton.addEventListener('click', () => {
    logout();
    toast('Sesión cerrada');
  });

  els.tabs.forEach((button, index) => {
    button.addEventListener('click', () => {
      const filter = button.dataset.agendaFilter;
      switchTab(button.dataset.tab, filter ? { agendaStatus: filter } : {});
    });
    button.addEventListener('keydown', (event) => {
      const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      let next = index;
      if (event.key === 'ArrowRight') next = (index + 1) % els.tabs.length;
      if (event.key === 'ArrowLeft')
        next = (index - 1 + els.tabs.length) % els.tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = els.tabs.length - 1;
      els.tabs[next].focus();
      switchTab(els.tabs[next].dataset.tab);
    });
  });

  els.refreshTop.addEventListener('click', () => {
    switchTab(state.tab);
    toast('Sección actualizada');
  });

  /* Agenda */
  els.agendaSearch.addEventListener('input', () => {
    state.agenda.search = els.agendaSearch.value.trim();
    renderAgenda();
  });
  els.agendaArtist.addEventListener('change', () => {
    state.agenda.artist = els.agendaArtist.value;
    renderAgenda();
  });
  document.querySelectorAll('.seg').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.seg').forEach((other) => other.classList.toggle('active', other === button));
      state.agenda.period = button.dataset.period;
      renderAgenda();
    });
  });
  document.querySelectorAll('.filter-chip[data-status]').forEach((button) => {
    button.addEventListener('click', () => {
      state.agenda.status = button.dataset.status;
      syncAgendaFilterChips();
      activateTab('agenda');
      renderAgenda();
    });
  });
  els.agendaBody.addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-code]');
    if (row) openAppointment(row.dataset.code);
  });
  els.drawerClose.addEventListener('click', closeDrawer);
  els.drawerBackdrop.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeDrawer();
    if (event.key === '/' && state.tab === 'agenda' && state.inApp) {
      const tag = document.activeElement?.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
        event.preventDefault();
        els.agendaSearch.focus();
      }
    }
  });
  document.getElementById('drawer-confirm').addEventListener('click', () => {
    const item = APPOINTMENTS.find((entry) => entry.code === state.agenda.selected);
    if (item) item.status = 'confirmada';
    closeDrawer();
    toast('Cita confirmada y sincronizada con Notion');
  });
  document.getElementById('drawer-remind').addEventListener('click', () => {
    toast('Recordatorio enviado por WhatsApp');
  });
  document.getElementById('drawer-open-chat').addEventListener('click', () => {
    closeDrawer();
    switchTab('conversations');
  });
  document.getElementById('agenda-new').addEventListener('click', () => {
    toast('La alta de citas se hace desde el flujo de WhatsApp', 'success');
  });
  document.getElementById('agenda-export').addEventListener('click', () => {
    toast('Exportación disponible cuando se conecte la agenda de Notion');
  });

  /* Artistas y catálogo */
  document.querySelectorAll('[data-artist-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      state.agenda.artist = button.dataset.artistFilter;
      els.agendaArtist.value = button.dataset.artistFilter;
      switchTab('agenda');
    });
  });
  document.querySelectorAll('.filter-chip[data-flash-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.filter-chip[data-flash-filter]').forEach((other) => other.classList.toggle('active', other === button));
      renderFlash(button.dataset.flashFilter);
    });
  });

  els.refreshOverview.addEventListener('click', () =>
    loadOverview({ silent: false }),
  );
  els.refreshConversations.addEventListener('click', () =>
    loadConversations({ silent: false }),
  );
  els.refreshSystem.addEventListener('click', () => loadSystem());
  els.refreshWhatsApp.addEventListener('click', () =>
    loadWhatsApp({ silent: false }),
  );
  els.whatsappConnect.addEventListener('click', () => {
    connectWhatsApp(els.whatsappConnect).catch(handleError);
  });
  els.whatsappRestart.addEventListener('click', () => {
    restartWhatsApp(els.whatsappRestart).catch(handleError);
  });
  els.tattooForm.addEventListener('submit', (event) => {
    saveTattoo(event).catch(handleError);
  });
  els.tattooClear.addEventListener('click', () => {
    clearTattoo().catch(handleError);
  });
  els.tattooPhone.addEventListener('blur', normalizeTattooInput);
  els.notionForm.addEventListener('submit', (event) => {
    saveNotion(event).catch(handleError);
  });
  els.notionTest.addEventListener('click', () => {
    testNotion().catch(handleError);
  });
  els.notionDiscover.addEventListener('click', () => {
    discoverNotion().catch(handleError);
  });
  els.goWhatsApp.addEventListener('click', () => switchTab('whatsapp'));
  els.goConversations.addEventListener('click', () =>
    switchTab('conversations'),
  );
  els.goSystem.addEventListener('click', () => switchTab('system'));

  let searchTimer;
  els.conversationSearch.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.conversations.search = els.conversationSearch.value.trim();
      state.conversations.offset = 0;
      void loadConversations();
    }, 300);
  });

  els.conversationStatus.addEventListener('change', () => {
    state.conversations.status = els.conversationStatus.value;
    state.conversations.offset = 0;
    void loadConversations();
  });

  els.conversationsPrev.addEventListener('click', () => {
    state.conversations.offset = Math.max(
      0,
      state.conversations.offset - state.conversations.limit,
    );
    void loadConversations();
  });

  els.conversationsNext.addEventListener('click', () => {
    if (
      state.conversations.offset + state.conversations.limit <
      state.conversations.total
    ) {
      state.conversations.offset += state.conversations.limit;
      void loadConversations();
    }
  });

  els.conversationList.addEventListener('click', (event) => {
    const item = event.target.closest('[data-conversation-id]');
    if (!item) return;
    void openConversation(Number(item.dataset.conversationId));
  });

  els.detailPanel.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button || button.disabled) return;

    const action = button.dataset.action;
    const handlers = {
      'toggle-ai': toggleAi,
      'toggle-archive': toggleArchive,
      'reset-context': resetContext,
      export: exportConversation,
      'retry-message': retryMessage,
    };
    const handler = handlers[action];
    if (!handler) return;

    Promise.resolve(handler(button)).catch(handleError);
  });

  els.loadOlder.addEventListener('click', () => {
    loadOlderMessages(els.loadOlder).catch(handleError);
  });

  els.manualForm.addEventListener('submit', (event) => {
    event.preventDefault();
    sendManualMessage().catch(handleError);
  });

  els.manualText.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      els.manualForm.requestSubmit();
    }
  });

  els.failedJobs.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-job-id]');
    if (!button) return;
    retryJob(button).catch(handleError);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !state.inApp) return;
    if (state.tab === 'overview') {
      void loadOverview({ silent: true });
    } else if (state.tab === 'whatsapp') {
      void loadWhatsApp({ silent: true });
    }
  });
}

async function init() {
  bindEvents();
  renderAgenda();
  renderBento();
  renderFlash();

  const storedToken = readStoredToken();
  if (!storedToken) {
    showLogin();
    return;
  }

  els.loginRemember.checked = Boolean(
    safeGet(window.localStorage, TOKEN_KEY),
  );
  state.token = storedToken;
  els.loginSubmit.disabled = true;
  els.loginSubmit.textContent = 'Verificando…';

  try {
    const overview = await api('/overview');
    showApp(overview);
  } catch (error) {
    clearStoredToken();
    showLogin(
      error.status === 401
        ? 'El token guardado ya no es válido. Ingresalo de nuevo.'
        : error.message,
    );
  } finally {
    els.loginSubmit.disabled = false;
    els.loginSubmit.textContent = 'Entrar al panel';
  }
}

void init();
