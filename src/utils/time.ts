export function nowIso(): string {
  return new Date().toISOString();
}

export function addMilliseconds(ms: number, from: Date = new Date()): string {
  return new Date(from.getTime() + ms).toISOString();
}

export function toIsoFromUnix(value: unknown, fallback: Date = new Date()): string {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback.toISOString();
  }
  const milliseconds = numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
  return new Date(milliseconds).toISOString();
}

export function startOfUtcDay(date: Date = new Date()): string {
  const copy = new Date(date);
  copy.setUTCHours(0, 0, 0, 0);
  return copy.toISOString();
}

export function formatDateTime(
  date: Date,
  timeZone: string,
  locale = 'es-AR',
): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone,
  }).format(date);
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('es-AR', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function secondsToHuman(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}
