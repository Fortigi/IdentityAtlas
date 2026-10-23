// Context activity — the rows of an export, read with a confirmed mapping.
//
//   readActivityRows(rows, mapping) → { entries, skipped, skippedSamples, period }
//
// Pure. One entry per usable row:
//   { contextValue, subjectName, subjectEmail, date: 'YYYY-MM-DD', amount, kind, attributes }
// A row is skipped — counted, never guessed — when its date does not read, its
// amount does not read (or is negative), or it names nobody. Cells are read as
// the list upload reads an owner cell (upload/cellValues.js singleValue): a
// SharePoint person value "Name;#27" is the name, a claim
// "i:0#.f|membership|a@example.com" the address. A name cell that is an
// address, with no e-mail column, is taken as the address.
// `period` is the first and last date of the entries (null without entries) —
// the range a re-upload of the same source replaces.

import { singleValue } from '../upload/cellValues.js';
import { isEmailLike } from '../upload/profile.js';
import { parseActivityDate, parseAmount } from './values.js';

export const MAX_SKIPPED_SAMPLES = 20;
const MAX_ATTRIBUTE_LENGTH = 500;
const MAX_KIND_LENGTH = 200;

const cell = (row, column) => (column ? singleValue(row[column]) : '');
const orNull = (v) => (v === '' ? null : v);

function subjectOf(row, mapping) {
  const name = cell(row, mapping.subjectNameColumn);
  const email = cell(row, mapping.subjectEmailColumn);
  if (!email && isEmailLike(name)) return { subjectName: null, subjectEmail: name.toLowerCase() };
  return { subjectName: orNull(name), subjectEmail: isEmailLike(email) ? email.toLowerCase() : null };
}

function attributesOf(row, columns) {
  const out = {};
  for (const c of columns) {
    const v = String(row[c] ?? '').trim();
    if (v !== '') out[c] = v.slice(0, MAX_ATTRIBUTE_LENGTH);
  }
  return Object.keys(out).length ? out : null;
}

// Why a row cannot be read, or null when it can.
function problemOf(entry) {
  if (!entry.date) return 'no date';
  if (entry.amount === null || entry.amount < 0) return 'no amount';
  if (!entry.subjectName && !entry.subjectEmail) return 'no person';
  return null;
}

function entryOf(row, mapping) {
  return {
    contextValue: mapping.contextColumn ? orNull(cell(row, mapping.contextColumn)) : null,
    ...subjectOf(row, mapping),
    date: parseActivityDate(row[mapping.dateColumn], mapping.dateOrder),
    amount: parseAmount(mapping.amountColumn ? row[mapping.amountColumn] : '', mapping.unit),
    kind: orNull(cell(row, mapping.kindColumn).slice(0, MAX_KIND_LENGTH)),
    attributes: attributesOf(row, mapping.attributeColumns),
  };
}

export function readActivityRows(rows, mapping) {
  const entries = [];
  const skipped = { 'no date': 0, 'no amount': 0, 'no person': 0 };
  const skippedSamples = [];
  let start = null;
  let end = null;
  rows.forEach((row, i) => {
    const entry = entryOf(row, mapping);
    const problem = problemOf(entry);
    if (problem) {
      skipped[problem]++;
      // The n-th data row (counted from 1, below the header).
      if (skippedSamples.length < MAX_SKIPPED_SAMPLES) skippedSamples.push({ row: i + 1, reason: problem });
      return;
    }
    if (start === null || entry.date < start) start = entry.date;
    if (end === null || entry.date > end) end = entry.date;
    entries.push(entry);
  });
  return { entries, skipped, skippedSamples, period: start ? { start, end } : null };
}
