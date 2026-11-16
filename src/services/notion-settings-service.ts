import type { AppConfig } from '../config.js';
import type { ContactRow, QuoteRequestRow } from '../db/types.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Logger } from '../logger.js';
import {
  databaseTitle,
  normalizeNotionDatabaseId,
  NotionClient,
  type NotionDatabase,
  type NotionProperty,
} from '../clients/notion.js';
import type { AppointmentIntent } from '../domain/scheduling.js';
import { ValidationError } from '../errors.js';
import { errorMessage } from '../utils/async.js';
import { truncate } from '../utils/text.js';

const API_KEY_META = 'notion.api_key';
const DATABASE_ID_META = 'notion.database_id';
const DATABASE_TITLE_META = 'notion.database_title';
const LAST_ERROR_META = 'notion.last_error';
const LAST_CHECKED_META = 'notion.last_checked_at';

const AGENDA_DATABASE_PATTERN = /(?:agenda|cita|turno|tatuaje|calendario)/i;

export interface NotionAgendaSchema {
  databaseId: string;
  databaseTitle: string;
  databaseUrl: string;
  titleProperty: string;
  dateProperty: string | null;
  clientProperty: string | null;
  phoneProperty: string | null;
  codeProperty: string | null;
  priceProperty: string | null;
  pricePropertyType: 'number' | 'rich_text' | null;
  statusProperty: string | null;
  statusPropertyType: 'status' | 'select' | null;
  statusValue: string | null;
}

export interface NotionSettingsSnapshot {
  configured: boolean;
  ready: boolean;
  tokenSet: boolean;
  tokenSource: 'dashboard' | 'env' | 'none';
  databaseId: string | null;
  databaseTitle: string | null;
  databaseUrl: string | null;
  dateProperty: string | null;
  titleProperty: string | null;
  statusProperty: string | null;
  warning: string | null;
  lastError: string | null;
  checkedAt: string | null;
}

export interface NotionDatabaseCandidate {
  id: string;
  title: string;
  url: string;
}

export interface NotionAppointmentInput {
  quote: QuoteRequestRow;
  contact: ContactRow;
  appointment: AppointmentIntent & { start: Date };
  artistReply: string | null;
  timeZone: string;
}

function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function findProperty(
  properties: Record<string, NotionProperty>,
  predicate: (property: NotionProperty, name: string) => boolean,
): { name: string; property: NotionProperty } | null {
  for (const [name, property] of Object.entries(properties)) {
    if (predicate(property, name)) return { name, property };
  }
  return null;
}

function optionName(property: NotionProperty): string | null {
  const options =
    property.type === 'status'
      ? property.status?.options
      : property.select?.options;
  if (!Array.isArray(options) || options.length === 0) return null;

  const preferred = options.find((option) =>
    /(?:confirmad|agendad|reservad)/i.test(option.name),
  );
  return preferred?.name ?? options[0]?.name ?? null;
}

function schemaFromDatabase(database: NotionDatabase): NotionAgendaSchema {
  const title = findProperty(
    database.properties,
    (property) => property.type === 'title',
  );
  const date = findProperty(
    database.properties,
    (property) => property.type === 'date',
  );
  const client = findProperty(database.properties, (property, name) => {
    const normalized = normalizeName(name);
    return property.type === 'rich_text' && /cliente|nombre/.test(normalized);
  });
  const phone = findProperty(database.properties, (property, name) => {
    const normalized = normalizeName(name);
    return (
      property.type === 'rich_text' &&
      /telefono|whatsapp|celular/.test(normalized)
    );
  });
  const code = findProperty(database.properties, (property, name) => {
    const normalized = normalizeName(name);
    return (
      property.type === 'rich_text' &&
      /codigo|cotizacion|consulta/.test(normalized)
    );
  });
  const priceText = findProperty(database.properties, (property, name) => {
    const normalized = normalizeName(name);
    return property.type === 'rich_text' && /precio|valor|total/.test(normalized);
  });
  const priceNumber = findProperty(database.properties, (property, name) => {
    const normalized = normalizeName(name);
    return property.type === 'number' && /precio|valor|total/.test(normalized);
  });
  const notes = findProperty(database.properties, (property, name) => {
    const normalized = normalizeName(name);
    return (
      property.type === 'rich_text' &&
      /nota|detalle|descripcion/.test(normalized)
    );
  });
  const status = findProperty(database.properties, (property, name) => {
    const normalized = normalizeName(name);
    return (
      (property.type === 'status' || property.type === 'select') &&
      /estado/.test(normalized)
    );
  });

  return {
    databaseId: database.id,
    databaseTitle: databaseTitle(database),
    databaseUrl: database.url,
    titleProperty: title?.name ?? 'Name',
    dateProperty: date?.name ?? null,
    clientProperty: client?.name ?? null,
    phoneProperty: phone?.name ?? null,
    codeProperty: code?.name ?? notes?.name ?? null,
    priceProperty: priceNumber?.name ?? priceText?.name ?? null,
    pricePropertyType: priceNumber
      ? 'number'
      : priceText
        ? 'rich_text'
        : null,
    statusProperty: status?.name ?? null,
    statusPropertyType:
      status?.property.type === 'status'
        ? 'status'
        : status?.property.type === 'select'
          ? 'select'
          : null,
    statusValue: status ? optionName(status.property) : null,
  };
}

function richText(content: string): unknown {
  return {
    rich_text: [
      {
        type: 'text',
        text: { content: truncate(content, 1900, '') },
      },
    ],
  };
}

function titleText(content: string): unknown {
  return {
    title: [
      {
        type: 'text',
        text: { content: truncate(content, 1900, '') },
      },
    ],
  };
}

function parsePriceAmount(text: string | null): number | null {
  if (!text) return null;

  const thousands = /(\d+(?:[.,]\d+)?)\s*(mil|k)\b/i.exec(text);
  if (thousands?.[1]) {
    const value = Number(thousands[1].replace(',', '.'));
    if (Number.isFinite(value)) return Math.round(value * 1000);
  }

  const withSeparators = /\b\d{1,3}(?:[.,]\d{3})+\b/.exec(text);
  if (withSeparators?.[0]) {
    const value = Number(withSeparators[0].replace(/[.,]/g, ''));
    if (Number.isFinite(value)) return value;
  }

  const plain = /\b\d{3,}\b/.exec(text);
  if (plain?.[0]) {
    const value = Number(plain[0]);
    if (Number.isFinite(value)) return value;
  }

  return null;
}

/**
 * Configuración de Notion para la agenda.
 *
 * El token y la base se pueden cargar desde el panel; el valor guardado en
 * `app_meta` tiene prioridad sobre `NOTION_API_KEY` / `NOTION_DATABASE_ID`.
 */
export class NotionSettingsService {
  private schemaCache: { schema: NotionAgendaSchema; at: number } | null = null;
  private warning: string | null = null;
  private readonly envToken: string | undefined;
  private readonly envDatabase: string | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly repos: Repositories,
    private readonly logger: Logger,
    private readonly client: NotionClient = new NotionClient(),
  ) {
    this.envToken = config.notion.apiKey;
    this.envDatabase = config.notion.databaseId;
  }

  get token(): string | undefined {
    return this.config.notion.apiKey;
  }

  get databaseId(): string | undefined {
    return this.config.notion.databaseId;
  }

  get configured(): boolean {
    return Boolean(this.token && this.databaseId);
  }

  load(): void {
    const storedToken = this.repos.meta.get(API_KEY_META);
    this.config.notion.apiKey = storedToken ?? this.envToken;

    const storedDatabase = this.repos.meta.get(DATABASE_ID_META);
    this.config.notion.databaseId = storedDatabase ?? this.envDatabase;

    if (this.configured) {
      this.logger.info(
        {
          databaseId: this.config.notion.databaseId,
          source: storedToken ? 'dashboard' : 'env',
        },
        'Agenda de Notion configurada',
      );
    } else if (this.token) {
      this.logger.warn(
        'Notion tiene token pero falta la base de agenda. Compartí la base con la integración y elegila desde el panel.',
      );
    }
  }

  async initialize(): Promise<void> {
    this.load();
    if (!this.configured && this.token) {
      await this.autoDiscover();
    }
    if (this.configured) {
      try {
        await this.refreshSchema(false);
      } catch (error) {
        this.warning = errorMessage(error);
        this.logger.warn(
          { err: this.warning },
          'No se pudo leer el esquema de la agenda de Notion',
        );
      }
    }
  }

  snapshot(): NotionSettingsSnapshot {
    const storedToken = this.repos.meta.get(API_KEY_META);
    const databaseId = this.databaseId ?? null;
    const databaseTitle =
      this.repos.meta.get(DATABASE_TITLE_META) ?? null;
    const cached = this.schemaCache?.schema ?? null;

    return {
      configured: this.configured,
      ready: Boolean(this.configured && cached?.dateProperty),
      tokenSet: Boolean(this.token),
      tokenSource: storedToken
        ? 'dashboard'
        : this.config.notion.apiKey
          ? 'env'
          : 'none',
      databaseId,
      databaseTitle,
      databaseUrl: cached?.databaseUrl ?? null,
      dateProperty: cached?.dateProperty ?? null,
      titleProperty: cached?.titleProperty ?? null,
      statusProperty: cached?.statusProperty ?? null,
      warning: this.warning,
      lastError: this.repos.meta.get(LAST_ERROR_META) ?? null,
      checkedAt: this.repos.meta.get(LAST_CHECKED_META) ?? null,
    };
  }

  async save(input: {
    apiKey?: string;
    databaseId?: string;
  }): Promise<NotionSettingsSnapshot> {
    if (input.apiKey !== undefined) {
      const value = input.apiKey.trim();
      if (value) {
        this.repos.meta.set(API_KEY_META, value);
        this.config.notion.apiKey = value;
      } else {
        this.repos.meta.delete(API_KEY_META);
        this.config.notion.apiKey = this.envToken;
      }
      this.schemaCache = null;
    }

    if (input.databaseId !== undefined) {
      const value = input.databaseId.trim();
      if (value) {
        const normalized = normalizeNotionDatabaseId(value);
        if (!normalized) {
          throw new ValidationError(
            'El ID o la URL de la base de Notion no es válido. Copialo desde Compartir → Copiar enlace.',
          );
        }
        await this.validateDatabase(normalized);
        this.storeDatabase(normalized);
      } else {
        this.repos.meta.delete(DATABASE_ID_META);
        this.repos.meta.delete(DATABASE_TITLE_META);
        this.config.notion.databaseId = this.envDatabase;
        this.schemaCache = null;
      }
    }

    if (this.token && !this.databaseId) {
      await this.autoDiscover();
    } else if (this.configured) {
      await this.refreshSchema(true);
    }

    return this.snapshot();
  }

  async discover(): Promise<{
    databases: NotionDatabaseCandidate[];
    suggestedId: string | null;
    warning: string | null;
  }> {
    if (!this.token) {
      throw new ValidationError(
        'Primero guardá el token de la integración de Notion.',
      );
    }

    const databases = await this.client.searchDatabases(this.token);
    const candidates = databases.map((database) => ({
      id: database.id,
      title: databaseTitle(database),
      url: database.url,
    }));

    const matching = databases.filter((database) =>
      AGENDA_DATABASE_PATTERN.test(databaseTitle(database)),
    );
    const suggested =
      matching.length === 1
        ? matching[0]
        : databases.length === 1
          ? databases[0]
          : undefined;

    return {
      databases: candidates,
      suggestedId: suggested?.id ?? null,
      warning:
        databases.length === 0
          ? 'La integración no tiene ninguna base compartida. Compartí la base de agenda con la integración en Notion: ••• → Conexiones → agregar la integración.'
          : null,
    };
  }

  async autoDiscover(): Promise<void> {
    if (!this.token || this.databaseId) return;

    try {
      const result = await this.discover();
      if (result.suggestedId) {
        this.storeDatabase(result.suggestedId);
        await this.refreshSchema(true);
        this.logger.info(
          { databaseId: result.suggestedId },
          'Base de agenda de Notion detectada automáticamente',
        );
      } else if (result.warning) {
        this.warning = result.warning;
      }
    } catch (error) {
      this.warning = errorMessage(error);
      this.logger.warn(
        { err: this.warning },
        'No se pudo detectar la base de agenda de Notion',
      );
    }
  }

  async test(): Promise<{
    ok: boolean;
    error: string | null;
    schema: NotionAgendaSchema | null;
  }> {
    if (!this.token) {
      return {
        ok: false,
        error: 'Falta el token de la integración de Notion.',
        schema: null,
      };
    }
    if (!this.databaseId) {
      return {
        ok: false,
        error: 'Falta elegir la base de agenda de Notion.',
        schema: null,
      };
    }

    try {
      const schema = await this.refreshSchema(true);
      return { ok: true, error: null, schema };
    } catch (error) {
      const message = errorMessage(error);
      this.repos.meta.set(LAST_ERROR_META, message);
      return { ok: false, error: message, schema: null };
    }
  }

  async getSchema(): Promise<NotionAgendaSchema> {
    if (!this.token) {
      throw new ValidationError('Falta configurar el token de Notion.');
    }
    if (!this.databaseId) {
      throw new ValidationError('Falta elegir la base de agenda de Notion.');
    }

    const cached = this.schemaCache;
    if (cached && Date.now() - cached.at < 60_000) return cached.schema;
    return this.refreshSchema(true);
  }

  async createAppointment(
    input: NotionAppointmentInput,
  ): Promise<{ pageId: string; pageUrl: string; schema: NotionAgendaSchema }> {
    const schema = await this.getSchema();
    if (!schema.dateProperty) {
      throw new ValidationError(
        'La base de Notion no tiene una propiedad de fecha. Agregá una propiedad “Fecha” de tipo fecha o dale permiso de edición a la integración.',
      );
    }

    const clientName =
      input.contact.display_name ??
      input.contact.push_name ??
      input.contact.phone ??
      input.contact.wa_id;
    const dateLabel = input.appointment.label ?? 'cita';
    const price = parsePriceAmount(input.artistReply);
    const properties: Record<string, unknown> = {
      [schema.titleProperty]: titleText(
        `Tatuaje · ${clientName} · ${dateLabel}`,
      ),
      [schema.dateProperty]: {
        date: {
          start: input.appointment.start.toISOString(),
        },
      },
    };

    if (schema.clientProperty) {
      properties[schema.clientProperty] = richText(clientName);
    }
    if (schema.phoneProperty && input.contact.phone) {
      properties[schema.phoneProperty] = richText(input.contact.phone);
    }
    if (schema.codeProperty) {
      properties[schema.codeProperty] = richText(input.quote.code ?? '');
    }
    if (schema.priceProperty && schema.pricePropertyType) {
      if (schema.pricePropertyType === 'number' && price !== null) {
        properties[schema.priceProperty] = { number: price };
      } else if (schema.pricePropertyType === 'rich_text') {
        properties[schema.priceProperty] = richText(
          input.artistReply ?? '',
        );
      }
    }
    if (
      schema.statusProperty &&
      schema.statusPropertyType &&
      schema.statusValue
    ) {
      properties[schema.statusProperty] = {
        [schema.statusPropertyType]: { name: schema.statusValue },
      };
    }

    const notes = [
      `Cliente: ${clientName}`,
      input.contact.phone ? `Teléfono: ${input.contact.phone}` : null,
      input.quote.code ? `Código: ${input.quote.code}` : null,
      input.artistReply ? `Precio: ${input.artistReply}` : null,
      input.quote.request_body ? `Consulta: ${input.quote.request_body}` : null,
    ].filter((line): line is string => Boolean(line));

    const page = await this.client.createPage(this.token as string, {
      databaseId: schema.databaseId,
      properties,
      children: [
        {
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [
              {
                type: 'text',
                text: { content: truncate(notes.join('\n'), 1900, '') },
              },
            ],
          },
        },
      ],
    });

    this.repos.meta.delete(LAST_ERROR_META);
    this.logger.info(
      {
        databaseId: schema.databaseId,
        pageId: page.id,
        quoteId: input.quote.id,
        code: input.quote.code,
        appointment: input.appointment.start.toISOString(),
      },
      'Cita creada en la agenda de Notion',
    );

    return { pageId: page.id, pageUrl: page.url, schema };
  }

  private async validateDatabase(databaseId: string): Promise<void> {
    if (!this.token) {
      throw new ValidationError(
        'Primero guardá el token de la integración de Notion.',
      );
    }

    try {
      await this.client.retrieveDatabase(this.token, databaseId);
    } catch (error) {
      throw new ValidationError(
        [
          'No pude acceder a esa base de Notion.',
          'Verificá que el ID sea correcto y que la base esté compartida con la integración: en Notion, ••• → Conexiones → agregar la integración.',
          `Detalle: ${errorMessage(error)}`,
        ].join(' '),
      );
    }
  }

  private storeDatabase(databaseId: string): void {
    const normalized = normalizeNotionDatabaseId(databaseId);
    if (!normalized) return;

    this.repos.meta.set(DATABASE_ID_META, normalized);
    this.config.notion.databaseId = normalized;
    this.schemaCache = null;

    // El título se completa al refrescar el esquema; si falla, se conserva el
    // ID igual para que el error se vea en el panel.
    this.repos.meta.delete(DATABASE_TITLE_META);
  }

  private async refreshSchema(
    ensureDate: boolean,
  ): Promise<NotionAgendaSchema> {
    if (!this.token || !this.databaseId) {
      throw new ValidationError('La agenda de Notion no está configurada.');
    }

    let database = await this.client.retrieveDatabase(
      this.token,
      this.databaseId,
    );
    let warning: string | null = null;

    if (ensureDate && !Object.values(database.properties).some(
      (property) => property.type === 'date',
    )) {
      try {
        database = await this.client.updateDatabase(
          this.token,
          this.databaseId,
          { Fecha: { date: {} } },
        );
      } catch (error) {
        warning =
          'La base no tiene una propiedad de fecha y no pude crearla. Agregá una propiedad “Fecha” de tipo fecha o dale permiso de edición a la integración.';
        this.logger.warn(
          { err: errorMessage(error), databaseId: this.databaseId },
          'No se pudo agregar la propiedad Fecha a la base de Notion',
        );
      }
    }

    const schema = schemaFromDatabase(database);
    this.schemaCache = { schema, at: Date.now() };
    this.warning = warning;
    this.repos.meta.set(DATABASE_TITLE_META, schema.databaseTitle);
    this.repos.meta.set(LAST_CHECKED_META, new Date().toISOString());
    this.repos.meta.delete(LAST_ERROR_META);

    return schema;
  }
}
