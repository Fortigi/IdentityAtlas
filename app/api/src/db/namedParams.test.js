import { describe, it, expect } from 'vitest';
import { bindNamedParams } from './namedParams.js';

describe('bindNamedParams', () => {
  it('rewrites a single @name to $1 and binds its value', () => {
    const { text, values } = bindNamedParams('SELECT * FROM t WHERE a = @x', { x: 5 });
    expect(text).toBe('SELECT * FROM t WHERE a = $1');
    expect(values).toEqual([5]);
  });

  it('collapses a repeated @name to one $N bound once', () => {
    const { text, values } = bindNamedParams(
      'WHERE a = @x AND b ILIKE @x AND c = @y',
      { x: 'foo', y: 2 },
    );
    expect(text).toBe('WHERE a = $1 AND b ILIKE $1 AND c = $2');
    expect(values).toEqual(['foo', 2]);
  });

  it('numbers distinct @names in first-appearance order', () => {
    const { text, values } = bindNamedParams('@a @b @c', { a: 1, b: 2, c: 3 });
    expect(text).toBe('$1 $2 $3');
    expect(values).toEqual([1, 2, 3]);
  });

  it('leaves @names inside single-quoted string literals untouched', () => {
    const { text, values } = bindNamedParams(
      `SELECT '@notaparam' AS lit, x FROM t WHERE x = @real`,
      { real: 9 },
    );
    expect(text).toBe(`SELECT '@notaparam' AS lit, x FROM t WHERE x = $1`);
    expect(values).toEqual([9]);
  });

  it('includes only @names present in the SQL, ignoring extra bindings', () => {
    // The same superset map is safe to pass to a narrower COUNT query.
    const { text, values } = bindNamedParams('WHERE a = @a', { a: 1, unused: 99 });
    expect(text).toBe('WHERE a = $1');
    expect(values).toEqual([1]);
  });

  it('binds a missing value as undefined (name present, binding absent)', () => {
    const { text, values } = bindNamedParams('WHERE a = @a', {});
    expect(text).toBe('WHERE a = $1');
    expect(values).toEqual([undefined]);
  });

  it('passes through SQL with no placeholders and defaults bindings to {}', () => {
    const { text, values } = bindNamedParams('SELECT 1');
    expect(text).toBe('SELECT 1');
    expect(values).toEqual([]);
  });

  it('does not treat an email-like @ inside quotes as a placeholder', () => {
    const { text, values } = bindNamedParams(
      `WHERE email = 'a@b.com' AND id = @id`,
      { id: 'x' },
    );
    expect(text).toBe(`WHERE email = 'a@b.com' AND id = $1`);
    expect(values).toEqual(['x']);
  });
});
