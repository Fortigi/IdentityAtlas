import { describe, it, expect } from 'vitest';
import { createParams } from './sqlParams.js';

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
