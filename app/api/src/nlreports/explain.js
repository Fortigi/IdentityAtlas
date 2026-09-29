// Natural-language reports (PROTOTYPE) — spec → plain-language interpretation.
//
// This is what the analyst checks before trusting a generated report, so it is
// produced from the validated spec (what will actually run), never from the
// model's own prose.

import { ENTITIES, OPERATORS, fieldsOf } from './catalog.js';

import { explainCompare } from './compare.js';

function formatValue(field, value) {
  if (field.type === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') return `"${value}"`;
  return String(value);
}

/**
 * A list, as the interpretation line should read it.
 *
 * A follow-up question carries the previous answer's records as ids, and there
 * can be dozens. Printing them makes the one line a reader uses to check the
 * bot understood them — "Understood as …" — unreadable, so past a handful it
 * says how many instead. That is the honest summary: the reader is checking
 * the SHAPE of the question, and the records themselves are the answer they
 * just saw.
 */
const SHOW_IN_FULL = 3;

function formatList(field, list) {
  if (list.length <= SHOW_IN_FULL) return list.map(v => formatValue(field, v)).join(', ');
  return `${list.length} values`;
}

function fieldText(entityName, c, extFields) {
  const field = fieldsOf(entityName, extFields)[c.field];
  const op = OPERATORS[c.op];
  if (c.op === 'withinLastDays') return `${field.label} is within the last ${c.value} days`;
  if (c.op === 'olderThanDays') return `${field.label} is more than ${c.value} days ago`;
  if (c.op === 'in') return `${field.label} ${op.label} ${formatList(field, c.value ?? [])}`;
  return op.needsValue ? `${field.label} ${op.label} ${formatValue(field, c.value)}` : `${field.label} ${op.label}`;
}

function matchWord(match) {
  return match === 'any' ? 'any' : 'all';
}

function conditionLines(entityName, c, depth, out, extFields) {
  const entity = ENTITIES[entityName];
  if (c.type === 'field') {
    out.push({ depth, text: fieldText(entityName, c, extFields) });

    return;
  }
  if (c.type === 'compare') {
    out.push({ depth, text: explainCompare(entityName, c) });
    return;
  }
  if (c.type === 'relation') {
    const rel = entity.relations[c.relation];
    const phrase = c.quantifier === 'none' ? rel.none : rel.some;
    if (c.conditions.length === 0) {
      out.push({ depth, text: phrase });
      return;
    }
    const lead = `${phrase} where`;
    if (c.conditions.length === 1) {
      out.push({ depth, text: `${lead} ${fieldText(rel.target, c.conditions[0], extFields)}` });
      return;
    }
    out.push({ depth, text: `${lead} ${matchWord(c.match)} of:` });
    for (const ic of c.conditions) conditionLines(rel.target, ic, depth + 1, out, extFields);
    return;
  }
  out.push({ depth, text: `${matchWord(c.match)} of:` });
  for (const ic of c.conditions) conditionLines(entityName, ic, depth + 1, out, extFields);
}

// What the report returns, which grouping changes: not records any more, but one
// row per value with a count. The analyst checks this line before trusting the
// numbers, so it has to say so.
// "Department" reads as a word here and is lowercased; "sfDepartmentID" is a name
// and keeps its spelling. A label that is already mixed-case is not a word.
const asNoun = (label) => (/[A-Z]/.test(label.slice(1)) ? label : label.toLowerCase());

function reportNoun(spec, extFields) {
  const noun = `${ENTITIES[spec.entity].label}s`;
  if (!spec.groupBy) return noun;
  return `${noun} counted per ${asNoun(fieldsOf(spec.entity, extFields)[spec.groupBy].label)}`;
}



/**
 * @returns {{ title: string, lines: { depth: number, text: string }[] }}
 */
export function explainSpec(spec, extFields) {
  const lines = [];
  for (const c of spec.conditions) conditionLines(spec.entity, c, 0, lines, extFields);
  const noun = reportNoun(spec, extFields);
  let title;
  if (spec.conditions.length === 0) title = spec.groupBy ? noun : `All ${noun.toLowerCase()}`;

  else if (spec.conditions.length === 1) title = `${noun} where`;
  else title = `${noun} matching ${matchWord(spec.match)} of:`;
  return { title, lines };
}
