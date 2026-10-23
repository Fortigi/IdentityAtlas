import { describe, it, expect } from 'vitest';
import { parseActivityDate, detectDateOrder, isDateValue, parseAmount, MAX_CELL } from './values.js';

describe('parseActivityDate', () => {
  it('reads ISO dates and drops the time, including an xlsx cell turned into an ISO timestamp', () => {
    expect(parseActivityDate('2026-03-05')).toBe('2026-03-05');
    expect(parseActivityDate('2026-03-05T23:30:00.000Z')).toBe('2026-03-05');
    expect(parseActivityDate('2026/3/5')).toBe('2026-03-05');
    // ISO is year-month-day whatever the order says.
    expect(parseActivityDate('2026-03-05', 'mdy')).toBe('2026-03-05');
  });

  it('reads day-first by default and month-first when told', () => {
    expect(parseActivityDate('05-03-2026')).toBe('2026-03-05');
    expect(parseActivityDate('05-03-2026', 'mdy')).toBe('2026-05-03');
    expect(parseActivityDate('05.03.26')).toBe('2026-03-05');
    expect(parseActivityDate('03/05/2026 9:00 AM', 'mdy')).toBe('2026-03-05');
  });

  it('refuses dates that do not exist, and keeps a real leap day', () => {
    expect(parseActivityDate('31-02-2026')).toBeNull();
    expect(parseActivityDate('29-02-2027')).toBeNull();
    expect(parseActivityDate('29-02-2028')).toBe('2028-02-29');
    expect(parseActivityDate('13/05/2026', 'mdy')).toBeNull();
    expect(parseActivityDate('00-05-2026')).toBeNull();
  });

  it('refuses shapes that only look like dates', () => {
    expect(parseActivityDate('005-03-2026')).toBeNull();
    expect(parseActivityDate('05-03-226')).toBeNull();
    expect(parseActivityDate('hello')).toBeNull();
    expect(parseActivityDate('')).toBeNull();
    expect(parseActivityDate(null)).toBeNull();
    expect(parseActivityDate(`2026-03-05 ${'x'.repeat(MAX_CELL)}`)).toBeNull();
  });

  it('reads an Excel serial day number between 1970 and 2100, a fraction being the time', () => {
    expect(parseActivityDate('46086')).toBe('2026-03-05');
    expect(parseActivityDate('46086.75')).toBe('2026-03-05');
    expect(parseActivityDate('46086,75')).toBe('2026-03-05');
    expect(parseActivityDate('25569')).toBe('1970-01-01');
    expect(parseActivityDate('25568')).toBeNull();
    expect(parseActivityDate('73051')).toBe('2100-01-01');
    expect(parseActivityDate('73052')).toBeNull();
    expect(parseActivityDate('4608')).toBeNull();
  });
});

describe('detectDateOrder', () => {
  it('is month-first only when a second part is above 12 and no first part is', () => {
    expect(detectDateOrder(['03/05/2026', '04/18/2026'])).toBe('mdy');
    expect(detectDateOrder(['13/05/2026', '04/18/2026'])).toBe('dmy');
    expect(detectDateOrder(['03/05/2026', '04/12/2026'])).toBe('dmy');
    expect(detectDateOrder(['13/05/2026'])).toBe('dmy');
  });

  it('ignores ISO dates, non-dates and over-long cells', () => {
    expect(detectDateOrder(['2026-03-25', 'x', '', null, `04/18/2026 ${'x'.repeat(MAX_CELL)}`])).toBe('dmy');
    expect(detectDateOrder(['2026-03-25', '04/18/2026'])).toBe('mdy');
  });

  it('isDateValue accepts a date either way round', () => {
    expect(isDateValue('04/18/2026')).toBe(true);
    expect(isDateValue('18/04/2026')).toBe(true);
    expect(isDateValue('18/18/2026')).toBe(false);
  });
});

describe('parseAmount', () => {
  it('reads decimal hours with a point or a comma', () => {
    expect(parseAmount('1.5')).toBe(1.5);
    expect(parseAmount('1,25')).toBe(1.25);
    expect(parseAmount('8')).toBe(8);
  });

  it('reads clock durations h:mm and h:mm:ss', () => {
    expect(parseAmount('01:30:00')).toBe(1.5);
    expect(parseAmount('0:45')).toBe(0.75);
    expect(parseAmount('1:30:30')).toBe(1.5083);
    expect(parseAmount('1:75')).toBeNull();
    expect(parseAmount('1:30:61')).toBeNull();
  });

  it('reads worded durations in English and Dutch', () => {
    expect(parseAmount('1h 30m')).toBe(1.5);
    expect(parseAmount('90 min')).toBe(1.5);
    expect(parseAmount('2 uur')).toBe(2);
    expect(parseAmount('1,5uur')).toBe(1.5);
    expect(parseAmount('1h 30m 30s')).toBe(1.5083);
  });

  it('refuses a worded duration with a part it cannot read', () => {
    expect(parseAmount('1h30')).toBeNull();
    expect(parseAmount('1h 30x')).toBeNull();
    expect(parseAmount('soon')).toBeNull();
  });

  it('never takes a negative amount or an over-long cell', () => {
    expect(parseAmount('-1')).toBeNull();
    expect(parseAmount('-0:30')).toBeNull();
    expect(parseAmount('1'.repeat(MAX_CELL + 1))).toBeNull();
  });

  it('an empty cell is no hours but one event', () => {
    expect(parseAmount('', 'hours')).toBeNull();
    expect(parseAmount(undefined, 'events')).toBe(1);
    expect(parseAmount('3', 'events')).toBe(3);
    expect(parseAmount('1h', 'events')).toBeNull();
  });
});
