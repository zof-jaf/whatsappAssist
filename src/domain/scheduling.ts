const MONTHS: Record<string, number> = {
  enero: 1,
  ene: 1,
  febrero: 2,
  feb: 2,
  marzo: 3,
  mar: 3,
  abril: 4,
  abr: 4,
  mayo: 5,
  may: 5,
  junio: 6,
  jun: 6,
  julio: 7,
  jul: 7,
  agosto: 8,
  ago: 8,
  septiembre: 9,
  setiembre: 9,
  sep: 9,
  sept: 9,
  octubre: 10,
  oct: 10,
  noviembre: 11,
  nov: 11,
  diciembre: 12,
  dic: 12,
};

const MONTH_NAMES = [
  '',
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

const MONTH_PATTERN = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join('|');

const WEEKDAYS: Record<string, number> = {
  domingo: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
};

const WEEKDAY_PATTERN = Object.keys(WEEKDAYS).join('|');

export interface AppointmentDateParts {
  year: number;
  month: number;
  day: number;
  label: string;
}

export interface AppointmentTimeParts {
  hour: number;
  minute: number;
  label: string;
}

export interface AppointmentIntent {
  date: AppointmentDateParts | null;
  time: AppointmentTimeParts | null;
  /**
   * Fecha y hora completas en UTC. Es `null` cuando el cliente dio solo el
   * día o solo la hora y todavía falta el otro dato.
   */
  start: Date | null;
  label: string | null;
}

export interface ParseAppointmentOptions {
  timeZone: string;
  now?: Date;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\./g, '');
}

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const values = new Map(
    parts.map((part) => [part.type, Number(part.value)] as const),
  );

  return {
    year: values.get('year') ?? 0,
    month: values.get('month') ?? 1,
    day: values.get('day') ?? 1,
    hour: values.get('hour') ?? 0,
    minute: values.get('minute') ?? 0,
  };
}

/** Convierte una fecha/hora local de una zona IANA al instante UTC. */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const actual = zonedParts(new Date(guess), timeZone);
  const offset =
    Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
    ) - guess;

  return new Date(guess - offset);
}

export function formatZonedDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('es-CO', {
    timeZone,
    dateStyle: 'long',
  }).format(date);
}

export function formatZonedDateTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('es-CO', {
    timeZone,
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(date);
}

function isValidDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function fullYear(value: string | undefined): number | null {
  if (!value) return null;
  const year = Number(value);
  if (!Number.isInteger(year)) return null;
  if (year >= 0 && year < 100) return 2000 + year;
  if (year < 2000 || year > 2100) return null;
  return year;
}

function timeLabel(hour: number, minute: number): string {
  const suffix = hour >= 12 ? 'p. m.' : 'a. m.';
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

function parseDate(
  text: string,
): { month: number; day: number; year: number | null } | null {
  const named = new RegExp(
    `\\b(?:el\\s+)?(\\d{1,2})\\s+(?:de\\s+)?(${MONTH_PATTERN})\\b(?:\\s+de\\s+(\\d{4}))?`,
    'i',
  ).exec(text);

  if (named?.[1] && named[2]) {
    const month = MONTHS[named[2]];
    if (!month) return null;
    return {
      day: Number(named[1]),
      month,
      year: fullYear(named[3]),
    };
  }

  const numeric = /\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/.exec(text);
  if (!numeric?.[1] || !numeric[2]) return null;

  return {
    day: Number(numeric[1]),
    month: Number(numeric[2]),
    year: fullYear(numeric[3]),
  };
}

function addDays(
  day: { year: number; month: number; day: number },
  amount: number,
): { year: number; month: number; day: number } {
  const date = new Date(Date.UTC(day.year, day.month - 1, day.day + amount));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

/**
 * Interpreta fechas relativas y días de la semana: “hoy”, “mañana”,
 * “pasado mañana”, “el sábado”, “el próximo viernes”.
 */
function parseRelativeDate(
  text: string,
  today: ZonedParts,
): { month: number; day: number; year: number } | null {
  const relative = /\b(hoy|pasado\s+manana|manana)\b/.exec(text);
  if (relative?.[1]) {
    const expression = relative[1];
    if (expression === 'manana' && /\b(?:de|d)\s+la\s+manana\b/.test(text)) {
      return null;
    }
    const offset =
      expression === 'hoy' ? 0 : expression === 'manana' ? 1 : 2;
    return addDays(today, offset);
  }

  const weekday = new RegExp(
    `\\b(?:el\\s+|este\\s+|proximo\\s+)?(${WEEKDAY_PATTERN})\\b`,
    'i',
  ).exec(text);
  if (!weekday?.[1]) return null;

  const target = WEEKDAYS[weekday[1]];
  if (target === undefined) return null;

  const todayUtc = Date.UTC(today.year, today.month - 1, today.day);
  const current = new Date(todayUtc).getUTCDay();
  let delta = (target - current + 7) % 7;
  if (delta === 0) delta = 7;

  return addDays(today, delta);
}

function appointmentDate(
  year: number,
  month: number,
  day: number,
): AppointmentDateParts | null {
  if (!isValidDate(year, month, day)) return null;
  return {
    year,
    month,
    day,
    label: `${day} de ${MONTH_NAMES[month]} de ${year}`,
  };
}

function parseTime(
  text: string,
): { hour: number; minute: number } | null {
  const meridiem = /\b(?:a\s+las?\s+)?(\d{1,2})(?::(\d{1,2}))?\s*(am|pm)\b/i.exec(
    text,
  );
  if (meridiem?.[1]) {
    let hour = Number(meridiem[1]);
    const minute = Number(meridiem[2] ?? 0);
    const suffix = meridiem[3]?.toLowerCase();
    if (hour < 1 || hour > 12 || minute > 59) return null;
    if (suffix === 'pm' && hour !== 12) hour += 12;
    if (suffix === 'am' && hour === 12) hour = 0;
    return { hour, minute };
  }

  const clock = /\b(?:a\s+las?\s+)?(\d{1,2}):(\d{1,2})\b/.exec(text);
  if (clock?.[1] && clock[2]) {
    const hour = Number(clock[1]);
    const minute = Number(clock[2]);
    if (hour > 23 || minute > 59) return null;
    return { hour, minute };
  }

  const daytime = /\b(?:a\s+las?\s+)?(\d{1,2})\s*(?:de|d|por)\s+la\s+(manana|tarde|noche)\b/.exec(
    text,
  );
  if (daytime?.[1] && daytime[2]) {
    const rawHour = Number(daytime[1]);
    if (rawHour < 1 || rawHour > 12) return null;
    const period = daytime[2];
    let hour = rawHour;
    if (period === 'tarde' && rawHour !== 12) hour += 12;
    if (period === 'noche' && rawHour !== 12) hour += 12;
    return { hour, minute: 0 };
  }

  // “El martes a las 4” sin am/pm ni “de la tarde”. En una cita de tatuaje,
  // las horas de 1 a 7 se entienden de la tarde; de 8 a 12, de la mañana.
  const bare = /\ba\s+las?\s+(\d{1,2})(?::(\d{1,2}))?\b/.exec(text);
  if (bare?.[1]) {
    const rawHour = Number(bare[1]);
    const minute = Number(bare[2] ?? 0);
    if (rawHour < 1 || rawHour > 23 || minute > 59) return null;
    const hour = rawHour >= 1 && rawHour <= 7 ? rawHour + 12 : rawHour;
    return { hour, minute };
  }

  return null;
}

/**
 * Combina una fecha y una hora ya interpretadas en una cita completa.
 * Útil cuando el cliente da el día en un mensaje y la hora en otro.
 */
export function buildAppointment(
  date: AppointmentDateParts,
  time: AppointmentTimeParts,
  timeZone: string,
): AppointmentIntent {
  const start = zonedTimeToUtc(
    date.year,
    date.month,
    date.day,
    time.hour,
    time.minute,
    timeZone,
  );

  return {
    date,
    time,
    start,
    label: formatZonedDateTime(start, timeZone),
  };
}

/**
 * Interpreta expresiones habituales de agenda en español:
 * "2 de diciembre 4pm", "el 2/12 a las 16:00", "2 de dic a las 4 de la tarde",
 * "el sábado a las 3 de la tarde", "mañana 10am".
 *
 * Si solo hay día, `start` queda en `null` para que el bot pregunte la hora.
 * Si solo hay hora, también queda en `null` para que pregunte el día.
 */
export function parseSpanishAppointment(
  value: string,
  options: ParseAppointmentOptions,
): AppointmentIntent | null {
  const text = normalizeText(value);
  if (!text.trim()) return null;

  const now = options.now ?? new Date();
  const today = zonedParts(now, options.timeZone);

  const parsedDate = parseDate(text);
  const parsedTime = parseTime(text);
  const relative = parsedDate ? null : parseRelativeDate(text, today);
  if (!parsedDate && !relative && !parsedTime) return null;

  let date: AppointmentDateParts | null = null;
  if (parsedDate) {
    let year = parsedDate.year ?? today.year;
    if (
      parsedDate.year === null &&
      (parsedDate.month < today.month ||
        (parsedDate.month === today.month && parsedDate.day < today.day))
    ) {
      year += 1;
    }

    date = appointmentDate(year, parsedDate.month, parsedDate.day);
    if (!date) return null;
  } else if (relative) {
    date = appointmentDate(relative.year, relative.month, relative.day);
    if (!date) return null;
  }

  let time: AppointmentTimeParts | null = null;
  if (parsedTime) {
    time = {
      hour: parsedTime.hour,
      minute: parsedTime.minute,
      label: timeLabel(parsedTime.hour, parsedTime.minute),
    };
  }

  if (date && time) {
    return buildAppointment(date, time, options.timeZone);
  }

  return { date, time, start: null, label: null };
}
