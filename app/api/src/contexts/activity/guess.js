// Context activity — the deterministic best guess of how an activity export maps.
//
//   guessActivityMapping({ fileName, profile, rows, childNames }) → mapping
//
// Pure, and always complete (every field present, every column it names one of
// the file's) — the optional model only refines it and the analyst confirms it,
// exactly as for a list upload. Header words are read with the list upload's
// helpers (upload/guess.js: words, squash, says), so Dutch compounds and
// CamelCase headers read the same way.
//
// The mapping shape (shared with mapping.js, rows.js and the wizard):
//   { sourceLabel,                     e.g. "Clockify" — a re-upload of the same source replaces
//     contextColumn,                   the column naming the sub-unit a row lands on, or null
//     subjectNameColumn, subjectEmailColumn,   who did it (at least one)
//     dateColumn, dateOrder: 'dmy'|'mdy',
//     amountColumn, unit: 'hours'|'events',    no amount column: each row is one event
//     kindColumn,                      what kind of activity (a task, an operation), or null
//     attributeColumns: [column, …] }  kept on each row
//
// Two exports are recognised by their headers: a Clockify time export (Project,
// Client, Description, Task, User, Email, Tags, Billable, Start Date, Start Time,
// End Date, End Time, Duration (h), Duration (decimal)) and a Microsoft 365
// audit log (CreationDate, UserIds, Operations, AuditData). For the context
// column the file's values are compared with the sub-units' names: the column
// whose values name the most sub-units wins (on a customer tree that is
// Clockify's Client, or its Project).

import { says, squash, listNameFrom } from '../upload/guess.js';
import { isEmailLike } from '../upload/profile.js';
import { normalizeName } from '../../lib/nameMatch.js';
import { detectDateOrder, isDateValue } from './values.js';

export const UNITS = ['hours', 'events'];
export const DATE_ORDERS = ['dmy', 'mdy'];

const SOURCES = [
  { label: 'Clockify', min: 5, headers: ['project', 'client', 'description', 'task', 'user', 'email', 'tags', 'billable',
    'startdate', 'starttime', 'enddate', 'endtime', 'durationh', 'durationdecimal'] },
  { label: 'Microsoft 365 audit log', min: 3, headers: ['creationdate', 'userids', 'operations', 'auditdata', 'recordtype'] },
];

const CONTEXT_WORDS = new Set(['client', 'klant', 'customer', 'klantnaam', 'project', 'site', 'library', 'bibliotheek',
  'team', 'afdeling', 'department', 'application', 'applicatie', 'unit', 'eenheid']);
const EMAIL_WORDS = new Set(['email', 'mail', 'upn', 'userids', 'userprincipalname', 'emailadres']);
const NAME_WORDS = new Set(['user', 'gebruiker', 'username', 'medewerker', 'employee', 'person', 'persoon', 'naam', 'name',
  'actor', 'by', 'door', 'member', 'lid']);
const DATE_WORDS = new Set(['date', 'datum', 'day', 'dag', 'creationdate', 'timestamp', 'when', 'wanneer']);
// Not "tijd": Dutch exports also have a Starttijd and an Eindtijd, which are clock times.
const DURATION_WORDS = new Set(['duration', 'duur', 'hours', 'uren', 'uur', 'durationh', 'durationdecimal', 'timespent']);
const COUNT_WORDS = new Set(['count', 'aantal', 'events', 'number']);
const MONEY_WORDS = new Set(['billable', 'rate', 'tarief', 'usd', 'eur', 'cost', 'kosten', 'amount', 'bedrag']);
const KIND_WORDS = new Set(['task', 'taak', 'activity', 'activiteit', 'type', 'action', 'actie', 'event', 'operation',
  'operations', 'operatie', 'soort']);
// Columns a time export has that are no attribute worth keeping on a row.
const NOT_ATTRIBUTE_WORDS = new Set([...DATE_WORDS, ...DURATION_WORDS, 'time', 'tijd', 'start', 'end', 'eind', 'begin']);

/** The export a file is, by its headers: 'Clockify', 'Microsoft 365 audit log' or null. */
export function recogniseSource(headers) {
  const have = new Set(headers.map(squash));
  const hit = SOURCES.find(s => s.headers.filter(h => have.has(h)).length >= s.min);
  return hit?.label ?? null;
}

const filled = (c) => c.nonEmpty > 0;
const exact = (cols, key) => cols.find(c => squash(c.name) === key) ?? null;
const saying = (cols, vocab, taken) => cols.find(c => !taken.has(c.name) && filled(c) && says(c.name, vocab)) ?? null;

// The column whose distinct values name the most sub-units (at least one), the
// context vocabulary breaking a tie; without sub-units there is no context column.
function pickContext(cols, rows, childNames) {
  if (!childNames?.length) return null;
  const names = new Set(childNames.map(normalizeName));
  let best = null;
  let bestScore = 0;
  for (const c of cols) {
    const values = new Set(rows.map(r => normalizeName(r[c.name])).filter(Boolean));
    const score = [...values].filter(v => names.has(v)).length + (says(c.name, CONTEXT_WORDS) ? 0.5 : 0);
    if (score > bestScore) { best = c; bestScore = score; }
  }
  return bestScore >= 1 ? best : saying(cols, CONTEXT_WORDS, new Set());
}

function pickEmail(cols, taken) {
  return saying(cols, EMAIL_WORDS, taken)
    ?? cols.find(c => !taken.has(c.name) && c.shape === 'email' && c.samples.every(isEmailLike)) ?? null;
}

// The date column: a header that says date (Clockify's Start Date before its End
// Date), else the first column whose sampled values all read as dates.
function pickDate(cols, taken) {
  const free = cols.filter(c => !taken.has(c.name) && filled(c));
  return exact(free, 'startdate')
    ?? free.find(c => says(c.name, DATE_WORDS) && c.samples.every(isDateValue))
    ?? free.find(c => c.samples.length > 0 && c.samples.every(isDateValue))
    ?? null;
}

// The amount: Clockify's decimal duration first, then any duration / hours
// column (never a money column), then a count; none means one event per row.
function pickAmount(cols, taken) {
  const free = cols.filter(c => !taken.has(c.name) && filled(c) && !says(c.name, MONEY_WORDS));
  const duration = exact(free, 'durationdecimal') ?? exact(free, 'duurdecimaal') ?? exact(free, 'durationh')
    ?? free.find(c => says(c.name, DURATION_WORDS));
  if (duration) return { column: duration, unit: 'hours' };
  const count = free.find(c => says(c.name, COUNT_WORDS) && c.shape === 'number');
  return { column: count ?? null, unit: 'events' };
}

/**
 * @param {object} args
 * @param {string} [args.fileName]
 * @param {object[]} args.profile      upload/profile.js profileColumns()
 * @param {object[]} [args.rows]       the file's rows (for the context column and the date order)
 * @param {string[]} [args.childNames] the names (and keys) of the sub-units rows may land on
 * @returns {object} a complete mapping
 */
export function guessActivityMapping({ fileName = '', profile, rows = [], childNames = [] }) {
  const cols = Array.isArray(profile) ? profile : [];
  if (cols.length === 0) throw new Error('The file has no columns, so there is nothing to map.');
  const taken = new Set();
  const claim = (c) => { if (c) taken.add(c.name); return c?.name ?? null; };

  const contextColumn = claim(pickContext(cols, rows, childNames));
  const subjectEmailColumn = claim(pickEmail(cols, taken));
  const subjectNameColumn = claim(saying(cols, NAME_WORDS, taken));
  const dateColumn = claim(pickDate(cols, taken));
  const amount = pickAmount(cols, taken);
  const amountColumn = claim(amount.column);
  const kindColumn = claim(saying(cols, KIND_WORDS, taken));
  const attributeColumns = cols
    .filter(c => !taken.has(c.name) && !says(c.name, NOT_ATTRIBUTE_WORDS) && !says(c.name, MONEY_WORDS))
    .map(c => c.name);

  return {
    sourceLabel: recogniseSource(cols.map(c => c.name)) ?? listNameFrom(fileName),
    contextColumn,
    subjectNameColumn,
    subjectEmailColumn,
    dateColumn,
    dateOrder: dateColumn ? detectDateOrder(rows.map(r => r[dateColumn])) : 'dmy',
    amountColumn,
    unit: amount.unit,
    kindColumn,
    attributeColumns,
  };
}
