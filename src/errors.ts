export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;
  readonly expose: boolean;

  constructor(
    message: string,
    options: {
      statusCode?: number;
      code?: string;
      details?: unknown;
      expose?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'AppError';
    this.statusCode = options.statusCode ?? 500;
    this.code = options.code ?? 'INTERNAL_ERROR';
    this.details = options.details;
    this.expose = options.expose ?? this.statusCode < 500;
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class WahaError extends AppError {
  constructor(message: string, statusCode = 502, details?: unknown) {
    super(message, {
      statusCode,
      code: 'WAHA_ERROR',
      details,
      expose: false,
    });
    this.name = 'WahaError';
  }
}

export class OllamaError extends AppError {
  constructor(message: string, statusCode = 502, details?: unknown) {
    super(message, {
      statusCode,
      code: 'OLLAMA_ERROR',
      details,
      expose: false,
    });
    this.name = 'OllamaError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Recurso no encontrado') {
    super(message, { statusCode: 404, code: 'NOT_FOUND', expose: true });
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Datos inválidos', details?: unknown) {
    super(message, {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      details,
      expose: true,
    });
    this.name = 'ValidationError';
  }
}
