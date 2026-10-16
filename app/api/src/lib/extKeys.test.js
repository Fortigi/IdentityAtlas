import { describe, it, expect } from 'vitest';
import {
  EXT_KEY_RE, MAX_EXT_KEY_LENGTH, isExtKey, extKeyLiteral, extValueSql, extKeyOf,
} from './extKeys.js';

describe('isExtKey', () => {
  // What sources really send. Each of these used to be dropped.
  it.each([
    'CMDB Reference', 'Cost-Center', 'Kostenplaats (NL)', 'a.b', 'ns:attr', 'path/to',
    'Größe', '名前', 'x#1', '50%', 'normal_Key9',
  ])('accepts %s', (key) => {
    expect(isExtKey(key)).toBe(true);
  });

  // The characters that end a quoted literal or a quoted alias.
  it.each([
    ["it's", 'a single quote'],
    ['a"b', 'a double quote'],
    ['a\\b', 'a backslash'],
    ['a\nb', 'a newline'],
    ['a\tb', 'a tab'],
    ['a\u0000b', 'a NUL'],
    ['a\u007fb', 'DEL'],
    ['', 'nothing'],
  ])('refuses %j (%s)', (key) => {
    expect(isExtKey(key)).toBe(false);
  });

  it(`stops at ${MAX_EXT_KEY_LENGTH} characters, counted as characters not bytes`, () => {
    expect(isExtKey('é'.repeat(MAX_EXT_KEY_LENGTH))).toBe(true);
    expect(isExtKey('é'.repeat(MAX_EXT_KEY_LENGTH + 1))).toBe(false);
  });

  it('refuses anything that is not a string', () => {
    for (const v of [undefined, null, 42, {}, ['a']]) expect(isExtKey(v)).toBe(false);
  });

  it('is anchored: a refused character anywhere refuses the key', () => {
    expect(EXT_KEY_RE.test("ok' or 1=1")).toBe(false);
    expect(EXT_KEY_RE.test("'ok")).toBe(false);
  });
});

describe('extKeyLiteral / extValueSql', () => {
  it('quotes the key as a literal', () => {
    expect(extKeyLiteral('CMDB Reference')).toBe(`'CMDB Reference'`);
  });

  it('throws on a refused key instead of emitting it', () => {
    expect(() => extKeyLiteral("x'; DROP TABLE t; --")).toThrow(/invalid extendedAttributes key/);
    expect(() => extValueSql('a"b', 'u')).toThrow();
  });

  it('qualifies the column with the alias when there is one', () => {
    expect(extValueSql('Cost-Center', 'u')).toBe(`u."extendedAttributes"->>'Cost-Center'`);
    expect(extValueSql('Cost-Center')).toBe(`"extendedAttributes"->>'Cost-Center'`);
  });
});

describe('extKeyOf', () => {
  it('returns the key of an ext. field', () => {
    expect(extKeyOf('ext.CMDB Reference')).toBe('CMDB Reference');
    expect(extKeyOf('ext.a.b')).toBe('a.b'); // only the prefix is stripped
  });

  it('is null for a real column, a refused key, or no key', () => {
    expect(extKeyOf('department')).toBeNull();
    expect(extKeyOf("ext.it's")).toBeNull();
    expect(extKeyOf('ext.')).toBeNull();
    expect(extKeyOf(undefined)).toBeNull();
  });
});
