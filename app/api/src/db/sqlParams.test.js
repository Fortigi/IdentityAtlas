import { describe, it, expect } from 'vitest';
import { createParams, escapeLike, likeContains } from './sqlParams.js';

describe('escapeLike / likeContains (SEC-2026-09 L-14)', () => {
  it('escapes the LIKE wildcards and the escape character itself', () => {
    expect(escapeLike('a_b')).toBe('a\\_b');
    expect(escapeLike('100%')).toBe('100\\%');
    expect(escapeLike('dom\\user')).toBe('dom\\\\user');
    expect(escapeLike('%_\\%')).toBe('\\%\\_\\\\\\%');
  });

  it('leaves ordinary text (and other regex-ish characters) alone', () => {
    expect(escapeLike('Jane O\'Neil [x].*')).toBe('Jane O\'Neil [x].*');
    expect(escapeLike(42)).toBe('42');
  });

  it('wraps the escaped value for a contains-search', () => {
    expect(likeContains('50%_off')).toBe('%50\\%\\_off%');
    expect(likeContains('')).toBe('%%');
  });
});

describe('createParams', () => {
  it('hands out sequential $N tokens and collects the values', () => {
    const { params, bind } = createParams();
    const a = bind('x');
    const b = bind(42);
    expect(a).toBe('$1');
    expect(b).toBe('$2');
    expect(params).toEqual(['x', 42]);
  });

  it('starts empty', () => {
    const { params } = createParams();
    expect(params).toEqual([]);
  });

  it('lets a caller reuse a captured token for a repeated value (bound once)', () => {
    const { params, bind } = createParams();
    const s = bind('%foo%');
    const where = `a ILIKE ${s} OR b ILIKE ${s}`;
    expect(where).toBe('a ILIKE $1 OR b ILIKE $1');
    expect(params).toEqual(['%foo%']); // one value, referenced twice
  });

  it('numbers fragments in bind() call order regardless of SQL position', () => {
    // A helper may bind a JOIN param before the WHERE params; pg matches by
    // number, not textual position, so call order is what defines $N.
    const { params, bind } = createParams();
    const join = bind('joinval');   // $1
    const w = bind('whereval');     // $2
    const sql = `... WHERE x = ${w} ... JOIN y ON z = ${join}`;
    expect(sql).toContain('x = $2');
    expect(sql).toContain('z = $1');
    expect(params).toEqual(['joinval', 'whereval']);
  });
});
