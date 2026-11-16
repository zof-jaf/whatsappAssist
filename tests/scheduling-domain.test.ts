import { describe, expect, it } from 'vitest';
import {
  parseSpanishAppointment,
  zonedTimeToUtc,
} from '../src/domain/scheduling.js';

const options = {
  timeZone: 'America/Bogota',
  now: new Date('2026-11-15T15:00:00.000Z'),
};

describe('interpretación de citas en español', () => {
  it('interpreta día, mes y hora con am/pm', () => {
    const result = parseSpanishAppointment('2 de diciembre 4pm', options);

    expect(result?.date).toMatchObject({ year: 2026, month: 12, day: 2 });
    expect(result?.time).toMatchObject({ hour: 16, minute: 0 });
    expect(result?.start?.toISOString()).toBe('2026-12-02T21:00:00.000Z');
    expect(result?.label).toContain('2 de diciembre');
  });

  it('acepta formato numérico, mayúsculas y acentos', () => {
    const result = parseSpanishAppointment(
      'El 2/12 a las 16:30, por favor',
      options,
    );

    expect(result?.date).toMatchObject({ year: 2026, month: 12, day: 2 });
    expect(result?.time).toMatchObject({ hour: 16, minute: 30 });
    expect(result?.start?.toISOString()).toBe('2026-12-02T21:30:00.000Z');
  });

  it('interpreta “de la tarde”', () => {
    const result = parseSpanishAppointment(
      '2 de dic a las 4 de la tarde',
      options,
    );

    expect(result?.time).toMatchObject({ hour: 16, minute: 0 });
    expect(result?.start?.toISOString()).toBe('2026-12-02T21:00:00.000Z');
  });

  it('interpreta días de la semana', () => {
    // 15 de noviembre de 2026 es domingo.
    const result = parseSpanishAppointment(
      'el sábado a las 3 de la tarde',
      options,
    );

    expect(result?.date).toMatchObject({ year: 2026, month: 11, day: 21 });
    expect(result?.time).toMatchObject({ hour: 15, minute: 0 });
    expect(result?.start?.toISOString()).toBe('2026-11-21T20:00:00.000Z');
  });

  it('interpreta mañana y hoy', () => {
    const tomorrow = parseSpanishAppointment('mañana 10am', options);
    expect(tomorrow?.date).toMatchObject({ year: 2026, month: 11, day: 16 });
    expect(tomorrow?.start?.toISOString()).toBe('2026-11-16T15:00:00.000Z');

    const today = parseSpanishAppointment('hoy a las 4pm', options);
    expect(today?.date).toMatchObject({ year: 2026, month: 11, day: 15 });
  });

  it('no confunde “de la mañana” con el día siguiente', () => {
    const result = parseSpanishAppointment(
      '2 de diciembre a las 10 de la mañana',
      options,
    );

    expect(result?.date).toMatchObject({ year: 2026, month: 12, day: 2 });
    expect(result?.time).toMatchObject({ hour: 10, minute: 0 });
  });

  it('pasa al año siguiente si la fecha ya pasó', () => {
    const result = parseSpanishAppointment('2 de enero 10am', options);

    expect(result?.date).toMatchObject({ year: 2027, month: 1, day: 2 });
  });

  it('devuelve solo la fecha cuando falta la hora', () => {
    const result = parseSpanishAppointment('2 de diciembre', options);

    expect(result?.date?.label).toBe('2 de diciembre de 2026');
    expect(result?.time).toBeNull();
    expect(result?.start).toBeNull();
  });

  it('devuelve solo la hora cuando falta el día', () => {
    const result = parseSpanishAppointment('a las 4pm', options);

    expect(result?.date).toBeNull();
    expect(result?.time).toMatchObject({ hour: 16, minute: 0 });
    expect(result?.start).toBeNull();
  });

  it('ignora mensajes sin fecha ni hora', () => {
    expect(
      parseSpanishAppointment('Quiero un tatuaje de 10x10', options),
    ).toBeNull();
    expect(parseSpanishAppointment('Hola, ¿cómo estás?', options)).toBeNull();
  });

  it('rechaza fechas inexistentes', () => {
    expect(parseSpanishAppointment('30 de febrero 4pm', options)).toBeNull();
  });

  it('convierte hora local de Bogotá a UTC', () => {
    const date = zonedTimeToUtc(2026, 12, 2, 16, 0, 'America/Bogota');
    expect(date.toISOString()).toBe('2026-12-02T21:00:00.000Z');
  });
});
