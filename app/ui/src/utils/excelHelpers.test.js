import { describe, it, expect } from 'vitest';
import { safeCell } from './excelHelpers';

describe('safeCell — Excel/CSV formula-injection guard (M-05)', () => {
  it('prefixes a single quote on values starting with a formula trigger', () => {
    for (const v of ['=HYPERLINK("http://evil")', '+1+1', '-2+3', '@SUM(A1)', '\tcmd', '\rfoo']) {
      expect(safeCell(v)).toBe(`'${v}`);
    }
  });

  it('leaves ordinary display names / descriptions unchanged', () => {
    for (const v of ['Domain Admins', 'GG_ROL_AD_Finance', 'Finance (EU) — read only', '', 'a=b']) {
      expect(safeCell(v)).toBe(v);
    }
  });

  it('passes non-string values (numbers, null, rich-text objects) through untouched', () => {
    expect(safeCell(42)).toBe(42);
    expect(safeCell(null)).toBe(null);
    expect(safeCell(undefined)).toBe(undefined);
    const rich = { richText: [{ text: '=x' }] };
    expect(safeCell(rich)).toBe(rich);
  });
});
