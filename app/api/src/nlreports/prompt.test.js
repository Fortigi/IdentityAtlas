// The reply grammar must bound everything the model can repeat.
//
// At temperature 0 a small model that starts repeating itself does not stop, and the
// grammar is the only thing that can stop it. Asked for "groups with more than 10
// members, biggest first", the shipped model wrote the right condition and then the
// same ten column names over and over until the token cap: 570 s, and invalid JSON.
// These tests walk the schema handed to the model server, so a new array or text
// field added without a limit fails here rather than in front of an analyst.

import { describe, it, expect } from 'vitest';
import { REPLY_LIMITS, REPORT_ONLY_SCHEMA, RESPONSE_SCHEMA, buildSystemPrompt } from './prompt.js';
import { OPERATORS_BY_TYPE } from './catalog.js';
import { MAX_COLUMNS, MAX_CONDITIONS } from './spec.js';

/** Every node in a JSON schema, with the path that reaches it. */
function* nodes(schema, path = '$') {
  if (!schema || typeof schema !== 'object') return;
  yield [path, schema];
  for (const [key, child] of Object.entries(schema.properties || {})) yield* nodes(child, `${path}.${key}`);
  if (schema.items) yield* nodes(schema.items, `${path}[]`);
  for (const [i, child] of (schema.anyOf || []).entries()) yield* nodes(child, `${path}|${i}`);
}

const unbounded = (schema) => [...nodes(schema)].flatMap(([path, node]) => {
  if (node.type === 'array' && !(node.maxItems > 0)) return [`${path}: array without maxItems`];
  const isFreeText = node.type === 'string' && !node.enum;
  if (isFreeText && !(node.maxLength > 0)) return [`${path}: text without maxLength`];
  // A type LIST cannot carry maxLength for its string member — the grammar has
  // nowhere to put it. Spell such a value out as anyOf instead.
  if (Array.isArray(node.type) && node.type.includes('string')) return [`${path}: string in a type list is unbounded`];
  return [];
});

describe('reply grammar', () => {
  it('bounds every array and every free-text string the model can emit', () => {
    expect(unbounded(RESPONSE_SCHEMA)).toEqual([]);
    expect(unbounded(REPORT_ONLY_SCHEMA)).toEqual([]);
  });

  it('actually reaches the fields that looped, so the walk above is not vacuous', () => {
    const paths = [...nodes(RESPONSE_SCHEMA)].map(([p]) => p);
    expect(paths).toContain('$|0.spec.columns');
    expect(paths).toContain('$|0.spec.conditions[]|3.conditions');   // a group's conditions
    expect(paths).toContain('$|1.options');
    // A text value is reachable through the anyOf, and is itself bounded.
    const value = [...nodes(RESPONSE_SCHEMA)].find(([p]) => p === '$|0.spec.conditions[]|0.value|0')?.[1];
    expect(value).toEqual({ type: 'string', maxLength: REPLY_LIMITS.value });
  });

  it("never lets the model emit more than validation accepts", () => {
    // The two limits are one rule. If the grammar allowed more, a reply could be
    // well-formed and still rejected; if it allowed fewer, a valid report could not
    // be written at all.
    const spec = RESPONSE_SCHEMA.anyOf[0].properties.spec.properties;
    expect(spec.columns.maxItems).toBe(MAX_COLUMNS);
    expect(spec.conditions.maxItems).toBe(MAX_CONDITIONS);
  });

  it('leaves room for the largest definition in the measured question sets', () => {
    // Observed maxima across 56 questions: 3 top-level conditions, 2 nested, 3
    // columns in the prompt examples. The limits are meant to stop a loop, never a
    // real report.
    expect(REPLY_LIMITS.conditions).toBeGreaterThanOrEqual(3 * 4);
    expect(REPLY_LIMITS.columns).toBeGreaterThanOrEqual(3 * 4);
  });
});

describe('the prompt only offers what the grammar can express', () => {
  // Operators that take a LIST of values. The reply schema's `value` has no
  // array branch, so a model told about one of these writes a comma-joined
  // string instead — which coerces to a single value and matches one record
  // whose name happens to contain a comma. An empty answer, stated
  // confidently, from advertising something the model cannot actually write.
  const LIST_OPERATORS = new Set(['in']);

  /** Every operator named in the prompt's per-type list. */
  function offeredOperators() {
    const section = buildSystemPrompt().split('# Operators per field type')[1] ?? '';
    const listed = section.split('\n# ')[0];
    return new Set(
      listed.split('\n')
        .filter(l => l.startsWith('- '))
        .flatMap(l => l.slice(l.indexOf(':') + 1).split(',').map(o => o.trim()))
        .filter(Boolean),
    );
  }

  /** Every `value` branch list in the schema, wherever a condition can nest. */
  function allValueBranches(node, found = []) {
    if (!node || typeof node !== 'object') return found;
    if (node.properties?.value?.anyOf) found.push(node.properties.value.anyOf);
    for (const child of Object.values(node)) allValueBranches(child, found);
    return found;
  }

  it('has no array branch for a condition value, anywhere it can nest', () => {
    // The premise the rule below rests on. Walked rather than looked up by
    // path: a condition value appears at four depths (top level, inside a
    // relation, inside a group, inside a relation inside a group), and a list
    // branch added to only one of them is exactly the kind of gap a fixed
    // path misses. When this stops being true, list operators can be offered
    // — and this test is where that gets noticed.
    const branchLists = allValueBranches(RESPONSE_SCHEMA);
    expect(branchLists.length).toBeGreaterThan(1);
    for (const branches of branchLists) {
      expect(branches.some(b => b.type === 'array')).toBe(false);
    }
  });

  it('keeps list operators out of the prompt while that is so', () => {
    const offered = [...offeredOperators()].filter(op => LIST_OPERATORS.has(op));
    expect(offered, `the prompt offers ${offered.join(', ')}, which the schema cannot express`).toEqual([]);
  });

  it('still HAS those operators in the catalog, for callers that build a spec directly', () => {
    // Proves the line above is a filter and not an accident. The Teams bot's
    // follow-up ("of these groups, which …") is exactly such a caller.
    const inCatalog = new Set(Object.values(OPERATORS_BY_TYPE).flat());
    for (const op of LIST_OPERATORS) expect(inCatalog.has(op), `${op} vanished from the catalog`).toBe(true);
  });

  it('offers every other operator the catalog has, so the filter stays narrow', () => {
    const offered = offeredOperators();
    const expected = new Set(Object.values(OPERATORS_BY_TYPE).flat().filter(op => !LIST_OPERATORS.has(op)));
    expect([...expected].filter(op => !offered.has(op))).toEqual([]);
  });
});
