// Context upload — the column profile of a list.
//
//   profileColumns(columns, rows) → ColumnProfile[]
//
//   {
//     name:        the column header
//     index:       0-based position in the file
//     nonEmpty:    rows with a non-blank value
//     distinct:    distinct trimmed values among those
//     uniqueness:  distinct / nonEmpty, 0..1 rounded to 3 decimals (0 for an empty column)
//     shape:       'email' | 'lookup' | 'number' | 'date' | 'text' — the first that
//                  at least 80 % of the non-empty values have, else text. 'lookup'
//                  is a SharePoint person or lookup column ("Name;#27", cellValues.js)
//     multiValued: share (0..1) of the non-empty values that hold more than one
//                  item (cellValues.js splitValues) — a members cell
//     samples:     up to 5 distinct values, in file order
//   }
//
// Ported from the Org Info prototype (orgtruth/import/profileColumns.js); the
// boolean shape is dropped (nothing in an upload reads it) and multiValued is new.

import { splitValues, isLookupCell } from './cellValues.js';

export const SAMPLE_COUNT = 5;
export const SHAPE_SHARE = 0.8;

const EMAIL = /^[^\s@;,]+@[^\s@;,]+\.[^\s@;,]+$/;

/** One e-mail address (or UPN). */
export function isEmailLike(v) {
  return EMAIL.test(v);
}

function isEmailListLike(v) {
  const parts = splitValues(v);
  return parts.length > 0 && parts.every(isEmailLike);
}

// Digits with an optional sign, thousands separators and one decimal mark.
function isNumberLike(v) {
  return /^[-+]?\d[\d\s.,]*$/.test(v) && !/[\s.,]{2}/.test(v) && !/[\s.,]$/.test(v);
}

// ISO dates (with an optional time) and the day-first / month-first forms lists use.
function isDateLike(v) {
  const rest = v.slice(10);
  return (/^\d{4}-\d{2}-\d{2}$/.test(v.slice(0, 10)) && (rest === '' || /^[T ][\d:.]+Z?$/.test(rest)))
    || /^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}$/.test(v);
}

const SHAPES = [['email', isEmailListLike], ['lookup', isLookupCell], ['number', isNumberLike], ['date', isDateLike]];

export function detectShape(values) {
  if (values.length === 0) return 'text';
  for (const [shape, test] of SHAPES) {
    if (values.filter(test).length / values.length >= SHAPE_SHARE) return shape;
  }
  return 'text';
}

const round3 = (n) => Math.round(n * 1000) / 1000;

export function profileColumns(columns, rows) {
  return columns.map((name, index) => {
    const values = [];
    for (const row of rows) {
      const v = String(row?.[name] ?? '').trim();
      if (v !== '') values.push(v);
    }
    const distinctSet = new Set(values);
    const nonEmpty = values.length;
    const multi = values.filter(v => splitValues(v).length > 1).length;
    return {
      name,
      index,
      nonEmpty,
      distinct: distinctSet.size,
      uniqueness: nonEmpty === 0 ? 0 : round3(distinctSet.size / nonEmpty),
      shape: detectShape(values),
      multiValued: nonEmpty === 0 ? 0 : round3(multi / nonEmpty),
      samples: [...distinctSet].slice(0, SAMPLE_COUNT),
    };
  });
}
