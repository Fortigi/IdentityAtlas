// Organisation truth — apply an activity recipe to the rows of a list. Pure: no I/O.
//
//   applyActivity(rows, recipe) → { facts, skipped }
//
// `recipe` is a normalised activity recipe (templateContracts.js). Row i of
// `rows` is data row i + 1.
//
// facts:   { row, sourceLocator, actor, subject, occurredOn, periodEnd, measure, unit, attributes }
//   actor / subject  the trimmed raw cell values (resolved later, once per distinct value)
//   occurredOn       'YYYY-MM-DD': the date, or the first day of the year + month
//   periodEnd        the last day of that month for year + month data, null for a date
//   measure          a number ("7,5" and "1.234,5" read the Dutch way), null when the cell is blank
//   attributes       the extra columns, blanks left out
// skipped: { row, reason } — a row without an actor or subject, with a date (or
//   year/month) that cannot be read, or with a measure that is not a number.
//   Fully blank rows are not counted.
import { monthOf } from '../model/evidence.js';

const cell = (row, column) => String(row?.[column] ?? '').trim();
const pad = (n) => String(n).padStart(2, '0');

function isoDay(y, m, d) {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** 'YYYY-MM-DD' from an ISO date (time allowed, as parse.js writes xlsx dates), D-M-YYYY or YYYY/M/D; else null. */
export function dayOf(value) {
  const v = String(value ?? '').trim();
  let m = v.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m && (v.length === 10 || /^[T ][\d:.]+Z?$/.test(v.slice(10)))) return isoDay(Number(m[1]), Number(m[2]), Number(m[3]));
  m = v.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) return isoDay(Number(m[3]), Number(m[2]), Number(m[1]));
  m = v.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  return m ? isoDay(Number(m[1]), Number(m[2]), Number(m[3])) : null;
}

/** { occurredOn, periodEnd } for a year (1900–2099) and a month (name nl/en or 1–12); null when either does not read. */
export function monthPeriod(year, month) {
  const y = /^(19|20)\d\d$/.test(String(year ?? '').trim()) ? Number(String(year).trim()) : null;
  const m = monthOf(month);
  if (y === null || m === null) return null;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { occurredOn: `${y}-${pad(m)}-01`, periodEnd: `${y}-${pad(m)}-${pad(last)}` };
}

/**
 * A measure cell as a number. A comma is the decimal mark when it is the last
 * separator ("7,5", "1.234,5"); a point when it is ("7.5", "1,234.5"). Blank → null,
 * anything else that is not a number → NaN.
 */
export function measureOf(value) {
  const v = String(value ?? '').trim().replace(/\s/g, '');
  if (v === '') return null;
  if (!/^[-+]?\d[\d.,]*$/.test(v)) return NaN;
  const lastComma = v.lastIndexOf(',');
  const lastPoint = v.lastIndexOf('.');
  const decimal = lastComma > lastPoint ? ',' : '.';
  const thousands = decimal === ',' ? '.' : ',';
  const n = Number(v.split(thousands).join('').replace(decimal, '.'));
  return Number.isFinite(n) ? n : NaN;
}

function whenOf(row, when) {
  if (when.dateColumn) {
    const day = dayOf(cell(row, when.dateColumn));
    return day ? { occurredOn: day, periodEnd: null } : null;
  }
  return monthPeriod(cell(row, when.yearColumn), cell(row, when.monthColumn));
}

function extraAttributes(row, attrs) {
  const out = {};
  for (const a of attrs ?? []) {
    const v = cell(row, a.column);
    if (v !== '') out[a.name] = v;
  }
  return out;
}

const isBlank = (row) => Object.values(row ?? {}).every(v => String(v ?? '').trim() === '');

// The reason a row cannot become a fact, or the fact.
function factOf(row, rowNo, a) {
  const actor = cell(row, a.actor.column);
  const subject = cell(row, a.subject.column);
  if (!actor) return { skip: `row ${rowNo} has no ${a.actor.column}` };
  if (!subject) return { skip: `row ${rowNo} has no ${a.subject.column}` };
  const when = whenOf(row, a.when);
  if (!when) return { skip: `row ${rowNo} has no readable date` };
  const measure = a.measure ? measureOf(cell(row, a.measure.column)) : null;
  if (Number.isNaN(measure)) return { skip: `row ${rowNo}: "${cell(row, a.measure.column)}" is not a number` };
  return {
    fact: {
      row: rowNo, sourceLocator: `row:${rowNo}`, actor, subject, ...when,
      measure, unit: a.measure?.unit ?? null, attributes: extraAttributes(row, a.attributes),
    },
  };
}

export function applyActivity(rows, recipe) {
  const facts = [];
  const skipped = [];
  rows.forEach((row, i) => {
    if (isBlank(row)) return;
    const out = factOf(row, i + 1, recipe.activity);
    if (out.fact) facts.push(out.fact);
    else skipped.push({ row: i + 1, reason: out.skip });
  });
  return { facts, skipped };
}

/** The distinct raw values per role, in first-seen order, with the number of facts naming each. */
export function distinctKeys(facts) {
  const out = { actor: new Map(), subject: new Map() };
  for (const f of facts) {
    for (const role of ['actor', 'subject']) out[role].set(f[role], (out[role].get(f[role]) ?? 0) + 1);
  }
  return out;
}
