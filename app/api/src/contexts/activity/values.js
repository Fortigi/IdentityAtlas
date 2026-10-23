// Context activity — reading the values of one activity row: its date and its amount.
//
//   detectDateOrder(values)         → 'dmy' | 'mdy'   which way round a column's day-month dates are
//   parseActivityDate(value, order) → 'YYYY-MM-DD' | null
//   parseAmount(value, unit)        → number | null
//
// Pure. Dates come as an export writes them:
//   ISO 8601 (2026-03-05, 2026-03-05T09:00:00Z — what parse.js makes of an xlsx date cell),
//   2026/03/05, day-first 05-03-2026 / 05.03.2026 / 05/03/2026, month-first 03/05/2026,
//   and an Excel serial day number (46086 = 2026-03-05) when a date cell lost its format.
// A time after the date is ignored; a two-digit year is read as 20xx; a date
// that does not exist (31-02-2026) is null.
//
// Amounts, for unit 'hours': a decimal (1.5 or 1,5 — Clockify "Duration (decimal)"),
// a clock duration h:mm or h:mm:ss (Clockify "Duration (h)": 01:30:00), or words
// (1h 30m, 90 min, 2 uur). For any other unit a plain number; an empty cell is one
// event. Negative amounts are null: activity is never undone by a row.
//
// A cell longer than MAX_CELL is neither a date nor an amount, and every pattern
// here is anchored without nested repetition — linear on any input.

export const MAX_CELL = 40;
const pad = (n) => String(n).padStart(2, '0');

function validDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

const DATE_PART = /^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})$/;
// eslint-disable-next-line security/detect-unsafe-regex -- anchored, bounded repeats only ({n,m}), applied to a cell of at most MAX_CELL characters
const SERIAL = /^\d{5}(?:[.,]\d{1,12})?$/;
// Excel day numbers between 1970 and 2100; the epoch is 1899-12-30 (Excel's leap-year bug included).
const SERIAL_MIN = 25569;
const SERIAL_MAX = 73051;
const DAY_MS = 86_400_000;
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

function fromSerial(text) {
  const serial = Math.floor(Number(text.replace(',', '.')));
  if (serial < SERIAL_MIN || serial > SERIAL_MAX) return null;
  const d = new Date(EXCEL_EPOCH + serial * DAY_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// The date word of a cell: before a 'T' (ISO) or the first space or comma.
const dateWord = (text) => text.split(/[T ,]/)[0];

// { y, a, b, iso } of a date word (a, b: month and day for ISO, else the two
// day-month parts in file order), or null.
function dateParts(text) {
  const m = DATE_PART.exec(dateWord(text));
  if (!m) return null;
  if (m[1].length === 4) return { y: Number(m[1]), a: Number(m[2]), b: Number(m[3]), iso: true };
  if (m[1].length > 2 || (m[3].length !== 2 && m[3].length !== 4)) return null;
  return { y: m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]), a: Number(m[1]), b: Number(m[2]), iso: false };
}

/** 'YYYY-MM-DD' for a date cell, or null when it is not one. `order` decides 05/03/2026. */
export function parseActivityDate(value, order = 'dmy') {
  const text = String(value ?? '').trim();
  if (text === '' || text.length > MAX_CELL) return null;
  const p = dateParts(text);
  if (p?.iso) return validDate(p.y, p.a, p.b);
  if (p) return order === 'mdy' ? validDate(p.y, p.a, p.b) : validDate(p.y, p.b, p.a);
  return SERIAL.test(text) ? fromSerial(text) : null;
}

/**
 * Which way round a column's day-month dates are: 'mdy' only when some value can
 * only be month-first (its second part is above 12) and none can only be
 * day-first; otherwise day-first, the European reading.
 */
export function detectDateOrder(values) {
  let dayFirst = false;
  let monthFirst = false;
  for (const v of values) {
    const text = String(v ?? '').trim();
    const p = text.length <= MAX_CELL ? dateParts(text) : null;
    if (!p || p.iso) continue;
    if (p.a > 12) dayFirst = true;
    if (p.b > 12) monthFirst = true;
  }
  return monthFirst && !dayFirst ? 'mdy' : 'dmy';
}

/** True when the value reads as a date one way round or the other. */
export function isDateValue(value) {
  return parseActivityDate(value, 'dmy') !== null || parseActivityDate(value, 'mdy') !== null;
}

// ─── Amounts ─────────────────────────────────────────────────────────────
// eslint-disable-next-line security/detect-unsafe-regex -- anchored, bounded repeats only ({n,m}), applied to a cell of at most MAX_CELL characters
const CLOCK = /^(\d{1,4}):(\d{1,2})(?::(\d{1,2}))?$/;
// eslint-disable-next-line security/detect-unsafe-regex -- anchored, bounded repeats only ({n,m}), applied to a cell of at most MAX_CELL characters
const DECIMAL = /^\d{1,9}(?:[.,]\d{1,9})?$/;
// One "<number><unit>" piece of a worded duration, spaces removed: 1h, 30m, 1,5uur.
// eslint-disable-next-line security/detect-unsafe-regex -- anchored, bounded repeats only ({n,m}), applied to a cell of at most MAX_CELL characters
const PIECE = /^(\d{1,6}(?:[.,]\d{1,6})?)([a-z]{1,9})/;
const UNIT_HOURS = {
  h: 1, hr: 1, hrs: 1, hour: 1, hours: 1, u: 1, uur: 1, uren: 1,
  m: 1 / 60, min: 1 / 60, mins: 1 / 60, minute: 1 / 60, minutes: 1 / 60, minuut: 1 / 60, minuten: 1 / 60,
  s: 1 / 3600, sec: 1 / 3600, secs: 1 / 3600, second: 1 / 3600, seconds: 1 / 3600, seconde: 1 / 3600, seconden: 1 / 3600,
};
const toNumber = (s) => Number(String(s).replace(',', '.'));
const round4 = (n) => Math.round(n * 10_000) / 10_000;

// "1h 30m" → 1.5; null when any part of the text is not a "<number><unit>" piece.
function wordedHours(text) {
  let rest = text.toLowerCase().replace(/\s+/g, '');
  let hours = 0;
  while (rest !== '') {
    const m = PIECE.exec(rest);
    const factor = m ? UNIT_HOURS[m[2]] : undefined;
    if (factor === undefined) return null;
    hours += toNumber(m[1]) * factor;
    rest = rest.slice(m[0].length);
  }
  return hours;
}

function hoursOf(text) {
  const clock = CLOCK.exec(text);
  if (clock) {
    if (Number(clock[2]) > 59 || Number(clock[3] ?? 0) > 59) return null;
    return Number(clock[1]) + Number(clock[2]) / 60 + Number(clock[3] ?? 0) / 3600;
  }
  if (DECIMAL.test(text)) return toNumber(text);
  return wordedHours(text);
}

/**
 * The amount of one row in `unit`, rounded to four decimals; null when the
 * cell is not an amount. Without an amount column every row is one event —
 * the caller passes no value then, and gets 1.
 */
export function parseAmount(value, unit = 'hours') {
  const text = String(value ?? '').trim();
  if (text === '') return unit === 'hours' ? null : 1;
  if (text.length > MAX_CELL) return null;
  const amount = unit === 'hours' ? hoursOf(text) : (DECIMAL.test(text) ? toNumber(text) : null);
  return amount === null ? null : round4(amount);
}
