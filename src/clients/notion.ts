import { NotionError } from '../errors.js';

const NOTION_VERSION = '2022-06-28';
const DEFAULT_BASE_URL = 'https://api.notion.com/v1';

export interface NotionSelectOption {
  id?: string;
  name: string;
  color?: string;
}

export interface NotionProperty {
  id?: string;
  name?: string;
  type: string;
  title?: unknown;
  rich_text?: unknown;
  date?: unknown;
  number?: unknown;
  select?: { options?: NotionSelectOption[] };
  status?: { options?: NotionSelectOption[] };
  [key: string]: unknown;
}

export interface NotionDatabase {
  id: string;
  title: string;
  url: string;
  properties: Record<string, NotionProperty>;
}

export interface NotionPage {
  id: string;
  url: string;
}

export interface NotionPageInput {
  databaseId: string;
  properties: Record<string, unknown>;
  children?: unknown[];
}

interface NotionErrorBody {
  code?: string;
  message?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function plainText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((item) => {
      const record = asRecord(item);
      return typeof record?.plain_text === 'string' ? record.plain_text : '';
    })
    .join('')
    .trim();
}

/**
 * Acepta el ID de una base o la URL completa que copia Notion.
 * Ejemplo: `https://www.notion.so/Agenda-<id>?v=...`.
 */
export function normalizeNotionDatabaseId(
  value: string | null | undefined,
): string | null {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;

  const dashed = trimmed.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  );
  if (dashed?.[0]) return dashed[0].toLowerCase();

  const compact = trimmed.match(/[0-9a-f]{32}/i);
  if (!compact?.[0]) return null;

  const id = compact[0].toLowerCase();
  return [
    id.slice(0, 8),
    id.slice(8, 12),
    id.slice(12, 16),
    id.slice(16, 20),
    id.slice(20),
  ].join('-');
}

export function databaseTitle(database: NotionDatabase): string {
  return database.title || 'Base de Notion';
}

export class NotionClient {
  constructor(
    private readonly baseUrl: string = DEFAULT_BASE_URL,
    private readonly timeoutMs = 15_000,
  ) {}

  private async request<T>(
    token: string,
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    if (!token.trim()) {
      throw new NotionError('Falta configurar el token de Notion');
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${token.trim()}`,
          'Notion-Version': NOTION_VERSION,
          'Content-Type': 'application/json',
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Error de red desconocido';
      throw new NotionError(`No se pudo conectar con Notion: ${message}`);
    }

    const raw = await response.text();
    let body: unknown = {};
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = {};
      }
    }

    if (!response.ok) {
      const errorBody = body as NotionErrorBody;
      const detail =
        errorBody.message ||
        `Notion respondió con HTTP ${response.status}`;
      const code = errorBody.code ? ` (${errorBody.code})` : '';
      throw new NotionError(`${detail}${code}`, response.status, body);
    }

    return body as T;
  }

  async searchDatabases(token: string): Promise<NotionDatabase[]> {
    const databases: NotionDatabase[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 10; page += 1) {
      const body: Record<string, unknown> = {
        filter: { property: 'object', value: 'database' },
        page_size: 100,
      };
      if (cursor) body.start_cursor = cursor;

      const result = await this.request<{
        results?: unknown[];
        has_more?: boolean;
        next_cursor?: string | null;
      }>(token, '/search', { method: 'POST', body });

      for (const item of result.results ?? []) {
        const database = this.toDatabase(item);
        if (database) databases.push(database);
      }

      if (!result.has_more || !result.next_cursor) break;
      cursor = result.next_cursor;
    }

    return databases;
  }

  async retrieveDatabase(
    token: string,
    databaseId: string,
  ): Promise<NotionDatabase> {
    const normalized = normalizeNotionDatabaseId(databaseId);
    if (!normalized) {
      throw new NotionError('El ID de la base de Notion no es válido');
    }

    const result = await this.request<unknown>(
      token,
      `/databases/${normalized}`,
    );
    const database = this.toDatabase(result);
    if (!database) {
      throw new NotionError('Notion no devolvió una base válida');
    }
    return database;
  }

  async updateDatabase(
    token: string,
    databaseId: string,
    properties: Record<string, unknown>,
  ): Promise<NotionDatabase> {
    const normalized = normalizeNotionDatabaseId(databaseId);
    if (!normalized) {
      throw new NotionError('El ID de la base de Notion no es válido');
    }

    const result = await this.request<unknown>(
      token,
      `/databases/${normalized}`,
      { method: 'PATCH', body: { properties } },
    );
    const database = this.toDatabase(result);
    if (!database) {
      throw new NotionError('Notion no devolvió una base válida');
    }
    return database;
  }

  async createPage(token: string, input: NotionPageInput): Promise<NotionPage> {
    const normalized = normalizeNotionDatabaseId(input.databaseId);
    if (!normalized) {
      throw new NotionError('El ID de la base de Notion no es válido');
    }

    const body: Record<string, unknown> = {
      parent: { database_id: normalized },
      properties: input.properties,
    };
    if (input.children?.length) body.children = input.children;

    const result = await this.request<{ id?: string; url?: string }>(
      token,
      '/pages',
      { method: 'POST', body },
    );

    if (!result.id) {
      throw new NotionError('Notion no devolvió el ID de la página creada');
    }

    return { id: result.id, url: result.url ?? '' };
  }

  private toDatabase(value: unknown): NotionDatabase | null {
    const record = asRecord(value);
    if (!record || record.object !== 'database' || !record.id) return null;

    const properties = asRecord(record.properties) ?? {};
    const normalizedProperties: Record<string, NotionProperty> = {};
    for (const [name, property] of Object.entries(properties)) {
      const propertyRecord = asRecord(property);
      if (!propertyRecord) continue;
      normalizedProperties[name] = {
        ...propertyRecord,
        name,
        type: String(propertyRecord.type ?? ''),
      } as NotionProperty;
    }

    return {
      id: String(record.id),
      title: plainText(record.title),
      url: typeof record.url === 'string' ? record.url : '',
      properties: normalizedProperties,
    };
  }
}
