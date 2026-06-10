import { describe, it, expect } from 'vitest';
import { resolveAttrExpr } from './attrExpr.js';

const COLS = [{ name: 'department' }, { name: 'jobTitle' }, { name: 'companyName' }];

describe('resolveAttrExpr', () => {
  it('resolves a real column to an aliased, quoted identifier', () => {
    expect(resolveAttrExpr('department', 'u', COLS)).toEqual({ attrExpr: 'u."department"' });
    expect(resolveAttrExpr('jobTitle', 'i', COLS)).toEqual({ attrExpr: 'i."jobTitle"' });
  });

  it('resolves an ext.<key> to a JSONB path', () => {
    expect(resolveAttrExpr('ext.costCenter', 'u', COLS)).toEqual({ attrExpr: `u."extendedAttributes"->>'costCenter'` });
  });

  it('rejects an unknown real column', () => {
    expect(resolveAttrExpr('notAColumn', 'u', COLS)).toEqual({ error: 'unknown attribute' });
  });

  it('rejects unsafe identifiers (injection guard)', () => {
    expect(resolveAttrExpr('a"; DROP', 'u', COLS).error).toBeTruthy();
    expect(resolveAttrExpr('ext.a\'b', 'u', COLS).error).toBeTruthy();
    expect(resolveAttrExpr('', 'u', COLS).error).toBeTruthy();
    expect(resolveAttrExpr(null, 'u', COLS).error).toBeTruthy();
  });

  it('does not require the column list for ext.* keys', () => {
    expect(resolveAttrExpr('ext.sfDepartmentName', 'u', [])).toEqual({ attrExpr: `u."extendedAttributes"->>'sfDepartmentName'` });
  });
});
