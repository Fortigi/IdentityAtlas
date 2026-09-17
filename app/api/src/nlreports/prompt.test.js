// The reply grammar must bound everything the model can repeat.
//
// At temperature 0 a small model that starts repeating itself does not stop, and the
// grammar is the only thing that can stop it. Asked for "groups with more than 10
// members, biggest first", the shipped model wrote the right condition and then the
// same ten column names over and over until the token cap: 570 s, and invalid JSON.
// These tests walk the schema handed to the model server, so a new array or text
// field added without a limit fails here rather than in front of an analyst.

import { describe, it, expect } from 'vitest';
import { REPLY_LIMITS, REPORT_ONLY_SCHEMA, RESPONSE_SCHEMA } from './prompt.js';
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
