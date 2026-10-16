// Unit tests for the access-review field catalogue: what a field key means,
// what heading it gets and what value it reads. Pure — no database.

import { describe, it, expect } from 'vitest';
import {
  MAX_LIST, attributeValue, coreFields, isOfferableAttributeKey, parseList, resolveField, resolveFields,
} from './accessReviewFields.js';

const source = {
  context: {
    displayName: 'Ledger', contextType: 'LogicalApplication', description: 'The ledger.',
    ownerName: 'Ada Lovelace', ownerUserId: 'EMP-1',
    extendedAttributes: { cmdbReference: 'CI-1', risk: 3 },
  },
  entitlement: {
    resourceType: 'Entitlement', systemName: 'IdentityIQ', description: 'Post journals',
    extendedAttributes: { certfrequency: ' Quarterly ', requestable: true, nested: { a: 1 }, blank: '   ' },
  },
  owner: { ownerName: 'Grace Hopper', ownerEmail: 'grace@example.com' },
  count: { direct: 2, indirect: 5, eligible: 7 },
};

const read = key => resolveField(key).read(source);

describe('core fields', () => {
  it('reads each built-in fact from its own part of the row', () => {
    // Every value distinct, so a field wired to the wrong part fails.
    expect(Object.fromEntries(coreFields().map(f => [f.key, read(f.key)]))).toEqual({
      'context.name': 'Ledger',
      'context.type': 'LogicalApplication',
      'context.description': 'The ledger.',
      'context.owner': 'Ada Lovelace',
      'entitlement.type': 'Entitlement',
      'entitlement.system': 'IdentityIQ',
      'entitlement.description': 'Post journals',
      'entitlement.owner': 'Grace Hopper',
      'entitlement.ownerEmail': 'grace@example.com',
      'entitlement.eligibleAssignments': 7,
    });
  });

  it('falls back to the stored owner id when no account matched it', () => {
    const field = resolveField('context.owner');
    expect(field.read({ context: { ownerUserId: 'EMP-1', ownerName: null } })).toBe('EMP-1');
  });

  it('reads an absent part as nothing, and an absent eligible count as zero', () => {
    for (const { key } of coreFields()) {
      const value = resolveField(key).read({});
      expect(value ?? null, key).toBe(key === 'entitlement.eligibleAssignments' ? 0 : null);
    }
  });
});

describe('attribute fields', () => {
  it('reads a context attribute from the context and an entitlement attribute from the resource', () => {
    expect(read('context.ext.cmdbReference')).toBe('CI-1');
    expect(read('entitlement.ext.certfrequency')).toBe('Quarterly');
    // Same key, other owner: the context has no certfrequency.
    expect(read('context.ext.certfrequency')).toBeNull();
  });

  it('labels a context attribute as the context\'s, and strips an Entra extension prefix', () => {
    expect(resolveField('context.ext.cmdbReference').label).toBe('Context · cmdbReference');
    expect(resolveField('entitlement.ext.certfrequency').label).toBe('certfrequency');
    expect(resolveField('entitlement.ext.extension_0123456789abcdef0123456789abcdef_costCenter').label)
      .toBe('costCenter');
  });

  it('marks which attribute a field reads, so the report can say when nobody has it', () => {
    expect(resolveField('entitlement.ext.certfrequency').attribute).toEqual({ owner: 'entitlement', key: 'certfrequency' });
    expect(resolveField('entitlement.owner').attribute).toBeUndefined();
  });

  it('refuses a key that is not one', () => {
    for (const key of ['', 'nonsense', 'entitlement', 'entitlement.ext.', 'entitlement.ext.a,b', 'ext.x', null, 42]) {
      expect(resolveField(key), String(key)).toBeNull();
    }
  });
});

describe('attributeValue', () => {
  it('keeps numbers and booleans typed, so a pivot can sum or group them', () => {
    expect(attributeValue({ n: 0 }, 'n')).toBe(0);
    expect(attributeValue({ b: false }, 'b')).toBe(false);
  });

  it('trims text and reads blank text as nothing', () => {
    expect(attributeValue({ s: '  x ' }, 's')).toBe('x');
    expect(attributeValue({ s: '   ' }, 's')).toBeNull();
  });

  it('shows a nested value as its JSON rather than "[object Object]"', () => {
    expect(attributeValue({ o: { a: 1 } }, 'o')).toBe('{"a":1}');
    expect(attributeValue({ l: [1, 2] }, 'l')).toBe('[1,2]');
  });

  it('reads only own keys, so `constructor` is not Object\'s constructor', () => {
    expect(attributeValue({}, 'constructor')).toBeNull();
    expect(attributeValue({ constructor: 'Bob' }, 'constructor')).toBe('Bob');
  });

  it('reads nothing from something that is not an object', () => {
    for (const attrs of [null, undefined, 'text', 5]) expect(attributeValue(attrs, 'length')).toBeNull();
    expect(attributeValue({ x: null }, 'x')).toBeNull();
  });
});

describe('isOfferableAttributeKey', () => {
  it('accepts what sources write, in any script, and nothing that breaks a list or a heading', () => {
    for (const ok of ['certfrequency', 'Cost Center', 'gpi_compliance', 'Kostenplaats', 'Größe', 'a.b:c/d(e)-f']) {
      expect(isOfferableAttributeKey(ok), ok).toBe(true);
    }
    for (const bad of ['', 'a,b', 'tab\there', 'x'.repeat(129), null, 7]) {
      expect(isOfferableAttributeKey(bad), String(bad)).toBe(false);
    }
  });
});

describe('resolveFields', () => {
  it('keeps the order given, drops repeats and returns the keys it could not resolve', () => {
    const { fields, unknown } = resolveFields(['entitlement.owner', 'bogus', 'context.name', 'entitlement.owner']);
    expect(fields.map(f => f.key)).toEqual(['entitlement.owner', 'context.name']);
    expect(unknown).toEqual(['bogus']);
  });
});

describe('parseList', () => {
  it('parses a list from either a comma string or an array, dropping blanks', () => {
    expect(parseList('a, b ,, c')).toEqual(['a', 'b', 'c']);
    expect(parseList(['a', ' b ', null])).toEqual(['a', 'b']);
    expect(parseList(undefined)).toEqual([]);
  });

  it('caps the list, because it is user input reaching a query', () => {
    const many = Array.from({ length: MAX_LIST + 50 }, (_, i) => `x-${i}`);
    expect(parseList(many)).toHaveLength(MAX_LIST);
    expect(parseList(many.join(','), 3)).toEqual(['x-0', 'x-1', 'x-2']);
  });
});
